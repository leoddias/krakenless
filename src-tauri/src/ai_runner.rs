//! Plumbing only: spawn a user-configured AI CLI and capture its answer.
//!
//! The app has no API client and holds no key. It shells out to a binary the
//! user already installed and authenticated — the same relationship it has
//! with `git`. That is the whole design: Krakenless never talks to a model
//! provider, so there is no key to store, no key to leak, and nothing to
//! configure beyond "which command".
//!
//! Like `git_runner`, this module contains no semantics. It does not know what
//! a commit message is; argument building and output cleaning live in
//! TypeScript. The binary is always spawned with an argument array, never
//! through a shell.

use std::process::Command;
use std::time::Duration;

use crate::git_runner::{run_capture, GitOutput, GitRunError};

/// Long enough for a model call, short enough that a wedged CLI cannot hold a
/// button down forever. A local model on a cold start is the slow case.
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

/// Rejects a program the app should not be launching on the user's behalf.
///
/// Deliberately narrow. The program is whatever the user configured, exactly
/// as `editorCommand` already is — but unlike the editor, this one is handed
/// the staged diff and run by a button, so the shape is checked first. A path
/// separator is allowed (people do point at an absolute path); an argument
/// smuggled into the same string is not, because it would arrive as part of
/// the program name and silently fail to be what it looks like.
fn validate_program(program: &str) -> Result<(), GitRunError> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err(GitRunError::BadArgument("no AI command configured".into()));
    }
    if trimmed != program {
        return Err(GitRunError::BadArgument(
            "AI command has leading or trailing whitespace".into(),
        ));
    }
    if program.contains('\0') {
        return Err(GitRunError::BadArgument(
            "AI command contains NUL".into(),
        ));
    }
    // A space here means the user wrote `claude --flag` where a program name
    // belongs. Running that looks for a file literally called "claude --flag";
    // saying so beats a confusing "not found".
    if program.chars().any(char::is_whitespace) {
        return Err(GitRunError::BadArgument(
            "AI command must be a program name or path, without arguments".into(),
        ));
    }
    Ok(())
}

fn validate_args(args: &[String]) -> Result<(), GitRunError> {
    for arg in args {
        if arg.contains('\0') {
            return Err(GitRunError::BadArgument("argument contains NUL".into()));
        }
    }
    Ok(())
}

/// Runs the configured AI CLI with `prompt_text` on stdin.
///
/// `async` for the same reason as `git_run`: a synchronous Tauri command runs
/// on the thread that paints the window, and a model call takes seconds. On
/// the main thread it would freeze the whole app for its entire duration.
#[tauri::command]
pub async fn ai_run(
    program: String,
    args: Vec<String>,
    cwd: String,
    stdin_text: String,
    timeout_ms: Option<u64>,
) -> Result<GitOutput, GitRunError> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_program(&program)?;
        validate_args(&args)?;

        let path = std::path::Path::new(&cwd);
        if !path.is_absolute() || !path.is_dir() {
            return Err(GitRunError::BadRepoPath(format!(
                "not an absolute directory: {cwd}"
            )));
        }

        let timeout = Duration::from_millis(
            timeout_ms
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
        );

        let mut command = Command::new(&program);
        command.current_dir(path).args(&args);

        run_capture(command, timeout, Some(stdin_text))
    })
    .await
    .map_err(|e| GitRunError::IoFailed(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_bare_program_name_and_a_path() {
        assert!(validate_program("claude").is_ok());
        assert!(validate_program("C:/tools/claude.exe").is_ok());
        assert!(validate_program("/usr/local/bin/claude").is_ok());
    }

    #[test]
    fn refuses_a_command_with_arguments_baked_in() {
        // Otherwise the whole string is looked up as a file name, and the user
        // gets "not found" for a command they can see is installed.
        let error = validate_program("claude --print").unwrap_err();
        assert!(format!("{error}").contains("without arguments"));
    }

    #[test]
    fn refuses_an_empty_or_whitespace_command() {
        assert!(validate_program("").is_err());
        assert!(validate_program("   ").is_err());
        assert!(validate_program(" claude").is_err());
        assert!(validate_program("claude ").is_err());
    }

    #[test]
    fn refuses_nul_in_the_program_or_an_argument() {
        // A NUL cannot survive the trip to the OS and would truncate silently.
        assert!(validate_program("clau\0de").is_err());
        assert!(validate_args(&["--model".into(), "hai\0ku".into()]).is_err());
    }

    #[test]
    fn allows_an_empty_argument_list() {
        assert!(validate_args(&[]).is_ok());
    }
}
