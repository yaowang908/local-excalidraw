use local_excalidraw_filesystem as filesystem;

use filesystem::{Entry, Result, Snapshot, WorkspaceError, WorkspaceFs, WorkspaceWatcher};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};

mod embeds;
mod recovery;
use recovery::{RecoveryRecord, RecoveryStore};

struct Workspace {
    fs: Arc<WorkspaceFs>,
    _watcher: WorkspaceWatcher,
}

#[derive(Default)]
struct AppState(Mutex<Option<Workspace>>);

static ACTIVE_IO: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct IoPermit(String);

impl Drop for IoPermit {
    fn drop(&mut self) {
        if let Some(active) = ACTIVE_IO.get() {
            if let Ok(mut active) = active.lock() {
                active.remove(&self.0);
            }
        }
    }
}

fn begin_io(key: String) -> Result<IoPermit> {
    let active = ACTIVE_IO.get_or_init(|| Mutex::new(HashSet::new()));
    let mut active = active
        .lock()
        .map_err(|_| WorkspaceError::new("io", "I/O state lock poisoned"))?;
    if active.contains(&key) {
        return Err(WorkspaceError::new(
            "busy",
            "This file operation is still waiting for the cloud service. Retry after it finishes.",
        ));
    }
    let root = key.split('\0').nth(1);
    let waiting_here = active
        .iter()
        .filter(|item| item.split('\0').nth(1) == root)
        .count();
    if waiting_here >= 8 || active.len() >= 64 {
        return Err(WorkspaceError::new(
            "busy",
            "Too many file operations are waiting in this folder. Retry shortly.",
        ));
    }
    active.insert(key.clone());
    Ok(IoPermit(key))
}

fn save_pending(root: &str, path: &str) -> Result<bool> {
    let active = ACTIVE_IO.get_or_init(|| Mutex::new(HashSet::new()));
    let active = active
        .lock()
        .map_err(|_| WorkspaceError::new("io", "I/O state lock poisoned"))?;
    Ok(active.contains(&format!("save\0{root}\0{path}")))
}

async fn bounded_io<T: Send + 'static>(
    key: String,
    timeout_code: &'static str,
    action: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    bounded_io_for(key, timeout_code, Duration::from_secs(15), action).await
}

async fn bounded_io_for<T: Send + 'static>(
    key: String,
    timeout_code: &'static str,
    deadline: Duration,
    action: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let permit = begin_io(key)?;
    let (sender, receiver) = sync_channel(1);
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if sender.send(action()).is_err() {
            eprintln!(
                "Workspace I/O completed after its caller timed out; re-read before retrying"
            );
        }
    });
    let wait = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(deadline))
        .await
        .map_err(|e| WorkspaceError::new("io", format!("Workspace wait task failed: {e}")))?;
    match wait {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(WorkspaceError::new(
            timeout_code,
            if timeout_code == "uncertain" {
                "The cloud service has not finished this write. Its result is uncertain; local recovery is retained. Recheck the file before retrying."
            } else {
                "The cloud service has not returned this file yet. Retry when it is available."
            },
        )),
        Err(RecvTimeoutError::Disconnected) => Err(WorkspaceError::new(
            "io",
            "Workspace I/O worker stopped unexpectedly",
        )),
    }
}

#[cfg(test)]
mod io_tests {
    use super::*;

    #[test]
    fn timed_out_write_stays_busy_until_the_worker_finishes() {
        let (release, wait) = sync_channel::<()>(1);
        let first = tauri::async_runtime::block_on(bounded_io_for(
            "test-cloud-write".into(),
            "uncertain",
            Duration::from_millis(20),
            move || {
                wait.recv().unwrap();
                Ok(())
            },
        ));
        assert_eq!(first.unwrap_err().code, "uncertain");
        let retry = tauri::async_runtime::block_on(bounded_io_for(
            "test-cloud-write".into(),
            "uncertain",
            Duration::from_millis(20),
            || Ok(()),
        ));
        assert_eq!(retry.unwrap_err().code, "busy");
        let local = tauri::async_runtime::block_on(bounded_io_for(
            "read\0local-folder\0a.excalidraw".into(),
            "unavailable",
            Duration::from_millis(20),
            || Ok(7),
        ));
        assert_eq!(local.unwrap(), 7);
        release.send(()).unwrap();
        for _ in 0..100 {
            if ACTIVE_IO.get().unwrap().lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ACTIVE_IO.get().unwrap().lock().unwrap().is_empty());
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Preferences {
    workspace_path: Option<String>,
    open_tabs: Vec<String>,
    active_tab: Option<String>,
}

#[derive(Clone, Serialize)]
struct WorkspaceEvent {
    root: String,
    error: Option<String>,
}

async fn with_workspace<T: Send + 'static>(
    state: &AppState,
    root: &str,
    key: String,
    timeout_code: &'static str,
    action: impl FnOnce(&WorkspaceFs) -> Result<T> + Send + 'static,
) -> Result<T> {
    let fs = {
        let guard = state
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))?;
        let workspace = guard
            .as_ref()
            .ok_or_else(|| WorkspaceError::new("state", "Open a workspace first"))?;
        if workspace.fs.root.to_string_lossy() != root {
            return Err(WorkspaceError::new(
                "state",
                "Workspace changed; this operation belongs to the previous workspace",
            ));
        }
        workspace.fs.clone()
    };
    bounded_io(key, timeout_code, move || action(&fs)).await
}

