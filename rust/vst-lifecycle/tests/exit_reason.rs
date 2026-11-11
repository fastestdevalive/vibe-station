//! Poller dead-pane handling (`LifecyclePollerHandle::run_poll_once`): an agent
//! pane that dies is kept by per-session `remain-on-exit`, its exit reason is
//! recorded, and the dead session is then killed. All tmux use is on a private
//! `-L vst-rtest-*` socket (`TmuxGuard`), never the default server.

use std::time::{Duration, Instant};

use tokio::sync::broadcast::Receiver;
use vst_lifecycle::lifecycle::{mark_session_exited, LifecyclePollerHandle};
use vst_proc::test_support::TmuxGuard;
use vst_proc::{NewSessionOptions, Tmux};
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::{LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType};

const TS0: &str = "2024-01-01T00:00:00.000Z";

fn session(id: &str, tmux_name: &str, ty: SessionType) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: ty,
        mode_id: Some("m".into()),
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: tmux_name.into(),
        use_tmux: true,
        channel: None,
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: "2024-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        carry_over: None,
        draft_prompt: None,
        draft_config: None,
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
        id: "p".into(),
        absolute_path: "/fake/p".into(),
        prefix: "p".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: TS0.into(),
        hidden: None,
        direct_sessions: sessions,
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

struct Fixture {
    guard: TmuxGuard,
    _dir: tempfile::TempDir,
    tmux: Tmux,
    store: StoreHandle,
    broadcaster: Broadcaster,
    rx: Receiver<ServerEvent>,
    poller: LifecyclePollerHandle,
}

async fn fixture(sessions: Vec<SessionRecord>) -> Option<Fixture> {
    if !std::process::Command::new("tmux")
        .arg("-V")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        eprintln!("skipping: no tmux binary on PATH");
        return None;
    }
    let guard = TmuxGuard::new();
    let tmux = guard.tmux();
    // Keeps the private server up while test sessions come and go.
    tmux.new_session(&NewSessionOptions {
        name: "anchor".into(),
        command: Some(vec!["sleep".into(), "120".into()]),
        ..Default::default()
    })
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("t.db")).unwrap();
    store.add_project(project(sessions)).await.unwrap();
    let broadcaster = Broadcaster::new(64);
    let rx = broadcaster.subscribe();
    let poller =
        LifecyclePollerHandle::new(store.clone(), broadcaster.clone()).with_tmux(tmux.clone());
    Some(Fixture {
        guard,
        _dir: dir,
        tmux,
        store,
        broadcaster,
        rx,
        poller,
    })
}

fn spawn(tmux: &Tmux, name: &str, script: &str, remain: bool) {
    tmux.new_session(&NewSessionOptions {
        name: name.into(),
        command: Some(vec!["sh".into(), "-c".into(), script.into()]),
        remain_on_exit: remain,
        ..Default::default()
    })
    .unwrap();
}

