//! Reading and writing a file in the open repository's working tree.
//!
//! Every other write this app performs goes through git, which has its own
//! opinions about safety. This module does not: it puts bytes on a user's disk,
//! and the guards below are the whole reason it exists.
//!
//! - The path is resolved against the repository root and must still be inside
//!   it after symbolic links are followed. A path the UI got wrong must not be
//!   able to write somewhere else on the machine.
//! - Nothing under `.git` is editable. Hand-editing the index or a ref through
//!   a text box corrupts repositories.
//! - A symbolic link is refused rather than followed, because the atomic
//!   replace below would leave a regular file where the link used to be.
//! - A write names the bytes it expects to replace. If the file changed on disk
//!   since it was read, the write is refused instead of overwriting work that
//!   arrived from somewhere else.
//!
//! Rust owns *where* bytes may be written; TypeScript owns what they mean —
//! encoding, line endings, and every decision about the text itself.

use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// Largest file the editor will open, in bytes.
///
/// A text box is not an editor for a 400 MB log: loading one would freeze the
/// window, and the stamp below reads the whole file on every save.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum WorktreeError {
    /// The request cannot be honoured as asked — an absolute path, a `..`
    /// segment, a symbolic link, a directory.
    BadRequest(String),
    /// The path resolved outside the repository.
    OutsideRepo(String),
    NotFound(String),
    TooLarge(String),
    /// The file no longer holds the bytes the caller expected to replace.
    ChangedOnDisk(String),
    ReadFailed(String),
    WriteFailed(String),
}

impl std::fmt::Display for WorktreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(m) => write!(f, "bad request: {m}"),
            Self::OutsideRepo(m) => write!(f, "outside the repository: {m}"),
            Self::NotFound(m) => write!(f, "not found: {m}"),
            Self::TooLarge(m) => write!(f, "too large: {m}"),
            Self::ChangedOnDisk(m) => write!(f, "changed on disk: {m}"),
            Self::ReadFailed(m) => write!(f, "could not read: {m}"),
            Self::WriteFailed(m) => write!(f, "could not write: {m}"),
        }
    }
}

impl std::error::Error for WorktreeError {}

#[derive(Debug, serde::Serialize)]
pub struct FileContents {
    pub text: String,
    /// Identifies the exact bytes that were read; hand it back to write.
    pub stamp: String,
    /// True when the bytes were not valid UTF-8 and were decoded lossily. The
    /// TypeScript layer refuses to edit such a file: saving the replacement
    /// characters back would destroy the bytes they stand for.
    pub lossy: bool,
}

/// A fingerprint of the file's contents.
///
/// Content, not a timestamp: filesystem clocks are coarse — a whole second on
/// some — so two edits inside one tick share an mtime, and a stamp that missed
/// that would let this app silently overwrite the second one. FNV-1a is small
/// enough to write out here and keeps the crate dependency-free.
fn stamp_of(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{}-{hash:016x}", bytes.len())
}

/// Resolves `path` inside `repo`, refusing anything that could escape the
/// repository or that must not be edited by hand.
fn resolve(repo: &str, path: &str) -> Result<PathBuf, WorktreeError> {
    if path.is_empty() {
        return Err(WorktreeError::BadRequest("empty path".into()));
    }

    let relative = Path::new(path);
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                // Refused case-insensitively because the filesystems this ships
                // on are: `.GIT` reaches the same directory as `.git`.
                if part.to_string_lossy().eq_ignore_ascii_case(".git") {
                    return Err(WorktreeError::BadRequest(
                        "the git directory is not editable".into(),
                    ));
                }
            }
            Component::CurDir => {}
            _ => {
                return Err(WorktreeError::BadRequest(format!(
                    "path must be relative to the repository: {path}"
                )))
            }
        }
    }

    let root = Path::new(repo)
        .canonicalize()
        .map_err(|e| WorktreeError::NotFound(format!("{repo}: {e}")))?;
    let joined = root.join(relative);

    // Checked before canonicalizing, which would follow the link and hide it.
    match std::fs::symlink_metadata(&joined) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(WorktreeError::BadRequest(format!(
                "{path} is a symbolic link; edit the file it points at"
            )))
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(WorktreeError::NotFound(path.into()))
        }
        Err(e) => return Err(WorktreeError::ReadFailed(format!("{path}: {e}"))),
    }

    // Canonicalized last, so a symbolic link anywhere along the path cannot
    // land the write outside the repository.
    let resolved = joined
        .canonicalize()
        .map_err(|e| WorktreeError::NotFound(format!("{path}: {e}")))?;
    if !resolved.starts_with(&root) {
        return Err(WorktreeError::OutsideRepo(path.into()));
    }
    if !resolved.is_file() {
        return Err(WorktreeError::BadRequest(format!("{path} is not a file")));
    }
    Ok(resolved)
}

