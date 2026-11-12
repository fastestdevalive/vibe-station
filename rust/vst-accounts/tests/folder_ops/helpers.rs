//! Shared fixtures for the folder-account tests: a handle with a fake
//! `FolderDeps` under a tempdir, user folders, identity closures and snapshots.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use tokio::sync::{broadcast::Receiver, Notify};
use vst_accounts::{
    AccountsDeps, AccountsHandle, FolderDeps, FolderSpec, IdentityFn, SharedEntriesFn,
};
use vst_types::{
    AccountIdentity, AccountLinkMeta, Broadcaster, ResolvedAccount, ServerEvent, SharedEntries,
    SignInSteps,
};

/// The login line the fake plugin reports.
pub const SIGNIN_COMMAND: &str = "FAKE_CONFIG=x fakecli login";

pub struct Fx {
    /// Keeps the tempdir alive.
    pub _dir: tempfile::TempDir,
    pub home: PathBuf,
    pub handle: AccountsHandle,
    pub events: Receiver<ServerEvent>,
}

/// A handle with folder support. `verifies` sets `AccountLinkMeta::verifies_identity`.
pub fn fx(identity: IdentityFn, verifies: bool, shared: Option<SharedEntries>) -> Fx {
    fx_looks(identity, verifies, shared, true)
}

/// Like [`fx`], with the plugin's "looks like a login folder" answer fixed to `looks_valid`.
pub fn fx_looks(
    identity: IdentityFn,
    verifies: bool,
    shared: Option<SharedEntries>,
    looks_valid: bool,
) -> Fx {
    let dir = tempfile::tempdir().expect("tempdir");
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let broadcaster = Broadcaster::new(256);
    let events = broadcaster.subscribe();
    let shared_fn: SharedEntriesFn = Arc::new(move |_cli| shared.clone());
    let system_dir = home.join(".fakecli");
    let deps = FolderDeps {
        home: home.clone(),
        link_meta: Arc::new(move |_cli| {
            Some(AccountLinkMeta {
                example_path: "~/.fakecli-work".to_string(),
                field_label: "Folder".to_string(),
                field_note: None,
                system_dir: Some(system_dir.clone()),
                verifies_identity: verifies,
                first_run_note: None,
            })
        }),
        looks_valid: Arc::new(move |_cli, _names| looks_valid),
        sign_in_steps: Arc::new(|_acct: &ResolvedAccount| SignInSteps {
            command: Some(SIGNIN_COMMAND.to_string()),
            hint: None,
        }),
    };
    let handle = AccountsHandle::new(AccountsDeps {
        root: dir.path().join("accounts"),
        broadcaster,
        identity,
        shared_entries: shared_fn,
        supports: Arc::new(|_cli| true),
    })
    .with_folder_support(deps);
    Fx {
        _dir: dir,
        home,
        handle,
        events,
    }
}

/// A user folder under `home` with one file in it.
pub fn folder(home: &Path, name: &str) -> PathBuf {
    let dir = home.join(name);
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(dir.join("settings.json"), "{}").expect("write");
    dir
}

pub fn choose(path: &Path) -> FolderSpec {
    FolderSpec::Choose(path.to_string_lossy().into_owned())
}

/// Every entry name and its mtime, plus the folder's own mtime.
pub fn snapshot(dir: &Path) -> Vec<(String, SystemTime)> {
    let mut out: Vec<(String, SystemTime)> = std::fs::read_dir(dir)
        .expect("read dir")
        .flatten()
        .map(|e| {
            let mtime = e.metadata().expect("metadata").modified().expect("mtime");
            (e.file_name().to_string_lossy().into_owned(), mtime)
        })
        .collect();
    let own = std::fs::metadata(dir)
        .expect("dir")
        .modified()
        .expect("mtime");
    out.push((".".to_string(), own));
    out.sort();
    out
}

pub fn drain(rx: &mut Receiver<ServerEvent>) -> Vec<ServerEvent> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        out.push(event);
    }
    out
}

pub fn updated_for(events: &[ServerEvent], id: &str) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, ServerEvent::AccountUpdated { account } if account.id == id))
        .count()
}

/// Named accounts report `email` as signed in; the System row stays unknown.
/// `signed` flips the named accounts between signed in and signed out.
pub fn toggled(signed: Arc<AtomicBool>, email: &'static str) -> IdentityFn {
    Arc::new(move |acct: ResolvedAccount| {
        let signed = signed.clone();
        Box::pin(async move {
            if acct.id.is_none() {
                AccountIdentity::default()
            } else if signed.load(Ordering::SeqCst) {
                AccountIdentity {
                    signed_in: Some(true),
                    email: Some(email.to_string()),
                    plan: None,
                }
            } else {
                AccountIdentity {
                    signed_in: Some(false),
                    email: None,
                    plan: None,
                }
            }
        })
    })
}

/// Named accounts report `email` as signed in, and block on `gate` once `armed`.
pub fn gated(armed: Arc<AtomicBool>, entered: Arc<Notify>, gate: Arc<Notify>) -> IdentityFn {
    Arc::new(move |acct: ResolvedAccount| {
        let (armed, entered, gate) = (armed.clone(), entered.clone(), gate.clone());
        Box::pin(async move {
            if acct.id.is_none() || !armed.load(Ordering::SeqCst) {
                return AccountIdentity::default();
            }
            entered.notify_one();
            gate.notified().await;
            AccountIdentity {
                signed_in: Some(true),
                email: Some("gated@example.com".to_string()),
                plan: None,
            }
        })
    })
}
