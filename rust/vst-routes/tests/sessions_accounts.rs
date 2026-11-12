//! Account rules for session create/resume/reset (multi-account plan A3.T2/T3,
//! Decisions 7/11/12). CLI-agnostic: every case goes through the plugin seam.
//!
//! Modes are seeded into a temp home (`load_modes` reads it); the accounts
//! registry lives in its own temp root with fake identity/support closures, so
//! no real login or credential file is ever touched. Agent spawns are detached
//! by the routes and use an isolated tmux socket; the CLIs chosen here (cursor,
//! omp) are the ones the A1 spike found absent, so no real agent process runs.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use tempfile::tempdir;
use vst_accounts::{AccountsDeps, AccountsHandle, IdentityFn};
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::read_transcript_from_data_dir;
use vst_agents::paths::Paths as AgentPaths;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::account_sessions::AccountProblem;
use vst_routes::projects::{ProjectRouteError, ProjectRoutes};
use vst_routes::sessions::{ResetError, ResumeError, SessionRoutes};
use vst_routes::worktrees::{WorktreeRouteError, WorktreeRoutes};
use vst_store::transcript::open_transcript_store;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::projects::{CreateNewProjectBody, CreateNewProjectResult};
use vst_types::rest::sessions::WhenBusy;
use vst_types::rest::sessions::{ResetBody, SessionOrDraft, StartDraftBody};
use vst_types::rest::worktrees::CreateWorktreeBody;
use vst_types::{
    AccountAuth, AccountIdentity, CarryOver, Channel, DraftConfig, DraftEntryPoint, LifecycleState,
    NormalizedEvent, NormalizedEventKind, ProjectRecord, SessionBreakKind, SessionLifecycle,
    SessionNameSource, SessionRecord, SessionType, WorktreeRecord,
};
use vst_ws::state::attachment_registry::AttachmentRegistry;

fn store() -> (tempfile::TempDir, StoreHandle) {
    let dir = tempdir().unwrap();
    let s = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    (dir, s)
}

/// A temp home with the given `(id, name, cli)` modes, plus the guard.
fn home_with_modes(
    modes: &[(&str, &str, &str)],
) -> (tempfile::TempDir, vst_agents::home::HomeGuard) {
    let home = tempdir().unwrap();
    let modes_dir = home.path().join(".vibe-station");
    std::fs::create_dir_all(&modes_dir).unwrap();
    let arr: Vec<serde_json::Value> = modes
        .iter()
        .map(|(id, name, cli)| {
            serde_json::json!({
                "id": id,
                "name": name,
                "cli": cli,
                "context": "",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "model": null,
            })
        })
        .collect();
    std::fs::write(
        modes_dir.join("modes.json"),
        serde_json::to_string(&arr).unwrap(),
    )
    .unwrap();
    let guard = with_home(home.path().to_path_buf());
    (home, guard)
}

fn signed_in_identity() -> IdentityFn {
    Arc::new(|_| {
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(true),
                email: Some("work@example.com".to_string()),
                plan: None,
            }
        })
    })
}

/// A registry over `root` whose supported CLIs are exactly `supported`.
fn accounts_handle(root: &Path, supported: &[&str]) -> AccountsHandle {
    let supported: Vec<String> = supported.iter().map(|s| (*s).to_owned()).collect();
    AccountsHandle::new(AccountsDeps {
        root: root.to_path_buf(),
        broadcaster: Broadcaster::new(16),
        identity: signed_in_identity(),
        shared_entries: Arc::new(|_| None),
        supports: Arc::new(move |cli| supported.iter().any(|s| s == cli)),
    })
}

/// A usable (not signed-out) api-key account, so `resolve` succeeds.
fn add_account(accounts: &AccountsHandle, cli: &str, label: &str) -> String {
    accounts
        .add_api_key(cli, "sk-test-key", label)
        .expect("account created")
        .id
}

fn routes(store: &StoreHandle, accounts: Option<AccountsHandle>) -> SessionRoutes {
    SessionRoutes {
        store: store.clone(),
        broadcaster: Broadcaster::new(64),
        json_registry: Arc::new(JsonAgentRegistry::new()),
        direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
        direct_streams: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        tmux: vst_proc::test_support::isolated_tmux(),
        daemon_port: 3999,
        json_unsupported: Arc::new(|_| None),
        subagent_notify: SubagentNotifyHandle::new(),
        attachment_registry: AttachmentRegistry::new(),
        model_catalog: vst_routes::model_catalog::ModelCatalog::default(),
        handoff_timeout: Duration::from_secs(5),
        reset_cancels: vst_routes::sessions::ResetCancels::default(),
        terminal_delivery: vst_routes::terminal_delivery::build_terminal_delivery(
            store.clone(),
            Broadcaster::new(16),
            Arc::new(vst_proc::test_support::isolated_tmux()),
            None,
        ),
        accounts,
    }
}

fn make_project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/tmp/{id}"),
        prefix: "p".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    }
}

