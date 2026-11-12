//! Registry tests: file/folder modes, labels, removal/default rules,
//! forward-compatible parsing, `resolve` vs `locate`.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use serde_json::json;
use vst_accounts::{folders, normalize_label, AccountsError, AccountsHandle, LabelError};
use vst_types::{
    AccountAuth, AccountIdentity, AccountPort, AccountResolveError, AccountSummary,
    ResolvedAccount, SYSTEM_ACCOUNT_ID,
};

use common::{fixture, identity_unknown, CLI};

fn mode_of(path: &std::path::Path) -> u32 {
    std::fs::metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777
}

fn account_by_id(handle: &AccountsHandle, id: &str) -> AccountSummary {
    handle
        .list()
        .into_iter()
        .find(|a| a.id == id)
        .expect("account listed")
}

#[test]
fn registry_add_api_key_writes_0600_file() {
    let f = fixture();
    let summary = f
        .handle
        .add_api_key(CLI, "sk-test-key", "Work")
        .expect("add api-key account");
    let dir = folders::account_dir(f.handle.root(), CLI, &summary.id);
    let key_path = vst_accounts::secret::key_path(&dir);
    assert_eq!(mode_of(&key_path), 0o600, "key file must be 0600");
    assert_eq!(
        std::fs::read_to_string(&key_path).expect("read key"),
        "sk-test-key",
        "content is the key bytes with no newline"
    );
    assert_eq!(summary.method, vst_types::AccountMethod::ApiKey);
    assert_eq!(summary.display_name, "Work");
}

#[test]
fn account_dir_is_0700() {
    let f = fixture();
    let summary = f
        .handle
        .add_api_key(CLI, "sk-test-key", "Work")
        .expect("add");
    let dir = folders::account_dir(f.handle.root(), CLI, &summary.id);
    assert_eq!(mode_of(&dir), 0o700, "account folder must be 0700");
}

#[test]
fn registry_file_is_0600() {
    let f = fixture();
    f.handle
        .add_api_key(CLI, "sk-test-key", "Work")
        .expect("add");
    let path = f.handle.root().join("accounts.json");
    assert_eq!(mode_of(&path), 0o600, "registry file must be 0600");
}

#[test]
fn labels_unique_case_insensitive() {
    let f = fixture();
    f.handle.add_api_key(CLI, "key-one", "Work").expect("first");
    let second = f.handle.add_api_key(CLI, "key-two", "work");
    assert!(
        matches!(second, Err(AccountsError::LabelTaken)),
        "{second:?}"
    );
}

#[test]
fn label_rules_reject_empty_long_control() {
    assert_eq!(normalize_label("   "), Err(LabelError::Empty));
    assert_eq!(normalize_label(""), Err(LabelError::Empty));
    assert_eq!(normalize_label(&"x".repeat(41)), Err(LabelError::TooLong));
    assert_eq!(normalize_label("a\u{7}b"), Err(LabelError::Control));
    assert_eq!(normalize_label("  Work  "), Ok("Work".to_string()));
    assert_eq!(normalize_label(&"x".repeat(40)), Ok("x".repeat(40)));
}

#[test]
fn system_row_reserves_name() {
    let f = fixture();
    f.handle
        .note_identity(CLI, None, &AccountIdentity::default())
        .expect("register the System row");
    assert!(f.handle.list().iter().any(|a| a.id == SYSTEM_ACCOUNT_ID));
    let taken = f.handle.add_api_key(CLI, "key", "System login");
    assert!(matches!(taken, Err(AccountsError::LabelTaken)), "{taken:?}");
    let taken_ci = f.handle.add_api_key(CLI, "key", "system LOGIN");
    assert!(
        matches!(taken_ci, Err(AccountsError::LabelTaken)),
        "{taken_ci:?}"
    );
}

#[test]
fn system_account_cannot_be_removed() {
    let f = fixture();
    let removed = f.handle.remove(CLI, SYSTEM_ACCOUNT_ID);
    assert!(
        matches!(removed, Err(AccountsError::SystemAccount)),
        "{removed:?}"
    );
}

