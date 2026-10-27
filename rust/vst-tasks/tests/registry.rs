//! Handle-level tests of `TaskRegistry` (paused tokio time; observations are
//! scripted per event id so these tests are independent of any harness).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vst_tasks::{format_ms, TaskObservation, TaskRegistry};
use vst_types::{NormalizedEvent, TaskKind, TaskOutputKind, TaskState, TaskSummary};

type Script = Arc<Mutex<HashMap<String, Vec<TaskObservation>>>>;
type Sent = Arc<Mutex<Vec<(u64, Vec<TaskSummary>)>>>;

struct H {
    reg: TaskRegistry,
    script: Script,
    sent: Sent,
    n: AtomicUsize,
}

fn harness() -> H {
    let script: Script = Arc::default();
    let sent: Sent = Arc::default();
    let s2 = script.clone();
    let sent2 = sent.clone();
    let reg = TaskRegistry::new(
        Arc::new(move |ev: &NormalizedEvent| {
            s2.lock().unwrap().get(&ev.id).cloned().unwrap_or_default()
        }),
        Arc::new(move |rev, tasks| sent2.lock().unwrap().push((rev, tasks))),
    );
    H {
        reg,
        script,
        sent,
        n: AtomicUsize::new(0),
    }
}

impl H {
    /// A scripted event stamped `offset_ms` after the registry's now.
    fn event(
        &self,
        offset_ms: i64,
        turn: Option<&str>,
        obs: Vec<TaskObservation>,
    ) -> NormalizedEvent {
        let id = format!("e{}", self.n.fetch_add(1, Ordering::SeqCst));
        self.script.lock().unwrap().insert(id.clone(), obs);
        NormalizedEvent {
            id,
            ts: format_ms(self.reg.now_ms() + offset_ms),
            turn_id: turn.map(str::to_string),
            ..NormalizedEvent::default()
        }
    }

    fn feed(&self, obs: Vec<TaskObservation>) -> NormalizedEvent {
        let ev = self.event(0, Some("t1"), obs);
        self.reg.observe(&ev);
        ev
    }

    fn launch_command(&self, tool: &str, task: &str) {
        let path = format!("/tmp/claude-1000/p/u/tasks/{task}.output");
        self.feed(vec![
            TaskObservation::CommandLaunched {
                tool_id: tool.into(),
                command: format!("sleep 90 # {task}"),
            },
            TaskObservation::CommandBackgrounded {
                tool_id: tool.into(),
                task_id: task.into(),
                output_path: Some(path),
            },
        ]);
    }

    fn start_subagent(&self, tool: &str, background: bool) {
        self.feed(vec![TaskObservation::SubagentStarted {
            tool_id: tool.into(),
            label: format!("agent {tool}"),
            background,
        }]);
    }

    fn tasks(&self) -> Vec<TaskSummary> {
        self.reg.snapshot().expect("not rebuilding").1
    }

    fn sent_count(&self) -> usize {
        self.sent.lock().unwrap().len()
    }

    fn last_sent(&self) -> (u64, Vec<TaskSummary>) {
        self.sent
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("a broadcast")
    }
}

async fn settle_window() {
    tokio::time::sleep(Duration::from_millis(1_100)).await;
}

fn find<'a>(tasks: &'a [TaskSummary], id: &str) -> &'a TaskSummary {
    tasks.iter().find(|t| t.id == id).expect("task present")
}

#[tokio::test(start_paused = true)]
async fn command_running_then_stale_after_30_min_from_event_ts() {
    let h = harness();
    h.launch_command("tool-1", "b1");
    settle_window().await;
    let t = h.last_sent().1;
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].kind, TaskKind::Command);
    assert_eq!(t[0].state, TaskState::Running);
    assert_eq!(t[0].output_kind, TaskOutputKind::File);
    assert!(!t[0].can_stop);

    tokio::time::sleep(Duration::from_secs(29 * 60)).await;
    assert_eq!(h.tasks()[0].state, TaskState::Running);

    tokio::time::sleep(Duration::from_secs(61)).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    let (_, sent) = h.last_sent();
    assert_eq!(sent[0].state, TaskState::Stale);
    assert_eq!(
        sent[0].reason.as_deref(),
        Some("No end signal from the agent")
    );
}

