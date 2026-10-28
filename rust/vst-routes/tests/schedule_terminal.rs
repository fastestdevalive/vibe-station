//! Terminal (tmux) scheduling through the route layer: create rules, row
//! actions, the snapshot, the outcome observer on every real path, channel
//! flips, reset and session delete. The pane is scripted; the store, resolver,
//! poller and delivery owner are the real ones.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::schedule_poller::SchedulePollerHandle;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_proc::tmux::{PaneFlags, Tmux};
use vst_review::{OutcomeObserver, PaneIo};
use vst_routes::sessions::{ChatRouteError, ResetError, SessionRoutes};
use vst_routes::terminal_delivery::build_terminal_delivery;
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::sessions::{CreateScheduledMessageBody, ResetBody};
use vst_types::terminal_delivery::{FailureKind, PaneSnapshot, TerminalOutcome};
use vst_types::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionNameSource, SessionRecord,
    SessionType,
};
use vst_ws::state::attachment_registry::AttachmentRegistry;

const FUTURE: &str = "2099-01-01T00:00:00Z";
const PAST_ROW: &str = "2000-01-01T00:00:00Z";

// ── scripted pane ───────────────────────────────────────────────────────────

struct FakePane {
    names: Mutex<HashSet<String>>,
    pastes: Mutex<Vec<String>>,
}

impl FakePane {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            names: Mutex::new(["vst-s1", "vst-s2"].into_iter().map(String::from).collect()),
            pastes: Mutex::new(vec![]),
        })
    }
}

