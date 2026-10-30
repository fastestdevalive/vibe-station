//! Hold / liveness / grace behaviour of `TaskRegistry` (paused tokio time, a
//! fake liveness probe, real files under a temp allowlisted root).

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vst_tasks::{
    format_ms, HoldLapse, Liveness, LivenessProbe, TaskObservation, TaskRegistry, REASON_EXITED,
    REASON_HOLD_CAP, REASON_UNVERIFIED, TASK_END_GRACE_MS, TASK_HOLD_CAP_MS,
    TASK_UNVERIFIED_HOLD_MS,
};
use vst_types::{NormalizedEvent, TaskState, TaskSummary};

type Script = Arc<Mutex<HashMap<String, Vec<TaskObservation>>>>;

/// Probe whose answer the test sets; counts calls; can hang to model "in flight".
struct FakeProbe {
    answer: Mutex<Liveness>,
    calls: AtomicUsize,
    hang: Mutex<bool>,
}

impl FakeProbe {
    fn new(l: Liveness) -> Arc<Self> {
        Arc::new(Self {
            answer: Mutex::new(l),
            calls: AtomicUsize::new(0),
            hang: Mutex::new(false),
        })
    }
    fn set(&self, l: Liveness) {
        *self.answer.lock().unwrap() = l;
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl LivenessProbe for FakeProbe {
    fn probe<'a>(&'a self, _p: &'a Path) -> Pin<Box<dyn Future<Output = Liveness> + Send + 'a>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if *self.hang.lock().unwrap() {
                std::future::pending::<()>().await;
            }
            *self.answer.lock().unwrap()
        })
    }
}

struct H {
    reg: TaskRegistry,
    script: Script,
    probe: Arc<FakeProbe>,
    root: PathBuf,
    _dir: tempfile::TempDir,
    n: AtomicUsize,
}

fn harness(l: Liveness) -> H {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let script: Script = Arc::default();
    let s2 = script.clone();
    let reg = TaskRegistry::with_roots(
        Arc::new(move |ev: &NormalizedEvent| {
            s2.lock().unwrap().get(&ev.id).cloned().unwrap_or_default()
        }),
        Arc::new(|_, _| {}),
        vec![root.clone()],
    );
    let probe = FakeProbe::new(l);
    reg.set_probe_for_test(probe.clone());
    H {
        reg,
        script,
        probe,
        root,
        _dir: dir,
        n: AtomicUsize::new(0),
    }
}

impl H {
    fn event(&self, turn: Option<&str>, obs: Vec<TaskObservation>) -> NormalizedEvent {
        let id = format!("e{}", self.n.fetch_add(1, Ordering::SeqCst));
        self.script.lock().unwrap().insert(id.clone(), obs);
        NormalizedEvent {
            id,
            ts: format_ms(self.reg.now_ms()),
            turn_id: turn.map(str::to_string),
            ..NormalizedEvent::default()
        }
    }

    fn feed(&self, obs: Vec<TaskObservation>) {
        self.reg.observe(&self.event(Some("t1"), obs));
    }

    /// Background a command; `file` = whether its output file exists on disk.
    fn command(&self, id: &str, with_path: bool, file: bool) {
        let dir = self.root.join("claude-1000/p/tasks");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.output"));
        if file {
            std::fs::write(&path, b"").unwrap();
        }
        self.feed(vec![
            TaskObservation::CommandLaunched {
                tool_id: format!("tool-{id}"),
                command: format!("sleep 9999 # {id}"),
            },
            TaskObservation::CommandBackgrounded {
                tool_id: format!("tool-{id}"),
                task_id: id.into(),
                output_path: with_path.then(|| path.to_string_lossy().into_owned()),
            },
        ]);
    }

    fn tasks(&self) -> Vec<TaskSummary> {
        self.reg.snapshot().expect("not rebuilding").1
    }

    fn task(&self, id: &str) -> TaskSummary {
        self.tasks().into_iter().find(|t| t.id == id).expect("task")
    }
}

/// Advance paused time in steps so timer-driven work interleaves like real time.
async fn run(ms: i64) {
    let mut left = ms;
    while left > 0 {
        let step = left.min(1_000);
        tokio::time::advance(Duration::from_millis(u64::try_from(step).unwrap())).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        left -= step;
    }
}

#[tokio::test(start_paused = true)]
async fn alive_probe_holds_until_the_cap_then_lapses_with_reason() {
    let h = harness(Liveness::Alive);
    h.command("b1", true, true);
    assert_eq!(h.reg.hold().holding, 1);
    run(3_000).await;
    assert!(h.probe.calls() >= 1);
    run(TASK_HOLD_CAP_MS - 60_000).await;
    assert_eq!(h.reg.hold().holding, 1);
    run(2 * 60_000).await;
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert_eq!(hold.lapsed.len(), 1);
    assert_eq!(hold.lapsed[0].id, "b1");
    assert_eq!(hold.lapsed[0].why, HoldLapse::AliveCap);
    let t = h.task("b1");
    assert_eq!(t.state, TaskState::Running);
    assert_eq!(t.reason.as_deref(), Some(REASON_HOLD_CAP));
}

