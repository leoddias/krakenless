//! Reading how far along a stopped rebase is.
//!
//! Git records this in a handful of tiny files inside the git directory —
//! `rebase-merge/msgnum` and `end` for the merge backend, `rebase-apply/next`
//! and `last` for the apply backend — and there is no plumbing command that
//! reports them. `git status` prints the numbers, but only in prose that git
//! translates into the user's language, which is not something to parse.
//!
//! So this reads the files, and the guards are the whole reason it is its own
//! module rather than a call to the working-tree reader next door:
//!
//! - **Only a fixed list of names.** The caller passes the git directory and
//!   nothing else; every path read is built here from a constant. No caller
//!   supplies a filename, so no caller can traverse out.
//! - **Read-only.** Nothing in this module writes. A rebase's state files are
//!   git's own bookkeeping, and hand-editing them corrupts the rebase.
//! - **Absent is an answer, not a failure.** A repository not mid-rebase has
//!   none of these files, which is reported as "no rebase" rather than an
//!   error.

use std::path::{Path, PathBuf};

/// These files hold a number or one ref name. Anything larger is not the file
/// this module thinks it is, and is refused rather than parsed.
const MAX_BYTES: u64 = 4096;

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum RebaseStateError {
    /// The git directory is missing, not a directory, or not absolute.
    BadGitDir(String),
}

impl std::fmt::Display for RebaseStateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadGitDir(m) => write!(f, "bad git directory: {m}"),
        }
    }
}

impl std::error::Error for RebaseStateError {}

/// How far a stopped rebase has got, as git records it.
#[derive(Debug, Default, serde::Serialize)]
pub struct RebaseProgress {
    /// True when either backend's directory is present.
    pub in_progress: bool,
    /// Commit number being replayed, 1-based. `None` when git did not say.
    pub current: Option<u32>,
    /// How many commits the rebase has in total.
    pub total: Option<u32>,
    /// Branch being rebased, without `refs/heads/`; `None` for a detached one.
    pub head_name: Option<String>,
    /// Commit the replay is being built on.
    pub onto: Option<String>,
    /// True for the interactive backend, which is also what `--rebase-merges`
    /// and a plain conflict stop use on modern git.
    pub interactive: bool,
}