impl PaneIo for FakePane {
    fn list_session_names(&self) -> Option<HashSet<String>> {
        Some(self.names.lock().unwrap().clone())
    }
    fn pane_flags(&self, _: &str) -> Option<PaneFlags> {
        Some(PaneFlags {
            in_mode: false,
            dead: false,
        })
    }
    fn capture(&self, _: &str) -> Result<PaneSnapshot, String> {
        // Not a ready prompt: nothing is ever pasted in these tests.
        Ok(PaneSnapshot {
            text: "starting up".into(),
            cursor_x: 0,
            cursor_y: 0,
        })
    }
    fn cancel_mode(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn paste(&self, _: &str, _: &str, text: &str, _: bool) -> Result<(), String> {
        self.pastes.lock().unwrap().push(text.to_string());
        Ok(())
    }
    fn send_enter(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

type Outcomes = Arc<Mutex<Vec<(String, TerminalOutcome)>>>;

fn observer() -> (OutcomeObserver, Outcomes) {
    let log: Outcomes = Arc::new(Mutex::new(vec![]));
    let l = log.clone();
    (Arc::new(move |id, o| l.lock().unwrap().push((id, o))), log)
}

// ── fixtures ────────────────────────────────────────────────────────────────

fn session(id: &str, channel: Channel, mode: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some(mode.into()),
        mode_icon: None,
        name: Some("Agent".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: format!("vst-{id}"),
        use_tmux: channel == Channel::Tmux,
        channel: Some(channel),
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
    }
}

fn project(sessions: Vec<SessionRecord>) -> ProjectRecord {
    ProjectRecord {
        id: "p1".into(),
        absolute_path: "/repos/p1".into(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: sessions,
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    }
}

/// A temp home whose modes.json has a claude mode (terminal delivery proven)
/// and an opencode mode (not proven).
fn home() -> (tempfile::TempDir, vst_agents::home::HomeGuard) {
    let home = tempdir().unwrap();
    let dir = home.path().join(".vibe-station");
    std::fs::create_dir_all(&dir).unwrap();
    let mode = |id: &str, cli: &str| {
        serde_json::json!({
            "id": id, "name": id, "cli": cli, "context": "",
            "createdAt": "2026-01-01T00:00:00.000Z", "model": null, "icon": cli,
        })
    };
    std::fs::write(
        dir.join("modes.json"),
        serde_json::json!([mode("m-claude", "claude"), mode("m-oc", "opencode")]).to_string(),
    )
    .unwrap();
    let guard = with_home(home.path().to_path_buf());
    (home, guard)
}

struct Env {
    _dir: tempfile::TempDir,
    store: StoreHandle,
    bc: Broadcaster,
    pane: Arc<FakePane>,
    outcomes: Outcomes,
    routes: SessionRoutes,
    tmux_socket: String,
}

impl Drop for Env {
    fn drop(&mut self) {
        // The reset/delete paths talk to this isolated socket only.
        Tmux::with_socket(&self.tmux_socket).kill_server();
    }
}

async fn env(sessions: Vec<SessionRecord>) -> Env {
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.add_project(project(sessions)).await.unwrap();
    let bc = Broadcaster::new(64);
    let pane = FakePane::new();
    let (obs, outcomes) = observer();
    let socket = format!(
        "vst-sched-test-{}-{}",
        std::process::id(),
        uuid_like(dir.path())
    );
    let routes = SessionRoutes {
        store: store.clone(),
        broadcaster: bc.clone(),
        json_registry: Arc::new(JsonAgentRegistry::new()),
        direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
        direct_streams: Arc::new(Mutex::new(std::collections::HashMap::new())),
        tmux: Tmux::with_socket(&socket),
        daemon_port: 3999,
        json_unsupported: Arc::new(|_| None),
        subagent_notify: SubagentNotifyHandle::new(),
        attachment_registry: AttachmentRegistry::new(),
        model_catalog: Default::default(),
        handoff_timeout: Duration::from_secs(120),
        reset_cancels: Default::default(),
        terminal_delivery: build_terminal_delivery(
            store.clone(),
            bc.clone(),
            pane.clone(),
            Some(obs),
        ),
    };
    Env {
        _dir: dir,
        store,
        bc,
        pane,
        outcomes,
        routes,
        tmux_socket: socket,
    }
}

fn uuid_like(p: &std::path::Path) -> String {
    p.file_name().unwrap().to_string_lossy().replace('.', "")
}

fn body(message: &str) -> CreateScheduledMessageBody {
    CreateScheduledMessageBody {
        message: message.into(),
        attachment_ids: vec![],
        fire_at: FUTURE.into(),
        review_comment_ids: vec![],
    }
}

fn code_of(e: &ChatRouteError) -> &'static str {
    e.code()
}

async fn flip_channel(store: &StoreHandle, id: &str, channel: Channel) {
    let id = id.to_string();
    store
        .mutate_project("p1", move |p| {
            for s in &mut p.direct_sessions {
                if s.id == id {
                    s.channel = Some(channel);
                    s.use_tmux = channel == Channel::Tmux;
                }
            }
            Ok(p.clone())
        })
        .await
        .unwrap();
}

async fn wait_for<F, Fut>(what: &str, mut f: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let start = std::time::Instant::now();
    while !f().await {
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "timed out: {what}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ── create (6.T1, 6.T2, 6.T15) ──────────────────────────────────────────────

#[tokio::test]
async fn create_on_a_tmux_claude_session_stores_channel_origin_and_stripped_text() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Tmux, "m-claude")]).await;
    let res = e
        .routes
        .schedule_create("s1", body("hi\u{1b}[31m there\u{7}"))
        .await
        .unwrap();
    let row = e
        .store
        .get_scheduled_message(&res.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.channel.as_deref(), Some("tmux"));
    assert_eq!(row.origin.as_deref(), Some("schedule"));
    assert_eq!(row.message, "hi[31m there");
    assert_eq!(row.fire_at, FUTURE);

    let past = CreateScheduledMessageBody {
        fire_at: "2000-01-01T00:00:00Z".into(),
        ..body("x")
    };
    let err = e.routes.schedule_create("s1", past).await.unwrap_err();
    assert_eq!(code_of(&err), "BAD_REQUEST");
}

#[tokio::test]
async fn json_sessions_still_schedule_with_a_json_channel() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Json, "m-claude")]).await;
    let res = e.routes.schedule_create("s1", body("hello")).await.unwrap();
    let row = e
        .store
        .get_scheduled_message(&res.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.channel.as_deref(), Some("json"));
    assert_eq!(row.origin.as_deref(), Some("schedule"));
}