#[tokio::test(start_paused = true)]
async fn two_no_writer_probes_end_the_command_one_does_not() {
    let h = harness(Liveness::NoWriter);
    h.command("b1", true, true);
    run(3_000).await; // first probe: one NoWriter
    assert_eq!(h.task("b1").state, TaskState::Running);
    h.probe.set(Liveness::Alive); // resets the count
    run(10_000).await;
    h.probe.set(Liveness::NoWriter);
    run(10_000).await; // one NoWriter after the reset
    assert_eq!(h.task("b1").state, TaskState::Running);
    run(10_000).await; // second consecutive
    let t = h.task("b1");
    assert_eq!(t.state, TaskState::Done);
    assert_eq!(t.reason.as_deref(), Some(REASON_EXITED));
    assert_eq!(h.reg.hold().holding, 0);
}

#[tokio::test(start_paused = true)]
async fn command_without_path_holds_ten_minutes_since_activity_and_oob_rearms() {
    let h = harness(Liveness::Alive);
    h.command("b1", false, false);
    assert_eq!(h.reg.hold().holding, 1);
    run(TASK_UNVERIFIED_HOLD_MS - 60_000).await;
    assert_eq!(h.reg.hold().holding, 1);
    // Out-of-band activity re-arms the 10 min window.
    h.reg.observe_out_of_band(&h.event(None, vec![]));
    run(TASK_UNVERIFIED_HOLD_MS - 60_000).await;
    assert_eq!(h.reg.hold().holding, 1);
    run(2 * 60_000).await;
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert_eq!(hold.lapsed[0].why, HoldLapse::Unverified);
    assert_eq!(h.task("b1").reason.as_deref(), Some(REASON_UNVERIFIED));
    assert_eq!(h.probe.calls(), 0, "no path, never probed");
}

#[tokio::test(start_paused = true)]
async fn unknown_probe_uses_unverified_rule_and_alive_restores_the_cap_rule() {
    let h = harness(Liveness::Unknown);
    h.command("b1", true, true);
    run(3_000).await;
    run(TASK_UNVERIFIED_HOLD_MS + 60_000).await;
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert_eq!(hold.lapsed[0].why, HoldLapse::Unverified);
    h.probe.set(Liveness::Alive);
    run(11_000).await; // next probe: Alive -> cap rule, still well inside 60 min
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 1);
    assert!(hold.lapsed.is_empty());
    assert_eq!(h.task("b1").reason, None);
}

#[tokio::test(start_paused = true)]
async fn bump_epoch_drops_the_hold_stamps_grace_and_publishes() {
    let h = harness(Liveness::Alive);
    h.command("b1", true, true);
    let mut rx = h.reg.subscribe_hold();
    rx.borrow_and_update();
    h.reg.bump_epoch();
    assert!(rx.has_changed().unwrap());
    let hold = rx.borrow_and_update().clone();
    assert_eq!(hold.holding, 0);
    assert!(hold.last_hold_end_ms.is_some());
    assert!(hold.grace_active);
    assert_eq!(h.task("b1").state, TaskState::Stale);

    // A rebuild leaves holding at 0 (running rows become Stale).
    let h2 = harness(Liveness::Alive);
    h2.reg.begin_rebuild();
    assert_eq!(h2.reg.hold().holding, 0);
    h2.reg.rebuild(&[]);
    assert_eq!(h2.reg.hold().holding, 0);

    // A rebuild over a row with a running command marks it Stale: no hold and,
    // being a restart rather than a fresh hold end, no grace.
    let h3 = harness(Liveness::Alive);
    let rows = vec![h3.event(
        Some("t1"),
        vec![
            TaskObservation::CommandLaunched {
                tool_id: "tool-r".into(),
                command: "sleep 9999".into(),
            },
            TaskObservation::CommandBackgrounded {
                tool_id: "tool-r".into(),
                task_id: "r1".into(),
                output_path: None,
            },
        ],
    )];
    h3.reg.begin_rebuild();
    h3.reg.rebuild(&rows);
    assert_eq!(h3.task("r1").state, TaskState::Stale);
    let hold = h3.reg.hold();
    assert_eq!(hold.holding, 0);
    assert!(!hold.grace_active);
    assert!(hold.last_hold_end_ms.is_none());
}

