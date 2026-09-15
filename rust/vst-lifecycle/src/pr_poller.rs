//! 30-second PR-status poller — ports `services/prPoller.ts`.
//!
//! **Two-axis model** (Gotcha #3): this module is the **sole writer** of the
//! `pr` field on a session.  The setter is fully private — restricted to this
//! module only — so the compiler prevents lifecycle.rs (or any other module) from calling it.
//!
//! Behavior contract:
//! - `PR_POLL_INTERVAL_MS = 30_000`
//! - Only polls `isMain=true` sessions (the designated PR-tracking session per
//!   worktree).
//! - `classify_pr_state`: merged→Merged, draft→Draft, closed→Closed, else→Open.
//! - The poller **never** touches `lifecycle.state`.
//! - Overlap guard: if a poll tick is already in-flight, the new tick is skipped.
//! - `pr_status_equivalent`: compares state/number/url/error/pr_branch;
//!   ignores `checked_at` so unchanged results don't broadcast.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use vst_store::StoreHandle;
use vst_types::domain::{PrState, PrStatus, SessionRecord};
use vst_types::events::{Broadcaster, ServerEvent};

use crate::github::{
    fetch_prs_for_branches, get_remote_url, resolve_github_remote, PrLookupResult,
};
use crate::util::now_iso;

pub const PR_POLL_INTERVAL_MS: u64 = 30_000;

/// Classify a raw GitHub PR into a `PrState`.
///
/// Decision rules (mirrors TS `classifyPrState`):
/// 1. `merged == true` → `Merged`
/// 2. `draft == true` → `Draft`
/// 3. `state == "closed"` → `Closed`
/// 4. otherwise → `Open`
pub fn classify_pr_state(merged: bool, draft: bool, state_closed: bool) -> PrState {
    if merged {
        PrState::Merged
    } else if draft {
        PrState::Draft
    } else if state_closed {
        PrState::Closed
    } else {
        PrState::Open
    }
}

/// Compare two `PrStatus` values for effective equivalence, ignoring the
/// `checked_at` timestamp (so an unchanged result doesn't trigger a broadcast).
pub fn pr_status_equivalent(a: &PrStatus, b: &PrStatus) -> bool {
    a.state == b.state
        && a.number == b.number
        && a.url == b.url
        && a.error == b.error
        && a.pr_branch == b.pr_branch
}

/// Private (this module only) PR-status setter.
/// Only this module may write `pr` — enforces the two-axis model.
async fn set_pr_status(
    project_id: &str,
    session: &SessionRecord,
    pr: PrStatus,
    store: &StoreHandle,
    broadcaster: &Broadcaster,
) {
    if let Some(existing) = &session.pr {
        if pr_status_equivalent(existing, &pr) {
            return;
        }
    }
    let pr_box = Box::new(pr.clone());
    let _ = store.update_session_pr(project_id, &session.id, pr).await;
    broadcaster.send(ServerEvent::SessionUpdated {
        session_id: session.id.clone(),
        pr: Some(pr_box),
        pinned_at: None,
        channel: None,
        name: None,
        archived_at: None,
        sort_order: None,
        superseded_by: None,
        is_main: None,
        parent_session_id: None,
        worktree_id: None,
        draft_prompt: None,
        draft_config: None,
    });
}

fn pr_lookup_to_status(result: &PrLookupResult, branch: &str, checked_at: &str) -> PrStatus {
    match result {
        PrLookupResult::NoPr => PrStatus {
            state: PrState::None,
            number: None,
            url: None,
            checked_at: checked_at.to_string(),
            error: None,
            pr_branch: Some(branch.to_string()),
        },
        PrLookupResult::Pr(data) => PrStatus {
            state: classify_pr_state(data.merged, data.draft, data.state == "closed"),
            number: Some(data.number),
            url: Some(data.url.clone()),
            checked_at: checked_at.to_string(),
            error: None,
            pr_branch: Some(branch.to_string()),
        },
        PrLookupResult::NoCredentials { error } | PrLookupResult::Error { error } => PrStatus {
            state: PrState::None,
            number: None,
            url: None,
            checked_at: checked_at.to_string(),
            error: Some(error.clone()),
            pr_branch: Some(branch.to_string()),
        },
    }
}

/// Handle to the PR poller.
#[derive(Clone)]
pub struct PrPollerHandle {
    store: StoreHandle,
    broadcaster: Broadcaster,
    in_flight: Arc<AtomicBool>,
}

impl PrPollerHandle {
    pub fn new(store: StoreHandle, broadcaster: Broadcaster) -> Self {
        Self {
            store,
            broadcaster,
            in_flight: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Run one poll tick — public for testing.
    pub async fn poll_all_prs(&self) {
        if self
            .in_flight
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        // Reset in_flight on drop.
        struct Guard(Arc<AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = Guard(self.in_flight.clone());

        let projects = self.store.get_all_projects().await;
        let checked_at = now_iso();

        for project in &projects {
            let main_sessions: Vec<(&str, &str)> = project
                .worktrees
                .iter()
                .flat_map(|wt| {
                    wt.sessions.iter().filter_map(|s| {
                        if s.is_main {
                            Some((wt.branch.as_str(), s.id.as_str()))
                        } else {
                            None
                        }
                    })
                })
                .collect();

            if main_sessions.is_empty() {
                continue;
            }

            let remote_url =
                match get_remote_url(std::path::Path::new(&project.absolute_path)).await {
                    Ok(u) => u,
                    Err(_) => continue,
                };
            let Some(remote) = resolve_github_remote(&remote_url) else {
                continue;
            };

            let branches: Vec<String> = main_sessions.iter().map(|(b, _)| b.to_string()).collect();
            let results = match fetch_prs_for_branches(&remote, &branches).await {
                Ok(r) => r,
                Err(_) => continue,
            };

            let branch_to_session: HashMap<&str, &str> = main_sessions.iter().cloned().collect();
            let sessions_by_id: HashMap<&str, &SessionRecord> = project
                .worktrees
                .iter()
                .flat_map(|wt| wt.sessions.iter())
                .map(|s| (s.id.as_str(), s))
                .collect();

            for (branch, result) in &results {
                let Some(&session_id) = branch_to_session.get(branch.as_str()) else {
                    continue;
                };
                let Some(&session) = sessions_by_id.get(session_id) else {
                    continue;
                };
                let pr_status = pr_lookup_to_status(result, branch, &checked_at);
                set_pr_status(
                    &project.id,
                    session,
                    pr_status,
                    &self.store,
                    &self.broadcaster,
                )
                .await;
            }
        }
    }

    /// Start the 30s background polling loop.
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(tokio::time::Duration::from_millis(PR_POLL_INTERVAL_MS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                self.poll_all_prs().await;
            }
        })
    }
}
