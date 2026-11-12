//! Sign-in tests: duplicate detection (named + System identity), pending sweep
//! on boot and the 15-minute expiry.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use vst_accounts::signin::SIGNIN_TTL_SECS;
use vst_accounts::{folders, AccountsError, IdentityFn};
use vst_types::{AccountIdentity, ResolvedAccount, SignInState};

use common::{fixture, fixture_with, identity_named_only, identity_with, CLI};

/// Identity per account kind: named accounts always report `email`; the System
/// row reports "unknown" on its first call and `email` afterwards (the
/// production case where the boot check failed and a later finish re-asks).
fn identity_system_late(email: &'static str) -> IdentityFn {
    let system_calls = Arc::new(AtomicUsize::new(0));
    Arc::new(move |acct: ResolvedAccount| {
        let email = email.to_string();
        if acct.id.is_some() {
            let fut: vst_accounts::IdentityFuture = Box::pin(async move {
                AccountIdentity {
                    signed_in: Some(true),
                    email: Some(email),
                    plan: None,
                }
            });
            return fut;
        }
        let call = system_calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            Box::pin(async { AccountIdentity::default() })
        } else {
            Box::pin(async move {
                AccountIdentity {
                    signed_in: Some(true),
                    email: Some(email),
                    plan: None,
                }
            })
        }
    })
}

#[tokio::test]
async fn duplicate_email_rejected() {
    let named = fixture_with(identity_named_only("dup@example.com"), None);
    // The first account is added normally.
    let first = named.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    assert_eq!(
        named
            .handle
            .on_login_exited(&first.attempt_id)
            .await
            .expect("exit"),
        SignInState::Done
    );
    named
        .handle
        .finish_sign_in(&first.attempt_id, Some("First"))
        .await
        .expect("finish");

    // A second sign-in reports the same email: the exit path rejects it and
    // removes the half-made folder.
    let second = named.handle.begin_sign_in(CLI, "s2", None).expect("begin");
    let second_dir = folders::account_dir(named.handle.root(), CLI, &second.account_id);
    assert_eq!(
        named
            .handle
            .on_login_exited(&second.attempt_id)
            .await
            .expect("exit"),
        SignInState::Duplicate
    );
    assert!(!second_dir.exists(), "a duplicate's folder must be removed");
    assert!(!named
        .handle
        .list()
        .iter()
        .any(|x| x.id == second.account_id));
    assert!(matches!(
        named.handle.finish_sign_in(&second.attempt_id, None).await,
        Err(AccountsError::AttemptNotDone)
    ));

    // The exit reported its own email, then ANOTHER account's email changed to
    // the same one (a refresh); `finish_sign_in` must reject the duplicate.
    let calls = Arc::new(AtomicUsize::new(0));
    let emails = ["other@example.com", "late@example.com"];
    let sequence: IdentityFn = Arc::new(move |acct: ResolvedAccount| {
        if acct.id.is_none() {
            return Box::pin(async { AccountIdentity::default() });
        }
        let idx = calls.fetch_add(1, Ordering::SeqCst).min(emails.len() - 1);
        let email = emails[idx].to_string();
        Box::pin(async move {
            AccountIdentity {
                signed_in: Some(true),
                email: Some(email),
                plan: None,
            }
        })
    });
    let refreshed = fixture_with(sequence, None);
    let existing = refreshed
        .handle
        .begin_sign_in(CLI, "s3", None)
        .expect("begin");
    refreshed
        .handle
        .on_login_exited(&existing.attempt_id)
        .await
        .expect("exit");
    refreshed
        .handle
        .finish_sign_in(&existing.attempt_id, Some("Existing"))
        .await
        .expect("finish");
    let pending = refreshed
        .handle
        .begin_sign_in(CLI, "s4", None)
        .expect("begin");
    refreshed
        .handle
        .on_login_exited(&pending.attempt_id)
        .await
        .expect("exit");
    // The existing account's identity now reports the pending one's email (the
    // same login twice).
    refreshed
        .handle
        .note_identity(
            CLI,
            Some(&existing.account_id),
            &AccountIdentity {
                signed_in: Some(true),
                email: Some("late@example.com".to_string()),
                plan: None,
            },
        )
        .expect("refresh the existing account");
    let pending_dir = folders::account_dir(refreshed.handle.root(), CLI, &pending.account_id);
    assert!(matches!(
        refreshed
            .handle
            .finish_sign_in(&pending.attempt_id, Some("Pending"))
            .await,
        Err(AccountsError::Duplicate)
    ));
    assert!(
        !pending_dir.exists(),
        "a duplicate's folder must be removed"
    );
    assert!(!refreshed
        .handle
        .list()
        .iter()
        .any(|x| x.id == pending.account_id));
}

#[tokio::test]
async fn duplicate_checks_system_identity() {
    // Case 1: the System email is already known (production fills it at boot).
    let f = fixture_with(identity_with(Some("sys@example.com")), None);
    f.handle
        .note_identity(
            CLI,
            None,
            &AccountIdentity {
                signed_in: Some(true),
                email: Some("sys@example.com".to_string()),
                plan: None,
            },
        )
        .expect("cache the System identity");
    let a = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    assert_eq!(
        f.handle.on_login_exited(&a.attempt_id).await.expect("exit"),
        SignInState::Duplicate,
        "the same login as the System row is a duplicate"
    );

    // Case 2: the System email is unknown at exit time, so the identity command
    // is asked once more at finish and the duplicate is caught there.
    let g = fixture_with(identity_system_late("late@example.com"), None);
    let b = g.handle.begin_sign_in(CLI, "s2", None).expect("begin");
    assert_eq!(
        g.handle.on_login_exited(&b.attempt_id).await.expect("exit"),
        SignInState::Done,
        "unknown System identity cannot decide the duplicate yet"
    );
    let b_dir = folders::account_dir(g.handle.root(), CLI, &b.account_id);
    assert!(matches!(
        g.handle.finish_sign_in(&b.attempt_id, Some("Late")).await,
        Err(AccountsError::Duplicate)
    ));
    assert!(!b_dir.exists(), "the duplicate's folder must be removed");
    assert!(!g.handle.list().iter().any(|x| x.id == b.account_id));
}

