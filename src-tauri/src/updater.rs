//! Replacing the running program with a newer one.
//!
//! Two shapes of Krakenless exist on Windows and only one of them can be
//! updated by `tauri-plugin-updater`: that plugin downloads an *installer* and
//! runs it, which is exactly right for the NSIS and MSI builds and useless for
//! the portable executable, which has no installer at all. The portable build
//! is also the one least likely to ever be replaced by hand — it is the
//! download for people who are not allowed to install software — so it gets
//! the path written here.
//!
//! What makes that safe is not the transport. TLS says the bytes arrived
//! intact from whoever GitHub handed them over for; it does not say this
//! project built them. The only statement to that effect is the minisign
//! signature, made by a key that lives in the release workflow's secrets, so
//! **nothing downloaded here reaches the disk before it has been verified
//! against the public key compiled into this binary** (ADR-0036).
//!
//! The swap itself leans on the one thing Windows permits against a running
//! image: it can be renamed. It cannot be deleted or written over. So the new
//! file is moved into place by renaming the old one out of the way first, and
//! the old one is renamed back if the second move fails.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use tauri::Manager;

/// Public half of the release signing key, base64 as minisign writes it.
///
/// The same string is in `tauri.conf.json` for the plugin's use, and
/// `the_public_key_matches_the_manifest` below fails the test suite if the two
/// ever drift — an app that verifies installers against one key and portable
/// downloads against another has a hole exactly the size of the difference.
pub const UPDATE_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY4QzkzMjI0MzE2NTAwRjUKUldUMUFHVXhKRExKK0wxRDV4ZXIrenhIRGVQVDE5WlNoL0pFQWVOZFpvRnVtWUE2b0hXVEhleHcK";

/// File shipped as a bundle resource, present only in installed builds.
///
/// Installers copy resources next to the executable; a `krakenless.exe` copied
/// out of `target/release` has no neighbours at all. That makes the question
/// "was this installed?" a file existence check rather than a guess about
/// where the executable happens to be sitting.
const INSTALL_MARKER: &str = "krakenless-install.marker";

/// Infix given to the displaced executable while the swap is in flight, and
/// the prefix the next launch sweeps for.
const DISPLACED_INFIX: &str = ".displaced-";

/// Refuses a download larger than this before reading it into memory.
///
/// The portable executable is tens of megabytes. The cap is not a size
/// estimate — it is the ceiling on how much a manifest pointing somewhere
/// unexpected can make this process allocate.
const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

/// Smallest thing that could plausibly be the application.
const MIN_DOWNLOAD_BYTES: usize = 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum UpdateError {
    /// The running build must not replace its own file this way.
    NotPortable(String),
    /// The folder holding the executable cannot be written to.
    NotWritable(String),
    DownloadFailed(String),
    /// The bytes are not what the signing key says they should be.
    SignatureInvalid(String),
    /// The download does not look like a Windows executable.
    NotAnExecutable(String),
    SwapFailed(String),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotPortable(m) => write!(f, "not a portable build: {m}"),
            Self::NotWritable(m) => write!(f, "cannot write next to the app: {m}"),
            Self::DownloadFailed(m) => write!(f, "download failed: {m}"),
            Self::SignatureInvalid(m) => write!(f, "signature check failed: {m}"),
            Self::NotAnExecutable(m) => write!(f, "not an executable: {m}"),
            Self::SwapFailed(m) => write!(f, "could not replace the app: {m}"),
        }
    }
}

impl std::error::Error for UpdateError {}

/// How this copy of Krakenless got onto the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    /// Came from the NSIS or MSI installer; the plugin updates it.
    Installed,
    /// A loose executable; the code below updates it.
    Portable,
    /// Neither could be established. Nothing is replaced.
    Unknown,
}

/// Directories a program only ends up in by being installed.
///
/// Taken from the environment rather than hard-coded: `C:\Program Files` is
/// the usual answer and not the only one, and a machine that relocated it
/// would otherwise have its installed build classified as portable.
fn managed_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        // Where NSIS puts a per-user install, which needs no elevation and is
        // therefore the one most likely to be in use.
        roots.push(PathBuf::from(local).join("Programs"));
    }
    roots
}