#[tauri::command(async)]
async fn open_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String> {
    let key = format!("open\0{path}");
    let (fs, watcher) = bounded_io(key, "unavailable", move || {
        let fs = WorkspaceFs::open(Path::new(&path))?;
        let event_root = fs.root.to_string_lossy().into_owned();
        let watcher =
            WorkspaceWatcher::new(&fs.root, move |event: notify::Result<notify::Event>| {
                let error = match event {
                    Ok(event) => {
                        if event.kind.is_access()
                            || event.paths.iter().all(|path| {
                                path.file_name()
                                    .is_some_and(|name| name.to_string_lossy().starts_with('.'))
                            })
                        {
                            return;
                        }
                        None
                    }
                    Err(error) => Some(format!("Workspace watcher failed: {error}")),
                };
                if let Err(error) = app.emit(
                    "workspace-changed",
                    WorkspaceEvent {
                        root: event_root.clone(),
                        error,
                    },
                ) {
                    eprintln!("Cannot deliver workspace change: {error}");
                }
            })
            .map_err(|e| WorkspaceError::new("watch", format!("Cannot start file watcher: {e}")))?;
        Ok((fs, watcher))
    })
    .await?;
    let root = fs.root.to_string_lossy().into_owned();
    *state
        .0
        .lock()
        .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))? =
        Some(Workspace {
            fs: Arc::new(fs),
            _watcher: watcher,
        });
    Ok(root)
}

#[tauri::command(async)]
async fn list_entries(
    state: tauri::State<'_, AppState>,
    root: String,
    path: Option<String>,
) -> Result<Vec<Entry>> {
    let key = format!("tree\0{root}\0{}", path.as_deref().unwrap_or(""));
    with_workspace(&state, &root, key, "unavailable", move |fs| {
        fs.list_at(path.as_deref())
    })
    .await
}

#[tauri::command(async)]
async fn read_document(
    state: tauri::State<'_, AppState>,
    root: String,
    path: String,
) -> Result<Snapshot> {
    let key = format!("read\0{root}\0{path}");
    with_workspace(&state, &root, key, "unavailable", move |fs| fs.read(&path)).await
}

#[tauri::command(async)]
async fn save_document(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    recovery: tauri::State<'_, RecoveryStore>,
    root: String,
    path: String,
    content: String,
    expected_hash: Option<String>,
) -> Result<Snapshot> {
    let directory = recovery_directory(&app)?;
    let store = recovery.inner().clone();
    let checked_root = root.clone();
    let key = format!("save\0{root}\0{path}");
    with_workspace(&state, &root, key, "uncertain", move |fs| {
        store.save(
            &directory,
            fs,
            &checked_root,
            &path,
            &content,
            expected_hash.as_deref(),
        )
    })
    .await
}

#[tauri::command(async)]
async fn create_folder(
    state: tauri::State<'_, AppState>,
    root: String,
    path: String,
) -> Result<()> {
    let key = format!("create\0{root}\0{path}");
    with_workspace(&state, &root, key, "uncertain", move |fs| {
        fs.create_folder(&path)
    })
    .await
}

#[tauri::command(async)]
async fn move_entry(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    recovery: tauri::State<'_, RecoveryStore>,
    root: String,
    from: String,
    to: String,
) -> Result<()> {
    let directory = recovery_directory(&app)?;
    let store = recovery.inner().clone();
    let checked_root = root.clone();
    let key = format!("move\0{root}\0{from}");
    with_workspace(&state, &root, key, "uncertain", move |fs| {
        fs.move_entry(&from, &to)?;
        store
            .moved(&directory, &checked_root, &from, &to)
            .map_err(|error| {
                WorkspaceError::new(
                    "recovery_move",
                    format!(
                        "Entry moved, but local recovery did not follow: {}",
                        error.message
                    ),
                )
            })
    })
    .await
}

