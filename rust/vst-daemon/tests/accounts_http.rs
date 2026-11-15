//! HTTP-level tests for the accounts routes under `/api` and the accounts
//! derivation wiring (multi-account plan A3.T1/A3.T3).
//!
//! Follows `limits_routes_http.rs`: `build_state` + `install_accounts` +
//! `router_from_state`, `tempfile::tempdir()` isolation, no real TCP port, no
//! auth. The registry gets fake identity/support closures, so no credential
//! file, keychain or vendor login is ever touched. The one sign-in test puts a
//! stub `omp` on `PATH` (the A1 spike found omp absent) and asserts the pasted
//! login line ran inside the account folder.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_accounts::{AccountsDeps, AccountsHandle, FolderDeps, FolderSpec, IdentityFn};
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_daemon::accounts_wiring::{check_identity, spawn_derivation_task, IdentityChecker};
use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_state, router_from_state, AppState, BuildServerOptions};
use vst_git::paths::Paths;
use vst_harness_limits::{
    LimitsDeps, LimitsHandle, LimitsTiming, ProbeFn, ProbeTarget, SessionTargetFn, TargetsFn,
};
use vst_proc::tmux::NewSessionOptions;
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::limits::{default_slots, LimitStatus, LimitWindow, LimitsResult, LimitsSnapshot};
use vst_types::{
    AccountAuth, AccountIdentity, AccountLinkMeta, AccountSummary, AccountUsage, LifecycleState,
    ProjectRecord, ResolvedAccount, SessionLifecycle, SessionNameSource, SessionRecord,
    SessionType, SignInState, SignInSteps, WorktreeRecord,
};

/// Serializes the tests that set the isolated tmux server's global `default-command`.
static PATH_LOCK: Mutex<()> = Mutex::new(());

fn limits_handle() -> LimitsHandle {
    let broadcaster = Broadcaster::new(16);
    let targets: TargetsFn = Arc::new(|| vec![ProbeTarget::system("claude")]);
    let probe: ProbeFn = Arc::new(|_| {
        let r = LimitsResult {
            harness: "claude".to_string(),
            account_id: None,
            status: LimitStatus::Ok,
            message: None,
            as_of: "2026-10-11T00:00:00.000Z".to_string(),
            windows: vec![LimitWindow::placeholder(
                "claude",
                "five_hour",
                Some(300),
                LimitStatus::Ok,
                "2026-10-11T00:00:00.000Z",
            )],
        };
        Box::pin(async move { r })
    });
    let session_target: SessionTargetFn = Arc::new(|_| Box::pin(async { None }));
    LimitsHandle::new(LimitsDeps {
        broadcaster,
        targets,
        probe,
        session_target,
        host: "test".to_string(),
        initial_slots: default_slots(),
        timing: LimitsTiming::default(),
    })
}

fn opts_for(tmp: &Path, store: StoreHandle) -> BuildServerOptions {
    BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: None,
        no_auth: true,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster: Broadcaster::new(256),
        json_registry: Arc::new(JsonAgentRegistry::<JsonAgentSession>::new()),
        tmux: vst_proc::test_support::isolated_tmux(),
        started_at: Instant::now(),
        update: vst_daemon::update::UpdateService::for_tests(tmp),
        version: "test".to_string(),
        paths: Paths::with_home(tmp.join(".vibe-station")),
        limits: limits_handle(),
    }
}

/// Folder support for the fake registry (`verifies` = the CLI confirms sign-in
/// itself; pi/omp cannot). The System folder is `<home>/sys`; sign-in steps
/// name the account folder.
fn folder_support(home: &Path, verifies: bool) -> FolderDeps {
    let sys = home.join("sys");
    FolderDeps {
        home: home.to_path_buf(),
        link_meta: Arc::new(move |_| {
            Some(AccountLinkMeta {
                example_path: "~/accounts/claude/work".into(),
                field_label: "Claude config folder".into(),
                field_note: None,
                system_dir: Some(sys.clone()),
                verifies_identity: verifies,
                first_run_note: None,
            })
        }),
        looks_valid: Arc::new(|_, _| true),
        sign_in_steps: Arc::new(|acct| SignInSteps {
            command: Some(format!(
                "FAKE={} fake login",
                acct.dir
                    .as_ref()
                    .map_or_else(String::new, |d| d.display().to_string())
            )),
            hint: None,
        }),
    }
}

/// A registry over `root` supporting exactly `supported`, with folder support
/// rooted at `root`'s parent (the home folder in these tests).
fn fake_accounts(
    root: &Path,
    supported: &[&str],
    identity: IdentityFn,
    verifies: bool,
) -> AccountsHandle {
    let supported: Vec<String> = supported.iter().map(|s| (*s).to_owned()).collect();
    let home = root.parent().unwrap_or(root);
    AccountsHandle::new(AccountsDeps {
        root: root.to_path_buf(),
        broadcaster: Broadcaster::new(64),
        identity,
        shared_entries: Arc::new(|_| None),
        supports: Arc::new(move |cli| supported.iter().any(|s| s == cli)),
    })
    .with_folder_support(folder_support(home, verifies))
}

fn signed_in_identity() -> IdentityFn {
    Arc::new(|_| {
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(true),
                email: Some("work@example.com".to_string()),
                plan: Some("Max".to_string()),
            }
        })
    })
}

/// A state with the registry installed, ready for `router_from_state`.
fn state_with(tmp: &Path, store: StoreHandle, accounts: AccountsHandle) -> AppState {
    let mut state = build_state(opts_for(tmp, store));
    state.install_accounts(accounts);
    state
}

fn write_modes(home: &Path) {
    let dir = home.join(".vibe-station");
    std::fs::create_dir_all(&dir).unwrap();
    let modes = serde_json::json!([{
        "id": "claude-mode",
        "name": "Claude",
        "cli": "claude",
        "context": "",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "model": null
    }]);
    std::fs::write(dir.join("modes.json"), modes.to_string()).unwrap();
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
        worktrees: vec![WorktreeRecord {
            id: "w1".into(),
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
        }],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    }
}