#[test]
fn remove_deletes_folder_and_clears_default() {
    let f = fixture();
    // Production fills the System row at boot; register it so the CLI stays
    // listed after its last named account is removed.
    f.handle
        .note_identity(CLI, None, &AccountIdentity::default())
        .expect("register the System row");
    let summary = f.handle.add_api_key(CLI, "key", "Work").expect("add");
    f.handle.set_default(CLI, &summary.id).expect("set default");
    assert_eq!(f.handle.default_for(CLI), Some(summary.id.clone()));

    f.handle.remove(CLI, &summary.id).expect("remove");
    let dir = folders::account_dir(f.handle.root(), CLI, &summary.id);
    assert!(!dir.exists(), "account folder must be gone");
    assert_eq!(
        f.handle.default_for(CLI),
        None,
        "default falls back to System"
    );
    assert!(!f.handle.list().iter().any(|a| a.id == summary.id));
    let system = f
        .handle
        .list()
        .into_iter()
        .find(|a| a.id == SYSTEM_ACCOUNT_ID);
    assert!(system.expect("System row").is_default);
}

#[test]
fn set_default_rejects_signed_out() {
    let f = fixture();
    let summary = f.handle.add_api_key(CLI, "key", "Work").expect("add");
    f.handle
        .note_auth(CLI, Some(&summary.id), AccountAuth::SignedOut)
        .expect("note auth");
    let result = f.handle.set_default(CLI, &summary.id);
    assert!(
        matches!(result, Err(AccountsError::SignedOut)),
        "{result:?}"
    );
}

#[test]
fn registry_file_roundtrip_unknown_fields_kept() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("accounts");
    std::fs::create_dir_all(&root).expect("mkdir");
    std::fs::write(
        root.join("accounts.json"),
        json!({
            "version": 1,
            "futureThing": { "nested": true },
            "accounts": [{
                "id": "acc_1a2b3c4d",
                "cli": CLI,
                "label": "Work",
                "method": "sign_in",
                "auth": "signed_in",
                "createdAt": "2026-01-01T00:00:00Z",
                "futureAccountField": "kept"
            }],
            "defaults": { CLI: "acc_1a2b3c4d" }
        })
        .to_string(),
    )
    .expect("write registry");

    let handle = AccountsHandle::new(vst_accounts::AccountsDeps {
        root: root.clone(),
        broadcaster: vst_types::Broadcaster::new(8),
        identity: identity_unknown(),
        shared_entries: Arc::new(|_cli| None),
        supports: Arc::new(|_cli| true),
    });
    assert_eq!(handle.default_for(CLI), Some("acc_1a2b3c4d".to_string()));
    assert_eq!(
        account_by_id(&handle, "acc_1a2b3c4d").label.as_deref(),
        Some("Work")
    );

    handle
        .rename(CLI, "acc_1a2b3c4d", Some("Renamed".to_string()))
        .expect("rename saves the registry");
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("accounts.json")).expect("read"))
            .expect("parse");
    assert_eq!(saved["futureThing"], json!({ "nested": true }));
    assert_eq!(saved["accounts"][0]["futureAccountField"], json!("kept"));
    assert_eq!(saved["accounts"][0]["label"], json!("Renamed"));
}

#[test]
fn resolve_signed_out_is_error() {
    let f = fixture();
    let summary = f.handle.add_api_key(CLI, "key", "Work").expect("add");
    f.handle
        .note_auth(CLI, Some(&summary.id), AccountAuth::SignedOut)
        .expect("note auth");
    assert_eq!(
        f.handle.resolve(CLI, Some(&summary.id)),
        Err(AccountResolveError::SignedOut),
        "spawn must be blocked"
    );
    assert!(
        f.handle.locate(CLI, Some(&summary.id)).is_some(),
        "locate still returns a signed-out account"
    );
}

#[test]
fn resolve_system_is_default_env_free() {
    let f = fixture();
    let resolved = f.handle.resolve(CLI, None).expect("system resolves");
    assert_eq!(resolved, ResolvedAccount::system(CLI));
    assert_eq!(resolved.id, None);
    assert_eq!(resolved.dir, None);
    assert!(resolved.api_key.is_none());
    assert_eq!(
        f.handle.resolve(CLI, Some("acc_missing")),
        Err(AccountResolveError::NotFound)
    );
}