#[tauri::command(async)]
async fn trash_entry(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    recovery: tauri::State<'_, RecoveryStore>,
    root: String,
    path: String,
) -> Result<()> {
    let directory = recovery_directory(&app)?;
    let store = recovery.inner().clone();
    let checked_root = root.clone();
    let key = format!("trash\0{root}\0{path}");
    with_workspace(&state, &root, key, "uncertain", move |fs| {
        fs.trash_entry(&path)?;
        store
            .trashed(&directory, &checked_root, &path)
            .map_err(|error| {
                WorkspaceError::new(
                    "recovery_trash",
                    format!(
                        "Entry moved to Trash, but local recovery cleanup failed: {}",
                        error.message
                    ),
                )
            })
    })
    .await
}

#[tauri::command(async)]
async fn reveal_entry(
    state: tauri::State<'_, AppState>,
    root: String,
    path: Option<String>,
) -> Result<()> {
    let key = format!("reveal\0{root}\0{}", path.as_deref().unwrap_or(""));
    with_workspace(&state, &root, key, "unavailable", move |fs| {
        let target = match path {
            Some(path) => fs.resolve(&path, false)?,
            None => fs.root.clone(),
        };
        let status = std::process::Command::new("open")
            .arg("-R")
            .arg(target)
            .status()
            .map_err(|e| WorkspaceError::new("io", format!("Cannot open Finder: {e}")))?;
        if !status.success() {
            return Err(WorkspaceError::new(
                "io",
                "Finder could not reveal this entry",
            ));
        }
        Ok(())
    })
    .await
}

fn recovery_directory(app: &tauri::AppHandle) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("recovery"))
        .map_err(|e| WorkspaceError::new("recovery", format!("Cannot locate local recovery: {e}")))
}

#[tauri::command(async)]
fn read_recovery(
    app: tauri::AppHandle,
    store: tauri::State<RecoveryStore>,
    root: String,
    path: String,
) -> Result<RecoveryRecord> {
    store.read(&recovery_directory(&app)?, &root, &path)
}

#[tauri::command(async)]
fn checkpoint_document(
    app: tauri::AppHandle,
    store: tauri::State<RecoveryStore>,
    root: String,
    path: String,
    content: String,
    base_hash: Option<String>,
) -> Result<String> {
    store.checkpoint(
        &recovery_directory(&app)?,
        &root,
        &path,
        &content,
        base_hash,
    )
}

#[tauri::command(async)]
fn accept_external(
    app: tauri::AppHandle,
    store: tauri::State<RecoveryStore>,
    root: String,
    path: String,
) -> Result<()> {
    if save_pending(&root, &path)? {
        return Err(WorkspaceError::new("busy", "A previous save is still waiting for the cloud service. Retry the version choice after it finishes."));
    }
    store.accept_external(&recovery_directory(&app)?, &root, &path)
}

fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("preferences.json"))
        .map_err(|e| WorkspaceError::new("io", format!("Cannot locate app preferences: {e}")))
}

#[tauri::command(async)]
fn load_preferences(app: tauri::AppHandle) -> Result<Preferences> {
    let path = preferences_path(&app)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            WorkspaceError::new("invalid", format!("Cannot read app preferences: {e}"))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(e) => Err(WorkspaceError::new(
            "io",
            format!("Cannot read app preferences: {e}"),
        )),
    }
}

#[tauri::command(async)]
fn save_preferences(app: tauri::AppHandle, preferences: Preferences) -> Result<()> {
    let path = preferences_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| WorkspaceError::new("path", "Missing preferences directory"))?;
    fs::create_dir_all(parent).map_err(|e| {
        WorkspaceError::new("io", format!("Cannot create preferences directory: {e}"))
    })?;
    let bytes = serde_json::to_vec_pretty(&preferences).map_err(|e| {
        WorkspaceError::new("invalid", format!("Cannot serialize preferences: {e}"))
    })?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| {
        WorkspaceError::new("io", format!("Cannot create temporary preferences: {e}"))
    })?;
    temp.write_all(&bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| WorkspaceError::new("io", format!("Cannot write preferences: {e}")))?;
    temp.persist(path)
        .map_err(|e| WorkspaceError::new("io", format!("Cannot replace preferences: {e}")))?;
    Ok(())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn youtube_embed_base(server: tauri::State<embeds::EmbedServer>) -> String {
    server.base.clone()
}

/// Launch the local desktop workspace.
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(RecoveryStore::default())
        .manage(embeds::EmbedServer::start().expect("Cannot start YouTube player listener"))
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            list_entries,
            read_document,
            save_document,
            read_recovery,
            checkpoint_document,
            accept_external,
            create_folder,
            move_entry,
            trash_entry,
            reveal_entry,
            load_preferences,
            save_preferences,
            exit_app,
            youtube_embed_base
        ])
        .build(tauri::generate_context!())
        .expect("Cannot initialize Local Excalidraw");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            api.prevent_exit();
            if let Err(error) = app.emit("app-close-requested", ()) {
                eprintln!("Cannot request safe app close: {error}");
            }
        }
    });
}