#[tokio::test]
async fn create_rejections_carry_typed_codes() {
    let (_h, _g) = home();
    let mut shell = session("shell", Channel::Tmux, "m-claude");
    shell.r#type = SessionType::Terminal;
    let mut exited = session("exited", Channel::Tmux, "m-claude");
    exited.lifecycle.state = LifecycleState::Exited;
    let mut done = session("done", Channel::Tmux, "m-claude");
    done.lifecycle.state = LifecycleState::Done;
    let mut archived = session("archived", Channel::Tmux, "m-claude");
    archived.archived_at = Some("2026-01-01T00:00:00Z".into());
    let e = env(vec![
        shell,
        session("pty", Channel::Pty, "m-claude"),
        exited,
        done,
        archived,
        session("unproven", Channel::Tmux, "m-oc"),
        session("nomode", Channel::Tmux, "deleted-mode"),
        session("ok", Channel::Tmux, "m-claude"),
    ])
    .await;

    let cases: [(&str, &str); 7] = [
        ("shell", "NOT_SCHEDULABLE"),
        ("pty", "NOT_SCHEDULABLE"),
        ("exited", "AGENT_EXITED"),
        ("done", "DONE"),
        ("archived", "ARCHIVED"),
        ("unproven", "TERMINAL_DELIVERY_UNSUPPORTED"),
        ("nomode", "TERMINAL_DELIVERY_UNSUPPORTED"),
    ];
    for (id, code) in cases {
        let err = e.routes.schedule_create(id, body("hi")).await.unwrap_err();
        assert_eq!(code_of(&err), code, "{id}: {err:?}");
    }
    // Attachments on Terminal; whitespace-only after strip; one byte over 32 KB.
    let with_att = CreateScheduledMessageBody {
        attachment_ids: vec!["a".into()],
        ..body("hi")
    };
    assert_eq!(
        code_of(&e.routes.schedule_create("ok", with_att).await.unwrap_err()),
        "BAD_REQUEST"
    );
    assert_eq!(
        code_of(
            &e.routes
                .schedule_create("ok", body("\u{1b}\u{7}  "))
                .await
                .unwrap_err()
        ),
        "BAD_REQUEST"
    );
    let big = "x".repeat(32 * 1024 + 1);
    assert_eq!(
        code_of(
            &e.routes
                .schedule_create("ok", body(&big))
                .await
                .unwrap_err()
        ),
        "BAD_REQUEST"
    );
    // Exactly 32 KB is accepted.
    let exact = "x".repeat(32 * 1024);
    e.routes.schedule_create("ok", body(&exact)).await.unwrap();
    // Unknown session.
    assert_eq!(
        code_of(
            &e.routes
                .schedule_create("nope", body("hi"))
                .await
                .unwrap_err()
        ),
        "NOT_FOUND"
    );
}

#[tokio::test]
async fn the_pending_cap_counts_schedule_rows_only() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Tmux, "m-claude")]).await;
    for i in 0..99 {
        e.store
            .insert_scheduled_message(
                &format!("r{i}"),
                "s1",
                "x",
                None,
                FUTURE,
                PAST_ROW,
                Some("tmux"),
                None,
                Some("schedule"),
            )
            .await
            .unwrap();
    }
    for i in 0..5 {
        e.store
            .insert_scheduled_message(
                &format!("i{i}"),
                "s1",
                "x",
                None,
                FUTURE,
                PAST_ROW,
                Some("tmux"),
                None,
                Some("immediate"),
            )
            .await
            .unwrap();
    }
    // 99 schedule rows + 5 immediate: one more is allowed...
    e.routes
        .schedule_create("s1", body("the hundredth"))
        .await
        .unwrap();
    // ...and now 100 schedule rows: refused.
    let err = e
        .routes
        .schedule_create("s1", body("one too many"))
        .await
        .unwrap_err();
    assert_eq!(code_of(&err), "BAD_REQUEST");
}

// ── row actions (6.T4) ──────────────────────────────────────────────────────

