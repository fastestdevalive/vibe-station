//! Phase 3, 3.T1 — `LimitsRoutes` route-owner tests.

use tempfile::tempdir;
use tokio::sync::broadcast;
use vst_harness_limits::LimitsHandle;
use vst_routes::limits::{LimitsRouteError, LimitsRoutes, LIMITS_SLOTS_SCOPE};
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::limits::{default_slots, LimitSlotRef, PutLimitSlotsBody};

fn routes(tmp: &std::path::Path) -> (Broadcaster, LimitsRoutes) {
    let store = StoreHandle::open(&tmp.join("vibe-station.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let handle = LimitsHandle::inert(broadcaster.clone(), "test".to_string());
    let routes = LimitsRoutes::new(handle, store);
    (broadcaster, routes)
}

async fn next_limits(
    rx: &mut broadcast::Receiver<ServerEvent>,
) -> vst_types::limits::LimitsSnapshot {
    loop {
        match rx.recv().await {
            Ok(ServerEvent::LimitsUpdated { limits }) => return limits,
            Ok(_) => continue,
            Err(_) => panic!("broadcast closed"),
        }
    }
}

#[tokio::test]
async fn put_slots_validates() {
    let tmp = tempdir().unwrap();
    let (_, routes) = routes(tmp.path());

    let ok = LimitSlotRef::new("claude", "five_hour");
    let other = LimitSlotRef::new("codex", "primary");

    // Wrong length (1).
    let err = routes
        .put_slots(PutLimitSlotsBody {
            slots: vec![ok.clone()],
        })
        .await
        .unwrap_err();
    assert_eq!(
        err,
        LimitsRouteError::Validation("slots must contain exactly 2 entries".to_string())
    );

    // Empty harness.
    let err = routes
        .put_slots(PutLimitSlotsBody {
            slots: vec![LimitSlotRef::new("", "five_hour"), other.clone()],
        })
        .await
        .unwrap_err();
    assert_eq!(
        err,
        LimitsRouteError::Validation(
            "harness and windowId must be non-empty and contain no '/'".to_string()
        )
    );

    // Empty window id.
    let err = routes
        .put_slots(PutLimitSlotsBody {
            slots: vec![LimitSlotRef::new("claude", ""), other.clone()],
        })
        .await
        .unwrap_err();
    assert_eq!(
        err,
        LimitsRouteError::Validation(
            "harness and windowId must be non-empty and contain no '/'".to_string()
        )
    );

    // '/' in a window id.
    let err = routes
        .put_slots(PutLimitSlotsBody {
            slots: vec![LimitSlotRef::new("claude", "a/b"), other.clone()],
        })
        .await
        .unwrap_err();
    assert_eq!(
        err,
        LimitsRouteError::Validation(
            "harness and windowId must be non-empty and contain no '/'".to_string()
        )
    );

    // '/' in a harness id (would corrupt the persisted `harness/windowId` key).
    let err = routes
        .put_slots(PutLimitSlotsBody {
            slots: vec![LimitSlotRef::new("a/b", "five_hour"), other.clone()],
        })
        .await
        .unwrap_err();
    assert_eq!(
        err,
        LimitsRouteError::Validation(
            "harness and windowId must be non-empty and contain no '/'".to_string()
        )
    );

    // Identical slots.
    let err = routes
        .put_slots(PutLimitSlotsBody {
            slots: vec![ok.clone(), ok.clone()],
        })
        .await
        .unwrap_err();
    assert_eq!(
        err,
        LimitsRouteError::Validation("slots must be different".to_string())
    );
}

#[tokio::test]
async fn put_slots_persists_and_broadcasts() {
    let tmp = tempdir().unwrap();
    let (broadcaster, routes) = routes(tmp.path());
    let mut rx = broadcaster.subscribe();

    let new_slots = [
        LimitSlotRef::new("claude", "five_hour"),
        LimitSlotRef::new("codex", "primary"),
    ];
    let snap = routes
        .put_slots(PutLimitSlotsBody {
            slots: new_slots.to_vec(),
        })
        .await
        .expect("valid slots accepted");
    assert_eq!(snap.slots, new_slots);

    // One LimitsUpdated broadcast with the new slots.
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), next_limits(&mut rx))
        .await
        .expect("broadcast after put_slots");
    assert_eq!(event.slots, new_slots);

    // Persisted: load_slots returns them.
    let store = StoreHandle::open(&tmp.path().join("vibe-station.db")).unwrap();
    let loaded = LimitsRoutes::load_slots(&store).await;
    assert_eq!(loaded, new_slots);
}

#[tokio::test]
async fn load_slots_defaults_when_absent_or_corrupt() {
    let tmp = tempdir().unwrap();
    let store = StoreHandle::open(&tmp.path().join("vibe-station.db")).unwrap();

    // Absent → default.
    assert_eq!(LimitsRoutes::load_slots(&store).await, default_slots());

    // Corrupt: wrong length.
    store
        .set_ordered_list(LIMITS_SLOTS_SCOPE, vec!["claude/five_hour".to_string()])
        .await;
    assert_eq!(LimitsRoutes::load_slots(&store).await, default_slots());

    // Corrupt: unparseable key.
    store
        .set_ordered_list(
            LIMITS_SLOTS_SCOPE,
            vec!["claude/five_hour".to_string(), "nope".to_string()],
        )
        .await;
    assert_eq!(LimitsRoutes::load_slots(&store).await, default_slots());

    // Corrupt: identical slots.
    store
        .set_ordered_list(
            LIMITS_SLOTS_SCOPE,
            vec![
                "claude/five_hour".to_string(),
                "claude/five_hour".to_string(),
            ],
        )
        .await;
    assert_eq!(LimitsRoutes::load_slots(&store).await, default_slots());

    // Valid two-slot list loads back.
    store
        .set_ordered_list(
            LIMITS_SLOTS_SCOPE,
            vec!["claude/five_hour".to_string(), "codex/primary".to_string()],
        )
        .await;
    let loaded = LimitsRoutes::load_slots(&store).await;
    assert_eq!(
        loaded,
        [
            LimitSlotRef::new("claude", "five_hour"),
            LimitSlotRef::new("codex", "primary")
        ]
    );
}

#[tokio::test]
async fn refresh_cooldown_returns_started_false() {
    let tmp = tempdir().unwrap();
    let (_, routes) = routes(tmp.path());

    let first = routes.refresh().await;
    assert!(first.started, "first manual refresh should start");
    assert!(first.retry_after_secs.is_none());

    // Immediate second call is inside the 30 s cooldown.
    let second = routes.refresh().await;
    assert!(!second.started, "second manual refresh inside cooldown");
    assert!(second.retry_after_secs.is_some());
    assert!(second.retry_after_secs.unwrap() >= 1);
}
