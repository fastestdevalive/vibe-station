//! The registry file (`<root>/accounts.json`, 0600, atomic tmp+rename) and the
//! read side of the state: lookups, summaries and the list order.
//!
//! The persisted record holds no secrets; the System login has no record at all
//! (it is virtual, one per CLI). Its auth/email/plan live only in memory, filled
//! by the boot identity check and after each finished sign-in (Decision 12).
//! Mutations live in `ops.rs`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use vst_types::{
    AccountAuth, AccountLimited, AccountMethod, AccountRecord, AccountSummary, ResolvedAccount,
    SYSTEM_ACCOUNT_ID,
};

use crate::labels::{display_name, label_taken, LabelRow};
use crate::migrate::migrate_record;
use crate::signin::Attempt;
use crate::{folders, secret, AccountsError, FolderDeps};

/// File name of the registry inside the accounts root.
pub const REGISTRY_FILENAME: &str = "accounts.json";
/// Current registry format version.
pub const REGISTRY_VERSION: u32 = 1;
/// Mode of the accounts root and every account folder.
/// Mode of the registry file and the API-key file.
const FILE_MODE: u32 = 0o600;

/// `<vst_home>/accounts/accounts.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFile {
    #[serde(default = "registry_version")]
    pub version: u32,
    #[serde(default)]
    pub accounts: Vec<AccountRecord>,
    /// cli -> account id; absent = the System login.
    #[serde(default)]
    pub defaults: BTreeMap<String, String>,
    /// cli -> the System row's label.
    #[serde(default)]
    pub system_labels: BTreeMap<String, String>,
    /// Unknown top-level fields written by a newer build are kept on save.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn registry_version() -> u32 {
    REGISTRY_VERSION
}

impl Default for RegistryFile {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            accounts: Vec::new(),
            defaults: BTreeMap::new(),
            system_labels: BTreeMap::new(),
            extra: serde_json::Map::new(),
        }
    }
}

/// One CLI's System login, as learned from the identity command. Never persisted.
#[derive(Clone, Debug, Default)]
pub struct SystemRow {
    pub auth: AccountAuth,
    pub email: Option<String>,
    pub plan: Option<String>,
}

/// The whole in-memory registry state (one `Mutex` in `AccountsHandle`).
#[derive(Debug)]
pub struct State {
    pub registry: RegistryFile,
    pub system: BTreeMap<String, SystemRow>,
    pub limited: BTreeMap<(String, Option<String>), AccountLimited>,
    pub attempts: BTreeMap<String, Attempt>,
    pub timers: BTreeMap<String, tokio::task::JoinHandle<()>>,
    /// Folder-account support; `None` until `with_folder_support`.
    pub folder: Option<Arc<FolderDeps>>,
}

impl State {
    /// Load the registry file (migrating legacy records in memory); the
    /// in-memory halves start empty.
    #[must_use]
    pub fn load(root: &Path) -> Self {
        let mut registry = load_file(root);
        for record in &mut registry.accounts {
            migrate_record(root, record);
        }
        Self {
            registry,
            system: BTreeMap::new(),
            limited: BTreeMap::new(),
            attempts: BTreeMap::new(),
            timers: BTreeMap::new(),
            folder: None,
        }
    }
}

fn load_file(root: &Path) -> RegistryFile {
    let path = root.join(REGISTRY_FILENAME);
    let Ok(text) = fs::read_to_string(&path) else {
        return RegistryFile::default();
    };
    match serde_json::from_str(&text) {
        Ok(registry) => registry,
        Err(e) => {
            tracing::error!(path = %path.display(), "accounts registry unreadable: {e}");
            // Keep the original: the next mutation rewrites the file.
            let backup = root.join(format!("{REGISTRY_FILENAME}.corrupt"));
            if let Err(e) = fs::copy(&path, &backup) {
                tracing::error!("could not back up the unreadable accounts registry: {e}");
            }
            RegistryFile::default()
        }
    }
}

/// Atomic save: tmp file 0600, fsync, rename. Creates the root 0700.
pub(crate) fn save_file(root: &Path, registry: &RegistryFile) -> Result<(), AccountsError> {
    fs::create_dir_all(root)?;
    fs::set_permissions(root, fs::Permissions::from_mode(crate::folders::DIR_MODE))?;
    let tmp = root.join(format!(".{REGISTRY_FILENAME}.tmp"));
    let body = serde_json::to_string_pretty(registry)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(FILE_MODE)
        .open(&tmp)?;
    file.write_all(body.as_bytes())?;
    file.sync_all()?;
    fs::rename(&tmp, root.join(REGISTRY_FILENAME))?;
    Ok(())
}

