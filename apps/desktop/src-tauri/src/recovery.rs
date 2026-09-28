use local_excalidraw_filesystem::{hash, Result, Snapshot, WorkspaceError, WorkspaceFs};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
unsafe extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryVersion {
    pub content: String,
    pub hash: String,
    pub base_hash: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub root: String,
    pub path: String,
    pub written: Option<RecoveryVersion>,
    pub pending: Option<RecoveryVersion>,
}

#[derive(Clone, Default)]
pub struct RecoveryStore(Arc<Mutex<()>>);

impl RecoveryStore {
    fn lock_directory(directory: &Path) -> Result<File> {
        fs::create_dir_all(directory).map_err(|e| {
            WorkspaceError::new("recovery", format!("Cannot create local recovery: {e}"))
        })?;
        let path = directory.join(".recovery.lock");
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(WorkspaceError::new(
                "recovery",
                "Recovery lock must not be a symlink",
            ));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot open recovery lock: {e}"))
            })?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let start = Instant::now();
            loop {
                if unsafe { flock(file.as_raw_fd(), 2 | 4) } == 0 {
                    break;
                }
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::WouldBlock
                    && start.elapsed() < Duration::from_secs(3)
                {
                    thread::sleep(Duration::from_millis(15));
                    continue;
                }
                return Err(WorkspaceError::new(
                    "recovery",
                    format!("Cannot lock local recovery: {error}"),
                ));
            }
        }
        Ok(file)
    }

    pub fn save(
        &self,
        directory: &Path,
        fs: &WorkspaceFs,
        root: &str,
        path: &str,
        content: &str,
        expected_hash: Option<&str>,
    ) -> Result<Snapshot> {
        self.checkpoint(
            directory,
            root,
            path,
            content,
            expected_hash.map(str::to_owned),
        )?;
        let saved = fs.save(path, content, expected_hash)?;
        self.saved(directory, root, path, content)?;
        Ok(saved)
    }

    fn record_path(directory: &Path, root: &str, path: &str) -> PathBuf {
        directory.join(format!(
            "{}.json",
            hash(format!("{root}\0{path}").as_bytes())
        ))
    }

    fn read_unlocked(directory: &Path, root: &str, path: &str) -> Result<RecoveryRecord> {
        let record_path = Self::record_path(directory, root, path);
        match fs::read(&record_path) {
            Ok(bytes) => {
                let record: RecoveryRecord = serde_json::from_slice(&bytes).map_err(|e| {
                    WorkspaceError::new("recovery", format!("Cannot decode local recovery: {e}"))
                })?;
                if record.root != root || record.path != path {
                    return Err(WorkspaceError::new(
                        "recovery",
                        "Local recovery identity mismatch",
                    ));
                }
                Ok(record)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RecoveryRecord {
                root: root.into(),
                path: path.into(),
                written: None,
                pending: None,
            }),
            Err(e) => Err(WorkspaceError::new(
                "recovery",
                format!("Cannot read local recovery: {e}"),
            )),
        }
    }

    fn write_unlocked(directory: &Path, record: &RecoveryRecord) -> Result<()> {
        fs::create_dir_all(directory).map_err(|e| {
            WorkspaceError::new("recovery", format!("Cannot create local recovery: {e}"))
        })?;
        let bytes = serde_json::to_vec(record).map_err(|e| {
            WorkspaceError::new("recovery", format!("Cannot encode local recovery: {e}"))
        })?;
        let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| {
            WorkspaceError::new(
                "recovery",
                format!("Cannot create recovery checkpoint: {e}"),
            )
        })?;
        temp.write_all(&bytes)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot write recovery checkpoint: {e}"))
            })?;
        temp.persist(Self::record_path(directory, &record.root, &record.path))
            .map_err(|e| {
                WorkspaceError::new(
                    "recovery",
                    format!("Cannot replace recovery checkpoint: {}", e.error),
                )
            })?;
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot sync recovery directory: {e}"))
            })
    }

    pub fn read(&self, directory: &Path, root: &str, path: &str) -> Result<RecoveryRecord> {
        let _guard = self
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("recovery", "Recovery lock poisoned"))?;
        let _file_lock = Self::lock_directory(directory)?;
        Self::read_unlocked(directory, root, path)
    }

    pub fn checkpoint(
        &self,
        directory: &Path,
        root: &str,
        path: &str,
        content: &str,
        base_hash: Option<String>,
    ) -> Result<String> {
        let _guard = self
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("recovery", "Recovery lock poisoned"))?;
        let _file_lock = Self::lock_directory(directory)?;
        let mut record = Self::read_unlocked(directory, root, path)?;
        let content_hash = hash(content.as_bytes());
        record.pending = Some(RecoveryVersion {
            content: content.into(),
            hash: content_hash.clone(),
            base_hash,
        });
        Self::write_unlocked(directory, &record)?;
        Ok(content_hash)
    }

    pub fn saved(&self, directory: &Path, root: &str, path: &str, content: &str) -> Result<()> {
        let _guard = self
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("recovery", "Recovery lock poisoned"))?;
        let _file_lock = Self::lock_directory(directory)?;
        let mut record = Self::read_unlocked(directory, root, path)?;
        let content_hash = hash(content.as_bytes());
        record.written = Some(RecoveryVersion {
            content: content.into(),
            hash: content_hash.clone(),
            base_hash: None,
        });
        if record
            .pending
            .as_ref()
            .is_some_and(|pending| pending.hash == content_hash)
        {
            record.pending = None;
        }
        Self::write_unlocked(directory, &record)
    }

    pub fn accept_external(&self, directory: &Path, root: &str, path: &str) -> Result<()> {
        let _guard = self
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("recovery", "Recovery lock poisoned"))?;
        let _file_lock = Self::lock_directory(directory)?;
        let record_path = Self::record_path(directory, root, path);
        match fs::remove_file(record_path) {
            Ok(()) => File::open(directory)
                .and_then(|file| file.sync_all())
                .map_err(|e| {
                    WorkspaceError::new(
                        "recovery",
                        format!("Cannot sync recovered version removal: {e}"),
                    )
                }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(WorkspaceError::new(
                "recovery",
                format!("Cannot clear resolved recovery: {e}"),
            )),
        }
    }

    pub fn moved(&self, directory: &Path, root: &str, from: &str, to: &str) -> Result<()> {
        let _guard = self
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("recovery", "Recovery lock poisoned"))?;
        let _file_lock = Self::lock_directory(directory)?;
        let mut updates = Vec::new();
        for entry in fs::read_dir(directory).map_err(|e| {
            WorkspaceError::new("recovery", format!("Cannot list local recovery: {e}"))
        })? {
            let entry = entry.map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot inspect local recovery: {e}"))
            })?;
            if entry.path().extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let bytes = fs::read(entry.path()).map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot read local recovery: {e}"))
            })?;
            let mut record: RecoveryRecord = serde_json::from_slice(&bytes).map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot decode local recovery: {e}"))
            })?;
            if record.root != root
                || !(record.path == from || record.path.starts_with(&format!("{from}/")))
            {
                continue;
            }
            let original = entry.path();
            record.path = format!("{to}{}", &record.path[from.len()..]);
            let destination = Self::record_path(directory, root, &record.path);
            if destination.exists() {
                let existing = Self::read_unlocked(directory, root, &record.path)?;
                if existing.written.as_ref().map(|version| &version.hash)
                    != record.written.as_ref().map(|version| &version.hash)
                    || existing.pending.as_ref().map(|version| &version.hash)
                        != record.pending.as_ref().map(|version| &version.hash)
                {
                    return Err(WorkspaceError::new(
                        "recovery",
                        "Destination recovery already contains another version",
                    ));
                }
            } else {
                Self::write_unlocked(directory, &record)?;
            }
            updates.push(original);
        }
        for original in updates {
            fs::remove_file(original).map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot clear old recovery path: {e}"))
            })?;
        }
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|e| WorkspaceError::new("recovery", format!("Cannot sync recovery move: {e}")))
    }

    pub fn trashed(&self, directory: &Path, root: &str, path: &str) -> Result<()> {
        let _guard = self
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("recovery", "Recovery lock poisoned"))?;
        let _file_lock = Self::lock_directory(directory)?;
        for entry in fs::read_dir(directory).map_err(|e| {
            WorkspaceError::new("recovery", format!("Cannot list local recovery: {e}"))
        })? {
            let entry = entry.map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot inspect local recovery: {e}"))
            })?;
            if entry.path().extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let bytes = fs::read(entry.path()).map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot read local recovery: {e}"))
            })?;
            let record: RecoveryRecord = serde_json::from_slice(&bytes).map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot decode local recovery: {e}"))
            })?;
            if record.root == root
                && (record.path == path || record.path.starts_with(&format!("{path}/")))
            {
                fs::remove_file(entry.path()).map_err(|e| {
                    WorkspaceError::new("recovery", format!("Cannot clear trashed recovery: {e}"))
                })?;
            }
        }
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|e| {
                WorkspaceError::new("recovery", format!("Cannot sync recovery removal: {e}"))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_survives_restart_and_failed_save() {
        let directory = tempfile::tempdir().unwrap();
        let store = RecoveryStore::default();
        store
            .checkpoint(
                directory.path(),
                "root",
                "a.excalidraw",
                "local",
                Some("base".into()),
            )
            .unwrap();
        let restarted = RecoveryStore::default();
        let record = restarted
            .read(directory.path(), "root", "a.excalidraw")
            .unwrap();
        assert_eq!(record.pending.unwrap().content, "local");
    }

    #[test]
    fn later_checkpoint_is_not_cleared_by_older_save() {
        let directory = tempfile::tempdir().unwrap();
        let store = RecoveryStore::default();
        store
            .checkpoint(directory.path(), "root", "a.excalidraw", "first", None)
            .unwrap();
        store
            .checkpoint(directory.path(), "root", "a.excalidraw", "second", None)
            .unwrap();
        store
            .saved(directory.path(), "root", "a.excalidraw", "first")
            .unwrap();
        let record = store
            .read(directory.path(), "root", "a.excalidraw")
            .unwrap();
        assert_eq!(record.written.unwrap().content, "first");
        assert_eq!(record.pending.unwrap().content, "second");
    }

    #[test]
    fn failed_checkpoint_prevents_workspace_write() {
        let workspace_dir = tempfile::tempdir().unwrap();
        let fs = WorkspaceFs::open(workspace_dir.path()).unwrap();
        let recovery_file = tempfile::NamedTempFile::new().unwrap();
        let store = RecoveryStore::default();
        assert_eq!(
            store
                .save(
                    recovery_file.path(),
                    &fs,
                    "root",
                    "a.excalidraw",
                    "{}",
                    None
                )
                .unwrap_err()
                .code,
            "recovery"
        );
        assert!(!fs.root.join("a.excalidraw").exists());
    }

    #[test]
    fn folder_move_carries_recovery_and_trash_bounds_history() {
        let directory = tempfile::tempdir().unwrap();
        let store = RecoveryStore::default();
        store
            .checkpoint(directory.path(), "root", "old/a.excalidraw", "local", None)
            .unwrap();
        store
            .saved(directory.path(), "root", "old/a.excalidraw", "local")
            .unwrap();
        store.moved(directory.path(), "root", "old", "new").unwrap();
        assert!(store
            .read(directory.path(), "root", "old/a.excalidraw")
            .unwrap()
            .written
            .is_none());
        assert_eq!(
            store
                .read(directory.path(), "root", "new/a.excalidraw")
                .unwrap()
                .written
                .unwrap()
                .content,
            "local"
        );
        store.trashed(directory.path(), "root", "new").unwrap();
        assert!(store
            .read(directory.path(), "root", "new/a.excalidraw")
            .unwrap()
            .written
            .is_none());
    }

    #[test]
    fn independent_instances_keep_written_and_pending_versions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_path_buf();
        for index in 0..8 {
            let document = format!("{index}.excalidraw");
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let first = {
                let path = path.clone();
                let document = document.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    RecoveryStore::default()
                        .checkpoint(&path, "root", &document, "pending", None)
                        .unwrap();
                })
            };
            barrier.wait();
            RecoveryStore::default()
                .saved(&path, "root", &document, "written")
                .unwrap();
            first.join().unwrap();
            let record = RecoveryStore::default()
                .read(&path, "root", &document)
                .unwrap();
            assert_eq!(record.written.unwrap().content, "written");
        }
    }
}
