//! Review comments to a Terminal agent (plan 04, Phase 3): the immediate send,
//! the outcome observer, the `terminal-delivery:updated` stream, boot
//! reconcile. The pane and resolver are scripted; the store, review owner and
//! delivery handle are the real ones.

mod common;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;
use vst_proc::tmux::PaneFlags;
use vst_review::{
    BoxFuture, NotifyScheduled, PaneIo, TargetResolver, TerminalDeliveryHandle, TerminalError,
    TerminalTarget, TerminalWiring, JOB_TIMEOUT,
};
use vst_store::StoreHandle;
use vst_types::artifacts::ScopeKey;
use vst_types::domain::{ScheduledMessageMeta, ScheduledPhase};
use vst_types::rest::review::CreateTerminalDeliveryBody;
use vst_types::rest::sessions::ScheduledMessageRow;
use vst_types::review::{
    DeliveryState, PayloadState, ReviewComment, ReviewError, TerminalDelivery,
};
use vst_types::terminal_delivery::{
    PaneSnapshot, TerminalDeliveryCaps, TerminalOutcome, TerminalReadiness,
};
use vst_types::ServerEvent;

use common::Env;

const S: &str = "sess-1";
const NOW: &str = "2026-01-01T00:01:00Z";

// ── scripted pane / resolver ────────────────────────────────────────────────

struct FakeIo {
    pastes: Mutex<Vec<String>>,
    enters: Mutex<u32>,
}

impl PaneIo for FakeIo {
    fn list_session_names(&self) -> Option<HashSet<String>> {
        Some(["agent".to_string()].into_iter().collect())
    }
    fn pane_flags(&self, _t: &str) -> Option<PaneFlags> {
        Some(PaneFlags {
            in_mode: false,
            dead: false,
        })
    }
    fn capture(&self, _t: &str) -> Result<PaneSnapshot, String> {
        Ok(PaneSnapshot {
            text: format!("idle {}", self.pastes.lock().unwrap().len()),
            cursor_x: 0,
            cursor_y: 0,
        })
    }
    fn cancel_mode(&self, _t: &str) -> Result<(), String> {
        Ok(())
    }
    fn paste(&self, _t: &str, _b: &str, text: &str, _raw_lf: bool) -> Result<(), String> {
        self.pastes.lock().unwrap().push(text.to_string());
        Ok(())
    }
    fn send_enter(&self, _t: &str) -> Result<(), String> {
        *self.enters.lock().unwrap() += 1;
        Ok(())
    }
}

struct Spec {
    channel_is_tmux: bool,
    channel_is_json: bool,
    gone: bool,
    exited: bool,
    caps: Option<TerminalDeliveryCaps>,
    readiness: TerminalReadiness,
}

struct FakeResolver(Mutex<Spec>);

impl TargetResolver for FakeResolver {
    fn resolve(&self, _id: &str) -> BoxFuture<'_, Option<TerminalTarget>> {
        let s = self.0.lock().unwrap();
        let ready = s.readiness;
        let t = TerminalTarget {
            tmux_name: "agent".into(),
            channel_is_tmux: s.channel_is_tmux,
            channel_is_json: s.channel_is_json,
            gone: s.gone,
            exited: s.exited,
            caps: s.caps,
            probe: Arc::new(move |_| ready),
        };
        Box::pin(async move { Some(t) })
    }
}

fn caps(multiline_ok: bool) -> TerminalDeliveryCaps {
    TerminalDeliveryCaps {
        settle_ms: 200,
        multiline_ok,
        raw_lf: false,
    }
}

struct H {
    env: Env,
    io: Arc<FakeIo>,
    res: Arc<FakeResolver>,
    delivery: TerminalDeliveryHandle,
}

impl H {
    async fn new() -> Self {
        let env = Env::new().await;
        let io = Arc::new(FakeIo {
            pastes: Mutex::new(vec![]),
            enters: Mutex::new(0),
        });
        let res = Arc::new(FakeResolver(Mutex::new(Spec {
            channel_is_tmux: true,
            channel_is_json: false,
            gone: false,
            exited: false,
            caps: Some(caps(true)),
            readiness: TerminalReadiness::Unknown,
        })));
        let notify: NotifyScheduled = Arc::new(|_| Box::pin(async {}));
        let delivery = TerminalDeliveryHandle::new(
            env.store.clone(),
            io.clone(),
            res.clone(),
            notify,
            Some(env.review.terminal_observer()),
        )
        .with_paste_body(vst_review::review_paste_body())
        .with_row_capture(env.review.terminal_row_capture());
        env.review.attach_terminal(TerminalWiring {
            delivery: delivery.clone(),
            resolver: res.clone(),
        });
        H {
            env,
            io,
            res,
            delivery,
        }
    }

