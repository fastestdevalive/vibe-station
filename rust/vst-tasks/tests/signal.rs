//! Structured task signals (`Confirmed` / `Ended`): authoritative over the
//! liveness probe, order-independent, bounded (paused tokio time, fake probe).

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vst_tasks::{
    format_ms, Liveness, LivenessProbe, TaskObservation, TaskRegistry, REASON_HOLD_CAP,
    REASON_PAUSED, TASK_END_GRACE_MS, TASK_HOLD_CAP_MS,
};
use vst_types::{NormalizedEvent, TaskState, TaskSummary};

type Script = Arc<Mutex<HashMap<String, Vec<TaskObservation>>>>;

/// Probe that always answers `NoWriter` (what a wrongly-dead guess would say) and counts calls.
struct DeadProbe(AtomicUsize);

impl LivenessProbe for DeadProbe {
    fn probe<'a>(&'a self, _p: &'a Path) -> Pin<Box<dyn Future<Output = Liveness> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Liveness::NoWriter
        })
    }
}

struct H {
    reg: TaskRegistry,
    script: Script,
    probe: Arc<DeadProbe>,
    root: PathBuf,
    _dir: tempfile::TempDir,
    n: AtomicUsize,
}

fn harness() -> H {
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
    let probe = Arc::new(DeadProbe(AtomicUsize::new(0)));
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

fn launched(id: &str) -> TaskObservation {
    TaskObservation::CommandLaunched {
        tool_id: format!("tool-{id}"),
        command: format!("sleep 9999 # {id}"),
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

    fn backgrounded(&self, id: &str) -> TaskObservation {
        let dir = self.root.join("claude-1000/p/tasks");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.output"));
        std::fs::write(&path, b"").unwrap();
        TaskObservation::CommandBackgrounded {
            tool_id: format!("tool-{id}"),
            task_id: id.into(),
            output_path: Some(path.to_string_lossy().into_owned()),
        }
    }

    fn command(&self, id: &str) {
        let b = self.backgrounded(id);
        self.feed(vec![launched(id), b]);
    }

    fn task(&self, id: &str) -> TaskSummary {
        self.reg
            .snapshot()
            .expect("not rebuilding")
            .1
            .into_iter()
            .find(|t| t.id == id)
            .expect("task")
    }
}

fn confirmed(id: &str, tool_id: Option<&str>, paused: bool) -> TaskObservation {
    TaskObservation::Confirmed {
        id: id.into(),
        tool_id: tool_id.map(str::to_string),
        paused,
    }
}

fn ended(id: &str, tool_id: Option<&str>, state: TaskState) -> TaskObservation {
    TaskObservation::Ended {
        id: id.into(),
        tool_id: tool_id.map(str::to_string),
        state,
        reason: None,
    }
}

async fn run(ms: i64) {
    let mut left = ms;
    while left > 0 {
        let step = left.min(1_000);
        tokio::time::advance(Duration::from_millis(u64::try_from(step).unwrap())).await;
        left -= step;
    }
}

/// 9.T1: once confirmed, the probe is ignored (and stops running); the hold is
/// the 60 min cap, then a visible lapse.
#[tokio::test(start_paused = true)]
async fn confirmed_command_ignores_the_probe_until_the_cap() {
    let h = harness();
    h.command("b1");
    h.feed(vec![confirmed("b1", Some("tool-b1"), false)]);
    run(TASK_HOLD_CAP_MS - 5_000).await;
    assert_eq!(
        h.probe.0.load(Ordering::SeqCst),
        0,
        "no probe after Confirmed"
    );
    assert_eq!(
        h.reg.hold().holding,
        1,
        "held although the probe would say dead"
    );
    assert_eq!(h.task("b1").state, TaskState::Running);
    run(10_000).await;
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert_eq!(hold.lapsed.len(), 1);
    assert_eq!(h.task("b1").reason.as_deref(), Some(REASON_HOLD_CAP));
}

/// 9.T2: signals that beat their tool rows are parked and adopted at creation.
#[tokio::test(start_paused = true)]
async fn signals_before_the_tool_row_are_adopted_at_creation() {
    let h = harness();
    // Confirmed first: created authoritative (probe NoWriter never kills it).
    h.feed(vec![confirmed("b1", Some("tool-b1"), false)]);
    assert!(
        h.reg.snapshot().unwrap().1.is_empty(),
        "Confirmed never creates"
    );
    let b = h.backgrounded("b1");
    h.feed(vec![launched("b1"), b]);
    run(30_000).await;
    assert_eq!(h.reg.hold().holding, 1);
    assert_eq!(h.probe.0.load(Ordering::SeqCst), 0);

    // Ended first: created already Done, never holds, no grace.
    let mut rx = h.reg.subscribe_hold();
    h.feed(vec![ended("b2", Some("tool-b2"), TaskState::Done)]);
    let b = h.backgrounded("b2");
    h.feed(vec![launched("b2"), b]);
    assert_eq!(h.task("b2").state, TaskState::Done);
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 1, "only b1 holds");
    rx.borrow_and_update();
    h.feed(vec![ended("b1", None, TaskState::Done)]);
    assert_eq!(h.reg.hold().holding, 0);

    // A task that ends before it ever held arms no grace.
    let h = harness();
    h.feed(vec![ended("b3", None, TaskState::Done)]);
    let b = h.backgrounded("b3");
    h.feed(vec![launched("b3"), b]);
    let hold = h.reg.hold();
    assert_eq!(
        (hold.holding, hold.last_hold_end_ms, hold.grace_active),
        (0, None, false)
    );
}

/// 9.T3: a structured `Ended` that drops the hold to zero arms grace; its expiry republishes.
#[tokio::test(start_paused = true)]
async fn ended_arms_grace_and_expiry_is_published() {
    let h = harness();
    h.command("b1");
    h.feed(vec![confirmed("b1", Some("tool-b1"), false)]);
    let mut rx = h.reg.subscribe_hold();
    rx.borrow_and_update();
    h.feed(vec![ended("b1", Some("tool-b1"), TaskState::Done)]);
    let hold = h.reg.hold();
    assert_eq!(hold.holding, 0);
    assert!(hold.last_hold_end_ms.is_some());
    assert!(hold.grace_active);
    assert_eq!(h.task("b1").state, TaskState::Done);
    assert!(rx.has_changed().unwrap());
    assert!(rx.borrow_and_update().grace_active);
    // The registry timer was only just armed by the observation above: give it a
    // few scheduler turns after the clock passed the grace deadline.
    run(TASK_END_GRACE_MS + 1_000).await;
    for _ in 0..200 {
        if rx.has_changed().unwrap() {
            break;
        }
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(50)).await;
    }
    assert!(rx.has_changed().unwrap(), "grace expiry republishes");
    assert!(!rx.borrow_and_update().grace_active);
}