fn read_bounded(resolved: &Path, path: &str) -> Result<Vec<u8>, WorktreeError> {
    let size = std::fs::metadata(resolved)
        .map_err(|e| WorktreeError::ReadFailed(format!("{path}: {e}")))?
        .len();
    if size > MAX_BYTES {
        return Err(WorktreeError::TooLarge(format!(
            "{path} is {size} bytes; the editor opens files up to {MAX_BYTES}"
        )));
    }
    std::fs::read(resolved).map_err(|e| WorktreeError::ReadFailed(format!("{path}: {e}")))
}

/// Reads a working-tree file for editing.
#[tauri::command]
pub fn worktree_read(repo: String, path: String) -> Result<FileContents, WorktreeError> {
    let resolved = resolve(&repo, &path)?;
    let bytes = read_bounded(&resolved, &path)?;
    let stamp = stamp_of(&bytes);
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContents {
            text,
            stamp,
            lossy: false,
        }),
        Err(e) => Ok(FileContents {
            text: String::from_utf8_lossy(e.as_bytes()).into_owned(),
            stamp,
            lossy: true,
        }),
    }
}

/// Replaces a working-tree file, but only if it still holds `expect_stamp`.
///
/// The replacement is written to a temporary file in the same directory and
/// renamed over the original, so a crash or a full disk leaves the old file
/// intact rather than a half-written one. Returns the stamp of what was
/// written, so an editor left open can save again without re-reading.
#[tauri::command]
pub fn worktree_write(
    repo: String,
    path: String,
    contents: String,
    expect_stamp: String,
) -> Result<String, WorktreeError> {
    let resolved = resolve(&repo, &path)?;
    let current = stamp_of(&read_bounded(&resolved, &path)?);
    if current != expect_stamp {
        return Err(WorktreeError::ChangedOnDisk(format!(
            "{path} changed on disk since it was opened"
        )));
    }

    let directory = resolved
        .parent()
        .ok_or_else(|| WorktreeError::WriteFailed(format!("{path} has no parent directory")))?;
    // Same directory, so the rename stays on one filesystem and is therefore
    // atomic. The name is not derived from the file's own, which could be long
    // enough to overflow the filesystem's limit once a suffix is added.
    let temp = directory.join(format!(".krakenless-{}.tmp", std::process::id()));

    let write = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(contents.as_bytes())?;
        // The rename is atomic, but only for data that actually reached disk.
        file.sync_all()?;
        drop(file);
        // Carried over explicitly: a freshly created file gets default
        // permissions, so an executable script would come back non-executable.
        if let Ok(meta) = std::fs::metadata(&resolved) {
            std::fs::set_permissions(&temp, meta.permissions())?;
        }
        std::fs::rename(&temp, &resolved)
    };

    if let Err(e) = write() {
        // A leftover temporary file would show up in the user's repository as
        // an untracked change they did not make.
        let _ = std::fs::remove_file(&temp);
        return Err(WorktreeError::WriteFailed(format!("{path}: {e}")));
    }

    Ok(stamp_of(contents.as_bytes()))
}