#[tokio::test(start_paused = true)]
async fn out_of_band_event_postpones_command_stale() {
    let h = harness();
    h.launch_command("tool-1", "b1");
    tokio::time::sleep(Duration::from_secs(25 * 60)).await;
    let ev = h.event(0, Some("notif-1"), vec![]);
    h.reg.observe_out_of_band(&ev);
    tokio::time::sleep(Duration::from_secs(10 * 60)).await;
    assert_eq!(
        h.tasks()[0].state,
        TaskState::Running,
        "35 min after launch"
    );
    tokio::time::sleep(Duration::from_secs(21 * 60)).await;
    assert_eq!(h.tasks()[0].state, TaskState::Stale);
}

#[tokio::test(start_paused = true)]
async fn backgrounded_without_matching_launch_is_dropped() {
    let h = harness();
    h.feed(vec![TaskObservation::CommandBackgrounded {
        tool_id: "ghost".into(),
        task_id: "b9".into(),
        output_path: None,
    }]);
    settle_window().await;
    assert!(h.tasks().is_empty());
    assert_eq!(h.sent_count(), 0, "empty and never sent: no broadcast");
}

#[tokio::test(start_paused = true)]
async fn invalid_output_path_yields_no_output_kind() {
    let h = harness();
    h.feed(vec![
        TaskObservation::CommandLaunched {
            tool_id: "t".into(),
            command: "x".into(),
        },
        TaskObservation::CommandBackgrounded {
            tool_id: "t".into(),
            task_id: "b1".into(),
            output_path: Some("/tmp/claude-1/../../etc/passwd".into()),
        },
    ]);
    let t = h.tasks();
    assert_eq!(t[0].output_kind, TaskOutputKind::None);
    assert_eq!(t[0].output_path, None);
}

#[tokio::test(start_paused = true)]
async fn sync_subagent_done_and_failed() {
    let h = harness();
    h.start_subagent("a", false);
    h.start_subagent("b", false);
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "a".into(),
        ok: true,
        final_text: Some("all good".into()),
    }]);
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "b".into(),
        ok: false,
        final_text: Some("boom\nstack".into()),
    }]);
    let t = h.tasks();
    assert_eq!(find(&t, "a").state, TaskState::Done);
    assert!(find(&t, "a").ended_at.is_some());
    assert_eq!(find(&t, "b").state, TaskState::Failed);
    assert_eq!(find(&t, "b").reason.as_deref(), Some("boom"));
    // A finish for an unknown tool id is ignored.
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "nope".into(),
        ok: true,
        final_text: None,
    }]);
    assert_eq!(h.tasks().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn turn_ended_stops_only_that_turns_sync_subagents() {
    let h = harness();
    h.start_subagent("sync", false);
    h.start_subagent("bg", true);
    h.reg.turn_ended("other-turn");
    assert!(h.tasks().iter().all(|t| t.state == TaskState::Running));
    h.reg.turn_ended("t1");
    let t = h.tasks();
    assert_eq!(find(&t, "sync").state, TaskState::Stopped);
    assert_eq!(find(&t, "sync").reason.as_deref(), Some("Turn ended"));
    assert_eq!(find(&t, "bg").state, TaskState::Running);
}

#[tokio::test(start_paused = true)]
async fn background_subagent_launch_receipt_does_not_finish_it_and_goes_stale() {
    let h = harness();
    h.start_subagent("bg", true);
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "bg".into(),
        ok: true,
        final_text: Some("launched".into()),
    }]);
    assert_eq!(h.tasks()[0].state, TaskState::Running);
    tokio::time::sleep(Duration::from_secs(9 * 60)).await;
    h.feed(vec![TaskObservation::SubagentNested {
        parent_tool_id: "bg".into(),
        line: "Read a.rs".into(),
    }]);
    tokio::time::sleep(Duration::from_secs(9 * 60)).await;
    assert_eq!(
        h.tasks()[0].state,
        TaskState::Running,
        "nested activity resets the clock"
    );
    tokio::time::sleep(Duration::from_secs(2 * 60)).await;
    let t = h.tasks();
    assert_eq!(t[0].state, TaskState::Stale);
    assert_eq!(t[0].reason.as_deref(), Some("No end signal from the agent"));
}

