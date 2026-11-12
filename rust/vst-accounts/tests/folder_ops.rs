//! Folder-account tests (`folder_ops`): validation, add as pending, confirm,
//! the background refresh rule, duplicate identity and the in-flight guard.
//! Fake `FolderDeps` (generic CLI id) and fake identity closures only.

mod common;
#[path = "folder_ops/helpers.rs"]
mod helpers;

use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use helpers::{
    choose, drain, folder, fx, fx_looks, gated, snapshot, toggled, updated_for, SIGNIN_COMMAND,
};
use tokio::sync::Notify;
use vst_accounts::paths::PathRefusal;
use vst_accounts::{AccountsDeps, AccountsError, AccountsHandle, FolderSpec, IdentityFn};
use vst_types::{
    AccountIdentity, AccountPort, AccountResolveError, AccountSummary, Broadcaster,
    ResolvedAccount, SharedEntries, SharedSet, SYSTEM_ACCOUNT_ID,
};

use common::{identity_named_only, identity_unknown, CLI};

#[tokio::test]
async fn add_choose_signed_in_is_added_at_once_and_folder_untouched() {
    let mut f = fx(identity_named_only("work@example.com"), true, None);
    let chosen = folder(&f.home, ".fakecli-work");
    let before = snapshot(&chosen);
    let summary = f
        .handle
        .add_folder(CLI, choose(&chosen), Some("Work"))
        .await
        .expect("add");
    assert!(!summary.pending, "a signed-in folder is added at once");
    assert!(!summary.created_by_us, "a chosen folder is never ours");
    assert_eq!(
        snapshot(&chosen),
        before,
        "listing and mtimes are unchanged"
    );
    let symlinks = std::fs::read_dir(&chosen)
        .expect("read")
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_symlink()))
        .count();
    assert_eq!(symlinks, 0, "no shared links are made into a chosen folder");
    assert_eq!(updated_for(&drain(&mut f.events), &summary.id), 1);
}

/// An identity closure that counts the calls made for named accounts.
fn counting(calls: Arc<AtomicUsize>) -> IdentityFn {
    Arc::new(move |acct: ResolvedAccount| {
        if acct.id.is_none() {
            return Box::pin(async { AccountIdentity::default() });
        }
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(true),
                email: Some("probe@example.com".to_string()),
                plan: None,
            }
        })
    })
}

#[tokio::test]
async fn add_choose_not_looking_valid_skips_identity_and_is_pending() {
    let calls = Arc::new(AtomicUsize::new(0));
    let f = fx_looks(counting(calls.clone()), true, None, false);
    let chosen = folder(&f.home, "sessions");
    let before = snapshot(&chosen);
    let summary = f
        .handle
        .add_folder(CLI, choose(&chosen), None)
        .await
        .expect("add");
    assert!(summary.pending, "added straight as pending");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no identity command ran");
    assert_eq!(snapshot(&chosen), before, "folder listing unchanged");
}

#[tokio::test]
async fn add_choose_empty_folder_is_pending_and_never_probed() {
    let calls = Arc::new(AtomicUsize::new(0));
    // Even a plugin that says "looks valid" cannot make an empty folder probe.
    let f = fx_looks(counting(calls.clone()), true, None, true);
    let empty = f.home.join("empty-login");
    std::fs::create_dir_all(&empty).expect("mkdir");
    let summary = f
        .handle
        .add_folder(CLI, choose(&empty), None)
        .await
        .expect("add");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "an empty folder is not probed"
    );
    assert!(summary.pending);
    assert_eq!(
        std::fs::read_dir(&empty).expect("read").count(),
        0,
        "nothing was written into the chosen folder"
    );
}

#[tokio::test]
async fn add_choose_non_empty_looking_valid_folder_probes_once() {
    let calls = Arc::new(AtomicUsize::new(0));
    let f = fx_looks(counting(calls.clone()), true, None, true);
    let chosen = folder(&f.home, ".fakecli-login");
    let summary = f
        .handle
        .add_folder(CLI, choose(&chosen), None)
        .await
        .expect("add");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!summary.pending);
}