/// `acc_` + 8 lowercase hex, regenerated on collision.
fn new_id(taken: impl Fn(&str) -> bool) -> String {
    for _ in 0..64 {
        let candidate = format!("acc_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        if !taken(&candidate) {
            return candidate;
        }
    }
    // 8 hex chars collided 64 times: practically impossible, so widen the id
    // rather than panic.
    format!("acc_{}", &uuid::Uuid::new_v4().simple().to_string()[..16])
}

/// A fresh account id no record uses.
pub(crate) fn new_account_id(state: &State) -> String {
    new_id(|candidate| state.registry.accounts.iter().any(|r| r.id == candidate))
}

/// A record's folder: its stored `dir`, or `<root>/<cli>/<id>` for a record
/// that has none (only possible before the load migration).
#[must_use]
pub fn record_dir(root: &Path, record: &AccountRecord) -> PathBuf {
    record.dir.as_deref().map_or_else(
        || folders::account_dir(root, &record.cli, &record.id),
        PathBuf::from,
    )
}

/// The name a record shows: label, else email, else its folder's name, else the id.
pub(crate) fn record_display_name(record: &AccountRecord) -> String {
    let fallback = record
        .dir
        .as_deref()
        .and_then(|d| Path::new(d).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| record.id.clone());
    display_name(
        record.label.as_deref(),
        record.email.as_deref(),
        &fallback,
        false,
    )
}

/// Find an account record (pending ones included — `locate` ignores `pending`).
#[must_use]
pub fn record_locked<'a>(state: &'a State, cli: &str, id: &str) -> Option<&'a AccountRecord> {
    state
        .registry
        .accounts
        .iter()
        .find(|r| r.cli == cli && r.id == id)
}

/// `None` id = the System login (no folder, no key).
#[must_use]
pub fn locate_locked(
    state: &State,
    root: &Path,
    cli: &str,
    account_id: Option<&str>,
) -> Option<ResolvedAccount> {
    let Some(id) = account_id else {
        return Some(ResolvedAccount::system(cli));
    };
    let record = record_locked(state, cli, id)?;
    let dir = record_dir(root, record);
    let api_key = (record.method == AccountMethod::ApiKey)
        .then(|| secret::read_api_key(&dir))
        .flatten();
    Some(ResolvedAccount {
        cli: cli.to_string(),
        id: Some(id.to_string()),
        dir: Some(dir),
        api_key,
    })
}

/// The System row of `cli`.
#[must_use]
pub fn system_summary(state: &State, cli: &str) -> AccountSummary {
    let row = state.system.get(cli);
    let label = state.registry.system_labels.get(cli).cloned();
    let auth = row.map_or(AccountAuth::Unknown, |r| r.auth);
    AccountSummary {
        id: SYSTEM_ACCOUNT_ID.to_string(),
        cli: cli.to_string(),
        display_name: display_name(
            label.as_deref(),
            row.and_then(|r| r.email.as_deref()),
            SYSTEM_ACCOUNT_ID,
            true,
        ),
        email: row.and_then(|r| r.email.clone()),
        plan: row.and_then(|r| r.plan.clone()),
        method: AccountMethod::System,
        auth,
        is_default: !state.registry.defaults.contains_key(cli),
        limited: state.limited.get(&(cli.to_string(), None)).cloned(),
        created_at: None,
        label,
        dir: None,
        created_by_us: false,
        pending: false,
        sign_in: system_sign_in(state, cli, auth),
    }
}

/// Sign-in steps for a signed-out System login (it has no record, so no
/// folder account path reaches it). `None` unless its identity says signed out.
fn system_sign_in(state: &State, cli: &str, auth: AccountAuth) -> Option<vst_types::SignInSteps> {
    if auth != AccountAuth::SignedOut {
        return None;
    }
    let folder = state.folder.as_deref()?;
    Some((folder.sign_in_steps)(&ResolvedAccount::system(cli)))
}