#[tokio::test(start_paused = true)]
async fn bump_epoch_marks_running_tasks_agent_restarted() {
    let h = harness();
    h.launch_command("t", "b1");
    h.start_subagent("a", false);
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "a".into(),
        ok: true,
        final_text: None,
    }]);
    h.reg.bump_epoch();
    let t = h.tasks();
    assert_eq!(find(&t, "b1").state, TaskState::Stale);
    assert_eq!(find(&t, "b1").reason.as_deref(), Some("Agent restarted"));
    assert_eq!(
        find(&t, "a").state,
        TaskState::Done,
        "terminal rows untouched"
    );
}

#[tokio::test(start_paused = true)]
async fn rebuild_equals_live_and_stales_running() {
    let live = harness();
    let rebuilt = harness();
    // The same scripted history, stamped at fixed offsets.
    let mk = |h: &H| -> Vec<NormalizedEvent> {
        vec![
            h.event(
                0,
                Some("t1"),
                vec![
                    TaskObservation::CommandLaunched {
                        tool_id: "tc".into(),
                        command: "sleep 90".into(),
                    },
                    TaskObservation::CommandBackgrounded {
                        tool_id: "tc".into(),
                        task_id: "b1".into(),
                        output_path: Some("/tmp/claude-1000/p/u/tasks/b1.output".into()),
                    },
                ],
            ),
            h.event(
                1_000,
                Some("t1"),
                vec![TaskObservation::SubagentStarted {
                    tool_id: "a".into(),
                    label: "review".into(),
                    background: false,
                }],
            ),
            h.event(
                2_000,
                Some("t1"),
                vec![TaskObservation::SubagentNested {
                    parent_tool_id: "a".into(),
                    line: "Read x".into(),
                }],
            ),
            h.event(
                3_000,
                Some("t1"),
                vec![TaskObservation::SubagentFinished {
                    tool_id: "a".into(),
                    ok: true,
                    final_text: Some("done".into()),
                }],
            ),
        ]
    };
    for ev in mk(&live) {
        live.reg.observe(&ev);
    }
    let rows = mk(&rebuilt);
    rebuilt.reg.begin_rebuild();
    rebuilt.reg.rebuild(&rows);

    let l = live.tasks();
    let r = rebuilt.tasks();
    assert_eq!(l.len(), r.len());
    let (lc, rc) = (find(&l, "b1"), find(&r, "b1"));
    assert_eq!(lc.label, rc.label);
    assert_eq!(lc.output_path, rc.output_path);
    assert_eq!(lc.state, TaskState::Running);
    assert_eq!(rc.state, TaskState::Stale);
    assert_eq!(rc.reason.as_deref(), Some("Agent restarted"));
    let (la, ra) = (find(&l, "a"), find(&r, "a"));
    assert_eq!(la.state, TaskState::Done);
    assert_eq!(ra.state, la.state);
    assert_eq!(ra.output_rev, la.output_rev);
    assert_eq!(ra.ended_at.is_some(), la.ended_at.is_some());
    // The rebuild broadcast its first snapshot immediately.
    assert_eq!(rebuilt.sent_count(), 1);
}

#[tokio::test(start_paused = true)]
async fn terminal_rows_expire_after_one_hour_and_an_empty_snapshot_is_sent() {
    let h = harness();
    h.start_subagent("a", false);
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "a".into(),
        ok: true,
        final_text: None,
    }]);
    settle_window().await;
    assert_eq!(h.last_sent().1.len(), 1);
    tokio::time::sleep(Duration::from_secs(59 * 60)).await;
    assert_eq!(h.tasks().len(), 1);
    tokio::time::sleep(Duration::from_secs(61)).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(h.last_sent().1.is_empty(), "expiry emits an empty snapshot");
    assert!(h.tasks().is_empty());
}