fn make_worktree(id: &str) -> WorktreeRecord {
    WorktreeRecord {
        id: id.into(),
        name: Some("wt".into()),
        branch: "wip/wt".into(),
        branch_is_placeholder: Some(false),
        base_branch: "main".into(),
        base_sha: String::new(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: None,
        agent_seq: None,
        lsp_enabled: None,
        sessions: vec![],
        open_files: vec![],
    }
}

#[allow(clippy::too_many_arguments)]
fn session(
    id: &str,
    project_id: &str,
    worktree_id: Option<&str>,
    mode_id: &str,
    channel: Channel,
    account_id: Option<&str>,
) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree_id.map(str::to_string),
        project_id: project_id.into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some(mode_id.into()),
        mode_icon: None,
        account_id: account_id.map(str::to_string),
        name: Some("Agent".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: format!("vst-{id}"),
        use_tmux: channel == Channel::Tmux,
        channel: Some(channel),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
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

async fn add_project(store: &StoreHandle, p: ProjectRecord) {
    store.add_project(p).await.unwrap();
}

fn reset_body() -> ResetBody {
    ResetBody {
        handoff: None,
        prompt: None,
        handoff_text: None,
        mode_id: None,
        channel: None,
        carry_over: None,
        when_busy: Some(WhenBusy::Stop),
        queued: None,
        account_id: None,
    }
}

fn persisted<'a>(p: &'a ProjectRecord, id: &str) -> &'a SessionRecord {
    p.worktrees
        .iter()
        .flat_map(|w| w.sessions.iter())
        .chain(p.direct_sessions.iter())
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("session {id} not persisted"))
}

fn init_git_repo(path: &Path) {
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(path)
            .status()
            .expect("git command failed");
        assert!(status.success(), "git command {args:?} failed");
    };
    run(&["init", "-b", "main"]);
    run(&["config", "user.name", "Test Agent"]);
    run(&["config", "user.email", "test@agent.local"]);
    std::fs::write(path.join("README.md"), "# Test\n").unwrap();
    run(&["add", "README.md"]);
    run(&["commit", "-m", "Initial commit"]);
}

fn channel_modes() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("claude-mode", "Claude", "claude"),
        ("cursor-mode", "Cursor", "cursor"),
        ("omp-mode", "Omp", "omp"),
        ("opencode-mode", "OpenCode", "opencode"),
    ]
}

// ---------------------------------------------------------------------------
// A3.T2 — create / resume account rules
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_session_stamps_account_id() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");

    let mut p = make_project("p1");
    p.worktrees.push(make_worktree("w1"));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let body = serde_json::json!({
        "type": "agent",
        "worktreeId": "w1",
        "modeId": "claude-mode",
        "channel": "json",
        "skipAutoTurn": true,
        "accountId": work,
    });
    let created = r.create_session(&body).await.unwrap();
    let SessionOrDraft::Session(s) = created else {
        panic!("expected a session");
    };
    assert_eq!(s.account_id.as_deref(), Some(work.as_str()));
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(
        persisted(&project, &s.id).account_id.as_deref(),
        Some(work.as_str())
    );
}

#[tokio::test]
async fn create_session_inherits_parent_account() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");

    let parent = session(
        "parent",
        "p1",
        None,
        "claude-mode",
        Channel::Json,
        Some(&work),
    );
    let mut p = make_project("p1");
    p.direct_sessions.push(parent);
    p.worktrees.push(make_worktree("w1"));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    // A subagent in an existing worktree inherits its parent's account
    // (Decision 11; a direct session deliberately has no parent).
    let body = serde_json::json!({
        "type": "agent",
        "worktreeId": "w1",
        "modeId": "claude-mode",
        "channel": "json",
        "skipAutoTurn": true,
        "sourceAgentId": "parent",
    });
    let SessionOrDraft::Session(s) = r.create_session(&body).await.unwrap() else {
        panic!("expected a session");
    };
    assert_eq!(s.account_id.as_deref(), Some(work.as_str()));
}

#[tokio::test]
async fn create_session_account_cli_mismatch_400() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude", "cursor"]);
    let cursor_account = add_account(&accounts, "cursor", "Cursor Work");

    let mut p = make_project("p1");
    p.worktrees.push(make_worktree("w1"));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let body = serde_json::json!({
        "type": "agent",
        "worktreeId": "w1",
        "modeId": "claude-mode",
        "channel": "json",
        "skipAutoTurn": true,
        "accountId": cursor_account,
    });
    let err = r.create_session(&body).await.unwrap_err();
    match err {
        vst_routes::sessions::CreateError::Account(AccountProblem::CliMismatch(id)) => {
            assert_eq!(id, cursor_account);
        }
        other => panic!("expected CliMismatch, got {other:?}"),
    }
}