fn agent_session(id: &str, account_id: &str, tmux_name: &str, archived: bool) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: Some("w1".into()),
        project_id: "p1".into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("claude-mode".into()),
        mode_icon: None,
        account_id: Some(account_id.to_string()),
        name: Some("Agent".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: tmux_name.into(),
        use_tmux: true,
        channel: Some(vst_types::Channel::Tmux),
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
        initial_prompt: None,
        draft_prompt: None,
        draft_config: None,
        archived_at: archived.then(|| "2026-01-02T00:00:00.000Z".to_string()),
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

async fn send_json(
    router: &axum::Router,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let resp = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .method(method)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

async fn get(router: &axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let resp = router
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

async fn delete(router: &axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let resp = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .method("DELETE")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

// ---------------------------------------------------------------------------
// A3.T1 — the REST contract
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_accounts_includes_system_row_per_cli() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude", "omp"],
        signed_in_identity(),
        true,
    );
    // Production seeds the System rows at boot (Decision 12).
    for cli in ["claude", "omp"] {
        let identity = AccountIdentity {
            signed_in: Some(true),
            email: None,
            plan: None,
        };
        accounts.note_identity(cli, None, &identity).unwrap();
    }
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = get(&router, "/api/accounts").await;
    assert_eq!(status, StatusCode::OK);
    let accounts: Vec<AccountSummary> = serde_json::from_value(body["accounts"].clone()).unwrap();
    assert_eq!(accounts.len(), 2);
    assert!(accounts.iter().all(|a| a.id == "system"));
    assert!(accounts.iter().any(|a| a.cli == "claude"));
    assert!(accounts.iter().any(|a| a.cli == "omp"));
}

#[tokio::test]
async fn create_api_key_account_never_echoes_key() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude"],
        signed_in_identity(),
        true,
    );
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts",
        serde_json::json!({
            "cli": "claude",
            "method": "api_key",
            "apiKey": "sk-secret-value",
            "label": "Work",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["label"], serde_json::json!("Work"));
    assert_eq!(body["method"], serde_json::json!("api_key"));
    assert!(
        !body.to_string().contains("sk-secret-value"),
        "the API key must never be echoed"
    );
}

#[tokio::test]
async fn create_api_key_requires_label() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude"],
        signed_in_identity(),
        true,
    );
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts",
        serde_json::json!({
            "cli": "claude",
            "method": "api_key",
            "apiKey": "sk-x",
            "label": "   ",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], serde_json::json!("label_required"));
}

#[tokio::test]
async fn rename_label_taken_409() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude"],
        signed_in_identity(),
        true,
    );
    let first = accounts.add_api_key("claude", "sk-1", "First").unwrap();
    let second = accounts.add_api_key("claude", "sk-2", "Second").unwrap();
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = send_json(
        &router,
        "PATCH",
        &format!("/api/accounts/claude/{}", second.id),
        serde_json::json!({ "label": first.label }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], serde_json::json!("label_taken"));
}

#[tokio::test]
async fn set_default_signed_out_409() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude"],
        signed_in_identity(),
        true,
    );
    let work = accounts.add_api_key("claude", "sk-1", "Work").unwrap();
    accounts
        .note_auth("claude", Some(&work.id), AccountAuth::SignedOut)
        .unwrap();
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = send_json(
        &router,
        "PUT",
        "/api/accounts/claude/default",
        serde_json::json!({ "accountId": work.id }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], serde_json::json!("account_signed_out"));
    assert_eq!(body["accountId"], serde_json::json!(work.id));
}

#[tokio::test]
async fn delete_system_400() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude"],
        signed_in_identity(),
        true,
    );
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = delete(&router, "/api/accounts/claude/system").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], serde_json::json!("cannot_remove_system"));
}

#[tokio::test]
async fn delete_account_stops_sessions_and_removes_folder() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let root = tmp.path().join("accounts");
    let accounts = fake_accounts(&root, &["claude"], signed_in_identity(), true);
    let work = accounts.add_api_key("claude", "sk-1", "Work").unwrap();

    // One live tmux session under that account.
    let mut p = make_project("p1");
    p.worktrees[0]
        .sessions
        .push(agent_session("s1", &work.id, "acct-test-1", false));
    store.add_project(p).await.unwrap();

    let state = state_with(tmp.path(), store.clone(), accounts.clone());
    let tmux = state.session_routes.tmux.clone();
    tmux.new_session(&NewSessionOptions {
        name: "acct-test-1".to_string(),
        cwd: Some(tmp.path().to_path_buf()),
        env: std::collections::HashMap::new(),
        command: Some(vec!["sleep".into(), "300".into()]),
        remain_on_exit: false,
    })
    .unwrap();
    assert!(tmux.has_session("acct-test-1"));
    let router = router_from_state(state);

    let (status, body) = delete(&router, &format!("/api/accounts/claude/{}", work.id)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], serde_json::json!(true));
    let stopped: Vec<String> = serde_json::from_value(body["stoppedSessionIds"].clone()).unwrap();
    assert_eq!(stopped, vec!["s1".to_string()]);
    assert!(!tmux.has_session("acct-test-1"), "the runtime was released");
    assert!(
        !root.join("claude").join(&work.id).exists(),
        "the account folder is gone"
    );
}

#[tokio::test]
async fn usage_counts_running_and_past() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude"],
        signed_in_identity(),
        true,
    );
    let work = accounts.add_api_key("claude", "sk-1", "Work").unwrap();

    let mut p = make_project("p1");
    p.worktrees[0]
        .sessions
        .push(agent_session("running", &work.id, "acct-u-1", false));
    p.worktrees[0]
        .sessions
        .push(agent_session("past", &work.id, "acct-u-2", true));
    let mut exited = agent_session("exited", &work.id, "acct-u-3", false);
    exited.lifecycle.state = LifecycleState::Exited;
    p.worktrees[0].sessions.push(exited);
    store.add_project(p).await.unwrap();
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = get(&router, &format!("/api/accounts/claude/{}/usage", work.id)).await;
    assert_eq!(status, StatusCode::OK);
    let usage: AccountUsage = serde_json::from_value(body).unwrap();
    assert_eq!(usage.running.len(), 1);
    assert_eq!(usage.running[0].id, "running");
    assert_eq!(usage.past_count, 2, "archived and exited are both past");
}

// ---------------------------------------------------------------------------
// A3.T1 — sign-in flows
// ---------------------------------------------------------------------------