#[tokio::test]
async fn pending_swept_on_boot() {
    let f = fixture();
    let a = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    let dir = folders::account_dir(f.handle.root(), CLI, &a.account_id);
    assert!(dir.exists(), "a pending sign-in has its folder");
    assert!(f
        .handle
        .list()
        .iter()
        .any(|x| x.id == a.account_id && x.pending));

    let removed = f.handle.sweep_pending_on_boot().expect("sweep");
    assert_eq!(removed, vec![a.account_id.clone()]);
    assert!(!dir.exists(), "the swept folder must be removed");
    assert!(!f.handle.list().iter().any(|x| x.id == a.account_id));
    let again = f.handle.sweep_pending_on_boot().expect("idempotent");
    assert_eq!(again.len(), 0);
}

#[tokio::test(start_paused = true)]
async fn signin_expires_after_deadline() {
    let f = fixture();
    let mut rx = f.broadcaster.subscribe();
    let a = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    let dir = folders::account_dir(f.handle.root(), CLI, &a.account_id);
    assert!(dir.exists());

    tokio::time::sleep(Duration::from_secs(SIGNIN_TTL_SECS + 1)).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
        if !dir.exists() {
            break;
        }
    }
    assert!(!dir.exists(), "an expired attempt's folder must be removed");

    let mut expired = false;
    while let Ok(ev) = rx.try_recv() {
        if let vst_types::ServerEvent::AccountSignin {
            attempt_id, state, ..
        } = ev
        {
            if attempt_id == a.attempt_id && state == SignInState::Expired {
                expired = true;
            }
        }
    }
    assert!(
        expired,
        "an `account:signin expired` event must be broadcast"
    );
}

#[tokio::test]
async fn failed_login_drops_folder_and_pending_record() {
    let identity: IdentityFn = Arc::new(|_acct: ResolvedAccount| {
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(false),
                email: None,
                plan: None,
            }
        })
    });
    let f = fixture_with(identity, None);
    let a = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    let dir = folders::account_dir(f.handle.root(), CLI, &a.account_id);
    assert_eq!(
        f.handle.on_login_exited(&a.attempt_id).await.expect("exit"),
        SignInState::Failed
    );
    assert!(!dir.exists(), "a failed login owns no folder");
    assert!(f.handle.locate(CLI, Some(&a.account_id)).is_none());
}

#[tokio::test]
async fn finish_twice_is_attempt_not_found() {
    let f = fixture_with(identity_named_only("one@example.com"), None);
    let a = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    f.handle.on_login_exited(&a.attempt_id).await.expect("exit");
    f.handle
        .finish_sign_in(&a.attempt_id, Some("First"))
        .await
        .expect("finish");
    let err = f
        .handle
        .finish_sign_in(&a.attempt_id, Some("Second"))
        .await
        .expect_err("second finish");
    assert!(matches!(err, AccountsError::AttemptNotFound));
    let listed = f.handle.summary(CLI, Some(&a.account_id)).expect("listed");
    assert_eq!(listed.display_name, "First");
}

#[tokio::test]
async fn begin_sign_in_record_has_dir_and_created_by_us() {
    let f = fixture();
    let a = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    let dir = folders::account_dir(f.handle.root(), CLI, &a.account_id);
    let resolved = f.handle.locate(CLI, Some(&a.account_id)).expect("located");
    assert_eq!(resolved.dir.as_deref(), Some(dir.as_path()));
    let summary = f
        .handle
        .summary(CLI, Some(&a.account_id))
        .expect("pending listed");
    assert!(summary.created_by_us, "a sign-in folder is ours");
    assert!(summary.pending);
}

#[tokio::test]
async fn cancel_sign_in_deletes_created_folder() {
    let f = fixture();
    let a = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    let dir = folders::account_dir(f.handle.root(), CLI, &a.account_id);
    assert!(dir.exists());
    f.handle.cancel_sign_in(&a.attempt_id).expect("cancel");
    assert!(!dir.exists(), "cancel deletes the folder we created");
    assert!(f.handle.summary(CLI, Some(&a.account_id)).is_none());
}

#[tokio::test]
async fn cancel_after_confirm_keeps_the_added_account_folder() {
    let f = fixture();
    let a = f.handle.begin_sign_in(CLI, "s1", None).expect("begin");
    f.handle
        .confirm_pending(CLI, &a.account_id)
        .await
        .expect("confirm");
    f.handle.cancel_sign_in(&a.attempt_id).expect("cancel");
    let dir = folders::account_dir(f.handle.root(), CLI, &a.account_id);
    assert!(
        dir.exists(),
        "a finished account's folder survives an old attempt"
    );
    let summary = f
        .handle
        .summary(CLI, Some(&a.account_id))
        .expect("still listed");
    assert!(!summary.pending);
}
