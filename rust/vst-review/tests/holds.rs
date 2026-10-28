//! The Rich Chat holds (`heldBy` marker rows) at the public handle (`ReviewPort` + `TurnObserver`
//! on `ReviewHandle`): a send hides the rows under a hold; the turn
//! observer settles it (persisted = delete, cancelled = restore, idempotent).

mod common;

use common::{body, Env};
use vst_review::{persisted_review, CardRestoreError};
use vst_store::comment_consumers::{Consumer, ScheduleSpec, TakeLimits};
use vst_types::artifacts::ScopeKey;
use vst_types::rest::review::AttachBody;
use vst_types::review::{
    HoldRequest, PayloadState, RestoreReason, ReviewError, ReviewPort, ReviewRecord, TurnObserver,
};
use vst_types::{NormalizedEvent, NormalizedEventKind, ServerEvent};

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn req(scope: &ScopeKey, hold: &str, turn: &str, comments: &[&str]) -> HoldRequest {
    HoldRequest {
        hold_id: hold.into(),
        scope: scope.clone(),
        session_id: "sess-1".into(),
        turn_id: turn.into(),
        comment_ids: ids(comments),
        composer_key: Some("session:sess-1".into()),
    }
}

async fn seed(env: &Env, n: u32) {
    for i in 1..=n {
        env.review
            .create(&env.wt, body(&format!("c{i}"), "src/f.rs", i))
            .await
            .unwrap();
    }
    env.review.flush_events();
}

#[tokio::test]
async fn hold_deletes_rows_stores_the_snapshot_and_announces_sent() {
    let mut env = Env::new().await;
    seed(&env, 3).await;
    env.events();

    let hold = env
        .review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1", "c3"]))
        .await
        .unwrap();
    assert_eq!(hold.record.name, "feature/review");
    assert_eq!(hold.record.comments.len(), 2);

    let left = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments;
    assert_eq!(
        left.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["c2"]
    );
    let stored = env.store.get_hold("h1").await.unwrap().unwrap();
    assert_eq!(
        (stored.session_id.as_str(), stored.turn_id.as_str()),
        ("sess-1", "t1")
    );
    assert_eq!(stored.scope, env.wt);

    env.review.flush_events();
    let ev = env.events();
    assert_eq!(ev.len(), 1);
    assert!(ev[0].0.is_empty());
    let mut gone = ev[0].1.clone();
    gone.sort();
    assert_eq!(
        gone,
        vec![("c1".into(), "sent".into()), ("c3".into(), "sent".into())]
    );
}

#[tokio::test]
async fn a_retried_hold_id_takes_nothing_and_says_nothing() {
    let mut env = Env::new().await;
    seed(&env, 2).await;
    env.review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1"]))
        .await
        .unwrap();
    env.review.flush_events();
    env.events();

    let again = env
        .review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1"]))
        .await
        .unwrap();
    assert_eq!(again.record.comments.len(), 1, "the stored hold comes back");
    env.review.flush_events();
    assert!(env.events().is_empty());
    assert_eq!(env.store.list_holds(None).await.unwrap().len(), 1);
}

/// 2.T3 — a second send of the same ids (a different hold) is refused.
#[tokio::test]
async fn second_send_of_the_same_ids_is_comments_changed() {
    let env = Env::new().await;
    seed(&env, 2).await;
    env.review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1", "c2"]))
        .await
        .unwrap();
    let err = env
        .review
        .hold_for_turn(req(&env.wt, "h2", "t2", &["c1", "c2"]))
        .await
        .unwrap_err();
    assert_eq!(err, ReviewError::Changed { remaining: 0 });
    assert!(env.store.get_hold("h2").await.unwrap().is_none());
}

