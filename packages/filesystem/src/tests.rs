use super::*;
use std::sync::{Arc, Barrier};

fn scene(label: &str) -> String {
    serde_json::json!({ "type": "excalidraw", "version": 2, "elements": [], "appState": {}, "files": {}, "testLabel": label }).to_string()
}

fn fixture() -> (tempfile::TempDir, WorkspaceFs) {
    let directory = tempfile::tempdir().unwrap();
    let fs = WorkspaceFs::open(directory.path()).unwrap();
    (directory, fs)
}

#[test]
fn rejects_traversal_absolute_hidden_and_symlink_paths() {
    let (_directory, fs) = fixture();
    for path in [
        "../escape.excalidraw",
        "/tmp/escape.excalidraw",
        "",
        ".internal",
        "folder/../../escape",
        ".excalidraw-workspace.lock",
    ] {
        assert!(fs.resolve(path, true).is_err(), "{path}");
    }
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), fs.root.join("linked")).unwrap();
    assert!(fs.resolve("linked/escape.excalidraw", true).is_err());
    assert!(fs.tree().unwrap().is_empty());
}

#[test]
fn rejects_prefix_sibling_escape_and_missing_parent() {
    let (_directory, fs) = fixture();
    let sibling = format!("{}-other/file.excalidraw", fs.root.display());
    assert!(fs.resolve(&sibling, true).is_err());
    assert!(fs
        .save("missing/file.excalidraw", &scene("a"), None)
        .is_err());
}

#[test]
fn shallow_listing_does_not_descend_into_unavailable_subfolders() {
    let (_directory, fs) = fixture();
    fs.create_folder("nested").unwrap();
    fs.save("nested/a.excalidraw", &scene("a"), None).unwrap();
    let root = fs.list_at(None).unwrap();
    assert_eq!(root.len(), 1);
    assert_eq!(root[0].path, "nested");
    assert!(root[0].children.is_empty());
    let nested = fs.list_at(Some("nested")).unwrap();
    assert_eq!(nested[0].path, "nested/a.excalidraw");
}

#[test]
fn locks_cannot_be_redirected_via_symlinks() {
    let (_directory, fs) = fixture();
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::os::unix::fs::symlink(outside.path(), fs.root.join(".excalidraw-workspace.lock")).unwrap();
    assert_eq!(
        fs.save("a.excalidraw", &scene("a"), None).unwrap_err().code,
        "path"
    );
}