/// Resolves a path for a write that may *create* the file.
///
/// The same component checks as `resolve`, then: an existing target is
/// resolved exactly as for a write; a missing one has its parent created and
/// canonicalized, and must land inside the repository. A restore of an
/// untracked file a discard removed is the case — `git clean` may have taken
/// the directory with it.
fn resolve_for_create(repo: &str, path: &str) -> Result<PathBuf, WorktreeError> {
    match resolve(repo, path) {
        Err(WorktreeError::NotFound(_)) => {}
        other => return other,
    }

    let root = Path::new(repo)
        .canonicalize()
        .map_err(|e| WorktreeError::NotFound(format!("{repo}: {e}")))?;
    let relative = Path::new(path);
    let joined = root.join(relative);
    let parent = joined
        .parent()
        .ok_or_else(|| WorktreeError::BadRequest(format!("{path} has no parent directory")))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| WorktreeError::WriteFailed(format!("{path}: {e}")))?;
    let parent = parent
        .canonicalize()
        .map_err(|e| WorktreeError::NotFound(format!("{path}: {e}")))?;
    if !parent.starts_with(&root) {
        return Err(WorktreeError::OutsideRepo(path.into()));
    }
    let name = relative
        .file_name()
        .ok_or_else(|| WorktreeError::BadRequest(format!("{path} has no file name")))?;
    Ok(parent.join(name))
}

/// Writes bytes to `resolved` through a temporary file in the same directory.
fn write_atomically(resolved: &Path, path: &str, bytes: &[u8]) -> Result<(), WorktreeError> {
    let directory = resolved
        .parent()
        .ok_or_else(|| WorktreeError::WriteFailed(format!("{path} has no parent directory")))?;
    let temp = directory.join(format!(".krakenless-{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = std::fs::metadata(resolved) {
            std::fs::set_permissions(&temp, meta.permissions())?;
        }
        std::fs::rename(&temp, resolved)
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&temp);
        return Err(WorktreeError::WriteFailed(format!("{path}: {e}")));
    }
    Ok(())
}