/// Put a stub `omp` on PATH that records that the pasted login line ran.
fn stub_omp(bin_dir: &Path) -> PathBuf {
    std::fs::create_dir_all(bin_dir).unwrap();
    let script = bin_dir.join("omp");
    std::fs::write(&script, "#!/bin/sh\n: > \"$PI_CODING_AGENT_DIR/omp-ran\"\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[tokio::test]
async fn signin_start_invalid_label_400() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["omp"],
        signed_in_identity(),
        true,
    );
    let mut p = make_project("p1");
    p.worktrees[0].sessions.clear();
    store.add_project(p).await.unwrap();
    let router = router_from_state(state_with(tmp.path(), store.clone(), accounts));

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts/sign-in",
        serde_json::json!({ "cli": "omp", "worktreeId": "w1", "label": "x".repeat(41) }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "label_required");
    let project = store.get_project("p1").await.unwrap();
    assert!(
        project.worktrees[0].sessions.is_empty(),
        "no session created"
    );
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn signin_start_creates_terminal_and_pastes_login_line() {
    let _path_guard = PATH_LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let bin = tmp.path().join("bin");
    stub_omp(&bin);
    vst_proc::test_support::use_plain_shell(&vst_proc::test_support::isolated_tmux(), &bin);

    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["omp"],
        signed_in_identity(),
        true,
    );
    let mut p = make_project("p1");
    p.worktrees[0].sessions.clear();
    store.add_project(p).await.unwrap();
    let router = router_from_state(state_with(tmp.path(), store.clone(), accounts.clone()));

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts/sign-in",
        serde_json::json!({ "cli": "omp", "worktreeId": "w1", "label": "Work" }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let session_id = body["sessionId"].as_str().unwrap().to_string();
    let account_id = body["accountId"].as_str().unwrap().to_string();

    // The login Terminal exists in the store.
    let project = store.get_project("p1").await.unwrap();
    let terminal = project.worktrees[0]
        .sessions
        .iter()
        .find(|s| s.id == session_id)
        .expect("login Terminal session");
    assert_eq!(terminal.r#type, SessionType::Terminal);
    assert_eq!(terminal.name.as_deref(), Some("Sign in: Work"));

    // The pasted line ran the stub inside the account folder.
    let marker = tmp
        .path()
        .join("accounts")
        .join("omp")
        .join(&account_id)
        .join("omp-ran");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !marker.exists() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(marker.exists(), "the login line was pasted and executed");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn resignin_system_login_is_accepted() {
    let _path_guard = PATH_LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let bin = tmp.path().join("bin");
    stub_omp(&bin);
    vst_proc::test_support::use_plain_shell(&vst_proc::test_support::isolated_tmux(), &bin);

    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["omp"],
        signed_in_identity(),
        true,
    );
    let mut p = make_project("p1");
    p.worktrees[0].sessions.clear();
    store.add_project(p).await.unwrap();
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts/omp/system/sign-in",
        serde_json::json!({ "worktreeId": "w1" }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["accountId"], "system");

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts/omp/acc_missing/sign-in",
        serde_json::json!({ "worktreeId": "w1" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "account_not_found", "{body}");
}

#[tokio::test]
async fn refresh_api_key_account_stays_usable() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let identity: IdentityFn = Arc::new(|_| {
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(false),
                email: None,
                plan: None,
            }
        })
    });
    let accounts = fake_accounts(&tmp.path().join("accounts"), &["claude"], identity, true);
    let work = accounts.add_api_key("claude", "sk-1", "Work").unwrap();
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = send_json(
        &router,
        "POST",
        &format!("/api/accounts/claude/{}/refresh", work.id),
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["auth"], "unknown");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn signin_cancel_removes_folder() {
    let _path_guard = PATH_LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let bin = tmp.path().join("bin");
    stub_omp(&bin);
    vst_proc::test_support::use_plain_shell(&vst_proc::test_support::isolated_tmux(), &bin);

    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["omp"],
        signed_in_identity(),
        true,
    );
    let mut p = make_project("p1");
    p.worktrees[0].sessions.clear();
    store.add_project(p).await.unwrap();
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts/sign-in",
        serde_json::json!({ "cli": "omp", "worktreeId": "w1" }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let attempt_id = body["attemptId"].as_str().unwrap().to_string();
    let account_id = body["accountId"].as_str().unwrap().to_string();
    let folder = tmp.path().join("accounts").join("omp").join(&account_id);
    assert!(folder.exists(), "begin_sign_in makes the folder");

    let (status, body) = delete(&router, &format!("/api/accounts/sign-in/{attempt_id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], serde_json::json!(true));
    assert!(!folder.exists(), "cancelling removes the half-made folder");
}

#[tokio::test]
async fn signin_duplicate_event() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let broadcaster = Broadcaster::new(16);
    let identity: IdentityFn = Arc::new(|_| {
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(true),
                email: Some("dup@example.com".to_string()),
                plan: None,
            }
        })
    });
    let accounts = AccountsHandle::new(AccountsDeps {
        root: tmp.path().join("accounts"),
        broadcaster: broadcaster.clone(),
        identity,
        shared_entries: Arc::new(|_| None),
        supports: Arc::new(|cli| cli == "claude"),
    })
    .with_folder_support(folder_support(tmp.path(), true));
    // The System login already uses that email.
    accounts
        .note_identity(
            "claude",
            None,
            &AccountIdentity {
                signed_in: Some(true),
                email: Some("dup@example.com".to_string()),
                plan: None,
            },
        )
        .unwrap();
    let mut rx = broadcaster.subscribe();
    let started = accounts
        .begin_sign_in("claude", "sess-login", Some("Second"))
        .unwrap();
    let state = accounts.on_login_exited(&started.attempt_id).await.unwrap();
    assert_eq!(state, SignInState::Duplicate);
    let mut duplicate = false;
    while let Ok(event) = rx.try_recv() {
        if let ServerEvent::AccountSignin {
            attempt_id,
            state: SignInState::Duplicate,
            ..
        } = event
        {
            assert_eq!(attempt_id, started.attempt_id);
            duplicate = true;
        }
    }
    assert!(duplicate, "account:signin duplicate is broadcast");
    // The half-made record is gone.
    assert!(accounts
        .locate("claude", Some(&started.account_id))
        .is_none());
}

