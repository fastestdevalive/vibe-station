//! The API-key file beside an account folder.
//!
//! `<accounts root>/<cli>/<id>.key` (a sibling of the account folder, never
//! inside it), mode 0600, content = the key bytes with no trailing newline.
//! The key is never logged, never returned by any API and never put in argv —
//! it reaches the CLI only as an env var at spawn (R6).

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use vst_types::ApiKey;

/// Longest key we accept (bytes).
pub const MAX_KEY_BYTES: usize = 4096;

/// Why a key was rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
    #[error("an API key is required")]
    Empty,
    #[error("an API key can be at most 4096 bytes")]
    TooLong,
    #[error("an API key cannot contain control characters")]
    Control,
}

/// Why writing the key file failed.
#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("invalid API key: {0}")]
    Key(#[from] KeyError),
    #[error("could not write the API key file")]
    Io(#[from] std::io::Error),
}

/// Validate a key: non-empty, no control characters, at most 4096 bytes.
///
/// # Errors
///
/// [`KeyError::Empty`], [`KeyError::TooLong`] or [`KeyError::Control`].
pub fn validate_key(key: &str) -> Result<(), KeyError> {
    if key.is_empty() {
        return Err(KeyError::Empty);
    }
    if key.len() > MAX_KEY_BYTES {
        return Err(KeyError::TooLong);
    }
    if key.chars().any(char::is_control) {
        return Err(KeyError::Control);
    }
    Ok(())
}

/// The key file's path for account folder `dir`: `<dir>.key` (a sibling).
#[must_use]
pub fn key_path(dir: &Path) -> PathBuf {
    let mut name = dir.as_os_str().to_owned();
    name.push(".key");
    PathBuf::from(name)
}

/// Delete the key file for `dir`; a missing file is not an error.
///
/// # Errors
///
/// Propagates a filesystem error other than "not found".
pub fn remove_api_key(dir: &Path) -> io::Result<()> {
    match std::fs::remove_file(key_path(dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Write the key to `<dir>.key` with mode 0600 (no newline).
///
/// # Errors
///
/// The key fails validation, or the file cannot be created/written.
pub fn write_api_key(dir: &Path, key: &str) -> Result<(), SecretError> {
    validate_key(key)?;
    let path = key_path(dir);
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)?;
    // `mode` only applies on create: re-pin before the key is written.
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.write_all(key.as_bytes())?;
    Ok(())
}

/// Read the key back. `None` when the file is missing, unreadable or invalid —
/// the caller must treat that as "this account cannot spawn", never as an
/// empty key.
#[must_use]
pub fn read_api_key(dir: &Path) -> Option<ApiKey> {
    let bytes = std::fs::read(key_path(dir)).ok()?;
    let key = String::from_utf8(bytes).ok()?;
    validate_key(&key).ok()?;
    Some(ApiKey::from(key))
}