#[tokio::test]
async fn create_session_signed_out_409() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");
    accounts
        .note_auth("claude", Some(&work), AccountAuth::SignedOut)
        .unwrap();

    let mut p = make_project("p1");
    p.worktrees.push(make_worktree("w1"));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let body = serde_json::json!({
        "type": "agent",
        "worktreeId": "w1",
        "modeId": "claude-mode",
        "channel": "json",
        "skipAutoTurn": true,
        "accountId": work,
    });
    let err = r.create_session(&body).await.unwrap_err();
    assert!(matches!(
        err,
        vst_routes::sessions::CreateError::Account(AccountProblem::SignedOut(_))
    ));
}

#[tokio::test]
async fn create_session_explicit_unknown_account_404() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);

    let mut p = make_project("p1");
    p.worktrees.push(make_worktree("w1"));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let body = serde_json::json!({
        "type": "agent",
        "worktreeId": "w1",
        "modeId": "claude-mode",
        "channel": "json",
        "skipAutoTurn": true,
        "accountId": "acc_deadbeef",
    });
    let err = r.create_session(&body).await.unwrap_err();
    assert!(matches!(
        err,
        vst_routes::sessions::CreateError::Account(AccountProblem::NotFound)
    ));
}

#[tokio::test]
async fn resume_removed_account_409() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "claude-mode",
        Channel::Tmux,
        Some("acc_gone"),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let err = r.resume_session("s1").await.unwrap_err();
    match err {
        ResumeError::Account(AccountProblem::Removed(id)) => assert_eq!(id, "acc_gone"),
        other => panic!("expected Removed, got {other:?}"),
    }
}

/// The account env merge runs at the three spawn sites (resume, restore/toggle,
/// fresh create) and refuses a signed-out account with a typed 409 (R7). A fake
/// plugin cannot be injected into the route structs, so this asserts the merge's
/// observable outcome at each site instead of capturing its env map.
#[tokio::test]
async fn account_env_refuses_signed_out_at_resume_restore_and_fresh() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");
    accounts
        .note_auth("claude", Some(&work), AccountAuth::SignedOut)
        .unwrap();

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "resume-me",
        "p1",
        None,
        "claude-mode",
        Channel::Tmux,
        Some(&work),
    ));
    p.direct_sessions.push(session(
        "toggle-me",
        "p1",
        None,
        "claude-mode",
        Channel::Json,
        Some(&work),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));

    let resume_err = r.resume_session("resume-me").await.unwrap_err();
    assert!(matches!(
        resume_err,
        ResumeError::Account(AccountProblem::SignedOut(_))
    ));

    let toggle_err = r
        .patch_session_channel(
            "toggle-me",
            vst_types::rest::sessions::PatchChannelBody {
                channel: Channel::Tmux,
                mode_id: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        toggle_err,
        vst_routes::sessions::ChannelError::Account(AccountProblem::SignedOut(_))
    ));

    let fresh = r
        .create_session(&serde_json::json!({
            "type": "agent",
            "target": "direct",
            "projectId": "p1",
            "modeId": "claude-mode",
            "channel": "json",
            "skipAutoTurn": true,
            "accountId": work,
        }))
        .await
        .unwrap_err();
    assert!(matches!(
        fresh,
        vst_routes::sessions::CreateError::Account(AccountProblem::SignedOut(_))
    ));
}

// ---------------------------------------------------------------------------
// A3.T2 — reset account rules
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reset_without_account_keeps_account() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "claude-mode",
        Channel::Tmux,
        Some(&work),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let res = r.reset_session("s1", &reset_body()).await.unwrap();
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(
        persisted(&project, &res.new_session_id)
            .account_id
            .as_deref(),
        Some(work.as_str())
    );
    assert!(res.account_switch.is_none());
}

#[tokio::test]
async fn reset_without_account_removed_stored_account_409() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "claude-mode",
        Channel::Tmux,
        Some("acc_gone"),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let err = r.reset_session("s1", &reset_body()).await.unwrap_err();
    assert!(matches!(
        err,
        ResetError::Account(AccountProblem::Removed(_))
    ));
    let project = store.get_project("p1").await.unwrap();
    assert!(persisted(&project, "s1").archived_at.is_none());
}

#[tokio::test]
async fn reset_same_account_by_label_400() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "claude-mode",
        Channel::Tmux,
        Some(&work),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some("Work".to_string());
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(matches!(err, ResetError::AlreadyOnAccount(_)));
}

#[tokio::test]
async fn mode_switch_to_other_cli_uses_that_cli_default() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude", "cursor"]);
    let claude_work = add_account(&accounts, "claude", "Claude Work");
    let cursor_work = add_account(&accounts, "cursor", "Cursor Work");
    accounts.set_default("cursor", &cursor_work).unwrap();

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "claude-mode",
        Channel::Tmux,
        Some(&claude_work),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.mode_id = Some("cursor-mode".to_string());
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Nothing);
    assert!(res.account_switch.is_none(), "no explicit accountId");
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(
        persisted(&project, &res.new_session_id)
            .account_id
            .as_deref(),
        Some(cursor_work.as_str())
    );
}