#[tokio::test(start_paused = true)]
async fn signin_expired_event() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let broadcaster = Broadcaster::new(16);
    let identity: IdentityFn = Arc::new(|_| Box::pin(async { AccountIdentity::default() }));
    let accounts = AccountsHandle::new(AccountsDeps {
        root: tmp.path().join("accounts"),
        broadcaster: broadcaster.clone(),
        identity,
        shared_entries: Arc::new(|_| None),
        supports: Arc::new(|cli| cli == "claude"),
    })
    .with_folder_support(folder_support(tmp.path(), true));
    let mut rx = broadcaster.subscribe();
    let started = accounts
        .begin_sign_in("claude", "sess-login", Some("Work"))
        .unwrap();
    // Let the expiry task register its sleep BEFORE moving the paused clock,
    // otherwise its deadline is computed from the already-advanced time.
    let mut expired = false;
    for _ in 0..200 {
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(60)).await;
        while let Ok(event) = rx.try_recv() {
            if let ServerEvent::AccountSignin {
                attempt_id,
                state: SignInState::Expired,
                ..
            } = event
            {
                assert_eq!(attempt_id, started.attempt_id);
                expired = true;
            }
        }
        if expired {
            break;
        }
    }
    assert!(expired, "the attempt expires after 15 minutes");
    assert!(
        !tmp.path()
            .join("accounts")
            .join("claude")
            .join(&started.account_id)
            .exists(),
        "an expired attempt's folder is removed"
    );
}

// ---------------------------------------------------------------------------
// A3.T3 — derivation: limited state, identity checks, sign-out
// ---------------------------------------------------------------------------

/// A live tmux session named after `s` (so a halt is observable).
fn start_live(state: &AppState, s: &SessionRecord) {
    state
        .session_routes
        .tmux
        .new_session(&NewSessionOptions {
            name: s.tmux_name.clone(),
            cwd: Some(std::env::temp_dir()),
            env: std::collections::HashMap::new(),
            command: Some(vec!["sleep".into(), "300".into()]),
            remain_on_exit: false,
        })
        .unwrap();
}

fn limits_with(
    harness: &str,
    account_id: Option<&str>,
    used: f64,
    status: LimitStatus,
) -> LimitsSnapshot {
    LimitsSnapshot {
        host: "test".to_string(),
        slots: default_slots(),
        harnesses: vec![LimitsResult {
            harness: harness.to_string(),
            account_id: account_id.map(str::to_string),
            status,
            message: None,
            as_of: "2026-10-11T00:00:00.000Z".to_string(),
            windows: vec![LimitWindow {
                harness: harness.to_string(),
                window_id: "five_hour".to_string(),
                account_id: account_id.map(str::to_string),
                cadence_minutes: Some(300),
                used_pct: Some(used),
                resets_at: Some("2999-01-01T00:00:00Z".to_string()),
                as_of: "2026-10-11T00:00:00.000Z".to_string(),
                status,
                label: None,
                dollars: None,
            }],
        }],
    }
}

#[tokio::test]
async fn limits_signed_out_read_alone_never_halts() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude"],
        signed_in_identity(),
        true,
    );
    let work = accounts.add_api_key("claude", "sk-1", "Work").unwrap();
    accounts
        .note_auth("claude", Some(&work.id), AccountAuth::SignedIn)
        .unwrap();

    let mut p = make_project("p1");
    p.worktrees[0]
        .sessions
        .push(agent_session("s1", &work.id, "acct-halt-1", false));
    store.add_project(p).await.unwrap();

    let state = state_with(tmp.path(), store, accounts.clone());
    start_live(&state, &agent_session("s1", &work.id, "acct-halt-1", false));
    let checker = IdentityChecker::new(accounts.clone(), state.session_routes.clone());

    // A limits read says signed out; the identity command says signed in.
    vst_daemon::accounts_wiring::on_limits_updated(
        &checker,
        &accounts,
        &limits_with("claude", Some(&work.id), 0.0, LimitStatus::SignedOut),
    )
    .await;

    let summary = accounts
        .list()
        .into_iter()
        .find(|a| a.id == work.id)
        .unwrap();
    assert_eq!(summary.auth, AccountAuth::SignedIn);
    assert!(
        state.session_routes.tmux.has_session("acct-halt-1"),
        "a limits read alone never halts"
    );
}

/// A signed-in sign-in (non-API-key) account, set up the way the sign-in flow does.
async fn sign_in_account(accounts: &AccountsHandle, cli: &str, label: &str) -> AccountSummary {
    let attempt = accounts.begin_sign_in(cli, "sess", Some(label)).unwrap();
    accounts.on_login_exited(&attempt.attempt_id).await.unwrap();
    accounts
        .finish_sign_in(&attempt.attempt_id, Some(label))
        .await
        .unwrap()
}

#[tokio::test]
async fn identity_signed_out_halts_account_sessions_without_lifecycle_write() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    // Signed in while the account is set up, flipped to signed out before the check.
    let signed_in = Arc::new(AtomicBool::new(true));
    let flag = signed_in.clone();
    let identity: IdentityFn = Arc::new(move |_| {
        let signed_in = flag.load(Ordering::SeqCst);
        Box::pin(async move {
            AccountIdentity {
                signed_in: Some(signed_in),
                email: None,
                plan: None,
            }
        })
    });
    let accounts = fake_accounts(&tmp.path().join("accounts"), &["claude"], identity, true);
    let work = sign_in_account(&accounts, "claude", "Work").await;
    signed_in.store(false, Ordering::SeqCst);

    let mut p = make_project("p1");
    p.worktrees[0]
        .sessions
        .push(agent_session("s1", &work.id, "acct-halt-2", false));
    store.add_project(p).await.unwrap();

    let state = state_with(tmp.path(), store.clone(), accounts.clone());
    start_live(&state, &agent_session("s1", &work.id, "acct-halt-2", false));

    check_identity(&accounts, &state.session_routes, "claude", Some(&work.id)).await;

    assert!(!state.session_routes.tmux.has_session("acct-halt-2"));
    let project = store.get_project("p1").await.unwrap();
    let stored = &project.worktrees[0].sessions[0];
    assert_eq!(
        stored.lifecycle.state,
        LifecycleState::Idle,
        "sign-out releases the runtime, never the lifecycle axis"
    );
}

