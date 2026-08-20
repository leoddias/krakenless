//! Plumbing only: spawn the system `git` binary and capture its output.
//!
//! This module contains no git semantics — no argument building, no output
//! parsing. Those live in TypeScript (see `docs/ARCHITECTURE.md`). Git is
//! always spawned with an argument array, never through a shell.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt as UnixCommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Hides the console window that would otherwise flash on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// How long we still wait for the pipes after killing a child. Grandchildren
/// (ssh, credential helpers, hooks) can hold the write end open forever, so
/// this wait must be bounded or the whole call would hang.
const PIPE_GRACE: Duration = Duration::from_secs(2);

/// Environment variables that redirect where git reads or writes. Inheriting
/// any of them (e.g. launching the app from inside a `rebase -i` hook) would
/// silently point our commands at a foreign index, object store, or config.
const GIT_ENV_TO_SCRUB: [&str; 16] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_ASKPASS",
    // Injects arbitrary config (hooksPath, aliases) — the env-side `-c`.
    "GIT_CONFIG_PARAMETERS",
    // Runs an arbitrary program for every diff we ask for.
    "GIT_EXTERNAL_DIFF",
];

/// Prepended to every invocation so path quoting, paging and pathspec magic
/// are decided once, here, instead of per builder. `--literal-pathspecs`
/// matters most on the write side: a file legally named `:(glob)**` would
/// otherwise expand a `checkout -- <path>` from one file to the whole tree.
const GIT_GLOBAL_ARGS: [&str; 6] = [
    "--no-pager",
    "--literal-pathspecs",
    "-c",
    "core.quotePath=false",
    // Without this, a user's `i18n.logOutputEncoding` makes git emit commit
    // messages in a legacy encoding, which the UTF-8 decode below then flags as
    // undecodable — blinding every parser that reads commit text.
    "-c",
    "i18n.logOutputEncoding=UTF-8",
];

#[derive(Debug, serde::Serialize)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    /// `None` when the process was killed (signal or our timeout).
    pub code: Option<i32>,
    pub timed_out: bool,
    /// True when stdout was not valid UTF-8 and characters were replaced.
    /// Callers must not build further commands from paths in such output.
    pub stdout_lossy: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum GitRunError {
    /// The repository path is missing, not a directory, or not absolute.
    BadRepoPath(String),
    /// An argument was rejected before git was spawned.
    BadArgument(String),
    /// `git` could not be started at all (not installed, not on PATH).
    SpawnFailed(String),
    /// The child started but its output could not be read in full.
    IoFailed(String),
}

impl std::fmt::Display for GitRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRepoPath(m) => write!(f, "bad repository path: {m}"),
            Self::BadArgument(m) => write!(f, "bad argument: {m}"),
            Self::SpawnFailed(m) => write!(f, "failed to start git: {m}"),
            Self::IoFailed(m) => write!(f, "failed to read git output: {m}"),
        }
    }
}

impl std::error::Error for GitRunError {}

fn validate_repo(repo: &str) -> Result<PathBuf, GitRunError> {
    if repo.trim().is_empty() {
        return Err(GitRunError::BadRepoPath("empty path".into()));
    }
    let path = Path::new(repo);
    if !path.is_absolute() {
        return Err(GitRunError::BadRepoPath(format!("not absolute: {repo}")));
    }
    if !path.is_dir() {
        return Err(GitRunError::BadRepoPath(format!("not a directory: {repo}")));
    }
    Ok(path.to_path_buf())
}

fn validate_args(args: &[String]) -> Result<(), GitRunError> {
    if args.is_empty() {
        return Err(GitRunError::BadArgument("no arguments given".into()));
    }
    for arg in args {
        // A NUL byte cannot survive the trip to the OS and would silently
        // truncate an argument — reject rather than pass a mangled command.
        if arg.contains('\0') {
            return Err(GitRunError::BadArgument("argument contains NUL".into()));
        }
    }
    Ok(())
}