#[test]
fn api_key_never_in_debug_or_events() {
    let f = fixture();
    let mut rx = f.broadcaster.subscribe();
    let secret = "sk-super-secret-value";
    let summary = f.handle.add_api_key(CLI, secret, "Work").expect("add");

    let mut events = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        events.push(ev);
    }
    assert!(!events.is_empty(), "the add must broadcast");
    for ev in &events {
        let json = serde_json::to_string(ev).expect("serialize event");
        assert!(!json.contains(secret), "event leaked the key: {json}");
    }
    let located = f.handle.locate(CLI, Some(&summary.id)).expect("locate");
    assert!(
        !format!("{located:?}").contains(secret),
        "Debug leaked the key"
    );
    assert!(
        located.api_key.is_some(),
        "the key must be available to spawn"
    );
}

#[tokio::test]
async fn locate_ignores_signed_out_and_pending() {
    let f = fixture();
    let summary = f.handle.add_api_key(CLI, "key", "Work").expect("add");
    f.handle
        .note_auth(CLI, Some(&summary.id), AccountAuth::SignedOut)
        .expect("note auth");
    assert!(f.handle.locate(CLI, Some(&summary.id)).is_some());

    let attempt = f
        .handle
        .begin_sign_in(CLI, "session-1", None)
        .expect("begin sign-in");
    assert!(
        f.handle.locate(CLI, Some(&attempt.account_id)).is_some(),
        "locate must see a pending account (the login needs its folder)"
    );
    assert!(f
        .handle
        .list()
        .iter()
        .any(|a| a.id == attempt.account_id && a.pending));
}

#[tokio::test]
async fn refresh_identity_never_signs_out_api_key_account() {
    let f = common::fixture_with(
        Arc::new(|_acct: ResolvedAccount| {
            Box::pin(async {
                AccountIdentity {
                    signed_in: Some(false),
                    email: None,
                    plan: None,
                }
            })
        }),
        None,
    );
    let summary = f.handle.add_api_key(CLI, "key", "Work").expect("add");
    let after = f
        .handle
        .refresh_identity(CLI, Some(&summary.id))
        .await
        .expect("refresh");
    assert_eq!(after.auth, AccountAuth::Unknown);
    assert!(f.handle.resolve(CLI, Some(&summary.id)).is_ok());
}

#[test]
fn resolve_api_key_account_without_key_file_is_error() {
    let f = fixture();
    let summary = f.handle.add_api_key(CLI, "sk-test", "Work").expect("add");
    let dir = folders::account_dir(f.handle.root(), CLI, &summary.id);
    std::fs::remove_file(vst_accounts::secret::key_path(&dir)).expect("remove key file");
    assert_eq!(
        f.handle.resolve(CLI, Some(&summary.id)),
        Err(AccountResolveError::SignedOut)
    );
    assert!(f.handle.locate(CLI, Some(&summary.id)).is_some());
}

#[test]
fn corrupt_registry_is_backed_up_before_reuse() {
    let f = fixture();
    let root = f.dir.path().join("accounts-corrupt");
    std::fs::create_dir_all(&root).expect("root");
    std::fs::write(root.join("accounts.json"), "{not json").expect("write");
    let handle = common::fixture_at(root.clone());
    handle.add_api_key(CLI, "sk-test", "Work").expect("add");
    assert_eq!(
        std::fs::read_to_string(root.join("accounts.json.corrupt")).expect("backup"),
        "{not json"
    );
}

#[test]
fn remove_broadcasts_even_when_folder_cannot_be_deleted() {
    let f = fixture();
    let mut rx = f.broadcaster.subscribe();
    let summary = f.handle.add_api_key(CLI, "sk-test", "Work").expect("add");
    let parent = f.handle.root().join(CLI);
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o500)).expect("chmod");
    let result = f.handle.remove(CLI, &summary.id);
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).expect("restore");
    result.expect("remove succeeds even if the folder stays");
    let mut removed = false;
    while let Ok(event) = rx.try_recv() {
        removed |= matches!(event, vst_types::ServerEvent::AccountRemoved { .. });
    }
    assert!(removed, "AccountRemoved must be broadcast");
    assert!(f.handle.list().iter().all(|a| a.id != summary.id));
}