#[tokio::test]
async fn system_login_sessions_are_never_halted() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let identity: IdentityFn = Arc::new(|_| {
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(false),
                email: None,
                plan: None,
            }
        })
    });
    let accounts = fake_accounts(&tmp.path().join("accounts"), &["claude"], identity, true);
    // A System-login session (account_id None).
    let mut s = agent_session("s1", "system", "acct-halt-3", false);
    s.account_id = None;
    let mut p = make_project("p1");
    p.worktrees[0].sessions.push(s);
    store.add_project(p).await.unwrap();

    let state = state_with(tmp.path(), store, accounts.clone());
    let live = agent_session("s1", "system", "acct-halt-3", false);
    start_live(&state, &live);

    let summary = check_identity(&accounts, &state.session_routes, "claude", None)
        .await
        .expect("System identity");
    assert_eq!(summary.auth, AccountAuth::SignedOut);
    assert!(
        state.session_routes.tmux.has_session("acct-halt-3"),
        "the System login is never auto-halted"
    );
}

#[tokio::test]
async fn system_signed_out_shows_banner_state_without_halt() {
    // Same rule as above, asserted through the row the banner reads.
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let identity: IdentityFn = Arc::new(|_| {
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(false),
                email: None,
                plan: None,
            }
        })
    });
    let accounts = fake_accounts(&tmp.path().join("accounts"), &["claude"], identity, true);
    let state = state_with(tmp.path(), store, accounts.clone());
    let summary = check_identity(&accounts, &state.session_routes, "claude", None)
        .await
        .unwrap();
    assert_eq!(summary.id, "system");
    assert_eq!(summary.auth, AccountAuth::SignedOut);
}

#[tokio::test]
async fn limit_derivation_sets_and_clears_limited() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude"],
        signed_in_identity(),
        true,
    );
    let work = accounts.add_api_key("claude", "sk-1", "Work").unwrap();
    let state = state_with(tmp.path(), store, accounts.clone());
    let checker = IdentityChecker::new(accounts.clone(), state.session_routes.clone());

    vst_daemon::accounts_wiring::on_limits_updated(
        &checker,
        &accounts,
        &limits_with("claude", Some(&work.id), 100.0, LimitStatus::Ok),
    )
    .await;
    let limited = accounts
        .list()
        .into_iter()
        .find(|a| a.id == work.id)
        .unwrap()
        .limited
        .expect("limited");
    assert_eq!(limited.window_id, "five_hour");

    vst_daemon::accounts_wiring::on_limits_updated(
        &checker,
        &accounts,
        &limits_with("claude", Some(&work.id), 12.0, LimitStatus::Ok),
    )
    .await;
    assert!(accounts
        .list()
        .into_iter()
        .find(|a| a.id == work.id)
        .unwrap()
        .limited
        .is_none());
}

#[tokio::test]
async fn system_identity_checked_on_boot_and_after_signin() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let calls = Arc::new(AtomicU64::new(0));
    let identity: IdentityFn = {
        let calls = calls.clone();
        Arc::new(move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { AccountIdentity::default() })
        })
    };
    let broadcaster = Broadcaster::new(64);
    let accounts = AccountsHandle::new(AccountsDeps {
        root: tmp.path().join("accounts"),
        broadcaster: broadcaster.clone(),
        identity,
        shared_entries: Arc::new(|_| None),
        supports: Arc::new(|cli| cli == "claude"),
    })
    .with_folder_support(folder_support(tmp.path(), true));
    let state = state_with(tmp.path(), store, accounts.clone());
    let task = spawn_derivation_task(
        accounts.clone(),
        broadcaster.clone(),
        state.session_routes.clone(),
    );

    // Boot: one System check for the supported CLI.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && calls.load(Ordering::SeqCst) < 1 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "boot checks the System row"
    );

    // After a finished sign-in: one more.
    broadcaster.send(ServerEvent::AccountSignin {
        attempt_id: "att_x".to_string(),
        cli: "claude".to_string(),
        account_id: "acc_1".to_string(),
        state: SignInState::Done,
        email: None,
        plan: None,
        message: None,
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && calls.load(Ordering::SeqCst) < 2 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    task.abort();
}

#[tokio::test]
async fn identity_check_runs_only_on_status_change_and_never_concurrently() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    write_modes(tmp.path());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let calls = Arc::new(AtomicU64::new(0));
    let identity: IdentityFn = {
        let calls = calls.clone();
        Arc::new(move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                AccountIdentity::default()
            })
        })
    };
    let accounts = fake_accounts(&tmp.path().join("accounts"), &["claude"], identity, true);
    let state = state_with(tmp.path(), store, accounts.clone());
    let checker = IdentityChecker::new(accounts.clone(), state.session_routes.clone());

    // Same status twice: one identity run.
    let _ = checker
        .check_on_status("claude", None, LimitStatus::NoPlanLimits)
        .await;
    let _ = checker
        .check_on_status("claude", None, LimitStatus::NoPlanLimits)
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Two concurrent triggers: one runs, the other is dropped.
    let a = checker.check("claude", None);
    let b = checker.check("claude", None);
    let (ra, rb) = tokio::join!(a, b);
    assert!(ra.is_some() ^ rb.is_some(), "exactly one runs");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

// ---------------------------------------------------------------------------
// A2c.T2 — folder routes, refresh, delete, secrets, legacy registry
// ---------------------------------------------------------------------------

/// The identity of a folder account reads `signed_in` at call time and reports
/// a work email; the System login reports none, so it never duplicates one.
fn identity_flag(signed_in: Arc<AtomicBool>) -> IdentityFn {
    Arc::new(move |acct: ResolvedAccount| {
        let on = signed_in.load(Ordering::SeqCst);
        Box::pin(async move {
            AccountIdentity {
                signed_in: Some(on),
                email: acct.id.map(|_| "work@example.com".to_string()),
                plan: None,
            }
        })
    })
}

/// A canonical home, so display paths compare exactly on every platform.
fn canonical(p: &Path) -> PathBuf {
    p.canonicalize().unwrap()
}

