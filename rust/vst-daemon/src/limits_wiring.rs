//! Harness-limits scheduler wiring: builds a `LimitsHandle` from the daemon's
//! store, broadcaster, plugins, and hostname — the only place `vst-daemon`
//! injects `vst-agents` probe closures and the session→harness resolver.

use std::sync::Arc;

use vst_harness_limits::{
    HarnessFuture, HarnessProbe, LimitsDeps, LimitsHandle, LimitsTiming, SessionHarnessFn,
};
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;

/// Build the daemon's harness-limits scheduler.
pub async fn build_limits_handle(store: &StoreHandle, broadcaster: &Broadcaster) -> LimitsHandle {
    let probes: Vec<HarnessProbe> = vst_agents::SUPPORTED_CLIS
        .iter()
        .map(|cli| {
            let cli = *cli;
            HarnessProbe {
                harness: cli.as_str().to_string(),
                // `resolve_plugin(..).get_limits()` returns a 'static future (plugin.rs:232).
                probe: Arc::new(move || vst_agents::resolve_plugin(cli).get_limits()),
            }
        })
        .collect();
    let store_for_resolver = store.clone();
    // The explicit `-> HarnessFuture` return type is REQUIRED: without it the closure returns a
    // concrete `Pin<Box<impl Future>>` and will not coerce to `SessionHarnessFn`.
    let session_harness: SessionHarnessFn = Arc::new(move |session_id: String| -> HarnessFuture {
        let store = store_for_resolver.clone();
        Box::pin(async move {
            let (_, session) = store.find_session(&session_id).await?;
            let mode_id = session.mode_id?;
            let modes = tokio::task::spawn_blocking(vst_routes::modes::load_modes)
                .await
                .ok()?;
            modes
                .into_iter()
                .find(|m| m.id == mode_id)
                .map(|m| m.cli.as_str().to_string())
        })
    });
    LimitsHandle::new(LimitsDeps {
        broadcaster: broadcaster.clone(),
        probes,
        session_harness,
        host: crate::doctor::resolve_hostname(),
        initial_slots: vst_routes::limits::LimitsRoutes::load_slots(store).await,
        timing: LimitsTiming::default(),
    })
}
