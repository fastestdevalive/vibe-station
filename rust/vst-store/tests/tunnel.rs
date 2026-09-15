//! Behavior contract for `tunnel-store.ts` (part 01-storage).
//! Ported 1:1 from `daemon/src/__tests__/tunnel-store.test.ts`.

use vst_store::tunnel::TunnelStateRow;
use vst_store::StoreHandle;

#[tokio::test]
async fn set_then_get_round_trips_all_fields() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .set_tunnel_state(TunnelStateRow {
            enabled: true,
            current_url: Some("https://x.trycloudflare.com".into()),
            current_pid: Some(4242),
            started_at: Some(1_700_000_000_000),
            port: Some(7421),
        })
        .await;
    assert_eq!(
        store.get_tunnel_state().await,
        TunnelStateRow {
            enabled: true,
            current_url: Some("https://x.trycloudflare.com".into()),
            current_pid: Some(4242),
            started_at: Some(1_700_000_000_000),
            port: Some(7421),
        }
    );
}

#[tokio::test]
async fn clear_zeroes_enabled_and_process_fields() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .set_tunnel_state(TunnelStateRow {
            enabled: true,
            current_url: Some("https://x.trycloudflare.com".into()),
            current_pid: Some(4242),
            started_at: Some(1),
            port: Some(7421),
        })
        .await;
    store.clear_tunnel().await;
    assert_eq!(store.get_tunnel_state().await, TunnelStateRow::empty());
}

#[tokio::test]
async fn clear_process_zeroes_only_process_fields_leaves_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .set_tunnel_state(TunnelStateRow {
            enabled: true,
            current_url: Some("https://x.trycloudflare.com".into()),
            current_pid: Some(4242),
            started_at: Some(1),
            port: Some(7421),
        })
        .await;
    store.clear_tunnel_process().await;
    let state = store.get_tunnel_state().await;
    assert!(state.enabled);
    assert!(state.current_url.is_none());
    assert!(state.current_pid.is_none());
}

#[tokio::test]
async fn fresh_db_returns_empty_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    assert_eq!(store.get_tunnel_state().await, TunnelStateRow::empty());
}
