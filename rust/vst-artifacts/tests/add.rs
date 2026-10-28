//! `vst artifact add` pipeline (`add_by_token`), pin/remove, purge, and the
//! store-backed resolver.

mod common;

use common::Env;
use vst_artifacts::{AddError, ArtifactError, ScopeResolver, StoreResolver};
use vst_types::artifacts::ScopeKey;
use vst_types::rest::artifacts::ArtifactErrorCode;
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

fn code(r: &vst_types::rest::artifacts::AddArtifactResult) -> ArtifactErrorCode {
    r.error.as_ref().expect("error").code
}

#[tokio::test]
async fn add_records_outside_files_with_per_path_errors() {
    let env = Env::new().await;
    let shot = env.file(&env.out("login.png"), "png");
    let src = env.file(&env.root.join("src/main.rs"), "fn main(){}");
    let key = env.file(&env.out("server.pem"), "k");
    let dir = env.out("adir");
    std::fs::create_dir_all(&dir).unwrap();
    let paths: Vec<String> = vec![
        shot.to_string_lossy().into(),
        src.to_string_lossy().into(),
        key.to_string_lossy().into(),
        env.out("missing.md").to_string_lossy().into(),
        "relative/x.md".into(),
        dir.to_string_lossy().into(),
        "/tmp/\u{1}bad".into(),
    ];
    let resp = env.handle.add_by_token("sess-a", paths).await.unwrap();
    let r = &resp.results;
    assert_eq!(r.len(), 7);
    assert_eq!(r[0].outside_worktree, Some(true));
    assert_eq!(r[0].artifact.as_ref().unwrap().path, shot.to_string_lossy());
    assert_eq!(code(&r[1]), ArtifactErrorCode::ArtifactIneligible);
    assert_eq!(code(&r[2]), ArtifactErrorCode::ArtifactDenied);
    assert_eq!(code(&r[3]), ArtifactErrorCode::NotFound);
    assert_eq!(code(&r[4]), ArtifactErrorCode::ValidationError);
    assert_eq!(code(&r[5]), ArtifactErrorCode::ArtifactIneligible);
    assert!(r[5]
        .error
        .as_ref()
        .unwrap()
        .message
        .contains("regular file"));
    assert_eq!(code(&r[6]), ArtifactErrorCode::ValidationError);

    let row = env.handle.list(&env.scope).await.unwrap().items.remove(0);
    assert_eq!(row.added_via, vst_types::artifacts::AddedVia::Cli);
    assert_eq!(row.writers, vec!["sess-a"]);
}

#[tokio::test]
async fn denylist_matrix_for_add() {
    let env = Env::new().await;
    // The denylist is path based: the protected files need not be real secrets.
    let home = env.vst_home.parent().unwrap().to_path_buf();
    for p in [
        home.join(".ssh/id_rsa"),
        home.join(".aws/credentials"),
        home.join(".vibe-station/config.json"),
        env.out(".env"),
        env.out("foo.pem"),
        env.out("id_ed25519"),
    ] {
        env.file(&p, "secret");
        let resp = env
            .handle
            .add_by_token("sess-a", vec![p.to_string_lossy().into()])
            .await
            .unwrap();
        assert_eq!(
            code(&resp.results[0]),
            ArtifactErrorCode::ArtifactDenied,
            "{p:?}"
        );
        // Spend no more than a token per call: refill is not needed for 6 calls.
    }
    assert_eq!(env.handle.list(&env.scope).await.unwrap().total, 0);
}

#[tokio::test]
async fn token_errors_and_rate_limit_cost_one_token_per_request() {
    let env = Env::new().await;
    let f = env.file(&env.out("a.md"), "a");
    let p = || vec![f.to_string_lossy().to_string()];
    assert_eq!(
        env.handle.add_by_token("nobody", p()).await.unwrap_err(),
        AddError::UnknownSession
    );
    assert_eq!(
        env.handle
            .add_by_token("sess-archived", p())
            .await
            .unwrap_err(),
        AddError::SessionArchived
    );
    assert!(matches!(
        env.handle.add_by_token("sess-a", vec![]).await.unwrap_err(),
        AddError::InvalidRequest(_)
    ));
    let many: Vec<String> = (0..51).map(|i| format!("/x/{i}")).collect();
    assert!(matches!(
        env.handle.add_by_token("sess-a", many).await.unwrap_err(),
        AddError::InvalidRequest(_)
    ));

    // One request with 20 paths costs ONE token: ten such requests fit the burst.
    let twenty: Vec<String> = (0..20).map(|_| f.to_string_lossy().to_string()).collect();
    for i in 0..10 {
        env.handle
            .add_by_token("sess-a", twenty.clone())
            .await
            .unwrap_or_else(|e| panic!("request {i}: {e:?}"));
    }
    assert_eq!(
        env.handle.add_by_token("sess-a", p()).await.unwrap_err(),
        AddError::RateLimited
    );
    // A flood of single adds: refused, nothing unbounded.
    let mut limited = 0;
    for _ in 0..100 {
        if env.handle.add_by_token("sess-a", p()).await == Err(AddError::RateLimited) {
            limited += 1;
        }
    }
    assert!(limited >= 99);
    assert_eq!(env.handle.list(&env.scope).await.unwrap().total, 1);
}