/// Modes, a folder-supporting `claude` registry rooted at `home/accounts`, and
/// a router over it. Returns the registry, the router and the sign-in flag.
fn folder_env(
    home: &Path,
    verifies: bool,
    signed_in: bool,
) -> (AccountsHandle, axum::Router, Arc<AtomicBool>) {
    write_modes(home);
    let flag = Arc::new(AtomicBool::new(signed_in));
    let accounts = fake_accounts(
        &home.join("accounts"),
        &["claude"],
        identity_flag(flag.clone()),
        verifies,
    );
    let store = StoreHandle::open(home.join("t.db")).unwrap();
    let router = router_from_state(state_with(home, store, accounts.clone()));
    (accounts, router, flag)
}

/// `POST /api/accounts/folder` with a `choose` folder.
async fn add_chosen(router: &axum::Router, dir: &Path) -> (StatusCode, serde_json::Value) {
    send_json(
        router,
        "POST",
        "/api/accounts/folder",
        serde_json::json!({ "cli": "claude", "mode": "choose", "dir": dir.display().to_string() }),
    )
    .await
}

/// True when this process can read a folder it was just made unreadable for
/// (root), so the permission-based refusal test must skip.
fn is_root_like(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok()
}

#[tokio::test]
async fn validate_path_eight_refusal_codes_and_messages() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (accounts, router, _) = folder_env(&home, false, true);
    std::fs::create_dir_all(home.join("sys")).unwrap();
    std::fs::create_dir_all(home.join("accounts/claude/stray")).unwrap();
    std::fs::write(home.join("file.txt"), "x").unwrap();
    std::fs::create_dir_all(home.join("dupe")).unwrap();
    std::fs::create_dir_all(home.join("outer/inner/deeper")).unwrap();
    let dup = accounts
        .add_folder(
            "claude",
            FolderSpec::Choose(home.join("dupe").display().to_string()),
            None,
        )
        .await
        .unwrap();
    let inner = accounts
        .add_folder(
            "claude",
            FolderSpec::Choose(home.join("outer/inner").display().to_string()),
            None,
        )
        .await
        .unwrap();

    let cases: Vec<(String, u16, &str, String)> = vec![
        (
            "relative/path".into(),
            400,
            "path_invalid",
            "Enter a full path, or one starting with ~, without \"..\".".into(),
        ),
        (
            home.display().to_string(),
            400,
            "path_invalid",
            "Choose a more specific folder. This one contains your home or login folders.".into(),
        ),
        (
            home.join("missing").display().to_string(),
            404,
            "folder_not_found",
            "Folder not found.".into(),
        ),
        (
            home.join("file.txt").display().to_string(),
            400,
            "folder_not_directory",
            "That is a file, not a folder.".into(),
        ),
        (
            home.join("sys").display().to_string(),
            409,
            "folder_is_system",
            "That is your system login folder; it is already the default account.".into(),
        ),
        (
            home.join("accounts/claude/stray").display().to_string(),
            409,
            "folder_in_accounts_root",
            "That folder is managed by vibe-station.".into(),
        ),
        (
            home.join("dupe").display().to_string(),
            409,
            "folder_duplicate",
            format!("Already added as {}.", dup.display_name),
        ),
        (
            home.join("outer").display().to_string(),
            409,
            "folder_nested",
            format!(
                "This folder contains the folder of \"{}\".",
                inner.display_name
            ),
        ),
        (
            home.join("outer/inner/deeper").display().to_string(),
            409,
            "folder_nested",
            format!(
                "This folder is inside the folder of \"{}\".",
                inner.display_name
            ),
        ),
    ];
    for (dir, status, code, message) in cases {
        let (got, body) = send_json(
            &router,
            "POST",
            "/api/accounts/validate-path",
            serde_json::json!({ "cli": "claude", "mode": "choose", "dir": dir }),
        )
        .await;
        assert_eq!(got.as_u16(), status, "{code} status for {dir}");
        assert_eq!(body["code"], serde_json::json!(code), "{code} code");
        assert_eq!(body["error"], serde_json::json!(message), "{code} text");
    }
    let (_, body) = send_json(
        &router,
        "POST",
        "/api/accounts/validate-path",
        serde_json::json!({ "cli": "claude", "mode": "choose", "dir": home.join("dupe").display().to_string() }),
    )
    .await;
    assert_eq!(
        body["accountId"],
        serde_json::json!(dup.id),
        "folder_duplicate names the owner"
    );

    // folder_unreadable: 403 (skipped where the test runs as root).
    let locked = home.join("locked");
    std::fs::create_dir_all(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    if !is_root_like(&locked) {
        let (got, body) = send_json(
            &router,
            "POST",
            "/api/accounts/validate-path",
            serde_json::json!({ "cli": "claude", "mode": "choose", "dir": locked.display().to_string() }),
        )
        .await;
        assert_eq!(got, StatusCode::FORBIDDEN);
        assert_eq!(body["code"], serde_json::json!("folder_unreadable"));
        assert_eq!(
            body["error"],
            serde_json::json!("This folder cannot be read.")
        );
    }
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn folder_create_failed_via_folder_route() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, false, true);
    let root = home.join("accounts");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o555)).unwrap();
    if !is_root_like(&root) && std::fs::write(root.join("probe"), "").is_err() {
        let (got, body) = send_json(
            &router,
            "POST",
            "/api/accounts/folder",
            serde_json::json!({ "cli": "claude", "mode": "create", "label": "Work" }),
        )
        .await;
        assert_eq!(got, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["code"], serde_json::json!("folder_create_failed"));
        assert_eq!(
            body["error"],
            serde_json::json!("Could not create this folder. Nothing was added.")
        );
    }
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn validate_path_writes_nothing() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (accounts, router, _) = folder_env(&home, false, true);
    std::fs::create_dir_all(home.join("chosen")).unwrap();

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts/validate-path",
        serde_json::json!({ "cli": "claude", "mode": "create", "label": "Work" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["dir"], serde_json::json!("~/accounts/claude/work"));
    assert_eq!(body["exists"], serde_json::json!(false));
    assert_eq!(body["isEmpty"], serde_json::json!(true));
    assert_eq!(body["looksValid"], serde_json::json!(true));

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts/validate-path",
        serde_json::json!({ "cli": "claude", "mode": "choose", "dir": home.join("chosen").display().to_string() }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["exists"], serde_json::json!(true));

    assert!(
        !home.join("accounts").exists(),
        "validate-path never creates the root"
    );
    assert!(
        accounts.list().iter().all(|a| a.id == "system"),
        "no row was added"
    );
}

