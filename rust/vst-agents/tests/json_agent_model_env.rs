//! `AgentPlugin::acp_model_env` wiring in `JsonAgentSession::
//! get_or_create_connection`: the adapter is spawned with the env derived
//! from the session's current model, winning over the launch spec's own env,
//! and a model switch respawns with the new value.

mod common;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_agents::acp_connection::AcpLaunchSpec;
use vst_agents::acp_transport::AcpTransport;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_types::{Channel, NormalizedEvent};

const MODEL_VAR: &str = "FAKE_MODEL_ENV";

/// Pins `FAKE_MODEL_ENV` to a non-empty model, like claude's `ANTHROPIC_MODEL`.
struct ModelEnvPlugin;

impl AgentPlugin for ModelEnvPlugin {
    fn name(&self) -> &str {
        "model-env"
    }
    fn default_model(&self) -> &str {
        ""
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "mock"
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
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        _cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        mpsc::unbounded_channel().1
    }
    fn acp_model_env(&self, model: &str) -> BTreeMap<String, String> {
        if model.is_empty() {
            return BTreeMap::new();
        }
        BTreeMap::from([(MODEL_VAR.to_string(), model.to_string())])
    }
}

fn session_with_model(home: &std::path::Path, model: Option<&str>) -> JsonAgentSession {
    let store_handle = vst_store::StoreHandle::open(home.join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    JsonAgentSession::new(JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree: None,
        session: common::make_session("s1"),
        plugin: Arc::new(ModelEnvPlugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: model.map(str::to_string),
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    })
}

/// Fake adapter spec whose own env sets `FAKE_MODEL_ENV=from-spec` (standing
/// in for a value the adapter would otherwise see) and echoes it back.
fn spec(out: &std::path::Path) -> AcpLaunchSpec {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![manifest
            .join("tests/fixtures/fakeAcpAgent.mjs")
            .to_string_lossy()
            .into_owned()],
        cwd: manifest,
        env: HashMap::from([
            (MODEL_VAR.to_string(), "from-spec".to_string()),
            ("ENV_ECHO_VAR".to_string(), MODEL_VAR.to_string()),
            (
                "ENV_OUT_FILE".to_string(),
                out.to_string_lossy().into_owned(),
            ),
        ]),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
    }
}

fn echoed(out: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(out).expect("fake adapter wrote the env echo");
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    v["value"].as_str().map(str::to_string)
}

#[tokio::test]
async fn adapter_env_carries_the_session_model_and_follows_a_switch() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let out = dir.path().join("env.json");
    let session = session_with_model(dir.path(), Some("m-a"));

    let conn = session
        .get_or_create_connection(spec(&out), None)
        .await
        .unwrap();
    assert_eq!(
        echoed(&out).as_deref(),
        Some("m-a"),
        "model env beats spec env"
    );
    assert!(conn.is_alive());

    // A switch disposes the connection; the respawn gets the new model.
    session.set_model(Some("m-b".to_string()), None).await;
    let conn = session
        .get_or_create_connection(spec(&out), None)
        .await
        .unwrap();
    assert_eq!(echoed(&out).as_deref(), Some("m-b"));
    conn.dispose().await;
}

#[tokio::test]
async fn no_model_leaves_the_adapter_env_alone() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let out = dir.path().join("env.json");
    let session = session_with_model(dir.path(), None);

    let conn = session
        .get_or_create_connection(spec(&out), None)
        .await
        .unwrap();
    assert_eq!(echoed(&out).as_deref(), Some("from-spec"));
    conn.dispose().await;
}