#[test]
fn add_api_key_trims_the_key() {
    let f = fixture();
    let summary = f
        .handle
        .add_api_key(CLI, "  sk-test\n", "Work")
        .expect("add");
    let located = f.handle.locate(CLI, Some(&summary.id)).expect("located");
    assert_eq!(located.api_key.expect("key").expose(), "sk-test");
}

#[test]
fn add_api_key_same_label_from_two_threads_only_one_wins() {
    let f = fixture();
    let handle = Arc::new(f.handle.clone());
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let h = Arc::clone(&handle);
            std::thread::spawn(move || h.add_api_key(CLI, "k", "Same"))
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|t| t.join().expect("join"))
        .collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(results
        .iter()
        .filter(|r| r.is_err())
        .all(|r| matches!(r, Err(AccountsError::LabelTaken))));
    // Only the winner's folder (and its sibling key file) may remain.
    let dirs = std::fs::read_dir(handle.root().join(CLI))
        .expect("dir")
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .count();
    assert_eq!(dirs, 1);
}

#[tokio::test]
async fn set_default_rejects_pending_and_unsupported() {
    let f = fixture();
    let a = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    assert!(matches!(
        f.handle.set_default(CLI, &a.account_id),
        Err(AccountsError::NotFound)
    ));
    let off = AccountsHandle::new(vst_accounts::AccountsDeps {
        root: f.dir.path().join("off"),
        broadcaster: vst_types::Broadcaster::new(8),
        identity: identity_unknown(),
        shared_entries: Arc::new(|_cli| None),
        supports: Arc::new(|_cli| false),
    });
    assert!(matches!(
        off.set_default("nope", "x"),
        Err(AccountsError::Unsupported)
    ));
}

#[test]
fn rename_system_row_of_unsupported_cli_is_rejected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("accounts");
    let off = AccountsHandle::new(vst_accounts::AccountsDeps {
        root: root.clone(),
        broadcaster: vst_types::Broadcaster::new(8),
        identity: identity_unknown(),
        shared_entries: Arc::new(|_cli| None),
        supports: Arc::new(|_cli| false),
    });
    let res = off.rename("nope", SYSTEM_ACCOUNT_ID, Some("Mine".to_string()));
    assert!(matches!(res, Err(AccountsError::Unsupported)));
    let file = root.join("accounts.json");
    let text = std::fs::read_to_string(file).unwrap_or_default();
    assert!(!text.contains("systemLabels") || !text.contains("Mine"));
}

#[tokio::test]
async fn summary_returns_system_named_and_hides_pending() {
    let f = fixture();
    let pending = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    assert!(f.handle.summary(CLI, None).is_some(), "System row");
    assert!(
        f.handle
            .summary(CLI, Some(&pending.account_id))
            .is_some_and(|a| a.pending),
        "a pending sign-in is visible, flagged pending"
    );
    let named = f.handle.add_api_key(CLI, "sk-test", "Work").expect("add");
    assert_eq!(
        f.handle
            .summary(CLI, Some(&named.id))
            .map(|a| a.display_name),
        Some("Work".to_string())
    );
    assert!(f.handle.summary(CLI, Some("missing")).is_none());
}

// --- Folder accounts: legacy migration, guarded removal, pending sweep -------

/// Write a registry file holding `accounts` (the on-disk shape, camelCase).
fn write_registry(root: &std::path::Path, accounts: &serde_json::Value) {
    std::fs::create_dir_all(root).expect("root");
    let body = json!({ "version": 1, "accounts": accounts, "defaults": {}, "systemLabels": {} });
    std::fs::write(root.join("accounts.json"), body.to_string()).expect("write registry");
}

/// One persisted record; `dir`/`created` are omitted when `None` (legacy shape).
fn record_json(
    id: &str,
    method: &str,
    dir: Option<&std::path::Path>,
    created: Option<bool>,
    pending: bool,
) -> serde_json::Value {
    let mut r = json!({
        "id": id, "cli": CLI, "label": id, "method": method, "auth": "unknown",
        "pending": pending, "createdAt": "2026-01-01T00:00:00.000Z",
    });
    if let Some(d) = dir {
        r["dir"] = json!(d.to_string_lossy());
    }
    if let Some(c) = created {
        r["createdByUs"] = json!(c);
    }
    r
}

