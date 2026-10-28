//! Review comments through the schedule routes and the Terminal delivery owner
//! (plan 04, Phase 3): schedule with comments (snapshot, size check, cancel /
//! dismiss / retry restore), channel flips and reset around waiting rows, session
//! delete. Real `ReviewHandle`, delivery owner, resolver and store; the pane is
//! scripted.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_proc::tmux::{PaneFlags, Tmux};
use vst_review::{PaneIo, ReviewHandle, TerminalWiring};
use vst_routes::sessions::{ChatRouteError, SessionRoutes};
use vst_routes::terminal_delivery::{build_terminal_delivery, target_resolver};
use vst_store::StoreHandle;
use vst_types::artifacts::ScopeKey;
use vst_types::events::Broadcaster;
use vst_types::rest::review::{CreateCommentBody, CreateTerminalDeliveryBody};
use vst_types::rest::sessions::CreateScheduledMessageBody;
use vst_types::review::{
    CommentSurface, PathKind, PayloadState, ReviewComment, ReviewError, ScheduledReviewPayload,
};
use vst_types::terminal_delivery::PaneSnapshot;
use vst_types::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionNameSource, SessionRecord,
    SessionType,
};
use vst_ws::state::attachment_registry::AttachmentRegistry;

const FUTURE: &str = "2099-01-01T00:00:00Z";
const NOW: &str = "2026-01-01T00:00:00Z";

// ── scripted pane ───────────────────────────────────────────────────────────

struct FakePane {
    ready: Mutex<bool>,
    pastes: Mutex<Vec<String>>,
}