#[tokio::test(start_paused = true)]
async fn stale_rows_expire_one_hour_after_going_stale() {
    let h = harness();
    h.launch_command("t", "b1");
    tokio::time::sleep(Duration::from_secs(31 * 60)).await;
    assert_eq!(h.tasks()[0].state, TaskState::Stale);
    tokio::time::sleep(Duration::from_secs(58 * 60)).await;
    assert_eq!(h.tasks().len(), 1);
    tokio::time::sleep(Duration::from_secs(3 * 60)).await;
    assert!(h.tasks().is_empty());
}

#[tokio::test(start_paused = true)]
async fn fifty_task_cap_evicts_finished_rows_first() {
    let h = harness();
    h.start_subagent("done-0", false);
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "done-0".into(),
        ok: true,
        final_text: None,
    }]);
    for i in 0..60 {
        h.start_subagent(&format!("run-{i}"), true);
    }
    let t = h.tasks();
    assert_eq!(t.len(), 50);
    assert!(
        t.iter().all(|x| x.id != "done-0"),
        "finished row evicted first"
    );
    assert!(t.iter().any(|x| x.id == "run-59"));
    assert!(t.iter().all(|x| x.id != "run-0"), "then the oldest running");
}

#[tokio::test(start_paused = true)]
async fn burst_of_nested_events_is_one_broadcast_and_rev_is_monotonic() {
    let h = harness();
    h.start_subagent("a", false);
    settle_window().await;
    let base = h.sent_count();
    for i in 0..10 {
        h.feed(vec![TaskObservation::SubagentNested {
            parent_tool_id: "a".into(),
            line: format!("Read {i}"),
        }]);
    }
    settle_window().await;
    assert_eq!(h.sent_count(), base + 1, "coalesced into one");
    let (_, t) = h.last_sent();
    assert_eq!(t[0].output_rev, 10, "nested lines bump output_rev");

    // Another window, another broadcast, strictly larger rev.
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "a".into(),
        ok: true,
        final_text: Some("ok".into()),
    }]);
    settle_window().await;
    let sent = h.sent.lock().unwrap();
    let revs: Vec<u64> = sent.iter().map(|(r, _)| *r).collect();
    assert!(
        revs.windows(2).all(|w| w[0] < w[1]),
        "revs strictly increase: {revs:?}"
    );
    assert_eq!(sent.last().unwrap().1[0].state, TaskState::Done);
}

#[tokio::test(start_paused = true)]
async fn last_activity_alone_does_not_broadcast() {
    let h = harness();
    h.launch_command("t", "b1");
    settle_window().await;
    let base = h.sent_count();
    // Out-of-band event with no observations only bumps last_activity.
    tokio::time::sleep(Duration::from_secs(5)).await;
    let ev = h.event(0, Some("notif-1"), vec![]);
    h.reg.observe_out_of_band(&ev);
    settle_window().await;
    assert_eq!(h.sent_count(), base);
    // ...but the snapshot reports the fresh activity time.
    let t = h.tasks();
    assert!(t[0].last_activity_at.as_deref() > Some(t[0].started_at.as_str()));
}