#[tokio::test]
async fn reset_explicit_carry_nothing_is_fresh() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");
    let home = add_account(&accounts, "claude", "Home");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "claude-mode",
        Channel::Json,
        Some(&work),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(home.clone());
    body.carry_over = Some(CarryOver::Nothing);
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Nothing);
    assert_eq!(res.break_kind, Some(SessionBreakKind::Switch));
    let switch = res.account_switch.expect("explicit switch");
    assert_eq!(switch.from_account_id.as_deref(), Some(work.as_str()));
    assert_eq!(switch.to_account_id.as_deref(), Some(home.as_str()));
    assert_eq!(
        switch.handover,
        vst_types::rest::sessions::AccountSwitchHandover::Fresh
    );
}

#[tokio::test]
async fn reset_account_same_account_400() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "claude-mode",
        Channel::Tmux,
        Some(&work),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(work);
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(matches!(err, ResetError::AlreadyOnAccount(_)));
}

#[tokio::test]
async fn reset_concurrent_account_switch_409() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");
    let home = add_account(&accounts, "claude", "Home");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "claude-mode",
        Channel::Tmux,
        Some(&work),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    // Simulate an in-flight reset (the single-flight guard is per session id).
    let _flag = r.reset_cancels.register("s1").expect("flag");
    let mut body = reset_body();
    body.account_id = Some(home);
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(matches!(err, ResetError::InProgress(_)));
}

#[tokio::test]
async fn reset_account_switch_agent_busy_409() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["cursor"]);
    let work = add_account(&accounts, "cursor", "Work");
    let home = add_account(&accounts, "cursor", "Home");

    let mut s = session("s1", "p1", None, "cursor-mode", Channel::Tmux, Some(&work));
    s.lifecycle.state = LifecycleState::Working;
    let mut p = make_project("p1");
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(home);
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(matches!(err, ResetError::AgentBusy(_)));
}

#[tokio::test]
async fn reset_with_account_native_copies_ids_and_resumes_terminal() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["omp"]);
    let work = add_account(&accounts, "omp", "Work");
    let home = add_account(&accounts, "omp", "Home");

    let mut s = session("s1", "p1", None, "omp-mode", Channel::Tmux, Some(&work));
    s.agent_chat_id = Some("native-chat-1".to_string());
    s.acp_session_id = Some("acp-1".to_string());
    let mut p = make_project("p1");
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(home.clone());
    let res = r.reset_session("s1", &body).await.unwrap();
    let switch = res.account_switch.expect("explicit switch");
    assert_eq!(
        switch.handover,
        vst_types::rest::sessions::AccountSwitchHandover::Native
    );
    let project = store.get_project("p1").await.unwrap();
    let new_rec = persisted(&project, &res.new_session_id);
    assert_eq!(new_rec.account_id.as_deref(), Some(home.as_str()));
    assert_eq!(new_rec.agent_chat_id.as_deref(), Some("native-chat-1"));
    assert_eq!(new_rec.acp_session_id.as_deref(), Some("acp-1"));
}

#[tokio::test]
async fn reset_with_account_transcript_for_unsupported_cli() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["cursor"]);
    let work = add_account(&accounts, "cursor", "Work");
    let home = add_account(&accounts, "cursor", "Home");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "cursor-mode",
        Channel::Json,
        Some(&work),
    ));
    add_project(&store, p).await;
    seed_old_row("p1", "s1");

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(home);
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Transcript);
    let switch = res.account_switch.expect("explicit switch");
    assert_eq!(
        switch.handover,
        vst_types::rest::sessions::AccountSwitchHandover::Transcript
    );
}

#[tokio::test]
async fn reset_account_switch_terminal_writes_no_marker_and_reports_handover() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["cursor"]);
    let work = add_account(&accounts, "cursor", "Work");
    let home = add_account(&accounts, "cursor", "Home");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "cursor-mode",
        Channel::Tmux,
        Some(&work),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(home);
    let res = r.reset_session("s1", &body).await.unwrap();
    // No card exists for a Terminal switch: the UI toasts the hand-over.
    assert_eq!(res.break_kind, Some(SessionBreakKind::Switch));
    assert_eq!(res.carry_over, CarryOver::Nothing);
    let switch = res.account_switch.expect("explicit switch");
    assert_eq!(
        switch.handover,
        vst_types::rest::sessions::AccountSwitchHandover::Fresh
    );
    let project = store.get_project("p1").await.unwrap();
    assert!(persisted(&project, &res.new_session_id)
        .transcript_ref
        .is_none());
}

#[tokio::test]
async fn reset_account_switch_rich_chat_writes_switch_marker() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["omp", "cursor"]);
    let omp_work = add_account(&accounts, "omp", "Omp Work");
    let omp_home = add_account(&accounts, "omp", "Omp Home");

    let mut s = session("s1", "p1", None, "omp-mode", Channel::Json, Some(&omp_work));
    s.agent_chat_id = Some("native-chat-1".to_string());
    let mut p = make_project("p1");
    p.direct_sessions.push(s);
    add_project(&store, p).await;
    seed_old_row("p1", "s1");

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(omp_home.clone());
    let res = r.reset_session("s1", &body).await.unwrap();

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    let marker = carried.last().expect("marker row");
    assert_eq!(marker.kind, NormalizedEventKind::SessionBreak);
    assert_eq!(marker.break_kind, Some(SessionBreakKind::Switch));
    assert_eq!(marker.carry_over, Some(CarryOver::Native));
    assert_eq!(marker.from_account.as_deref(), Some("Omp Work"));
    assert_eq!(marker.to_account.as_deref(), Some("Omp Home"));
}