/// True when `dir` is inside one of `roots`.
///
/// Compared case-insensitively because Windows paths are, and a check that
/// says "no" to `C:\PROGRAM FILES\Krakenless` would hand an installed build to
/// the self-replacing path.
fn is_under(dir: &Path, roots: &[PathBuf]) -> bool {
    let needle = dir.to_string_lossy().to_lowercase().replace('\\', "/");
    roots.iter().any(|root| {
        let root = root.to_string_lossy().to_lowercase().replace('\\', "/");
        !root.is_empty() && (needle == root || needle.starts_with(&format!("{root}/")))
    })
}

/// The classification rule, separated from the filesystem so it can be tested.
///
/// Order matters, and it is the conservative one: the marker is proof of an
/// install, and in its absence a managed location is grounds for refusing to
/// act rather than grounds for assuming portable. Only an unmarked executable
/// sitting somewhere a user put it is treated as portable.
pub fn classify(marker_present: bool, dir: &Path, roots: &[PathBuf]) -> InstallKind {
    if marker_present {
        InstallKind::Installed
    } else if is_under(dir, roots) {
        InstallKind::Unknown
    } else {
        InstallKind::Portable
    }
}

fn current_exe() -> Result<PathBuf, UpdateError> {
    std::env::current_exe().map_err(|e| UpdateError::SwapFailed(e.to_string()))
}

fn exe_dir(exe: &Path) -> Result<&Path, UpdateError> {
    exe.parent()
        .ok_or_else(|| UpdateError::SwapFailed("the executable has no parent folder".into()))
}

/// Reports how this copy was installed, so the UI can pick an update path.
#[tauri::command]
pub fn update_install_kind(app: tauri::AppHandle) -> Result<InstallKind, UpdateError> {
    let exe = current_exe()?;
    let dir = exe_dir(&exe)?;
    // Beside the executable is where an installer puts resources. The
    // resolved resource directory is consulted too because that is where they
    // are under `tauri dev`, which keeps the dev build from claiming to be
    // portable and offering to overwrite a debug binary.
    let marker = dir.join(INSTALL_MARKER).exists()
        || app
            .path()
            .resource_dir()
            .map(|resources| resources.join(INSTALL_MARKER).exists())
            .unwrap_or(false);
    Ok(classify(marker, dir, &managed_roots()))
}

/// Proves the folder can be written to before anything is downloaded.
///
/// A portable executable on a read-only share or in a folder the user has no
/// rights to is a normal situation, and finding out about it *after* the old
/// binary has been renamed away would be the worst possible moment.
fn check_writable(dir: &Path) -> Result<(), UpdateError> {
    let probe = dir.join(format!(".krakenless-write-probe-{}", unique_suffix()));
    std::fs::write(&probe, b"probe").map_err(|e| UpdateError::NotWritable(e.to_string()))?;
    std::fs::remove_file(&probe).map_err(|e| UpdateError::NotWritable(e.to_string()))?;
    Ok(())
}

/// A suffix no concurrent attempt will pick, so no swap can collide with another.
fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Verifies `bytes` against the compiled-in public key.
///
/// `signature` is the manifest's field verbatim: base64 of a minisign
/// signature file, which is what the Tauri bundler writes into `.sig` and what
/// the release workflow copies into the manifest.
pub fn verify_signature(bytes: &[u8], signature: &str, public_key: &str) -> Result<(), UpdateError> {
    let decode = |what: &str, text: &str| -> Result<String, UpdateError> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(text.trim())
            .map_err(|e| UpdateError::SignatureInvalid(format!("{what} is not base64: {e}")))?;
        String::from_utf8(raw)
            .map_err(|e| UpdateError::SignatureInvalid(format!("{what} is not text: {e}")))
    };

    let key = minisign_verify::PublicKey::decode(&decode("the public key", public_key)?)
        .map_err(|e| UpdateError::SignatureInvalid(format!("unusable public key: {e}")))?;
    let signature = minisign_verify::Signature::decode(&decode("the signature", signature)?)
        .map_err(|e| UpdateError::SignatureInvalid(format!("unusable signature: {e}")))?;

    key.verify(bytes, &signature, false)
        .map_err(|e| UpdateError::SignatureInvalid(e.to_string()))
}

/// True for something that starts like a Windows executable.
///
/// Not a security check — the signature is that — but the difference between
/// "the update did nothing and the app still runs" and "the app is now an HTML
/// error page named `.exe`" if the signing key is ever misused to sign the
/// wrong file.
pub fn looks_like_an_executable(bytes: &[u8]) -> bool {
    bytes.len() >= MIN_DOWNLOAD_BYTES && bytes.starts_with(b"MZ")
}