#[test]
fn legacy_record_gets_dir_and_created_by_us() {
    let root = tempfile::tempdir().expect("tempdir");
    let accounts = root.path().join("accounts");
    write_registry(
        &accounts,
        &json!([record_json("acc_legacy01", "api_key", None, None, false)]),
    );
    let folder = folders::account_dir(&accounts, CLI, "acc_legacy01");
    std::fs::create_dir_all(&folder).expect("legacy folder");
    let handle = common::fixture_at(accounts.clone());
    let located = handle.locate(CLI, Some("acc_legacy01")).expect("located");
    assert_eq!(located.dir.as_deref(), Some(folder.as_path()));
    assert!(
        handle.remove(CLI, "acc_legacy01").expect("remove"),
        "created by us => deleted"
    );
    assert!(!folder.exists());
}

#[test]
fn record_with_dir_without_flag_is_not_created_by_us() {
    let root = tempfile::tempdir().expect("tempdir");
    let accounts = root.path().join("accounts");
    let chosen = accounts.join(CLI).join("chosen");
    std::fs::create_dir_all(&chosen).expect("chosen");
    write_registry(
        &accounts,
        &json!([record_json(
            "acc_chosen1",
            "sign_in",
            Some(&chosen),
            None,
            false
        )]),
    );
    let handle = common::fixture_at(accounts.clone());
    assert!(!handle.remove(CLI, "acc_chosen1").expect("remove"));
    assert!(chosen.exists(), "a chosen folder is never deleted");
}

#[test]
fn legacy_key_file_is_moved_on_load() {
    let root = tempfile::tempdir().expect("tempdir");
    let accounts = root.path().join("accounts");
    let dir = folders::account_dir(&accounts, CLI, "acc_key1");
    std::fs::create_dir_all(&dir).expect("dir");
    std::fs::write(dir.join(".vst-api-key"), "sk-legacy").expect("legacy key");
    write_registry(
        &accounts,
        &json!([record_json("acc_key1", "api_key", None, None, false)]),
    );
    let handle = common::fixture_at(accounts.clone());
    let key = handle.locate(CLI, Some("acc_key1")).and_then(|r| r.api_key);
    assert_eq!(
        key.as_ref().map(vst_types::ApiKey::expose),
        Some("sk-legacy")
    );
    let moved = vst_accounts::secret::key_path(&dir);
    assert_eq!(mode_of(&moved), 0o600, "moved key is 0600");
    assert!(!dir.join(".vst-api-key").exists(), "the old file is gone");
}

#[test]
fn remove_created_deletes_folder_and_reports_true() {
    let f = fixture();
    let summary = f.handle.add_api_key(CLI, "sk-one", "Made").expect("add");
    let dir = folders::account_dir(f.handle.root(), CLI, &summary.id);
    assert!(f.handle.remove(CLI, &summary.id).expect("remove"));
    assert!(!dir.exists());
}

#[test]
fn remove_api_key_account_deletes_key_file() {
    let f = fixture();
    let summary = f.handle.add_api_key(CLI, "sk-two", "Keyed").expect("add");
    let key =
        vst_accounts::secret::key_path(&folders::account_dir(f.handle.root(), CLI, &summary.id));
    assert!(key.exists());
    f.handle.remove(CLI, &summary.id).expect("remove");
    assert!(!key.exists(), "the key file goes with the account");
}

#[test]
fn remove_chosen_leaves_folder_and_reports_false() {
    let root = tempfile::tempdir().expect("tempdir");
    let accounts = root.path().join("accounts");
    let chosen = root.path().join("my-claude");
    std::fs::create_dir_all(&chosen).expect("chosen");
    write_registry(
        &accounts,
        &json!([record_json(
            "acc_mine01",
            "sign_in",
            Some(&chosen),
            Some(false),
            false
        )]),
    );
    let handle = common::fixture_at(accounts);
    assert!(!handle.remove(CLI, "acc_mine01").expect("remove"));
    assert!(chosen.exists());
}