#[tokio::test]
async fn reset_account_switch_native_rich_chat_opens_without_prompt() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["omp"]);
    let work = add_account(&accounts, "omp", "Work");
    let home = add_account(&accounts, "omp", "Home");

    let mut s = session("s1", "p1", None, "omp-mode", Channel::Json, Some(&work));
    s.agent_chat_id = Some("native-chat-1".to_string());
    let mut p = make_project("p1");
    p.direct_sessions.push(s);
    add_project(&store, p).await;
    seed_old_row("p1", "s1");

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(home);
    let res = r.reset_session("s1", &body).await.unwrap();
    let project = store.get_project("p1").await.unwrap();
    let new_rec = persisted(&project, &res.new_session_id);
    // Native carries no text: the session opens on the copied id, so there is
    // no persisted prompt for a first turn.
    assert_eq!(new_rec.initial_prompt, None);
    assert_eq!(new_rec.agent_chat_id.as_deref(), Some("native-chat-1"));
}

/// Seed the old session's transcript store with one row (the marker carry needs
/// an existing store; an empty dir returns early and writes nothing).
fn seed_old_row(project_id: &str, session_id: &str) {
    let dir = AgentPaths::default().direct_session_data_dir(project_id, session_id);
    let mut store = open_transcript_store(&dir, session_id).unwrap();
    let mut ev = NormalizedEvent {
        session_id: session_id.to_string(),
        kind: NormalizedEventKind::Text,
        text: Some("earlier".into()),
        turn_id: Some("t1".into()),
        ..Default::default()
    };
    store.append(&mut ev);
    store.close();
}

// ---------------------------------------------------------------------------
// A3.T2 — new worktree / new project main sessions
// ---------------------------------------------------------------------------

fn worktree_routes(store: &StoreHandle, accounts: Option<AccountsHandle>) -> WorktreeRoutes {
    WorktreeRoutes::new(
        store.clone(),
        Broadcaster::new(16),
        Arc::new(JsonAgentRegistry::new()),
        vst_proc::test_support::isolated_tmux(),
        3999,
    )
    .with_accounts(accounts)
}

#[tokio::test]
async fn worktree_main_session_uses_cli_default() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let repo = tempdir().unwrap();
    init_git_repo(repo.path());
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.absolute_path = repo.path().to_string_lossy().to_string();
    add_project(&store, p).await;

    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["cursor"]);
    let work = add_account(&accounts, "cursor", "Work");
    accounts.set_default("cursor", &work).unwrap();

    let routes = worktree_routes(&store, Some(accounts));
    let wt = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "p1".into(),
            mode_id: "cursor-mode".into(),
            branch: Some("feature/accounts".into()),
            base_branch: None,
            prompt: Some("do the thing".into()),
            use_tmux: None,
            channel: Some(Channel::Json),
            name: None,
            source_agent_id: None,
            skip_auto_turn: Some(true),
            account_id: None,
        })
        .await
        .expect("worktree created");
    let project = store.get_project("p1").await.unwrap();
    let wt_rec = project
        .worktrees
        .iter()
        .find(|w| w.id == wt.id)
        .expect("persisted worktree");
    assert_eq!(
        wt_rec.sessions[0].account_id.as_deref(),
        Some(work.as_str())
    );
}

#[tokio::test]
async fn worktree_create_with_account_sets_main_session_account() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let repo = tempdir().unwrap();
    init_git_repo(repo.path());
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.absolute_path = repo.path().to_string_lossy().to_string();
    add_project(&store, p).await;

    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["cursor"]);
    let _default = add_account(&accounts, "cursor", "Default");
    let picked = add_account(&accounts, "cursor", "Picked");

    let routes = worktree_routes(&store, Some(accounts));
    let wt = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "p1".into(),
            mode_id: "cursor-mode".into(),
            branch: Some("feature/picked".into()),
            base_branch: None,
            prompt: Some("picked account".into()),
            use_tmux: None,
            channel: Some(Channel::Json),
            name: None,
            source_agent_id: None,
            skip_auto_turn: Some(true),
            account_id: Some(picked.clone()),
        })
        .await
        .expect("worktree created");
    let project = store.get_project("p1").await.unwrap();
    let wt_rec = project
        .worktrees
        .iter()
        .find(|w| w.id == wt.id)
        .expect("persisted worktree");
    assert_eq!(
        wt_rec.sessions[0].account_id.as_deref(),
        Some(picked.as_str())
    );
}