#[tokio::test]
async fn add_choose_not_signed_in_is_pending_with_steps() {
    let f = fx(identity_unknown(), true, None);
    let chosen = folder(&f.home, ".fakecli-work");
    let summary = f
        .handle
        .add_folder(CLI, choose(&chosen), None)
        .await
        .expect("add");
    assert!(summary.pending);
    let steps = summary.sign_in.expect("sign-in steps while pending");
    assert_eq!(steps.command.as_deref(), Some(SIGNIN_COMMAND));
    assert_eq!(
        f.handle.resolve(CLI, Some(&summary.id)),
        Err(AccountResolveError::Pending),
        "a pending row cannot be spawned"
    );
}

#[tokio::test]
async fn add_create_makes_folder_links_shared_entries_0700() {
    let source = tempfile::tempdir().expect("source");
    let system = source.path().join("system");
    std::fs::create_dir_all(system.join("skills")).expect("skills");
    std::fs::write(system.join("settings.json"), "{}").expect("settings");
    let shared = SharedEntries {
        source_dir: system,
        set: SharedSet::Named(vec!["skills", "settings.json"]),
    };
    let f = fx(identity_named_only("made@example.com"), true, Some(shared));
    let summary = f
        .handle
        .add_folder(CLI, FolderSpec::Create, None)
        .await
        .expect("add");
    assert!(summary.created_by_us);
    let dir = f.handle.root().join(CLI).join(&summary.id);
    let mode = std::fs::metadata(&dir).expect("dir").permissions().mode() & 0o777;
    assert_eq!(mode, 0o700, "a managed folder is 0700");
    for name in ["skills", "settings.json"] {
        let link = std::fs::symlink_metadata(dir.join(name)).expect("linked");
        assert!(link.file_type().is_symlink(), "{name} is a shared link");
    }
}

#[tokio::test]
async fn add_create_label_names_folder() {
    let f = fx(identity_unknown(), true, None);
    let summary = f
        .handle
        .add_folder(CLI, FolderSpec::Create, Some("My Work"))
        .await
        .expect("add");
    assert_eq!(summary.display_name, "My Work");
    assert!(
        f.handle.root().join(CLI).join("my-work").is_dir(),
        "the folder is named after the label's slug"
    );
}

#[tokio::test]
async fn add_create_failure_adds_nothing() {
    let f = fx(identity_unknown(), true, None);
    let root = f.handle.root().to_path_buf();
    std::fs::create_dir_all(&root).expect("root");
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o500)).expect("chmod");
    if std::fs::write(root.join("probe"), b"x").is_ok() {
        // Running as root: a read-only directory is still writable, so skip.
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        return;
    }
    let res = f.handle.add_folder(CLI, FolderSpec::Create, None).await;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).expect("restore");
    assert!(matches!(res, Err(AccountsError::FolderCreate)));
    assert!(
        f.handle.list().iter().all(|a| a.id == SYSTEM_ACCOUNT_ID),
        "nothing was added"
    );
}

#[tokio::test]
async fn confirm_pending_signed_in_unpends_and_broadcasts_once() {
    let signed = Arc::new(AtomicBool::new(false));
    let mut f = fx(toggled(signed.clone(), "confirm@example.com"), true, None);
    let chosen = folder(&f.home, ".fakecli-confirm");
    let pending = f
        .handle
        .add_folder(CLI, choose(&chosen), None)
        .await
        .expect("add");
    assert!(pending.pending);
    signed.store(true, Ordering::SeqCst);
    drain(&mut f.events);
    let done = f
        .handle
        .confirm_pending(CLI, &pending.id)
        .await
        .expect("confirm");
    assert!(!done.pending);
    assert_eq!(updated_for(&drain(&mut f.events), &pending.id), 1);
}

#[tokio::test]
async fn confirm_pending_still_signed_out_stays_pending_idempotent() {
    let signed = Arc::new(AtomicBool::new(false));
    let f = fx(toggled(signed, "later@example.com"), true, None);
    let chosen = folder(&f.home, ".fakecli-later");
    let pending = f
        .handle
        .add_folder(CLI, choose(&chosen), None)
        .await
        .expect("add");
    for _ in 0..2 {
        let still = f
            .handle
            .confirm_pending(CLI, &pending.id)
            .await
            .expect("confirm");
        assert!(still.pending, "still signed out: stays pending");
    }
    assert!(chosen.exists(), "the chosen folder is kept");
}

