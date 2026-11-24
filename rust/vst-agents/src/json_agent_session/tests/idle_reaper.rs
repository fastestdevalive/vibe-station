//! The idle reaper's skip conditions (B3.T2-T4). Every case reaps with
//! `after = ZERO` (or an explicit window) instead of waiting 2 hours.

use std::path::{Path, PathBuf};
use std::time::Duration;

use vst_tasks::TaskObservation;

use super::*;
use crate::acp_connection::AcpLaunchSpec;
use crate::acp_transport::AcpTransport;

/// Detects background work from the event text, like a harness would.
struct TaskPlugin;

impl AgentPlugin for TaskPlugin {
    fn name(&self) -> &str {
        "tasks"
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
    fn default_channel(&self) -> vst_types::Channel {
        vst_types::Channel::Json
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
    fn task_observations(&self, ev: &NormalizedEvent) -> Vec<TaskObservation> {
        match ev.text.as_deref() {
            Some("subagent") => vec![TaskObservation::SubagentStarted {
                tool_id: "sub1".into(),
                label: "sub".into(),
                background: true,
            }],
            Some("command") => vec![
                TaskObservation::CommandLaunched {
                    tool_id: "cmd1".into(),
                    command: "sleep 9999".into(),
                },
                TaskObservation::CommandBackgrounded {
                    tool_id: "cmd1".into(),
                    task_id: "bg1".into(),
                    output_path: None,
                },
            ],
            _ => vec![],
        }
    }
}

fn spec() -> AcpLaunchSpec {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![manifest
            .join("tests/fixtures/fakeAcpAgent.mjs")
            .to_string_lossy()
            .into_owned()],
        cwd: manifest,
        env: std::collections::HashMap::new(),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
        open_tool_idle_timeout_ms: None,
    }
}

/// A session with a live fake-adapter child, its temp home guard alive.
async fn live(dir: &Path) -> (JsonAgentSession, AcpConnection) {
    // `session_with_plugin` takes the (non-reentrant) home guard itself.
    let s = session_with_plugin(dir, Arc::new(TaskPlugin));
    let conn = s.get_or_create_connection(spec(), None).await.unwrap();
    // Let the rebuild settle so task observations are applied, not buffered.
    s.rebuild_tasks_from_transcript_for_test();
    (s, conn)
}

fn text_event(text: &str) -> NormalizedEvent {
    let mut ev = NormalizedEvent::default();
    ev.text = Some(text.to_string());
    ev
}

async fn assert_kept(s: &JsonAgentSession, conn: &AcpConnection, after: Duration, why: &str) {
    assert!(!s.reap_agent_if_idle(after).await, "reaped despite: {why}");
    assert!(s.has_live_connection_for_test(), "{why}");
    assert!(conn.is_alive(), "{why}");
}

#[tokio::test]
async fn an_idle_session_is_reaped_but_each_busy_signal_keeps_it() {
    type Mutate = fn(&JsonAgentSession);
    let cases: [(&str, Mutate); 5] = [
        ("running", |s| s.0.state.lock().unwrap().running = true),
        ("queued turn", |s| {
            let turn = QueuedTurn {
                turn_id: "q".into(),
                enqueue_order: 0,
                raw_message: "m".into(),
                attachments: vec![],
                fork_from_chat_id: None,
                silent: false,
                mentions: vec![],
                review: None,
            };
            s.0.state.lock().unwrap().queue.push_back(turn);
        }),
        ("held review turn", |s| {
            let held = HeldTurn {
                turn: QueuedTurn {
                    turn_id: "h".into(),
                    enqueue_order: 0,
                    raw_message: "m".into(),
                    attachments: vec![],
                    fork_from_chat_id: None,
                    silent: false,
                    mentions: vec![],
                    review: None,
                },
                ahead_ids: vec![],
            };
            s.0.state.lock().unwrap().holds.insert("h".into(), held);
        }),
        ("open background window", |s| {
            s.0.state.lock().unwrap().bg_working = true
        }),
        ("running subagent", |s| {
            s.0.tasks.observe(&text_event("subagent"))
        }),
    ];
    for (why, mutate) in cases {
        let dir = tempfile::tempdir().unwrap();
        let (s, conn) = live(dir.path()).await;
        mutate(&s);
        assert_kept(&s, &conn, Duration::ZERO, why).await;
        conn.dispose().await;
    }
}

#[tokio::test]
async fn an_agent_without_load_session_is_never_reaped() {
    let dir = tempfile::tempdir().unwrap();
    let s = session_with_plugin(dir.path(), Arc::new(TaskPlugin));
    let mut sp = spec();
    sp.env
        .insert("FAKE_ACP_MODE".into(), "no_load_session".into());
    let conn = s.get_or_create_connection(sp, None).await.unwrap();
    assert!(!conn.supports_load_session());
    assert_kept(&s, &conn, Duration::ZERO, "no loadSession").await;
    conn.dispose().await;
}

#[tokio::test]
async fn recent_activity_keeps_the_agent_until_the_window_passes() {
    let dir = tempfile::tempdir().unwrap();
    let (s, conn) = live(dir.path()).await;
    assert_kept(&s, &conn, Duration::from_secs(3600), "busy a moment ago").await;
    assert!(s.reap_agent_if_idle(Duration::ZERO).await);
    assert!(!s.has_live_connection_for_test());
}

#[tokio::test]
async fn a_task_in_its_grace_window_or_with_a_lapsed_hold_keeps_the_agent() {
    // Grace: a held task ends because its adapter was replaced.
    let dir = tempfile::tempdir().unwrap();
    let (s, conn) = live(dir.path()).await;
    s.0.tasks.observe(&text_event("subagent"));
    s.0.tasks.bump_epoch();
    let hold = s.0.tasks.hold();
    assert!(hold.holding == 0 && hold.grace_active, "{hold:?}");
    assert_kept(&s, &conn, Duration::ZERO, "grace window").await;
    conn.dispose().await;
}

#[tokio::test]
async fn a_lapsed_but_still_running_task_keeps_the_agent() {
    let dir = tempfile::tempdir().unwrap();
    let (s, conn) = live(dir.path()).await;
    // Paused only after the child is up: a paused clock would fire its init timeout.
    tokio::time::pause();
    s.0.tasks.observe(&text_event("command"));
    tokio::time::advance(Duration::from_secs(11 * 60)).await;
    let hold = s.0.tasks.hold();
    assert!(!hold.lapsed.is_empty(), "{hold:?}");
    assert_kept(&s, &conn, Duration::ZERO, "lapsed task").await;
    conn.dispose().await;
}

#[tokio::test]
async fn an_attached_listener_keeps_the_agent_until_every_one_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let (s, conn) = live(dir.path()).await;
    let a = s.0.stream.subscribe_message(Box::new(|_| {}));
    let b = s.0.stream.subscribe_message(Box::new(|_| {}));
    assert_kept(&s, &conn, Duration::ZERO, "two listeners").await;
    drop(a);
    assert_kept(&s, &conn, Duration::ZERO, "one listener").await;
    drop(b);
    assert!(s.reap_agent_if_idle(Duration::ZERO).await);
}

#[tokio::test]
async fn a_pending_scheduled_message_keeps_the_agent_until_it_is_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let (s, conn) = live(dir.path()).await;
    s.0.store_handle
        .insert_scheduled_message(
            "sched1",
            "s1",
            "later",
            None,
            "2999-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert_kept(&s, &conn, Duration::ZERO, "pending schedule row").await;
    s.0.store_handle
        .cancel_scheduled_message("sched1", "s1")
        .await
        .unwrap();
    assert!(s.reap_agent_if_idle(Duration::ZERO).await);
}
