//! Wiring for Terminal (tmux) delivery of scheduled messages.
//!
//! `vst-review` is CLI-agnostic; everything that depends on the agent CLI, the
//! session store or the broadcaster is injected here as closures:
//! - the [`TargetResolver`] resolves a session to its tmux name, current channel,
//!   liveness and the plugin's delivery capabilities + readiness probe;
//! - the notify closure re-broadcasts the session's scheduled state.
//!
//! The outcome observer is a parameter: the daemon injects the review owner's
//! (`ReviewHandle::terminal_observer`, see `vst-daemon`'s `build_state`).
//! The pane access is a parameter too, so route tests drive a scripted pane.

use std::sync::Arc;

use crate::modes::find_mode;
use vst_agents::json_agent_chat::broadcast_scheduled_meta;
use vst_agents::{resolve_plugin, AgentPlugin};
use vst_lifecycle::channel::session_channel;
use vst_review::{
    BoxFuture, NotifyScheduled, OutcomeObserver, PaneIo, TargetResolver, TerminalDeliveryHandle,
    TerminalTarget,
};
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::terminal_delivery::{PaneSnapshot, TerminalReadiness};
use vst_types::{Channel, LifecycleState};

/// Resolves a session id to what a delivery job needs, from the live store.
struct StoreTargetResolver {
    store: StoreHandle,
}

impl TargetResolver for StoreTargetResolver {
    fn resolve(&self, session_id: &str) -> BoxFuture<'_, Option<TerminalTarget>> {
        let id = session_id.to_string();
        Box::pin(async move {
            let (project, session) = self.store.find_session(&id).await?;
            let worktree_hidden = session
                .worktree_id
                .as_deref()
                .and_then(|wid| project.worktrees.iter().find(|w| w.id == wid))
                .is_some_and(|w| w.hidden_at.is_some());
            let channel = session_channel(session.channel, Some(session.use_tmux));
            // The session's mode may have been deleted: no plugin, no delivery.
            let plugin: Option<Arc<dyn AgentPlugin>> = session
                .mode_id
                .as_deref()
                .and_then(find_mode)
                .map(|m| Arc::from(resolve_plugin(m.cli)));
            let caps = plugin.as_ref().and_then(|p| p.terminal_delivery());
            let probe: Arc<dyn Fn(&PaneSnapshot) -> TerminalReadiness + Send + Sync> = match plugin
            {
                Some(p) => Arc::new(move |pane| p.terminal_readiness(pane)),
                None => Arc::new(|_| TerminalReadiness::Unknown),
            };
            Some(TerminalTarget {
                tmux_name: session.tmux_name.clone(),
                channel_is_tmux: channel == Channel::Tmux,
                channel_is_json: channel == Channel::Json,
                gone: session.archived_at.is_some() || worktree_hidden,
                exited: matches!(
                    session.lifecycle.state,
                    LifecycleState::Exited | LifecycleState::Done
                ),
                caps,
                probe,
            })
        })
    }
}

/// The resolver of the daemon's delivery owner, for callers that need a session's
/// current channel and plugin capabilities without owning a job (the review
/// owner's eligibility check).
pub fn target_resolver(store: StoreHandle) -> Arc<dyn TargetResolver> {
    Arc::new(StoreTargetResolver { store })
}

/// Build the daemon's single Terminal delivery owner. `io` is the real tmux in
/// production.
pub fn build_terminal_delivery(
    store: StoreHandle,
    broadcaster: Broadcaster,
    io: Arc<dyn PaneIo>,
    observer: Option<OutcomeObserver>,
) -> TerminalDeliveryHandle {
    let notify_store = store.clone();
    let notify: NotifyScheduled = Arc::new(move |session_id| {
        let (store, broadcaster) = (notify_store.clone(), broadcaster.clone());
        Box::pin(async move { broadcast_scheduled_meta(&store, &broadcaster, &session_id).await })
    });
    TerminalDeliveryHandle::new(
        store.clone(),
        io,
        Arc::new(StoreTargetResolver { store }),
        notify,
        observer,
    )
}