/// A row scheduled under Rich Chat, picked up by Terminal delivery after a
/// channel flip, is cancelled through the delivery owner (observer fires once).
#[tokio::test]
async fn a_json_row_picked_up_by_terminal_delivery_cancels_through_the_owner() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Json, "m-claude")]).await;
    let id = e.routes.schedule_create("s1", body("go")).await.unwrap().id;
    let row = e.store.get_scheduled_message(&id).await.unwrap().unwrap();
    assert_eq!(row.channel.as_deref(), Some("json"));

    flip_channel(&e.store, "s1", Channel::Tmux).await;
    e.routes.schedule_send_now("s1", &id).await.unwrap();
    let row = e.store.get_scheduled_message(&id).await.unwrap().unwrap();
    assert_eq!(
        row.channel.as_deref(),
        Some("json"),
        "stored channel is unchanged"
    );
    assert_eq!(row.delivery_phase.as_deref(), Some("waiting"));

    e.routes.schedule_cancel("s1", &id).await.unwrap();
    assert!(e.store.get_scheduled_message(&id).await.unwrap().is_none());
    assert_eq!(
        e.outcomes.lock().unwrap().clone(),
        vec![(id.clone(), TerminalOutcome::Cancelled)]
    );
}

#[tokio::test]
async fn send_now_cancel_retry_and_dismiss_on_tmux_rows() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Tmux, "m-claude")]).await;

    // send-now claims + fires: the row is visible as waiting, still pending.
    let id = e.routes.schedule_create("s1", body("go")).await.unwrap().id;
    e.routes.schedule_send_now("s1", &id).await.unwrap();
    let row = e.store.get_scheduled_message(&id).await.unwrap().unwrap();
    assert_eq!(row.delivery_phase.as_deref(), Some("waiting"));
    // Send now means due now: fireAt is no longer in the future.
    assert!(
        row.fire_at <= vst_lifecycle::util::now_iso(),
        "fireAt {} should be <= now",
        row.fire_at
    );
    // A waiting row can't be sent now again (404), but it can be cancelled.
    let err = e.routes.schedule_send_now("s1", &id).await.unwrap_err();
    assert_eq!(code_of(&err), "TURN_NOT_FOUND");
    e.routes.schedule_cancel("s1", &id).await.unwrap();
    assert!(e.store.get_scheduled_message(&id).await.unwrap().is_none());
    assert_eq!(
        e.outcomes.lock().unwrap().clone(),
        vec![(id.clone(), TerminalOutcome::Cancelled)]
    );

    // Cancel while pasting: 409 ALREADY_DELIVERING, the row stays.
    let id2 = e
        .routes
        .schedule_create("s1", body("go 2"))
        .await
        .unwrap()
        .id;
    e.routes.schedule_send_now("s1", &id2).await.unwrap();
    assert!(e
        .store
        .mark_scheduled_phase(&id2, Some("waiting"), "pasting", "2026-01-01T00:00:00Z")
        .await
        .unwrap());
    let err = e.routes.schedule_cancel("s1", &id2).await.unwrap_err();
    assert_eq!(code_of(&err), "ALREADY_DELIVERING");
    assert!(e.store.get_scheduled_message(&id2).await.unwrap().is_some());

    // Retry clears kind/phase/claim; dismiss deletes a failed row.
    assert!(e
        .store
        .mark_scheduled_message_failed(&id2, "boom", Some("error"), "2026-01-01T00:00:00Z")
        .await
        .unwrap());
    e.routes.schedule_retry("s1", &id2).await.unwrap();
    let r = e.store.get_scheduled_message(&id2).await.unwrap().unwrap();
    assert_eq!(
        (
            r.status.as_str(),
            r.failure_kind,
            r.delivery_phase,
            r.claimed_at
        ),
        ("pending", None, None, None)
    );
    let id3 = e
        .routes
        .schedule_create("s1", body("dismiss me"))
        .await
        .unwrap()
        .id;
    assert!(e
        .store
        .claim_scheduled_message(&id3, "s1", "2026-01-01T00:00:00Z")
        .await
        .unwrap()
        .is_some());
    assert!(e
        .store
        .mark_scheduled_message_failed(&id3, "x", Some("timed_out"), "2026-01-01T00:00:00Z")
        .await
        .unwrap());
    e.routes.schedule_dismiss("s1", &id3).await.unwrap();
    assert!(e.store.get_scheduled_message(&id3).await.unwrap().is_none());

    // Edit is only for a not-yet-fired row.
    let id4 = e
        .routes
        .schedule_create("s1", body("later"))
        .await
        .unwrap()
        .id;
    e.routes
        .schedule_edit(
            "s1",
            &id4,
            vst_types::rest::sessions::EditScheduledMessageBody {
                fire_at: "2099-02-01T00:00:00Z".into(),
            },
        )
        .await
        .unwrap();
    e.routes.schedule_send_now("s1", &id4).await.unwrap();
    let err = e
        .routes
        .schedule_edit(
            "s1",
            &id4,
            vst_types::rest::sessions::EditScheduledMessageBody {
                fire_at: "2099-03-01T00:00:00Z".into(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(code_of(&err), "TURN_NOT_FOUND");
    // Jobs idle in `waiting`; make sure no test left a live job behind.
    e.routes.terminal_delivery.shutdown();
}

#[tokio::test]
async fn cancelling_a_json_row_reports_nothing_to_the_observer() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Json, "m-claude")]).await;
    let id = e
        .routes
        .schedule_create("s1", body("hello"))
        .await
        .unwrap()
        .id;
    e.routes.schedule_cancel("s1", &id).await.unwrap();
    assert!(e.outcomes.lock().unwrap().is_empty());
}