/// 2.T4 — ids held by another composer, or a mix, are refused; unattached ids
/// (picker send) and ids attached to the sending composer pass.
#[tokio::test]
async fn composer_rules_for_attached_and_unattached_ids() {
    let env = Env::new().await;
    seed(&env, 4).await;
    let attach = |key: &str, ids: &[&str]| AttachBody {
        composer_key: key.into(),
        comment_ids: Some(self::ids(ids)),
        refresh_only: None,
    };
    env.review
        .attach(&env.wt, attach("session:other", &["c1"]))
        .await
        .unwrap();
    env.review
        .attach(&env.wt, attach("session:sess-1", &["c2", "c3"]))
        .await
        .unwrap();

    // Attached to composer B, sent from A.
    assert_eq!(
        env.review
            .hold_for_turn(req(&env.wt, "h1", "t1", &["c1"]))
            .await
            .unwrap_err(),
        ReviewError::NotAttached
    );
    // A mix of the sending composer's chip and an unattached comment.
    assert_eq!(
        env.review
            .hold_for_turn(req(&env.wt, "h2", "t2", &["c2", "c4"]))
            .await
            .unwrap_err(),
        ReviewError::NotAttached
    );
    // Nothing moved on a refusal.
    assert_eq!(
        env.review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        4
    );
    // The chip's own ids, and an unattached picker send, pass.
    env.review
        .hold_for_turn(req(&env.wt, "h3", "t3", &["c2", "c3"]))
        .await
        .unwrap();
    env.review
        .hold_for_turn(req(&env.wt, "h4", "t4", &["c4"]))
        .await
        .unwrap();
}

/// 2.T6 — over 200 comments: refused, nothing deleted, nothing held.
#[tokio::test]
async fn over_the_comment_limit_is_too_large_and_moves_nothing() {
    let env = Env::new().await;
    seed(&env, 201).await;
    let all: Vec<String> = (1..=201).map(|i| format!("c{i}")).collect();
    let err = env
        .review
        .hold_for_turn(HoldRequest {
            comment_ids: all,
            ..req(&env.wt, "h1", "t1", &[])
        })
        .await
        .unwrap_err();
    assert_eq!(
        err,
        ReviewError::TooLarge {
            limit: 200,
            unit: "comments"
        }
    );
    assert_eq!(
        env.review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        201
    );
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn over_the_byte_limit_is_too_large_and_moves_nothing() {
    let env = Env::new().await;
    for i in 1..=17u32 {
        let mut b = body(&format!("big{i}"), "src/f.rs", i);
        b.text = "x".repeat(8192);
        env.review.create(&env.wt, b).await.unwrap();
    }
    let all: Vec<String> = (1..=17).map(|i| format!("big{i}")).collect();
    let err = env
        .review
        .hold_for_turn(HoldRequest {
            comment_ids: all,
            ..req(&env.wt, "h1", "t1", &[])
        })
        .await
        .unwrap_err();
    assert_eq!(
        err,
        ReviewError::TooLarge {
            limit: 131_072,
            unit: "bytes"
        }
    );
    assert_eq!(
        env.review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        17
    );
}

/// 2.T2 — cancelling restores the comments with their original pins and the
/// reason, in ONE event.
#[tokio::test]
async fn turn_cancelled_restores_with_original_pins_and_one_event() {
    let mut env = Env::new().await;
    seed(&env, 3).await;
    let before = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments;
    env.review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1", "c2", "c3"]))
        .await
        .unwrap();
    env.review.flush_events();
    env.events();

    env.review
        .turn_cancelled("h1", RestoreReason::TurnCancelled)
        .await;
    env.review.flush_events();
    let ev = env.events();
    assert_eq!(ev.len(), 1, "one comments:changed");
    assert_eq!(ev[0].0.len(), 3);

    let after = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments;
    assert_eq!(
        after
            .iter()
            .map(|c| (c.id.clone(), c.pin))
            .collect::<Vec<_>>(),
        before
            .iter()
            .map(|c| (c.id.clone(), c.pin))
            .collect::<Vec<_>>(),
        "original pins"
    );
    assert!(after.iter().all(
        |c| c.restored_reason == Some(RestoreReason::TurnCancelled) && c.attached_to.is_none()
    ));
    assert!(env.store.get_hold("h1").await.unwrap().is_none());
}

/// 2.T14 (owner half) — `turn_cancelled` is idempotent: a repeat, or a racing
/// pair, restores once and announces once.
#[tokio::test]
async fn turn_cancelled_is_idempotent() {
    let mut env = Env::new().await;
    seed(&env, 2).await;
    env.review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1", "c2"]))
        .await
        .unwrap();
    env.review.flush_events();
    env.events();

    let (a, b) = tokio::join!(
        env.review
            .turn_cancelled("h1", RestoreReason::SessionRemoved),
        env.review
            .turn_cancelled("h1", RestoreReason::SessionRemoved),
    );
    let _ = (a, b);
    env.review
        .turn_cancelled("h1", RestoreReason::SessionRemoved)
        .await;
    env.review.flush_events();
    let ev = env.events();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].0.len(), 2, "each comment once");
    assert_eq!(
        env.review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        2
    );
}

