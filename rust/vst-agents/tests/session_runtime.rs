//! Behavior contract for `session_runtime.rs` (part 04c).
//!
//! Ports `daemon/src/__tests__/sessionRuntime.test.ts` — 1:1 mapping of every
//! TS test case.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use vst_types::domain::{Channel, LifecycleState, SessionLifecycle, SessionRecord, SessionType};

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::session_runtime::{
    release_session_runtime, release_session_runtime_with_warn, Releasable, ReleaseCallbacks,
    ReleaseOpts, TmuxSessionOps,
};

// ---------------------------------------------------------------------------
// Fake releasable (stands in for JsonAgentSession.release())
// ---------------------------------------------------------------------------

struct FakeAgent {
    call_count: Arc<AtomicUsize>,
}

impl Releasable for FakeAgent {
    async fn release(&self) {
        self.call_count.fetch_add(1, Ordering::SeqCst);
    }
}

fn make_fake_agent() -> (Arc<FakeAgent>, Arc<AtomicUsize>) {
    let counter = Arc::new(AtomicUsize::new(0));
    let agent = Arc::new(FakeAgent {
        call_count: Arc::clone(&counter),
    });
    (agent, counter)
}

// ---------------------------------------------------------------------------
// Slow agent for 1.T1b
// ---------------------------------------------------------------------------

struct SlowAgent {
    finished: Arc<AtomicBool>,
}

