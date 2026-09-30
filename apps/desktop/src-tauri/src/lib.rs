use local_excalidraw_filesystem as filesystem;

use filesystem::{Entry, Result, Snapshot, WorkspaceError, WorkspaceFs, WorkspaceWatcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};

mod embeds;
mod recovery;
mod viewer_server;
use recovery::{RecoveryRecord, RecoveryStore};
use viewer_server::ViewerService;

struct Workspace {
    fs: Arc<WorkspaceFs>,
    _watcher: WorkspaceWatcher,
}

#[derive(Default)]
struct WorkspaceState {
    active: HashMap<String, Workspace>,
    pending: HashMap<String, PathBuf>,
}

#[derive(Clone, Default)]
struct AppState(Arc<Mutex<WorkspaceState>>);

static NEXT_WINDOW_ID: AtomicU64 = AtomicU64::new(1);

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

#[cfg(test)]
mod link_tests {
    use super::*;

    #[test]
    fn external_links_accept_web_urls_only() {
        assert!(external_link("https://example.com/path").is_ok());
        assert!(external_link("http://localhost:3000/").is_ok());
        assert!(external_link("file:///tmp/drawing").is_err());
        assert!(external_link("javascript:alert(1)").is_err());
        assert!(external_link("https://").is_err());
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Preferences {
    workspace_path: Option<String>,
    open_tabs: Vec<String>,
    active_tab: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct WindowPreferences {
    windows: HashMap<String, Preferences>,
}

#[derive(Default)]
struct PreferencesStore(Mutex<()>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRoute {
    kind: &'static str,
    root: String,
}

#[derive(Clone, Serialize)]
struct WorkspaceEvent {
    root: String,
    error: Option<String>,
}

async fn with_workspace<T: Send + 'static>(
    state: &AppState,
    label: &str,
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
            .active
            .get(label)
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

fn check_window_root(state: &AppState, label: &str, root: &str) -> Result<()> {
    let guard = state
        .0
        .lock()
        .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))?;
    if guard
        .active
        .get(label)
        .is_none_or(|workspace| workspace.fs.root.to_string_lossy() != root)
    {
        return Err(WorkspaceError::new(
            "state",
            "This operation belongs to a different workspace window",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod window_tests {
    use super::*;

    fn workspace(root: &Path) -> Workspace {
        let fs = WorkspaceFs::open(root).unwrap();
        let watcher = WorkspaceWatcher::new(&fs.root, |_| {}).unwrap();
        Workspace {
            fs: Arc::new(fs),
            _watcher: watcher,
        }
    }

    #[test]
    fn commands_cannot_read_another_windows_folder() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = AppState::default();
        let viewer = ViewerService::default();
        viewer
            .select_workspace(&state, "main", workspace(first.path()))
            .unwrap();
        viewer
            .select_workspace(&state, "workspace-1", workspace(second.path()))
            .unwrap();
        let first_root = first
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let second_root = second
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let own = tauri::async_runtime::block_on(with_workspace(
            &state,
            "main",
            &first_root,
            format!("test\0{first_root}"),
            "unavailable",
            |fs| Ok(fs.root.clone()),
        ));
        assert_eq!(own.unwrap(), first.path().canonicalize().unwrap());
        let other = tauri::async_runtime::block_on(with_workspace(
            &state,
            "main",
            &second_root,
            format!("test\0{second_root}"),
            "unavailable",
            |fs| Ok(fs.root.clone()),
        ));
        assert_eq!(other.unwrap_err().code, "state");
        assert_eq!(
            check_window_root(&state, "workspace-1", &first_root)
                .unwrap_err()
                .code,
            "state"
        );
        assert_eq!(
            viewer
                .select_workspace(&state, "workspace-2", workspace(first.path()))
                .unwrap_err()
                .code,
            "state"
        );
    }

    #[test]
    fn old_preferences_migrate_without_losing_tabs() {
        let old =
            br#"{"workspacePath":"/a","openTabs":["one.excalidraw"],"activeTab":"one.excalidraw"}"#;
        let migrated = decode_preferences(old).unwrap();
        let main = migrated.windows.get("main").unwrap();
        assert_eq!(main.workspace_path.as_deref(), Some("/a"));
        assert_eq!(main.open_tabs, ["one.excalidraw"]);
        let multi = br#"{"windows":{"main":{"workspacePath":"/a"},"workspace-1":{"workspacePath":"/b","openTabs":["two.excalidraw"]}}}"#;
        let saved = decode_preferences(multi).unwrap();
        assert_eq!(saved.windows.len(), 2);
        assert_eq!(
            saved.windows.get("workspace-1").unwrap().open_tabs,
            ["two.excalidraw"]
        );
    }

    #[test]
    fn closing_main_keeps_other_workspace_for_restart() {
        let mut saved = decode_preferences(br#"{"windows":{"workspace-2":{"workspacePath":"/b","openTabs":["two.excalidraw"],"activeTab":"two.excalidraw"}}}"#).unwrap();
        assert!(promote_main_window(&mut saved));
        assert_eq!(saved.windows.len(), 1);
        let main = saved.windows.get("main").unwrap();
        assert_eq!(main.workspace_path.as_deref(), Some("/b"));
        assert_eq!(main.active_tab.as_deref(), Some("two.excalidraw"));
    }
}

#[tauri::command(async)]
async fn open_workspace(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    viewer: tauri::State<'_, ViewerService>,
    path: String,
) -> Result<String> {
    let label = window.label().to_string();
    let key = format!("open\0{path}");
    let opened = bounded_io(key, "unavailable", move || {
        let fs = WorkspaceFs::open(Path::new(&path))?;
        let event_root = fs.root.to_string_lossy().into_owned();
        let event_label = label.clone();
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
                if let Err(error) = app.emit_to(
                    &event_label,
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
    .await;
    let (fs, watcher) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            state
                .0
                .lock()
                .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))?
                .pending
                .remove(window.label());
            return Err(error);
        }
    };
    let root = fs.root.to_string_lossy().into_owned();
    let selected = viewer.select_workspace(
        &state,
        window.label(),
        Workspace {
            fs: Arc::new(fs),
            _watcher: watcher,
        },
    );
    if let Err(error) = selected {
        state
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))?
            .pending
            .remove(window.label());
        return Err(error);
    }
    let folder_name = Path::new(&root)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.clone());
    if let Err(error) = window.set_title(&format!("{folder_name} — Local Excalidraw")) {
        eprintln!("Cannot set workspace window title: {error}");
    }
    Ok(root)
}

#[tauri::command(async)]
async fn list_entries(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    root: String,
    path: Option<String>,
) -> Result<Vec<Entry>> {
    let key = format!("tree\0{root}\0{}", path.as_deref().unwrap_or(""));
    with_workspace(
        &state,
        window.label(),
        &root,
        key,
        "unavailable",
        move |fs| fs.list_at(path.as_deref()),
    )
    .await
}

#[tauri::command(async)]
async fn read_document(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    root: String,
    path: String,
) -> Result<Snapshot> {
    let key = format!("read\0{root}\0{path}");
    with_workspace(
        &state,
        window.label(),
        &root,
        key,
        "unavailable",
        move |fs| fs.read(&path),
    )
    .await
}

#[tauri::command(async)]
async fn save_document(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
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
    with_workspace(&state, window.label(), &root, key, "uncertain", move |fs| {
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
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    root: String,
    path: String,
) -> Result<()> {
    let key = format!("create\0{root}\0{path}");
    with_workspace(&state, window.label(), &root, key, "uncertain", move |fs| {
        fs.create_folder(&path)
    })
    .await
}

#[tauri::command(async)]
async fn move_entry(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
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
    with_workspace(&state, window.label(), &root, key, "uncertain", move |fs| {
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
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    recovery: tauri::State<'_, RecoveryStore>,
    root: String,
    path: String,
) -> Result<()> {
    let directory = recovery_directory(&app)?;
    let store = recovery.inner().clone();
    let checked_root = root.clone();
    let key = format!("trash\0{root}\0{path}");
    with_workspace(&state, window.label(), &root, key, "uncertain", move |fs| {
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
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    root: String,
    path: Option<String>,
) -> Result<()> {
    let key = format!("reveal\0{root}\0{}", path.as_deref().unwrap_or(""));
    with_workspace(
        &state,
        window.label(),
        &root,
        key,
        "unavailable",
        move |fs| {
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
        },
    )
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
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    store: tauri::State<RecoveryStore>,
    root: String,
    path: String,
) -> Result<RecoveryRecord> {
    check_window_root(&state, window.label(), &root)?;
    store.read(&recovery_directory(&app)?, &root, &path)
}

#[tauri::command(async)]
fn checkpoint_document(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    store: tauri::State<RecoveryStore>,
    root: String,
    path: String,
    content: String,
    base_hash: Option<String>,
) -> Result<String> {
    check_window_root(&state, window.label(), &root)?;
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
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    store: tauri::State<RecoveryStore>,
    root: String,
    path: String,
) -> Result<()> {
    check_window_root(&state, window.label(), &root)?;
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

fn decode_preferences(bytes: &[u8]) -> Result<WindowPreferences> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| WorkspaceError::new("invalid", format!("Cannot read app preferences: {e}")))?;
    if value.get("windows").is_some() {
        serde_json::from_value(value).map_err(|e| {
            WorkspaceError::new("invalid", format!("Cannot read window preferences: {e}"))
        })
    } else {
        let old: Preferences = serde_json::from_value(value).map_err(|e| {
            WorkspaceError::new("invalid", format!("Cannot read app preferences: {e}"))
        })?;
        let mut windows = HashMap::new();
        if old.workspace_path.is_some() {
            windows.insert("main".into(), old);
        }
        Ok(WindowPreferences { windows })
    }
}

fn promote_main_window(saved: &mut WindowPreferences) -> bool {
    if saved.windows.contains_key("main") {
        return false;
    }
    let label = saved
        .windows
        .iter()
        .filter(|(label, preferences)| {
            label.starts_with("workspace-") && preferences.workspace_path.is_some()
        })
        .map(|(label, _)| label.clone())
        .min();
    let Some(label) = label else { return false };
    if let Some(preferences) = saved.windows.remove(&label) {
        saved.windows.insert("main".into(), preferences);
        return true;
    }
    false
}

fn read_preferences(app: &tauri::AppHandle) -> Result<WindowPreferences> {
    let path = preferences_path(app)?;
    match fs::read(path) {
        Ok(bytes) => decode_preferences(&bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(WindowPreferences::default()),
        Err(e) => Err(WorkspaceError::new(
            "io",
            format!("Cannot read app preferences: {e}"),
        )),
    }
}

fn write_preferences(app: &tauri::AppHandle, preferences: &WindowPreferences) -> Result<()> {
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

#[tauri::command(async)]
fn load_preferences(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    store: tauri::State<PreferencesStore>,
) -> Result<Preferences> {
    let _guard = store
        .0
        .lock()
        .map_err(|_| WorkspaceError::new("state", "Preferences lock poisoned"))?;
    Ok(read_preferences(&app)?
        .windows
        .remove(window.label())
        .unwrap_or_default())
}

#[tauri::command(async)]
fn save_preferences(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    store: tauri::State<PreferencesStore>,
    preferences: Preferences,
) -> Result<()> {
    let _guard = store
        .0
        .lock()
        .map_err(|_| WorkspaceError::new("state", "Preferences lock poisoned"))?;
    let mut saved = read_preferences(&app)?;
    if preferences.workspace_path.is_some() {
        saved.windows.insert(window.label().into(), preferences);
    } else {
        saved.windows.remove(window.label());
    }
    write_preferences(&app, &saved)
}

fn remove_preferences(app: &tauri::AppHandle, store: &PreferencesStore, label: &str) -> Result<()> {
    let _guard = store
        .0
        .lock()
        .map_err(|_| WorkspaceError::new("state", "Preferences lock poisoned"))?;
    let mut saved = read_preferences(app)?;
    saved.windows.remove(label);
    write_preferences(app, &saved)
}

#[tauri::command(async)]
async fn route_workspace(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    store: tauri::State<'_, PreferencesStore>,
    path: String,
    selected_file: Option<String>,
) -> Result<WorkspaceRoute> {
    let key = format!("route\0{path}");
    let root = bounded_io(key, "unavailable", move || {
        Ok(WorkspaceFs::open(Path::new(&path))?.root)
    })
    .await?;
    let root_text = root.to_string_lossy().into_owned();
    let current = window.label();
    let (kind, label) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))?;
        let existing = guard
            .active
            .iter()
            .find_map(|(label, selected)| (selected.fs.root == root).then(|| label.clone()))
            .or_else(|| {
                guard
                    .pending
                    .iter()
                    .find_map(|(label, pending)| (*pending == root).then(|| label.clone()))
            });
        if let Some(label) = existing {
            (
                if label == current {
                    "current"
                } else {
                    "focused"
                },
                label,
            )
        } else if !guard.active.contains_key(current) && !guard.pending.contains_key(current) {
            ("current", current.to_string())
        } else {
            let label = loop {
                let id = NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
                let candidate = format!("workspace-{id}");
                if !guard.active.contains_key(&candidate)
                    && !guard.pending.contains_key(&candidate)
                    && app.get_webview_window(&candidate).is_none()
                {
                    break candidate;
                }
            };
            guard.pending.insert(label.clone(), root);
            ("new", label)
        }
    };
    if kind == "focused" {
        let target = app.get_webview_window(&label).ok_or_else(|| {
            WorkspaceError::new("state", "The existing workspace window has closed; retry")
        })?;
        target.set_focus().map_err(|e| {
            WorkspaceError::new("window", format!("Cannot focus workspace window: {e}"))
        })?;
        if let Some(file) = selected_file.as_ref() {
            let pending = state
                .0
                .lock()
                .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))?
                .pending
                .contains_key(&label);
            if pending {
                let _guard = store
                    .0
                    .lock()
                    .map_err(|_| WorkspaceError::new("state", "Preferences lock poisoned"))?;
                let mut saved = read_preferences(&app)?;
                if let Some(preferences) = saved.windows.get_mut(&label) {
                    if !preferences.open_tabs.contains(file) {
                        preferences.open_tabs.push(file.clone());
                    }
                    preferences.active_tab = Some(file.clone());
                    write_preferences(&app, &saved)?;
                }
            } else {
                app.emit_to(&label, "open-drawing", file).map_err(|e| {
                    WorkspaceError::new(
                        "window",
                        format!("Cannot open drawing in workspace window: {e}"),
                    )
                })?;
            }
        }
    } else if kind == "new" {
        let preferences = Preferences {
            workspace_path: Some(root_text.clone()),
            open_tabs: selected_file.iter().cloned().collect(),
            active_tab: selected_file,
        };
        let saved = (|| {
            let _guard = store
                .0
                .lock()
                .map_err(|_| WorkspaceError::new("state", "Preferences lock poisoned"))?;
            let mut saved = read_preferences(&app)?;
            saved.windows.insert(label.clone(), preferences);
            write_preferences(&app, &saved)
        })();
        if let Err(error) = saved {
            state
                .0
                .lock()
                .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))?
                .pending
                .remove(&label);
            return Err(error);
        }
        let built = tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Local Excalidraw")
        .inner_size(1360.0, 900.0)
        .min_inner_size(850.0, 560.0)
        .build();
        match built {
            Ok(created) => {
                if let Err(error) = created.set_focus() {
                    eprintln!("Cannot focus new workspace window: {error}");
                }
            }
            Err(error) => {
                state
                    .0
                    .lock()
                    .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))?
                    .pending
                    .remove(&label);
                remove_preferences(&app, &store, &label)?;
                return Err(WorkspaceError::new(
                    "window",
                    format!("Cannot open workspace window: {error}"),
                ));
            }
        }
    }
    Ok(WorkspaceRoute {
        kind,
        root: root_text,
    })
}