#[tokio::test]
async fn pin_limit_and_unpin_roundtrip() {
    let env = Env::new().await;
    for i in 0..51 {
        let f = env.file(&env.out(&format!("p{i}.md")), &format!("c{i}"));
        env.record("sess-a", &f);
    }
    env.handle.drain_now().await;
    let ids: Vec<String> = env
        .handle
        .list(&env.scope)
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|r| r.id)
        .collect();
    for id in &ids[..50] {
        assert!(env.handle.pin(id, true).await.unwrap().pinned);
    }
    assert!(matches!(
        env.handle.pin(&ids[50], true).await,
        Err(ArtifactError::PinLimit)
    ));
    assert!(!env.handle.pin(&ids[0], false).await.unwrap().pinned);
    assert!(env.handle.pin(&ids[50], true).await.unwrap().pinned);
    assert!(matches!(
        env.handle.pin("nope", true).await,
        Err(ArtifactError::NotFound)
    ));
}

#[tokio::test]
async fn purge_scope_leaves_other_scopes() {
    let env = Env::new().await;
    let f = env.file(&env.out("p.md"), "a");
    env.write_now("sess-a", &f).await;
    let other = ScopeKey::worktree("wt-other");
    assert_eq!(env.handle.purge_scope(&other).await.unwrap(), 0);
    assert_eq!(env.handle.list(&env.scope).await.unwrap().total, 1);
    assert_eq!(env.handle.purge_scope(&env.scope).await.unwrap(), 1);
    assert_eq!(env.handle.list(&env.scope).await.unwrap().total, 0);
    assert_eq!(env.handle.rev(&env.scope), 0);
    assert!(env.handle.paths_for_scope(&env.scope).await.is_empty());
}

#[tokio::test]
async fn paths_for_scope_lists_live_rows_only() {
    let env = Env::new().await;
    let a = env.file(&env.out("a.md"), "a");
    let b = env.file(&env.out("b.md"), "b");
    env.write_now("sess-a", &a).await;
    env.write_now("sess-a", &b).await;
    let id = env
        .handle
        .list(&env.scope)
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|r| r.path == b.to_string_lossy())
        .unwrap()
        .id;
    env.handle.remove(&id).await.unwrap();
    assert_eq!(env.handle.paths_for_scope(&env.scope).await, vec![a]);
}

// ── StoreResolver ───────────────────────────────────────────────────────

fn session(id: &str, project: &str, wt: Option<&str>, archived: bool) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: wt.map(Into::into),
        project_id: project.into(),
        is_main: wt.is_some(),
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: true,
        channel: None,
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
        archived_at: archived.then(|| "2026-01-02T00:00:00.000Z".to_string()),
        handoff_summary: None,
        carry_over: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

#[tokio::test]
async fn store_resolver_maps_sessions_scopes_and_roots() {
    let env = Env::new().await;
    let project = ProjectRecord {
        id: "prj-1".into(),
        absolute_path: env.root.to_string_lossy().into_owned(),
        prefix: "prj".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![session("direct-1", "prj-1", None, false)],
        direct_session_seq: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-1".into(),
            name: None,
            branch: "b".into(),
            branch_is_placeholder: None,
            base_branch: "main".into(),
            base_sha: "a".repeat(40),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 0.0,
            terminal_seq: Some(0),
            agent_seq: Some(0),
            lsp_enabled: None,
            sessions: vec![
                session("s-live", "prj-1", Some("wt-1"), false),
                session("s-old", "prj-1", Some("wt-1"), true),
            ],
            open_files: vec![],
        }],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    };
    env.store.add_project(project).await.unwrap();
    let r = StoreResolver::new(env.store.clone(), env.vst_home.clone());
    let wt_root = env.vst_home.join("projects/prj-1/worktrees/wt-1");

    let s = r.session_scope("s-live").await.unwrap();
    assert_eq!(s.scope, ScopeKey::worktree("wt-1"));
    assert_eq!(s.cwd, wt_root);
    assert!(!s.archived);
    assert!(r.session_scope("s-old").await.unwrap().archived);
    let d = r.session_scope("direct-1").await.unwrap();
    assert_eq!(d.scope, ScopeKey::project("prj-1"));
    assert_eq!(d.cwd, env.root);
    assert!(r.session_scope("nobody").await.is_none());

    assert_eq!(
        r.scope_root(&ScopeKey::worktree("wt-1")).await,
        Some(wt_root.clone())
    );
    assert_eq!(
        r.scope_root(&ScopeKey::project("prj-1")).await,
        Some(env.root.clone())
    );
    assert!(r.scope_root(&ScopeKey::worktree("zzz")).await.is_none());
    assert!(r.scope_exists(&ScopeKey::project("prj-1")).await);
    assert!(!r.scope_exists(&ScopeKey::project("zzz")).await);
    let roots = r.registered_roots().await;
    assert!(roots.contains(&wt_root) && roots.contains(&env.root));
    assert_eq!(r.vst_home(), env.vst_home);
}