#[tokio::test]
async fn persisted_deletes_the_hold_and_a_later_cancel_restores_nothing() {
    let mut env = Env::new().await;
    seed(&env, 1).await;
    env.review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1"]))
        .await
        .unwrap();
    env.review.flush_events();
    env.events();

    env.review.turn_persisted("h1").await;
    env.review.turn_persisted("h1").await;
    env.review
        .turn_cancelled("h1", RestoreReason::TurnCancelled)
        .await;
    env.review.flush_events();
    assert!(env.events().is_empty());
    assert!(env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments
        .is_empty());
    assert!(env.store.get_hold("h1").await.unwrap().is_none());
}

#[tokio::test]
async fn restore_hold_and_consume_hold_are_the_port_spellings() {
    let env = Env::new().await;
    seed(&env, 2).await;
    env.review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1"]))
        .await
        .unwrap();
    env.review
        .hold_for_turn(req(&env.wt, "h2", "t2", &["c2"]))
        .await
        .unwrap();
    env.review
        .restore_hold("h1", RestoreReason::SendFailed)
        .await;
    env.review.consume_hold("h2").await;
    let left = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments;
    assert_eq!(
        left.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["c1"]
    );
    assert_eq!(left[0].restored_reason, Some(RestoreReason::SendFailed));
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

/// 2.T8b (owner half) — a carried hold moves to the new session / turn.
#[tokio::test]
async fn rehome_moves_the_hold_to_the_new_session_and_turn() {
    let env = Env::new().await;
    seed(&env, 1).await;
    env.review
        .hold_for_turn(req(&env.wt, "h1", "old-turn", &["c1"]))
        .await
        .unwrap();
    env.review.rehome_hold("h1", "new-sess", "new-turn").await;
    let h = env.store.get_hold("h1").await.unwrap().unwrap();
    assert_eq!(
        (h.session_id.as_str(), h.turn_id.as_str()),
        ("new-sess", "new-turn")
    );
    assert_eq!(env.store.list_holds(Some("sess-1")).await.unwrap().len(), 0);
}

// ── Scheduled rows: adopt / restore once ──────────────────────────────────────

async fn held_row(env: &Env, row: &str, session: &str, channel: &str) {
    seed(env, 2).await;
    env.store
        .take_for_consumer(
            &env.wt,
            &ids(&["c1", "c2"]),
            None,
            "feature/review",
            TakeLimits {
                max_comments: 200,
                max_bytes: 131_072,
            },
            Consumer::Schedule(ScheduleSpec {
                id: row.into(),
                session_id: session.into(),
                message: "later".into(),
                fire_at: "2026-02-01T00:00:00Z".into(),
                now: "2026-01-01T00:00:00Z".into(),
                channel: Some(channel.into()),
                attachments: None,
            }),
        )
        .await
        .unwrap()
        .unwrap();
}

fn record_of(h: &vst_store::comment_consumers::HeldSnapshot) -> ReviewRecord {
    ReviewRecord {
        name: h.payload.name.clone(),
        comments: h.payload.comments.clone(),
    }
}

async fn payload_state(env: &Env, row: &str) -> PayloadState {
    let raw: String = env
        .store
        .get_scheduled_message(row)
        .await
        .unwrap()
        .and_then(|r| r.comments_snapshot)
        .expect("row with snapshot");
    // The payload is a JSON object with a top-level `"state"`; compare spellings.
    PayloadState::ALL
        .iter()
        .copied()
        .find(|s| raw.contains(&format!("\"state\":\"{}\"", s.as_str())))
        .expect("payload state")
}

#[tokio::test]
async fn adopt_turns_a_held_snapshot_into_a_hold_exactly_once() {
    let env = Env::new().await;
    held_row(&env, "row1", "sess-1", "json").await;
    let held = env
        .store
        .list_held_snapshots(vst_store::comment_consumers::HeldFilter::Session("sess-1"))
        .await
        .unwrap()
        .remove(0);

    let hold = env
        .review
        .adopt_snapshot("row1", record_of(&held), env.wt.clone(), "sess-1", "turn-x")
        .await
        .unwrap();
    assert_eq!(hold.record.comments.len(), 2);
    let stored = env.store.get_hold(&hold.hold_id).await.unwrap().unwrap();
    assert_eq!(stored.turn_id, "turn-x");
    assert_eq!(payload_state(&env, "row1").await, PayloadState::Adopted);

    // No longer `held`: a second adopt, and a restore, do nothing.
    assert_eq!(
        env.review
            .adopt_snapshot("row1", record_of(&held), env.wt.clone(), "sess-1", "turn-y")
            .await
            .unwrap_err(),
        ReviewError::NotFound
    );
    env.review
        .restore_snapshot(
            Some("row1"),
            record_of(&held),
            env.wt.clone(),
            RestoreReason::ScheduleFailed,
        )
        .await;
    assert!(env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments
        .is_empty());
}

#[tokio::test]
async fn restore_snapshot_restores_once_and_flips_the_payload() {
    let mut env = Env::new().await;
    held_row(&env, "row1", "sess-1", "json").await;
    env.events();
    let held = env
        .store
        .list_held_snapshots(vst_store::comment_consumers::HeldFilter::Session("sess-1"))
        .await
        .unwrap()
        .remove(0);

    for _ in 0..2 {
        env.review
            .restore_snapshot(
                Some("row1"),
                record_of(&held),
                env.wt.clone(),
                RestoreReason::ScheduleFailed,
            )
            .await;
    }
    env.review.flush_events();
    let ev = env.events();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].0.len(), 2);
    assert_eq!(payload_state(&env, "row1").await, PayloadState::Restored);
    assert_eq!(
        env.review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        2
    );
}

