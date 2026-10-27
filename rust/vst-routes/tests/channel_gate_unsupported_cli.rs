//! Channel gate for CLIs that cannot / can run Rich Chat: pi (terminal-only) is
//! rejected for explicit json and ignores a json default override; agy supports
//! Rich Chat so its json override is honoured.

use std::sync::Arc;
use std::time::Duration;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::modes::json_unsupported_cli;
use vst_routes::sessions::{ResetError, SessionRoutes, StartError};
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::sessions::{ResetBody, SessionOrDraft, StartDraftBody};
use vst_types::{
    Channel, DraftConfig, DraftEntryPoint, LifecycleState, ProjectRecord, SessionLifecycle,
    SessionNameSource, SessionRecord, SessionType,
};
use vst_ws::state::attachment_registry::AttachmentRegistry;

fn store() -> (tempfile::TempDir, StoreHandle) {
    let dir = tempdir().unwrap();
    let s = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    (dir, s)
}

fn make_session(id: &str, project_id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: project_id.into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("my-mode".into()),
        mode_icon: None,
        name: Some("Agent".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: format!("vst-{id}"),
        use_tmux: true,
        channel: Some(Channel::Tmux),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: Some("original prompt".into()),
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
    }
}

fn json_session(id: &str, project_id: &str) -> SessionRecord {
    let mut s = make_session(id, project_id);
    s.use_tmux = false;
    s.channel = Some(Channel::Json);
    s
}

fn make_project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/repos/{id}"),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    }
}

fn routes(store: StoreHandle) -> SessionRoutes {
    SessionRoutes {
        store,
        broadcaster: Broadcaster::new(16),
        json_registry: Arc::new(JsonAgentRegistry::new()),
        direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
        direct_streams: std::sync::Arc::new(
            std::sync::Mutex::new(std::collections::HashMap::new()),
        ),
        tmux: vst_proc::tmux::Tmux::new(),
        daemon_port: 3999,
        json_unsupported: Arc::new(|_| None),
        subagent_notify: SubagentNotifyHandle::new(),
        attachment_registry: AttachmentRegistry::new(),
        model_catalog: Default::default(),
        handoff_timeout: Duration::from_secs(120),
        reset_cancels: Default::default(),
    }
}

async fn add_project(store: &StoreHandle, p: ProjectRecord) {
    store.add_project(p).await.unwrap();
}

fn reset_body() -> ResetBody {
    ResetBody {
        handoff: None,
        prompt: None,
        handoff_text: None,
        mode_id: None,
        channel: None,
        ..Default::default()
    }
}

/// Seed an arbitrary set of `(id, name, cli)` modes into a temp home so
/// `load_modes` resolves them, returning the home + guard (kept alive for the
/// test's duration). Used by the channel-defaulting tests, which use
/// pi/agy/claude modes.
fn home_with_modes(
    modes: &[(&str, &str, &str)],
) -> (tempfile::TempDir, vst_agents::home::HomeGuard) {
    let home = tempdir().unwrap();
    let modes_dir = home.path().join(".vibe-station");
    std::fs::create_dir_all(&modes_dir).unwrap();
    let arr: Vec<serde_json::Value> = modes
        .iter()
        .map(|(id, name, cli)| {
            serde_json::json!({
                "id": id,
                "name": name,
                "cli": cli,
                "context": "",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "model": null,
            })
        })
        .collect();
    std::fs::write(
        modes_dir.join("modes.json"),
        serde_json::to_string(&arr).unwrap(),
    )
    .unwrap();
    let guard = with_home(home.path().to_path_buf());
    (home, guard)
}

/// Create a direct agent session for `mode_id` and return the serialized
/// `Session` (asserting it came back as a session, not a draft).
async fn create_direct_agent(
    r: &SessionRoutes,
    project_id: &str,
    mode_id: &str,
) -> vst_types::rest::shared::Session {
    let body = serde_json::json!({
        "target": "direct",
        "type": "agent",
        "projectId": project_id,
        "modeId": mode_id,
    });
    let created = r.create_session(&body).await.unwrap();
    match created {
        SessionOrDraft::Session(s) => s,
        SessionOrDraft::GlobalDraft(_) => panic!("expected a session, got a global draft"),
    }
}