/// Puts a backup blob back as a working-tree file, byte for byte.
///
/// The blob is read with `git cat-file blob` here, in Rust, and written as
/// bytes: the TypeScript runner decodes git's output as text and refuses what
/// is not UTF-8, which is fine for a diff and wrong for a restore — the backup
/// of a PNG is bytes, and a restore that could not put a PNG back is not a
/// restore. The file may not exist (an untracked file a discard removed), so
/// the path is resolved for creation.
#[tauri::command]
pub fn worktree_restore_blob(
    repo: String,
    path: String,
    blob_oid: String,
) -> Result<(), WorktreeError> {
    // Exactly a sha1 or a sha256 oid: nothing else may reach `cat-file`.
    let hex = blob_oid.len() == 40 || blob_oid.len() == 64;
    if !hex || !blob_oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(WorktreeError::BadRequest(format!("not an object id: {blob_oid}")));
    }
    let resolved = resolve_for_create(&repo, &path)?;

    let mut command = std::process::Command::new("git");
    crate::git_runner::scrub_git_env(&mut command);
    command
        .args(["--no-pager", "cat-file", "blob", &blob_oid])
        .current_dir(&repo)
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|e| WorktreeError::ReadFailed(format!("git cat-file: {e}")))?;
    if !output.status.success() {
        return Err(WorktreeError::ReadFailed(format!(
            "git cat-file {blob_oid}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }

    write_atomically(&resolved, &path, &output.stdout)
}

/// Deletes a working-tree file.
///
/// The same `resolve` guards as a write, for the same reason and one more: this
/// is the only call in the app that removes a file the user can see, and the
/// path it is handed comes from a list the user clicked in. A `.git` component,
/// a symbolic link, a directory, or anything that resolves outside the
/// repository is refused rather than removed.
///
/// Deliberately one file at a time and never recursive: a directory removal
/// that went wrong would take work with it that was never named on screen.
#[tauri::command]
pub fn worktree_delete(repo: String, path: String) -> Result<(), WorktreeError> {
    let resolved = resolve(&repo, &path)?;
    std::fs::remove_file(&resolved).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => WorktreeError::NotFound(path.clone()),
        _ => WorktreeError::WriteFailed(format!("{path}: {e}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "krakenless-worktree-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn repo_arg(dir: &Path) -> String {
        dir.to_str().unwrap().to_string()
    }

    #[test]
    fn reads_a_file_and_stamps_its_contents() {
        let dir = temp_repo("read");
        write(&dir.join("a.txt"), "hello\n");

        let read = worktree_read(repo_arg(&dir), "a.txt".into()).unwrap();
        assert_eq!(read.text, "hello\n");
        assert!(!read.lossy);
        assert_eq!(read.stamp, stamp_of(b"hello\n"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_a_file_in_a_subdirectory() {
        let dir = temp_repo("nested");
        write(&dir.join("src").join("main.rs"), "fn main() {}\n");

        assert_eq!(
            worktree_read(repo_arg(&dir), "src/main.rs".into())
                .unwrap()
                .text,
            "fn main() {}\n"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn flags_bytes_that_are_not_utf8_instead_of_pretending() {
        // Editing this text and saving it back would write U+FFFD over the
        // bytes it stands for, which is silent data loss.
        let dir = temp_repo("lossy");
        std::fs::write(dir.join("bin"), [0xff, 0xfe, 0x00]).unwrap();

        assert!(worktree_read(repo_arg(&dir), "bin".into()).unwrap().lossy);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stamp_changes_with_the_content_even_at_the_same_length() {
        assert_ne!(stamp_of(b"aaaa"), stamp_of(b"aaab"));
        assert_eq!(stamp_of(b"same"), stamp_of(b"same"));
    }

    #[test]
    fn refuses_to_leave_the_repository() {
        let dir = temp_repo("escape");
        let outside = dir.parent().unwrap().join("krakenless-outside.txt");
        write(&outside, "not yours\n");

        for path in ["../krakenless-outside.txt", "a/../../x"] {
            let err = worktree_read(repo_arg(&dir), path.into()).unwrap_err();
            assert!(
                matches!(err, WorktreeError::BadRequest(_)),
                "{path} gave {err:?}"
            );
        }

        std::fs::remove_file(&outside).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_an_absolute_path() {
        let dir = temp_repo("absolute");
        let target = dir.join("a.txt");
        write(&target, "x\n");

        let err = worktree_read(repo_arg(&dir), target.to_str().unwrap().into()).unwrap_err();
        assert!(matches!(err, WorktreeError::BadRequest(_)), "{err:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_the_git_directory_in_any_casing() {
        let dir = temp_repo("gitdir");
        write(&dir.join(".git").join("HEAD"), "ref: refs/heads/main\n");

        for path in [".git/HEAD", ".GIT/HEAD"] {
            let err = worktree_read(repo_arg(&dir), path.into()).unwrap_err();
            assert!(
                matches!(err, WorktreeError::BadRequest(_)),
                "{path} gave {err:?}"
            );
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_directory() {
        let dir = temp_repo("directory");
        std::fs::create_dir_all(dir.join("src")).unwrap();

        let err = worktree_read(repo_arg(&dir), "src".into()).unwrap_err();
        assert!(matches!(err, WorktreeError::BadRequest(_)), "{err:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reports_a_missing_file_as_missing() {
        let dir = temp_repo("missing");
        let err = worktree_read(repo_arg(&dir), "nope.txt".into()).unwrap_err();
        assert!(matches!(err, WorktreeError::NotFound(_)), "{err:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_file_larger_than_the_editor_opens() {
        let dir = temp_repo("large");
        std::fs::write(dir.join("big.bin"), vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();

        let err = worktree_read(repo_arg(&dir), "big.bin".into()).unwrap_err();
        assert!(matches!(err, WorktreeError::TooLarge(_)), "{err:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writes_only_when_the_file_still_holds_what_was_read() {
        let dir = temp_repo("write");
        let file = dir.join("a.txt");
        write(&file, "one\n");

        let read = worktree_read(repo_arg(&dir), "a.txt".into()).unwrap();
        let stamp = worktree_write(
            repo_arg(&dir),
            "a.txt".into(),
            "two\n".into(),
            read.stamp.clone(),
        )
        .unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two\n");
        assert_eq!(stamp, stamp_of(b"two\n"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_to_overwrite_work_that_arrived_from_somewhere_else() {
        // The file was opened here, then a rebase, a build step or another
        // editor rewrote it. Saving would destroy that silently.
        let dir = temp_repo("stale");
        let file = dir.join("a.txt");
        write(&file, "one\n");
        let read = worktree_read(repo_arg(&dir), "a.txt".into()).unwrap();
        write(&file, "somebody else\n");

        let err =
            worktree_write(repo_arg(&dir), "a.txt".into(), "mine\n".into(), read.stamp).unwrap_err();

        assert!(matches!(err, WorktreeError::ChangedOnDisk(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "somebody else\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_second_save_from_the_same_editor_uses_the_returned_stamp() {
        let dir = temp_repo("resave");
        let file = dir.join("a.txt");
        write(&file, "one\n");

        let read = worktree_read(repo_arg(&dir), "a.txt".into()).unwrap();
        let stamp =
            worktree_write(repo_arg(&dir), "a.txt".into(), "two\n".into(), read.stamp).unwrap();
        worktree_write(repo_arg(&dir), "a.txt".into(), "three\n".into(), stamp).unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "three\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn leaves_no_temporary_file_behind() {
        let dir = temp_repo("tempfile");
        write(&dir.join("a.txt"), "one\n");
        let read = worktree_read(repo_arg(&dir), "a.txt".into()).unwrap();
        worktree_write(repo_arg(&dir), "a.txt".into(), "two\n".into(), read.stamp).unwrap();

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left {leftovers:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_file_is_a_legitimate_result() {
        let dir = temp_repo("empty");
        let file = dir.join("a.txt");
        write(&file, "one\n");
        let read = worktree_read(repo_arg(&dir), "a.txt".into()).unwrap();

        worktree_write(repo_arg(&dir), "a.txt".into(), String::new(), read.stamp).unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writing_refuses_the_git_directory_too() {
        // The read guard and the write guard are the same function, but a
        // regression that dropped it from one of them would be catastrophic in
        // exactly one direction.
        let dir = temp_repo("write-gitdir");
        write(&dir.join(".git").join("HEAD"), "ref: refs/heads/main\n");

        let err = worktree_write(
            repo_arg(&dir),
            ".git/HEAD".into(),
            "ref: refs/heads/evil\n".into(),
            "whatever".into(),
        )
        .unwrap_err();

        assert!(matches!(err, WorktreeError::BadRequest(_)), "{err:?}");
        assert_eq!(
            std::fs::read_to_string(dir.join(".git").join("HEAD")).unwrap(),
            "ref: refs/heads/main\n"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symbolic_link_rather_than_replacing_it() {
        let dir = temp_repo("symlink");
        write(&dir.join("real.txt"), "real\n");
        std::os::unix::fs::symlink(dir.join("real.txt"), dir.join("link.txt")).unwrap();

        let err = worktree_read(repo_arg(&dir), "link.txt".into()).unwrap_err();
        assert!(matches!(err, WorktreeError::BadRequest(_)), "{err:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_executable_bit_of_a_script() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_repo("mode");
        let file = dir.join("run.sh");
        write(&file, "#!/bin/sh\necho one\n");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();

        let read = worktree_read(repo_arg(&dir), "run.sh".into()).unwrap();
        worktree_write(
            repo_arg(&dir),
            "run.sh".into(),
            "#!/bin/sh\necho two\n".into(),
            read.stamp,
        )
        .unwrap();

        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755, "mode became {:o}", mode & 0o777);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deletes_a_file_inside_the_repository() {
        let dir = temp_repo("delete");
        let file = dir.join("src").join("gone.txt");
        write(&file, "bye\n");

        worktree_delete(repo_arg(&dir), "src/gone.txt".into()).unwrap();

        assert!(!file.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_refuses_everything_a_write_refuses() {
        // One list, one resolver: a delete that resolved paths its own way
        // would be the one call in the app able to remove `.git/HEAD`.
        let dir = temp_repo("delete-guards");
        write(&dir.join(".git").join("HEAD"), "ref: refs/heads/main\n");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let outside = dir.parent().unwrap().join("krakenless-outside-delete.txt");
        write(&outside, "not yours\n");

        for path in [
            ".git/HEAD",
            ".GIT/HEAD",
            "../krakenless-outside-delete.txt",
            "src",
        ] {
            let err = worktree_delete(repo_arg(&dir), path.into()).unwrap_err();
            assert!(
                matches!(err, WorktreeError::BadRequest(_)),
                "{path} gave {err:?}"
            );
        }

        assert!(outside.exists(), "a path outside the repository was deleted");
        assert!(dir.join(".git").join("HEAD").exists());
        assert!(dir.join("src").is_dir());

        std::fs::remove_file(&outside).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A real repository, because the restore reads the blob through git.
    fn git_repo(name: &str) -> PathBuf {
        let dir = temp_repo(name);
        std::fs::remove_dir_all(dir.join(".git")).unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["init", "--quiet"]);
        dir
    }

    /// Writes bytes into the object store and returns their oid.
    fn blob_of(dir: &Path, bytes: &[u8]) -> String {
        let mut child = std::process::Command::new("git")
            .args(["hash-object", "-w", "--stdin"])
            .current_dir(dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let out = child.wait_with_output().unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn restores_a_blob_over_an_existing_file_byte_for_byte() {
        let dir = git_repo("restore-over");
        let bytes: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a];
        let oid = blob_of(&dir, bytes);
        write(&dir.join("logo.png"), "replaced\n");

        worktree_restore_blob(repo_arg(&dir), "logo.png".into(), oid).unwrap();

        // A binary, not text: the whole reason the restore is done here and
        // not through the editor's UTF-8 path.
        assert_eq!(std::fs::read(dir.join("logo.png")).unwrap(), bytes);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restores_a_blob_as_a_file_that_no_longer_exists() {
        // An untracked file a discard removed — `git clean` may have taken the
        // directory with it.
        let dir = git_repo("restore-missing");
        let oid = blob_of(&dir, b"my notes\n");

        worktree_restore_blob(repo_arg(&dir), "notes/deep/todo.txt".into(), oid).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("notes").join("deep").join("todo.txt")).unwrap(),
            "my notes\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_refuses_what_a_write_refuses_even_for_a_missing_file() {
        let dir = git_repo("restore-guards");
        let oid = blob_of(&dir, b"x\n");
        let outside = dir.parent().unwrap().join("krakenless-outside-restore.txt");
        let _ = std::fs::remove_file(&outside);

        for path in [".git/HEAD", ".GIT/config", "../krakenless-outside-restore.txt", ""] {
            let err =
                worktree_restore_blob(repo_arg(&dir), path.into(), oid.clone()).unwrap_err();
            assert!(
                matches!(err, WorktreeError::BadRequest(_)),
                "{path} gave {err:?}"
            );
        }
        assert!(!outside.exists(), "a path outside the repository was written");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_refuses_anything_that_is_not_an_oid() {
        let dir = git_repo("restore-oid");
        for bad in ["HEAD", "main", "abc", "--help", &"g".repeat(40)] {
            let err = worktree_restore_blob(repo_arg(&dir), "a.txt".into(), bad.into())
                .unwrap_err();
            assert!(matches!(err, WorktreeError::BadRequest(_)), "{bad} gave {err:?}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_reports_a_blob_git_does_not_have() {
        let dir = git_repo("restore-unknown");
        let err = worktree_restore_blob(repo_arg(&dir), "a.txt".into(), "0".repeat(40))
            .unwrap_err();
        assert!(matches!(err, WorktreeError::ReadFailed(_)), "{err:?}");
        assert!(!dir.join("a.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_reports_a_missing_file_as_missing() {
        let dir = temp_repo("delete-missing");
        let err = worktree_delete(repo_arg(&dir), "nope.txt".into()).unwrap_err();
        assert!(matches!(err, WorktreeError::NotFound(_)), "{err:?}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