/// 3.T11 groundwork: session delete restores only pending, non-tmux, still-held
/// rows; a tmux row and an adopted row restore nothing.
#[tokio::test]
async fn restore_for_session_skips_tmux_adopted_and_restored_rows() {
    let env = Env::new().await;
    held_row(&env, "json-row", "sess-1", "json").await;
    seed(&env, 0).await;
    for (i, (row, channel)) in [("tmux-row", "tmux"), ("adopted-row", "json")]
        .iter()
        .enumerate()
    {
        let a = format!("a{i}");
        env.review
            .create(&env.wt, body(&a, "src/g.rs", 1))
            .await
            .unwrap();
        env.store
            .take_for_consumer(
                &env.wt,
                &[a],
                None,
                "feature/review",
                TakeLimits {
                    max_comments: 200,
                    max_bytes: 131_072,
                },
                Consumer::Schedule(ScheduleSpec {
                    id: (*row).into(),
                    session_id: "sess-1".into(),
                    message: String::new(),
                    fire_at: "2026-02-01T00:00:00Z".into(),
                    now: "2026-01-01T00:00:00Z".into(),
                    channel: Some((*channel).into()),
                    attachments: None,
                }),
            )
            .await
            .unwrap()
            .unwrap();
    }
    env.store
        .set_payload_state("adopted-row", PayloadState::Adopted, None)
        .await
        .unwrap();

    env.review.restore_for_session("sess-1").await;
    let back: Vec<String> = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(back.len(), 2, "only the json row's two comments: {back:?}");
    assert!(back.contains(&"c1".to_string()) && back.contains(&"c2".to_string()));
    assert_eq!(
        payload_state(&env, "json-row").await,
        PayloadState::Restored
    );
    assert_eq!(payload_state(&env, "tmux-row").await, PayloadState::Held);
}