// ── GET /schedule (6.T11) ───────────────────────────────────────────────────

#[tokio::test]
async fn schedule_list_returns_pending_failed_and_recent_pasted() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Tmux, "m-claude")]).await;
    let scheduled = e
        .routes
        .schedule_create("s1", body("scheduled"))
        .await
        .unwrap()
        .id;
    let waiting = e
        .routes
        .schedule_create("s1", body("waiting"))
        .await
        .unwrap()
        .id;
    e.routes.schedule_send_now("s1", &waiting).await.unwrap();
    let pasting = e
        .routes
        .schedule_create("s1", body("pasting"))
        .await
        .unwrap()
        .id;
    e.routes.schedule_send_now("s1", &pasting).await.unwrap();
    e.store
        .mark_scheduled_phase(&pasting, Some("waiting"), "pasting", "2026-01-01T00:00:00Z")
        .await
        .unwrap();
    let failed = e
        .routes
        .schedule_create("s1", body("failed"))
        .await
        .unwrap()
        .id;
    e.store
        .claim_scheduled_message(&failed, "s1", "2026-01-01T00:00:00Z")
        .await
        .unwrap();
    e.store
        .mark_scheduled_message_failed(
            &failed,
            "Not ready within 10 min",
            Some("timed_out"),
            "2026-01-01T00:00:00Z",
        )
        .await
        .unwrap();
    // Four pasted rows just now: the list keeps the newest three.
    let now = vst_lifecycle::util::now_iso();
    for i in 0..4 {
        let id = format!("sent{i}");
        e.store
            .insert_scheduled_message(
                &id,
                "s1",
                &format!("pasted {i}"),
                None,
                FUTURE,
                PAST_ROW,
                Some("tmux"),
                None,
                Some("schedule"),
            )
            .await
            .unwrap();
        e.store
            .claim_scheduled_message(&id, "s1", &now)
            .await
            .unwrap();
        e.store
            .mark_scheduled_phase(&id, None, "waiting", &now)
            .await
            .unwrap();
        e.store
            .mark_scheduled_phase(&id, Some("waiting"), "pasting", &now)
            .await
            .unwrap();
        e.store
            .mark_scheduled_message_pasted(&id, &now)
            .await
            .unwrap();
    }

    let snap = e.routes.schedule_list("s1").await.unwrap();
    let phases: Vec<(String, String)> = snap
        .scheduled_sends
        .iter()
        .map(|m| (m.id.clone(), format!("{:?}", m.phase.unwrap())))
        .collect();
    assert_eq!(snap.scheduled_sends.len(), 3, "{phases:?}");
    for (id, want) in [
        (&scheduled, "Scheduled"),
        (&waiting, "Waiting"),
        (&pasting, "Pasting"),
    ] {
        assert!(
            phases.contains(&(id.clone(), want.to_string())),
            "{phases:?}"
        );
    }
    assert_eq!(snap.scheduled_failed.len(), 1);
    assert_eq!(
        snap.scheduled_failed[0].failure_kind.as_deref(),
        Some("timed_out")
    );
    assert_eq!(snap.scheduled_sent.len(), 3);
    assert!(snap
        .scheduled_sent
        .iter()
        .all(|s| s.channel.as_deref() == Some("tmux")));

    let err = e.routes.schedule_list("nope").await.unwrap_err();
    assert_eq!(code_of(&err), "NOT_FOUND");
    e.routes.terminal_delivery.shutdown();
}

