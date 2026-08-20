//! Filesystem watching for the open repository.
//!
//! Plumbing only: this module knows nothing about git semantics. It reports
//! "something under this path changed, and it was not just git's own churn" and
//! lets the TypeScript layer decide what to re-read.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;

/// Events are coalesced over this window: a single `git checkout` produces
/// hundreds of filesystem events, and refreshing per event would run git in a
/// loop against a repository that is still changing.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Event name the frontend listens on.
pub const REPO_CHANGED_EVENT: &str = "repo-changed";

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum WatchError {
    BadPath(String),
    WatchFailed(String),
}

impl std::fmt::Display for WatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadPath(m) => write!(f, "bad path: {m}"),
            Self::WatchFailed(m) => write!(f, "could not watch: {m}"),
        }
    }
}

impl std::error::Error for WatchError {}

/// Paths whose changes are git's own bookkeeping. Reacting to them causes a
/// refresh storm: our own `git status` writes `.git/index`, which would wake
/// the watcher, which would run `git status` again.
pub fn is_noise(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('\\', "/");
    let Some(git_pos) = text.find("/.git/") else {
        // A change to `.git` itself (not inside it) is still worth reporting.
        return false;
    };
    let inside = &text[git_pos + "/.git/".len()..];

    // Lock files, temporary objects and the index churn every command touches.
    inside.ends_with(".lock")
        || inside.starts_with("objects/")
        || inside.starts_with("index")
        || inside.starts_with("logs/")
        || inside.starts_with("COMMIT_EDITMSG")
        || inside.starts_with("FETCH_HEAD")
}

/// Collapses a burst of events into one notification per quiet period.
/// Returns `true` when the burst contained at least one interesting path.
fn coalesce(rx: &Receiver<notify::Result<notify::Event>>) -> Option<bool> {
    // Block until something happens, then keep draining until the burst ends.
    let first = rx.recv().ok()?;
    let mut interesting = is_interesting(first);
    let deadline = Instant::now() + DEBOUNCE;

    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(remaining) {
            Ok(event) => interesting |= is_interesting(event),
            Err(_) => break,
        }
    }
    Some(interesting)
}

fn is_interesting(event: notify::Result<notify::Event>) -> bool {
    match event {
        Ok(event) => event.paths.iter().any(|path| !is_noise(path)),
        // A dropped/errored event means we may have missed something real.
        Err(_) => true,
    }
}

/// Hands out a fresh identity for every watch that is started.
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// The watch currently in force, and the token that owns it.
///
/// The token exists because stopping is not "stop whatever is running": two
/// watches overlap whenever the UI re-runs its effect (React's StrictMode does
/// this on every mount in development) or the user opens a second repository
/// while the first is still starting. Both call `watch_repo`, then the *first*
/// one's teardown arrives — and without an identity it would tear down the
/// second one's watch, leaving the app watching nothing at all and silently
/// blind to every change made outside it.
#[derive(Default)]
pub struct WatcherState {
    inner: Mutex<Option<(u64, RecommendedWatcher)>>,
}

/// Starts watching `path`, replacing any previous watch. Emits
/// [`REPO_CHANGED_EVENT`] to the frontend when the working tree changes.
///
/// Returns the token that identifies this watch; pass it to [`unwatch_repo`].
#[tauri::command]
pub fn watch_repo(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<u64, WatchError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(WatchError::BadPath(format!("not a directory: {path}")));
    }

    let (tx, rx) = channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        // A closed receiver just means the watch was replaced; drop quietly.
        let _ = tx.send(event);
    })
    .map_err(|e| WatchError::WatchFailed(e.to_string()))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| WatchError::WatchFailed(e.to_string()))?;

    std::thread::spawn(move || {
        while let Some(interesting) = coalesce(&rx) {
            if interesting {
                let _ = app.emit(REPO_CHANGED_EVENT, ());
            }
        }
    });

    let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
    // Dropping the previous watcher stops the previous watch.
    *state
        .inner
        .lock()
        .map_err(|e| WatchError::WatchFailed(e.to_string()))? = Some((token, watcher));
    Ok(token)
}

/// True when `token` still owns the watch recorded in `current`.
///
/// Its own function so the rule can be tested: the watcher it guards cannot be
/// constructed without a real filesystem, and this decision is the whole reason
/// the token exists.
fn owns(current: Option<u64>, token: u64) -> bool {
    current == Some(token)
}

