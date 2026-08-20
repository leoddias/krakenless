//! Plumbing for the author-picture cache.
//!
//! Rust owns *where* the bytes live and how they are written; TypeScript owns
//! what is fetched, from whom, and when (see `src/views/history/avatarCache.ts`
//! and ADR-0021). This module never makes a network request and never decides
//! that one should be made — it stores opaque bytes under an opaque key.
//!
//! The key is the SHA-256 the TypeScript side already computed, and it is
//! validated here as 64 lowercase hex digits before it is ever joined onto a
//! path. That is the whole security story of this file: a key that is not a
//! hash cannot name a file outside the cache folder.
//!
//! Nothing here is logged. The key is derived from an email address, and a log
//! line carrying it would be exactly the record this product promises not to
//! keep.

use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Same folder as the settings file (see `config.rs`): the product promise is
/// one human-readable directory the user can find, copy and delete.
const CONFIG_FOLDER: &str = "krakenless";
const AVATAR_FOLDER: &str = "avatars";

/// Extension marking "asked, and this identity has no picture".
const NO_PICTURE: &str = "none";

/// The extensions an entry may be stored under. An allow-list rather than a
/// sanitiser: `..` and `png/../../x` are not on it, so they cannot be written.
const EXTENSIONS: [&str; 5] = ["png", "jpg", "gif", "webp", NO_PICTURE];

/// Refuses anything a picture could not plausibly be, so a bad response cannot
/// fill the user's config folder. 2 MiB is far beyond a 32-pixel avatar.
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AvatarError {
    /// The platform config directory could not be resolved.
    NoConfigDir(String),
    /// The key was not a SHA-256 hex digest, or the extension was not allowed.
    /// Deliberately carries no detail: the key is derived from an email.
    Rejected(&'static str),
    ReadFailed(String),
    WriteFailed(String),
}

impl std::fmt::Display for AvatarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoConfigDir(m) => write!(f, "no config directory: {m}"),
            Self::Rejected(m) => write!(f, "rejected avatar cache entry: {m}"),
            Self::ReadFailed(m) => write!(f, "could not read avatar cache: {m}"),
            Self::WriteFailed(m) => write!(f, "could not write avatar cache: {m}"),
        }
    }
}

impl std::error::Error for AvatarError {}

/// One cached identity, as the webview gets it back.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarEntry {
    /// Image extension, or `none` for a cached "there is no picture".
    pub extension: String,
    /// The stored bytes; empty for a negative entry.
    pub bytes: Vec<u8>,
    /// Unix milliseconds the entry was written, for the expiry rule in TS.
    pub stored_at: u64,
}

fn avatar_dir(app: &tauri::AppHandle) -> Result<PathBuf, AvatarError> {
    Ok(app
        .path()
        .config_dir()
        .map_err(|e| AvatarError::NoConfigDir(e.to_string()))?
        .join(CONFIG_FOLDER)
        .join(AVATAR_FOLDER))
}

/// True for exactly 64 lowercase hex digits — the shape of the SHA-256 the
/// webview computes. Uppercase is refused rather than folded, so one identity
/// can never end up under two file names.
fn is_cache_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_extension(extension: &str) -> bool {
    EXTENSIONS.contains(&extension)
}

/// Path of one entry. The only place a key becomes a path, and it validates
/// both halves first.
fn entry_path(dir: &Path, key: &str, extension: &str) -> Result<PathBuf, AvatarError> {
    if !is_cache_key(key) {
        return Err(AvatarError::Rejected("cache key is not a sha-256 digest"));
    }
    if !is_extension(extension) {
        return Err(AvatarError::Rejected("unsupported cache entry type"));
    }
    Ok(dir.join(format!("{key}.{extension}")))
}

fn modified_millis(path: &Path) -> Result<u64, AvatarError> {
    let modified = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map_err(|e| AvatarError::ReadFailed(e.to_string()))?;
    Ok(modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .min(u128::from(u64::MAX)) as u64)
}