/// Kills the child *and* anything it spawned. Killing only the direct child
/// leaves grandchildren holding the pipes and, worse, still writing to the
/// repository while we report a timeout.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // The child leads its own process group (set at spawn), so a negative
        // pid signals the whole group: ssh, credential helpers, hooks.
        let mut killer = Command::new("kill");
        killer
            .args(["-9", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = killer.status();
    }
    #[cfg(windows)]
    {
        let mut killer = Command::new("taskkill");
        killer
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        killer.creation_flags(CREATE_NO_WINDOW);
        let _ = killer.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs `git` inside `repo` with `args`, capturing stdout, stderr and the exit
/// code. Kills the process tree if the child outlives `timeout_ms`.
///
/// `stdin_text` feeds the child's standard input — `git apply` reads a patch
/// that way, which keeps patch content out of the argument list entirely.
pub fn run_git(
    repo: &str,
    args: &[String],
    timeout_ms: Option<u64>,
    stdin_text: Option<String>,
) -> Result<GitOutput, GitRunError> {
    let cwd = validate_repo(repo)?;
    validate_args(args)?;
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );

    let mut command = Command::new("git");
    command
        .current_dir(&cwd)
        .args(GIT_GLOBAL_ARGS)
        .args(args)
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Keep output machine-stable regardless of the user's environment.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    for key in GIT_ENV_TO_SCRUB {
        command.env_remove(key);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    // Own process group, so killing on timeout reaches everything git spawned.
    command.process_group(0);

    let mut child = command
        .spawn()
        .map_err(|e| GitRunError::SpawnFailed(e.to_string()))?;

    // Write stdin on its own thread too: a patch larger than the pipe buffer
    // would otherwise block us here while the child blocks writing output.
    if let Some(text) = stdin_text {
        if let Some(mut pipe) = child.stdin.take() {
            std::thread::spawn(move || {
                let _ = pipe.write_all(text.as_bytes());
                // Dropping the handle closes the pipe, which is git's EOF.
            });
        }
    }

    // Read both pipes on their own threads: a child that fills one pipe while
    // we block on the other would deadlock.
    let stdout_rx = drain(child.stdout.take());
    let stderr_rx = drain(child.stderr.take());

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    kill_tree(&mut child);
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(GitRunError::IoFailed(e.to_string())),
        }
    };

    let stdout = collect(&stdout_rx, timed_out, "stdout")?;
    let stderr = collect(&stderr_rx, timed_out, "stderr")?;

    let (stdout_text, stdout_lossy) = decode(stdout);
    let (stderr_text, _) = decode(stderr);

    Ok(GitOutput {
        stdout: stdout_text,
        stderr: stderr_text,
        code: status.and_then(|s| s.code()),
        timed_out,
        stdout_lossy,
    })
}

/// Waits for one reader thread. After a timeout the wait is bounded, because a
/// surviving grandchild may keep the pipe open indefinitely.
fn collect(
    rx: &mpsc::Receiver<std::io::Result<Vec<u8>>>,
    timed_out: bool,
    which: &str,
) -> Result<Vec<u8>, GitRunError> {
    let received = if timed_out {
        match rx.recv_timeout(PIPE_GRACE) {
            Ok(value) => value,
            // The pipe is still held open by something git spawned; the child
            // is already dead, so report what we know instead of hanging.
            Err(_) => return Ok(Vec::new()),
        }
    } else {
        rx.recv()
            .map_err(|_| GitRunError::IoFailed(format!("{which} reader died")))?
    };
    received.map_err(|e| GitRunError::IoFailed(format!("{which}: {e}")))
}

/// Decodes captured bytes, reporting whether anything had to be replaced.
fn decode(bytes: Vec<u8>) -> (String, bool) {
    match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        // Git paths are bytes; a lossy conversion keeps the output visible,
        // but the caller is told so it never builds a command from it.
        Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), true),
    }
}