#[tokio::test]
async fn folder_choose_signed_in_201_signed_in_true() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, true, true);
    std::fs::create_dir_all(home.join("work-a")).unwrap();
    // Non-empty and login-looking: an empty chosen folder is never probed at add time.
    std::fs::write(home.join("work-a/settings.json"), "{}").unwrap();

    let (status, body) = add_chosen(&router, &home.join("work-a")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["signedIn"], serde_json::json!(true));
    assert_eq!(body["account"]["pending"], serde_json::json!(false));
    assert_eq!(body["account"]["createdByUs"], serde_json::json!(false));
    assert_eq!(body["account"]["dir"], serde_json::json!("~/work-a"));
}

#[tokio::test]
async fn folder_choose_pending_201_with_sign_in_steps_command() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, false, true);
    std::fs::create_dir_all(home.join("work-b")).unwrap();

    let (status, body) = add_chosen(&router, &home.join("work-b")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["signedIn"], serde_json::json!(false));
    assert_eq!(body["account"]["pending"], serde_json::json!(true));
    assert_eq!(body["account"]["displayName"], serde_json::json!("work-b"));
    assert_eq!(
        body["account"]["signIn"]["command"],
        serde_json::json!(format!("FAKE={} fake login", home.join("work-b").display()))
    );
}

#[tokio::test]
async fn folder_create_201_pending_dir_under_root() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, false, true);

    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts/folder",
        serde_json::json!({ "cli": "claude", "mode": "create", "label": "Work" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["signedIn"], serde_json::json!(false));
    assert_eq!(body["account"]["pending"], serde_json::json!(true));
    assert_eq!(body["account"]["createdByUs"], serde_json::json!(true));
    assert_eq!(
        body["account"]["dir"],
        serde_json::json!("~/accounts/claude/work")
    );
    assert!(home.join("accounts/claude/work").is_dir());
}

#[tokio::test]
async fn folder_duplicate_409_carries_account_id() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, false, true);
    std::fs::create_dir_all(home.join("dup")).unwrap();

    let (status, first) = add_chosen(&router, &home.join("dup")).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, body) = add_chosen(&router, &home.join("dup")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], serde_json::json!("folder_duplicate"));
    assert_eq!(body["accountId"], first["account"]["id"]);
}

#[tokio::test]
async fn folder_label_taken_409() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, false, true);
    std::fs::create_dir_all(home.join("a")).unwrap();
    std::fs::create_dir_all(home.join("b")).unwrap();

    let (status, _) = send_json(
        &router,
        "POST",
        "/api/accounts/folder",
        serde_json::json!({ "cli": "claude", "mode": "choose", "dir": home.join("a").display().to_string(), "label": "Work" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, body) = send_json(
        &router,
        "POST",
        "/api/accounts/folder",
        serde_json::json!({ "cli": "claude", "mode": "choose", "dir": home.join("b").display().to_string(), "label": "work" }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], serde_json::json!("label_taken"));
}

#[tokio::test]
async fn refresh_pending_completes_then_not_pending() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, flag) = folder_env(&home, true, false);
    std::fs::create_dir_all(home.join("sig")).unwrap();
    let (_, added) = add_chosen(&router, &home.join("sig")).await;
    let id = added["account"]["id"].as_str().unwrap().to_string();

    flag.store(true, Ordering::SeqCst);
    let (status, body) = send_json(
        &router,
        "POST",
        &format!("/api/accounts/claude/{id}/refresh"),
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["pending"], serde_json::json!(false));
}

#[tokio::test]
async fn refresh_pending_duplicate_identity_409_and_row_removed() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, flag) = folder_env(&home, true, true);
    std::fs::create_dir_all(home.join("a")).unwrap();
    std::fs::write(home.join("a/settings.json"), "{}").unwrap();
    std::fs::create_dir_all(home.join("b")).unwrap();
    let (status, _) = add_chosen(&router, &home.join("a")).await;
    assert_eq!(status, StatusCode::CREATED);

    flag.store(false, Ordering::SeqCst);
    let (_, pending) = add_chosen(&router, &home.join("b")).await;
    assert_eq!(pending["signedIn"], serde_json::json!(false));
    let id = pending["account"]["id"].as_str().unwrap().to_string();

    flag.store(true, Ordering::SeqCst);
    let (status, body) = send_json(
        &router,
        "POST",
        &format!("/api/accounts/claude/{id}/refresh"),
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], serde_json::json!("duplicate_account"));

    let (_, list) = get(&router, "/api/accounts").await;
    let ids: Vec<&str> = list["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a["id"].as_str())
        .collect();
    assert!(!ids.contains(&id.as_str()), "the duplicate row is removed");
}

#[tokio::test]
async fn refresh_unverifiable_pending_completes_via_route_only() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (accounts, router, _) = folder_env(&home, false, true);
    std::fs::create_dir_all(home.join("pi")).unwrap();
    let (_, added) = add_chosen(&router, &home.join("pi")).await;
    let id = added["account"]["id"].as_str().unwrap().to_string();

    // A background identity read never finishes an unverifiable row.
    let background = accounts
        .refresh_identity("claude", Some(&id))
        .await
        .unwrap();
    assert!(background.pending, "background identity never un-pends");

    let (status, body) = send_json(
        &router,
        "POST",
        &format!("/api/accounts/claude/{id}/refresh"),
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["pending"], serde_json::json!(false));
}

