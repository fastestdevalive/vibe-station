//! Bringing a registry record written before folder accounts up to the
//! current shape (legacy `dir`, legacy API-key file location).

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use vst_types::{AccountMethod, AccountRecord};

use crate::{folders, secret};

/// Mode of the API-key file.
const FILE_MODE: u32 = 0o600;
/// The API-key file name used before keys moved beside their folder.
const LEGACY_KEY_FILE: &str = ".vst-api-key";

/// Bring a record written before folder accounts up to the current shape:
/// a missing `dir` becomes `<root>/<cli>/<id>` and the folder counts as ours;
/// an API-key file is moved beside its folder (Decision 6). Best effort.
pub(crate) fn migrate_record(root: &Path, record: &mut AccountRecord) {
    if record.dir.is_none() {
        record.dir = Some(
            folders::account_dir(root, &record.cli, &record.id)
                .to_string_lossy()
                .into_owned(),
        );
        record.created_by_us = true;
    }
    if record.method == AccountMethod::ApiKey {
        if let Some(dir) = record.dir.as_deref() {
            move_legacy_key(Path::new(dir));
        }
    }
}

/// Move `<dir>/.vst-api-key` to `<dir>.key` (mode 0600) when the new file is absent.
fn move_legacy_key(dir: &Path) {
    let legacy = dir.join(LEGACY_KEY_FILE);
    let key = secret::key_path(dir);
    if !legacy.exists() || key.exists() {
        return;
    }
    let moved = fs::rename(&legacy, &key)
        .and_then(|()| fs::set_permissions(&key, fs::Permissions::from_mode(FILE_MODE)));
    if let Err(e) = moved {
        tracing::warn!(dir = %dir.display(), "could not move a legacy API-key file: {e}");
    }
}