// ── observer through the real paths (6.T13) ─────────────────────────────────

#[tokio::test]
async fn deleting_a_session_reports_gone_for_tmux_rows_only() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Tmux, "m-claude")]).await;
    let waiting = e.routes.schedule_create("s1", body("w")).await.unwrap().id;
    e.routes.schedule_send_now("s1", &waiting).await.unwrap();
    let scheduled = e.routes.schedule_create("s1", body("s")).await.unwrap().id;
    e.routes.delete_session("s1").await.unwrap();
    let mut got = e.outcomes.lock().unwrap().clone();
    got.sort_by(|a, b| a.0.cmp(&b.0));
    let mut want = vec![
        (waiting, TerminalOutcome::Gone),
        (scheduled, TerminalOutcome::Gone),
    ];
    want.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(got, want);
    // The rows were removed with the session.
    assert!(e
        .store
        .list_pending_scheduled_messages("s1")
        .await
        .unwrap()
        .is_empty());
    e.routes.terminal_delivery.shutdown();
}

#[tokio::test]
async fn deleting_a_json_session_reports_nothing() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Json, "m-claude")]).await;
    e.routes.schedule_create("s1", body("hello")).await.unwrap();
    e.routes.delete_session("s1").await.unwrap();
    assert!(e.outcomes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reset_moves_a_waiting_schedule_row_and_fails_an_immediate_one() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Tmux, "m-claude")]).await;
    let sched = e
        .routes
        .schedule_create("s1", body("keep me"))
        .await
        .unwrap()
        .id;
    e.routes.schedule_send_now("s1", &sched).await.unwrap();
    // An immediate send (part 04 shape): claimed + waiting from the start.
    e.store
        .insert_scheduled_message(
            "imm",
            "s1",
            "now",
            None,
            PAST_ROW,
            PAST_ROW,
            Some("tmux"),
            None,
            Some("immediate"),
        )
        .await
        .unwrap();
    let imm = e
        .store
        .claim_scheduled_message("imm", "s1", PAST_ROW)
        .await
        .unwrap()
        .unwrap();
    e.routes.terminal_delivery.fire(imm).await;

    let res = match e.routes.reset_session("s1", &ResetBody::default()).await {
        Ok(r) => r,
        Err(ResetError::Internal(m)) => panic!("reset failed: {m}"),
        Err(other) => panic!("reset failed: {other:?}"),
    };

    // The schedule row follows the user: pending, unclaimed, on the new session.
    let r = e
        .store
        .get_scheduled_message(&sched)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.session_id, res.new_session_id);
    assert_eq!(
        (r.status.as_str(), r.claimed_at, r.delivery_phase),
        ("pending", None, None)
    );
    // The immediate row failed `archived` and stayed on the old session.
    let i = e.store.get_scheduled_message("imm").await.unwrap().unwrap();
    assert_eq!(i.session_id, "s1");
    assert_eq!(
        (i.status.as_str(), i.failure_kind.as_deref()),
        ("failed", Some("archived"))
    );
    let mut got = e.outcomes.lock().unwrap().clone();
    got.sort_by(|a, b| a.0.cmp(&b.0));
    // The schedule row is left claimed for `reassign` (one statement moves and
    // un-claims it), so the reset reports no `Rearmed` for it.
    let mut want = vec![(
        "imm".to_string(),
        TerminalOutcome::Failed(FailureKind::Archived),
    )];
    let _ = &sched;
    want.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(got, want);
    e.routes.terminal_delivery.shutdown();
}