#[tokio::test]
async fn confirm_concurrent_second_call_returns_cached() {
    let armed = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(Notify::new());
    let gate = Arc::new(Notify::new());
    let f = fx(
        gated(armed.clone(), entered.clone(), gate.clone()),
        true,
        None,
    );
    let chosen = folder(&f.home, ".fakecli-slow");
    let pending = f
        .handle
        .add_folder(CLI, choose(&chosen), None)
        .await
        .expect("add");
    armed.store(true, Ordering::SeqCst);
    let handle = f.handle.clone();
    let id = pending.id.clone();
    let first = tokio::spawn(async move { handle.confirm_pending(CLI, &id).await });
    entered.notified().await;
    let second = f
        .handle
        .confirm_pending(CLI, &pending.id)
        .await
        .expect("second call answers at once");
    assert!(second.pending, "the second call returns the cached row");
    gate.notify_one();
    let first = first.await.expect("join").expect("first confirm");
    assert!(!first.pending);
}

#[tokio::test]
async fn background_refresh_never_unpends_unverifiable() {
    // The identity says signed in, but this CLI cannot verify it (pi, omp).
    let f = fx(identity_named_only("pi@example.com"), false, None);
    let chosen = folder(&f.home, ".fakecli-pi");
    let pending = f
        .handle
        .add_folder(CLI, choose(&chosen), None)
        .await
        .expect("add");
    assert!(pending.pending, "an unverifiable add stays pending");
    let after = f
        .handle
        .refresh_identity(CLI, Some(&pending.id))
        .await
        .expect("refresh");
    assert!(after.pending, "a background refresh never confirms it");
    let done = f
        .handle
        .confirm_pending(CLI, &pending.id)
        .await
        .expect("confirm");
    assert!(!done.pending, "the explicit confirmation finishes it");
}

#[tokio::test]
async fn background_refresh_unpends_only_on_signed_in_true() {
    let signed = Arc::new(AtomicBool::new(false));
    let f = fx(toggled(signed.clone(), "bg@example.com"), true, None);
    let chosen = folder(&f.home, ".fakecli-bg");
    let pending = f
        .handle
        .add_folder(CLI, choose(&chosen), None)
        .await
        .expect("add");
    let still: AccountSummary = f
        .handle
        .refresh_identity(CLI, Some(&pending.id))
        .await
        .expect("refresh");
    assert!(
        still.pending,
        "signed out: the background check leaves it pending"
    );
    signed.store(true, Ordering::SeqCst);
    let done = f
        .handle
        .refresh_identity(CLI, Some(&pending.id))
        .await
        .expect("refresh");
    assert!(
        !done.pending,
        "signed in (true): the background check finishes it"
    );
}

#[tokio::test]
async fn duplicate_identity_chosen_keeps_folder() {
    let f = fx(identity_named_only("dup@example.com"), true, None);
    let first = folder(&f.home, ".fakecli-first");
    f.handle
        .add_folder(CLI, choose(&first), Some("First"))
        .await
        .expect("first added");
    let second = folder(&f.home, ".fakecli-second");
    let err = f
        .handle
        .add_folder(CLI, choose(&second), Some("Second"))
        .await;
    assert!(
        matches!(&err, Err(AccountsError::DuplicateIdentity { name, folder_deleted: false, .. }) if name == "First"),
        "the existing account is named: {err:?}"
    );
    assert!(
        second.join("settings.json").exists(),
        "a chosen folder is never deleted"
    );
    assert!(!f
        .handle
        .list()
        .iter()
        .any(|a| a.label.as_deref() == Some("Second")));
}

#[tokio::test]
async fn duplicate_identity_created_deletes_only_our_folder() {
    let f = fx(identity_named_only("dup2@example.com"), true, None);
    let keep = folder(&f.home, ".fakecli-keep");
    f.handle
        .add_folder(CLI, choose(&keep), Some("Keep"))
        .await
        .expect("first added");
    let err = f
        .handle
        .add_folder(CLI, FolderSpec::Create, Some("Second"))
        .await;
    assert!(matches!(
        err,
        Err(AccountsError::DuplicateIdentity {
            folder_deleted: true,
            ..
        })
    ));
    assert!(
        !f.handle.root().join(CLI).join("second").exists(),
        "the folder we created is removed"
    );
    assert!(keep.exists(), "another account's folder is untouched");
}

