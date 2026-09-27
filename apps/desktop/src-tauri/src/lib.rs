use local_excalidraw_filesystem as filesystem;

use filesystem::{Entry, Result, Snapshot, WorkspaceError, WorkspaceFs, WorkspaceWatcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

mod embeds;

struct Workspace {
    fs: WorkspaceFs,
    _watcher: WorkspaceWatcher,
}

#[derive(Default)]
struct AppState(Mutex<Option<Workspace>>);

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

fn with_workspace<T>(
    state: &AppState,
    root: &str,
    action: impl FnOnce(&WorkspaceFs) -> Result<T>,
) -> Result<T> {
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
    action(&workspace.fs)
}

#[tauri::command(async)]
fn open_workspace(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    path: String,
) -> Result<String> {
    let fs = WorkspaceFs::open(Path::new(&path))?;
    let root = fs.root.to_string_lossy().into_owned();
    let event_root = root.clone();
    let watcher = WorkspaceWatcher::new(&fs.root, move |event: notify::Result<notify::Event>| {
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
    *state
        .0
        .lock()
        .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))? =
        Some(Workspace {
            fs,
            _watcher: watcher,
        });
    Ok(root)
}

#[tauri::command(async)]
fn list_entries(state: tauri::State<AppState>, root: String) -> Result<Vec<Entry>> {
    with_workspace(&state, &root, |fs| fs.tree())
}

#[tauri::command(async)]
fn read_document(state: tauri::State<AppState>, root: String, path: String) -> Result<Snapshot> {
    with_workspace(&state, &root, |fs| fs.read(&path))
}

#[tauri::command(async)]
fn save_document(
    state: tauri::State<AppState>,
    root: String,
    path: String,
    content: String,
    expected_hash: Option<String>,
) -> Result<Snapshot> {
    with_workspace(&state, &root, |fs| {
        fs.save(&path, &content, expected_hash.as_deref())
    })
}

#[tauri::command(async)]
fn create_folder(state: tauri::State<AppState>, root: String, path: String) -> Result<()> {
    with_workspace(&state, &root, |fs| fs.create_folder(&path))
}

#[tauri::command(async)]
fn move_entry(state: tauri::State<AppState>, root: String, from: String, to: String) -> Result<()> {
    with_workspace(&state, &root, |fs| fs.move_entry(&from, &to))
}

#[tauri::command(async)]
fn trash_entry(state: tauri::State<AppState>, root: String, path: String) -> Result<()> {
    with_workspace(&state, &root, |fs| fs.trash_entry(&path))
}

#[tauri::command(async)]
fn reveal_entry(state: tauri::State<AppState>, root: String, path: Option<String>) -> Result<()> {
    with_workspace(&state, &root, |fs| {
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
        .manage(embeds::EmbedServer::start().expect("Cannot start YouTube player listener"))
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            list_entries,
            read_document,
            save_document,
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