pub(crate) fn named_summary(state: &State, record: &AccountRecord) -> AccountSummary {
    let folder = state.folder.as_deref();
    AccountSummary {
        id: record.id.clone(),
        cli: record.cli.clone(),
        label: record.label.clone(),
        display_name: record_display_name(record),
        email: record.email.clone(),
        plan: record.plan.clone(),
        method: record.method,
        auth: record.auth,
        is_default: state.registry.defaults.get(&record.cli) == Some(&record.id),
        limited: state
            .limited
            .get(&(record.cli.clone(), Some(record.id.clone())))
            .cloned(),
        created_at: Some(record.created_at.clone()),
        dir: folder.and_then(|f| {
            record
                .dir
                .as_deref()
                .map(|d| vst_types::collapse_home(Path::new(d), &f.home))
        }),
        created_by_us: record.created_by_us,
        pending: record.pending,
        sign_in: folder.and_then(|f| sign_in_steps_for(f, record)),
    }
}

/// The copyable steps for a folder account that still needs a sign-in
/// (pending, or signed out, and method `sign_in`). `None` otherwise.
fn sign_in_steps_for(
    folder: &FolderDeps,
    record: &AccountRecord,
) -> Option<vst_types::SignInSteps> {
    let needs = record.method == AccountMethod::SignIn
        && (record.pending || record.auth == AccountAuth::SignedOut);
    let dir = record.dir.as_deref()?;
    needs.then(|| {
        let resolved = ResolvedAccount {
            cli: record.cli.clone(),
            id: Some(record.id.clone()),
            dir: Some(PathBuf::from(dir)),
            api_key: None,
        };
        (folder.sign_in_steps)(&resolved)
    })
}

/// One account's summary, or `None` for an unknown id.
#[must_use]
pub fn summary_locked(
    state: &State,
    cli: &str,
    account_id: Option<&str>,
) -> Option<AccountSummary> {
    match account_id {
        None => Some(system_summary(state, cli)),
        Some(id) => record_locked(state, cli, id).map(|r| named_summary(state, r)),
    }
}

/// Every CLI the registry knows about (accounts, defaults, labels or identity).
fn known_clis(state: &State) -> BTreeSet<String> {
    let mut clis: BTreeSet<String> = state
        .registry
        .accounts
        .iter()
        .map(|r| r.cli.clone())
        .collect();
    clis.extend(state.registry.defaults.keys().cloned());
    clis.extend(state.registry.system_labels.keys().cloned());
    clis.extend(state.system.keys().cloned());
    clis
}

/// System row first per CLI, then that CLI's accounts by `created_at`.
#[must_use]
pub fn list_locked(state: &State, supports: &crate::SupportsFn) -> Vec<AccountSummary> {
    let mut out = Vec::new();
    for cli in known_clis(state) {
        if !supports(&cli) {
            continue;
        }
        out.push(system_summary(state, &cli));
        let mut records: Vec<&AccountRecord> = state
            .registry
            .accounts
            .iter()
            .filter(|r| r.cli == cli)
            .collect();
        records.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        out.extend(records.into_iter().map(|r| named_summary(state, r)));
    }
    out
}

/// `(cli, id, effective name)` for every row, for the uniqueness check.
fn label_rows(state: &State) -> Vec<(String, String, String)> {
    let mut rows: Vec<(String, String, String)> = state
        .registry
        .accounts
        .iter()
        .map(|r| (r.cli.clone(), r.id.clone(), record_display_name(r)))
        .collect();
    for cli in known_clis(state) {
        let label = state.registry.system_labels.get(&cli).cloned();
        let email = state.system.get(&cli).and_then(|r| r.email.clone());
        rows.push((
            cli,
            SYSTEM_ACCOUNT_ID.to_string(),
            display_name(label.as_deref(), email.as_deref(), SYSTEM_ACCOUNT_ID, true),
        ));
    }
    rows
}

/// Whether `label` collides with another row of `cli` (System row included).
pub(crate) fn taken_in(state: &State, cli: &str, label: &str, except_id: Option<&str>) -> bool {
    let rows = label_rows(state);
    let refs: Vec<LabelRow<'_>> = rows
        .iter()
        .map(|(c, i, n)| (c.as_str(), i.as_str(), n.as_str()))
        .collect();
    label_taken(&refs, cli, label, except_id)
}
