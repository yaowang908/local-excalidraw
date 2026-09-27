use notify::{Config, Event, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// Native events for low latency plus content polling for filesystems that drop events.
/// Dropping this value stops both watchers. Polling does not follow symlinks.
pub struct WorkspaceWatcher {
    _native: Option<RecommendedWatcher>,
    _poll: PollWatcher,
}

impl WorkspaceWatcher {
    /// Watch a canonical root; polling also detects edits that preserve mtime and size.
    pub fn new(
        root: &Path,
        handler: impl Fn(notify::Result<Event>) + Send + Sync + 'static,
    ) -> notify::Result<Self> {
        let handler = Arc::new(handler);
        let native_handler = handler.clone();
        let native = RecommendedWatcher::new(
            move |event| native_handler(event),
            Config::default().with_follow_symlinks(false),
        )
        .and_then(|mut watcher| {
            watcher.watch(root, RecursiveMode::Recursive)?;
            Ok(watcher)
        });
        let native = match native {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                eprintln!("Native workspace notifications unavailable; using polling: {error}");
                None
            }
        };
        let poll_root = root.to_path_buf();
        let mut poll = PollWatcher::new(
            move |event: notify::Result<Event>| {
                // Atomic saves can remove a temporary entry between directory
                // enumeration and stat. The next scan reconciles the final path.
                if let Err(error) = &event {
                    if matches!(&error.kind, notify::ErrorKind::Io(error) if error.kind() == std::io::ErrorKind::NotFound)
                        && !error.paths.is_empty()
                        && error.paths.iter().all(|path| path != &poll_root)
                    {
                        return;
                    }
                }
                handler(event);
            },
            Config::default()
                .with_poll_interval(Duration::from_secs(2))
                .with_compare_contents(true)
                .with_follow_symlinks(false),
        )?;
        poll.watch(root, RecursiveMode::Recursive)?;
        Ok(Self {
            _native: native,
            _poll: poll,
        })
    }
}
