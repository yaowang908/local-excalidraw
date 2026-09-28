use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;

/// Native events for low latency. Callers reconcile open files periodically because
/// cloud providers may omit notifications. Dropping this value stops the watcher.
pub struct WorkspaceWatcher {
    _native: Option<RecommendedWatcher>,
}

impl WorkspaceWatcher {
    /// Watch a canonical root without reading any file contents on startup.
    pub fn new(
        root: &Path,
        handler: impl Fn(notify::Result<Event>) + Send + Sync + 'static,
    ) -> notify::Result<Self> {
        let native =
            RecommendedWatcher::new(handler, Config::default().with_follow_symlinks(false))
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
        Ok(Self { _native: native })
    }
}