#[tokio::test]
async fn delete_created_reports_folder_deleted_true() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, false, true);
    let (_, created) = send_json(
        &router,
        "POST",
        "/api/accounts/folder",
        serde_json::json!({ "cli": "claude", "mode": "create", "label": "Work" }),
    )
    .await;
    let id = created["account"]["id"].as_str().unwrap().to_string();

    let (status, body) = delete(&router, &format!("/api/accounts/claude/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["folderDeleted"], serde_json::json!(true));
    assert!(!home.join("accounts/claude/work").exists());
}

#[tokio::test]
async fn delete_chosen_reports_false_and_folder_intact() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, true, true);
    std::fs::create_dir_all(home.join("keep")).unwrap();
    let (_, added) = add_chosen(&router, &home.join("keep")).await;
    let id = added["account"]["id"].as_str().unwrap().to_string();

    let (status, body) = delete(&router, &format!("/api/accounts/claude/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["folderDeleted"], serde_json::json!(false));
    assert!(
        home.join("keep").is_dir(),
        "a chosen folder is never deleted"
    );
}

#[tokio::test]
async fn delete_pending_is_cancel() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, false, true);
    std::fs::create_dir_all(home.join("cancel-me")).unwrap();
    let (_, added) = add_chosen(&router, &home.join("cancel-me")).await;
    let id = added["account"]["id"].as_str().unwrap().to_string();

    let (status, _) = delete(&router, &format!("/api/accounts/claude/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = get(&router, "/api/accounts").await;
    let ids: Vec<&str> = list["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a["id"].as_str())
        .collect();
    assert!(!ids.contains(&id.as_str()));
    assert!(home.join("cancel-me").is_dir());
}

#[tokio::test]
async fn api_key_never_in_any_response_or_error_body() {
    const KEY: &str = "sk-SECRETKEY-123";
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (_accounts, router, _) = folder_env(&home, true, true);

    let mut bodies = Vec::new();
    let (status, created) = send_json(
        &router,
        "POST",
        "/api/accounts",
        serde_json::json!({ "cli": "claude", "method": "api_key", "apiKey": KEY, "label": "KeyAcct" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    bodies.push(created.to_string());
    // An error path for the same label, and a refused folder.
    let (_, taken) = send_json(
        &router,
        "POST",
        "/api/accounts",
        serde_json::json!({ "cli": "claude", "method": "api_key", "apiKey": KEY, "label": "KeyAcct" }),
    )
    .await;
    bodies.push(taken.to_string());
    let (_, refused) = send_json(
        &router,
        "POST",
        "/api/accounts/validate-path",
        serde_json::json!({ "cli": "claude", "mode": "choose", "dir": "relative" }),
    )
    .await;
    bodies.push(refused.to_string());
    let (_, list) = get(&router, "/api/accounts").await;
    bodies.push(list.to_string());
    for body in &bodies {
        assert!(!body.contains(KEY), "the API key leaked into: {body}");
    }
}

#[tokio::test]
async fn legacy_registry_file_loads_and_lists() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    // A record written before folder accounts: no dir, no createdByUs.
    std::fs::create_dir_all(home.join("accounts")).unwrap();
    std::fs::write(
        home.join("accounts/accounts.json"),
        r#"{"version":1,"accounts":[{"id":"acc_legacy1","cli":"claude","label":"Old","method":"sign_in","email":"old@example.com","plan":null,"auth":"signed_in","createdAt":"2026-01-01T00:00:00.000Z"}],"defaults":{"claude":"acc_legacy1"}}"#,
    )
    .unwrap();
    let (_accounts, router, _) = folder_env(&home, true, true);

    let (status, list) = get(&router, "/api/accounts").await;
    assert_eq!(status, StatusCode::OK);
    let legacy = list["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == serde_json::json!("acc_legacy1"))
        .expect("the legacy record is listed");
    assert_eq!(legacy["label"], serde_json::json!("Old"));
    assert_eq!(
        legacy["createdByUs"],
        serde_json::json!(true),
        "legacy folders were created by us"
    );
    assert_eq!(
        legacy["dir"],
        serde_json::json!("~/accounts/claude/acc_legacy1")
    );
}

#[tokio::test]
async fn signed_out_error_text_says_signed_out() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    let (accounts, router, _) = folder_env(&home, true, true);
    let work = accounts.add_api_key("claude", "sk-1", "Work").unwrap();
    accounts
        .note_auth("claude", Some(&work.id), AccountAuth::SignedOut)
        .unwrap();

    let (status, body) = send_json(
        &router,
        "PUT",
        "/api/accounts/claude/default",
        serde_json::json!({ "accountId": work.id }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], serde_json::json!("account_signed_out"));
    assert_eq!(
        body["error"],
        serde_json::json!("This account is signed out. Sign in, then try again.")
    );
}

#[tokio::test]
async fn limits_update_skips_pending_identity_check() {
    let tmp = tempdir().unwrap();
    let home = canonical(tmp.path());
    let _guard = with_home(home.clone());
    write_modes(&home);
    let calls = Arc::new(AtomicU64::new(0));
    let counter = calls.clone();
    let identity: IdentityFn = Arc::new(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            AccountIdentity {
                signed_in: Some(true),
                email: None,
                plan: None,
            }
        })
    });
    // Unverifiable: the folder account stays pending until the user confirms.
    let accounts = fake_accounts(&home.join("accounts"), &["claude"], identity, false);
    let store = StoreHandle::open(home.join("t.db")).unwrap();
    let state = state_with(&home, store, accounts.clone());
    std::fs::create_dir_all(home.join("pend")).unwrap();
    let pending = accounts
        .add_folder(
            "claude",
            FolderSpec::Choose(home.join("pend").display().to_string()),
            None,
        )
        .await
        .unwrap();
    assert!(pending.pending);

    let checker = IdentityChecker::new(accounts.clone(), state.session_routes.clone());
    vst_daemon::accounts_wiring::on_limits_updated(
        &checker,
        &accounts,
        &limits_with("claude", Some(&pending.id), 0.0, LimitStatus::SignedOut),
    )
    .await;

    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "no identity check for a pending row"
    );
    assert!(
        accounts
            .summary("claude", Some(&pending.id))
            .unwrap()
            .pending
    );
}

#[tokio::test]
async fn list_accounts_shows_sign_in_steps_for_signed_out_system_row() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    let accounts = fake_accounts(
        &tmp.path().join("accounts"),
        &["claude"],
        signed_in_identity(),
        true,
    );
    let identity = AccountIdentity {
        signed_in: Some(false),
        email: None,
        plan: None,
    };
    accounts.note_identity("claude", None, &identity).unwrap();
    let router = router_from_state(state_with(tmp.path(), store, accounts));

    let (status, body) = get(&router, "/api/accounts").await;
    assert_eq!(status, StatusCode::OK);
    let command = body["accounts"][0]["signIn"]["command"].as_str();
    assert!(command.is_some_and(|c| c.contains("fake login")), "{body}");
}