/// Reads a pipe to completion on a background thread, preserving read errors:
/// a truncated capture reported as success would silently hide changes.
fn drain<R: Read + Send + 'static>(
    pipe: Option<R>,
) -> mpsc::Receiver<std::io::Result<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let result = match pipe {
            Some(mut pipe) => pipe.read_to_end(&mut buffer).map(|_| buffer),
            None => Ok(buffer),
        };
        let _ = tx.send(result);
    });
    rx
}

#[tauri::command]
pub fn git_run(
    repo: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
    stdin: Option<String>,
) -> Result<GitOutput, GitRunError> {
    run_git(&repo, &args, timeout_ms, stdin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "krakenless-test-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_string()).collect()
    }

    #[test]
    fn rejects_relative_repo_path() {
        let err = run_git("relative/path", &s(&["status"]), None, None).unwrap_err();
        assert!(matches!(err, GitRunError::BadRepoPath(_)));
    }

    #[test]
    fn rejects_missing_repo_path() {
        let missing = std::env::temp_dir().join("krakenless-does-not-exist-9e1f");
        let err = run_git(missing.to_str().unwrap(), &s(&["status"]), None, None).unwrap_err();
        assert!(matches!(err, GitRunError::BadRepoPath(_)));
    }

    #[test]
    fn rejects_empty_args() {
        let dir = temp_dir("empty-args");
        let err = run_git(dir.to_str().unwrap(), &[], None, None).unwrap_err();
        assert!(matches!(err, GitRunError::BadArgument(_)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_nul_in_argument() {
        let dir = temp_dir("nul-arg");
        let err = run_git(dir.to_str().unwrap(), &s(&["log\0--all"]), None, None).unwrap_err();
        assert!(matches!(err, GitRunError::BadArgument(_)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn captures_stdout_and_zero_exit_code() {
        let dir = temp_dir("stdout");
        let out = run_git(dir.to_str().unwrap(), &s(&["--version"]), None, None).unwrap();
        assert_eq!(out.code, Some(0));
        assert!(out.stdout.starts_with("git version"), "got {:?}", out.stdout);
        assert!(!out.timed_out);
        assert!(!out.stdout_lossy);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn surfaces_nonzero_exit_code_and_stderr() {
        let dir = temp_dir("nonrepo");
        let out = run_git(dir.to_str().unwrap(), &s(&["status"]), None, None).unwrap();
        assert_ne!(out.code, Some(0));
        assert!(!out.stderr.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn arguments_are_not_shell_interpreted() {
        // If this went through a shell, the `&&` would run a second command.
        let dir = temp_dir("shell");
        let out = run_git(dir.to_str().unwrap(), &s(&["--version && echo pwned"]), None, None).unwrap();
        assert!(!out.stdout.contains("pwned"), "got {:?}", out.stdout);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_hanging_child_is_killed_and_the_call_returns() {
        use std::net::TcpListener;

        let dir = temp_dir("timeout");
        // A local listener that accepts and never answers makes git's own
        // protocol hang deterministically, with no network and no sleep binary.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = std::thread::spawn(move || {
            // Hold the connection open without writing anything.
            if let Ok((stream, _)) = listener.accept() {
                std::thread::sleep(Duration::from_secs(20));
                drop(stream);
            }
        });

        let timeout = Duration::from_millis(1_000);
        let started = Instant::now();
        let out = run_git(
            dir.to_str().unwrap(),
            &s(&["ls-remote", &format!("git://127.0.0.1:{port}/x")]),
            Some(timeout.as_millis() as u64),
            None,
        )
        .unwrap();
        let elapsed = started.elapsed();

        assert!(out.timed_out, "a hanging child must be reported as timed out");
        assert_eq!(out.code, None, "a killed child has no exit code");
        assert!(
            elapsed < timeout + PIPE_GRACE + Duration::from_secs(3),
            "call took {elapsed:?}, so the kill or the pipe wait is unbounded"
        );
        drop(accepted);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_zero_timeout_is_clamped_to_a_usable_floor() {
        let dir = temp_dir("zero-timeout");
        let out = run_git(dir.to_str().unwrap(), &s(&["--version"]), Some(0), None).unwrap();
        assert_eq!(out.code, Some(0), "a trivial command must still complete");
        assert!(!out.timed_out);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn redirecting_git_env_vars_are_not_inherited() {
        let dir = temp_dir("env-scrub");
        // `--git-path` only answers inside a repository.
        let init = Command::new("git")
            .current_dir(&dir)
            .args(["init", "--quiet"])
            .status()
            .unwrap();
        assert!(init.success(), "could not create the test repository");
        let foreign = "C:/nowhere/foreign-index";
        // SAFETY: single-threaded test; the variable is removed right after.
        unsafe {
            std::env::set_var("GIT_INDEX_FILE", foreign);
        }

        // Positive control: without scrubbing, git reports the foreign path.
        let leaked = Command::new("git")
            .current_dir(&dir)
            .args(["rev-parse", "--path-format=absolute", "--git-path", "index"])
            .output()
            .unwrap();
        let leaked = String::from_utf8_lossy(&leaked.stdout).into_owned();

        let out = run_git(
            dir.to_str().unwrap(),
            &s(&["rev-parse", "--path-format=absolute", "--git-path", "index"]),
            None,
            None,
        )
        .unwrap();

        unsafe {
            std::env::remove_var("GIT_INDEX_FILE");
        }

        assert!(
            leaked.contains("foreign-index"),
            "control failed: git no longer honors GIT_INDEX_FILE ({leaked:?})"
        );
        assert!(
            !out.stdout.contains("foreign-index"),
            "child saw a redirecting env var: {:?}",
            out.stdout
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn feeds_stdin_to_the_child() {
        let dir = temp_dir("stdin");
        // `hash-object --stdin` echoes back the oid of whatever it read, so the
        // known oid of "hello" plus a newline proves the bytes arrived intact.
        let out = run_git(
            dir.to_str().unwrap(),
            &s(&["hash-object", "--stdin"]),
            None,
            Some("hello\n".to_string()),
        )
        .unwrap();
        assert_eq!(out.code, Some(0), "stderr: {}", out.stderr);
        assert_eq!(out.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_large_stdin_payload_does_not_deadlock() {
        let dir = temp_dir("stdin-big");
        // Well past any pipe buffer: if stdin were written on this thread while
        // the child wrote output, both sides would block forever.
        let payload = "x".repeat(4 * 1024 * 1024);
        let started = Instant::now();
        let out = run_git(
            dir.to_str().unwrap(),
            &s(&["hash-object", "--stdin"]),
            Some(20_000),
            Some(payload),
        )
        .unwrap();
        assert_eq!(out.code, Some(0));
        assert!(!out.timed_out);
        assert!(started.elapsed() < Duration::from_secs(20));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn without_stdin_the_child_sees_eof_immediately() {
        let dir = temp_dir("stdin-null");
        let out = run_git(dir.to_str().unwrap(), &s(&["hash-object", "--stdin"]), None, None)
            .unwrap();
        // The empty blob's oid: git read EOF rather than waiting for input.
        assert_eq!(out.stdout.trim(), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decode_flags_invalid_utf8_instead_of_hiding_it() {
        let (text, lossy) = decode(vec![b'c', b'a', b'f', 0xE9, b'.', b't', b'x', b't']);
        assert!(lossy, "invalid UTF-8 must be reported");
        assert!(text.contains('\u{FFFD}'));

        let (text, lossy) = decode("café.txt".as_bytes().to_vec());
        assert!(!lossy);
        assert_eq!(text, "café.txt");
    }
}
