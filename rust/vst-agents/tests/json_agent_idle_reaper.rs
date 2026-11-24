//! Idle reaper against a real (fake-adapter) child process.

mod common;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use vst_agents::acp_transport::AcpTransport;
use vst_types::{LifecycleState, ProjectRecord};

fn project_with(session_id: &str) -> ProjectRecord {
    let mut p = common::make_project("p1");
    p.direct_sessions.push(common::make_session(session_id));
    p
}

#[tokio::test]
async fn reaping_ends_the_child_and_leaves_lifecycle_alone() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    store.add_project(project_with("s-reap")).await.unwrap();
    let plugin = common::FakeAcpPlugin::default();
    let s = common::seeded_session(&store, "s-reap", 0, Arc::new(plugin));

    let conn = s
        .get_or_create_connection(common::fake_acp_spec(), None)
        .await
        .unwrap();
    assert!(s.has_live_connection_for_test() && conn.is_alive());

    assert!(s.reap_agent_if_idle(Duration::ZERO).await);
    assert!(!s.has_live_connection_for_test());
    for _ in 0..500 {
        if !conn.is_alive() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!conn.is_alive(), "the child exits after the reap");
    let (_, rec) = store.find_session("s-reap").await.unwrap();
    assert_eq!(
        rec.lifecycle.state,
        LifecycleState::Working,
        "no lifecycle write"
    );
    assert!(
        !s.reap_agent_if_idle(Duration::ZERO).await,
        "nothing left to reap"
    );
}

#[tokio::test]
async fn a_send_racing_the_reap_always_completes() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let plugin = common::FakeAcpPlugin::default();
    let (completed, errors) = (plugin.completed.clone(), plugin.errors.clone());
    let s = common::seeded_session(&store, "s-race", 0, Arc::new(plugin));

    for i in 0..20 {
        let (_, _) = tokio::join!(s.reap_agent_if_idle(Duration::ZERO), async {
            s.enqueue(format!("turn {i}"), vec![], None, None)
        });
        common::wait_turns(&completed, i + 1, &s).await;
    }
    assert_eq!(completed.load(Ordering::SeqCst), 20);
    assert!(
        errors.lock().unwrap().is_empty(),
        "{:?}",
        errors.lock().unwrap()
    );
    // Leave no child behind.
    s.reap_agent_if_idle(Duration::ZERO).await;
}