// ── channel flips (6.T5, 6.T6) ──────────────────────────────────────────────

fn poller_for(e: &Env) -> (SchedulePollerHandle, Arc<Mutex<Vec<String>>>) {
    let fired = Arc::new(Mutex::new(Vec::new()));
    let (delivery, f) = (e.routes.terminal_delivery.clone(), fired.clone());
    let poller = SchedulePollerHandle::new(
        e.store.clone(),
        e.bc.clone(),
        Arc::new(JsonAgentRegistry::new()),
        3999,
    )
    .with_terminal_fire(Arc::new(move |row| {
        let (delivery, f) = (delivery.clone(), f.clone());
        Box::pin(async move {
            f.lock().unwrap().push(row.id.clone());
            delivery.fire(row).await;
        })
    }));
    (poller, fired)
}

#[tokio::test]
async fn a_tmux_to_json_flip_rearms_schedule_rows_and_fails_immediate_rows() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Tmux, "m-claude")]).await;
    let (poller, fired) = poller_for(&e);

    let sched = e
        .routes
        .schedule_create("s1", body("later"))
        .await
        .unwrap()
        .id;
    e.routes.schedule_send_now("s1", &sched).await.unwrap();
    e.store
        .insert_scheduled_message(
            "imm",
            "s1",
            "now",
            None,
            PAST_ROW,
            PAST_ROW,
            Some("tmux"),
            None,
            Some("immediate"),
        )
        .await
        .unwrap();
    let imm = e
        .store
        .claim_scheduled_message("imm", "s1", PAST_ROW)
        .await
        .unwrap()
        .unwrap();
    e.routes.terminal_delivery.fire(imm).await;

    flip_channel(&e.store, "s1", Channel::Json).await;

    // The job notices the flip: the schedule row is released, the immediate
    // row fails; neither is ever pasted.
    let (store, id) = (e.store.clone(), sched.clone());
    wait_for("schedule row re-armed", || {
        let (store, id) = (store.clone(), id.clone());
        async move {
            store
                .get_scheduled_message(&id)
                .await
                .unwrap()
                .unwrap()
                .claimed_at
                .is_none()
        }
    })
    .await;
    let i = e.store.get_scheduled_message("imm").await.unwrap().unwrap();
    assert_eq!(
        (i.status.as_str(), i.failure_kind.as_deref()),
        ("failed", Some("channel_unsupported"))
    );
    let mut got = e.outcomes.lock().unwrap().clone();
    got.sort_by(|a, b| a.0.cmp(&b.0));
    let mut want = vec![
        (
            "imm".to_string(),
            TerminalOutcome::Failed(FailureKind::ChannelUnsupported),
        ),
        (sched.clone(), TerminalOutcome::Rearmed),
    ];
    want.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(got, want);
    assert!(e.pane.pastes.lock().unwrap().is_empty());

    // Re-armed rows are due (fireAt is in the future here, so make it due) and
    // the poller delivers them down the Rich Chat path, not to the terminal.
    e.store
        .reschedule_scheduled_message(&sched, "s1", PAST_ROW, PAST_ROW)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(20), poller.run_poll_once())
        .await
        .expect("json delivery attempt returns");
    assert!(
        fired.lock().unwrap().is_empty(),
        "never handed to terminal delivery again"
    );
    assert_ne!(
        e.store
            .get_scheduled_message(&sched)
            .await
            .unwrap()
            .unwrap()
            .status,
        "pending"
    );
    e.routes.terminal_delivery.shutdown();
}