/// 9.T4: a subagent is matched by its agent id once confirmed; confirmed
/// subagents are not stale after 30 quiet minutes; the agent-id `Ended` ends it.
#[tokio::test(start_paused = true)]
async fn subagent_confirmed_by_agent_id_ends_via_ext_id_and_is_not_stale() {
    let h = harness();
    h.feed(vec![TaskObservation::SubagentStarted {
        tool_id: "tu1".into(),
        label: "explore".into(),
        background: true,
    }]);
    h.feed(vec![confirmed("agent-9", Some("tu1"), false)]);
    run(30 * 60 * 1000).await;
    assert_eq!(
        h.task("tu1").state,
        TaskState::Running,
        "not stale (10 min bound waived)"
    );
    assert_eq!(h.reg.hold().holding, 1);
    h.feed(vec![ended("agent-9", None, TaskState::Done)]);
    assert_eq!(h.task("tu1").state, TaskState::Done);
    assert_eq!(h.reg.hold().holding, 0);

    // An unconfirmed background subagent still goes stale at 10 min.
    let h = harness();
    h.feed(vec![TaskObservation::SubagentStarted {
        tool_id: "tu2".into(),
        label: "x".into(),
        background: true,
    }]);
    run(11 * 60 * 1000).await;
    assert_eq!(h.task("tu2").state, TaskState::Stale);
}

/// 9.T5: paused does not hold and says why; resuming holds again.
#[tokio::test(start_paused = true)]
async fn paused_task_does_not_hold_and_resume_restores_it() {
    let h = harness();
    h.command("b1");
    h.feed(vec![confirmed("b1", None, true)]);
    assert_eq!(h.reg.hold().holding, 0);
    let t = h.task("b1");
    assert_eq!(t.state, TaskState::Running);
    assert_eq!(t.reason.as_deref(), Some(REASON_PAUSED));
    h.feed(vec![confirmed("b1", None, false)]);
    assert_eq!(h.reg.hold().holding, 1);
    assert_eq!(h.task("b1").reason, None);
}

/// 9.T6: the result of a set of signal rows does not depend on how they
/// interleave with the tool rows, and a rebuild equals live observation.
#[tokio::test(start_paused = true)]
async fn rebuild_equals_live_for_every_interleaving() {
    fn rows(h: &H, order: usize) -> Vec<NormalizedEvent> {
        let b = h.backgrounded("b1");
        let launch = h.event(Some("t1"), vec![launched("b1")]);
        let bg = h.event(Some("t1"), vec![b]);
        let end = h.event(None, vec![ended("b1", Some("tool-b1"), TaskState::Done)]);
        match order {
            0 => vec![launch, bg, end],
            _ => vec![launch, end, bg],
        }
    }
    let mut live_states = Vec::new();
    let mut rebuilt_states = Vec::new();
    for order in 0..2 {
        let live = harness();
        for ev in rows(&live, order) {
            live.reg.observe(&ev);
        }
        live_states.push((live.task("b1").state, live.task("b1").reason));

        let rb = harness();
        let evs = rows(&rb, order);
        rb.reg.begin_rebuild();
        rb.reg.rebuild(&evs);
        rebuilt_states.push((rb.task("b1").state, rb.task("b1").reason));
    }
    assert_eq!(
        live_states[0], live_states[1],
        "interleaving does not matter"
    );
    assert_eq!(live_states, rebuilt_states, "rebuild == live");
    assert_eq!(live_states[0].0, TaskState::Done);

    // Unfinished: Confirmed before/after the tool row both end up Stale on rebuild.
    let mut after = Vec::new();
    for order in 0..2 {
        let h = harness();
        let b = h.backgrounded("b1");
        let launch = h.event(Some("t1"), vec![launched("b1")]);
        let bg = h.event(Some("t1"), vec![b]);
        let conf = h.event(None, vec![confirmed("b1", Some("tool-b1"), false)]);
        let evs = if order == 0 {
            vec![launch, bg, conf]
        } else {
            vec![launch, conf, bg]
        };
        h.reg.begin_rebuild();
        h.reg.rebuild(&evs);
        after.push(h.task("b1").state);
    }
    assert_eq!(after, vec![TaskState::Stale, TaskState::Stale]);
}