/// Stops the watch named by `token`, and only that one.
///
/// A token that no longer owns the current watch is a teardown that lost its
/// race with a newer watch; it is a no-op rather than an error, because the
/// caller did nothing wrong and the newer watch must survive.
#[tauri::command]
pub fn unwatch_repo(
    state: tauri::State<'_, WatcherState>,
    token: u64,
) -> Result<(), WatchError> {
    let mut current = state
        .inner
        .lock()
        .map_err(|e| WatchError::WatchFailed(e.to_string()))?;
    if owns(current.as_ref().map(|(owner, _)| *owner), token) {
        *current = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treats_git_bookkeeping_as_noise() {
        for path in [
            "C:/repos/app/.git/index",
            "C:/repos/app/.git/index.lock",
            "C:/repos/app/.git/objects/ab/cdef",
            "C:/repos/app/.git/logs/HEAD",
            "C:/repos/app/.git/COMMIT_EDITMSG",
            "C:/repos/app/.git/refs/heads/main.lock",
            "/srv/app/.git/FETCH_HEAD",
        ] {
            assert!(is_noise(Path::new(path)), "{path} should be noise");
        }
    }

    #[test]
    fn reports_real_work_and_ref_updates() {
        // A branch switch rewrites refs/HEAD; the UI must see those.
        for path in [
            "C:/repos/app/src/main.rs",
            "C:/repos/app/.git/HEAD",
            "C:/repos/app/.git/refs/heads/main",
            "C:/repos/app/.git/MERGE_HEAD",
            "C:/repos/app/README.md",
        ] {
            assert!(!is_noise(Path::new(path)), "{path} should not be noise");
        }
    }

    #[test]
    fn a_file_named_like_git_is_not_treated_as_git_internals() {
        // `.github/` and `mygit/` are ordinary project files.
        assert!(!is_noise(Path::new("C:/repos/app/.github/workflows/ci.yml")));
        assert!(!is_noise(Path::new("C:/repos/app/mygit/index")));
    }

    #[test]
    fn handles_windows_separators() {
        assert!(is_noise(Path::new("C:\\repos\\app\\.git\\index.lock")));
        assert!(!is_noise(Path::new("C:\\repos\\app\\src\\main.rs")));
    }

    #[test]
    fn coalesces_a_burst_into_one_notification() {
        let (tx, rx) = channel();
        for _ in 0..50 {
            tx.send(Ok(notify::Event {
                paths: vec![PathBuf::from("C:/repos/app/src/main.rs")],
                ..Default::default()
            }))
            .unwrap();
        }
        assert_eq!(coalesce(&rx), Some(true));
        // The whole burst was consumed by the single call.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_burst_of_pure_noise_reports_nothing_interesting() {
        let (tx, rx) = channel();
        for name in ["index", "index.lock", "objects/ab/cd"] {
            tx.send(Ok(notify::Event {
                paths: vec![PathBuf::from(format!("C:/repos/app/.git/{name}"))],
                ..Default::default()
            }))
            .unwrap();
        }
        assert_eq!(coalesce(&rx), Some(false));
    }

    #[test]
    fn one_real_change_inside_a_noisy_burst_still_counts() {
        let (tx, rx) = channel();
        tx.send(Ok(notify::Event {
            paths: vec![PathBuf::from("C:/repos/app/.git/index.lock")],
            ..Default::default()
        }))
        .unwrap();
        tx.send(Ok(notify::Event {
            paths: vec![PathBuf::from("C:/repos/app/src/main.rs")],
            ..Default::default()
        }))
        .unwrap();
        assert_eq!(coalesce(&rx), Some(true));
    }

    #[test]
    fn a_watcher_error_is_reported_rather_than_swallowed() {
        // Dropped events mean we may have missed a real change.
        let (tx, rx) = channel();
        tx.send(Err(notify::Error::generic("queue overflow"))).unwrap();
        assert_eq!(coalesce(&rx), Some(true));
    }

    #[test]
    fn a_closed_channel_ends_the_loop() {
        let (tx, rx) = channel::<notify::Result<notify::Event>>();
        drop(tx);
        assert_eq!(coalesce(&rx), None);
    }

    #[test]
    fn a_token_only_stops_the_watch_it_names() {
        // Two watches overlap whenever the UI re-runs the effect that owns them
        // (React's StrictMode does this on every mount in development). The
        // first teardown then arrives *after* the second watch has started, and
        // without an identity it would stop the wrong one — leaving the app
        // watching nothing and blind to every change made outside it.
        let first = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        let second = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        assert_ne!(first, second, "every watch needs its own identity");

        assert!(owns(Some(second), second), "the current watch stops itself");
        assert!(
            !owns(Some(second), first),
            "a late teardown must not stop the watch that replaced it"
        );
        assert!(!owns(None, first), "stopping twice is a no-op, not an error");
    }
}
