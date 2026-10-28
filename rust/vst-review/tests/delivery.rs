//! Terminal delivery: job loop, gate, FIFO, cancel races, observer, recovery.
//! Fake pane + resolver; virtual time (`start_paused`) except where noted.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;
use vst_proc::tmux::PaneFlags;
use vst_review::{
    BoxFuture, NotifyScheduled, OutcomeObserver, PaneIo, PasteBody, TargetResolver,
    TerminalDeliveryHandle, TerminalTarget, JOB_TIMEOUT, MIN_GAP_AFTER_ENTER, POLL_INTERVAL,
};
use vst_store::{CancelOutcome, RecoveryOutcome, StoreHandle};
use vst_types::rest::sessions::ScheduledMessageRow;
use vst_types::terminal_delivery::{
    FailureKind, PaneSnapshot, TerminalDeliveryCaps, TerminalOutcome, TerminalReadiness,
};

const S: &str = "sess-1";
const T0: &str = "2026-01-01T00:00:00Z";
const DUE: &str = "2026-01-01T00:00:10Z";
const NOW: &str = "2026-01-01T00:01:00Z";

#[derive(Clone, Debug, PartialEq, Eq)]
enum Ev {
    Paste {
        target: String,
        buffer: String,
        text: String,
        raw_lf: bool,
    },
    Enter,
    CancelMode,
}

struct FakeState {
    names: Option<HashSet<String>>,
    flags: Option<PaneFlags>,
    text: String,
    after_enter_text: Option<String>,
    capture_err: bool,
    scroll_during_settle: bool,
    events: Vec<(Instant, Ev)>,
}

struct FakeIo(Mutex<FakeState>);

impl FakeIo {
    fn new() -> Arc<Self> {
        Arc::new(FakeIo(Mutex::new(FakeState {
            names: Some(["agent".to_string()].into_iter().collect()),
            flags: Some(PaneFlags {
                in_mode: false,
                dead: false,
            }),
            text: "idle".into(),
            after_enter_text: Some("redrawn".into()),
            capture_err: false,
            scroll_during_settle: false,
            events: vec![],
        })))
    }
    fn set(&self, f: impl FnOnce(&mut FakeState)) {
        f(&mut self.0.lock().unwrap());
    }
    fn events(&self) -> Vec<(Instant, Ev)> {
        self.0.lock().unwrap().events.clone()
    }
    fn pastes(&self) -> Vec<(Instant, String)> {
        self.events()
            .into_iter()
            .filter_map(|(t, e)| match e {
                Ev::Paste { text, .. } => Some((t, text)),
                _ => None,
            })
            .collect()
    }
    fn enters(&self) -> Vec<Instant> {
        self.events()
            .into_iter()
            .filter_map(|(t, e)| (e == Ev::Enter).then_some(t))
            .collect()
    }
    fn count(&self, ev: &Ev) -> usize {
        self.events().iter().filter(|(_, e)| e == ev).count()
    }
}

impl PaneIo for FakeIo {
    fn list_session_names(&self) -> Option<HashSet<String>> {
        self.0.lock().unwrap().names.clone()
    }
    fn pane_flags(&self, _t: &str) -> Option<PaneFlags> {
        self.0.lock().unwrap().flags
    }
    fn capture(&self, _t: &str) -> Result<PaneSnapshot, String> {
        let s = self.0.lock().unwrap();
        if s.capture_err {
            return Err("boom".into());
        }
        Ok(PaneSnapshot {
            text: s.text.clone(),
            cursor_x: 0,
            cursor_y: 0,
        })
    }
    fn cancel_mode(&self, _t: &str) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        if let Some(f) = s.flags.as_mut() {
            f.in_mode = false;
        }
        s.events.push((Instant::now(), Ev::CancelMode));
        Ok(())
    }
    fn paste(&self, target: &str, buffer_id: &str, text: &str, raw_lf: bool) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        s.text = "typed".into();
        if s.scroll_during_settle {
            // The user scrolled into copy mode while the paste settled.
            if let Some(f) = s.flags.as_mut() {
                f.in_mode = true;
            }
        }
        s.events.push((
            Instant::now(),
            Ev::Paste {
                target: target.into(),
                buffer: buffer_id.into(),
                text: text.into(),
                raw_lf,
            },
        ));
        Ok(())
    }
    fn send_enter(&self, _t: &str) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        if let Some(t) = s.after_enter_text.clone() {
            s.text = t;
        }
        s.events.push((Instant::now(), Ev::Enter));
        Ok(())
    }
}

/// Probe answers: a queue of scripted readings, then `default`.
struct Script {
    queue: Mutex<VecDeque<TerminalReadiness>>,
    default: Mutex<TerminalReadiness>,
}

struct Spec {
    channel_is_tmux: bool,
    channel_is_json: bool,
    gone: bool,
    exited: bool,
    caps: Option<TerminalDeliveryCaps>,
    deleted: bool,
}

struct FakeResolver {
    spec: Mutex<Spec>,
    script: Arc<Script>,
}

impl TargetResolver for FakeResolver {
    fn resolve(&self, _id: &str) -> BoxFuture<'_, Option<TerminalTarget>> {
        let s = self.spec.lock().unwrap();
        let script = self.script.clone();
        let t = (!s.deleted).then(|| TerminalTarget {
            tmux_name: "agent".into(),
            channel_is_tmux: s.channel_is_tmux,
            channel_is_json: s.channel_is_json,
            gone: s.gone,
            exited: s.exited,
            caps: s.caps,
            probe: Arc::new(move |_| {
                script
                    .queue
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(*script.default.lock().unwrap())
            }),
        });
        Box::pin(async move { t })
    }
}

fn caps(multiline_ok: bool) -> TerminalDeliveryCaps {
    TerminalDeliveryCaps {
        settle_ms: 200,
        multiline_ok,
        raw_lf: false,
    }
}

type Outcomes = Arc<Mutex<Vec<(String, TerminalOutcome)>>>;
type Notes = Arc<Mutex<Vec<(String, Option<(String, Option<String>)>)>>>;