impl PaneIo for FakePane {
    fn list_session_names(&self) -> Option<HashSet<String>> {
        Some(["vst-s1", "vst-s2"].into_iter().map(String::from).collect())
    }
    fn pane_flags(&self, _: &str) -> Option<PaneFlags> {
        Some(PaneFlags {
            in_mode: false,
            dead: false,
        })
    }
    fn capture(&self, _: &str) -> Result<PaneSnapshot, String> {
        if *self.ready.lock().unwrap() && self.pastes.lock().unwrap().is_empty() {
            return Ok(PaneSnapshot {
                text: "welcome\n──────────\n❯ \n──────────\nfooter".into(),
                cursor_x: 2,
                cursor_y: 2,
            });
        }
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

// ── fixtures ────────────────────────────────────────────────────────────────

fn session(id: &str, channel: Channel) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("m-claude".into()),
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

fn project() -> ProjectRecord {
    ProjectRecord {
        id: "p1".into(),
        absolute_path: "/repos/p1".into(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![session("s1", Channel::Tmux), session("s2", Channel::Json)],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    }
}

fn write_modes(home: &std::path::Path) {
    let dir = home.join(".vibe-station");
    std::fs::create_dir_all(&dir).unwrap();
    let mode = serde_json::json!({
        "id": "m-claude", "name": "m-claude", "cli": "claude", "context": "",
        "createdAt": "2026-01-01T00:00:00.000Z", "model": null, "icon": "claude",
    });
    std::fs::write(
        dir.join("modes.json"),
        serde_json::json!([mode]).to_string(),
    )
    .unwrap();
}

struct Env {
    _home: tempfile::TempDir,
    _guard: vst_agents::home::HomeGuard,
    _dir: tempfile::TempDir,
    store: StoreHandle,
    review: ReviewHandle,
    routes: SessionRoutes,
    pane: Arc<FakePane>,
    scope: ScopeKey,
    socket: String,
}

impl Drop for Env {
    fn drop(&mut self) {
        self.routes.terminal_delivery.shutdown();
        Tmux::with_socket(&self.socket).kill_server();
    }
}

async fn env() -> Env {
    let home = tempdir().unwrap();
    write_modes(home.path());
    let guard = with_home(home.path().to_path_buf());
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.add_project(project()).await.unwrap();
    let bc = Broadcaster::new(256);
    let artifacts = vst_artifacts::ArtifactsHandle::new(
        store.clone(),
        bc.clone(),
        Arc::new(vst_artifacts::StoreResolver::new(
            store.clone(),
            home.path().join(".vibe-station"),
        )),
    );
    let review = ReviewHandle::new(store.clone(), bc.clone(), artifacts);
    let pane = Arc::new(FakePane {
        ready: Mutex::new(false),
        pastes: Mutex::new(vec![]),
    });
    let delivery = build_terminal_delivery(
        store.clone(),
        bc.clone(),
        pane.clone(),
        Some(review.terminal_observer()),
    )
    .with_paste_body(vst_review::review_paste_body())
    .with_row_capture(review.terminal_row_capture());
    review.attach_terminal(TerminalWiring {
        delivery: delivery.clone(),
        resolver: target_resolver(store.clone()),
    });
    let socket = format!(
        "vst-rt-test-{}-{}",
        std::process::id(),
        dir.path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace('.', "")
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
        terminal_delivery: delivery,
    };
    let (port, observer) = vst_review::hooks(&review);
    routes.json_registry.set_review_hooks(port, observer);
    Env {
        _home: home,
        _guard: guard,
        _dir: dir,
        store,
        review,
        routes,
        pane,
        scope: ScopeKey::project("p1"),
        socket,
    }
}

impl Env {
    async fn comment(&self, id: &str, line: u32, quote_len: usize) {
        self.review
            .create(
                &self.scope,
                CreateCommentBody {
                    id: id.into(),
                    path: "src/f.rs".into(),
                    path_kind: PathKind::Repo,
                    surface: CommentSurface::File,
                    diff_scope: None,
                    base_sha: None,
                    side: None,
                    line_start: Some(line),
                    line_end: Some(line),
                    old_start: None,
                    old_end: None,
                    new_start: None,
                    new_end: None,
                    quote: if quote_len == 0 {
                        format!("quote of {id}")
                    } else {
                        "q".repeat(quote_len)
                    },
                    prefix: String::new(),
                    suffix: String::new(),
                    occurrence: 0,
                    text: if quote_len == 0 {
                        format!("text of {id}")
                    } else {
                        "t".repeat(8000)
                    },
                    restore_pin: None,
                },
            )
            .await
            .unwrap();
    }

    async fn panel(&self) -> Vec<ReviewComment> {
        self.review
            .list(&self.scope, None, false)
            .await
            .unwrap()
            .comments
    }

    /// Wait until a Terminal send's row has been handled and deleted: the
    /// definite end of its outcome (a late duplicate restore would come before it).
    async fn wait_row_gone(&self, id: &str) {
        let start = std::time::Instant::now();
        while self
            .store
            .get_scheduled_message(id)
            .await
            .unwrap()
            .is_some()
        {
            assert!(
                start.elapsed() < Duration::from_secs(15),
                "row {id} never went away"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.review.flush_events();
    }

    async fn wait_panel(&self, n: usize) -> Vec<ReviewComment> {
        let start = std::time::Instant::now();
        loop {
            let p = self.panel().await;
            if p.len() >= n {
                return p;
            }
            assert!(
                start.elapsed() < Duration::from_secs(15),
                "panel never reached {n}: {p:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn flip(&self, id: &str, channel: Channel) {
        let id = id.to_string();
        self.store
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

    fn reasons(panel: &[ReviewComment]) -> Vec<String> {
        let mut v: Vec<String> = panel
            .iter()
            .map(|c| {
                c.restored_reason
                    .map_or("none".to_string(), |r| r.as_str().to_string())
            })
            .collect();
        v.sort();
        v
    }
}

fn body(message: &str, ids: &[&str]) -> CreateScheduledMessageBody {
    CreateScheduledMessageBody {
        message: message.into(),
        attachment_ids: vec![],
        fire_at: FUTURE.into(),
        review_comment_ids: ids.iter().map(|s| s.to_string()).collect(),
    }
}

fn payload(row: &vst_types::rest::sessions::ScheduledMessageRow) -> ScheduledReviewPayload {
    ScheduledReviewPayload::parse(row.comments_snapshot.as_deref().unwrap()).unwrap()
}

// ── 3.T5 ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_rich_chat_schedule_with_comments_snapshots_and_cancel_restores() {
    let e = env().await;
    e.comment("c1", 1, 0).await;
    e.comment("c2", 2, 0).await;
    // Comments only (empty message) are allowed.
    let id = e
        .routes
        .schedule_create("s2", body("", &["c1", "c2"]))
        .await
        .unwrap()
        .id;
    assert!(e.panel().await.is_empty());
    let row = e.store.get_scheduled_message(&id).await.unwrap().unwrap();
    assert_eq!(row.origin.as_deref(), Some("schedule"));
    assert_eq!(row.channel.as_deref(), Some("json"));
    assert_eq!(row.message, "", "text is the user's message only");
    assert_eq!(payload(&row).state, PayloadState::Held);
    assert_eq!(payload(&row).comments.len(), 2);

    e.routes.schedule_cancel("s2", &id).await.unwrap();
    let back = e.wait_panel(2).await;
    assert_eq!(Env::reasons(&back), vec!["schedule_cancelled"; 2]);
    assert!(e.store.get_scheduled_message(&id).await.unwrap().is_none());

    // Without ids and without text a schedule is still refused.
    let err = e
        .routes
        .schedule_create("s2", body("", &[]))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "BAD_REQUEST");
}

#[tokio::test]
async fn dismissing_and_retrying_a_failed_row_follow_its_snapshot() {
    let e = env().await;
    e.comment("c1", 1, 0).await;
    // Failure of a held json row that nobody restored: dismiss puts it back.
    let id = e
        .routes
        .schedule_create("s2", body("note", &["c1"]))
        .await
        .unwrap()
        .id;
    e.store
        .claim_scheduled_message(&id, "s2", NOW)
        .await
        .unwrap()
        .unwrap();
    e.store
        .mark_scheduled_message_failed(&id, "boom", None, NOW)
        .await
        .unwrap();
    e.routes.schedule_dismiss("s2", &id).await.unwrap();
    let back = e.wait_panel(1).await;
    assert_eq!(Env::reasons(&back), vec!["schedule_cancelled"]);

    // A failed row whose comments already came back: Retry re-holds them.
    let id2 = e
        .routes
        .schedule_create("s2", body("again", &["c1"]))
        .await
        .unwrap()
        .id;
    e.store
        .claim_scheduled_message(&id2, "s2", NOW)
        .await
        .unwrap()
        .unwrap();
    // The fire failure path: restore (flips `restored`), then the row is failed.
    let row = e.store.get_scheduled_message(&id2).await.unwrap().unwrap();
    let p = payload(&row);
    vst_types::review::ReviewPort::restore_snapshot(
        &e.review,
        Some(&id2),
        vst_types::review::ReviewRecord {
            name: p.name.clone(),
            comments: p.comments.clone(),
        },
        e.scope.clone(),
        vst_types::review::RestoreReason::ScheduleFailed,
    )
    .await;
    e.store
        .mark_scheduled_message_failed(&id2, "boom", None, NOW)
        .await
        .unwrap();
    assert_eq!(e.panel().await.len(), 1);
    e.routes.schedule_retry("s2", &id2).await.unwrap();
    assert!(
        e.panel().await.is_empty(),
        "retry re-holds what is still there"
    );
    let row = e.store.get_scheduled_message(&id2).await.unwrap().unwrap();
    assert_eq!(row.status, "pending");
    assert_eq!(payload(&row).state, PayloadState::Held);
}

// ── 3.T5c ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_terminal_schedule_over_32_kb_is_413_at_create_and_holds_nothing() {
    let e = env().await;
    for i in 0..4u32 {
        e.comment(&format!("big{i}"), i + 1, 2048).await;
    }
    let ids: Vec<String> = (0..4).map(|i| format!("big{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let err = e
        .routes
        .schedule_create("s1", body("", &refs))
        .await
        .unwrap_err();
    match err {
        ChatRouteError::Review(ReviewError::TooLarge { limit, unit }) => {
            assert_eq!((limit, unit), (32_768, "bytes"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(e.panel().await.len(), 4, "nothing deleted");
    assert!(e
        .store
        .list_pending_scheduled_messages("s1")
        .await
        .unwrap()
        .is_empty());
    // The same comments are fine for a Rich Chat schedule (128 KB cap).
    e.routes
        .schedule_create("s2", body("", &refs))
        .await
        .unwrap();
}

// ── 3.T6 / 3.T6c ────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_channel_flip_fails_a_waiting_immediate_row_and_restores_once() {
    let e = env().await;
    e.comment("c1", 1, 0).await;
    let d = e
        .review
        .send_terminal(
            &e.scope,
            CreateTerminalDeliveryBody {
                terminal_delivery_id: "td-1".into(),
                session_id: "s1".into(),
                comment_ids: vec!["c1".into()],
                message: None,
                composer_key: None,
            },
        )
        .await
        .unwrap();
    assert!(e.panel().await.is_empty());
    e.flip("s1", Channel::Json).await;
    let back = e.wait_panel(1).await;
    e.wait_row_gone(&d.id).await;
    let back2 = e.panel().await;
    assert_eq!(back.len(), 1);
    assert_eq!(back2.len(), 1, "restored exactly once");
    assert_eq!(Env::reasons(&back2), vec!["send_failed"]);
    assert!(
        e.store
            .get_scheduled_message(&d.id)
            .await
            .unwrap()
            .is_none(),
        "the row is not reassigned or kept"
    );
    assert!(e.pane.pastes.lock().unwrap().is_empty());
    assert!(
        e.routes.json_registry.get("s1").is_none(),
        "no turn was enqueued"
    );
}

#[tokio::test]
async fn reset_fails_a_waiting_immediate_row_archived_and_a_schedule_row_stays_held_for_reassignment(
) {
    let e = env().await;
    e.comment("c1", 1, 0).await;
    e.comment("c2", 2, 0).await;
    let imm = e
        .review
        .send_terminal(
            &e.scope,
            CreateTerminalDeliveryBody {
                terminal_delivery_id: "td-1".into(),
                session_id: "s1".into(),
                comment_ids: vec!["c1".into()],
                message: None,
                composer_key: None,
            },
        )
        .await
        .unwrap();
    let sched = e
        .routes
        .schedule_create("s1", body("later", &["c2"]))
        .await
        .unwrap()
        .id;
    let row = e
        .store
        .claim_scheduled_message(&sched, "s1", NOW)
        .await
        .unwrap()
        .unwrap();
    e.routes.terminal_delivery.fire(row).await;

    // What `reset` does before archiving the old session.
    e.routes.terminal_delivery.stop_for_reset("s1").await;
    let back = e.wait_panel(1).await;
    e.wait_row_gone(&imm.id).await;
    let back = if back.len() == 1 {
        e.panel().await
    } else {
        back
    };
    assert_eq!(back.len(), 1, "only the immediate row's comment returned");
    assert_eq!(back[0].id, "c1");
    assert_eq!(Env::reasons(&back), vec!["session_removed"]);
    let r = e
        .store
        .get_scheduled_message(&sched)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.status, "pending");
    assert!(
        r.claimed_at.is_some() && r.delivery_phase.as_deref() == Some("waiting"),
        "the schedule row stays claimed + waiting so the poller cannot re-claim it for the old session"
    );
    assert_eq!(payload(&r).state, PayloadState::Held);
    // Reassignment un-claims and moves it in one statement.
    let n = e
        .store
        .reassign_scheduled_messages("s1", "s1-new", NOW)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let moved = e
        .store
        .get_scheduled_message(&sched)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            moved.session_id.as_str(),
            moved.claimed_at.is_none(),
            moved.delivery_phase.is_none()
        ),
        ("s1-new", true, true)
    );
}

#[tokio::test]
async fn a_failed_reset_rearms_the_stopped_schedule_row_in_place() {
    let e = env().await;
    e.comment("c2", 1, 0).await;
    let sched = e
        .routes
        .schedule_create("s1", body("later", &["c2"]))
        .await
        .unwrap()
        .id;
    let row = e
        .store
        .claim_scheduled_message(&sched, "s1", NOW)
        .await
        .unwrap()
        .unwrap();
    e.routes.terminal_delivery.fire(row).await;
    e.routes.terminal_delivery.stop_for_reset("s1").await;
    e.routes
        .terminal_delivery
        .rearm_after_failed_reset("s1")
        .await;
    let r = e
        .store
        .get_scheduled_message(&sched)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            r.status.as_str(),
            r.claimed_at.is_none(),
            r.delivery_phase.is_none()
        ),
        ("pending", true, true),
        "back to scheduled for the session that stays"
    );
    assert_eq!(payload(&r).state, PayloadState::Held);
}

// ── 3.T6b ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn json_to_tmux_with_an_over_cap_row_fails_channel_unsupported_and_restores() {
    let e = env().await;
    for i in 0..4u32 {
        e.comment(&format!("big{i}"), i + 1, 2048).await;
    }
    let ids: Vec<String> = (0..4).map(|i| format!("big{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    // A Rich Chat schedule (128 KB cap) holds ~34 KB of comments...
    let id = e
        .routes
        .schedule_create("s2", body("", &refs))
        .await
        .unwrap()
        .id;
    // ...then the agent is toggled to Terminal and the row fires there.
    e.flip("s2", Channel::Tmux).await;
    *e.pane.ready.lock().unwrap() = true;
    let row = e
        .store
        .claim_scheduled_message(&id, "s2", NOW)
        .await
        .unwrap()
        .unwrap();
    // The row's channel column still says json; deliver it through the Terminal owner.
    e.routes.terminal_delivery.fire(row).await;
    let back = e.wait_panel(4).await;
    assert_eq!(Env::reasons(&back), vec!["schedule_failed"; 4]);
    assert!(
        e.pane.pastes.lock().unwrap().is_empty(),
        "nothing over the cap is pasted"
    );
    let r = e.store.get_scheduled_message(&id).await.unwrap().unwrap();
    assert_eq!(r.status, "failed");
    assert_eq!(r.failure_kind.as_deref(), Some("channel_unsupported"));
    assert_eq!(payload(&r).state, PayloadState::Restored);
}

// ── 3.T11 ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn deleting_a_session_restores_held_json_rows_but_not_sent_adopted_tmux_or_restored() {
    let e = env().await;
    for id in ["held", "sent", "adopted", "restored"] {
        e.comment(id, 1, 0).await;
    }
    let mut rows = std::collections::HashMap::new();
    for id in ["held", "sent", "adopted", "restored"] {
        let r = e
            .routes
            .schedule_create("s2", body("m", &[id]))
            .await
            .unwrap()
            .id;
        rows.insert(id, r);
    }
    let st = &e.store;
    st.set_payload_state(&rows["adopted"], PayloadState::Adopted, None)
        .await
        .unwrap();
    st.set_payload_state(&rows["restored"], PayloadState::Restored, None)
        .await
        .unwrap();
    st.claim_scheduled_message(&rows["sent"], "s2", NOW)
        .await
        .unwrap()
        .unwrap();
    st.mark_scheduled_message_sent(&rows["sent"], "turn-x", NOW)
        .await
        .unwrap();
    assert!(e.panel().await.is_empty());

    e.routes.delete_session("s2").await.unwrap();
    // `delete_session` awaited `restore_for_session` before returning: nothing
    // later can restore again, so no settle sleep, just the queued events.
    e.review.flush_events();
    let back = e.wait_panel(1).await;
    let back = if back.len() == 1 {
        e.panel().await
    } else {
        back
    };
    assert_eq!(back.len(), 1, "only the held, pending json row comes back");
    assert_eq!(back[0].id, "held");
    assert_eq!(Env::reasons(&back), vec!["session_removed"]);

    // A tmux schedule row is the observer's (`Gone`), not `restore_for_session`'s.
    e.comment("t1", 3, 0).await;
    let t = e
        .routes
        .schedule_create("s1", body("t", &["t1"]))
        .await
        .unwrap()
        .id;
    let _ = t;
    vst_types::review::ReviewPort::restore_for_session(&e.review, "s1").await;
    assert!(e.panel().await.iter().all(|c| c.id != "t1"));
    e.routes.delete_session("s1").await.unwrap();
    let back = e.wait_panel(2).await;
    assert!(back.iter().any(|c| c.id == "t1"));
}

// ── 3.T6 (schedule row) ─────────────────────────────────────────────────────

#[tokio::test]
async fn a_channel_flip_to_json_rearms_a_schedule_row_and_its_comments_follow() {
    let e = env().await;
    e.comment("c1", 1, 0).await;
    let id = e
        .routes
        .schedule_create("s1", body("later", &["c1"]))
        .await
        .unwrap()
        .id;
    let row = e
        .store
        .claim_scheduled_message(&id, "s1", NOW)
        .await
        .unwrap()
        .unwrap();
    e.routes.terminal_delivery.fire(row).await;
    e.flip("s1", Channel::Json).await;
    let start = std::time::Instant::now();
    loop {
        let r = e.store.get_scheduled_message(&id).await.unwrap().unwrap();
        if r.delivery_phase.is_none() && r.claimed_at.is_none() {
            assert_eq!(r.status, "pending", "back to scheduled");
            assert_eq!(
                payload(&r).state,
                PayloadState::Held,
                "the snapshot follows"
            );
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(15), "never re-armed");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(e.panel().await.is_empty(), "no restore on a re-arm");
}