#[tauri::command]
fn close_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    viewer: tauri::State<ViewerService>,
    store: tauri::State<PreferencesStore>,
    preserve_session: bool,
) -> Result<()> {
    if !preserve_session {
        remove_preferences(&app, &store, window.label())?;
    }
    viewer.remove_window(&state, window.label())?;
    window
        .destroy()
        .map_err(|e| WorkspaceError::new("window", format!("Cannot close window: {e}")))?;
    if app.webview_windows().is_empty() {
        app.exit(0);
    }
    Ok(())
}

#[tauri::command]
fn youtube_embed_base(server: tauri::State<embeds::EmbedServer>) -> String {
    server.base.clone()
}

#[tauri::command]
fn viewer_url(
    window: tauri::WebviewWindow,
    server: tauri::State<ViewerService>,
) -> Result<Option<String>> {
    server.url(window.label())
}

#[tauri::command]
fn start_viewer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    server: tauri::State<ViewerService>,
) -> Result<String> {
    server.start(window.label(), app, state.inner().clone())
}

#[tauri::command]
fn stop_viewer(window: tauri::WebviewWindow, server: tauri::State<ViewerService>) -> Result<()> {
    server.stop(window.label())
}

fn external_link(link: &str) -> Result<tauri::Url> {
    let url = tauri::Url::parse(link)
        .map_err(|error| WorkspaceError::new("link", format!("Invalid link: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(WorkspaceError::new("link", "Only web links can be opened"));
    }
    Ok(url)
}

#[tauri::command(async)]
async fn open_external_link(link: String) -> Result<()> {
    let url = external_link(&link)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("/usr/bin/open");
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = std::process::Command::new("rundll32.exe");
            command.arg("url.dll,FileProtocolHandler");
            command
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = std::process::Command::new("xdg-open");
        let status = command.arg(url.as_str()).status().map_err(|error| {
            WorkspaceError::new(
                "link",
                format!("Cannot launch the default browser: {error}"),
            )
        })?;
        if !status.success() {
            return Err(WorkspaceError::new(
                "link",
                format!("Default browser launcher exited with {status}"),
            ));
        }
        Ok(())
    })
    .await
    .map_err(|error| WorkspaceError::new("link", format!("Browser launch task failed: {error}")))?
}