#[test]
fn atomic_save_checks_hash_and_leaves_no_temp_files() {
    let (_directory, fs) = fixture();
    let first = fs.save("a.excalidraw", &scene("a"), None).unwrap();
    let second = fs
        .save("a.excalidraw", &scene("b"), Some(&first.hash))
        .unwrap();
    assert_ne!(first.hash, second.hash);
    assert_eq!(fs.read("a.excalidraw").unwrap().content, scene("b"));
    assert_eq!(
        fs.save("a.excalidraw", &scene("c"), Some(&first.hash))
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(fs.read("a.excalidraw").unwrap().hash, second.hash);
    assert_eq!(fs::read_dir(&fs.root).unwrap().count(), 2);
}

#[test]
fn retry_of_successful_save_is_idempotent() {
    let (_directory, fs) = fixture();
    let first = fs.save("a.excalidraw", &scene("a"), None).unwrap();
    let saved = fs
        .save("a.excalidraw", &scene("b"), Some(&first.hash))
        .unwrap();
    let retried = fs
        .save("a.excalidraw", &scene("b"), Some(&first.hash))
        .unwrap();
    assert_eq!(saved.hash, retried.hash);
    assert_eq!(
        fs.save("a.excalidraw", &scene("b"), None).unwrap_err().code,
        "conflict"
    );
}

#[test]
fn detects_external_write_and_deletion_without_recreating_file() {
    let (_directory, fs) = fixture();
    let first = fs.save("a.excalidraw", &scene("a"), None).unwrap();
    fs::write(fs.root.join("a.excalidraw"), scene("external")).unwrap();
    assert_eq!(
        fs.save("a.excalidraw", &scene("local"), Some(&first.hash))
            .unwrap_err()
            .code,
        "conflict"
    );
    fs::remove_file(fs.root.join("a.excalidraw")).unwrap();
    assert_eq!(
        fs.save("a.excalidraw", &scene("local"), Some(&first.hash))
            .unwrap_err()
            .code,
        "conflict"
    );
    assert!(!fs.root.join("a.excalidraw").exists());
}

#[test]
fn only_one_concurrent_writer_can_commit_the_same_baseline() {
    let (_directory, fs) = fixture();
    let original = fs.save("a.excalidraw", &scene("initial"), None).unwrap();
    let root = Arc::new(fs.root);
    let barrier = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|index| {
            let root = root.clone();
            let barrier = barrier.clone();
            let expected = original.hash.clone();
            thread::spawn(move || {
                let fs = WorkspaceFs::open(&root).unwrap();
                barrier.wait();
                fs.save("a.excalidraw", &scene(&index.to_string()), Some(&expected))
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(results
        .iter()
        .filter_map(|r| r.as_ref().err())
        .all(|e| e.code == "conflict"));
}

#[test]
fn atomic_replace_preserves_permissions_and_embedded_assets() {
    use std::os::unix::fs::PermissionsExt;
    let (_directory, fs) = fixture();
    let first = fs.save("a.excalidraw", &scene("a"), None).unwrap();
    fs::set_permissions(
        fs.root.join("a.excalidraw"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    let mut content: serde_json::Value = serde_json::from_str(&scene("image")).unwrap();
    content["files"] = serde_json::json!({ "image": { "dataURL": "data:image/png;base64,AAAA" } });
    let saved = fs
        .save("a.excalidraw", &content.to_string(), Some(&first.hash))
        .unwrap();
    assert!(saved.content.contains("data:image/png;base64,AAAA"));
    assert_eq!(
        fs::metadata(fs.root.join("a.excalidraw"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
}

#[test]
fn validates_before_writing_and_never_overwrites_on_move() {
    let (_directory, fs) = fixture();
    assert!(fs.save("bad.excalidraw", "not json", None).is_err());
    assert!(fs.save("bad.txt", &scene("a"), None).is_err());
    assert!(!fs.root.join("bad.excalidraw").exists());
    fs.save("a.excalidraw", &scene("a"), None).unwrap();
    fs.save("b.excalidraw", &scene("b"), None).unwrap();
    assert!(fs.move_entry("a.excalidraw", "b.excalidraw").is_err());
    assert_eq!(fs.read("b.excalidraw").unwrap().content, scene("b"));
}

#[test]
fn recursive_tree_and_folder_moves_preserve_contents() {
    let (_directory, fs) = fixture();
    fs.create_folder("architecture").unwrap();
    fs.save("architecture/api.excalidraw", &scene("a"), None)
        .unwrap();
    fs::write(fs.root.join("architecture/notes.md"), "keep me").unwrap();
    fs::write(fs.root.join("shapes.excalidrawlib"), "{}").unwrap();
    let tree = fs.tree().unwrap();
    assert_eq!(tree.len(), 2);
    assert_eq!(tree[0].children.len(), 1);
    assert_eq!(tree[1].kind, "library");
    fs.move_entry("architecture", "design").unwrap();
    assert_eq!(
        fs.read("design/api.excalidraw").unwrap().content,
        scene("a")
    );
    assert_eq!(
        fs::read_to_string(fs.root.join("design/notes.md")).unwrap(),
        "keep me"
    );
    assert!(fs.move_entry("design", "design/child").is_err());
}

#[test]
fn watcher_start_does_not_read_drawing_contents() {
    let (_directory, fs) = fixture();
    let pipe = fs.root.join("blocked.excalidraw");
    assert!(std::process::Command::new("mkfifo")
        .arg(&pipe)
        .status()
        .unwrap()
        .success());
    let root = fs.root.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = WorkspaceWatcher::new(&root, |_| {});
        tx.send(result.is_ok()).unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap());
}