#[tokio::test]
async fn worktree_create_with_signed_out_default_409() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let repo = tempdir().unwrap();
    init_git_repo(repo.path());
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.absolute_path = repo.path().to_string_lossy().to_string();
    add_project(&store, p).await;

    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["cursor"]);
    let work = add_account(&accounts, "cursor", "Work");
    accounts.set_default("cursor", &work).unwrap();
    accounts
        .note_auth("cursor", Some(&work), AccountAuth::SignedOut)
        .unwrap();

    let routes = worktree_routes(&store, Some(accounts));
    let err = routes
        .create_worktree(CreateWorktreeBody {
            project_id: "p1".into(),
            mode_id: "cursor-mode".into(),
            branch: Some("feature/nope".into()),
            base_branch: None,
            prompt: None,
            use_tmux: None,
            channel: Some(Channel::Json),
            name: None,
            source_agent_id: None,
            skip_auto_turn: Some(true),
            account_id: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        WorktreeRouteError::Account(AccountProblem::SignedOut(_))
    ));
}

fn project_routes(store: &StoreHandle, accounts: Option<AccountsHandle>) -> ProjectRoutes {
    ProjectRoutes::new(
        store.clone(),
        Broadcaster::new(16),
        Arc::new(JsonAgentRegistry::new()),
        vst_proc::test_support::isolated_tmux(),
        3999,
    )
    .with_accounts(accounts)
}

#[tokio::test]
async fn new_project_main_session_uses_cli_default() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let parent = tempdir().unwrap();
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["cursor"]);
    let work = add_account(&accounts, "cursor", "Work");
    accounts.set_default("cursor", &work).unwrap();

    let routes = project_routes(&store, Some(accounts));
    let created: CreateNewProjectResult = routes
        .create_new_project(CreateNewProjectBody {
            name: "Accounts Demo".into(),
            dir: Some(parent.path().to_string_lossy().to_string()),
            start_agent: Some(vst_types::rest::projects::StartAgent {
                mode_id: "cursor-mode".into(),
                prompt: Some("hello".into()),
                use_worktree: Some(false),
                branch: None,
            }),
        })
        .await
        .expect("project created");
    let session = created.session.expect("agent session");
    assert_eq!(session.account_id.as_deref(), Some(work.as_str()));
}

#[tokio::test]
async fn new_project_with_signed_out_default_409() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let parent = tempdir().unwrap();
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["cursor"]);
    let work = add_account(&accounts, "cursor", "Work");
    accounts.set_default("cursor", &work).unwrap();
    accounts
        .note_auth("cursor", Some(&work), AccountAuth::SignedOut)
        .unwrap();

    let routes = project_routes(&store, Some(accounts));
    let err = routes
        .create_new_project(CreateNewProjectBody {
            name: "Accounts Demo".into(),
            dir: Some(parent.path().to_string_lossy().to_string()),
            start_agent: Some(vst_types::rest::projects::StartAgent {
                mode_id: "cursor-mode".into(),
                prompt: Some("hello".into()),
                use_worktree: Some(false),
                branch: None,
            }),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        ProjectRouteError::Account(AccountProblem::SignedOut(_))
    ));
}

/// Decision 7: an explicit `carryOver: summary` is the one override that keeps
/// the existing summary path (the hand-over itself is Fresh at file level).
#[tokio::test]
async fn reset_with_account_and_explicit_summary_keeps_summary() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");
    let home = add_account(&accounts, "claude", "Home");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "claude-mode",
        Channel::Json,
        Some(&work),
    ));
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(home);
    body.carry_over = Some(CarryOver::Summary);
    body.handoff_text = Some("the summary the caller wrote".to_string());
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Summary);
    let switch = res.account_switch.expect("explicit switch");
    assert_eq!(
        switch.handover,
        vst_types::rest::sessions::AccountSwitchHandover::Fresh
    );
    let project = store.get_project("p1").await.unwrap();
    let new_rec = persisted(&project, &res.new_session_id);
    assert!(new_rec
        .initial_prompt
        .as_deref()
        .is_some_and(|p| p.contains("the summary the caller wrote")));
}

/// A normal reset (no `accountId`) must NOT take the native hand-over even when
/// the plugin would support one: the replacement starts a fresh conversation
/// and keeps no account-switch metadata.
#[tokio::test]
async fn reset_without_account_does_not_hand_over_natively() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["omp"]);
    let work = add_account(&accounts, "omp", "Work");

    let mut s = session("s1", "p1", None, "omp-mode", Channel::Json, Some(&work));
    s.agent_chat_id = Some("native-chat-1".to_string());
    let mut p = make_project("p1");
    p.direct_sessions.push(s);
    add_project(&store, p).await;
    seed_old_row("p1", "s1");

    let r = routes(&store, Some(accounts));
    let res = r.reset_session("s1", &reset_body()).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Nothing);
    assert!(res.account_switch.is_none());
    let project = store.get_project("p1").await.unwrap();
    let new_rec = persisted(&project, &res.new_session_id);
    assert_eq!(new_rec.account_id.as_deref(), Some(work.as_str()));
    assert_eq!(new_rec.agent_chat_id, None, "no native hand-over");
}

