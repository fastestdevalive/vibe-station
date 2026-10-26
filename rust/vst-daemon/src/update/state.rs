//! `~/.vibe-station/update-state.json` store.
//!
//! Owned by the daemon (`UpdateService`); the CLI fallback writes under
//! `.update.lock` (one writer at a time). Mutations use atomic tmp+rename, 0600.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// Same serde shapes as the wire types, so update-state.json is unchanged.
use vst_types::rest::update::UpdateError;
pub use vst_types::rest::update::{RestartKind, RolledBack};

/// The latest release we've seen (rebuilds the snapshot after a 304).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestSeen {
    pub version: String,
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub html_url: String,
    pub behind_count: u32,
    pub assets: Vec<SeenAsset>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

/// A release asset as the installer sees it (name, download URL, size).
pub type AssetRef = SeenAsset;

/// A pending restart (kept so the next boot knows a binary was replaced).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestart {
    pub version: String,
    pub exe_path: String,
    pub kind: RestartKind,
}

/// Persisted update state (`update-state.json`).
///
/// Read by OLDER binaries after a rollback: a field this version cannot parse
/// (e.g. an enum value a newer build added) is dropped, never the whole file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_error: Option<UpdateError>,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub latest_seen: Option<LatestSeen>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient_or_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub skipped_versions: Vec<String>,
    #[serde(default = "default_true", deserialize_with = "lenient_auto_check")]
    pub auto_check: bool,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub pending_restart: Option<PendingRestart>,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub rolled_back: Option<RolledBack>,
}

fn default_true() -> bool {
    true
}

/// Field-level tolerant parse: a value this binary cannot read becomes `None`.
fn lenient<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where
    T: serde::de::DeserializeOwned,
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    Ok(match serde_json::from_value::<Option<T>>(v) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(err = %e, "update state: dropping an unreadable field");
            None
        }
    })
}

fn lenient_or_default<'de, T, D>(d: D) -> Result<T, D::Error>
where
    T: serde::de::DeserializeOwned + Default,
    D: serde::Deserializer<'de>,
{
    Ok(lenient::<T, D>(d)?.unwrap_or_default())
}

fn lenient_auto_check<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(lenient::<bool, D>(d)?.unwrap_or(true))
}

impl Default for StateFile {
    fn default() -> Self {
        StateFile {
            last_checked: None,
            last_error: None,
            latest_seen: None,
            etag: None,
            skipped_versions: Vec::new(),
            auto_check: true,
            pending_restart: None,
            rolled_back: None,
        }
    }
}

/// The on-disk store handle.
#[derive(Clone, Debug)]
pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    /// Load the state file, falling back to defaults on any error.
    ///
    /// A corrupt (unparseable) file is rewritten with defaults and logged —
    /// never fatal.
    pub fn load_or_default(path: PathBuf) -> (StateStore, StateFile) {
        let store = StateStore { path };
        let state = match std::fs::read(&store.path) {
            Ok(bytes) => match serde_json::from_slice::<StateFile>(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(path = %store.path.display(), err = %e, "corrupt update state; rewriting defaults");
                    let defaults = StateFile::default();
                    let _ = store.save(&defaults);
                    defaults
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => StateFile::default(),
            Err(e) => {
                tracing::warn!(path = %store.path.display(), err = %e, "failed to read update state; using defaults");
                StateFile::default()
            }
        };
        (store, state)
    }

    /// Directory holding the state file (the vst home).
    pub fn dir(&self) -> &Path {
        self.path.parent().unwrap_or_else(|| Path::new("."))
    }

    /// Write a unique `<path>.<pid>.<n>.tmp` (mode 0600) then atomically rename over the real
    /// file.
    pub fn save(&self, s: &StateFile) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Unique per writer (pid + counter) so concurrent saves, from threads
        // or from the daemon and the CLI fallback, never share a tmp file.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let tmp = self.path.with_extension(format!(
            "json.{}.{}.tmp",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let json = serde_json::to_vec_pretty(s).map_err(io::Error::other)?;
        write_mode_0600(&tmp, &json)?;
        std::fs::rename(&tmp, &self.path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }
}

fn write_mode_0600(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true).mode(0o600);
    let mut f = opts.open(path)?;
    std::io::Write::write_all(&mut f, bytes)?;
    f.sync_all()
}

/// Effective auto-check, honouring the `VST_UPDATE_CHECK=0` env override
/// (never persisted). Tests pass a closure so process env is never mutated.
pub fn auto_check_effective(s: &StateFile, env: &dyn Fn(&str) -> Option<String>) -> bool {
    match env("VST_UPDATE_CHECK") {
        Some(v) if v.trim() == "0" => false,
        _ => s.auto_check,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn future_enum_value_drops_only_that_field() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-state.json");
        std::fs::write(
            &path,
            r#"{"skippedVersions":["9.9.9"],"autoCheck":false,"lastError":{"kind":"install","reason":"some_future_reason","message":"x"}}"#,
        )
        .unwrap();
        let (_store, state) = StateStore::load_or_default(path.clone());
        assert_eq!(state.skipped_versions, vec!["9.9.9".to_string()]);
        assert!(!state.auto_check);
        assert!(state.last_error.is_none());
        // Not treated as corruption: the file was not rewritten with defaults.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("some_future_reason"));
    }

    #[test]
    fn corrupt_file_defaults_and_rewrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-state.json");
        std::fs::write(&path, "{ not valid json !!").unwrap();
        let (_store, state) = StateStore::load_or_default(path.clone());
        assert!(state.last_checked.is_none());
        assert!(state.auto_check);
        // file rewritten as valid JSON, mode 0600
        let bytes = std::fs::read(&path).unwrap();
        let parsed: StateFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed, StateFile::default());
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn save_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-state.json");
        let (store, mut state) = StateStore::load_or_default(path.clone());
        state.last_checked = Some("2026-10-07T00:00:00Z".into());
        state.auto_check = false;
        store.save(&state).unwrap();
        let (_store2, state2) = StateStore::load_or_default(path);
        assert_eq!(state2.last_checked.as_deref(), Some("2026-10-07T00:00:00Z"));
        assert!(!state2.auto_check);
    }

    #[test]
    fn concurrent_saves_never_corrupt_the_file_d16() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-state.json");
        let (store, _) = StateStore::load_or_default(path.clone());
        let handles: Vec<_> = (0..2)
            .map(|t| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for i in 0..1000 {
                        let mut s = StateFile::default();
                        s.last_checked = Some(format!("writer-{t}-{i}"));
                        s.skipped_versions = vec!["9.9.9".repeat(50)];
                        store.save(&s).unwrap();
                    }
                })
            })
            .collect();
        let reader = {
            let path = path.clone();
            std::thread::spawn(move || {
                for _ in 0..500 {
                    if let Ok(b) = std::fs::read(&path) {
                        serde_json::from_slice::<StateFile>(&b).expect("torn state file");
                    }
                }
            })
        };
        for h in handles {
            h.join().unwrap();
        }
        reader.join().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        serde_json::from_slice::<StateFile>(&bytes).unwrap();
        // no tmp litter
        let litter = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(litter, 0);
    }

    #[test]
    fn auto_check_env_override_not_persisted() {
        let s = StateFile::default(); // auto_check = true
        let env = |k: &str| {
            if k == "VST_UPDATE_CHECK" {
                Some("0".into())
            } else {
                None
            }
        };
        assert!(!auto_check_effective(&s, &env));
        // file field itself is untouched
        assert!(s.auto_check);
        let env_none = |_: &str| None;
        assert!(auto_check_effective(&s, &env_none));
    }
}