    fn spec(&self, f: impl FnOnce(&mut Spec)) {
        f(&mut self.res.0.lock().unwrap());
    }

    async fn comment(&self, id: &str, line: u32) -> ReviewComment {
        self.env
            .review
            .create(&self.env.wt, common::body(id, "src/a.rs", line))
            .await
            .unwrap()
            .0
    }

    fn req(&self, id: &str, ids: &[&str], message: Option<&str>) -> CreateTerminalDeliveryBody {
        CreateTerminalDeliveryBody {
            terminal_delivery_id: id.into(),
            session_id: S.into(),
            comment_ids: ids.iter().map(|s| s.to_string()).collect(),
            message: message.map(str::to_string),
            composer_key: None,
        }
    }

    async fn send(
        &self,
        id: &str,
        ids: &[&str],
        message: Option<&str>,
    ) -> Result<TerminalDelivery, TerminalError> {
        self.env
            .review
            .send_terminal(&self.env.wt, self.req(id, ids, message))
            .await
    }

    async fn panel(&self) -> Vec<ReviewComment> {
        self.env
            .review
            .list(&self.env.wt, None, false)
            .await
            .unwrap()
            .comments
    }

    async fn row(&self, id: &str) -> Option<ScheduledMessageRow> {
        self.env.store.get_scheduled_message(id).await.unwrap()
    }