/// A Rich Chat switch with a Transcript hand-over writes a `switch` marker too
/// (cursor has no native bridge).
#[tokio::test]
async fn reset_account_switch_rich_chat_transcript_writes_switch_marker() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["cursor"]);
    let work = add_account(&accounts, "cursor", "Cursor Work");
    let home = add_account(&accounts, "cursor", "Cursor Home");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "cursor-mode",
        Channel::Json,
        Some(&work),
    ));
    add_project(&store, p).await;
    seed_old_row("p1", "s1");

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(home);
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Transcript);

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    let marker = carried.last().expect("marker row");
    assert_eq!(marker.kind, NormalizedEventKind::SessionBreak);
    assert_eq!(marker.break_kind, Some(SessionBreakKind::Switch));
    assert_eq!(marker.carry_over, Some(CarryOver::Transcript));
    assert_eq!(marker.from_account.as_deref(), Some("Cursor Work"));
    assert_eq!(marker.to_account.as_deref(), Some("Cursor Home"));
}

/// `--carry=none` on a Rich Chat account switch still writes the `switch`
/// marker (A9: the card says "started fresh").
#[tokio::test]
async fn reset_account_switch_rich_chat_nothing_writes_switch_marker() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["omp"]);
    let work = add_account(&accounts, "omp", "Work");
    let home = add_account(&accounts, "omp", "Home");

    let mut p = make_project("p1");
    p.direct_sessions.push(session(
        "s1",
        "p1",
        None,
        "omp-mode",
        Channel::Json,
        Some(&work),
    ));
    add_project(&store, p).await;
    seed_old_row("p1", "s1");

    let r = routes(&store, Some(accounts));
    let mut body = reset_body();
    body.account_id = Some(home);
    body.carry_over = Some(CarryOver::Nothing);
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Nothing);

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    let marker = carried.last().expect("marker row");
    assert_eq!(marker.break_kind, Some(SessionBreakKind::Switch));
    assert_eq!(marker.carry_over, Some(CarryOver::Nothing));
    assert_eq!(marker.from_account.as_deref(), Some("Work"));
    assert_eq!(marker.to_account.as_deref(), Some("Home"));
}

#[tokio::test]
async fn start_draft_returns_resolved_account() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");
    accounts.set_default("claude", &work).unwrap();

    let mut draft = session("s-draft", "p1", None, "claude-mode", Channel::Json, None);
    draft.lifecycle.state = LifecycleState::Drafting;
    draft.draft_prompt = Some("initial".into());
    let mut p = make_project("p1");
    p.direct_sessions.push(draft);
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let body = StartDraftBody {
        draft_prompt: "do the thing".into(),
        draft_config: DraftConfig {
            entry_point: DraftEntryPoint::Direct,
            account_id: None,
            mode_id: Some("claude-mode".into()),
            channel: Some(Channel::Json),
            channel_explicit: None,
            worktree_choice: None,
            existing_worktree_id: None,
            branch: None,
            base_branch: None,
            use_tmux: None,
            use_worktree: None,
        },
        skip_auto_turn: Some(true),
        review_comment_ids: None,
    };
    let res = r.start_session("s-draft", &body).await.unwrap();
    assert_eq!(res.account_id.as_deref(), Some(work.as_str()));
}

#[tokio::test]
async fn usage_ignores_superseded_sessions() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["omp"]);
    let work = add_account(&accounts, "omp", "Work");

    let mut old = session("old", "p1", None, "omp-mode", Channel::Tmux, Some(&work));
    old.superseded_by = Some("past".to_string());
    old.archived_at = Some("2026-01-02T00:00:00.000Z".into());
    let mut past = session("past", "p1", None, "omp-mode", Channel::Tmux, Some(&work));
    past.lifecycle.state = LifecycleState::Exited;
    let mut p = make_project("p1");
    p.direct_sessions.push(old);
    p.direct_sessions.push(past);
    add_project(&store, p).await;

    let r = routes(&store, Some(accounts));
    let (usage, stopped) = r.usage_for_account("omp", Some(&work)).await;
    assert_eq!(usage.past_count, 1, "the superseded half is not counted");
    assert!(usage.running.is_empty());
    assert!(stopped.is_empty());
}

// ---------------------------------------------------------------------------
// R2F-01: a Terminal switch reads the plugin's recorded chat id
// ---------------------------------------------------------------------------

/// A project whose path is a temp dir, with one Terminal session `s1` on `mode`.
async fn terminal_fixture(
    store: &StoreHandle,
    mode: &str,
    account: Option<&str>,
) -> tempfile::TempDir {
    let proj_dir = tempdir().unwrap();
    let mut p = make_project("p1");
    p.absolute_path = proj_dir.path().display().to_string();
    p.direct_sessions
        .push(session("s1", "p1", None, mode, Channel::Tmux, account));
    add_project(store, p).await;
    proj_dir
}

