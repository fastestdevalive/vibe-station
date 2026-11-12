//! Harness-limits scheduler wiring: builds a `LimitsHandle` from the daemon's
//! store, broadcaster, plugins, accounts registry and hostname — the only place
//! `vst-daemon` injects `vst-agents` probe closures and the session→target
//! resolver (multi-account plan A3.2, Decision 9).
//!
//! Per account: one `ProbeTarget` per System login of every supported CLI plus
//! every non-pending account. A probe uses `AccountsHandle::locate` (NOT
//! `resolve`): a signed-out account must stay probe-able so the identity
//! trigger of Decision 12 can fire. An API-key account has no vendor login, so
//! it reports `NoPlanLimits` without spawning anything.

use std::str::FromStr;
use std::sync::Arc;

use vst_accounts::AccountsHandle;
use vst_agents::SUPPORTED_CLIS;
use vst_harness_limits::{
    LimitsDeps, LimitsHandle, LimitsTiming, ProbeFn, ProbeTarget, SessionTargetFn, TargetFuture,
    TargetsFn,
};
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::{AccountMethod, CliId, LimitStatus, LimitsResult};

/// The targets to probe: every supported CLI's System login, plus every
/// non-pending, non-System account (a pending row is invisible to background
/// paths, Decision 2).
pub(crate) fn probe_targets(accounts: &AccountsHandle) -> Vec<ProbeTarget> {
    let mut out: Vec<ProbeTarget> = SUPPORTED_CLIS
        .iter()
        .map(|cli| ProbeTarget::system(cli.as_str()))
        .collect();
    for account in accounts.list() {
        if account.method == AccountMethod::System || account.pending {
            continue; // the System target above covers System; pending is not added yet
        }
        out.push(ProbeTarget {
            harness: account.cli,
            account_id: Some(account.id),
        });
    }
    out
}

/// Build the daemon's harness-limits scheduler.
pub async fn build_limits_handle(
    store: &StoreHandle,
    broadcaster: &Broadcaster,
    accounts: &AccountsHandle,
) -> LimitsHandle {
    // Read at call time, so an account added or removed while the daemon runs is
    // picked up on the next tick (Decision 9).
    let accounts_for_targets = accounts.clone();
    let targets: TargetsFn = Arc::new(move || probe_targets(&accounts_for_targets));
    // One probe per target, with that account's env. `locate` (not `resolve`)
    // so a signed-out account stays probe-able; an API-key account never spawns.
    let accounts_for_probe = accounts.clone();
    let probe: ProbeFn = Arc::new(move |target| {
        let accounts = accounts_for_probe.clone();
        Box::pin(async move {
            let as_of = vst_agents::util::now_iso_8601();
            let Ok(cli) = CliId::from_str(&target.harness) else {
                return LimitsResult::unsupported(&target.harness, &as_of);
            };
            let plugin = vst_agents::resolve_plugin(cli);
            let Some(resolved) = accounts.locate(&target.harness, target.account_id.as_deref())
            else {
                return LimitsResult::failure(
                    &target.harness,
                    LimitStatus::NoPlanLimits,
                    "The account no longer exists.",
                    &as_of,
                    &[],
                )
                .with_account(target.account_id);
            };
            if resolved.api_key.is_some() {
                return LimitsResult::failure(
                    &target.harness,
                    LimitStatus::NoPlanLimits,
                    "API-key accounts have no plan limits.",
                    &as_of,
                    &[],
                )
                .with_account(target.account_id);
            }
            let env = plugin.account_env(&resolved);
            plugin
                .get_limits_with_env(env)
                .await
                .with_account(target.account_id)
        })
    });
    let store_for_resolver = store.clone();
    // The explicit `-> TargetFuture` return type is REQUIRED: without it the closure
    // returns a concrete `Pin<Box<impl Future>>` and will not coerce to `SessionTargetFn`.
    let session_target: SessionTargetFn = Arc::new(move |session_id: String| -> TargetFuture {
        let store = store_for_resolver.clone();
        Box::pin(async move {
            let (_, session) = store.find_session(&session_id).await?;
            let mode_id = session.mode_id?;
            let modes = tokio::task::spawn_blocking(vst_routes::modes::load_modes)
                .await
                .ok()?;
            let harness = modes
                .into_iter()
                .find(|m| m.id == mode_id)
                .map(|m| m.cli.as_str().to_string())?;
            Some(ProbeTarget {
                harness,
                account_id: session.account_id,
            })
        })
    });
    LimitsHandle::new(LimitsDeps {
        broadcaster: broadcaster.clone(),
        targets,
        probe,
        session_target,
        host: crate::doctor::resolve_hostname(),
        initial_slots: vst_routes::limits::LimitsRoutes::load_slots(store).await,
        timing: LimitsTiming::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_accounts::{AccountsDeps, FolderDeps, FolderSpec, IdentityFn};
    use vst_types::events::Broadcaster;
    use vst_types::{AccountIdentity, AccountLinkMeta, SignInSteps};

    /// A folder-supporting registry for `claude` whose folder accounts are
    /// unverifiable (so an added folder stays pending).
    fn registry(root: &std::path::Path) -> AccountsHandle {
        let identity: IdentityFn = Arc::new(|_| Box::pin(async { AccountIdentity::default() }));
        AccountsHandle::new(AccountsDeps {
            root: root.join("accounts"),
            broadcaster: Broadcaster::new(16),
            identity,
            shared_entries: Arc::new(|_| None),
            supports: Arc::new(|cli| cli == "claude"),
        })
        .with_folder_support(FolderDeps {
            home: root.to_path_buf(),
            link_meta: Arc::new(|_| {
                Some(AccountLinkMeta {
                    example_path: "~/.claude-work".into(),
                    field_label: "Folder".into(),
                    field_note: None,
                    system_dir: None,
                    verifies_identity: false,
                    first_run_note: None,
                })
            }),
            looks_valid: Arc::new(|_, _| true),
            sign_in_steps: Arc::new(|_| SignInSteps::default()),
        })
    }

    #[tokio::test]
    async fn limits_targets_skip_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let accounts = registry(tmp.path());
        let chosen = tmp.path().join("chosen");
        std::fs::create_dir_all(&chosen).unwrap();
        let pending = accounts
            .add_folder(
                "claude",
                FolderSpec::Choose(chosen.to_string_lossy().into_owned()),
                None,
            )
            .await
            .unwrap();
        assert!(pending.pending);
        let listed = accounts.add_api_key("claude", "sk-test", "Work").unwrap();

        let targets = probe_targets(&accounts);
        let has = |account_id: Option<&str>| {
            targets
                .iter()
                .any(|t| t.harness == "claude" && t.account_id.as_deref() == account_id)
        };
        assert!(has(None), "the System login is always probed");
        assert!(has(Some(listed.id.as_str())), "a listed account is probed");
        assert!(
            !has(Some(pending.id.as_str())),
            "a pending account is not probed"
        );
    }
}