#[tokio::test]
async fn duplicate_identity_matches_system_email() {
    // The System login and the new sign-in report the same email.
    let identity: IdentityFn = Arc::new(|_acct: ResolvedAccount| {
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(true),
                email: Some("sys@example.com".to_string()),
                plan: None,
            }
        })
    });
    let f = fx(identity, true, None);
    let chosen = folder(&f.home, ".fakecli-sys");
    let err = f.handle.add_folder(CLI, choose(&chosen), None).await;
    match err {
        Err(AccountsError::DuplicateIdentity { name, .. }) => {
            assert_eq!(name, "sys@example.com", "the System login is named");
        }
        other => panic!("expected a duplicate identity, got {other:?}"),
    }
}

#[tokio::test]
async fn two_concurrent_adds_same_folder_one_wins_loser_error() {
    let f = fx(identity_unknown(), true, None);
    let chosen = folder(&f.home, ".fakecli-race");
    let (a, b) = tokio::join!(
        f.handle.add_folder(CLI, choose(&chosen), None),
        f.handle.add_folder(CLI, choose(&chosen), None),
    );
    let results = [a, b];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(results
        .iter()
        .filter_map(|r| r.as_ref().err())
        .all(|e| matches!(e, AccountsError::Path(PathRefusal::Duplicate { .. }))));
}

#[tokio::test]
async fn label_taken_for_create_and_choose() {
    let f = fx(identity_unknown(), true, None);
    let first = folder(&f.home, ".fakecli-a");
    f.handle
        .add_folder(CLI, choose(&first), Some("Work"))
        .await
        .expect("first");
    let created = f
        .handle
        .add_folder(CLI, FolderSpec::Create, Some("work"))
        .await;
    assert!(matches!(created, Err(AccountsError::LabelTaken)));
    let other = folder(&f.home, ".fakecli-b");
    let chosen = f.handle.add_folder(CLI, choose(&other), Some("WORK")).await;
    assert!(matches!(chosen, Err(AccountsError::LabelTaken)));
    assert!(matches!(
        f.handle
            .validate_folder(CLI, &FolderSpec::Create, Some("work")),
        Err(AccountsError::LabelTaken)
    ));
}

#[tokio::test]
async fn without_folder_support_is_unsupported() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = AccountsHandle::new(AccountsDeps {
        root: dir.path().join("accounts"),
        broadcaster: Broadcaster::new(8),
        identity: identity_unknown(),
        shared_entries: Arc::new(|_cli| None),
        supports: Arc::new(|_cli| true),
    });
    assert!(matches!(
        handle.validate_folder(CLI, &FolderSpec::Create, None),
        Err(AccountsError::Unsupported)
    ));
    assert!(matches!(
        handle.add_folder(CLI, FolderSpec::Create, None).await,
        Err(AccountsError::Unsupported)
    ));
}

fn system_identity_with(signed_in: Option<bool>) -> IdentityFn {
    Arc::new(move |_acct: ResolvedAccount| {
        Box::pin(async move {
            AccountIdentity {
                signed_in,
                email: None,
                plan: None,
            }
        })
    })
}

#[tokio::test]
async fn signed_out_system_row_has_sign_in_steps() {
    let f = fx(system_identity_with(Some(false)), true, None);
    let summary = f.handle.refresh_identity(CLI, None).await.expect("refresh");
    assert_eq!(summary.auth, vst_types::AccountAuth::SignedOut);
    let steps = summary.sign_in.expect("signed-out System login has steps");
    assert_eq!(steps.command.as_deref(), Some(SIGNIN_COMMAND));
}

#[tokio::test]
async fn signed_in_system_row_has_none() {
    let f = fx(system_identity_with(Some(true)), true, None);
    let summary = f.handle.refresh_identity(CLI, None).await.expect("refresh");
    assert!(summary.sign_in.is_none());
    let unknown = fx(system_identity_with(None), true, None);
    let summary = unknown.handle.summary(CLI, None).expect("system row");
    assert!(summary.sign_in.is_none());
}
