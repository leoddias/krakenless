//! Bytes for the diff panel's image preview.
//!
//! The diff says only "Binary files differ" for an image, so the panel asks for
//! the two versions itself: one from the object store (a commit, its parent,
//! `HEAD` or the index) and, for unstaged work, one from disk. Both are read
//! only. Nothing here can write, and the blob spec is validated to a short
//! grammar before git sees it, so a request can name a version of a file and
//! nothing else — no option, no arbitrary revision expression.

use base64::Engine as _;

use crate::git_runner::{run_git_raw, GitRunError};
use crate::worktree::{resolve, WorktreeError};

/// Past this an image is not previewed. Base64 over IPC grows it by a third,
/// and a preview is a glance, not a viewer for print-resolution assets.
const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
pub struct Preview {
    pub base64: String,
    pub bytes: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum PreviewError {
    /// The request is malformed: a spec outside the grammar, a bad path.
    BadRequest(String),
    /// That version of the file does not exist.
    NotFound(String),
    TooLarge(String),
    ReadFailed(String),
}

impl From<GitRunError> for PreviewError {
    fn from(error: GitRunError) -> Self {
        match error {
            GitRunError::BadRepoPath(m) | GitRunError::BadArgument(m) => Self::BadRequest(m),
            GitRunError::SpawnFailed(m) | GitRunError::IoFailed(m) => Self::ReadFailed(m),
        }
    }
}

impl From<WorktreeError> for PreviewError {
    fn from(error: WorktreeError) -> Self {
        match error {
            WorktreeError::NotFound(m) => Self::NotFound(m),
            WorktreeError::TooLarge(m) => Self::TooLarge(m),
            WorktreeError::BadRequest(m) | WorktreeError::OutsideRepo(m) => Self::BadRequest(m),
            WorktreeError::ChangedOnDisk(m)
            | WorktreeError::ReadFailed(m)
            | WorktreeError::WriteFailed(m) => Self::ReadFailed(m),
        }
    }
}

/// Accepts `<rev>:<path>` where `<rev>` is empty (the index), `HEAD`, or a
/// full object id (40 or 64 hex) with at most one trailing `^` (its first
/// parent).
///
/// Mirrors `buildBlobSpec` on the TypeScript side; it is checked twice because
/// this is the boundary that a bug on the other side must not get through. A
/// short hex rev is refused because git resolves a branch named `abcd` before
/// the abbreviation, and the path is refused where git would read it as
/// something else: `:/text` searches commit messages, `:2:path` is a stage.
fn validate_spec(spec: &str) -> Result<(), PreviewError> {
    let Some((rev, path)) = spec.split_once(':') else {
        return Err(PreviewError::BadRequest(format!("not a blob spec: {spec}")));
    };
    if path.is_empty() {
        return Err(PreviewError::BadRequest("empty path".into()));
    }
    let oid = rev.strip_suffix('^').unwrap_or(rev);
    let valid_rev = rev.is_empty()
        || rev == "HEAD"
        || ((oid.len() == 40 || oid.len() == 64) && oid.bytes().all(|b| b.is_ascii_hexdigit()));
    if !valid_rev {
        return Err(PreviewError::BadRequest(format!("not a revision: {rev}")));
    }
    let staged =
        path.len() > 1 && path.as_bytes()[1] == b':' && path.as_bytes()[0].is_ascii_digit();
    if path.starts_with('/') || (rev.is_empty() && staged) {
        return Err(PreviewError::BadRequest(format!(
            "not a repository path: {path}"
        )));
    }
    Ok(())
}

fn check_size(bytes: u64, what: &str) -> Result<(), PreviewError> {
    if bytes > MAX_PREVIEW_BYTES {
        return Err(PreviewError::TooLarge(format!(
            "{what} is {bytes} bytes; images are previewed up to {MAX_PREVIEW_BYTES}"
        )));
    }
    Ok(())
}

fn git_raw(repo: &str, args: &[&str]) -> Result<crate::git_runner::RawOutput, PreviewError> {
    let args: Vec<String> = args.iter().map(|a| (*a).to_string()).collect();
    Ok(run_git_raw(repo, &args, None)?)
}

fn read_blob(repo: &str, spec: &str) -> Result<Preview, PreviewError> {
    validate_spec(spec)?;

    // Resolved to one object id first, and that id is what the size check and
    // the read both name. `HEAD:` and `:path` move when the user commits or
    // stages, and two lookups of the spec itself could size one blob and read
    // another — letting a huge one past the cap.
    let resolved = git_raw(repo, &["rev-parse", "--verify", "--quiet", spec])?;
    if resolved.timed_out {
        return Err(PreviewError::ReadFailed(format!("{spec}: git timed out")));
    }
    if resolved.code != Some(0) {
        return Err(PreviewError::NotFound(format!("{spec} does not exist")));
    }
    let oid = String::from_utf8_lossy(&resolved.stdout).trim().to_string();
    let full = oid.len() == 40 || oid.len() == 64;
    if !full || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(PreviewError::ReadFailed(format!(
            "{spec}: git named no object"
        )));
    }

    // Size first, so a huge blob is refused without being read into memory.
    let size = git_raw(repo, &["cat-file", "-s", &oid])?;
    if size.timed_out || size.code != Some(0) {
        return Err(PreviewError::ReadFailed(format!(
            "{spec}: {}",
            size.stderr.trim()
        )));
    }
    let bytes: u64 = String::from_utf8_lossy(&size.stdout)
        .trim()
        .parse()
        .map_err(|_| PreviewError::ReadFailed(format!("{spec}: git reported no size")))?;
    check_size(bytes, spec)?;