#[tokio::test(start_paused = true)]
async fn live_observations_during_rebuild_are_buffered_and_deduplicated() {
    let h = harness();
    let sub = |id: &str, off: i64| {
        h.event(
            off,
            Some("t1"),
            vec![TaskObservation::SubagentStarted {
                tool_id: id.into(),
                label: format!("sub {id}"),
                background: false,
            }],
        )
    };
    let nest = |id: &str, off: i64, line: &str| {
        h.event(
            off,
            Some("t1"),
            vec![TaskObservation::SubagentNested {
                parent_tool_id: id.into(),
                line: line.into(),
            }],
        )
    };
    let start_a = sub("a", 0);
    let nested_a = nest("a", 1_000, "Read 1");
    let start_b = sub("b", 2_000);
    let nested_b = nest("b", 3_000, "Read b");

    h.reg.begin_rebuild();
    // Live while the rebuild read is in flight. `start_a`/`nested_a` were
    // persisted before the read (rows contain them too); `start_b`/`nested_b`
    // after (rows lack them).
    h.reg.observe(&nested_a);
    h.reg.observe(&start_b);
    h.reg.observe(&nested_b);
    assert!(
        h.reg.snapshot().is_none(),
        "nothing exposed while rebuilding"
    );
    h.reg.rebuild(&[start_a, nested_a]);

    let t = h.tasks();
    assert_eq!(t.len(), 2, "no duplicate rows");
    // `a` came from the rows: nested counted once (dedup by event id), and it
    // belongs to the earlier adapter.
    assert_eq!(find(&t, "a").output_rev, 1);
    assert_eq!(find(&t, "a").state, TaskState::Stale);
    // `b` exists only in the buffered tail: nothing lost, and it is live.
    assert_eq!(find(&t, "b").output_rev, 1);
    assert_eq!(find(&t, "b").state, TaskState::Running);
}

#[tokio::test(start_paused = true)]
async fn buffered_epoch_bump_and_turn_end_replay_after_rebuild() {
    let h = harness();
    h.reg.begin_rebuild();
    h.reg.bump_epoch();
    let ev = h.event(
        0,
        Some("t2"),
        vec![TaskObservation::SubagentStarted {
            tool_id: "live".into(),
            label: "after restart".into(),
            background: false,
        }],
    );
    h.reg.observe(&ev);
    h.reg.turn_ended("t2");
    h.reg.rebuild(&[]);
    let t = h.tasks();
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].state, TaskState::Stopped);
}

#[tokio::test(start_paused = true)]
async fn output_of_unknown_task_is_not_found_and_subagent_output_lists_lines() {
    let h = harness();
    assert_eq!(
        h.reg.output("zzz", 200).await.unwrap_err(),
        vst_tasks::TaskOutputError::NotFound
    );
    h.start_subagent("a", false);
    for i in 0..3 {
        h.feed(vec![TaskObservation::SubagentNested {
            parent_tool_id: "a".into(),
            line: format!("Read {i}"),
        }]);
    }
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "a".into(),
        ok: true,
        final_text: Some("summary".into()),
    }]);
    let out = h.reg.output("a", 2).await.unwrap();
    assert_eq!(out.lines, vec!["Read 1".to_string(), "Read 2".to_string()]);
    assert!(out.truncated);
    assert_eq!(out.output_kind, TaskOutputKind::Events);
    assert_eq!(out.final_text.as_deref(), Some("summary"));
}

#[tokio::test(start_paused = true)]
async fn shutdown_silences_everything() {
    let h = harness();
    h.start_subagent("a", false);
    h.reg.shutdown();
    h.start_subagent("b", false);
    settle_window().await;
    // Only the final empty snapshot; nothing after it.
    assert_eq!(h.sent_count(), 1);
    assert!(h.last_sent().1.is_empty());
}

#[tokio::test(start_paused = true)]
async fn shutdown_final_snapshot_has_newer_rev_and_no_rows() {
    let h = harness();
    h.start_subagent("a", false);
    settle_window().await;
    let (rev, rows) = h.last_sent();
    assert_eq!(rows.len(), 1);
    h.reg.shutdown();
    let (rev2, rows2) = h.last_sent();
    assert!(rev2 > rev);
    assert!(rows2.is_empty());
    h.reg.shutdown();
    assert_eq!(h.sent_count(), 2, "second shutdown is a no-op");
}

#[tokio::test(start_paused = true)]
async fn snapshot_is_none_while_rebuilding_and_rebuild_broadcasts_even_if_empty() {
    let h = harness();
    h.reg.begin_rebuild();
    assert!(h.reg.snapshot().is_none());
    h.reg.rebuild(&[]);
    assert_eq!(h.sent_count(), 1);
    assert!(h.last_sent().1.is_empty());
    assert!(h.reg.snapshot().is_some());
}

