//! Resume of a Terminal (tmux) agent whose CLI the user quit (`/exit`).
//!
//! Real tmux on a private socket + a stub `claude` in the temp home's
//! `.vibe-station/bin` (which `build_vst_env` puts first on the agent's PATH).
//!
//! Manual-only: `#[ignore]`d (needs real tmux), run with `cargo test -p vst-routes
//! --test resume_after_exit -- --ignored`; no CI script runs it.

use std::sync::Arc;
use std::time::Duration;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::lifecycle::LifecyclePollerHandle;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_proc::tmux::{NewSessionOptions, Tmux};
use vst_routes::sessions::SessionRoutes;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionNameSource, SessionRecord,
    SessionType,
};
use vst_ws::state::attachment_registry::AttachmentRegistry;

/// Restores this process's `PATH` on drop (also on a failed assert), so the
/// stub dir never leaks into another test in the same binary.
struct PathGuard(Option<std::ffi::OsString>);

impl PathGuard {
    fn prepend(dir: &std::path::Path) -> Self {
        let old = std::env::var_os("PATH");
        let mut paths = vec![dir.to_path_buf()];
        paths.extend(old.iter().flat_map(std::env::split_paths));
        std::env::set_var("PATH", std::env::join_paths(paths).unwrap());
        Self(old)
    }
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        match self.0.take() {
            Some(old) => std::env::set_var("PATH", old),
            None => std::env::remove_var("PATH"),
        }
    }
}

fn tmux_available() -> bool {
    std::process::Command::new("tmux")
        .arg("-V")
        .output()
        .is_ok_and(|o| o.status.success())
}

fn routes(store: StoreHandle, tmux: Tmux) -> SessionRoutes {
    SessionRoutes {
        store: store.clone(),
        broadcaster: Broadcaster::new(64),
        json_registry: Arc::new(JsonAgentRegistry::new()),
        direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
        direct_streams: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        tmux: tmux.clone(),
        daemon_port: 3999,
        json_unsupported: Arc::new(|_| None),
        subagent_notify: SubagentNotifyHandle::new(),
        attachment_registry: AttachmentRegistry::new(),
        model_catalog: Default::default(),
        handoff_timeout: Duration::from_secs(120),
        reset_cancels: Default::default(),
        terminal_delivery: vst_routes::terminal_delivery::build_terminal_delivery(
            store,
            Broadcaster::new(16),
            Arc::new(tmux),
            None,
        ),
        accounts: None,
    }
}

fn session(id: &str, project_id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: project_id.into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("my-mode".into()),
        mode_icon: None,
        account_id: None,
        name: Some("Agent".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: format!("vst-resume-exit-{id}"),
        use_tmux: true,
        channel: Some(Channel::Tmux),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: Some("original prompt".into()),
        draft_prompt: None,
        draft_config: None,
        archived_at: None,
        handoff_summary: None,
        carry_over: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

fn project(id: &str, path: &std::path::Path) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: path.to_string_lossy().into_owned(),
        prefix: "vs".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    }
}

/// Seed a claude mode and a stub `claude` that logs its argv and stays up.
fn seed_home(home: &std::path::Path) {
    let vst = home.join(".vibe-station");
    std::fs::create_dir_all(vst.join("bin")).unwrap();
    let modes = serde_json::json!([{
        "id": "my-mode", "name": "My Mode", "cli": "claude", "context": "",
        "createdAt": "2026-01-01T00:00:00.000Z", "model": null
    }]);
    std::fs::write(vst.join("modes.json"), modes.to_string()).unwrap();
    let stub = vst.join("bin").join("claude");
    let log = home.join("claude-argv.log");
    std::fs::write(
        &stub,
        format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\nprintf '\\342\\235\\257 '\nexec sleep 300\n",
            log.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
#[ignore = "requires a real tmux binary; run with --ignored"]
async fn resume_brings_back_a_terminal_agent_after_the_user_quit_the_cli() {
    if !tmux_available() {
        eprintln!("tmux not available; skipping");
        return;
    }
    let guard = vst_proc::test_support::TmuxGuard::new();
    let tmux = guard.tmux();
    let home = tempdir().unwrap();
    seed_home(home.path());
    // tmux takes a new pane's PATH from the CLIENT (this process), not from
    // `-e PATH=` — the daemon sets its own PATH at boot for the same reason.
    let stub_dir = home.path().join(".vibe-station/bin");
    let _path = PathGuard::prepend(&stub_dir);
    // Never fall through to a real `claude` on the developer's machine.
    let resolved = std::process::Command::new("sh")
        .args(["-c", "command -v claude"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&resolved.stdout).trim(),
        stub_dir.join("claude").to_string_lossy(),
        "the stub must win on PATH"
    );
    let _home = with_home(home.path().to_path_buf());
    let cwd = tempdir().unwrap();
    let cwd_str = cwd.path().to_string_lossy().into_owned();
    // This session's own conversation (recorded by its SessionStart hook), and a
    // NEWER one of a sibling agent in the same worktree.
    let projects = home
        .path()
        .join(".claude/projects")
        .join(cwd_str.replace(['/', '.'], "-"));
    std::fs::create_dir_all(&projects).unwrap();
    std::fs::write(projects.join("own-conversation.jsonl"), "{}\n").unwrap();
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(projects.join("sibling-conversation.jsonl"), "{}\n").unwrap();
    let ids = cwd.path().join(".vibe-station/agent-chat-ids");
    std::fs::create_dir_all(&ids).unwrap();
    std::fs::write(ids.join("s1"), "own-conversation").unwrap();
    let dbdir = tempdir().unwrap();
    let store = StoreHandle::open(dbdir.path().join("vibe-station.db")).unwrap();
    let s = session("s1", "p1");
    let mut p = project("p1", cwd.path());
    p.direct_sessions.push(s.clone());
    store.add_project(p).await.unwrap();

    // The agent ran and the user typed /exit: the CLI exited 0 and
    // `remain-on-exit` kept a dead pane.
    tmux.new_session(&NewSessionOptions {
        name: s.tmux_name.clone(),
        cwd: Some(cwd.path().to_path_buf()),
        env: Default::default(),
        command: Some(vec!["sh".into(), "-c".into(), "exit 0".into()]),
        remain_on_exit: true,
    })
    .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let poller =
        LifecyclePollerHandle::new(store.clone(), Broadcaster::new(64)).with_tmux(tmux.clone());
    poller.run_poll_once().await;
    let (_, rec) = store.find_session("s1").await.unwrap();
    assert_eq!(
        rec.lifecycle.state,
        LifecycleState::Exited,
        "poller marks the quit CLI exited"
    );

    let r = routes(store.clone(), tmux.clone());
    let out = r.resume_session("s1").await;
    assert!(out.is_ok(), "resume failed: {:?}", out.err());

    assert!(
        tmux.pane_is_alive(&s.tmux_name),
        "resumed pane must be alive"
    );
    for _ in 0..3 {
        poller.run_poll_once().await;
    }
    let (_, rec) = store.find_session("s1").await.unwrap();
    assert_ne!(
        rec.lifecycle.state,
        LifecycleState::Exited,
        "resumed agent must stay up"
    );
    assert!(
        tmux.pane_is_alive(&s.tmux_name),
        "resumed pane must still be alive"
    );
    let argv = std::fs::read_to_string(home.path().join("claude-argv.log")).unwrap_or_default();
    assert!(
        argv.contains("--resume own-conversation"),
        "must resume this session's own conversation, got: {argv}"
    );
}