    async fn wait_row_gone_or(&self, id: &str, status: &str) {
        let start = Instant::now();
        loop {
            match self.row(id).await {
                None if status == "gone" => return,
                Some(r) if r.status == status => return,
                _ => {}
            }
            assert!(start.elapsed() < JOB_TIMEOUT * 4, "row {id} never {status}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Everything the bus carried since the last drain.
    fn drain(&mut self) -> Drained {
        self.env.review.flush_events();
        let mut d = Drained::default();
        while let Ok(ev) = self.env.rx.try_recv() {
            match ev {
                ServerEvent::TerminalDeliveryUpdated { delivery } => d.deliveries.push(delivery),
                ServerEvent::CommentsChanged {
                    upserted, deleted, ..
                } => d.comments.push((
                    upserted,
                    deleted
                        .into_iter()
                        .map(|x| (x.id, x.reason.as_str().to_string()))
                        .collect(),
                )),
                _ => {}
            }
        }
        d
    }
}

#[derive(Default)]
struct Drained {
    deliveries: Vec<TerminalDelivery>,
    comments: Vec<common::Changed>,
}

fn reasons(panel: &[ReviewComment]) -> Vec<Option<String>> {
    panel
        .iter()
        .map(|c| c.restored_reason.map(|r| r.as_str().to_string()))
        .collect()
}

async fn run_for(d: Duration) {
    let end = Instant::now() + d;
    while Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ── 3.T1 ────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn send_inserts_a_claimed_waiting_immediate_row_then_pastes_the_block_and_keeps_comments_gone(
) {
    let mut h = H::new().await;
    h.comment("c1", 3).await;
    h.comment("c2", 9).await;
    h.spec(|s| s.readiness = TerminalReadiness::Unknown);

    let d = h
        .send("td-1", &["c1", "c2"], Some("please fix"))
        .await
        .unwrap();
    assert_eq!(d.state, DeliveryState::Waiting);
    assert_eq!(d.comment_count, 2);
    assert_eq!(d.message.as_deref(), Some("please fix"));
    assert!(h.panel().await.is_empty(), "rows leave the panel on send");

    let row = h.row("td-1").await.unwrap();
    assert_eq!(
        row.origin.as_deref(),
        Some("immediate"),
        "origin is the column"
    );
    assert_eq!(row.channel.as_deref(), Some("tmux"));
    assert_eq!(row.delivery_phase.as_deref(), Some("waiting"));
    assert!(row.claimed_at.is_some(), "inserted already claimed");
    assert_eq!(row.message, "please fix", "text is the message only");
    let snap = vst_types::review::snapshot_meta(row.comments_snapshot.as_deref().unwrap());
    assert_eq!(snap.unwrap().count, 2);

    // The tray's source: the in-flight row is listed with its phase.
    let listed = h.env.review.list(&h.env.wt, None, false).await.unwrap();
    assert_eq!(listed.terminal_deliveries.len(), 1);
    assert_eq!(listed.terminal_deliveries[0].state, DeliveryState::Waiting);
    assert_eq!(
        listed.terminal_deliveries[0].bytes, d.bytes,
        "create and list report the same paste bytes"
    );

    h.spec(|s| s.readiness = TerminalReadiness::Ready);
    h.wait_row_gone_or("td-1", "sent").await;
    let pastes = h.io.pastes.lock().unwrap().clone();
    assert_eq!(pastes.len(), 1);
    assert!(pastes[0].starts_with("please fix\n\nReview comments (2) · feature/review"));
    assert!(pastes[0].contains("File: src/a.rs"));
    assert!(pastes[0].contains("Quote: \"quote of c1\""));
    assert_eq!(*h.io.enters.lock().unwrap(), 1);
    run_for(Duration::from_secs(1)).await;
    assert!(h.panel().await.is_empty(), "Sent keeps the comments gone");

    let d = h.drain();
    let states: Vec<_> = d.deliveries.iter().map(|x| x.state).collect();
    assert_eq!(states.first(), Some(&DeliveryState::Waiting));
    assert_eq!(states.last(), Some(&DeliveryState::Sent));
    let deleted: Vec<_> = d.comments.iter().flat_map(|c| c.1.clone()).collect();
    assert!(deleted.contains(&("c1".to_string(), "sent".to_string())));
}

// ── 3.T2 ────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn oversize_is_413_and_nothing_is_deleted() {
    let h = H::new().await;
    let mut body = common::body("big", "src/a.rs", 1);
    body.quote = "q".repeat(2048);
    body.text = "t".repeat(8192);
    let mut ids = vec![];
    for i in 0..4 {
        let mut b = body.clone();
        b.id = format!("big-{i}");
        b.line_start = Some(i + 1);
        b.line_end = Some(i + 1);
        h.env.review.create(&h.env.wt, b).await.unwrap();
        ids.push(format!("big-{i}"));
    }
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let err = h.send("td-big", &refs, None).await.unwrap_err();
    assert_eq!(
        err,
        TerminalError::Review(ReviewError::TooLarge {
            limit: 32_768,
            unit: "bytes"
        })
    );
    assert_eq!(h.panel().await.len(), 4, "nothing deleted");
    assert!(h.row("td-big").await.is_none(), "no row inserted");
}

#[tokio::test(start_paused = true)]
async fn an_empty_comment_list_is_refused_and_inserts_no_row() {
    let h = H::new().await;
    let err = h.send("td-empty", &[], Some("hi")).await.unwrap_err();
    assert_eq!(err, TerminalError::NoComments);
    assert!(h.row("td-empty").await.is_none(), "no row inserted");
}

#[tokio::test(start_paused = true)]
async fn two_sends_to_one_session_give_one_accept_and_one_in_flight() {
    let h = H::new().await;
    h.comment("c1", 1).await;
    h.comment("c2", 2).await;
    let (a, b) = tokio::join!(h.send("td-a", &["c1"], None), h.send("td-b", &["c2"], None));
    let results = [a, b];
    let ok = results.iter().filter(|r| r.is_ok()).count();
    let busy = results
        .iter()
        .filter(|r| matches!(r, Err(TerminalError::Review(ReviewError::InFlight))))
        .count();
    assert_eq!((ok, busy), (1, 1), "{results:?}");
    assert_eq!(h.panel().await.len(), 1, "the refused send moved nothing");
}

#[tokio::test(start_paused = true)]
async fn the_same_delivery_id_twice_is_one_job() {
    let h = H::new().await;
    h.comment("c1", 1).await;
    let first = h.send("td-1", &["c1"], Some("m")).await.unwrap();
    let again = h.send("td-1", &["c1"], Some("m")).await.unwrap();
    assert_eq!(first.id, again.id);
    assert_eq!(first.comment_ids, again.comment_ids);
    h.spec(|s| s.readiness = TerminalReadiness::Ready);
    h.wait_row_gone_or("td-1", "sent").await;
    assert_eq!(h.io.pastes.lock().unwrap().len(), 1, "one job, one paste");
}

#[tokio::test(start_paused = true)]
async fn a_waiting_schedule_row_never_blocks_and_waits_behind_counts_it() {
    let h = H::new().await;
    h.comment("c1", 1).await;
    h.env
        .store
        .insert_scheduled_message(
            "sch-1",
            S,
            "later",
            None,
            "2026-01-01T00:00:10Z",
            "2026-01-01T00:00:00Z",
            Some("tmux"),
            None,
            Some("schedule"),
        )
        .await
        .unwrap();
    let row = h
        .env
        .store
        .claim_scheduled_message("sch-1", S, NOW)
        .await
        .unwrap()
        .unwrap();
    h.delivery.fire(row).await;
    let d = h.send("td-1", &["c1"], None).await.unwrap();
    assert_eq!(d.waits_behind, Some(1), "counted in the same transaction");
    assert_eq!(d.state, DeliveryState::Waiting);
}

// ── 3.T2b ───────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn the_poller_never_claims_an_immediate_row_and_phase_events_push_once() {
    let mut h = H::new().await;
    h.comment("c1", 1).await;
    h.send("td-1", &["c1"], None).await.unwrap();
    // Already claimed: the 1 s poller's claim finds nothing.
    let claimed = h
        .env
        .store
        .claim_next_due_scheduled_message("2099-01-01T00:00:00Z", &[])
        .await
        .unwrap();
    assert!(claimed.is_none(), "{claimed:?}");

    let _ = h.drain();
    let meta = |phase| ScheduledMessageMeta {
        id: "td-1".into(),
        message: String::new(),
        attachments: None,
        fire_at: NOW.into(),
        channel: Some("tmux".into()),
        phase: Some(phase),
        comment_count: Some(1),
        origin: Some("immediate".into()),
    };
    // waiting was pushed at insert: the same phase again pushes nothing.
    h.env
        .review
        .on_scheduled_changed(S, &[meta(ScheduledPhase::Waiting)])
        .await;
    assert!(h.drain().deliveries.is_empty());
    // waiting -> pasting pushes once, then nothing more for the same phase.
    h.env
        .store
        .mark_scheduled_phase("td-1", Some("waiting"), "pasting", NOW)
        .await
        .unwrap();
    h.env
        .review
        .on_scheduled_changed(S, &[meta(ScheduledPhase::Pasting)])
        .await;
    h.env
        .review
        .on_scheduled_changed(S, &[meta(ScheduledPhase::Pasting)])
        .await;
    let d = h.drain();
    assert_eq!(d.deliveries.len(), 1, "{:?}", d.deliveries);
    assert_eq!(d.deliveries[0].state, DeliveryState::Pasting);
}

// ── 3.T3 ────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn hostile_quotes_never_reach_the_pane_as_control_bytes() {
    let h = H::new().await;
    let mut b = common::body("evil", "src/a.rs", 2);
    b.quote = "x\u{1b}[201~y\u{202e}z\u{9b}".into();
    b.text = "bad\u{1b}[31m text".into();
    h.env.review.create(&h.env.wt, b).await.unwrap();
    h.send("td-1", &["evil"], None).await.unwrap();
    h.spec(|s| s.readiness = TerminalReadiness::Ready);
    h.wait_row_gone_or("td-1", "sent").await;
    let pastes = h.io.pastes.lock().unwrap().clone();
    assert_eq!(pastes.len(), 1);
    let p = &pastes[0];
    for bad in ['\u{1b}', '\u{202e}', '\u{9b}'] {
        assert!(!p.contains(bad), "{bad:?} leaked into {p:?}");
    }
    assert!(!p.contains("\u{1b}[201~"), "{p:?}");
}

// ── 3.T4 + 3.T14 ────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn failed_cancelled_and_gone_restore_exactly_once_with_the_mapped_reason() {
    for (case, want) in [
        ("exited", "agent_exited"),
        ("timeout", "timed_out"),
        ("archived", "session_removed"),
        ("unsupported", "send_failed"),
        ("cancel", "send_cancelled"),
        ("gone", "session_removed"),
    ] {
        let mut h = H::new().await;
        h.comment("c1", 3).await;
        h.comment("c2", 4).await;
        let d = h.send("td-1", &["c1", "c2"], Some("msg")).await.unwrap();
        assert!(h.panel().await.is_empty());
        let _ = h.drain();
        match case {
            "exited" => h.spec(|s| s.exited = true),
            "timeout" => {
                run_for(JOB_TIMEOUT + Duration::from_secs(5)).await;
            }
            "archived" => h.spec(|s| s.gone = true),
            "unsupported" => h.spec(|s| {
                s.channel_is_tmux = false;
                s.channel_is_json = true;
            }),
            "cancel" => h.env.review.cancel_terminal(&d.id).await.unwrap(),
            "gone" => {
                h.delivery.on_session_removed(S).await;
                // The session's rows are purged right after the report.
                h.env
                    .store
                    .delete_scheduled_messages_for_session(S)
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let start = Instant::now();
        while h.panel().await.len() < 2 {
            assert!(start.elapsed() < JOB_TIMEOUT * 4, "{case}: never restored");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        run_for(Duration::from_secs(2)).await;
        let panel = h.panel().await;
        assert_eq!(panel.len(), 2, "{case}: restored exactly once");
        assert_eq!(
            reasons(&panel),
            vec![Some(want.to_string()), Some(want.to_string())],
            "{case}"
        );
        assert!(panel.iter().all(|c| c.attached_to.is_none()), "{case}");
        // The immediate row is gone (deleted terminal row), and the event said so.
        assert!(h.row("td-1").await.is_none(), "{case}: row deleted");
        let last = h.drain().deliveries.pop().expect("an update event");
        assert!(
            matches!(
                last.state,
                DeliveryState::Failed | DeliveryState::TimedOut | DeliveryState::Cancelled
            ),
            "{case}: {:?}",
            last.state
        );
        assert!(h.io.pastes.lock().unwrap().is_empty(), "{case}");
    }
}

#[tokio::test(start_paused = true)]
async fn cancel_during_pasting_is_refused_and_retry_creates_a_new_job() {
    let mut h = H::new().await;
    h.comment("c1", 1).await;
    let d = h.send("td-1", &["c1"], None).await.unwrap();
    h.env
        .store
        .mark_scheduled_phase("td-1", Some("waiting"), "pasting", NOW)
        .await
        .unwrap();
    assert_eq!(
        h.env.review.cancel_terminal(&d.id).await.unwrap_err(),
        TerminalError::Pasting
    );
    assert!(h.row("td-1").await.is_some(), "still pasting");
    // Unknown id.
    assert_eq!(
        h.env.review.cancel_terminal("nope").await.unwrap_err(),
        TerminalError::Review(ReviewError::NotFound)
    );
    let _ = h.drain();

    // A timeout restores; Retry is a fresh POST over the remaining ids.
    let h2 = H::new().await;
    h2.comment("c1", 1).await;
    let d = h2.send("td-1", &["c1"], None).await.unwrap();
    h2.env.review.cancel_terminal(&d.id).await.unwrap();
    while h2.panel().await.is_empty() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    h2.send("td-2", &["c1"], None).await.unwrap();
    assert!(h2.row("td-2").await.is_some());
    assert!(h2.panel().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn sent_and_rearmed_restore_nothing_and_an_immediate_rearm_is_defensive() {
    let h = H::new().await;
    h.comment("c1", 1).await;
    h.send("td-1", &["c1"], None).await.unwrap();
    // `Sent` keeps the hold.
    h.env
        .review
        .on_terminal_outcome("td-1", TerminalOutcome::Sent)
        .await;
    assert!(h.panel().await.is_empty());
    // A (defensive) `Rearmed` for an immediate row restores and deletes it.
    h.env
        .review
        .on_terminal_outcome("td-1", TerminalOutcome::Rearmed)
        .await;
    let panel = h.panel().await;
    assert_eq!(panel.len(), 1);
    assert_eq!(reasons(&panel), vec![Some("channel_changed".to_string())]);
    assert!(h.row("td-1").await.is_none());

    // A schedule row's `Rearmed` keeps its snapshot (it fires as Rich Chat later).
    let p = H::new().await;
    p.comment("c9", 1).await;
    p.env
        .review
        .take_for_schedule_impl(vst_types::review::ScheduleTake {
            scope: p.env.wt.clone(),
            comment_ids: vec!["c9".into()],
            composer_key: None,
            row_id: "sch-1".into(),
            session_id: S.into(),
            message: "later".into(),
            fire_at: "2026-02-01T00:00:00Z".into(),
            now: NOW.into(),
            channel: "tmux".into(),
            attachments: None,
        })
        .await
        .unwrap();
    p.env
        .review
        .on_terminal_outcome("sch-1", TerminalOutcome::Rearmed)
        .await;
    assert!(p.panel().await.is_empty());
    let row = p.row("sch-1").await.unwrap();
    let payload =
        vst_types::review::ScheduledReviewPayload::parse(row.comments_snapshot.as_deref().unwrap())
            .unwrap();
    assert_eq!(payload.state, PayloadState::Held);
}

#[tokio::test(start_paused = true)]
async fn a_failed_schedule_row_keeps_its_row_and_flips_restored() {
    let h = H::new().await;
    h.comment("c1", 1).await;
    h.env
        .review
        .take_for_schedule_impl(vst_types::review::ScheduleTake {
            scope: h.env.wt.clone(),
            comment_ids: vec!["c1".into()],
            composer_key: None,
            row_id: "sch-1".into(),
            session_id: S.into(),
            message: "later".into(),
            fire_at: "2026-01-01T00:00:10Z".into(),
            now: "2026-01-01T00:00:00Z".into(),
            channel: "tmux".into(),
            attachments: None,
        })
        .await
        .unwrap();
    let row = h
        .env
        .store
        .claim_scheduled_message("sch-1", S, NOW)
        .await
        .unwrap()
        .unwrap();
    h.spec(|s| s.exited = true);
    h.delivery.fire(row).await;
    h.wait_row_gone_or("sch-1", "failed").await;
    run_for(Duration::from_secs(2)).await;
    let panel = h.panel().await;
    assert_eq!(panel.len(), 1);
    assert_eq!(reasons(&panel), vec![Some("agent_exited".to_string())]);
    let row = h.row("sch-1").await.expect("a schedule row stays failed");
    let payload =
        vst_types::review::ScheduledReviewPayload::parse(row.comments_snapshot.as_deref().unwrap())
            .unwrap();
    assert_eq!(payload.state, PayloadState::Restored);

    // Retry re-holds the comments that are still in the panel.
    assert_eq!(h.env.review.rehold_schedule_impl("sch-1").await.unwrap(), 1);
    assert!(h.panel().await.is_empty());
    let row = h.row("sch-1").await.unwrap();
    let payload =
        vst_types::review::ScheduledReviewPayload::parse(row.comments_snapshot.as_deref().unwrap())
            .unwrap();
    assert_eq!(payload.state, PayloadState::Held);
}

// ── eligibility ─────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn eligibility_needs_a_tmux_agent_with_multiline_caps_in_the_same_scope() {
    let h = H::new().await;
    h.comment("c1", 1).await;
    h.spec(|s| s.caps = None);
    assert!(matches!(
        h.send("td-1", &["c1"], None).await,
        Err(TerminalError::Unsupported(_))
    ));
    h.spec(|s| s.caps = Some(caps(false)));
    assert!(matches!(
        h.send("td-1", &["c1"], None).await,
        Err(TerminalError::Unsupported(_))
    ));
    h.spec(|s| {
        s.caps = Some(caps(true));
        s.channel_is_tmux = false;
    });
    assert!(matches!(
        h.send("td-1", &["c1"], None).await,
        Err(TerminalError::Unsupported(_))
    ));
    h.spec(|s| s.channel_is_tmux = true);
    // A session of another scope (the project's direct session) is refused.
    let mut req = h.req("td-2", &["c1"], None);
    req.session_id = "direct-1".into();
    assert_eq!(
        h.env
            .review
            .send_terminal(&h.env.wt, req)
            .await
            .unwrap_err(),
        TerminalError::Review(ReviewError::Scope)
    );
    assert_eq!(
        h.panel().await.len(),
        1,
        "every refusal left the panel alone"
    );
}

// ── 3.T12 ───────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_hidden_worktree_fails_pending_rows_archived_and_detaches_leases() {
    let h = H::new().await;
    h.comment("c1", 1).await;
    h.comment("c2", 2).await;
    // c2 is attached to the session's composer.
    h.env
        .review
        .attach(
            &h.env.wt,
            vst_types::rest::review::AttachBody {
                composer_key: format!("session:{S}"),
                comment_ids: Some(vec!["c2".into()]),
                refresh_only: None,
            },
        )
        .await
        .unwrap();
    h.send("td-1", &["c1"], None).await.unwrap();
    h.spec(|s| s.gone = true);
    let start = Instant::now();
    while h.panel().await.len() < 2 {
        assert!(start.elapsed() < JOB_TIMEOUT, "never restored");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let by_id = |id: &str, p: &[ReviewComment]| p.iter().find(|c| c.id == id).cloned().unwrap();
    let panel = h.panel().await;
    assert_eq!(
        by_id("c1", &panel).restored_reason.map(|r| r.as_str()),
        Some("session_removed")
    );
    // The hide event detaches the lease (the loop's intake, driven directly).
    let mut wt = serde_json::Map::new();
    wt.insert("id".into(), "wt-1".into());
    wt.insert("hiddenAt".into(), "2026-01-01T00:00:00Z".into());
    h.env
        .review
        .on_holds_event(ServerEvent::WorktreeUpdated { worktree: wt })
        .await;
    let panel = h.panel().await;
    assert!(by_id("c2", &panel).attached_to.is_none(), "lease detached");
}

// ── 3.T13 ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_lagged_bus_reconciles_stale_immediate_rows_and_leases() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vst.db")).unwrap();
    store
        .add_project(common::project("p1", "wt-1"))
        .await
        .unwrap();
    let broadcaster = vst_types::Broadcaster::new(2);
    let artifacts = vst_artifacts::ArtifactsHandle::new(
        store.clone(),
        broadcaster.clone(),
        Arc::new(common::Resolver {
            roots: vec![ScopeKey::worktree("wt-1")],
            home: dir.path().join("home"),
        }),
    );
    let review = vst_review::ReviewHandle::new(store.clone(), broadcaster.clone(), artifacts);
    let wt = ScopeKey::worktree("wt-1");
    for (id, line) in [("c1", 1), ("c2", 2)] {
        review
            .create(&wt, common::body(id, "src/a.rs", line))
            .await
            .unwrap();
    }
    // c1: an immediate row of a session that is gone; c2: a lease of a dead session.
    store
        .take_for_terminal_row(
            &wt,
            &["c1".to_string()],
            None,
            "feature/review",
            vst_store::comment_consumers::TakeLimits {
                max_comments: 200,
                max_bytes: 32_768,
            },
            vst_store::comment_consumers::ScheduleSpec {
                id: "td-stale".into(),
                session_id: "ghost".into(),
                message: String::new(),
                fire_at: NOW.into(),
                now: NOW.into(),
                channel: Some("tmux".into()),
                attachments: None,
            },
        )
        .await
        .unwrap()
        .unwrap();
    review
        .attach(
            &wt,
            vst_types::rest::review::AttachBody {
                composer_key: "session:ghost".into(),
                comment_ids: Some(vec!["c2".into()]),
                refresh_only: None,
            },
        )
        .await
        .unwrap();

    let _loop = Arc::new(review.clone()).start();
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    for i in 0..16 {
        broadcaster.send(ServerEvent::SessionDeleted {
            session_id: format!("noise-{i}"),
        });
    }
    let start = std::time::Instant::now();
    loop {
        let list = review.list(&wt, None, false).await.unwrap();
        let restored = list.comments.iter().any(|c| c.id == "c1");
        let detached = list
            .comments
            .iter()
            .find(|c| c.id == "c2")
            .is_some_and(|c| c.attached_to.is_none());
        if restored && detached {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5), "never reconciled");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(store
        .get_scheduled_message("td-stale")
        .await
        .unwrap()
        .is_none());
    _loop.abort();
}

// ── 3.T7 boot ───────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn boot_reconcile_restores_what_a_restart_left_in_flight() {
    use vst_review::TranscriptReader;
    use vst_types::review::{HoldRequest, ReviewPort};
    let h = H::new().await;
    for (id, line) in [("p", 1), ("n", 2), ("j", 3), ("i", 4), ("a", 5)] {
        h.comment(id, line).await;
    }
    // Two holds: one whose turn was persisted (crash before the delete), one not.
    for (hold, turn, cid) in [("hold-p", "turn-p", "p"), ("hold-n", "turn-n", "n")] {
        h.env
            .review
            .hold_for_turn(HoldRequest {
                hold_id: hold.into(),
                scope: h.env.wt.clone(),
                session_id: S.into(),
                turn_id: turn.into(),
                comment_ids: vec![cid.into()],
                composer_key: None,
            })
            .await
            .unwrap();
    }
    // A claimed json schedule row (held) and an adopted one.
    for (row, cid, adopted) in [("sch-j", "j", false), ("sch-a", "a", true)] {
        h.env
            .review
            .take_for_schedule_impl(vst_types::review::ScheduleTake {
                scope: h.env.wt.clone(),
                comment_ids: vec![cid.into()],
                composer_key: None,
                row_id: row.into(),
                session_id: S.into(),
                message: "x".into(),
                fire_at: "2026-01-01T00:00:10Z".into(),
                now: "2026-01-01T00:00:00Z".into(),
                channel: "json".into(),
                attachments: None,
            })
            .await
            .unwrap();
        h.env
            .store
            .claim_scheduled_message(row, S, NOW)
            .await
            .unwrap()
            .unwrap();
        if adopted {
            h.env
                .store
                .set_payload_state(row, PayloadState::Adopted, None)
                .await
                .unwrap();
        }
    }
    // A claimed waiting immediate row.
    h.send("td-1", &["i"], None).await.unwrap();
    // The turn of `hold-p` has a persisted, non-cancelled user row.
    let reader: TranscriptReader = Arc::new(|_| {
        Box::pin(async {
            let mut ev = vst_types::NormalizedEvent::default();
            ev.kind = vst_types::NormalizedEventKind::User;
            ev.turn_id = Some("turn-p".into());
            Some(vec![ev])
        })
    });
    let report = h.env.review.reconcile_boot(reader).await;
    assert_eq!(report.holds_deleted, 1);
    assert_eq!(report.holds_restored, 1);
    assert_eq!(report.schedule_rows_restored, 1, "adopted is the hold's");
    assert_eq!(report.immediate_rows_noted, 1);
    let panel = h.panel().await;
    let ids: Vec<_> = {
        let mut v: Vec<_> = panel.iter().map(|c| c.id.as_str()).collect();
        v.sort_unstable();
        v
    };
    assert_eq!(
        ids,
        vec!["j", "n"],
        "persisted + adopted + immediate stay gone"
    );
    assert!(panel
        .iter()
        .all(|c| c.restored_reason.map(|r| r.as_str()) == Some("restart")));
    assert!(h.env.store.list_holds(None).await.unwrap().is_empty());

    // 02's recovery fails the claimed immediate row `error`; the observer then
    // restores it with the `restart` reason ("last send didn't finish") and
    // deletes the row.
    let recovery = h
        .env
        .store
        .recover_orphaned_scheduled_messages(NOW)
        .await
        .unwrap();
    assert_eq!(recovery.failed_other_tmux, vec!["td-1".to_string()]);
    h.delivery.report_recovery(recovery).await;
    let start = Instant::now();
    while h.panel().await.len() < 3 {
        assert!(start.elapsed() < Duration::from_secs(30), "never restored");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let panel = h.panel().await;
    let i = panel.iter().find(|c| c.id == "i").unwrap();
    assert_eq!(i.restored_reason.map(|r| r.as_str()), Some("restart"));
    assert!(h.row("td-1").await.is_none());
}

// ── 3.T14 ───────────────────────────────────────────────────────────────────

/// No `vst-review` path writes a tmux row's terminal state outside the delivery
/// handle: the store's `mark_scheduled_*` writers appear in `delivery.rs` only.
#[test]
fn only_the_delivery_handle_writes_terminal_row_state() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().is_some_and(|n| n == "delivery.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for forbidden in [
            "mark_scheduled_message_failed",
            "mark_scheduled_message_sent",
            "mark_scheduled_phase",
            "rearm_scheduled_message",
            "mark_scheduled_message_pasted",
            "mark_waiting_scheduled_message_failed",
            "cancel_scheduled_message",
            "delete_scheduled_message",
        ] {
            // Two exemptions, both in `terminal.rs`: (1) `on_terminal_outcome`
            // deletes a finished immediate row AFTER the handle reported its
            // outcome; (2) `reconcile_immediate_rows` (boot) deletes a stale
            // immediate row whose session vanished while the daemon was down. No
            // delivery job exists for it, and its snapshot is restored right
            // before the delete.
            let allowed = if forbidden == "delete_scheduled_message"
                && path.file_name().is_some_and(|n| n == "terminal.rs")
            {
                2
            } else {
                0
            };
            assert!(
                text.matches(forbidden).count() <= allowed,
                "{} writes a row's terminal state via {forbidden}",
                path.display()
            );
        }
    }
}
