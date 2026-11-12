//! Structured chat limit signals (multi-account plan A2.T7).
//!
//! The fixtures are HAND-WRITTEN from the shape documented in
//! `docs/MULTI-ACCOUNT.md` § Limit detection — no real capture, no account
//! touched. Spike V11: the claude adapter does not forward `rate_limit_event`
//! (its raw-SDK filter matches `{type, subtype}` pairs), so in production
//! claude's "limited" state comes from the poller; the parser below is still
//! exercised here so it is ready if the adapter ever forwards it. Spike V5: the
//! codex port forwards no `account/rateLimits/updated`, so codex keeps the
//! default (poller only) — hence no codex signal test.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use vst_agents::acp_connection::AcpExtNotification;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_agents::plugin::AgentPlugin;
use vst_agents::resolve_plugin;
use vst_types::{AccountPort, CliId, LimitSignal, ResolvedAccount};

fn fixture(name: &str) -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/accounts")
        .join(name);
    let raw = std::fs::read_to_string(path).expect("fixture exists");
    serde_json::from_str(&raw).expect("fixture is JSON")
}

#[test]
fn claude_rate_limit_event_maps_signal() {
    let plugin = resolve_plugin(CliId::Claude);

    let rejected = plugin
        .account_limit_signal(
            "_claude/sdkMessage",
            &fixture("claude_rate_limit_rejected.json"),
        )
        .expect("a rejected window maps");
    assert_eq!(rejected.window_id, "five_hour");
    assert_eq!(rejected.used_pct, 100.0);
    assert!(rejected.rejected);
    assert_eq!(
        rejected.resets_at.as_deref(),
        Some("2025-11-12T12:40:00.000Z"),
        "epoch seconds become ISO8601"
    );

    let ok = plugin
        .account_limit_signal("_claude/sdkMessage", &fixture("claude_rate_limit_ok.json"))
        .expect("an allowed window still maps");
    assert_eq!(ok.window_id, "seven_day");
    assert_eq!(ok.used_pct, 42.0);
    assert!(!ok.rejected);
    assert_eq!(ok.resets_at.as_deref(), Some("2026-11-12T10:00:00.000Z"));
}

#[test]
fn claude_unknown_shape_is_none() {
    let plugin = resolve_plugin(CliId::Claude);
    // Wrong method, wrong type, missing payload, garbage values.
    assert_eq!(
        plugin.account_limit_signal("session/update", &fixture("claude_rate_limit_ok.json")),
        None
    );
    assert_eq!(
        plugin.account_limit_signal(
            "_claude/sdkMessage",
            &serde_json::json!({"message": {"type": "system", "subtype": "task_started"}})
        ),
        None
    );
    assert_eq!(
        plugin.account_limit_signal("_claude/sdkMessage", &serde_json::json!({})),
        None
    );
    assert_eq!(
        plugin.account_limit_signal(
            "_claude/sdkMessage",
            &serde_json::json!({
                "message": {
                    "type": "rate_limit_event",
                    "rate_limit_info": {"unifiedWindows": {"five_hour": {"status": "rejected"}}}
                }
            })
        ),
        None,
        "a window without utilization is not a signal"
    );
}

/// A plugin that reports a fixed signal, so the session's report path is
/// observable without a vendor CLI.
struct SignalPlugin;

impl AgentPlugin for SignalPlugin {
    fn name(&self) -> &str {
        "signal"
    }
    fn default_model(&self) -> &str {
        ""
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "signal"
    }
    fn prompt_delivery(&self) -> vst_agents::plugin::PromptDelivery {
        vst_agents::plugin::PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &vst_agents::plugin::LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(
        &self,
        _cfg: &vst_agents::plugin::LaunchConfig,
    ) -> std::collections::BTreeMap<String, String> {
        std::collections::BTreeMap::new()
    }
    fn get_ready_signal(&self) -> vst_agents::plugin::ReadySignal {
        vst_agents::plugin::ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(
        &self,
        _input: vst_agents::plugin::ComposePromptInput,
    ) -> vst_agents::plugin::ComposePromptResult {
        vst_agents::plugin::ComposePromptResult::default()
    }
    fn default_channel(&self) -> vst_types::Channel {
        vst_types::Channel::Json
    }
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<vst_agents::plugin::ListModelsResult> {
        Box::pin(async { vst_agents::plugin::ListModelsResult::default() })
    }
    fn account_limit_signal(
        &self,
        _method: &str,
        _params: &serde_json::Value,
    ) -> Option<LimitSignal> {
        Some(LimitSignal {
            window_id: "five_hour".to_string(),
            used_pct: 100.0,
            resets_at: None,
            rejected: true,
        })
    }
}

/// Counts `report_limit` calls.
#[derive(Default)]
struct CountingPort {
    calls: AtomicUsize,
}

impl AccountPort for CountingPort {
    fn resolve(
        &self,
        cli: &str,
        _account_id: Option<&str>,
    ) -> Result<ResolvedAccount, vst_types::AccountResolveError> {
        Ok(ResolvedAccount::system(cli))
    }

    fn report_limit(&self, _cli: &str, _account_id: Option<&str>, _signal: LimitSignal) {
        self.calls.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn limit_signal_reaches_port_without_persisting_a_row() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree: None,
        session: common::make_session("s1"),
        plugin: Arc::new(SignalPlugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    });
    let port = Arc::new(CountingPort::default());
    session.attach_account_port(port.clone());

    assert!(session.read_transcript().is_empty(), "starts empty");
    session.ingest_ext_notification_for_test(&AcpExtNotification {
        method: "_claude/sdkMessage".to_string(),
        params: serde_json::json!({"message": {"type": "rate_limit_event"}}),
    });

    assert_eq!(
        port.calls.load(Ordering::SeqCst),
        1,
        "the signal reaches the one limited-state writer"
    );
    assert!(
        session.read_transcript().is_empty(),
        "a limit signal is never persisted as a transcript row"
    );
}

#[test]
fn registry_exposes_the_account_port() {
    // The seam the ACP connection and the limit-signal path read from.
    let registry = JsonAgentRegistry::<JsonAgentSession>::new();
    assert!(registry.account_port().is_none());
    let port: Arc<dyn AccountPort> = Arc::new(CountingPort::default());
    registry.set_account_port(port);
    assert!(registry.account_port().is_some());
}
