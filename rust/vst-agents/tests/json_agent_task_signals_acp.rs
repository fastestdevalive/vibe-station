//! End to end over a real ACP connection: ext notifications the (fake) adapter
//! sends during a turn reach the session through the connection's ext sink
//! (`connection.rs` attach), become persisted `task_signal` rows via the
//! plugin, and change nothing else. The notifications are the ones captured
//! from the REAL claude adapter (`tests/fixtures/claude_tasks/raw_adapter_capture.json`).

mod common;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_agents::claude_tasks::claude_task_signal_event;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_agents::plugin::{
    AgentPlugin, AsyncResult, ComposePromptInput, ComposePromptResult, LaunchConfig,
    ListModelsResult, PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_types::{Channel, NormalizedEvent, NormalizedEventKind};

struct RawSdkPlugin;

fn capture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude_tasks/raw_adapter_capture.json")
}

impl AgentPlugin for RawSdkPlugin {
    fn name(&self) -> &str {
        "raw-sdk"
    }
    fn default_model(&self) -> &str {
        "m"
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "m"
    }
    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
        BTreeMap::new()
    }
    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(&self, _input: ComposePromptInput) -> ComposePromptResult {
        ComposePromptResult::default()
    }
    fn default_channel(&self) -> Channel {
        Channel::Json
    }
    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn acp_ext_notification_event(
        &self,
        method: &str,
        params: &serde_json::Value,
    ) -> Option<NormalizedEvent> {
        claude_task_signal_event(method, params)
    }
    fn run_turn(
        &self,
        input: TurnInput,
        ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let spec = vst_agents::acp_connection::AcpLaunchSpec {
            command: "node".to_string(),
            args: vec![format!(
                "{}/tests/fixtures/fakeAcpAgent.mjs",
                env!("CARGO_MANIFEST_DIR")
            )],
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            env: HashMap::from([
                ("FAKE_ACP_MODE".to_string(), "raw_sdk_tasks".to_string()),
                (
                    "RAW_SDK_CAPTURE".to_string(),
                    capture_path().display().to_string(),
                ),
            ]),
            initialize_timeout_ms: None,
            prompt_timeout_ms: None,
            reap_detached_descendants: false,
            open_tool_idle_timeout_ms: None,
        };
        let params = vst_agents::acp_run_turn::RunTurnAcpParams {
            provider: vst_types::NormalizedEventProvider::Claude,
            build_spec: Box::new(move |_| spec.clone()),
            enrich: None,
            first_turn_session_init: None,
            build_prompt_blocks: Box::new(|_c, input, _sys| {
                vec![agent_client_protocol::schema::v1::ContentBlock::Text(
                    agent_client_protocol::schema::v1::TextContent::new(input.message.clone()),
                )]
            }),
            emit_refusal_error: false,
            stuck_turn_idle_ms: None,
            stuck_turn_cancel_grace_ms: None,
        };
        tokio::spawn(vst_agents::acp_run_turn::run_turn_acp(
            tx, input, ctx, cancel, params,
        ));
        rx
    }
}

#[tokio::test]
async fn ext_notifications_during_a_turn_become_inert_task_signal_rows() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(256);
    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree: None,
        session: common::make_session("s1"),
        plugin: Arc::new(RawSdkPlugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle: store,
        broadcaster: vst_types::Broadcaster(tx),
    });

    let capture: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(capture_path()).unwrap()).unwrap();
    let expected = capture["ext"].as_array().unwrap().len();

    session.enqueue("go".into(), vec![], None, None);
    let rows = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let rows: Vec<_> = session
                .read_transcript()
                .into_iter()
                .filter(|e| e.kind == NormalizedEventKind::TaskSignal)
                .collect();
            if rows.len() >= expected {
                return rows;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("task_signal rows persisted");

    // Exactly the adapter's task messages, in order, whitelisted; the foreign
    // session's and the oversized one never arrive.
    assert_eq!(rows.len(), expected);
    let subtypes: Vec<_> = rows
        .iter()
        .map(|r| {
            r.task_signal.as_ref().unwrap()["subtype"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(subtypes[0], "task_started");
    assert!(rows
        .iter()
        .all(|r| r.task_signal.as_ref().unwrap().get("prompt").is_none()));
    assert!(rows
        .iter()
        .all(|r| r.task_signal.as_ref().unwrap()["task_id"] != "foreign"
            && r.task_signal.as_ref().unwrap()["task_id"] != "huge"));
    // Inert: the turn ran normally and no autonomous-work marker appeared.
    let statuses: Vec<_> = session
        .read_transcript()
        .into_iter()
        .filter(|e| e.kind == NormalizedEventKind::Status)
        .filter_map(|e| e.text)
        .collect();
    assert!(
        !statuses.iter().any(|t| t.contains("resumed work")),
        "{statuses:?}"
    );
    session.abort_and_drain();
}