#[tokio::test(start_paused = true)]
async fn grace_is_stamped_synchronously_and_expiry_republishes() {
    let h = harness(Liveness::NoWriter);
    h.command("b1", true, true);
    let mut rx = h.reg.subscribe_hold();
    run(3_000).await;
    run(10_000).await; // second NoWriter -> Done
    assert_eq!(h.task("b1").state, TaskState::Done);
    // Synchronous read, no await: already carries the grace.
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert!(hold.last_hold_end_ms.is_some());
    assert!(hold.grace_active);
    rx.borrow_and_update();
    run(TASK_END_GRACE_MS + 2_000).await;
    assert!(
        rx.has_changed().unwrap(),
        "timer republished at grace expiry"
    );
    let hold = rx.borrow_and_update().clone();
    assert!(!hold.grace_active);
    assert!(hold.last_hold_end_ms.is_some());
}

#[tokio::test(start_paused = true)]
async fn liveness_init_cases() {
    // No path: unverified rule, never probed.
    let h = harness(Liveness::Alive);
    h.command("nopath", false, false);
    run(3_000).await;
    assert_eq!(h.probe.calls(), 0);
    run(TASK_UNVERIFIED_HOLD_MS + 60_000).await;
    assert_eq!(h.reg.hold().lapsed.len(), 1);

    // Path, no probe result yet (probe hangs): held under the alive rule even
    // past the 10 min unverified window.
    let h = harness(Liveness::Alive);
    *h.probe.hang.lock().unwrap() = true;
    h.command("p1", true, true);
    run(TASK_UNVERIFIED_HOLD_MS + 60_000).await;
    assert_eq!(h.probe.calls(), 1);
    assert_eq!(h.reg.hold().holding, 1);

    // Path that fails `resolve` (file missing): Unknown after the first probe,
    // so the unverified rule applies from then on and the probe is never called.
    let h = harness(Liveness::Alive);
    h.command("gone", true, false);
    assert_eq!(h.reg.hold().holding, 1);
    run(3_000).await;
    assert_eq!(h.probe.calls(), 0);
    run(TASK_UNVERIFIED_HOLD_MS + 60_000).await;
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert_eq!(hold.lapsed[0].why, HoldLapse::Unverified);
}

#[tokio::test(start_paused = true)]
async fn turn_settled_ends_only_background_subagents_of_that_turn() {
    let start = |h: &H, tool: &str, turn: &str, bg: bool| {
        h.reg.observe(&h.event(
            Some(turn),
            vec![TaskObservation::SubagentStarted {
                tool_id: tool.into(),
                label: format!("agent {tool}"),
                background: bg,
            }],
        ));
    };
    let h = harness(Liveness::Alive);
    start(&h, "a", "t1", true);
    start(&h, "b", "t2", true);
    start(&h, "c", "t1", false);
    assert_eq!(h.reg.hold().holding, 3);
    let settled = h.event(Some("t1"), vec![TaskObservation::TurnSettled]);
    h.reg.observe(&settled);
    assert_eq!(h.task("a").state, TaskState::Done);
    assert_eq!(h.task("a").reason, None);
    assert_eq!(h.task("b").state, TaskState::Running);
    assert_eq!(
        h.task("c").state,
        TaskState::Running,
        "sync subagent untouched"
    );
    assert_eq!(h.reg.hold().holding, 2);

    // A rebuild over the same kind of rows ends the same subagent as Done.
    let h2 = harness(Liveness::Alive);
    let mut rows2 = Vec::new();
    for (tool, turn) in [("a", "t1"), ("b", "t2")] {
        rows2.push(h2.event(
            Some(turn),
            vec![TaskObservation::SubagentStarted {
                tool_id: tool.into(),
                label: tool.into(),
                background: true,
            }],
        ));
    }
    rows2.push(h2.event(Some("t1"), vec![TaskObservation::TurnSettled]));
    h2.reg.begin_rebuild();
    h2.reg.rebuild(&rows2);
    assert_eq!(h2.task("a").state, TaskState::Done);
    assert_eq!(
        h2.task("b").state,
        TaskState::Stale,
        "still-running rows go stale"
    );
}

#[tokio::test(start_paused = true)]
async fn two_commands_hold_two_one_exits_publishes_once_and_probes_are_not_reissued() {
    let h = harness(Liveness::Alive);
    h.command("b1", true, true);
    h.command("b2", true, true);
    let mut rx = h.reg.subscribe_hold();
    rx.borrow_and_update();
    assert_eq!(h.reg.hold().holding, 2);
    run(3_000).await;
    h.probe.set(Liveness::NoWriter);
    // b1 and b2 both exit with the same probe; make only b1 die by ending b2's
    // hold differently: Done via a structured end signal.
    h.reg.observe(&h.event(
        Some("t1"),
        vec![TaskObservation::Ended {
            id: "b2".into(),
            tool_id: None,
            state: TaskState::Done,
            reason: None,
        }],
    ));
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 1);
    assert!(rx.has_changed().unwrap());
    assert_eq!(rx.borrow_and_update().holding, 1);
    assert!(!rx.has_changed().unwrap(), "published once");

    // In-flight guard: a hanging probe is not re-issued every tick.
    let h = harness(Liveness::Alive);
    *h.probe.hang.lock().unwrap() = true;
    h.command("b1", true, true);
    run(60_000).await;
    assert_eq!(h.probe.calls(), 1);
}