fn read_entry(dir: &Path, key: &str) -> Result<Option<AvatarEntry>, AvatarError> {
    for extension in EXTENSIONS {
        let path = entry_path(dir, key, extension)?;
        // Same cap as on the way in, applied before the read: a file that grew
        // by some other means must not be loaded whole just to be rejected.
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() > MAX_BYTES as u64 => continue,
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(AvatarError::ReadFailed(e.to_string())),
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(AvatarError::ReadFailed(e.to_string())),
        };
        let stored_at = modified_millis(&path)?;
        return Ok(Some(AvatarEntry {
            extension: extension.to_string(),
            bytes,
            stored_at,
        }));
    }
    Ok(None)
}

fn write_entry(
    dir: &Path,
    key: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<(), AvatarError> {
    if bytes.len() > MAX_BYTES {
        return Err(AvatarError::Rejected("cache entry is too large"));
    }
    // A negative entry says "asked, nothing there"; a body under that name
    // would be handed back later as a picture with no type.
    if extension == NO_PICTURE && !bytes.is_empty() {
        return Err(AvatarError::Rejected("a negative entry carries no bytes"));
    }
    let final_path = entry_path(dir, key, extension)?;
    std::fs::create_dir_all(dir).map_err(|e| AvatarError::WriteFailed(e.to_string()))?;

    let temp_path = dir.join(format!("{key}.{extension}.tmp"));
    write_temp(&temp_path, bytes).inspect_err(|_| {
        // Leaving `<key>.<ext>.tmp` behind would accumulate one file per
        // failure, and nothing ever reads it.
        let _ = std::fs::remove_file(&temp_path);
    })?;
    std::fs::rename(&temp_path, &final_path)
        .map_err(|e| AvatarError::WriteFailed(e.to_string()))?;

    // One identity, one file: drop whatever it was stored as before, so a
    // "no picture" entry cannot outlive the picture that replaced it. Done
    // *after* the rename, so a failed write leaves the old entry standing
    // rather than nothing at all — and best-effort, because the entry is
    // already committed at this point and reporting a locked leftover as a
    // failed write would be a lie. A stale sibling loses on the next read
    // anyway: its own timestamp expires it.
    for other in EXTENSIONS {
        if other == extension {
            continue;
        }
        let path = entry_path(dir, key, other)?;
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

fn write_temp(path: &Path, bytes: &[u8]) -> Result<(), AvatarError> {
    let mut file =
        std::fs::File::create(path).map_err(|e| AvatarError::WriteFailed(e.to_string()))?;
    file.write_all(bytes)
        .map_err(|e| AvatarError::WriteFailed(e.to_string()))?;
    file.sync_all()
        .map_err(|e| AvatarError::WriteFailed(e.to_string()))
}

/// Reads one cached identity. A miss is `None`, not an error: it means "never
/// asked", which the TypeScript layer turns into at most one request.
#[tauri::command]
pub fn avatar_read(
    app: tauri::AppHandle,
    key: String,
) -> Result<Option<AvatarEntry>, AvatarError> {
    read_entry(&avatar_dir(&app)?, &key)
}

/// Writes one cached identity: the picture's bytes, or nothing at all under
/// the `none` extension for "this identity has no picture".
#[tauri::command]
pub fn avatar_write(
    app: tauri::AppHandle,
    key: String,
    extension: String,
    bytes: Vec<u8>,
) -> Result<(), AvatarError> {
    write_entry(&avatar_dir(&app)?, &key, &extension, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "krakenless-avatars-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_a_sha256_digest_as_a_key() {
        assert!(is_cache_key(KEY));
    }

    #[test]
    fn refuses_a_key_that_is_not_a_digest() {
        // Traversal, separators, wrong length, wrong case: none of these can
        // become a path, so no response can name a file outside the cache.
        assert!(!is_cache_key("../../config"));
        assert!(!is_cache_key(&KEY.replace("01", "..")));
        assert!(!is_cache_key(&KEY.to_uppercase()));
        assert!(!is_cache_key(&KEY[..63]));
        assert!(!is_cache_key(&format!("{KEY}0")));
        assert!(!is_cache_key(""));
        assert!(!is_cache_key(&KEY.replace('0', "/")));
    }

    #[test]
    fn refuses_an_extension_that_is_not_on_the_list() {
        let dir = temp_dir("extension");
        assert!(entry_path(&dir, KEY, "exe").is_err());
        assert!(entry_path(&dir, KEY, "../evil").is_err());
        assert!(entry_path(&dir, KEY, "").is_err());
        assert!(entry_path(&dir, KEY, "png").is_ok());
        assert!(entry_path(&dir, KEY, NO_PICTURE).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_traversing_key_never_reaches_the_filesystem() {
        let dir = temp_dir("traverse");
        let key = "../../../../config";
        assert!(write_entry(&dir, key, "png", b"x").is_err());
        assert!(read_entry(&dir, key).is_err());
        assert!(!dir.parent().unwrap().join("config.png").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn round_trips_a_picture() {
        let dir = temp_dir("roundtrip");
        write_entry(&dir, KEY, "png", &[1, 2, 3]).unwrap();
        let entry = read_entry(&dir, KEY).unwrap().unwrap();
        assert_eq!(entry.extension, "png");
        assert_eq!(entry.bytes, vec![1, 2, 3]);
        assert!(entry.stored_at > 0);
        assert!(!dir.join(format!("{KEY}.png.tmp")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_identity_never_asked_about_reads_as_nothing() {
        let dir = temp_dir("miss");
        assert!(read_entry(&dir, KEY).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remembers_that_an_identity_has_no_picture() {
        let dir = temp_dir("negative");
        write_entry(&dir, KEY, NO_PICTURE, &[]).unwrap();
        let entry = read_entry(&dir, KEY).unwrap().unwrap();
        assert_eq!(entry.extension, NO_PICTURE);
        assert!(entry.bytes.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_identity_keeps_one_file() {
        let dir = temp_dir("replace");
        write_entry(&dir, KEY, NO_PICTURE, &[]).unwrap();
        write_entry(&dir, KEY, "png", &[9]).unwrap();

        assert!(!dir.join(format!("{KEY}.{NO_PICTURE}")).exists());
        let entry = read_entry(&dir, KEY).unwrap().unwrap();
        assert_eq!(entry.extension, "png");
        assert_eq!(entry.bytes, vec![9]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_negative_entry_that_carries_bytes() {
        let dir = temp_dir("negative-bytes");
        assert!(write_entry(&dir, KEY, NO_PICTURE, b"surprise").is_err());
        assert!(read_entry(&dir, KEY).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keeps_the_previous_entry_when_the_new_one_cannot_be_written() {
        let dir = temp_dir("failed-write");
        write_entry(&dir, KEY, "png", &[9]).unwrap();
        // A directory where the temp file wants to be: `File::create` fails,
        // and the entry already on disk must survive that.
        std::fs::create_dir_all(dir.join(format!("{KEY}.gif.tmp"))).unwrap();

        assert!(write_entry(&dir, KEY, "gif", &[1]).is_err());
        let entry = read_entry(&dir, KEY).unwrap().unwrap();
        assert_eq!(entry.extension, "png");
        assert_eq!(entry.bytes, vec![9]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_an_entry_that_grew_past_the_cap_on_disk() {
        let dir = temp_dir("large-on-disk");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{KEY}.png")), vec![0u8; MAX_BYTES + 1]).unwrap();
        assert!(read_entry(&dir, KEY).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_body_too_large_to_be_an_avatar() {
        let dir = temp_dir("large");
        let bytes = vec![0u8; MAX_BYTES + 1];
        assert!(write_entry(&dir, KEY, "png", &bytes).is_err());
        assert!(read_entry(&dir, KEY).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