// ── Bus subscriber ────────────────────────────────────────────────────────────

#[tokio::test]
async fn session_deleted_and_channel_flip_release_the_composer_lease() {
    let env = Env::new().await;
    seed(&env, 2).await;
    for (id, key) in [("c1", "session:sess-1"), ("c2", "session:direct-1")] {
        env.review
            .attach(
                &env.wt,
                AttachBody {
                    composer_key: key.into(),
                    comment_ids: Some(vec![id.into()]),
                    refresh_only: None,
                },
            )
            .await
            .unwrap();
    }
    env.review
        .on_holds_event(ServerEvent::SessionUpdated {
            session_id: "sess-1".into(),
            pinned_at: None,
            channel: Some(vst_types::Channel::Tmux),
            name: None,
            archived_at: None,
            sort_order: None,
            pr: None,
            superseded_by: None,
            is_main: None,
            parent_session_id: None,
            worktree_id: None,
            draft_prompt: None,
            draft_config: None,
            mode_id: None,
            mode_icon: None,
        })
        .await;
    env.review
        .on_holds_event(ServerEvent::SessionDeleted {
            session_id: "direct-1".into(),
        })
        .await;
    let rows = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments;
    assert!(rows.iter().all(|c| c.attached_to.is_none()), "{rows:?}");

    // An unrelated rename leaves a lease alone.
    env.review
        .attach(
            &env.wt,
            AttachBody {
                composer_key: "session:sess-1".into(),
                comment_ids: Some(vec!["c1".into()]),
                refresh_only: None,
            },
        )
        .await
        .unwrap();
    env.review
        .on_holds_event(ServerEvent::SessionUpdated {
            session_id: "sess-1".into(),
            pinned_at: None,
            channel: None,
            name: Some("renamed".into()),
            archived_at: None,
            sort_order: None,
            pr: None,
            superseded_by: None,
            is_main: None,
            parent_session_id: None,
            worktree_id: None,
            draft_prompt: None,
            draft_config: None,
            mode_id: None,
            mode_icon: None,
        })
        .await;
    let rows = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments;
    assert!(rows
        .iter()
        .any(|c| c.attached_to.as_deref() == Some("session:sess-1")));
}

#[tokio::test]
async fn deleting_a_session_restores_a_hold_the_engine_never_settled() {
    let env = Env::new().await;
    seed(&env, 1).await;
    env.review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1"]))
        .await
        .unwrap();
    env.review
        .on_holds_event(ServerEvent::SessionDeleted {
            session_id: "sess-1".into(),
        })
        .await;
    let rows = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].restored_reason, Some(RestoreReason::SessionRemoved));
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

/// Lagged bus: leases on a gone / archived / non-json session are released and
/// a hold whose session vanished is restored; live ones stay.
#[tokio::test]
async fn reconcile_scope_all_releases_stale_leases_and_restores_orphan_holds() {
    let env = Env::new().await;
    seed(&env, 4).await;
    // `sess-1` exists but is a tmux (non-json) session in the fixture; `ghost` does not.
    for (id, key) in [("c1", "session:sess-1"), ("c2", "session:ghost")] {
        env.review
            .attach(
                &env.wt,
                AttachBody {
                    composer_key: key.into(),
                    comment_ids: Some(vec![id.into()]),
                    refresh_only: None,
                },
            )
            .await
            .unwrap();
    }
    env.review
        .hold_for_turn(HoldRequest {
            session_id: "ghost".into(),
            ..req(&env.wt, "h-ghost", "t1", &["c3"])
        })
        .await
        .unwrap();
    env.review
        .hold_for_turn(HoldRequest {
            ..req(&env.wt, "h-live", "t2", &["c4"])
        })
        .await
        .unwrap();

    env.review.reconcile_scope_all().await;

    let rows = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments;
    assert_eq!(
        rows.len(),
        3,
        "c3 came back from the orphan hold; c4 stays held"
    );
    assert!(rows.iter().all(|c| c.attached_to.is_none()));
    assert!(env.store.get_hold("h-ghost").await.unwrap().is_none());
    assert!(
        env.store.get_hold("h-live").await.unwrap().is_some(),
        "a hold of an existing session stays"
    );
}

