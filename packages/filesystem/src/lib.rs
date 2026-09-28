use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

mod coordination;
mod watcher;
pub use watcher::WorkspaceWatcher;

pub type Result<T> = std::result::Result<T, WorkspaceError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceError {
    pub code: String,
    pub message: String,
}

impl WorkspaceError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

fn io_error(context: &str, error: std::io::Error) -> WorkspaceError {
    WorkspaceError::new(
        if error.kind() == ErrorKind::NotFound {
            "missing"
        } else {
            "io"
        },
        format!("{context}: {error}"),
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub content: String,
    pub hash: String,
    pub modified_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub children: Vec<Entry>,
}

/// All operations use paths relative to one canonical workspace root.
#[derive(Clone)]
pub struct WorkspaceFs {
    pub root: PathBuf,
}

impl WorkspaceFs {
    pub fn open(root: &Path) -> Result<Self> {
        let root = root
            .canonicalize()
            .map_err(|e| io_error("Cannot open workspace", e))?;
        if !root.is_dir() {
            return Err(WorkspaceError::new("path", "Workspace must be a directory"));
        }
        Ok(Self { root })
    }

    /// Reject symlinks, parent traversal, absolute paths, and reserved internal names.
    pub fn resolve(&self, relative: &str, allow_missing: bool) -> Result<PathBuf> {
        let path = Path::new(relative);
        if relative.is_empty()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(WorkspaceError::new(
                "path",
                "Use a nonempty path inside the workspace",
            ));
        }
        let mut current = self.root.clone();
        let parts: Vec<_> = path.components().collect();
        for (index, part) in parts.iter().enumerate() {
            if part.as_os_str().to_string_lossy().starts_with('.') {
                return Err(WorkspaceError::new(
                    "path",
                    "Hidden paths are not workspace documents",
                ));
            }
            current.push(part.as_os_str());
            match fs::symlink_metadata(&current) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        return Err(WorkspaceError::new(
                            "path",
                            "Symbolic links are not supported inside workspaces",
                        ));
                    }
                    let canonical = current
                        .canonicalize()
                        .map_err(|e| io_error("Cannot resolve path", e))?;
                    if !canonical.starts_with(&self.root) {
                        return Err(WorkspaceError::new("path", "Path is outside the workspace"));
                    }
                }
                Err(e)
                    if e.kind() == ErrorKind::NotFound
                        && allow_missing
                        && index + 1 == parts.len() => {}
                Err(e) => return Err(io_error("Cannot resolve workspace path", e)),
            }
        }
        Ok(current)
    }

    /// Persistent lock inode, advisory flock, released by the OS on process exit.
    /// Desktop and MCP writes use this same inode for compare-and-save.
    fn lock(&self) -> Result<File> {
        let path = self.root.join(".excalidraw-workspace.lock");
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(WorkspaceError::new(
                "path",
                "Workspace lock must not be a symbolic link",
            ));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|e| io_error("Cannot open workspace lock", e))?;
        let start = Instant::now();
        loop {
            match FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(file),
                Err(e)
                    if e.kind() == ErrorKind::WouldBlock
                        && start.elapsed() < Duration::from_secs(3) =>
                {
                    thread::sleep(Duration::from_millis(15))
                }
                Err(e) => return Err(io_error("Workspace is busy; retry the operation", e)),
            }
        }
    }

    pub fn tree(&self) -> Result<Vec<Entry>> {
        self.walk(&self.root, true)
    }

    /// List a workspace subdirectory using the same path boundary as document I/O.
    pub fn tree_at(&self, relative: Option<&str>) -> Result<Vec<Entry>> {
        match relative {
            None | Some("") => self.tree(),
            Some(relative) => self.walk(&self.resolve(relative, false)?, true),
        }
    }

    /// List only one folder so a cloud workspace never needs full hydration to appear.
    pub fn list_at(&self, relative: Option<&str>) -> Result<Vec<Entry>> {
        match relative {
            None | Some("") => self.walk(&self.root, false),
            Some(relative) => self.walk(&self.resolve(relative, false)?, false),
        }
    }

    fn walk(&self, directory: &Path, recursive: bool) -> Result<Vec<Entry>> {
        let mut entries = Vec::new();
        for item in fs::read_dir(directory).map_err(|e| io_error("Cannot list directory", e))? {
            let item = item.map_err(|e| io_error("Cannot read directory entry", e))?;
            let name = item.file_name().to_string_lossy().into_owned();
            let kind = item
                .file_type()
                .map_err(|e| io_error("Cannot inspect directory entry", e))?;
            if name.starts_with('.') || kind.is_symlink() {
                continue;
            }
            let path = item.path();
            if !kind.is_dir() && !is_supported(&path) {
                continue;
            }
            entries.push(Entry {
                name,
                path: path
                    .strip_prefix(&self.root)
                    .map_err(|_| WorkspaceError::new("path", "Entry escaped workspace"))?
                    .to_string_lossy()
                    .into_owned(),
                kind: if kind.is_dir() {
                    "folder"
                } else if path.extension().is_some_and(|ext| ext == "excalidrawlib") {
                    "library"
                } else {
                    "drawing"
                },
                children: if kind.is_dir() && recursive {
                    self.walk(&path, true)?
                } else {
                    Vec::new()
                },
            });
        }
        entries.sort_by(|a, b| {
            (a.kind != "folder", a.name.to_lowercase())
                .cmp(&(b.kind != "folder", b.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub fn read(&self, relative: &str) -> Result<Snapshot> {
        let path = self.resolve(relative, false)?;
        if !is_supported(&path) {
            return Err(WorkspaceError::new(
                "type",
                "Only Excalidraw drawings and libraries can be opened",
            ));
        }
        coordination::read(&path, read_snapshot)
    }

    /// Compare-and-save is serialized across cooperating processes and retry-safe.
    pub fn save(
        &self,
        relative: &str,
        content: &str,
        expected_hash: Option<&str>,
    ) -> Result<Snapshot> {
        validate_drawing(content)?;
        let path = self.resolve(relative, true)?;
        if path.extension().is_none_or(|ext| ext != "excalidraw") {
            return Err(WorkspaceError::new(
                "type",
                "Drawings must have the .excalidraw extension",
            ));
        }
        coordination::write(&path, |coordinated_path| {
            self.save_at(coordinated_path, content, expected_hash)
        })
    }

    fn save_at(&self, path: &Path, content: &str, expected_hash: Option<&str>) -> Result<Snapshot> {
        let _lock = self.lock()?;
        let existing = match read_snapshot(&path) {
            Ok(snapshot) => Some(snapshot),
            Err(error) if error.code == "missing" => None,
            Err(error) => return Err(error),
        };
        if expected_hash.is_some()
            && existing
                .as_ref()
                .is_some_and(|snapshot| snapshot.content == content)
        {
            return existing.ok_or_else(|| WorkspaceError::new("missing", "Drawing disappeared"));
        }
        if existing.as_ref().map(|s| s.hash.as_str()) != expected_hash {
            return Err(WorkspaceError::new(
                "conflict",
                "The file on disk changed. Choose which version to keep.",
            ));
        }
        let parent = path
            .parent()
            .ok_or_else(|| WorkspaceError::new("path", "Missing parent directory"))?;
        let mut temp = tempfile::Builder::new()
            .prefix(".excalidraw-save-")
            .tempfile_in(parent)
            .map_err(|e| io_error("Cannot create temporary drawing", e))?;
        if existing.is_some() {
            let permissions = fs::metadata(&path)
                .map_err(|e| io_error("Cannot read drawing permissions", e))?
                .permissions();
            temp.as_file()
                .set_permissions(permissions)
                .map_err(|e| io_error("Cannot preserve drawing permissions", e))?;
        }
        temp.write_all(content.as_bytes())
            .map_err(|e| io_error("Cannot write temporary drawing", e))?;
        temp.as_file()
            .sync_all()
            .map_err(|e| io_error("Cannot sync temporary drawing", e))?;
        // Check again immediately before rename; unrelated editors do not honor our lock.
        let latest = match read_snapshot(&path) {
            Ok(snapshot) => Some(snapshot.hash),
            Err(error) if error.code == "missing" => None,
            Err(error) => return Err(error),
        };
        if latest.as_deref() != expected_hash {
            return Err(WorkspaceError::new(
                "conflict",
                "The file changed during the save",
            ));
        }
        if expected_hash.is_none() {
            temp.persist_noclobber(&path).map_err(|e| {
                io_error(
                    "Cannot create drawing without overwriting an existing file",
                    e.error,
                )
            })?;
        } else {
            temp.persist(&path)
                .map_err(|e| io_error("Cannot replace drawing atomically", e.error))?;
        }
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|e| {
                io_error(
                    "Drawing was written, but directory sync failed; retry to verify",
                    e,
                )
            })?;
        // Return the committed bytes, not a potentially newer external version.
        Ok(Snapshot {
            content: content.into(),
            hash: hash(content.as_bytes()),
            modified_at: modified_at(&path)?,
        })
    }

    pub fn create_folder(&self, relative: &str) -> Result<()> {
        let _lock = self.lock()?;
        let path = self.resolve(relative, true)?;
        fs::create_dir(path).map_err(|e| io_error("Cannot create folder", e))
    }

    pub fn move_entry(&self, from: &str, to: &str) -> Result<()> {
        let _lock = self.lock()?;
        let source = self.resolve(from, false)?;
        let destination = self.resolve(to, true)?;
        if source.is_file()
            && (!is_supported(&source) || source.extension() != destination.extension())
        {
            return Err(WorkspaceError::new(
                "type",
                "Keep the original Excalidraw file extension",
            ));
        }
        if destination.exists() {
            return Err(WorkspaceError::new(
                "exists",
                "A file or folder already has that name",
            ));
        }
        if destination.starts_with(&source) {
            return Err(WorkspaceError::new(
                "path",
                "Cannot move a folder into itself",
            ));
        }
        fs::rename(source, destination).map_err(|e| io_error("Cannot move entry", e))
    }

    pub fn trash_entry(&self, relative: &str) -> Result<()> {
        let _lock = self.lock()?;
        let path = self.resolve(relative, false)?;
        if path.is_file() && !is_supported(&path) {
            return Err(WorkspaceError::new("type", "Unsupported file type"));
        }
        trash::delete(path)
            .map_err(|e| WorkspaceError::new("io", format!("Cannot move entry to Trash: {e}")))
    }
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext == "excalidraw" || ext == "excalidrawlib")
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn modified_at(path: &Path) -> Result<u64> {
    let time = fs::metadata(path)
        .and_then(|m| m.modified())
        .map_err(|e| io_error("Cannot read modification time", e))?;
    Ok(time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64)
}

fn read_snapshot(path: &Path) -> Result<Snapshot> {
    let bytes = fs::read(path).map_err(|e| io_error("Cannot read drawing", e))?;
    let hash = hash(&bytes);
    let content = String::from_utf8(bytes)
        .map_err(|e| WorkspaceError::new("invalid", format!("Drawing is not UTF-8: {e}")))?;
    Ok(Snapshot {
        content,
        hash,
        modified_at: modified_at(path)?,
    })
}

fn validate_drawing(content: &str) -> Result<()> {
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| WorkspaceError::new("invalid", format!("Invalid drawing JSON: {e}")))?;
    if value["type"] != "excalidraw"
        || !value["elements"].is_array()
        || !value["appState"].is_object()
    {
        return Err(WorkspaceError::new(
            "invalid",
            "Expected an Excalidraw drawing with elements and appState",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
