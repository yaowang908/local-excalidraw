use crate::{Result, WorkspaceError};
use std::path::Path;

#[cfg(target_os = "macos")]
fn is_file_provider_path(path: &Path) -> bool {
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    let home = Path::new(&home);
    path.starts_with(home.join("Library/CloudStorage"))
        || path.starts_with(home.join("Library/Mobile Documents"))
}

#[cfg(target_os = "macos")]
fn coordinate<T>(
    path: &Path,
    write: Option<bool>,
    action: impl FnOnce(&Path) -> Result<T>,
) -> Result<T> {
    use block2::RcBlock;
    use objc2::AnyThread;
    use objc2_foundation::{
        NSFileCoordinator, NSFileCoordinatorReadingOptions, NSFileCoordinatorWritingOptions,
        NSString, NSURL,
    };
    use std::cell::RefCell;
    use std::ptr::NonNull;

    let path_string = path
        .to_str()
        .ok_or_else(|| WorkspaceError::new("path", "Workspace path is not valid UTF-8"))?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path_string));
    let coordinator = NSFileCoordinator::initWithFilePresenter(NSFileCoordinator::alloc(), None);
    let operation = RefCell::new(Some(action));
    let result = RefCell::new(None);
    let accessor = RcBlock::new(|coordinated_url: NonNull<NSURL>| {
        let coordinated_url = unsafe { coordinated_url.as_ref() };
        let value = coordinated_url
            .path()
            .map(|value| value.to_string())
            .ok_or_else(|| WorkspaceError::new("io", "File coordination returned no path"))
            .and_then(|path| {
                let action = operation.borrow_mut().take().ok_or_else(|| {
                    WorkspaceError::new("io", "File coordination ran more than once")
                })?;
                action(Path::new(&path))
            });
        *result.borrow_mut() = Some(value);
    });
    let mut error = None;
    if let Some(replacing) = write {
        coordinator.coordinateWritingItemAtURL_options_error_byAccessor(
            &url,
            if replacing {
                NSFileCoordinatorWritingOptions::ForReplacing
            } else {
                NSFileCoordinatorWritingOptions::ForMerging
            },
            Some(&mut error),
            &accessor,
        );
    } else {
        coordinator.coordinateReadingItemAtURL_options_error_byAccessor(
            &url,
            NSFileCoordinatorReadingOptions::empty(),
            Some(&mut error),
            &accessor,
        );
    }
    if let Some(error) = error {
        return Err(WorkspaceError::new(
            "io",
            format!("File coordination failed: {error}"),
        ));
    }
    drop(accessor);
    result
        .into_inner()
        .ok_or_else(|| WorkspaceError::new("io", "File coordination did not access the file"))?
}

/// Coordinate a read with macOS File Provider; other platforms use ordinary I/O.
pub fn read<T>(path: &Path, action: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    #[cfg(target_os = "macos")]
    {
        if is_file_provider_path(path) {
            coordinate(path, None, action)
        } else {
            action(path)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        action(path)
    }
}

/// Coordinate a replacement with macOS File Provider; other platforms use ordinary I/O.
pub fn write<T>(path: &Path, action: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    #[cfg(target_os = "macos")]
    {
        if !is_file_provider_path(path) {
            return action(path);
        }
        if path.exists() {
            coordinate(path, Some(true), action)
        } else {
            let parent = path
                .parent()
                .ok_or_else(|| WorkspaceError::new("path", "Missing parent directory"))?;
            let name = path
                .file_name()
                .ok_or_else(|| WorkspaceError::new("path", "Missing drawing name"))?;
            coordinate(parent, Some(false), |coordinated_parent| {
                action(&coordinated_parent.join(name))
            })
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        action(path)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn coordinated_read_uses_the_url_supplied_by_macos() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"local").unwrap();
        let content = coordinate(file.path(), None, |path| {
            std::fs::read_to_string(path)
                .map_err(|error| WorkspaceError::new("io", format!("Cannot read: {error}")))
        })
        .unwrap();
        assert_eq!(content, "local");
    }

    #[test]
    fn coordinated_creation_and_replacement_use_existing_items() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.excalidraw");
        coordinate(directory.path(), Some(false), |parent| {
            std::fs::write(parent.join("a.excalidraw"), b"first")
                .map_err(|error| WorkspaceError::new("io", format!("Cannot create: {error}")))
        })
        .unwrap();
        coordinate(&path, Some(true), |coordinated| {
            std::fs::write(coordinated, b"second")
                .map_err(|error| WorkspaceError::new("io", format!("Cannot replace: {error}")))
        })
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
    }
}