/// Launch the local desktop workspace.
pub fn run() {
    let workspace = AppState::default();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(workspace)
        .manage(ViewerService::default())
        .manage(PreferencesStore::default())
        .manage(RecoveryStore::default())
        .manage(embeds::EmbedServer::start().expect("Cannot start YouTube player listener"))
        .setup(|app| {
            let mut saved = match read_preferences(app.handle()) {
                Ok(saved) => saved,
                Err(error) => {
                    eprintln!("Cannot restore workspace windows: {}", error.message);
                    WindowPreferences::default()
                }
            };
            if promote_main_window(&mut saved) {
                if let Err(error) = write_preferences(app.handle(), &saved) {
                    eprintln!("Cannot save restored window layout: {}", error.message);
                    saved = read_preferences(app.handle()).unwrap_or_default();
                }
            }
            if let Some(root) = saved
                .windows
                .get("main")
                .and_then(|preferences| preferences.workspace_path.as_ref())
            {
                app.state::<AppState>()
                    .0
                    .lock()
                    .map_err(|_| std::io::Error::other("Workspace state lock was poisoned"))?
                    .pending
                    .insert("main".into(), PathBuf::from(root));
            }
            for (label, preferences) in saved.windows {
                if label == "main"
                    || !label.starts_with("workspace-")
                    || label.len() == 10
                    || !label[10..].chars().all(|c| c.is_ascii_digit())
                {
                    continue;
                }
                let Some(root) = preferences.workspace_path else {
                    continue;
                };
                let state = app.state::<AppState>();
                state
                    .0
                    .lock()
                    .map_err(|_| std::io::Error::other("Workspace state lock was poisoned"))?
                    .pending
                    .insert(label.clone(), PathBuf::from(root));
                if let Err(error) = tauri::WebviewWindowBuilder::new(
                    app,
                    &label,
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Local Excalidraw")
                .inner_size(1360.0, 900.0)
                .min_inner_size(850.0, 560.0)
                .build()
                {
                    state
                        .0
                        .lock()
                        .map_err(|_| std::io::Error::other("Workspace state lock was poisoned"))?
                        .pending
                        .remove(&label);
                    eprintln!("Cannot restore workspace window {label}: {error}");
                }
            }
            Ok(())
        })
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
            route_workspace,
            close_window,
            youtube_embed_base,
            viewer_url,
            start_viewer,
            stop_viewer,
            open_external_link
        ])
        .build(tauri::generate_context!())
        .expect("Cannot initialize Local Excalidraw");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            if app.webview_windows().is_empty() {
                return;
            }
            api.prevent_exit();
            if let Err(error) = app.emit("app-close-requested", ()) {
                eprintln!("Cannot request safe app close: {error}");
            }
        }
    });
}