impl Releasable for SlowAgent {
    async fn release(&self) {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        self.finished.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Mock tmux — configurable sequence of has_session return values
// ---------------------------------------------------------------------------

struct MockTmux {
    kill_calls: Arc<AtomicUsize>,
    has_calls: Arc<AtomicUsize>,
    /// Sequence of `has_session` return values; last value is repeated.
    has_returns: Mutex<Vec<bool>>,
}

impl MockTmux {
    /// `has_session` always returns false (kill succeeded immediately).
    fn always_gone() -> Arc<Self> {
        Arc::new(Self {
            kill_calls: Arc::new(AtomicUsize::new(0)),
            has_calls: Arc::new(AtomicUsize::new(0)),
            has_returns: Mutex::new(vec![false]),
        })
    }

    /// `has_session` always returns true (session never dies).
    fn stubborn() -> Arc<Self> {
        Arc::new(Self {
            kill_calls: Arc::new(AtomicUsize::new(0)),
            has_calls: Arc::new(AtomicUsize::new(0)),
            has_returns: Mutex::new(vec![true]),
        })
    }

    /// `has_session` returns true once then false (first kill didn't take, second did).
    fn retry_once() -> Arc<Self> {
        Arc::new(Self {
            kill_calls: Arc::new(AtomicUsize::new(0)),
            has_calls: Arc::new(AtomicUsize::new(0)),
            has_returns: Mutex::new(vec![true, false]),
        })
    }
}

impl TmuxSessionOps for MockTmux {
    fn kill_session(&self, _name: &str) {
        self.kill_calls.fetch_add(1, Ordering::SeqCst);
    }

    fn has_session(&self, _name: &str) -> bool {
        self.has_calls.fetch_add(1, Ordering::SeqCst);
        let mut seq = self.has_returns.lock().unwrap();
        if seq.len() > 1 {
            seq.remove(0)
        } else {
            *seq.first().unwrap_or(&false)
        }
    }
}

// ---------------------------------------------------------------------------
// Spy callbacks
// ---------------------------------------------------------------------------

type SpyFn = Arc<dyn Fn(&str) + Send + Sync>;

fn spy_fn() -> (SpyFn, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls2 = Arc::clone(&calls);
    let f: SpyFn = Arc::new(move |_: &str| {
        calls2.fetch_add(1, Ordering::SeqCst);
    });
    (f, calls)
}

fn spy_fn_capturing() -> (SpyFn, Arc<Mutex<Vec<String>>>) {
    let captured = Arc::new(Mutex::new(vec![]));
    let captured2 = Arc::clone(&captured);
    let f: SpyFn = Arc::new(move |s: &str| {
        captured2.lock().unwrap().push(s.to_string());
    });
    (f, captured)
}

// ---------------------------------------------------------------------------
// Fake PtyKill for DirectPtyRegistry
// ---------------------------------------------------------------------------

struct FakePtyKill(Arc<AtomicUsize>);

impl vst_git::direct_pty::PtyKill for FakePtyKill {
    fn kill(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Session fixture (exact field names from vst-types/src/domain.rs)
// ---------------------------------------------------------------------------

fn make_session(id: &str, tmux_name: &str, use_tmux: bool) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        name: None,
        name_source: None,
        tmux_name: tmux_name.into(),
        use_tmux,
        channel: Some(Channel::Json),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
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
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    }
}

// ---------------------------------------------------------------------------
// 1.T1 — releases and unregisters the JsonAgentSession
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t1_releases_and_unregisters_json_agent() {
    let session = make_session("s-json", "vr-1-a0", false);
    let registry = Arc::new(JsonAgentRegistry::<FakeAgent>::new());
    let (agent, call_count) = make_fake_agent();
    registry.set(session.id.clone(), agent);

    let tmux = MockTmux::always_gone();
    let (on_idle, _) = spy_fn();
    let (on_attach, _) = spy_fn();
    let direct_pty = vst_git::DirectPtyRegistry::new();

    release_session_runtime(
        &session,
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        on_idle,
        on_attach,
    )
    .await;

    assert_eq!(
        call_count.load(Ordering::SeqCst),
        1,
        "release() must be called once"
    );
    assert!(
        registry.get(&session.id).is_none(),
        "must be unregistered after release"
    );
}

// ---------------------------------------------------------------------------
// 1.T1b — awaits release() before returning
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t1b_awaits_release_before_returning() {
    let session = make_session("s-slow", "vr-slow", false);
    let registry = Arc::new(JsonAgentRegistry::<SlowAgent>::new());
    let finished = Arc::new(AtomicBool::new(false));
    let agent = Arc::new(SlowAgent {
        finished: Arc::clone(&finished),
    });
    registry.set(session.id.clone(), agent);

    let tmux = MockTmux::always_gone();
    let (on_idle, _) = spy_fn();
    let (on_attach, _) = spy_fn();
    let direct_pty = vst_git::DirectPtyRegistry::new();

    release_session_runtime(
        &session,
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        on_idle,
        on_attach,
    )
    .await;

    assert!(
        finished.load(Ordering::SeqCst),
        "release() must be fully awaited"
    );
}

// ---------------------------------------------------------------------------
// 1.T2 — tmux session: kills the pane by name, never touches the pty registry
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t2_tmux_session_kills_pane_not_pty() {
    let session = make_session("s-tmux", "vr-7-m", true);
    let registry = Arc::new(JsonAgentRegistry::<FakeAgent>::new());

    let direct_pty = vst_git::DirectPtyRegistry::new();
    let pty_kill_count = Arc::new(AtomicUsize::new(0));
    direct_pty.insert(
        session.id.clone(),
        Arc::new(FakePtyKill(Arc::clone(&pty_kill_count))),
    );

    let tmux = MockTmux::always_gone();
    let (on_idle, _) = spy_fn();
    let (on_attach, _) = spy_fn();

    release_session_runtime(
        &session,
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        on_idle,
        on_attach,
    )
    .await;

    assert!(
        tmux.kill_calls.load(Ordering::SeqCst) >= 1,
        "tmux.kill_session must be called for a tmux session"
    );
    assert_eq!(
        pty_kill_count.load(Ordering::SeqCst),
        0,
        "pty.kill must NOT be called for a tmux session"
    );
}

// ---------------------------------------------------------------------------
// 1.T2b — direct-pty session: kills the child, never calls tmux
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t2b_direct_pty_kills_child_not_tmux() {
    let session = make_session("s-pty", "vr-pty", false);
    let registry = Arc::new(JsonAgentRegistry::<FakeAgent>::new());

    let direct_pty = vst_git::DirectPtyRegistry::new();
    let pty_kill_count = Arc::new(AtomicUsize::new(0));
    direct_pty.insert(
        session.id.clone(),
        Arc::new(FakePtyKill(Arc::clone(&pty_kill_count))),
    );

    let tmux = MockTmux::always_gone();
    let (on_idle, _) = spy_fn();
    let (on_attach, _) = spy_fn();

    release_session_runtime(
        &session,
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        on_idle,
        on_attach,
    )
    .await;

    assert_eq!(
        pty_kill_count.load(Ordering::SeqCst),
        1,
        "pty.kill must be called once for a direct-pty session"
    );
    assert_eq!(
        tmux.kill_calls.load(Ordering::SeqCst),
        0,
        "tmux.kill_session must NOT be called for a direct-pty session"
    );
}

// ---------------------------------------------------------------------------
// 1.T2c — missing pane / unregistered pty is not an error
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t2c_missing_pane_is_not_an_error() {
    let session = make_session("s-gone", "vr-gone", true);
    let registry = Arc::new(JsonAgentRegistry::<FakeAgent>::new());
    let direct_pty = vst_git::DirectPtyRegistry::new();
    let tmux = MockTmux::always_gone();
    let (on_idle, _) = spy_fn();
    let (on_attach, _) = spy_fn();

    // No agent registered, no pty registered — must complete without panic.
    release_session_runtime(
        &session,
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        on_idle,
        on_attach,
    )
    .await;
}

// ---------------------------------------------------------------------------
// 1.T3 — keeps staged attachments by default, clears when asked
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t3_attachments_cleared_only_when_requested() {
    let registry = Arc::new(JsonAgentRegistry::<FakeAgent>::new());
    let direct_pty = vst_git::DirectPtyRegistry::new();
    let tmux = MockTmux::always_gone();
    let (on_idle, _) = spy_fn();
    let (on_attach, attach_calls) = spy_fn();

    // First call: no clearing.
    release_session_runtime(
        &make_session("s-keep", "vr-keep", true),
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        Arc::clone(&on_idle),
        Arc::clone(&on_attach),
    )
    .await;
    assert_eq!(
        attach_calls.load(Ordering::SeqCst),
        0,
        "must not clear when opt=false"
    );

    // Second call: clearing requested.
    release_session_runtime(
        &make_session("s-clear", "vr-clear", true),
        ReleaseOpts {
            clear_attachments: true,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        Arc::clone(&on_idle),
        Arc::clone(&on_attach),
    )
    .await;
    assert_eq!(
        attach_calls.load(Ordering::SeqCst),
        1,
        "must clear once when opt=true"
    );
}

// ---------------------------------------------------------------------------
// 1.T3b — always clears the lifecycle poller's idle-hash entry
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t3b_always_clears_idle_tracking() {
    let session = make_session("s-idle", "vr-idle", true);
    let registry = Arc::new(JsonAgentRegistry::<FakeAgent>::new());
    let direct_pty = vst_git::DirectPtyRegistry::new();
    let tmux = MockTmux::always_gone();
    let (on_idle, idle_calls) = spy_fn();
    let (on_attach, _) = spy_fn();

    release_session_runtime(
        &session,
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        on_idle,
        on_attach,
    )
    .await;

    assert_eq!(
        idle_calls.load(Ordering::SeqCst),
        1,
        "clear_idle must always be called"
    );
}

// ---------------------------------------------------------------------------
// 2.T1 — kill succeeds (has_session = false): killSession once, no retry
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t2_1_kill_succeeds_no_retry() {
    let session = make_session("s-kill-ok", "vr-kill-ok", true);
    let registry = Arc::new(JsonAgentRegistry::<FakeAgent>::new());
    let direct_pty = vst_git::DirectPtyRegistry::new();
    let tmux = MockTmux::always_gone();
    let (on_idle, _) = spy_fn();
    let (on_attach, _) = spy_fn();

    release_session_runtime(
        &session,
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        on_idle,
        on_attach,
    )
    .await;

    assert_eq!(
        tmux.kill_calls.load(Ordering::SeqCst),
        1,
        "killSession called once"
    );
    assert_eq!(
        tmux.has_calls.load(Ordering::SeqCst),
        1,
        "hasSession called once"
    );
}

// ---------------------------------------------------------------------------
// 2.T2 — has_session true then false: killSession twice, hasSession twice
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t2_2_retry_once_on_first_kill_miss() {
    let session = make_session("s-kill-retry", "vr-kill-retry", true);
    let registry = Arc::new(JsonAgentRegistry::<FakeAgent>::new());
    let direct_pty = vst_git::DirectPtyRegistry::new();
    let tmux = MockTmux::retry_once();
    let (on_idle, _) = spy_fn();
    let (on_attach, _) = spy_fn();

    release_session_runtime(
        &session,
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        on_idle,
        on_attach,
    )
    .await;

    assert_eq!(
        tmux.kill_calls.load(Ordering::SeqCst),
        2,
        "killSession called twice"
    );
    assert_eq!(
        tmux.has_calls.load(Ordering::SeqCst),
        2,
        "hasSession called twice"
    );
}

// ---------------------------------------------------------------------------
// 2.T3 — has_session always true: killSession twice, warn once with ids
// ---------------------------------------------------------------------------

#[tokio::test]
async fn t2_3_warn_when_kill_never_takes() {
    let session = make_session("s-kill-stuck", "vr-kill-stuck", true);
    let registry = Arc::new(JsonAgentRegistry::<FakeAgent>::new());
    let direct_pty = vst_git::DirectPtyRegistry::new();
    let tmux = MockTmux::stubborn();

    let (on_idle, _) = spy_fn();
    let (on_attach, _) = spy_fn();
    let (on_warn, warn_msgs) = spy_fn_capturing();

    release_session_runtime_with_warn(
        &session,
        ReleaseOpts {
            clear_attachments: false,
        },
        &registry,
        &direct_pty,
        tmux.as_ref(),
        ReleaseCallbacks {
            on_clear_idle: on_idle,
            on_clear_attachments: on_attach,
            on_warn,
        },
    )
    .await;

    assert_eq!(
        tmux.kill_calls.load(Ordering::SeqCst),
        2,
        "killSession called twice"
    );
    assert_eq!(
        tmux.has_calls.load(Ordering::SeqCst),
        2,
        "hasSession checked twice"
    );

    let msgs = warn_msgs.lock().unwrap();
    assert_eq!(msgs.len(), 1, "warn must fire exactly once");
    let msg = &msgs[0];
    assert!(
        msg.contains("s-kill-stuck"),
        "warn must contain session id: {msg}"
    );
    assert!(
        msg.contains("vr-kill-stuck"),
        "warn must contain tmux name: {msg}"
    );
}