#[tokio::test(start_paused = true)]
async fn sync_subagent_under_notif_turn_goes_stale_without_a_result() {
    let h = harness();
    let ev = h.event(
        0,
        Some("notif-abc"),
        vec![TaskObservation::SubagentStarted {
            tool_id: "n".into(),
            label: "agent n".into(),
            background: false,
        }],
    );
    h.reg.observe_out_of_band(&ev);
    assert_eq!(h.tasks()[0].state, TaskState::Running);
    tokio::time::sleep(Duration::from_secs(11 * 60)).await;
    let t = h.tasks();
    assert_eq!(t[0].state, TaskState::Stale);
    assert_eq!(t[0].reason.as_deref(), Some("No end signal from the agent"));
}

#[tokio::test(start_paused = true)]
async fn a_stale_sync_subagent_still_ends_when_its_result_arrives() {
    let h = harness();
    h.start_subagent("a", false);
    tokio::time::sleep(Duration::from_secs(11 * 60)).await;
    assert_eq!(find(&h.tasks(), "a").state, TaskState::Stale);
    // The real end beats the "no end signal" guess (and matches a transcript rebuild).
    h.feed(vec![TaskObservation::SubagentFinished {
        tool_id: "a".into(),
        ok: true,
        final_text: Some("done".into()),
    }]);
    let t = h.tasks();
    assert_eq!(find(&t, "a").state, TaskState::Done);
    assert!(find(&t, "a").ended_at.is_some());
}

// ------------------------------------------------------------------
// Real filesystem + real time: the watcher bumps output_rev.
// ------------------------------------------------------------------

#[tokio::test]
async fn watcher_bumps_output_rev_when_the_file_grows() {
    let dir = tempfile::tempdir().unwrap();
    let canon = dir.path().canonicalize().unwrap();
    let tasks_dir = canon.join("claude-1000/p/u/tasks");
    std::fs::create_dir_all(&tasks_dir).unwrap();
    let file = tasks_dir.join("w1.output");
    std::fs::write(&file, "start\n").unwrap();

    let script: Script = Arc::default();
    let sent: Sent = Arc::default();
    let (s2, sent2) = (script.clone(), sent.clone());
    let reg = TaskRegistry::with_roots(
        Arc::new(move |ev: &NormalizedEvent| {
            s2.lock().unwrap().get(&ev.id).cloned().unwrap_or_default()
        }),
        Arc::new(move |rev, tasks| sent2.lock().unwrap().push((rev, tasks))),
        vec![canon.clone()],
    );
    script.lock().unwrap().insert(
        "e0".into(),
        vec![
            TaskObservation::CommandLaunched {
                tool_id: "t".into(),
                command: "tail".into(),
            },
            TaskObservation::CommandBackgrounded {
                tool_id: "t".into(),
                task_id: "w1".into(),
                output_path: Some(file.display().to_string()),
            },
        ],
    );
    let ev = NormalizedEvent {
        id: "e0".into(),
        ts: reg.now_iso(),
        ..NormalizedEvent::default()
    };
    reg.observe(&ev);
    assert_eq!(reg.watcher_count_for_test(), 1);

    let out = reg.output("w1", 200).await.unwrap();
    assert_eq!(out.lines, vec!["start".to_string()]);
    assert_eq!(out.total_bytes, Some(6));

    tokio::time::sleep(Duration::from_millis(300)).await;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .and_then(|mut f| std::io::Write::write_all(&mut f, b"more\n"))
        .unwrap();

    let mut bumped = false;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if sent
            .lock()
            .unwrap()
            .last()
            .is_some_and(|(_, t)| t[0].output_rev > 0)
        {
            bumped = true;
            break;
        }
    }
    assert!(bumped, "file growth must bump output_rev and broadcast");

    // Going terminal/stale drops the watcher.
    reg.bump_epoch();
    assert_eq!(reg.watcher_count_for_test(), 0);
}
