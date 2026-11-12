//! Account env at the ACP spawn site (multi-account plan A2.T8, Decision 3).
//!
//! The ACP connection has no registry access: the session captures the
//! `AccountPort` at build time, and `get_or_create_connection` merges the
//! account env LAST (after the launch spec and the model env), returning the
//! stable typed prefix instead of spawning when the account cannot run.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::*;
use crate::acp_connection::AcpLaunchSpec;
use crate::acp_transport::AcpTransport;
use vst_types::{AccountPort, AccountResolveError, Channel, ResolvedAccount};

/// The var the fake harness redirects per account.
const ACCOUNT_DIR_VAR: &str = "FAKE_ACCOUNT_DIR";

/// A plugin whose only account fact is the dir env var.
struct AccountPlugin;

impl AgentPlugin for AccountPlugin {
    fn name(&self) -> &str {
        "account-test"
    }
    fn default_model(&self) -> &str {
        ""
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "fake"
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
    fn list_models(&self) -> crate::plugin::AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn account_env(&self, acct: &ResolvedAccount) -> BTreeMap<String, String> {
        match &acct.dir {
            Some(dir) => BTreeMap::from([(
                ACCOUNT_DIR_VAR.to_string(),
                dir.to_string_lossy().into_owned(),
            )]),
            None => BTreeMap::new(),
        }
    }
}

/// A port answering one canned outcome.
struct CannedPort(Result<ResolvedAccount, AccountResolveError>);

impl AccountPort for CannedPort {
    fn resolve(
        &self,
        _cli: &str,
        _account_id: Option<&str>,
    ) -> Result<ResolvedAccount, AccountResolveError> {
        self.0.clone()
    }
    fn report_limit(&self, _cli: &str, _account_id: Option<&str>, _signal: vst_types::LimitSignal) {
    }
}

fn session_under(account_id: Option<&str>, dir: &Path) -> JsonAgentSession {
    let store_handle = vst_store::StoreHandle::open(dir.join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let record = SessionRecord {
        id: "s-account".into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: vst_types::SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        account_id: account_id.map(str::to_string),
        name: None,
        name_source: None,
        tmux_name: "vst-s-account".into(),
        use_tmux: true,
        channel: Some(Channel::Json),
        lifecycle: vst_types::SessionLifecycle {
            state: vst_types::LifecycleState::Working,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        draft_prompt: None,
        draft_config: None,
        archived_at: None,
        handoff_summary: None,
        carry_over: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    };
    let project = ProjectRecord {
        id: "p1".into(),
        absolute_path: dir.join("repos").display().to_string(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    };
    JsonAgentSession::new(JsonAgentSessionOptions {
        project,
        worktree: None,
        session: record,
        plugin: Arc::new(AccountPlugin),
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    })
}

/// Fake-adapter spec that echoes `ACCOUNT_DIR_VAR` into `out`.
fn spec(out: &Path) -> AcpLaunchSpec {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![manifest
            .join("tests/fixtures/fakeAcpAgent.mjs")
            .to_string_lossy()
            .into_owned()],
        cwd: manifest,
        env: std::collections::HashMap::from([
            ("ENV_ECHO_VAR".to_string(), ACCOUNT_DIR_VAR.to_string()),
            (
                "ENV_OUT_FILE".to_string(),
                out.to_string_lossy().into_owned(),
            ),
            // The spec's own value must lose to the account env.
            (ACCOUNT_DIR_VAR.to_string(), "/from-spec".to_string()),
        ]),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
        open_tool_idle_timeout_ms: None,
    }
}

fn echoed(out: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(out).expect("fake adapter wrote the env echo");
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    value["value"].as_str().map(str::to_string)
}

#[tokio::test]
async fn acp_connection_env_includes_account_env() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("env.json");
    let account_dir = dir.path().join("accounts").join("acc_00000001");
    std::fs::create_dir_all(&account_dir).unwrap();
    let _home = crate::home::with_home(dir.path().to_path_buf());
    let session = session_under(Some("acc_00000001"), dir.path());
    session.attach_account_port(Arc::new(CannedPort(Ok(ResolvedAccount {
        cli: "account-test".to_string(),
        id: Some("acc_00000001".to_string()),
        dir: Some(account_dir.clone()),
        api_key: None,
    }))));

    let conn = session
        .get_or_create_connection(spec(&out), None)
        .await
        .expect("a resolvable account spawns");
    assert_eq!(
        echoed(&out),
        Some(account_dir.display().to_string()),
        "the account env wins over the launch spec"
    );
    conn.dispose().await;
}

#[tokio::test]
async fn acp_connection_signed_out_does_not_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("env.json");
    let _home = crate::home::with_home(dir.path().to_path_buf());
    let session = session_under(Some("acc_00000001"), dir.path());
    session.attach_account_port(Arc::new(CannedPort(Err(AccountResolveError::SignedOut))));

    let err = session
        .get_or_create_connection(spec(&out), None)
        .await
        .expect_err("a signed-out account must not spawn");
    assert_request_failed_prefix(err, "account_signed_out");
    assert!(!out.exists(), "the adapter was never spawned");
}

#[tokio::test]
async fn acp_connection_removed_account_does_not_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("env.json");
    let _home = crate::home::with_home(dir.path().to_path_buf());
    let session = session_under(Some("acc_00000001"), dir.path());
    session.attach_account_port(Arc::new(CannedPort(Err(AccountResolveError::NotFound))));

    let err = session
        .get_or_create_connection(spec(&out), None)
        .await
        .expect_err("a removed (stored) account must not spawn");
    assert_request_failed_prefix(err, "account_removed");
    assert!(!out.exists(), "the adapter was never spawned");
}

/// The payload of `RequestFailed` must START with the stable prefix the session
/// routes map onto their typed 409s.
fn assert_request_failed_prefix(err: crate::acp_transport::AcpTransportError, prefix: &str) {
    match err {
        crate::acp_transport::AcpTransportError::RequestFailed(message) => {
            assert!(message.starts_with(prefix), "{message}")
        }
        other => panic!("expected RequestFailed, got {other}"),
    }
}