struct H {
    _dir: tempfile::TempDir,
    store: StoreHandle,
    io: Arc<FakeIo>,
    res: Arc<FakeResolver>,
    handle: TerminalDeliveryHandle,
    notes: Notes,
    outcomes: Outcomes,
}

fn observer_pair() -> (OutcomeObserver, Outcomes) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let l = log.clone();
    let obs: OutcomeObserver = Arc::new(move |id, o| l.lock().unwrap().push((id, o)));
    (obs, log)
}

fn h_with(
    store: StoreHandle,
    dir: tempfile::TempDir,
    io: Arc<FakeIo>,
    paste_body: Option<PasteBody>,
    observe_row: &'static str,
) -> H {
    let res = Arc::new(FakeResolver {
        spec: Mutex::new(Spec {
            channel_is_tmux: true,
            channel_is_json: false,
            gone: false,
            exited: false,
            caps: Some(caps(true)),
            deleted: false,
        }),
        script: Arc::new(Script {
            queue: Mutex::new(VecDeque::new()),
            default: Mutex::new(TerminalReadiness::Unknown),
        }),
    });
    let notes: Notes = Arc::new(Mutex::new(Vec::new()));
    let (n, st) = (notes.clone(), store.clone());
    let notify: NotifyScheduled = Arc::new(move |sid| {
        let (n, st) = (n.clone(), st.clone());
        Box::pin(async move {
            let r = st.get_scheduled_message(observe_row).await.unwrap();
            n.lock()
                .unwrap()
                .push((sid, r.map(|r| (r.status, r.delivery_phase))));
        })
    });
    let (obs, outcomes) = observer_pair();
    let mut handle =
        TerminalDeliveryHandle::new(store.clone(), io.clone(), res.clone(), notify, Some(obs));
    if let Some(b) = paste_body {
        handle = handle.with_paste_body(b);
    }
    H {
        _dir: dir,
        store,
        io,
        res,
        handle,
        notes,
        outcomes,
    }
}

async fn harness() -> H {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    h_with(store, dir, FakeIo::new(), None, "r1")
}

impl H {
    fn ready(&self, r: TerminalReadiness) {
        *self.res.script.default.lock().unwrap() = r;
    }
    fn script(&self, rs: &[TerminalReadiness]) {
        self.res
            .script
            .queue
            .lock()
            .unwrap()
            .extend(rs.iter().copied());
    }
    fn spec(&self, f: impl FnOnce(&mut Spec)) {
        f(&mut self.res.spec.lock().unwrap());
    }

    /// Insert a tmux row (due) and claim it, as the poller does.
    async fn claimed(
        &self,
        id: &str,
        text: &str,
        fire_at: &str,
        created: &str,
        origin: Option<&str>,
    ) -> ScheduledMessageRow {
        self.store
            .insert_scheduled_message(
                id,
                S,
                text,
                None,
                fire_at,
                created,
                Some("tmux"),
                None,
                origin,
            )
            .await
            .unwrap();
        self.store
            .claim_scheduled_message(id, S, NOW)
            .await
            .unwrap()
            .expect("claim")
    }

    async fn add_fire(&self, id: &str, text: &str) -> ScheduledMessageRow {
        let row = self.claimed(id, text, DUE, T0, Some("schedule")).await;
        self.handle.fire(row.clone()).await;
        row
    }

    async fn row(&self, id: &str) -> Option<ScheduledMessageRow> {
        self.store.get_scheduled_message(id).await.unwrap()
    }

    async fn status(&self, id: &str) -> String {
        self.row(id)
            .await
            .map(|r| r.status)
            .unwrap_or_else(|| "gone".into())
    }

    /// Advance virtual time until `done` (or fail after `limit`).
    async fn wait_status(&self, id: &str, want: &str) {
        let start = Instant::now();
        while self.status(id).await != want {
            assert!(
                start.elapsed() < JOB_TIMEOUT * 4,
                "row {id} never became {want}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn outcomes(&self) -> Vec<(String, TerminalOutcome)> {
        self.outcomes.lock().unwrap().clone()
    }
}

async fn run_for(d: Duration) {
    let end = Instant::now() + d;
    while Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

use TerminalReadiness::{AwaitingApproval, Ready, Unknown};

// ── 5.T2 ────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn happy_path_one_paste_then_enter_and_row_sent() {
    let h = harness().await;
    h.script(&[Unknown, Unknown, Unknown]);
    h.ready(Ready);
    h.add_fire("r1", "/review src/auth").await;
    h.wait_status("r1", "sent").await;

    let events = h.io.events();
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(
        events[0].1,
        Ev::Paste {
            target: "=agent:".into(),
            buffer: "vr-r1".into(),
            text: "/review src/auth".into(),
            raw_lf: false
        }
    );
    assert_eq!(events[1].1, Ev::Enter);
    assert!(events[1].0 - events[0].0 >= Duration::from_millis(200));

    let row = h.row("r1").await.unwrap();
    assert!(row.sent_turn_id.is_none() && row.sent_at.is_some());
    assert!(row.claimed_at.is_none() && row.delivery_phase.is_none());
    // The last notification saw the sent row.
    let notes = h.notes.lock().unwrap().clone();
    assert_eq!(
        notes.last().unwrap().1,
        Some(("sent".to_string(), None)),
        "{notes:?}"
    );
    assert_eq!(h.outcomes(), vec![("r1".into(), TerminalOutcome::Sent)]);
}

// ── 5.T3 ────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn approval_prompt_times_out_without_pasting() {
    let h = harness().await;
    h.ready(AwaitingApproval);
    let t0 = Instant::now();
    h.add_fire("r1", "hi").await;
    h.wait_status("r1", "failed").await;
    assert!(t0.elapsed() >= JOB_TIMEOUT);
    assert!(h.io.events().is_empty(), "nothing is ever sent or answered");
    let row = h.row("r1").await.unwrap();
    assert_eq!(row.failure_kind.as_deref(), Some("timed_out"));
    assert_eq!(
        h.outcomes(),
        vec![("r1".into(), TerminalOutcome::Failed(FailureKind::TimedOut))]
    );
}

// ── 5.T4 ────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn fire_writes_waiting_before_returning_even_when_queued() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "one").await;
    let row2 = h
        .claimed("r2", "two", DUE, "2026-01-01T00:00:01Z", Some("schedule"))
        .await;
    h.handle.fire(row2).await;
    for id in ["r1", "r2"] {
        let r = h.row(id).await.unwrap();
        assert_eq!(r.delivery_phase.as_deref(), Some("waiting"), "{id}");
    }
    // The queued one is visible and cancellable.
    let pending = h.store.list_pending_scheduled_messages(S).await.unwrap();
    assert_eq!(pending.len(), 2);
    assert_eq!(
        h.handle.cancel_row(S, "r2").await.unwrap(),
        CancelOutcome::Deleted
    );
    assert_eq!(h.status("r2").await, "gone");
    assert_eq!(
        h.row("r1").await.unwrap().delivery_phase.as_deref(),
        Some("waiting")
    );
    assert_eq!(
        h.outcomes(),
        vec![("r2".into(), TerminalOutcome::Cancelled)]
    );
}