fn wait_dead(tmux: &Tmux, name: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !tmux.pane_exit_info(name).is_some_and(|i| i.dead) {
        assert!(Instant::now() < deadline, "pane {name} never died");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// SIGTERM the pane's process (pid read from the private server, never by name).
fn term_pane(socket: &str, name: &str) {
    let out = std::process::Command::new("tmux")
        .args(["-L", socket, "display-message", "-p", "-t"])
        .arg(format!("={name}:"))
        .arg("#{pane_pid}")
        .output()
        .unwrap();
    let pid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert!(!pid.is_empty(), "no pane pid for {name}");
    std::process::Command::new("kill")
        .args(["-TERM", &pid])
        .status()
        .unwrap();
}

async fn lifecycle_of(store: &StoreHandle, id: &str) -> SessionLifecycle {
    store.find_session(id).await.unwrap().1.lifecycle
}

fn state_events(rx: &mut Receiver<ServerEvent>) -> Vec<(String, LifecycleState, Option<String>)> {
    let mut v = vec![];
    while let Ok(ev) = rx.try_recv() {
        if let ServerEvent::SessionState {
            session_id,
            state,
            reason,
        } = ev
        {
            v.push((session_id, state, reason));
        }
    }
    v
}

#[tokio::test]
async fn terminated_agent_pane_records_signal_reason_and_session_is_killed() {
    let Some(mut f) = fixture(vec![session("s1", "vst-s1", SessionType::Agent)]).await else {
        return;
    };
    spawn(&f.tmux, "vst-s1", "exec sleep 120", true);
    term_pane(f.guard.socket(), "vst-s1");
    wait_dead(&f.tmux, "vst-s1");

    f.poller.run_poll_once().await;

    let lc = lifecycle_of(&f.store, "s1").await;
    assert_eq!(lc.state, LifecycleState::Exited);
    assert!(
        lc.reason
            .as_deref()
            .is_some_and(|r| r.contains("signal 15")),
        "{:?}",
        lc.reason
    );
    let evs = state_events(&mut f.rx);
    assert_eq!(evs.len(), 1, "{evs:?}");
    assert_eq!(evs[0].1, LifecycleState::Exited);
    assert!(evs[0].2.as_deref().is_some_and(|r| r.contains("signal 15")));
    assert!(!f.tmux.has_session("vst-s1"), "dead session must be killed");
    assert!(f.tmux.has_session("anchor"));
}

#[tokio::test]
async fn stale_dead_snapshot_never_overwrites_a_resumed_session() {
    let Some(mut f) = fixture(vec![session("s1", "vst-s1", SessionType::Agent)]).await else {
        return;
    };
    spawn(&f.tmux, "vst-s1", "exec sleep 120", true);
    term_pane(f.guard.socket(), "vst-s1");
    wait_dead(&f.tmux, "vst-s1");
    // The poller's snapshot: dead pane, record as stored now.
    let snapshot = f.store.find_session("s1").await.unwrap().1;

    // Resume: the dead session is replaced by a live one and the record is
    // rewritten `working` with a NEW lastTransitionAt.
    f.tmux.kill_session("vst-s1");
    spawn(&f.tmux, "vst-s1", "exec sleep 120", true);
    f.store
        .update_session_lifecycle(
            "p",
            "s1",
            SessionLifecycle {
                state: LifecycleState::Working,
                reason: None,
                last_transition_at: "2024-03-03T00:00:00.000Z".into(),
            },
        )
        .await
        .unwrap();

    let applied = mark_session_exited(
        "p",
        &snapshot,
        &f.store,
        &f.broadcaster,
        Some("killed by signal 15 (TERM)".into()),
        true,
    )
    .await;
    assert!(
        !applied,
        "conditional write must lose against the newer row"
    );
    f.tmux.kill_session_if_dead("vst-s1");

    let lc = lifecycle_of(&f.store, "s1").await;
    assert_eq!(lc.state, LifecycleState::Working);
    assert_eq!(lc.last_transition_at, "2024-03-03T00:00:00.000Z");
    assert!(
        state_events(&mut f.rx).is_empty(),
        "no broadcast on a lost CAS"
    );
    assert!(f.tmux.has_session("vst-s1"), "live session must survive");
    assert!(f.tmux.pane_is_alive("vst-s1"));
}

#[tokio::test]
async fn exit_status_reasons_for_clean_and_failing_commands() {
    let Some(mut f) = fixture(vec![
        session("ok", "vst-ok", SessionType::Agent),
        session("bad", "vst-bad", SessionType::Agent),
    ])
    .await
    else {
        return;
    };
    spawn(&f.tmux, "vst-ok", "sleep 0.3; exit 0", true);
    spawn(&f.tmux, "vst-bad", "sleep 0.3; exit 7", true);
    wait_dead(&f.tmux, "vst-ok");
    wait_dead(&f.tmux, "vst-bad");

    f.poller.run_poll_once().await;

    assert_eq!(
        lifecycle_of(&f.store, "ok").await.reason.as_deref(),
        Some("exited normally (status 0)")
    );
    assert_eq!(
        lifecycle_of(&f.store, "bad").await.reason.as_deref(),
        Some("exited with status 7")
    );
    assert_eq!(state_events(&mut f.rx).len(), 2);
    assert!(!f.tmux.has_session("vst-ok") && !f.tmux.has_session("vst-bad"));
}

#[tokio::test]
async fn sessions_without_remain_on_exit_still_exit_with_no_reason() {
    let Some(f) = fixture(vec![
        session("agent", "vst-agent", SessionType::Agent),
        session("term", "vst-term", SessionType::Terminal),
    ])
    .await
    else {
        return;
    };
    // No remain-on-exit: the session vanishes with its pane.
    spawn(&f.tmux, "vst-agent", "exit 1", false);
    spawn(&f.tmux, "vst-term", "exit 1", false);
    let deadline = Instant::now() + Duration::from_secs(10);
    while f.tmux.has_session("vst-agent") || f.tmux.has_session("vst-term") {
        assert!(Instant::now() < deadline, "sessions never vanished");
        std::thread::sleep(Duration::from_millis(20));
    }

    f.poller.run_poll_once().await;

    for id in ["agent", "term"] {
        let lc = lifecycle_of(&f.store, id).await;
        assert_eq!(lc.state, LifecycleState::Exited, "{id}");
        assert_eq!(lc.reason, None, "{id}");
    }
}

#[tokio::test]
async fn already_exited_session_with_a_lingering_dead_pane_is_only_killed() {
    let mut s = session("s1", "vst-s1", SessionType::Agent);
    s.lifecycle.state = LifecycleState::Exited;
    s.lifecycle.reason = Some("earlier".into());
    let Some(mut f) = fixture(vec![s]).await else {
        return;
    };
    spawn(&f.tmux, "vst-s1", "sleep 0.3; exit 3", true);
    wait_dead(&f.tmux, "vst-s1");

    f.poller.run_poll_once().await;

    assert!(!f.tmux.has_session("vst-s1"));
    assert_eq!(
        lifecycle_of(&f.store, "s1").await.reason.as_deref(),
        Some("earlier"),
        "an existing exited record is not rewritten"
    );
    assert!(state_events(&mut f.rx).is_empty());
}

#[tokio::test]
async fn not_started_and_drafting_dead_panes_are_left_to_the_spawn_path() {
    for (i, state) in [LifecycleState::NotStarted, LifecycleState::Drafting]
        .into_iter()
        .enumerate()
    {
        let mut s = session("s1", "vst-s1", SessionType::Agent);
        s.lifecycle.state = state;
        let Some(mut f) = fixture(vec![s]).await else {
            return;
        };
        spawn(&f.tmux, "vst-s1", "sleep 0.3; exit 3", true);
        wait_dead(&f.tmux, "vst-s1");

        f.poller.run_poll_once().await;

        assert_eq!(lifecycle_of(&f.store, "s1").await.state, state, "case {i}");
        assert!(state_events(&mut f.rx).is_empty(), "case {i}");
        assert!(f.tmux.has_session("vst-s1"), "case {i}: pane left alone");
    }
}

#[tokio::test]
async fn json_channel_session_with_a_dead_pane_is_ignored() {
    let mut s = session("s1", "vst-s1", SessionType::Agent);
    s.channel = Some(vst_types::Channel::Json);
    let Some(mut f) = fixture(vec![s]).await else {
        return;
    };
    spawn(&f.tmux, "vst-s1", "sleep 0.3; exit 3", true);
    wait_dead(&f.tmux, "vst-s1");

    f.poller.run_poll_once().await;

    let lc = lifecycle_of(&f.store, "s1").await;
    assert_eq!(lc.state, LifecycleState::Working);
    assert_eq!(lc.last_transition_at, TS0);
    assert!(state_events(&mut f.rx).is_empty());
    assert!(f.tmux.has_session("vst-s1"), "json session not killed");
}

#[tokio::test]
async fn done_session_dead_pane_is_only_killed() {
    let mut s = session("s1", "vst-s1", SessionType::Agent);
    s.lifecycle.state = LifecycleState::Done;
    s.lifecycle.reason = Some("manual".into());
    let Some(mut f) = fixture(vec![s]).await else {
        return;
    };
    spawn(&f.tmux, "vst-s1", "sleep 0.3; exit 3", true);
    wait_dead(&f.tmux, "vst-s1");

    f.poller.run_poll_once().await;

    assert!(!f.tmux.has_session("vst-s1"), "dead pane is killed");
    let lc = lifecycle_of(&f.store, "s1").await;
    assert_eq!(lc.state, LifecycleState::Done);
    assert_eq!(lc.reason.as_deref(), Some("manual"));
    assert!(state_events(&mut f.rx).is_empty());
}
