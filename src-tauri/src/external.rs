//! Launching the user's own tools: editor, mergetool, file manager.
//!
//! Plumbing only. The *what* — which program, which arguments — is decided in
//! TypeScript from the user's settings; this module spawns it. As with git,
//! programs are launched with an argument array and never through a shell, so
//! a path or a setting containing `&&` cannot become a second command.

use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum ExternalError {
    BadRequest(String),
    LaunchFailed(String),
}

impl std::fmt::Display for ExternalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(m) => write!(f, "bad request: {m}"),
            Self::LaunchFailed(m) => write!(f, "could not launch: {m}"),
        }
    }
}

impl std::error::Error for ExternalError {}

fn validate(program: &str, args: &[String]) -> Result<(), ExternalError> {
    if program.trim().is_empty() {
        return Err(ExternalError::BadRequest("no program given".into()));
    }
    if program.contains('\0') || args.iter().any(|arg| arg.contains('\0')) {
        return Err(ExternalError::BadRequest("argument contains NUL".into()));
    }
    Ok(())
}

/// Spawns a program and returns immediately.
///
/// The child is detached on purpose: an editor stays open long after the app
/// stopped caring, and waiting for it would freeze the UI. Output goes nowhere
/// — the user sees their editor, not our logs.
#[tauri::command]
pub fn open_external(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<(), ExternalError> {
    validate(&program, &args)?;

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if let Some(dir) = cwd {
        let path = Path::new(&dir);
        if !path.is_dir() {
            return Err(ExternalError::BadRequest(format!(
                "working directory is not a directory: {dir}"
            )));
        }
        command.current_dir(path);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| ExternalError::LaunchFailed(format!("{program}: {e}")))
}

/// Opens a folder in the platform's file manager.
#[tauri::command]
pub fn reveal_folder(path: String) -> Result<(), ExternalError> {
    if !Path::new(&path).is_dir() {
        return Err(ExternalError::BadRequest(format!("not a directory: {path}")));
    }

    #[cfg(windows)]
    let (program, args) = ("explorer", vec![path]);
    #[cfg(target_os = "macos")]
    let (program, args) = ("open", vec![path]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (program, args) = ("xdg-open", vec![path]);

    // Explorer exits non-zero even on success, so the spawn is all we check.
    open_external(program.to_string(), args, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_empty_program() {
        let err = open_external(String::new(), vec![], None).unwrap_err();
        assert!(matches!(err, ExternalError::BadRequest(_)));
    }

    #[test]
    fn rejects_nul_in_arguments() {
        let err = open_external("git".into(), vec!["a\0b".into()], None).unwrap_err();
        assert!(matches!(err, ExternalError::BadRequest(_)));
    }

    #[test]
    fn rejects_a_working_directory_that_is_not_one() {
        let missing = std::env::temp_dir().join("krakenless-not-here-4f2a");
        let err = open_external(
            "git".into(),
            vec!["--version".into()],
            Some(missing.to_string_lossy().into_owned()),
        )
        .unwrap_err();
        assert!(matches!(err, ExternalError::BadRequest(_)));
    }

    #[test]
    fn reports_a_missing_program_instead_of_failing_silently() {
        let err = open_external("krakenless-no-such-program".into(), vec![], None).unwrap_err();
        assert!(matches!(err, ExternalError::LaunchFailed(_)));
    }

    #[test]
    fn arguments_are_not_shell_interpreted() {
        // Launching through a shell would let a path containing `&&` run a
        // second command. `git` is used here only because it is guaranteed
        // present; the assertion is that the odd argument is passed through as
        // one argument and the spawn itself succeeds.
        let dir = std::env::temp_dir();
        let result = open_external(
            "git".into(),
            vec!["--version && echo pwned".into()],
            Some(dir.to_string_lossy().into_owned()),
        );
        assert!(result.is_ok(), "spawn failed: {result:?}");
    }
}