#[tokio::test]
async fn a_json_to_tmux_flip_fails_a_row_with_attachments() {
    let (_h, _g) = home();
    let e = env(vec![session("s2", Channel::Json, "m-claude")]).await;
    let (poller, fired) = poller_for(&e);
    e.store
        .insert_scheduled_message(
            "a1",
            "s2",
            "see attached",
            Some("[{\"id\":\"u1\"}]"),
            PAST_ROW,
            PAST_ROW,
            Some("json"),
            None,
            Some("schedule"),
        )
        .await
        .unwrap();
    flip_channel(&e.store, "s2", Channel::Tmux).await;

    poller.run_poll_once().await;
    assert_eq!(*fired.lock().unwrap(), vec!["a1".to_string()]);
    let store = e.store.clone();
    wait_for("attachments row failed", || {
        let store = store.clone();
        async move {
            store
                .get_scheduled_message("a1")
                .await
                .unwrap()
                .unwrap()
                .status
                == "failed"
        }
    })
    .await;
    let r = e.store.get_scheduled_message("a1").await.unwrap().unwrap();
    assert_eq!(r.failure_kind.as_deref(), Some("channel_unsupported"));
    assert!(r.failure_reason.unwrap().contains("Attachments"));
    assert!(e.pane.pastes.lock().unwrap().is_empty());
    e.routes.terminal_delivery.shutdown();
}

// ── boot recovery (6.T13) ───────────────────────────────────────────────────

#[tokio::test]
async fn boot_recovery_is_reported_to_the_observer() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Tmux, "m-claude")]).await;
    let (poller, _fired) = poller_for(&e);
    // Left behind by a dead daemon: one waiting, one pasting.
    for (id, phase) in [("w", "waiting"), ("p", "pasting")] {
        e.store
            .insert_scheduled_message(
                id,
                "s1",
                "x",
                None,
                PAST_ROW,
                PAST_ROW,
                Some("tmux"),
                None,
                Some("schedule"),
            )
            .await
            .unwrap();
        e.store
            .claim_scheduled_message(id, "s1", PAST_ROW)
            .await
            .unwrap();
        e.store
            .mark_scheduled_phase(id, None, "waiting", PAST_ROW)
            .await
            .unwrap();
        if phase == "pasting" {
            e.store
                .mark_scheduled_phase(id, Some("waiting"), "pasting", PAST_ROW)
                .await
                .unwrap();
        }
    }
    let recovery = poller.recover_orphans().await;
    e.routes.terminal_delivery.report_recovery(recovery).await;
    let mut got = e.outcomes.lock().unwrap().clone();
    got.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        got,
        vec![
            (
                "p".to_string(),
                TerminalOutcome::Failed(FailureKind::RestartedMidPaste)
            ),
            ("w".to_string(), TerminalOutcome::Rearmed),
        ]
    );
}

// ── push to every subscriber (6.T7) ─────────────────────────────────────────

#[tokio::test]
async fn every_subscriber_hears_create_waiting_and_cancel() {
    let (_h, _g) = home();
    let e = env(vec![session("s1", Channel::Tmux, "m-claude")]).await;
    let mut a = e.bc.subscribe();
    let mut b = e.bc.subscribe();
    let id = e.routes.schedule_create("s1", body("hi")).await.unwrap().id;
    e.routes.schedule_send_now("s1", &id).await.unwrap();
    e.routes.schedule_cancel("s1", &id).await.unwrap();

    async fn phases(rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>) -> Vec<Option<String>> {
        let mut out = vec![];
        while let Ok(ev) = rx.try_recv() {
            if let ServerEvent::SessionScheduledChanged {
                scheduled_sends, ..
            } = ev
            {
                out.push(
                    scheduled_sends
                        .first()
                        .and_then(|m| m.phase)
                        .map(|p| format!("{p:?}")),
                );
            }
        }
        out
    }
    let (pa, pb) = (phases(&mut a).await, phases(&mut b).await);
    assert_eq!(pa, pb, "both subscribers saw the same sequence");
    assert_eq!(
        pa,
        vec![
            Some("Scheduled".to_string()), // create
            Some("Waiting".to_string()),   // send-now -> waiting
            None,                          // cancelled: no rows left
        ]
    );
    e.routes.terminal_delivery.shutdown();
}