/// Moves `staged` onto `current`, keeping the displaced file for the sweep.
///
/// The two renames are the whole trick, and the rollback is the whole safety:
/// if the second fails, the first is undone, and the user is left with exactly
/// the working application they started with.
pub fn swap_in_place(current: &Path, staged: &Path, displaced: &Path) -> Result<(), UpdateError> {
    std::fs::rename(current, displaced)
        .map_err(|e| UpdateError::SwapFailed(format!("could not move the running app aside: {e}")))?;

    if let Err(error) = std::fs::rename(staged, current) {
        // Put it back. Failing here would leave the machine with no
        // application at all, so the original error is reported alongside
        // whether the restore worked.
        let restored = std::fs::rename(displaced, current).is_ok();
        std::fs::remove_file(staged).ok();
        return Err(UpdateError::SwapFailed(if restored {
            format!("could not move the new app into place: {error} — the old one was restored")
        } else {
            format!(
                "could not move the new app into place: {error} — and the old one could not be \
                 restored; it is at {}",
                displaced.display()
            )
        }));
    }
    Ok(())
}

/// Deletes executables displaced by a previous update.
///
/// Best-effort by design. The file is unlocked the moment the old process
/// exits, so this normally succeeds on the very next launch; if it does not —
/// antivirus holding it open is the usual reason — leaving a stale file behind
/// is not worth a message the user can do nothing about.
pub fn sweep_displaced(dir: &Path, stem: &str) -> usize {
    let prefix = format!("{stem}{DISPLACED_INFIX}");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".exe"))
        })
        .filter(|entry| std::fs::remove_file(entry.path()).is_ok())
        .count()
}

/// Runs the sweep for the currently running executable. Called at startup.
pub fn sweep_after_update() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let (Some(dir), Some(stem)) = (exe.parent(), exe.file_stem().and_then(|s| s.to_str())) else {
        return;
    };
    let removed = sweep_displaced(dir, stem);
    if removed > 0 {
        log::info!("removed {removed} executable(s) displaced by a previous update");
    }
}

