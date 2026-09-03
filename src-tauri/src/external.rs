//! Launching the user's own tools: editor, mergetool, file manager.
//!
//! Plumbing only. The *what* — which program, which arguments — is decided in
//! TypeScript from the user's settings; this module spawns it. As with git,
//! programs are launched with an argument array and never through a shell, so
//! a path or a setting containing `&&` cannot become a second command.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::git_runner::{scrub_git_env, GIT_GLOBAL_ARGS};

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

/// True when the program being launched is git itself.
///
/// Launching git this way — `git mergetool` is the case — must inherit the same
/// hardening as the runner: without the environment scrub an inherited
/// `GIT_INDEX_FILE` sends the resolution into a foreign index, and without
/// `--literal-pathspecs` a file named `:(glob)**` makes mergetool operate on
/// files the user never selected.
fn is_git_program(program: &str) -> bool {
    Path::new(program)
        .file_stem()
        .is_some_and(|stem| stem.eq_ignore_ascii_case("git"))
}

/// The argument list the child actually receives.
///
/// Separated from the spawn so it can be asserted on: the child is detached
/// with its output discarded, so there is no way to observe this after the fact.
fn effective_args(program: &str, args: &[String]) -> Vec<String> {
    if !is_git_program(program) {
        return args.to_vec();
    }
    GIT_GLOBAL_ARGS
        .iter()
        .map(|arg| (*arg).to_string())
        .chain(args.iter().cloned())
        .collect()
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
    if is_git_program(&program) {
        scrub_git_env(&mut command);
    }

    command
        .args(effective_args(&program, &args))
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

/// The arguments that make a file manager open a folder *and select* an item.
///
/// Split out from the spawn so it can be asserted on: the child is detached
/// with its output discarded, so nothing about the launch is observable
/// afterwards, and the Windows form is unforgiving — Explorer wants
/// `/select,<path>` as **one** argument with backslashes, and silently opens
/// the user's Documents folder instead when either is wrong.
#[cfg(windows)]
fn reveal_launch(path: &str) -> (String, Vec<String>) {
    let native = path.replace('/', "\\");
    ("explorer".into(), vec![format!("/select,{native}")])
}

#[cfg(target_os = "macos")]
fn reveal_launch(path: &str) -> (String, Vec<String>) {
    ("open".into(), vec!["-R".into(), path.into()])
}

/// No desktop-independent way to select a file, so the containing folder is
/// opened instead. Better than doing nothing, and better than guessing at a
/// file manager that may not be installed.
#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_launch(path: &str) -> (String, Vec<String>) {
    let parent = Path::new(path)
        .parent()
        .map_or_else(|| path.to_string(), |dir| dir.to_string_lossy().into_owned());
    ("xdg-open".into(), vec![parent])
}

/// Shows one file in the platform's file manager, selected.
///
/// Takes the absolute path the UI already knows, and checks it rather than
/// trusting it: a row drawn before the file was deleted would otherwise open a
/// file manager at nothing — or, on Windows, at whatever folder Explorer falls
/// back to, which reads as the app having opened the wrong place.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), ExternalError> {
    if !Path::new(&path).exists() {
        return Err(ExternalError::BadRequest(format!("not found: {path}")));
    }
    let (program, args) = reveal_launch(&path);
    // Explorer exits non-zero even on success, so the spawn is all we check.
    open_external(program, args, None)
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
    fn recognises_git_however_it_is_spelled() {
        assert!(is_git_program("git"));
        assert!(is_git_program("git.exe"));
        assert!(is_git_program("C:/Program Files/Git/cmd/git.exe"));
        assert!(is_git_program("/usr/bin/git"));
        assert!(!is_git_program("gitk"));
        assert!(!is_git_program("code"));
        assert!(!is_git_program("my-git-wrapper"));
    }

    #[test]
    fn git_launched_externally_gets_the_runner_globals() {
        // `git mergetool` would otherwise run without --literal-pathspecs, and
        // a file named `:(glob)**` would make it touch files the user did not
        // select.
        let args = effective_args("git", &["mergetool".to_string(), "--no-prompt".to_string()]);
        assert_eq!(&args[..GIT_GLOBAL_ARGS.len()], &GIT_GLOBAL_ARGS[..]);
        assert_eq!(args.last().unwrap(), "--no-prompt");
        assert!(args.contains(&"--literal-pathspecs".to_string()));
    }

    #[test]
    fn launching_git_scrubs_the_redirecting_environment() {
        // The args half of this fix is asserted above; without this the scrub
        // could quietly stop happening in a refactor and nothing would notice.
        let mut command = Command::new("git");
        scrub_git_env(&mut command);
        let removed: Vec<_> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();

        for key in crate::git_runner::GIT_ENV_TO_SCRUB {
            assert!(removed.contains(&key.to_string()), "{key} was not scrubbed");
        }
    }

    #[test]
    fn an_editor_is_launched_with_exactly_what_it_was_given() {
        // Prepending `--no-pager` to an editor invocation would break it.
        let args = effective_args("code", &["-g".to_string(), "a.ts".to_string()]);
        assert_eq!(args, vec!["-g".to_string(), "a.ts".to_string()]);
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

    #[test]
    fn reveal_refuses_a_path_that_is_not_there() {
        let missing = std::env::temp_dir().join("krakenless-no-such-file-9c1d.txt");
        let err = reveal_path(missing.to_string_lossy().into_owned()).unwrap_err();
        assert!(matches!(err, ExternalError::BadRequest(_)), "{err:?}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_reveal_selects_the_file_itself() {
        // `/select,` and the path must arrive as one argument, with backslashes.
        // Two arguments, or forward slashes, and Explorer opens the user's
        // Documents folder without saying so.
        let (program, args) = reveal_launch("C:/repo/src/main.rs");
        assert_eq!(program, "explorer");
        assert_eq!(args, vec![r"/select,C:\repo\src\main.rs".to_string()]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reveal_selects_the_file_itself() {
        let (program, args) = reveal_launch("/repo/src/main.rs");
        assert_eq!(program, "open");
        assert_eq!(args, vec!["-R".to_string(), "/repo/src/main.rs".to_string()]);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn other_unix_reveal_opens_the_containing_folder() {
        let (program, args) = reveal_launch("/repo/src/main.rs");
        assert_eq!(program, "xdg-open");
        assert_eq!(args, vec!["/repo/src".to_string()]);
    }
}