// ── "Restore to comments" on a sent card ──────────────────────────────────────

fn user_row(turn: &str, cancelled: bool, review: Option<ReviewRecord>) -> NormalizedEvent {
    let mut e = NormalizedEvent::default();
    e.kind = NormalizedEventKind::User;
    e.turn_id = Some(turn.into());
    e.cancelled = cancelled.then_some(true);
    e.review = review;
    e
}

#[tokio::test]
async fn persisted_review_reads_only_a_live_row_with_a_snapshot() {
    let env = Env::new().await;
    seed(&env, 1).await;
    let hold = env
        .review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1"]))
        .await
        .unwrap();
    let rec = hold.record;

    let events = vec![
        user_row("t-ok", false, Some(rec.clone())),
        user_row("t-cancelled", true, None),
        user_row("t-plain", false, None),
        {
            let mut e = user_row("t-sup", false, Some(rec.clone()));
            e.superseded = Some(true);
            e
        },
    ];
    assert_eq!(persisted_review(&events, "t-ok").unwrap(), rec);
    assert_eq!(
        persisted_review(&events, "t-cancelled"),
        Err(CardRestoreError::Unavailable)
    );
    assert_eq!(
        persisted_review(&events, "t-sup"),
        Err(CardRestoreError::Unavailable)
    );
    assert_eq!(
        persisted_review(&events, "t-plain"),
        Err(CardRestoreError::NoReview)
    );
    assert_eq!(
        persisted_review(&events, "nope"),
        Err(CardRestoreError::NoSuchTurn)
    );
}

/// 2.T10 — restore from the persisted snapshot is idempotent: comments already
/// in the panel are skipped, no tray notice is set.
#[tokio::test]
async fn restore_sent_review_skips_what_is_already_in_the_panel() {
    let env = Env::new().await;
    seed(&env, 2).await;
    let hold = env
        .review
        .hold_for_turn(req(&env.wt, "h1", "t1", &["c1", "c2"]))
        .await
        .unwrap();
    env.review.turn_persisted("h1").await;

    let first = env
        .review
        .restore_sent_review(&env.wt, &hold.record.comments)
        .await
        .unwrap();
    assert_eq!((first.restored, first.skipped), (2, 0));
    let again = env
        .review
        .restore_sent_review(&env.wt, &hold.record.comments)
        .await
        .unwrap();
    assert_eq!((again.restored, again.skipped), (0, 2));

    let rows = env
        .review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments;
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter().all(|c| c.restored_reason.is_none()),
        "no notice"
    );
    let pins: Vec<u32> = rows.iter().map(|c| c.pin).collect();
    assert_eq!(pins, vec![1, 2], "original pins");
}

/// 5: a row whose adopted hold is restored after a failed delivery must say
/// `restored`, so Retry re-holds the comments instead of sending without them.
#[tokio::test]
async fn restoring_an_adopted_hold_flips_the_row_payload_so_retry_reholds() {
    let env = Env::new().await;
    held_row(&env, "row1", "sess-1", "json").await;
    let held = env
        .store
        .list_held_snapshots(vst_store::comment_consumers::HeldFilter::Session("sess-1"))
        .await
        .unwrap()
        .remove(0);
    let hold = env
        .review
        .adopt_snapshot("row1", record_of(&held), env.wt.clone(), "sess-1", "turn-x")
        .await
        .unwrap();
    assert_eq!(payload_state(&env, "row1").await, PayloadState::Adopted);
    // The row failed to deliver after the adopt.
    env.store
        .claim_scheduled_message("row1", "sess-1", "2026-02-01T00:00:01Z")
        .await
        .unwrap();
    env.store
        .mark_scheduled_message_failed("row1", "boom", None, "2026-02-01T00:00:02Z")
        .await
        .unwrap();
    env.review
        .restore_hold(&hold.hold_id, RestoreReason::ScheduleFailed)
        .await;
    assert_eq!(payload_state(&env, "row1").await, PayloadState::Restored);
    // Retry: both comments are back in the panel and are re-held.
    assert_eq!(env.review.rehold_schedule("row1").await.unwrap(), 2);
    assert_eq!(payload_state(&env, "row1").await, PayloadState::Held);
}