/// F2: an unverified command whose output keeps growing is still bounded by
/// the 60 min cap, and lapses with the cap reason.
#[tokio::test(start_paused = true)]
async fn unverified_command_with_growing_output_lapses_at_the_cap() {
    let h = harness(Liveness::Unknown);
    h.command("b1", true, true);
    let mut elapsed = 0;
    while elapsed < TASK_HOLD_CAP_MS - 6 * 60_000 {
        run(5 * 60_000).await;
        elapsed += 5 * 60_000;
        h.reg.observe_out_of_band(&h.event(None, vec![])); // output appended
        assert_eq!(h.reg.hold().holding, 1, "held at {elapsed} ms");
    }
    run(10 * 60_000).await;
    h.reg.observe_out_of_band(&h.event(None, vec![]));
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert_eq!(hold.lapsed[0].why, HoldLapse::AliveCap);
    assert_eq!(h.task("b1").reason.as_deref(), Some(REASON_HOLD_CAP));
    // More activity does not re-arm it.
    run(60_000).await;
    h.reg.observe_out_of_band(&h.event(None, vec![]));
    assert_eq!(h.reg.hold().holding, 0);
}

/// F1: only ends that a task-notification cycle can follow arm grace.
#[tokio::test(start_paused = true)]
async fn in_turn_ends_do_not_arm_grace() {
    let sub = |h: &H, tool: &str, turn: &str, bg: bool| {
        h.reg.observe(&h.event(
            Some(turn),
            vec![TaskObservation::SubagentStarted {
                tool_id: tool.into(),
                label: tool.into(),
                background: bg,
            }],
        ));
    };
    // Sync subagent result.
    let h = harness(Liveness::Alive);
    sub(&h, "a", "t1", false);
    assert_eq!(h.reg.hold().holding, 1);
    h.reg.observe(&h.event(
        Some("t1"),
        vec![TaskObservation::SubagentFinished {
            tool_id: "a".into(),
            ok: true,
            final_text: None,
        }],
    ));
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert!(!hold.grace_active && hold.last_hold_end_ms.is_none());

    // TurnSettled for a background subagent.
    let h = harness(Liveness::Alive);
    sub(&h, "b", "t1", true);
    h.reg
        .observe(&h.event(Some("t1"), vec![TaskObservation::TurnSettled]));
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert!(!hold.grace_active && hold.last_hold_end_ms.is_none());

    // turn_ended stops a sync subagent.
    let h = harness(Liveness::Alive);
    sub(&h, "c", "t1", false);
    h.reg.turn_ended("t1");
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert!(!hold.grace_active && hold.last_hold_end_ms.is_none());
}

#[tokio::test(start_paused = true)]
async fn skipped_probes_are_a_no_op_for_every_command() {
    let h = harness(Liveness::NoWriter);
    h.command("b1", true, true);
    h.command("b2", true, true);
    run(3_000).await; // one NoWriter each: counter = 1
    h.probe.set(Liveness::Skipped);
    // Far beyond the 10 min unverified window: a Skipped round must neither
    // flip the rule to "unknown" nor reset the dead-confirmation counter.
    run(TASK_UNVERIFIED_HOLD_MS + 60_000).await;
    assert!(h.probe.calls() > 4, "skipped probes are retried");
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 2);
    assert!(hold.lapsed.is_empty());
    h.probe.set(Liveness::NoWriter);
    run(15_000).await; // second NoWriter: counter preserved -> both end
    assert_eq!(h.task("b1").state, TaskState::Done);
    assert_eq!(h.task("b2").state, TaskState::Done);
}

#[tokio::test(start_paused = true)]
async fn in_band_events_count_as_activity_for_a_probe_less_command() {
    let h = harness(Liveness::Alive);
    h.command("b1", false, false);
    run(TASK_UNVERIFIED_HOLD_MS - 60_000).await;
    // A long human turn keeps emitting events: they are activity.
    h.reg.observe(&h.event(Some("t1"), vec![]));
    run(TASK_UNVERIFIED_HOLD_MS - 60_000).await;
    h.reg.observe(&h.event(Some("t1"), vec![]));
    run(TASK_UNVERIFIED_HOLD_MS - 60_000).await;
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 1);
    assert!(hold.lapsed.is_empty());
    // Once the events stop, the 10 min timer runs out from the last one.
    run(2 * 60_000).await;
    assert_eq!(h.reg.hold().lapsed.len(), 1);
}
