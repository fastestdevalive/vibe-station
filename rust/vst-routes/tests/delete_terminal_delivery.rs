//! Worktree and project deletes purge scheduled rows, so they must go through
//! `TerminalDeliveryHandle::on_session_removed` first: jobs stop and the outcome
//! observer hears `Gone` exactly once per held row.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tempfile::tempdir;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_git::paths::Paths;
use vst_proc::tmux::PaneFlags;
use vst_review::{OutcomeObserver, PaneIo};
use vst_routes::projects::ProjectRoutes;
use vst_routes::terminal_delivery::build_terminal_delivery;
use vst_routes::worktrees::WorktreeRoutes;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::terminal_delivery::{PaneSnapshot, TerminalOutcome};
use vst_types::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType,
    WorktreeRecord,
};

const ISO: &str = "2026-01-01T00:00:00.000Z";

struct IdlePane;
impl PaneIo for IdlePane {
    fn list_session_names(&self) -> Option<HashSet<String>> {
        Some(["vst-sd", "vst-sw"].into_iter().map(String::from).collect())
    }
    fn pane_flags(&self, _: &str) -> Option<PaneFlags> {
        Some(PaneFlags {
            in_mode: false,
            dead: false,
        })
    }
    fn capture(&self, _: &str) -> Result<PaneSnapshot, String> {
        Ok(PaneSnapshot {
            text: "starting up".into(),
            cursor_x: 0,
            cursor_y: 0,
        })
    }
    fn cancel_mode(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn paste(&self, _: &str, _: &str, _: &str, _: bool) -> Result<(), String> {
        Ok(())
    }
    fn send_enter(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

fn session(id: &str, worktree: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree.map(Into::into),
        project_id: "p1".into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("m-claude".into()),
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("vst-{id}"),
        use_tmux: true,
        channel: Some(Channel::Tmux),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: ISO.into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
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

fn write_modes(home: &std::path::Path) {
    let dir = home.join(".vibe-station");
    std::fs::create_dir_all(&dir).unwrap();
    let mode = serde_json::json!({
        "id": "m-claude", "name": "m-claude", "cli": "claude", "context": "",
        "createdAt": ISO, "model": null, "icon": "claude",
    });
    std::fs::write(
        dir.join("modes.json"),
        serde_json::json!([mode]).to_string(),
    )
    .unwrap();
}

struct Env {
    _home: tempfile::TempDir,
    _guard: vst_agents::home::HomeGuard,
    _dir: tempfile::TempDir,
    store: StoreHandle,
    project: ProjectRoutes,
    worktree: WorktreeRoutes,
    outcomes: Arc<Mutex<Vec<(String, TerminalOutcome)>>>,
}

async fn env() -> Env {
    let home = tempdir().unwrap();
    write_modes(home.path());
    let guard = vst_agents::home::with_home(home.path().to_path_buf());
    let dir = tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let paths = Paths::with_home(dir.path().join(".vibe-station"));
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let wt = WorktreeRecord {
        id: "w1".into(),
        name: None,
        branch: "feat-w1".into(),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "a".repeat(40),
        created_at: ISO.into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: Some(0),
        agent_seq: Some(1),
        lsp_enabled: None,
        sessions: vec![session("sw", Some("w1"))],
        open_files: vec![],
    };
    store
        .add_project(ProjectRecord {
            id: "p1".into(),
            absolute_path: repo.to_string_lossy().into(),
            prefix: "vs".into(),
            is_git: true,
            default_branch: Some("main".into()),
            created_at: ISO.into(),
            hidden: None,
            direct_sessions: vec![session("sd", None)],
            direct_session_seq: Some(1),
            worktrees: vec![wt],
            next_worktree_num: Some(2),
            lsp_enabled: None,
            open_files: vec![],
        })
        .await
        .unwrap();
    let bc = Broadcaster::new(64);
    let outcomes: Arc<Mutex<Vec<(String, TerminalOutcome)>>> = Default::default();
    let o = outcomes.clone();
    let observer: OutcomeObserver = Arc::new(move |id, out| o.lock().unwrap().push((id, out)));
    let td = build_terminal_delivery(
        store.clone(),
        bc.clone(),
        Arc::new(IdlePane),
        Some(observer),
    );
    let registry = Arc::new(JsonAgentRegistry::new());
    let project = ProjectRoutes::new(
        store.clone(),
        bc.clone(),
        registry.clone(),
        vst_proc::test_support::isolated_tmux(),
        4000,
    )
    .with_paths(paths.clone())
    .with_terminal_delivery(td.clone());
    let mut worktree = WorktreeRoutes::new(
        store.clone(),
        bc,
        registry,
        vst_proc::test_support::isolated_tmux(),
        4000,
    )
    .with_terminal_delivery(td.clone());
    worktree.paths = paths;
    // One held (claimed + waiting) tmux row per session, fired into the owner.
    for (row, sid) in [("r-d", "sd"), ("r-w", "sw")] {
        store
            .insert_scheduled_message(
                row,
                sid,
                "hi",
                None,
                "2026-01-01T00:00:00Z",
                ISO,
                Some("tmux"),
                None,
                Some("schedule"),
            )
            .await
            .unwrap();
        let claimed = store
            .claim_scheduled_message(row, sid, "2026-01-01T00:00:01Z")
            .await
            .unwrap()
            .unwrap();
        td.fire(claimed).await;
    }
    Env {
        _home: home,
        _guard: guard,
        _dir: dir,
        store,
        project,
        worktree,
        outcomes,
    }
}

#[tokio::test]
async fn deleting_a_worktree_reports_gone_for_its_held_terminal_rows() {
    let e = env().await;
    e.worktree.delete_worktree("w1", false).await.unwrap();
    assert_eq!(
        e.outcomes.lock().unwrap().clone(),
        vec![("r-w".into(), TerminalOutcome::Gone)]
    );
    assert!(e
        .store
        .get_scheduled_message("r-w")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn deleting_a_project_reports_gone_for_every_held_terminal_row() {
    let e = env().await;
    e.project.delete_project("p1").await.unwrap();
    let mut got = e.outcomes.lock().unwrap().clone();
    got.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        got,
        vec![
            ("r-d".into(), TerminalOutcome::Gone),
            ("r-w".into(), TerminalOutcome::Gone)
        ]
    );
}