#[test]
fn remove_tampered_dir_outside_root_deletes_nothing() {
    let root = tempfile::tempdir().expect("tempdir");
    let accounts = root.path().join("accounts");
    let victim = root.path().join("victim");
    std::fs::create_dir_all(&victim).expect("victim");
    std::fs::write(victim.join("keep.txt"), "x").expect("keep");
    write_registry(
        &accounts,
        &json!([record_json(
            "acc_evil01",
            "sign_in",
            Some(&victim),
            Some(true),
            false
        )]),
    );
    let handle = common::fixture_at(accounts);
    assert!(!handle.remove(CLI, "acc_evil01").expect("remove"));
    assert!(
        victim.join("keep.txt").exists(),
        "nothing outside the root is deleted"
    );
}

#[test]
fn remove_tampered_dir_deletes_no_key_file() {
    let root = tempfile::tempdir().expect("tempdir");
    let accounts = root.path().join("accounts");
    let victim = root.path().join("victim-key");
    std::fs::create_dir_all(&victim).expect("victim");
    let key = vst_accounts::secret::key_path(&victim);
    std::fs::write(&key, "sk-keep").expect("key");
    write_registry(
        &accounts,
        &json!([record_json(
            "acc_evil02",
            "api_key",
            Some(&victim),
            Some(true),
            false
        )]),
    );
    let handle = common::fixture_at(accounts);
    assert!(!handle.remove(CLI, "acc_evil02").expect("remove"));
    assert!(
        victim.exists() && key.exists(),
        "both survive a tampered dir"
    );
}

#[test]
fn sweep_pending_deletes_only_created_folders() {
    let root = tempfile::tempdir().expect("tempdir");
    let accounts = root.path().join("accounts");
    let ours = folders::account_dir(&accounts, CLI, "acc_pend1");
    let chosen = root.path().join("chosen-pending");
    std::fs::create_dir_all(&ours).expect("ours");
    std::fs::create_dir_all(&chosen).expect("chosen");
    write_registry(
        &accounts,
        &json!([
            record_json("acc_pend1", "sign_in", Some(&ours), Some(true), true),
            record_json("acc_pend2", "sign_in", Some(&chosen), Some(false), true),
        ]),
    );
    let handle = common::fixture_at(accounts);
    let mut swept = handle.sweep_pending_on_boot().expect("sweep");
    swept.sort();
    assert_eq!(
        swept,
        vec!["acc_pend1".to_string(), "acc_pend2".to_string()]
    );
    assert!(!ours.exists(), "our pending folder is removed");
    assert!(chosen.exists(), "a chosen pending folder is kept");
}

#[tokio::test]
async fn list_includes_pending_but_resolve_refuses() {
    let f = fixture();
    let pending = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    assert!(f
        .handle
        .list()
        .iter()
        .any(|a| a.id == pending.account_id && a.pending));
    assert_eq!(
        f.handle.resolve(CLI, Some(&pending.account_id)),
        Err(AccountResolveError::Pending)
    );
}

#[test]
fn display_name_falls_back_to_folder_name_then_id() {
    let root = tempfile::tempdir().expect("tempdir");
    let accounts = root.path().join("accounts");
    let chosen = root.path().join(".x-work");
    std::fs::create_dir_all(&chosen).expect("chosen");
    let rec =
        |id: &str, label: Option<&str>, email: Option<&str>, dir: Option<&std::path::Path>| {
            let mut r = record_json(id, "sign_in", dir, Some(false), false);
            r["label"] = json!(label);
            r["email"] = json!(email);
            r
        };
    write_registry(
        &accounts,
        &json!([
            rec("acc_nolabel1", None, None, Some(&chosen)),
            rec("acc_labeled1", Some("Mine"), Some("a@b.c"), Some(&chosen)),
            rec("acc_emailed1", None, Some("a@b.c"), Some(&chosen)),
            rec("acc_legacy01", None, None, None),
        ]),
    );
    let handle = common::fixture_at(accounts);
    let name = |id: &str| account_by_id(&handle, id).display_name;
    assert_eq!(name("acc_nolabel1"), ".x-work");
    assert_eq!(name("acc_labeled1"), "Mine");
    assert_eq!(name("acc_emailed1"), "a@b.c");
    assert_eq!(name("acc_legacy01"), "acc_legacy01");
}