#[tokio::test]
async fn retry_with_nothing_left_in_the_panel_clears_the_stale_snapshot() {
    let env = Env::new().await;
    held_row(&env, "row1", "sess-1", "json").await;
    let held = env
        .store
        .list_held_snapshots(vst_store::comment_consumers::HeldFilter::Session("sess-1"))
        .await
        .unwrap()
        .remove(0);
    env.review
        .restore_snapshot(
            Some("row1"),
            record_of(&held),
            env.wt.clone(),
            RestoreReason::ScheduleFailed,
        )
        .await;
    env.store
        .claim_scheduled_message("row1", "sess-1", "2026-02-01T00:00:01Z")
        .await
        .unwrap();
    env.store
        .mark_scheduled_message_failed("row1", "boom", None, "2026-02-01T00:00:02Z")
        .await
        .unwrap();
    // The user deleted both restored comments meanwhile.
    for c in &held.payload.comments {
        env.review.delete(&c.id).await.unwrap();
    }
    assert_eq!(env.review.rehold_schedule("row1").await.unwrap(), 0);
    let row = env
        .store
        .get_scheduled_message("row1")
        .await
        .unwrap()
        .unwrap();
    assert!(row.comments_snapshot.is_none(), "no stale chip count");
}

/// CR-03 at boot: a held row whose marker columns are partly NULL still
/// reaches `reconcile_boot`, which restores it with every other hold.
#[tokio::test]
async fn reconcile_boot_restores_a_hold_with_a_null_marker_column() {
    let env = Env::new().await;
    seed(&env, 2).await;
    env.review
        .hold_for_turn(req(&env.wt, "h-bad", "t1", &["c1"]))
        .await
        .unwrap();
    env.review
        .hold_for_turn(req(&env.wt, "h-ok", "t2", &["c2"]))
        .await
        .unwrap();
    env.store
        .raw_conn()
        .execute("UPDATE comments SET heldSession = NULL WHERE id = 'c1'", [])
        .unwrap();
    let reader: vst_review::TranscriptReader =
        std::sync::Arc::new(|_| Box::pin(async { Some(Vec::<NormalizedEvent>::new()) }));
    let report = env.review.reconcile_boot(reader).await;
    assert_eq!(report.holds_restored, 2);
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
    assert_eq!(
        env.review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        2
    );
}

#[tokio::test]
async fn restore_for_session_reports_a_store_failure_and_a_retry_restores() {
    let env = Env::new().await;
    held_row(&env, "json-row", "sess-1", "json").await;
    // The store cannot answer: the caller must keep the scheduled row (its
    // snapshot is the only copy of the comments).
    env.store
        .raw_conn()
        .execute(
            "ALTER TABLE scheduled_messages RENAME TO scheduled_messages_off",
            [],
        )
        .unwrap();
    assert!(!ReviewPort::restore_for_session(&env.review, "sess-1").await);
    assert!(!ReviewPort::restore_orphaned_snapshots(&env.review).await);
    env.store
        .raw_conn()
        .execute(
            "ALTER TABLE scheduled_messages_off RENAME TO scheduled_messages",
            [],
        )
        .unwrap();
    // The store is back: the snapshot is still held and restores now.
    assert_eq!(payload_state(&env, "json-row").await, PayloadState::Held);
    assert!(ReviewPort::restore_for_session(&env.review, "sess-1").await);
    assert_eq!(
        payload_state(&env, "json-row").await,
        PayloadState::Restored
    );
    assert_eq!(
        env.review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        2
    );
}