/// Downloads `url`, refusing anything oversized before it is read.
async fn download(url: &str) -> Result<Vec<u8>, UpdateError> {
    let response = reqwest::Client::builder()
        .user_agent(concat!("Krakenless/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| UpdateError::DownloadFailed(e.to_string()))?
        .get(url)
        .send()
        .await
        .map_err(|e| UpdateError::DownloadFailed(e.to_string()))?
        .error_for_status()
        .map_err(|e| UpdateError::DownloadFailed(e.to_string()))?;

    if let Some(length) = response.content_length() {
        if length > MAX_DOWNLOAD_BYTES {
            return Err(UpdateError::DownloadFailed(format!(
                "the download is {length} bytes, more than this app will accept"
            )));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| UpdateError::DownloadFailed(e.to_string()))?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err(UpdateError::DownloadFailed(
            "the download is larger than this app will accept".into(),
        ));
    }
    Ok(bytes.to_vec())
}

/// Downloads, verifies and installs a new portable executable, then restarts.
///
/// This function does not return on success: the last thing it does is ask
/// Tauri to restart the process, which replaces it.
#[tauri::command]
pub async fn update_portable_apply(
    app: tauri::AppHandle,
    url: String,
    signature: String,
) -> Result<(), UpdateError> {
    if update_install_kind(app.clone())? != InstallKind::Portable {
        return Err(UpdateError::NotPortable(
            "this copy was installed, so it updates through its installer".into(),
        ));
    }

    let exe = current_exe()?;
    let dir = exe_dir(&exe)?.to_path_buf();
    let stem = exe
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| UpdateError::SwapFailed("the executable has an unreadable name".into()))?
        .to_owned();
    check_writable(&dir)?;

    let bytes = download(&url).await?;
    verify_signature(&bytes, &signature, UPDATE_PUBLIC_KEY)?;
    if !looks_like_an_executable(&bytes) {
        return Err(UpdateError::NotAnExecutable(
            "the download is signed but is not a Windows program".into(),
        ));
    }

    // Only now does anything touch the disk, and it lands beside the current
    // executable so that the rename below stays on one volume and is therefore
    // atomic rather than a copy that can half-finish.
    let suffix = unique_suffix();
    let staged = dir.join(format!(".{stem}.incoming-{suffix}.exe"));
    let displaced = dir.join(format!("{stem}{DISPLACED_INFIX}{suffix}.exe"));
    std::fs::write(&staged, &bytes).map_err(|e| UpdateError::SwapFailed(e.to_string()))?;

    if let Err(error) = swap_in_place(&exe, &staged, &displaced) {
        std::fs::remove_file(&staged).ok();
        return Err(error);
    }

    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("krakenless-update-{name}-{}", unique_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The two keys must be the same key. A drift between them would mean the
    /// installed path and the portable path trust different signers.
    #[test]
    fn the_public_key_matches_the_manifest() {
        let manifest =
            std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"))
                .expect("tauri.conf.json is readable");
        let config: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        let configured = config["plugins"]["updater"]["pubkey"]
            .as_str()
            .expect("tauri.conf.json declares plugins.updater.pubkey");
        assert_eq!(
            configured, UPDATE_PUBLIC_KEY,
            "the updater plugin and the portable path must verify against one key"
        );
    }

    #[test]
    fn a_marker_beside_the_executable_means_installed() {
        let dir = PathBuf::from("C:/Users/someone/Downloads");
        assert_eq!(classify(true, &dir, &[]), InstallKind::Installed);
    }

    #[test]
    fn a_loose_executable_is_portable() {
        let dir = PathBuf::from("C:/Users/someone/Downloads");
        let roots = vec![PathBuf::from("C:/Program Files")];
        assert_eq!(classify(false, &dir, &roots), InstallKind::Portable);
    }

    #[test]
    fn an_unmarked_executable_in_an_install_location_is_not_guessed_at() {
        let roots = vec![PathBuf::from("C:/Program Files")];
        assert_eq!(
            classify(false, Path::new("C:/Program Files/Krakenless"), &roots),
            InstallKind::Unknown,
            "refusing beats self-replacing something an installer owns"
        );
    }

    #[test]
    fn install_locations_are_matched_case_and_separator_insensitively() {
        let roots = vec![PathBuf::from("C:\\Program Files")];
        assert_eq!(
            classify(false, Path::new("C:/PROGRAM FILES/Krakenless"), &roots),
            InstallKind::Unknown
        );
    }

    #[test]
    fn a_folder_merely_starting_with_a_root_name_is_not_under_it() {
        let roots = vec![PathBuf::from("C:/Program Files")];
        assert!(!is_under(Path::new("C:/Program Files Portable/app"), &roots));
    }

    #[test]
    fn an_empty_root_matches_nothing() {
        assert!(!is_under(Path::new("C:/anywhere"), &[PathBuf::new()]));
    }

    #[test]
    fn a_short_or_headerless_download_is_not_an_executable() {
        assert!(!looks_like_an_executable(b"MZ"));
        assert!(!looks_like_an_executable(&vec![0u8; MIN_DOWNLOAD_BYTES]));
        let mut real = vec![0u8; MIN_DOWNLOAD_BYTES];
        real[0] = b'M';
        real[1] = b'Z';
        assert!(looks_like_an_executable(&real));
    }

    /// Loads one of the fixtures under `tests/fixtures`.
    ///
    /// They were produced by `tauri signer generate` and `tauri signer sign` —
    /// the same two commands the release workflow runs — and the private key
    /// was thrown away afterwards. What they pin down is the part no mock can:
    /// that this verifier accepts the exact bytes that toolchain emits, in the
    /// exact encoding the manifest carries them in.
    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(name),
        )
        .unwrap_or_else(|e| panic!("fixture {name}: {e}"))
    }

    fn fixture_text(name: &str) -> String {
        String::from_utf8(fixture(name)).unwrap()
    }

    #[test]
    fn accepts_a_signature_the_tauri_signer_actually_produced() {
        verify_signature(
            &fixture("signed-payload.bin"),
            &fixture_text("signed-payload.bin.sig"),
            &fixture_text("signed-payload.pub"),
        )
        .expect("a genuine signature must verify");
    }

    /// The one test that checks the *shipping* key rather than a stand-in.
    ///
    /// `the_public_key_matches_the_manifest` proves the two copies of the key
    /// agree with each other; it cannot notice that both were truncated or
    /// mistyped together. This can: the fixture was signed by the private half
    /// that lives in the release workflow's secrets, so it only verifies if the
    /// public key compiled into this binary is genuinely that key's other half.
    /// A release built with a broken `UPDATE_PUBLIC_KEY` would install nowhere,
    /// and nothing would say so until a user tried to update.
    #[test]
    fn the_shipping_public_key_verifies_a_signature_from_the_release_key() {
        verify_signature(
            &fixture("release-key-payload.bin"),
            &fixture_text("release-key-payload.bin.sig"),
            UPDATE_PUBLIC_KEY,
        )
        .expect("UPDATE_PUBLIC_KEY must be the release signing key's public half");
    }

    #[test]
    fn refuses_a_payload_with_a_single_byte_changed() {
        let mut tampered = fixture("signed-payload.bin");
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;

        let error = verify_signature(
            &tampered,
            &fixture_text("signed-payload.bin.sig"),
            &fixture_text("signed-payload.pub"),
        );

        assert!(matches!(error, Err(UpdateError::SignatureInvalid(_))));
    }

    #[test]
    fn refuses_a_genuine_signature_made_by_a_different_key() {
        // The signature and the payload agree with each other; they just were
        // not signed by the key this build trusts. That is the case a stolen
        // manifest host is, and it must fail exactly like a corrupt download.
        let error = verify_signature(
            &fixture("signed-payload.bin"),
            &fixture_text("signed-payload.bin.sig"),
            UPDATE_PUBLIC_KEY,
        );

        assert!(matches!(error, Err(UpdateError::SignatureInvalid(_))));
    }

    #[test]
    fn a_signature_that_is_not_base64_is_refused_before_anything_is_parsed() {
        let error = verify_signature(b"payload", "not base64!!", "also not base64!!");
        assert!(matches!(error, Err(UpdateError::SignatureInvalid(_))));
    }

    #[test]
    fn a_signature_that_is_valid_base64_but_not_a_signature_is_refused() {
        // "c2ln" decodes to "sig", which is text and not a minisign signature.
        // The decode succeeding must not be mistaken for the signature being
        // usable: the portable path fails closed at every step or not at all.
        assert!(verify_signature(b"payload", "c2ln", UPDATE_PUBLIC_KEY).is_err());
    }

    #[test]
    fn the_swap_puts_the_new_file_in_place_and_keeps_the_old_one() {
        let dir = temp_dir("swap");
        let current = dir.join("krakenless.exe");
        let staged = dir.join(".krakenless.incoming.exe");
        let displaced = dir.join("krakenless.displaced-1.exe");
        std::fs::write(&current, b"old").unwrap();
        std::fs::write(&staged, b"new").unwrap();

        swap_in_place(&current, &staged, &displaced).unwrap();

        assert_eq!(std::fs::read(&current).unwrap(), b"new");
        assert_eq!(std::fs::read(&displaced).unwrap(), b"old");
        assert!(!staged.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_second_move_restores_the_original() {
        let dir = temp_dir("rollback");
        let current = dir.join("krakenless.exe");
        let displaced = dir.join("krakenless.displaced-1.exe");
        // A staged file that does not exist makes the second rename fail,
        // which is the branch the user's working application depends on.
        let staged = dir.join(".krakenless.incoming.exe");
        std::fs::write(&current, b"old").unwrap();

        let error = swap_in_place(&current, &staged, &displaced).unwrap_err();

        assert!(matches!(error, UpdateError::SwapFailed(_)));
        assert_eq!(
            std::fs::read(&current).unwrap(),
            b"old",
            "the application must still be there after a failed update"
        );
        assert!(!displaced.exists(), "the backup was left behind");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_sweep_removes_displaced_executables_and_nothing_else() {
        let dir = temp_dir("sweep");
        for name in [
            "krakenless.displaced-1.exe",
            "krakenless.displaced-2.exe",
            "krakenless.exe",
            "krakenless.displaced-1.exe.bak",
            "other.displaced-1.exe",
            "repo.db",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }

        assert_eq!(sweep_displaced(&dir, "krakenless"), 2);

        assert!(dir.join("krakenless.exe").exists());
        assert!(dir.join("other.displaced-1.exe").exists());
        assert!(dir.join("krakenless.displaced-1.exe.bak").exists());
        assert!(dir.join("repo.db").exists());
        assert!(!dir.join("krakenless.displaced-1.exe").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_sweep_on_a_missing_folder_is_not_an_error() {
        assert_eq!(
            sweep_displaced(Path::new("Z:/no/such/folder"), "krakenless"),
            0
        );
    }

    #[test]
    fn a_writable_folder_leaves_no_probe_behind() {
        let dir = temp_dir("probe");
        check_writable(&dir).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unwritable_folder_is_reported_before_any_download() {
        let error = check_writable(Path::new("Z:/no/such/folder"));
        assert!(matches!(error, Err(UpdateError::NotWritable(_))));
    }
}
