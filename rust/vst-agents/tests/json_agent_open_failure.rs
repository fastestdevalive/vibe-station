//! A transcript store that cannot be opened must surface as an error from the
//! lazy create — never a panic. The panic used to fire inside the registry's
//! lock and poison it, killing Rich Chat for every session (debug), or abort
//! the daemon (`panic = "abort"`, release).

mod common;

use std::sync::Arc;

use tokio::sync::broadcast;
use vst_agents::create_claude_plugin;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::{
    get_or_create_json_agent_session, probe_disk_transcript, JsonAgentSession,
    JsonAgentSessionOptions,
};
use vst_agents::paths::Paths;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;

const SID: &str = "s-broken";

#[tokio::test]
async fn unopenable_transcript_is_an_error_and_registers_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    let mut project = common::make_project("p1");
    let session = common::make_session(SID);
    project.direct_sessions.push(session.clone());
    store.add_project(project.clone()).await.unwrap();

    // `messages.db` is a directory: SQLite cannot open it.
    let data_dir = Paths::default().direct_session_data_dir("p1", SID);
    std::fs::create_dir_all(data_dir.join("messages.db")).unwrap();

    let opts = || JsonAgentSessionOptions {
        project: project.clone(),
        worktree: None,
        session: session.clone(),
        plugin: Arc::new(create_claude_plugin()),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle: store.clone(),
        broadcaster: Broadcaster(broadcast::channel(16).0),
    };
    let registry = JsonAgentRegistry::<JsonAgentSession>::new();

    assert!(get_or_create_json_agent_session(&registry, opts()).is_err());
    assert!(registry.get(SID).is_none(), "nothing registered on failure");
    assert!(probe_disk_transcript(&data_dir, SID).is_err());

    // Once the store is readable again the next resolve succeeds.
    std::fs::remove_dir_all(data_dir.join("messages.db")).unwrap();
    assert!(probe_disk_transcript(&data_dir, SID).is_ok());
    let s = get_or_create_json_agent_session(&registry, opts()).expect("retry succeeds");
    assert!(registry.get(SID).is_some());
    s.release().await;
}