/// Reads one of git's small state files, trimmed. `None` when it is absent,
/// unreadable, or bigger than a file of this kind can legitimately be.
fn read_small(dir: &Path, name: &str) -> Option<String> {
    let path = dir.join(name);
    let size = std::fs::metadata(&path).ok()?.len();
    if size > MAX_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn read_number(dir: &Path, name: &str) -> Option<u32> {
    read_small(dir, name)?.parse().ok()
}

/// Strips `refs/heads/` so the name matches what the rest of the app calls a
/// branch. Only that prefix: a branch legitimately named `heads/x` survives.
fn short_branch(name: String) -> String {
    name.strip_prefix("refs/heads/")
        .map_or(name.clone(), str::to_string)
}

/// Reads the progress of a rebase stopped in `git_dir`.
///
/// Answers for both backends. The merge backend (`rebase-merge`) is what an
/// interactive rebase and any modern conflict stop use; the apply backend
/// (`rebase-apply`) is still reachable with `--apply` and by older git, and
/// counts with different filenames — reading only one of them would report "no
/// rebase" to a user who is very much in the middle of one.
#[tauri::command]
pub fn rebase_state(git_dir: String) -> Result<RebaseProgress, RebaseStateError> {
    let root = PathBuf::from(&git_dir);
    if git_dir.trim().is_empty() || !root.is_absolute() {
        return Err(RebaseStateError::BadGitDir(format!(
            "not an absolute path: {git_dir}"
        )));
    }
    if !root.is_dir() {
        return Err(RebaseStateError::BadGitDir(format!(
            "not a directory: {git_dir}"
        )));
    }

    let merge_dir = root.join("rebase-merge");
    if merge_dir.is_dir() {
        return Ok(RebaseProgress {
            in_progress: true,
            current: read_number(&merge_dir, "msgnum"),
            total: read_number(&merge_dir, "end"),
            head_name: read_small(&merge_dir, "head-name").map(short_branch),
            onto: read_small(&merge_dir, "onto"),
            interactive: true,
        });
    }

    let apply_dir = root.join("rebase-apply");
    if apply_dir.is_dir() {
        return Ok(RebaseProgress {
            in_progress: true,
            current: read_number(&apply_dir, "next"),
            total: read_number(&apply_dir, "last"),
            head_name: read_small(&apply_dir, "head-name").map(short_branch),
            onto: read_small(&apply_dir, "onto"),
            interactive: false,
        });
    }

    Ok(RebaseProgress::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "krakenless-rebase-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str, contents: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
    }

    #[test]
    fn reports_no_rebase_when_neither_directory_exists() {
        let dir = temp_dir("none");
        let state = rebase_state(dir.to_str().unwrap().to_string()).unwrap();
        assert!(!state.in_progress);
        assert_eq!(state.current, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_the_merge_backend() {
        let dir = temp_dir("merge");
        let rebase = dir.join("rebase-merge");
        std::fs::create_dir_all(&rebase).unwrap();
        write(&rebase, "msgnum", "3\n");
        write(&rebase, "end", "43\n");
        write(&rebase, "head-name", "refs/heads/feat/x\n");
        write(&rebase, "onto", "83d18e0c2a1111111111111111111111111111ff\n");

        let state = rebase_state(dir.to_str().unwrap().to_string()).unwrap();
        assert!(state.in_progress);
        assert!(state.interactive);
        assert_eq!(state.current, Some(3));
        assert_eq!(state.total, Some(43));
        assert_eq!(state.head_name.as_deref(), Some("feat/x"));
        assert!(state.onto.unwrap().starts_with("83d18e0c"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_the_apply_backend_which_counts_under_other_names() {
        let dir = temp_dir("apply");
        let rebase = dir.join("rebase-apply");
        std::fs::create_dir_all(&rebase).unwrap();
        write(&rebase, "next", "2");
        write(&rebase, "last", "7");

        let state = rebase_state(dir.to_str().unwrap().to_string()).unwrap();
        assert!(state.in_progress);
        assert!(!state.interactive);
        assert_eq!(state.current, Some(2));
        assert_eq!(state.total, Some(7));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rebase_with_no_counters_is_still_a_rebase() {
        // The directory is the fact that matters; the numbers are a courtesy,
        // and reporting "not rebasing" because they are missing would strand
        // the user exactly as before.
        let dir = temp_dir("bare");
        std::fs::create_dir_all(dir.join("rebase-merge")).unwrap();

        let state = rebase_state(dir.to_str().unwrap().to_string()).unwrap();
        assert!(state.in_progress);
        assert_eq!(state.current, None);
        assert_eq!(state.total, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keeps_a_branch_actually_named_heads_something() {
        let dir = temp_dir("heads");
        let rebase = dir.join("rebase-merge");
        std::fs::create_dir_all(&rebase).unwrap();
        write(&rebase, "head-name", "refs/heads/heads/x");

        let state = rebase_state(dir.to_str().unwrap().to_string()).unwrap();
        assert_eq!(state.head_name.as_deref(), Some("heads/x"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_file_too_large_to_be_a_counter() {
        let dir = temp_dir("large");
        let rebase = dir.join("rebase-merge");
        std::fs::create_dir_all(&rebase).unwrap();
        write(&rebase, "msgnum", &"9".repeat((MAX_BYTES + 1) as usize));

        let state = rebase_state(dir.to_str().unwrap().to_string()).unwrap();
        assert!(state.in_progress);
        assert_eq!(state.current, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_relative_or_missing_git_dir() {
        assert!(rebase_state("relative/path".to_string()).is_err());
        let missing = std::env::temp_dir().join("krakenless-no-such-gitdir-4b1e");
        assert!(rebase_state(missing.to_str().unwrap().to_string()).is_err());
    }
}