// ── 5.T5 / 5.T6 ─────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn exited_mid_wait_fails_agent_exited() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "hi").await;
    run_for(Duration::from_secs(2)).await;
    h.spec(|s| s.exited = true);
    h.wait_status("r1", "failed").await;
    assert!(h.io.events().is_empty());
    assert_eq!(
        h.row("r1").await.unwrap().failure_kind.as_deref(),
        Some("agent_exited")
    );
    assert_eq!(
        h.outcomes(),
        vec![(
            "r1".into(),
            TerminalOutcome::Failed(FailureKind::AgentExited)
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn tmux_session_missing_fails_but_uninterpretable_error_keeps_waiting() {
    let h = harness().await;
    h.ready(Ready);
    // A tmux hiccup (None) and an unreadable pane (flags None) never fail.
    h.io.set(|s| {
        s.names = None;
        s.flags = None;
    });
    h.add_fire("r1", "hi").await;
    run_for(Duration::from_secs(30)).await;
    assert_eq!(h.status("r1").await, "pending");
    h.io.set(|s| s.names = Some(HashSet::new()));
    h.wait_status("r1", "failed").await;
    assert!(h.io.events().is_empty());
    assert_eq!(
        h.row("r1").await.unwrap().failure_kind.as_deref(),
        Some("agent_exited")
    );
}

#[tokio::test(start_paused = true)]
async fn flags_none_keeps_waiting_then_delivers() {
    let h = harness().await;
    h.ready(Ready);
    h.io.set(|s| s.flags = None);
    h.add_fire("r1", "hi").await;
    run_for(Duration::from_secs(10)).await;
    assert!(h.io.events().is_empty());
    h.io.set(|s| {
        s.flags = Some(PaneFlags {
            in_mode: false,
            dead: false,
        })
    });
    h.wait_status("r1", "sent").await;
    assert_eq!(h.io.pastes().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn dead_pane_with_listed_session_fails_agent_exited() {
    let h = harness().await;
    h.ready(Ready);
    h.io.set(|s| {
        s.flags = Some(PaneFlags {
            in_mode: false,
            dead: true,
        })
    });
    h.add_fire("r1", "hi").await;
    h.wait_status("r1", "failed").await;
    assert!(h.io.events().is_empty(), "zero pastes into a dead pane");
    assert_eq!(
        h.row("r1").await.unwrap().failure_kind.as_deref(),
        Some("agent_exited")
    );
}

// ── 5.T7 / 5.T8 ─────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn restart_rearms_a_waiting_row_and_delivers_it_once() {
    let h = harness().await;
    // The previous daemon left the row claimed + waiting.
    let row = h.claimed("r1", "later", DUE, T0, Some("schedule")).await;
    assert!(h
        .store
        .mark_scheduled_phase(&row.id, None, "waiting", NOW)
        .await
        .unwrap());
    // Boot: recovery, report, then the poller's sweep (claim + fire).
    let outcome = h
        .store
        .recover_orphaned_scheduled_messages(NOW)
        .await
        .unwrap();
    assert_eq!(outcome.rearmed, vec!["r1".to_string()]);
    h.handle.report_recovery(outcome).await;
    let claimed = h
        .store
        .claim_next_due_scheduled_message("2026-01-01T00:02:00Z", &[])
        .await
        .unwrap()
        .expect("re-armed row is due");
    h.ready(Ready);
    h.handle.fire(claimed).await;
    h.wait_status("r1", "sent").await;
    assert_eq!(h.io.pastes().len(), 1);
    assert_eq!(
        h.outcomes(),
        vec![
            ("r1".into(), TerminalOutcome::Rearmed),
            ("r1".into(), TerminalOutcome::Sent)
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn restart_fails_a_pasting_row_and_never_pastes_it() {
    let h = harness().await;
    let row = h.claimed("r1", "x", DUE, T0, Some("schedule")).await;
    h.store
        .mark_scheduled_phase(&row.id, None, "waiting", NOW)
        .await
        .unwrap();
    h.store
        .mark_scheduled_phase(&row.id, Some("waiting"), "pasting", NOW)
        .await
        .unwrap();
    let outcome = h
        .store
        .recover_orphaned_scheduled_messages(NOW)
        .await
        .unwrap();
    h.handle.report_recovery(outcome).await;
    h.ready(Ready);
    run_for(Duration::from_secs(10)).await;
    let r = h.row("r1").await.unwrap();
    assert_eq!(
        (r.status.as_str(), r.failure_kind.as_deref()),
        ("failed", Some("restarted_mid_paste"))
    );
    assert!(h.io.events().is_empty());
    assert_eq!(
        h.outcomes(),
        vec![(
            "r1".into(),
            TerminalOutcome::Failed(FailureKind::RestartedMidPaste)
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn report_recovery_reports_each_id_once_per_kind() {
    let h = harness().await;
    let o = RecoveryOutcome {
        rearmed: vec!["a".into()],
        failed_mid_paste: vec!["b".into()],
        failed_other_tmux: vec!["c".into()],
    };
    h.handle.report_recovery(o.clone()).await;
    h.handle.report_recovery(o).await;
    assert_eq!(
        h.outcomes(),
        vec![
            ("a".into(), TerminalOutcome::Rearmed),
            (
                "b".into(),
                TerminalOutcome::Failed(FailureKind::RestartedMidPaste)
            ),
            ("c".into(), TerminalOutcome::Failed(FailureKind::Error)),
        ]
    );
}

// ── 5.T9 ────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn copy_mode_is_cancelled_once_before_the_paste() {
    let h = harness().await;
    h.ready(Ready);
    h.io.set(|s| {
        s.flags = Some(PaneFlags {
            in_mode: true,
            dead: false,
        })
    });
    h.add_fire("r1", "hi").await;
    h.wait_status("r1", "sent").await;
    let kinds: Vec<Ev> = h.io.events().into_iter().map(|(_, e)| e).collect();
    assert_eq!(kinds.len(), 3, "{kinds:?}");
    assert_eq!(kinds[0], Ev::CancelMode);
    assert!(matches!(kinds[1], Ev::Paste { .. }));
    assert_eq!(kinds[2], Ev::Enter);
}

#[tokio::test(start_paused = true)]
async fn no_copy_mode_means_cancel_mode_is_never_called() {
    let h = harness().await;
    h.ready(Ready);
    h.add_fire("r1", "hi").await;
    h.wait_status("r1", "sent").await;
    assert_eq!(h.io.count(&Ev::CancelMode), 0);
}

// ── 5.T10 ───────────────────────────────────────────────────────────────────

async fn two_rows_same_instant(h: &H) {
    let r1 = h
        .claimed("r1", "first", DUE, "2026-01-01T00:00:00Z", Some("schedule"))
        .await;
    let r2 = h
        .claimed(
            "r2",
            "second",
            DUE,
            "2026-01-01T00:00:01Z",
            Some("schedule"),
        )
        .await;
    h.handle.fire(r1).await;
    h.handle.fire(r2).await;
}

#[tokio::test(start_paused = true)]
async fn same_instant_rows_never_interleave_and_wait_for_the_guard() {
    let h = harness().await;
    h.ready(Ready); // Ready the whole time
                    // The pane redraws once right after Enter, then stays as it is.
    two_rows_same_instant(&h).await;
    h.wait_status("r2", "sent").await;
    let pastes = h.io.pastes();
    let enters = h.io.enters();
    assert_eq!(
        pastes.iter().map(|p| p.1.as_str()).collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert_eq!(enters.len(), 2);
    // Strictly after the first Enter + 3 s.
    assert!(
        pastes[1].0 >= enters[0] + MIN_GAP_AFTER_ENTER,
        "second paste too early"
    );
    // The first paste happened before the second job could have started.
    assert!(pastes[0].0 < enters[0] && enters[0] <= pastes[1].0);
}

#[tokio::test(start_paused = true)]
async fn an_unchanged_pane_never_lets_the_next_job_paste() {
    let h = harness().await;
    h.ready(Ready);
    // Enter leaves the screen exactly as the pre-Enter baseline.
    h.io.set(|s| s.after_enter_text = None);
    two_rows_same_instant(&h).await;
    h.wait_status("r1", "sent").await;
    h.wait_status("r2", "failed").await;
    assert_eq!(h.io.pastes().len(), 1, "second never pasted");
    assert_eq!(
        h.row("r2").await.unwrap().failure_kind.as_deref(),
        Some("timed_out")
    );
}

#[tokio::test(start_paused = true)]
async fn second_jobs_clock_starts_when_it_heads_the_fifo() {
    let h = harness().await;
    two_rows_same_instant(&h).await;
    // First job waits 9.5 minutes, then goes; the second then waits 5 more
    // minutes: more than 10 minutes after its fire, less than 10 from its start.
    run_for(Duration::from_secs(570)).await;
    h.ready(Ready);
    h.wait_status("r1", "sent").await;
    h.ready(Unknown);
    run_for(Duration::from_secs(300)).await;
    assert_eq!(
        h.status("r2").await,
        "pending",
        "still waiting after > 10 min since fire"
    );
    h.ready(Ready);
    h.wait_status("r2", "sent").await;
}

// ── 5.T11 ───────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn oversize_or_multiline_without_support_fails_channel_unsupported() {
    let h = harness().await;
    h.ready(Ready);
    h.add_fire("big", &"x".repeat(33 * 1024)).await;
    h.wait_status("big", "failed").await;
    assert_eq!(
        h.row("big").await.unwrap().failure_kind.as_deref(),
        Some("channel_unsupported")
    );
    h.spec(|s| s.caps = Some(caps(false)));
    h.add_fire("ml", "a\nb").await;
    h.wait_status("ml", "failed").await;
    assert_eq!(
        h.row("ml").await.unwrap().failure_kind.as_deref(),
        Some("channel_unsupported")
    );
    assert!(h.io.events().is_empty());
}

// ── 5.T12 ───────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn session_removed_stops_the_job_and_reports_gone() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "hi").await;
    run_for(Duration::from_secs(2)).await;
    h.handle.on_session_removed(S).await;
    h.ready(Ready);
    h.spec(|s| s.deleted = true);
    run_for(Duration::from_secs(5)).await;
    assert!(h.io.events().is_empty());
    // The job never fails the row; the delete route removes it.
    assert_eq!(h.status("r1").await, "pending");
    assert_eq!(h.outcomes(), vec![("r1".into(), TerminalOutcome::Gone)]);
}

#[tokio::test(start_paused = true)]
async fn archived_or_hidden_fails_archived_without_pasting() {
    let h = harness().await;
    h.ready(Ready);
    h.spec(|s| s.gone = true);
    h.add_fire("r1", "hi").await;
    h.wait_status("r1", "failed").await;
    let r = h.row("r1").await.unwrap();
    assert_eq!(r.failure_kind.as_deref(), Some("archived"));
    assert_eq!(
        r.failure_reason.as_deref(),
        Some("The session was archived before this message was due.")
    );
    assert!(h.io.events().is_empty());
}

// ── 5.T13 ───────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn busy_agent_gets_nothing_until_ready_twice() {
    let h = harness().await;
    h.script(&[Unknown, Unknown, Unknown, Unknown, Unknown, Ready, Unknown]);
    h.ready(Ready);
    h.add_fire("r1", "hi").await;
    h.wait_status("r1", "sent").await;
    // 7 scripted readings, then Ready, Ready: the paste is on the 9th probe at
    // the earliest, never on the lone Ready among them.
    assert_eq!(h.io.pastes().len(), 1);
}

// ── 5.T16 ───────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn fire_is_idempotent_and_accepts_an_already_waiting_immediate_row() {
    let h = harness().await;
    // An immediate row inserted already claimed + waiting (as part 04 does).
    let row = h.claimed("r1", "now", DUE, T0, Some("immediate")).await;
    assert!(h
        .store
        .mark_scheduled_phase("r1", None, "waiting", NOW)
        .await
        .unwrap());
    h.handle.fire(row.clone()).await;
    h.handle.fire(row).await;
    assert!(h.outcomes().is_empty(), "fire itself calls no observer");
    h.ready(Ready);
    h.wait_status("r1", "sent").await;
    run_for(Duration::from_secs(10)).await;
    assert_eq!(h.io.pastes().len(), 1, "one job, one paste");
    assert_eq!(h.outcomes(), vec![("r1".into(), TerminalOutcome::Sent)]);
}

#[tokio::test(start_paused = true)]
async fn custom_paste_body_is_sanitized_and_rechecked() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let body: PasteBody = Arc::new(|row| {
        if row.id == "big" {
            "y".repeat(33 * 1024)
        } else {
            format!("{}\u{1b}[31m\u{202e}!", row.message)
        }
    });
    let h = h_with(store, dir, FakeIo::new(), Some(body), "r1");
    h.ready(Ready);
    h.add_fire("r1", "hello").await;
    h.wait_status("r1", "sent").await;
    assert_eq!(h.io.pastes()[0].1, "hello[31m!");
    h.add_fire("big", "ignored").await;
    h.wait_status("big", "failed").await;
    assert_eq!(
        h.row("big").await.unwrap().failure_kind.as_deref(),
        Some("channel_unsupported")
    );
    assert_eq!(h.io.pastes().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn stop_for_reset_stops_jobs_fails_immediate_rows_and_leaves_schedule_rows_claimed() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "sched").await;
    let imm = h
        .claimed("r2", "imm", DUE, "2026-01-01T00:00:01Z", Some("immediate"))
        .await;
    h.handle.fire(imm).await;
    h.handle.stop_for_reset(S).await;

    // The schedule row stays claimed + waiting: only `reassign` may move it.
    let r1 = h.row("r1").await.unwrap();
    assert_eq!(
        (
            r1.status.as_str(),
            r1.claimed_at.is_some(),
            r1.delivery_phase.as_deref()
        ),
        ("pending", true, Some("waiting"))
    );
    let r2 = h.row("r2").await.unwrap();
    assert_eq!(
        (r2.status.as_str(), r2.failure_kind.as_deref()),
        ("failed", Some("archived"))
    );
    // Jobs are stopped: even Ready never pastes, and the archive that follows
    // cannot fail the still-claimed row with the wrong reason.
    h.ready(Ready);
    h.spec(|s| s.gone = true);
    run_for(Duration::from_secs(10)).await;
    assert!(h.io.events().is_empty());
    assert_eq!(h.status("r1").await, "pending");
    assert_eq!(
        h.outcomes(),
        vec![("r2".into(), TerminalOutcome::Failed(FailureKind::Archived))]
    );
    // Reassignment un-claims and moves it in one statement.
    assert_eq!(
        h.store
            .reassign_scheduled_messages(S, "s-new", NOW)
            .await
            .unwrap(),
        1
    );
    let moved = h.row("r1").await.unwrap();
    assert_eq!(
        (
            moved.session_id.as_str(),
            moved.claimed_at.is_none(),
            moved.delivery_phase.is_none()
        ),
        ("s-new", true, true)
    );
}

#[tokio::test(start_paused = true)]
async fn rearm_after_failed_reset_puts_stopped_schedule_rows_back() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "sched").await;
    h.handle.stop_for_reset(S).await;
    h.handle.rearm_after_failed_reset(S).await;
    let r1 = h.row("r1").await.unwrap();
    assert_eq!(
        (
            r1.status.as_str(),
            r1.claimed_at.is_none(),
            r1.delivery_phase.is_none()
        ),
        ("pending", true, true)
    );
    assert_eq!(h.outcomes(), vec![("r1".into(), TerminalOutcome::Rearmed)]);
}

/// A row made under Rich Chat (stored channel `json`) that is `waiting` on a
/// session since switched to Terminal is still the delivery handle's to stop.
#[tokio::test(start_paused = true)]
async fn rows_are_selected_by_delivery_phase_not_the_stored_channel() {
    let h = harness().await;
    h.ready(Unknown);
    h.store
        .insert_scheduled_message(
            "rj",
            S,
            "from json",
            None,
            DUE,
            T0,
            Some("json"),
            None,
            Some("schedule"),
        )
        .await
        .unwrap();
    let row = h
        .store
        .claim_scheduled_message("rj", S, NOW)
        .await
        .unwrap()
        .unwrap();
    h.handle.fire(row).await;
    h.handle.on_session_removed(S).await;
    assert_eq!(h.outcomes(), vec![("rj".into(), TerminalOutcome::Gone)]);
    h.ready(Ready);
    run_for(Duration::from_secs(10)).await;
    assert!(h.io.events().is_empty(), "its job was stopped");
}

#[tokio::test(start_paused = true)]
async fn a_row_moved_to_another_session_ends_the_old_job_without_failing_it() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "sched").await;
    // Moved (reassigned) and re-claimed for another session while the old job lives.
    h.store
        .reassign_scheduled_messages(S, "s-new", NOW)
        .await
        .unwrap();
    h.store
        .claim_scheduled_message("r1", "s-new", NOW)
        .await
        .unwrap();
    assert!(h
        .store
        .mark_scheduled_phase("r1", None, "waiting", NOW)
        .await
        .unwrap());
    h.spec(|s| s.gone = true);
    run_for(Duration::from_secs(5)).await;
    assert_eq!(
        h.status("r1").await,
        "pending",
        "the old job must not fail it"
    );
    assert!(h.outcomes().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_fresh_claim_replaces_a_stale_job_instead_of_leaving_the_row_jobless() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "sched").await;
    // Re-claimed (as after a reset moved it) while the first fire's job is still known.
    h.store.rearm_scheduled_message("r1", NOW).await.unwrap();
    let row = h
        .store
        .claim_scheduled_message("r1", S, NOW)
        .await
        .unwrap()
        .expect("re-claim");
    h.handle.fire(row).await;
    h.ready(Ready);
    h.wait_status("r1", "sent").await;
    assert_eq!(h.io.pastes().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn channel_flip_rearms_schedule_rows_and_fails_immediate_rows() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "sched").await;
    let imm = h
        .claimed("r2", "imm", DUE, "2026-01-01T00:00:01Z", Some("immediate"))
        .await;
    h.handle.fire(imm).await;
    h.spec(|s| {
        s.channel_is_tmux = false;
        s.channel_is_json = true;
    });
    h.wait_status("r2", "failed").await;
    // r1 sat behind r2 in the FIFO; its job runs next and sees the flip too.
    let start = Instant::now();
    while h.row("r1").await.unwrap().claimed_at.is_some() {
        assert!(start.elapsed() < Duration::from_secs(30));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(h.row("r1").await.unwrap().delivery_phase, None);
    assert_eq!(
        h.row("r2").await.unwrap().failure_kind.as_deref(),
        Some("channel_unsupported")
    );
    let mut o = h.outcomes();
    o.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        o,
        vec![
            ("r1".into(), TerminalOutcome::Rearmed),
            (
                "r2".into(),
                TerminalOutcome::Failed(FailureKind::ChannelUnsupported)
            )
        ]
    );
    assert!(h.io.events().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_channel_that_is_neither_tmux_nor_json_fails_a_schedule_row() {
    let h = harness().await;
    h.spec(|s| {
        s.channel_is_tmux = false;
        s.channel_is_json = false;
    });
    h.add_fire("r1", "x").await;
    h.wait_status("r1", "failed").await;
    assert_eq!(
        h.row("r1").await.unwrap().failure_kind.as_deref(),
        Some("channel_unsupported")
    );
}

#[tokio::test(start_paused = true)]
async fn attachments_on_a_flipped_row_fail_the_delivery() {
    let h = harness().await;
    h.ready(Ready);
    h.store
        .insert_scheduled_message(
            "r1",
            S,
            "x",
            Some("[{\"id\":\"a\"}]"),
            DUE,
            T0,
            Some("json"),
            None,
            Some("schedule"),
        )
        .await
        .unwrap();
    let row = h
        .store
        .claim_scheduled_message("r1", S, NOW)
        .await
        .unwrap()
        .unwrap();
    h.handle.fire(row).await;
    h.wait_status("r1", "failed").await;
    let r = h.row("r1").await.unwrap();
    assert_eq!(r.failure_kind.as_deref(), Some("channel_unsupported"));
    assert!(r.failure_reason.unwrap().contains("Attachments"));
    assert!(h.io.events().is_empty());
}

// ── 5.T17 ───────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn cancel_row_reports_cancelled_once_for_waiting_and_scheduled_rows() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "w").await;
    // A scheduled (unclaimed) row with no job.
    h.store
        .insert_scheduled_message(
            "r2",
            S,
            "s",
            None,
            "2026-02-01T00:00:00Z",
            T0,
            Some("tmux"),
            None,
            Some("schedule"),
        )
        .await
        .unwrap();
    assert_eq!(
        h.handle.cancel_row(S, "r1").await.unwrap(),
        CancelOutcome::Deleted
    );
    assert_eq!(
        h.handle.cancel_row(S, "r2").await.unwrap(),
        CancelOutcome::Deleted
    );
    assert_eq!(
        h.handle.cancel_row(S, "r1").await.unwrap(),
        CancelOutcome::NotFound
    );
    assert_eq!(
        h.outcomes(),
        vec![
            ("r1".into(), TerminalOutcome::Cancelled),
            ("r2".into(), TerminalOutcome::Cancelled)
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn cancel_losing_to_pasting_reports_nothing() {
    let h = harness().await;
    h.ready(Unknown);
    h.add_fire("r1", "w").await;
    // The job won the phase CAS (simulated by the store call it makes).
    assert!(h
        .store
        .mark_scheduled_phase("r1", Some("waiting"), "pasting", NOW)
        .await
        .unwrap());
    assert_eq!(
        h.handle.cancel_row(S, "r1").await.unwrap(),
        CancelOutcome::InFlight
    );
    assert!(h.outcomes().is_empty());
}

#[tokio::test(start_paused = true)]
async fn failed_phase_cas_in_fire_is_reported_as_error_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vibe-station.db");
    let store = StoreHandle::open(&path).unwrap();
    let h = h_with(store, dir, FakeIo::new(), None, "r1");
    let row = h.claimed("r1", "x", DUE, T0, Some("schedule")).await;
    // Make only the NULL -> waiting write fail.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER boom BEFORE UPDATE OF deliveryPhase ON scheduled_messages \
         WHEN NEW.deliveryPhase = 'waiting' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    )
    .unwrap();
    h.handle.fire(row.clone()).await;
    h.handle.fire(row).await; // a second call must not double-report
    let r = h.row("r1").await.unwrap();
    assert_eq!(
        (r.status.as_str(), r.failure_kind.as_deref()),
        ("failed", Some("error"))
    );
    assert_eq!(
        h.outcomes(),
        vec![("r1".into(), TerminalOutcome::Failed(FailureKind::Error))]
    );
}

#[tokio::test(start_paused = true)]
async fn a_none_observer_is_a_noop() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let res = Arc::new(FakeResolver {
        spec: Mutex::new(Spec {
            channel_is_tmux: true,
            channel_is_json: false,
            gone: false,
            exited: false,
            caps: Some(caps(true)),
            deleted: false,
        }),
        script: Arc::new(Script {
            queue: Mutex::new(VecDeque::new()),
            default: Mutex::new(Ready),
        }),
    });
    let notify: NotifyScheduled = Arc::new(|_| Box::pin(async {}));
    let handle = TerminalDeliveryHandle::new(store.clone(), FakeIo::new(), res, notify, None);
    store
        .insert_scheduled_message("r1", S, "x", None, DUE, T0, Some("tmux"), None, None)
        .await
        .unwrap();
    let row = store
        .claim_scheduled_message("r1", S, NOW)
        .await
        .unwrap()
        .unwrap();
    handle.fire(row).await;
    let start = Instant::now();
    while store
        .get_scheduled_message("r1")
        .await
        .unwrap()
        .unwrap()
        .status
        != "sent"
    {
        assert!(start.elapsed() < Duration::from_secs(60));
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    handle.shutdown();
}

// ── 5.T18 ───────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn probe_once_reads_without_writing_or_pasting() {
    let h = harness().await;
    h.ready(Ready);
    assert_eq!(h.handle.probe_once(S).await, Ready);
    assert!(h.io.events().is_empty());
    assert!(h
        .store
        .list_pending_scheduled_messages(S)
        .await
        .unwrap()
        .is_empty());

    h.ready(AwaitingApproval);
    assert_eq!(h.handle.probe_once(S).await, AwaitingApproval);

    h.ready(Ready);
    h.spec(|s| s.gone = true);
    assert_eq!(h.handle.probe_once(S).await, Unknown);
    h.spec(|s| {
        s.gone = false;
        s.exited = true;
    });
    assert_eq!(h.handle.probe_once(S).await, Unknown);
    h.spec(|s| {
        s.exited = false;
        s.caps = None;
    });
    assert_eq!(h.handle.probe_once(S).await, Unknown);
    h.spec(|s| {
        s.caps = Some(caps(true));
        s.deleted = true;
    });
    assert_eq!(h.handle.probe_once(S).await, Unknown);
    h.spec(|s| {
        s.deleted = false;
        s.channel_is_tmux = false;
    });
    assert_eq!(h.handle.probe_once(S).await, Unknown);
    h.spec(|s| s.channel_is_tmux = true);
    h.io.set(|s| {
        s.flags = Some(PaneFlags {
            in_mode: false,
            dead: true,
        })
    });
    assert_eq!(h.handle.probe_once(S).await, Unknown);
    h.io.set(|s| {
        s.flags = Some(PaneFlags {
            in_mode: false,
            dead: false,
        });
        s.names = Some(HashSet::new());
    });
    assert_eq!(h.handle.probe_once(S).await, Unknown);
    h.io.set(|s| s.capture_err = true);
    h.io.set(|s| s.names = Some(["agent".to_string()].into_iter().collect()));
    assert_eq!(h.handle.probe_once(S).await, Unknown);
}

/// A capture that hangs must not hold `probe_once` past its 2 s bound (real
/// time: the blocking thread cannot be driven by the paused clock).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_once_is_bounded_on_a_hung_capture() {
    struct Hung;
    impl PaneIo for Hung {
        fn list_session_names(&self) -> Option<HashSet<String>> {
            Some(["agent".to_string()].into_iter().collect())
        }
        fn pane_flags(&self, _: &str) -> Option<PaneFlags> {
            Some(PaneFlags {
                in_mode: false,
                dead: false,
            })
        }
        fn capture(&self, _: &str) -> Result<PaneSnapshot, String> {
            std::thread::sleep(Duration::from_secs(4));
            Ok(PaneSnapshot::default())
        }
        fn cancel_mode(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn paste(&self, _: &str, _: &str, _: &str, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn send_enter(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let res = Arc::new(FakeResolver {
        spec: Mutex::new(Spec {
            channel_is_tmux: true,
            channel_is_json: false,
            gone: false,
            exited: false,
            caps: Some(caps(true)),
            deleted: false,
        }),
        script: Arc::new(Script {
            queue: Mutex::new(VecDeque::new()),
            default: Mutex::new(Ready),
        }),
    });
    let notify: NotifyScheduled = Arc::new(|_| Box::pin(async {}));
    let handle = TerminalDeliveryHandle::new(store, Arc::new(Hung), res, notify, None);
    let t = std::time::Instant::now();
    assert_eq!(handle.probe_once(S).await, Unknown);
    let took = t.elapsed();
    assert!(
        took >= Duration::from_secs(2) && took < Duration::from_millis(3500),
        "{took:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn copy_mode_entered_during_the_settle_is_left_before_enter() {
    let h = harness().await;
    h.io.set(|s| s.scroll_during_settle = true);
    h.ready(Ready);
    h.add_fire("r1", "hi").await;
    h.wait_status("r1", "sent").await;
    let kinds: Vec<Ev> = h.io.events().into_iter().map(|(_, e)| e).collect();
    assert!(
        matches!(
            kinds.as_slice(),
            [Ev::Paste { .. }, Ev::CancelMode, Ev::Enter]
        ),
        "{kinds:?}"
    );
}

/// A tmux call that never returns must not freeze the session's queue: the job
/// fails `timed_out` before the paste (real time; the blocking thread cannot be
/// driven by the paused clock).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hung_pane_call_fails_the_job_timed_out_instead_of_freezing_the_queue() {
    struct Hung;
    impl PaneIo for Hung {
        fn list_session_names(&self) -> Option<HashSet<String>> {
            std::thread::sleep(Duration::from_secs(3));
            None
        }
        fn pane_flags(&self, _: &str) -> Option<PaneFlags> {
            None
        }
        fn capture(&self, _: &str) -> Result<PaneSnapshot, String> {
            Err("hung".into())
        }
        fn cancel_mode(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn paste(&self, _: &str, _: &str, _: &str, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn send_enter(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let res = Arc::new(FakeResolver {
        spec: Mutex::new(Spec {
            channel_is_tmux: true,
            channel_is_json: false,
            gone: false,
            exited: false,
            caps: Some(caps(true)),
            deleted: false,
        }),
        script: Arc::new(Script {
            queue: Mutex::new(VecDeque::new()),
            default: Mutex::new(Ready),
        }),
    });
    let notify: NotifyScheduled = Arc::new(|_| Box::pin(async {}));
    let (obs, outcomes) = observer_pair();
    let handle = TerminalDeliveryHandle::new(store.clone(), Arc::new(Hung), res, notify, Some(obs))
        .with_timeouts(Duration::from_millis(100), Duration::from_millis(600));
    store
        .insert_scheduled_message(
            "r1",
            S,
            "hi",
            None,
            DUE,
            T0,
            Some("tmux"),
            None,
            Some("schedule"),
        )
        .await
        .unwrap();
    let row = store
        .claim_scheduled_message("r1", S, NOW)
        .await
        .unwrap()
        .unwrap();
    handle.fire(row).await;
    let start = std::time::Instant::now();
    loop {
        let r = store.get_scheduled_message("r1").await.unwrap().unwrap();
        if r.status == "failed" {
            assert_eq!(r.failure_kind.as_deref(), Some("timed_out"));
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5), "queue is frozen");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        outcomes.lock().unwrap().clone(),
        vec![("r1".into(), TerminalOutcome::Failed(FailureKind::TimedOut))]
    );
}

/// A paste call that never returns fails the row (it is `pasting`: not retried).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hung_paste_fails_the_row_with_error() {
    struct HungPaste;
    impl PaneIo for HungPaste {
        fn list_session_names(&self) -> Option<HashSet<String>> {
            Some(["agent".to_string()].into_iter().collect())
        }
        fn pane_flags(&self, _: &str) -> Option<PaneFlags> {
            Some(PaneFlags {
                in_mode: false,
                dead: false,
            })
        }
        fn capture(&self, _: &str) -> Result<PaneSnapshot, String> {
            Ok(PaneSnapshot::default())
        }
        fn cancel_mode(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn paste(&self, _: &str, _: &str, _: &str, _: bool) -> Result<(), String> {
            std::thread::sleep(Duration::from_secs(3));
            Ok(())
        }
        fn send_enter(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let res = Arc::new(FakeResolver {
        spec: Mutex::new(Spec {
            channel_is_tmux: true,
            channel_is_json: false,
            gone: false,
            exited: false,
            caps: Some(caps(true)),
            deleted: false,
        }),
        script: Arc::new(Script {
            queue: Mutex::new(VecDeque::new()),
            default: Mutex::new(Ready),
        }),
    });
    let notify: NotifyScheduled = Arc::new(|_| Box::pin(async {}));
    let handle = TerminalDeliveryHandle::new(store.clone(), Arc::new(HungPaste), res, notify, None)
        .with_timeouts(Duration::from_millis(100), Duration::from_secs(60));
    store
        .insert_scheduled_message(
            "r1",
            S,
            "hi",
            None,
            DUE,
            T0,
            Some("tmux"),
            None,
            Some("schedule"),
        )
        .await
        .unwrap();
    let row = store
        .claim_scheduled_message("r1", S, NOW)
        .await
        .unwrap()
        .unwrap();
    handle.fire(row).await;
    let start = std::time::Instant::now();
    loop {
        let r = store.get_scheduled_message("r1").await.unwrap().unwrap();
        if r.status == "failed" {
            assert_eq!(r.failure_kind.as_deref(), Some("error"));
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "row stuck pasting"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 13a: a reset must not fail (and so restore the comments of) an immediate row
/// whose job already won the `waiting` -> `pasting` CAS: that paste happens.
#[tokio::test(start_paused = true)]
async fn stop_for_reset_leaves_an_immediate_row_that_is_already_pasting() {
    let h = harness().await;
    h.claimed("r1", "now", DUE, T0, Some("immediate")).await;
    assert!(h
        .store
        .mark_scheduled_phase("r1", None, "waiting", NOW)
        .await
        .unwrap());
    assert!(h
        .store
        .mark_scheduled_phase("r1", Some("waiting"), "pasting", NOW)
        .await
        .unwrap());
    h.handle.stop_for_reset(S).await;
    let r = h.row("r1").await.unwrap();
    assert_eq!(
        (r.status.as_str(), r.delivery_phase.as_deref()),
        ("pending", Some("pasting"))
    );
    assert!(h.outcomes().is_empty());
    assert!(!h
        .store
        .mark_waiting_scheduled_message_failed("r1", "x", Some("archived"), NOW)
        .await
        .unwrap());
}

/// L1-01: session removal sees every row, not the display-capped first 100.
#[tokio::test(start_paused = true)]
async fn session_removed_reports_gone_for_rows_beyond_the_display_cap() {
    let h = harness().await;
    for i in 0..101 {
        let origin = if i == 100 { "immediate" } else { "schedule" };
        h.store
            .insert_scheduled_message(
                &format!("m{i:03}"),
                S,
                "x",
                None,
                &format!("2030-01-01T00:{:02}:{:02}.000Z", i / 60, i % 60),
                T0,
                Some("tmux"),
                None,
                Some(origin),
            )
            .await
            .unwrap();
    }
    h.handle.on_session_removed(S).await;
    let gone = h
        .outcomes()
        .into_iter()
        .filter(|(_, o)| matches!(o, TerminalOutcome::Gone))
        .count();
    assert_eq!(gone, 101);
}
