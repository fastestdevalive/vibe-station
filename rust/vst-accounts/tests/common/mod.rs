//! Shared fixtures for the `vst-accounts` integration tests.
//!
//! Every fixture uses a tempdir root, a generic fake CLI id (the crate is
//! CLI-agnostic — no harness name may appear in `src/`), and an in-process
//! broadcaster so events can be inspected.

#![allow(dead_code)] // each integration test file uses a subset

use std::sync::Arc;

use tempfile::TempDir;
use vst_accounts::{AccountsDeps, AccountsHandle, IdentityFn, SharedEntriesFn};
use vst_types::{AccountIdentity, Broadcaster, ResolvedAccount, SharedEntries};

/// The only CLI id the tests use (never a real harness name).
pub const CLI: &str = "fakecli";

pub struct Fixture {
    /// Keeps the tempdir alive for the whole test.
    pub dir: TempDir,
    pub handle: AccountsHandle,
    pub broadcaster: Broadcaster,
}

/// An identity function that reports a fixed email/plan as signed in.
pub fn identity_with(email: Option<&str>) -> IdentityFn {
    let email = email.map(str::to_string);
    Arc::new(move |_acct: ResolvedAccount| {
        let email = email.clone();
        Box::pin(async move {
            AccountIdentity {
                signed_in: Some(true),
                email,
                plan: Some("Max".to_string()),
            }
        })
    })
}

/// An identity function that reports "unknown" (the command failed).
pub fn identity_unknown() -> IdentityFn {
    Arc::new(|_acct: ResolvedAccount| Box::pin(async { AccountIdentity::default() }))
}

/// Reports `email` for a named account and "unknown" for the System row (the
/// boot check failed) — so a duplicate can only be decided against named
/// accounts.
pub fn identity_named_only(email: &'static str) -> IdentityFn {
    Arc::new(move |acct: ResolvedAccount| {
        if acct.id.is_none() {
            Box::pin(async { AccountIdentity::default() })
        } else {
            let email = email.to_string();
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

pub fn fixture_with(identity: IdentityFn, shared: Option<SharedEntries>) -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let broadcaster = Broadcaster::new(64);
    let shared_fn: SharedEntriesFn = Arc::new(move |_cli| shared.clone());
    let handle = AccountsHandle::new(AccountsDeps {
        root: dir.path().join("accounts"),
        broadcaster: broadcaster.clone(),
        identity,
        shared_entries: shared_fn,
        supports: Arc::new(|_cli| true),
    });
    Fixture {
        dir,
        handle,
        broadcaster,
    }
}

pub fn fixture() -> Fixture {
    fixture_with(identity_with(Some("work@example.com")), None)
}

/// A handle on an explicit root (e.g. one that already holds files).
pub fn fixture_at(root: std::path::PathBuf) -> AccountsHandle {
    AccountsHandle::new(AccountsDeps {
        root,
        broadcaster: Broadcaster::new(64),
        identity: identity_unknown(),
        shared_entries: Arc::new(|_cli| None),
        supports: Arc::new(|_cli| true),
    })
}
