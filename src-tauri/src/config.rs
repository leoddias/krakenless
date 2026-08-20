//! Plumbing for the app's settings file.
//!
//! Rust owns *where* the file lives and how it is written; TypeScript owns the
//! schema and every validation decision. This module deliberately never parses
//! the contents — it moves opaque text.

use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

const CONFIG_FILE: &str = "config.json";

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum ConfigError {
    /// The platform config directory could not be resolved.
    NoConfigDir(String),
    ReadFailed(String),
    WriteFailed(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoConfigDir(m) => write!(f, "no config directory: {m}"),
            Self::ReadFailed(m) => write!(f, "could not read config: {m}"),
            Self::WriteFailed(m) => write!(f, "could not write config: {m}"),
        }
    }
}

impl std::error::Error for ConfigError {}

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, ConfigError> {
    app.path()
        .app_config_dir()
        .map_err(|e| ConfigError::NoConfigDir(e.to_string()))
}

/// Reads the settings file. A missing file is not an error: it means "no
/// settings yet", which the TypeScript layer turns into defaults.
#[tauri::command]
pub fn config_read(app: tauri::AppHandle) -> Result<Option<String>, ConfigError> {
    let path = config_dir(&app)?.join(CONFIG_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ConfigError::ReadFailed(e.to_string())),
    }
}

/// Writes the settings file atomically: a crash mid-write must not leave the
/// user with a truncated config that the app then refuses to start with.
#[tauri::command]
pub fn config_write(app: tauri::AppHandle, contents: String) -> Result<(), ConfigError> {
    let dir = config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| ConfigError::WriteFailed(e.to_string()))?;

    let final_path = dir.join(CONFIG_FILE);
    let temp_path = dir.join(format!("{CONFIG_FILE}.tmp"));
    {
        let mut file =
            std::fs::File::create(&temp_path).map_err(|e| ConfigError::WriteFailed(e.to_string()))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| ConfigError::WriteFailed(e.to_string()))?;
        file.sync_all()
            .map_err(|e| ConfigError::WriteFailed(e.to_string()))?;
    }
    std::fs::rename(&temp_path, &final_path).map_err(|e| ConfigError::WriteFailed(e.to_string()))
}

/// Absolute path of the folder holding the settings file, for the UI's
/// "open config folder" affordance and for the README's backup instructions.
#[tauri::command]
pub fn config_dir_path(app: tauri::AppHandle) -> Result<String, ConfigError> {
    Ok(config_dir(&app)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The atomic-write dance is the part worth testing without a Tauri app
    /// handle: write to a temp file, fsync, rename over the target.
    fn write_atomically(dir: &PathBuf, contents: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let temp = dir.join("config.json.tmp");
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temp, dir.join(CONFIG_FILE))
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "krakenless-config-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replaces_an_existing_file_without_leaving_a_temp_behind() {
        let dir = temp_dir("replace");
        write_atomically(&dir, "{\"a\":1}").unwrap();
        write_atomically(&dir, "{\"a\":2}").unwrap();

        let text = std::fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert_eq!(text, "{\"a\":2}");
        assert!(!dir.join("config.json.tmp").exists(), "temp file survived");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keeps_unicode_content_intact() {
        let dir = temp_dir("unicode");
        write_atomically(&dir, "{\"path\":\"C:/repos/café\"}").unwrap();
        let text = std::fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert!(text.contains("café"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_file_reads_as_none() {
        let dir = temp_dir("missing");
        let result = std::fs::read_to_string(dir.join(CONFIG_FILE));
        assert_eq!(
            result.err().map(|e| e.kind()),
            Some(std::io::ErrorKind::NotFound)
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