    let blob = git_raw(repo, &["cat-file", "blob", &oid])?;
    if blob.code != Some(0) || blob.timed_out {
        return Err(PreviewError::ReadFailed(format!(
            "{spec}: {}",
            blob.stderr.trim()
        )));
    }
    // A short read reported as success would draw half an image as the whole.
    if blob.stdout.len() as u64 != bytes {
        return Err(PreviewError::ReadFailed(format!(
            "{spec}: expected {bytes} bytes, read {}",
            blob.stdout.len()
        )));
    }
    Ok(Preview {
        base64: base64::engine::general_purpose::STANDARD.encode(&blob.stdout),
        bytes,
    })
}

fn read_worktree(repo: &str, path: &str) -> Result<Preview, PreviewError> {
    use std::io::Read as _;

    let resolved = resolve(repo, path)?;
    let file = std::fs::File::open(&resolved)
        .map_err(|e| PreviewError::ReadFailed(format!("{path}: {e}")))?;
    // Read through a limit rather than trusting the size checked a moment
    // earlier: a file still being written can grow in between.
    let mut data = Vec::new();
    file.take(MAX_PREVIEW_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| PreviewError::ReadFailed(format!("{path}: {e}")))?;
    check_size(data.len() as u64, path)?;
    Ok(Preview {
        base64: base64::engine::general_purpose::STANDARD.encode(&data),
        bytes: data.len() as u64,
    })
}

/// One version of a file from the object store, for previewing.
#[tauri::command]
pub async fn preview_blob(repo: String, spec: String) -> Result<Preview, PreviewError> {
    tauri::async_runtime::spawn_blocking(move || read_blob(&repo, &spec))
        .await
        .map_err(|e| PreviewError::ReadFailed(format!("preview task did not finish: {e}")))?
}

/// A working-tree file, for previewing. Same path guard as the editor.
#[tauri::command]
pub async fn preview_worktree(repo: String, path: String) -> Result<Preview, PreviewError> {
    tauri::async_runtime::spawn_blocking(move || read_worktree(&repo, &path))
        .await
        .map_err(|e| PreviewError::ReadFailed(format!("preview task did not finish: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn git(dir: &PathBuf, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {output:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    /// Bytes that are not UTF-8 and hold a NUL: what an image looks like.
    const FIRST: [u8; 7] = [0x89, b'P', b'N', b'G', 0, 0xff, 0xfe];

    fn temp_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "krakenless-preview-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        std::fs::write(dir.join("img.png"), FIRST).unwrap();
        git(&dir, &["add", "img.png"]);
        git(&dir, &["commit", "-q", "-m", "one"]);
        std::fs::write(dir.join("img.png"), [1, 2, 3]).unwrap();
        git(&dir, &["commit", "-q", "-am", "two"]);
        dir
    }

    fn decoded(preview: &Preview) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(&preview.base64)
            .unwrap()
    }

    #[test]
    fn the_grammar_admits_index_head_and_oids() {
        for spec in [
            ":a.png",
            "HEAD:a.png",
            &format!("{}:a.png", "a".repeat(40)),
            &format!("{}^:dir/a b.png", "0123456789abcdef".repeat(4)),
            "HEAD:a:b.png",
        ] {
            assert!(validate_spec(spec).is_ok(), "{spec}");
        }
    }

    #[test]
    fn the_grammar_refuses_options_and_revision_expressions() {
        for spec in [
            "a.png",
            "HEAD:",
            "--output=x:a.png",
            "HEAD~3:a.png",
            "HEAD^:a.png",
            "main:a.png",
            "abc:a.png",
            "abcd:a.png",
            "abcd^^:a.png",
            ":/fix the bug",
            ":2:a.png",
            "HEAD:/etc/passwd",
            "@{-1}:a.png",
            "-p",
        ] {
            assert!(
                matches!(validate_spec(spec), Err(PreviewError::BadRequest(_))),
                "{spec}"
            );
        }
    }

    #[test]
    fn reads_binary_blobs_byte_for_byte_from_a_commit_its_parent_and_the_index() {
        let repo = temp_repo("blob");
        let root = repo.to_str().unwrap();
        let head = read_blob(root, "HEAD:img.png").unwrap();
        assert_eq!(decoded(&head), vec![1, 2, 3]);
        assert_eq!(head.bytes, 3);

        let oid = git(&repo, &["rev-parse", "HEAD"]);
        let parent = read_blob(root, &format!("{}^:img.png", oid.trim())).unwrap();
        assert_eq!(decoded(&parent), FIRST.to_vec());

        let index = read_blob(root, ":img.png").unwrap();
        assert_eq!(decoded(&index), vec![1, 2, 3]);
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn a_missing_version_is_not_found() {
        let repo = temp_repo("missing");
        let err = read_blob(repo.to_str().unwrap(), "HEAD:nope.png").unwrap_err();
        assert!(matches!(err, PreviewError::NotFound(_)), "{err:?}");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn reads_a_worktree_file_and_keeps_the_editor_guard() {
        let repo = temp_repo("worktree");
        let root = repo.to_str().unwrap();
        std::fs::write(repo.join("img.png"), [9, 0, 9]).unwrap();
        assert_eq!(
            decoded(&read_worktree(root, "img.png").unwrap()),
            vec![9, 0, 9]
        );
        assert!(matches!(
            read_worktree(root, "../outside.png"),
            Err(PreviewError::BadRequest(_))
        ));
        assert!(matches!(
            read_worktree(root, ".git/config"),
            Err(PreviewError::BadRequest(_))
        ));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn refuses_past_the_size_cap() {
        assert!(matches!(
            check_size(MAX_PREVIEW_BYTES + 1, "big.png"),
            Err(PreviewError::TooLarge(_))
        ));
        assert!(check_size(MAX_PREVIEW_BYTES, "ok.png").is_ok());
    }
}