/// `routes` but with `json_unsupported` wired to the REAL `json_unsupported_cli`
/// (which consults each mode's plugin capability), so a pi mode is flagged as
/// unable to run Rich Chat. Needed to exercise the draft-start json gate.
fn routes_with_real_json_gate(store: StoreHandle) -> SessionRoutes {
    SessionRoutes {
        json_unsupported: Arc::new(json_unsupported_cli),
        ..routes(store)
    }
}

#[tokio::test]
async fn pi_override_to_json_dropped_pi_is_terminal_only() {
    // pi can't run Rich Chat, so a persisted defaultChannelByCli
    // override {pi: json} is DROPPED (resolve_effective_default_channel falls
    // back to the plugin's Tmux default) instead of winning.
    let (home, _guard) = home_with_modes(&[("pi-mode", "Pi Mode", "pi")]);
    std::fs::write(
        home.path().join(".vibe-station").join("config.json"),
        r#"{"defaultChannelByCli": {"pi": "json"}}"#,
    )
    .unwrap();
    let (_d, store) = store();
    add_project(&store, make_project("p1")).await;
    let r = routes(store.clone());
    let s = create_direct_agent(&r, "p1", "pi-mode").await;
    assert_eq!(s.channel, Channel::Tmux);
}

#[tokio::test]
async fn agy_json_override_wins() {
    // agy supports Rich Chat, so a persisted {agy: json} override is honoured.
    let (home, _guard) = home_with_modes(&[("agy-mode", "Agy Mode", "agy")]);
    std::fs::write(
        home.path().join(".vibe-station").join("config.json"),
        r#"{"defaultChannelByCli": {"agy": "json"}}"#,
    )
    .unwrap();
    let (_d, store) = store();
    add_project(&store, make_project("p1")).await;
    let r = routes(store.clone());
    let s = create_direct_agent(&r, "p1", "agy-mode").await;
    assert_eq!(s.channel, Channel::Json);
}

#[tokio::test]
async fn start_draft_pi_explicit_json_rejected() {
    // pi can't run Rich Chat — promoting a draft with an explicit
    // `channel: json` for a pi mode must be rejected (400).
    let (_home, _guard) = home_with_modes(&[("pi-mode", "Pi Mode", "pi")]);
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s-draft", "p1");
    s.lifecycle.state = LifecycleState::Drafting;
    s.draft_prompt = Some("initial".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes_with_real_json_gate(store.clone());
    let body = StartDraftBody {
        draft_prompt: "do it".into(),
        draft_config: DraftConfig {
            entry_point: DraftEntryPoint::Direct,
            mode_id: Some("pi-mode".into()),
            channel: Some(Channel::Json), // explicit json -> must be rejected
            channel_explicit: Some(true),
            worktree_choice: None,
            existing_worktree_id: None,
            branch: None,
            base_branch: None,
            use_tmux: None,
            use_worktree: None,
        },
        skip_auto_turn: Some(true),
    };
    let err = r.start_session("s-draft", &body).await.unwrap_err();
    assert!(
        matches!(err, StartError::Validation(m) if m.contains("does not support JSON chat mode"))
    );
}

#[tokio::test]
async fn reset_explicit_json_on_pi_mode_rejected_400() {
    let (_home, _guard) = home_with_modes(&[
        ("claude-mode", "Claude Mode", "claude"),
        ("pi-mode", "Pi Mode", "pi"),
    ]);
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut old = json_session("s1", "p1");
    old.mode_id = Some("claude-mode".into());
    p.direct_sessions.push(old);
    add_project(&store, p).await;

    let r = routes_with_real_json_gate(store.clone());
    let body = ResetBody {
        mode_id: Some("pi-mode".into()),
        channel: Some(Channel::Json),
        ..reset_body()
    };
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(
        matches!(err, ResetError::JsonUnsupported(_)),
        "expected JsonUnsupported, got {:?}",
        err
    );
}