fn write_record(proj: &Path, id: &str, chat: &str) -> std::path::PathBuf {
    let dir = proj.join(".vibe-station").join("agent-chat-ids");
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join(id);
    std::fs::write(&f, format!("{chat}\n")).unwrap();
    f
}

fn write_conversation(home: &Path, chat: &str) {
    let dir = home.join(".claude").join("projects").join("-any-slug");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{chat}.jsonl")), "{\"a\":1}\n").unwrap();
}

#[tokio::test]
async fn terminal_switch_reads_the_recorded_chat_id_and_hands_over() {
    let (home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");
    let proj = terminal_fixture(&store, "claude-mode", None).await;
    write_record(proj.path(), "s1", "chat-1");
    write_conversation(home.path(), "chat-1");
    let target_dir = accounts.locate("claude", Some(&work)).unwrap().dir.unwrap();

    let r = routes(&store, Some(accounts));
    let old = store.get_project("p1").await.unwrap().direct_sessions[0].clone();
    let mut body = reset_body();
    body.account_id = Some(work);
    let plan = r.plan_account_switch(&old, &body).await.unwrap();
    assert!(plan.handover_is_native());
    assert_eq!(plan.carry_over(), Some(CarryOver::Native));
    assert_eq!(
        plan.result().unwrap().handover,
        vst_types::rest::sessions::AccountSwitchHandover::Native
    );
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(
        persisted(&project, "s1").agent_chat_id.as_deref(),
        Some("chat-1")
    );

    plan.apply_transfers().unwrap();
    let copied = target_dir.join("projects/-any-slug/chat-1.jsonl");
    assert_eq!(std::fs::read_to_string(copied).unwrap(), "{\"a\":1}\n");
    let mut rec = old.clone();
    plan.finish_record(&mut rec);
    assert_eq!(rec.agent_chat_id.as_deref(), Some("chat-1"));
}

#[tokio::test]
async fn terminal_switch_without_a_conversation_file_starts_fresh() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");
    let proj = terminal_fixture(&store, "claude-mode", None).await;
    write_record(proj.path(), "s1", "chat-1");

    let r = routes(&store, Some(accounts));
    let old = store.get_project("p1").await.unwrap().direct_sessions[0].clone();
    let mut body = reset_body();
    body.account_id = Some(work);
    let plan = r.plan_account_switch(&old, &body).await.unwrap();
    assert!(!plan.handover_is_native());
    assert_eq!(plan.carry_over(), Some(CarryOver::Nothing));
    assert_eq!(
        plan.result().unwrap().handover,
        vst_types::rest::sessions::AccountSwitchHandover::Fresh
    );
}

#[tokio::test]
async fn terminal_switch_without_a_recorded_id_starts_fresh() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let work = add_account(&accounts, "claude", "Work");
    let _proj = terminal_fixture(&store, "claude-mode", None).await;

    let r = routes(&store, Some(accounts));
    let old = store.get_project("p1").await.unwrap().direct_sessions[0].clone();
    let mut body = reset_body();
    body.account_id = Some(work);
    let plan = r.plan_account_switch(&old, &body).await.unwrap();
    assert_eq!(
        plan.result().unwrap().handover,
        vst_types::rest::sessions::AccountSwitchHandover::Fresh
    );
    let project = store.get_project("p1").await.unwrap();
    assert!(persisted(&project, "s1").agent_chat_id.is_none());
}

#[tokio::test]
async fn reset_without_account_never_reads_the_recorded_chat_id() {
    let (home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["claude"]);
    let _work = add_account(&accounts, "claude", "Work");
    let proj = terminal_fixture(&store, "claude-mode", None).await;
    let rec_file = write_record(proj.path(), "s1", "chat-1");
    write_conversation(home.path(), "chat-1");

    let r = routes(&store, Some(accounts));
    let old = store.get_project("p1").await.unwrap().direct_sessions[0].clone();
    let plan = r.plan_account_switch(&old, &reset_body()).await.unwrap();
    assert!(!plan.handover_is_native());
    assert!(rec_file.exists());
    let project = store.get_project("p1").await.unwrap();
    assert!(persisted(&project, "s1").agent_chat_id.is_none());
}

#[tokio::test]
async fn switch_plan_is_not_delayed_for_a_cli_without_native_hand_over() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let root = tempdir().unwrap();
    let accounts = accounts_handle(root.path(), &["opencode"]);
    let a = add_account(&accounts, "opencode", "A");
    let b = add_account(&accounts, "opencode", "B");
    let _proj = terminal_fixture(&store, "opencode-mode", Some(&a)).await;

    let r = routes(&store, Some(accounts));
    let old = store.get_project("p1").await.unwrap().direct_sessions[0].clone();
    let mut body = reset_body();
    body.account_id = Some(b);
    let plan = tokio::time::timeout(Duration::from_secs(1), r.plan_account_switch(&old, &body))
        .await
        .expect("plan must not wait on a capture poll")
        .unwrap();
    assert_eq!(
        plan.result().unwrap().handover,
        vst_types::rest::sessions::AccountSwitchHandover::Fresh
    );
}
