//! Behavior contract for `project-store.ts` (part 01-storage).
//! Ported from `daemon/src/__tests__/project-store.test.ts`.
//! The HTTP route + git round-trip test (2.T3) is omitted here: it depends on
//! vst-git (part 03) and vst-routes (part 07) which are not yet ported.

use vst_store::StoreError;
use vst_store::StoreHandle;
use vst_types::{LifecycleState, PrState, ProjectRecord, SessionType, WorktreeRecord};

fn make_project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/fake/{id}"),
        prefix: id.chars().take(4).collect(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
    }
}

fn project_with_session(project_id: &str, wt_id: &str, sess_id: &str) -> ProjectRecord {
    let mut p = make_project(project_id);
    p.worktrees = vec![WorktreeRecord {
        id: wt_id.into(),
        name: None,
        branch: "b".into(),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "a".repeat(40),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: Some(0),
        agent_seq: Some(0),
        lsp_enabled: None,
        sessions: vec![vst_types::SessionRecord {
            id: sess_id.into(),
            worktree_id: Some(wt_id.into()),
            project_id: project_id.into(),
            is_main: true,
            sort_order: 0.0,
            r#type: SessionType::Agent,
            mode_id: Some("m".into()),
            name: None,
            name_source: None,
            tmux_name: format!("{sess_id}-pane"),
            use_tmux: true,
            channel: None,
            lifecycle: vst_types::SessionLifecycle {
                state: LifecycleState::Idle,
                reason: None,
                last_transition_at: "2024-01-01T00:00:00.000Z".into(),
            },
            transcript_ref: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            initial_prompt: None,
            archived_at: None,
            handoff_summary: None,
            draft_prompt: None,
            draft_config: None,
            parent_session_id: None,
            superseded_by: None,
            pr: None,
        }],
    }];
    p
}

#[tokio::test]
async fn concurrent_mutate_serializes_no_lost_update() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.add_project(make_project("conc-proj")).await.unwrap();
    let before = store
        .get_project("conc-proj")
        .await
        .unwrap()
        .next_worktree_num
        .unwrap_or(0);

    let mut handles = Vec::new();
    for _ in 0..20 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            store
                .mutate_project("conc-proj", |p| {
                    let next = p.next_worktree_num.unwrap_or(0) + 1;
                    p.next_worktree_num = Some(next);
                    Ok(p.clone())
                })
                .await
        }));
    }
    for h in handles {
        h.await.unwrap().unwrap();
    }
    let after = store
        .get_project("conc-proj")
        .await
        .unwrap()
        .next_worktree_num
        .unwrap();
    assert_eq!(after, before + 20);
}

#[tokio::test]
async fn writes_visible_to_next_read_and_delete() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.add_project(make_project("inval-proj")).await.unwrap();
    assert_eq!(
        store
            .get_project("inval-proj")
            .await
            .unwrap()
            .next_worktree_num
            .unwrap_or(1),
        1
    );

    store
        .mutate_project("inval-proj", |p| {
            p.next_worktree_num = Some(42);
            Ok(p.clone())
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .get_project("inval-proj")
            .await
            .unwrap()
            .next_worktree_num
            .unwrap(),
        42
    );

    store.delete_project("inval-proj").await.unwrap();
    assert!(store.get_project("inval-proj").await.is_none());
}

#[tokio::test]
async fn failing_mutation_leaves_db_and_cache_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(make_project("rollback-proj"))
        .await
        .unwrap();

    let err = store
        .mutate_project("rollback-proj", |p| {
            p.next_worktree_num = Some(999);
            Err(StoreError::Mutation("boom".into()))
        })
        .await;
    assert!(matches!(err, Err(StoreError::Mutation(_))));
    assert_eq!(
        store
            .get_project("rollback-proj")
            .await
            .unwrap()
            .next_worktree_num
            .unwrap_or(1),
        1
    );
}

#[tokio::test]
async fn update_session_lifecycle_writes_one_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project_with_session("lc-proj", "lc-wt", "lc-sess"))
        .await
        .unwrap();

    let ok = store
        .update_session_lifecycle(
            "lc-proj",
            "lc-sess",
            vst_types::SessionLifecycle {
                state: LifecycleState::Idle,
                reason: None,
                last_transition_at: "2024-02-01T00:00:00.000Z".into(),
            },
        )
        .await
        .unwrap();
    assert!(ok);
    let p = store.get_project("lc-proj").await.unwrap();
    assert_eq!(
        p.worktrees[0].sessions[0].lifecycle.state,
        LifecycleState::Idle
    );
    // Unknown session id is a no-op, not a throw.
    let ok = store
        .update_session_lifecycle(
            "lc-proj",
            "nope",
            vst_types::SessionLifecycle {
                state: LifecycleState::Idle,
                reason: None,
                last_transition_at: "2024-02-01T00:00:00.000Z".into(),
            },
        )
        .await
        .unwrap();
    assert!(!ok);
}

#[tokio::test]
async fn update_session_pr_writes_one_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project_with_session(
            "pr-fastpath-proj",
            "pr-fastpath-wt",
            "pr-fastpath-sess",
        ))
        .await
        .unwrap();

    let ok = store
        .update_session_pr(
            "pr-fastpath-proj",
            "pr-fastpath-sess",
            vst_types::PrStatus {
                state: PrState::Open,
                number: Some(11),
                url: Some("https://github.com/acme/widgets/pull/11".into()),
                checked_at: "2026-01-01T00:00:00.000Z".into(),
                error: None,
                pr_branch: None,
            },
        )
        .await
        .unwrap();
    assert!(ok);
    let p = store.get_project("pr-fastpath-proj").await.unwrap();
    assert_eq!(
        p.worktrees[0].sessions[0].pr.as_ref().unwrap().state,
        PrState::Open
    );
    let ok = store
        .update_session_pr(
            "pr-fastpath-proj",
            "nope",
            vst_types::PrStatus {
                state: PrState::None,
                number: None,
                url: None,
                checked_at: "2026-01-01T00:00:00.000Z".into(),
                error: None,
                pr_branch: None,
            },
        )
        .await
        .unwrap();
    assert!(!ok);
}

#[tokio::test]
async fn session_pr_survives_write_read_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project_with_session("pr-status-proj", "pr-wt", "pr-sess"))
        .await
        .unwrap();
    store
        .mutate_project("pr-status-proj", |p| {
            for w in &mut p.worktrees {
                for s in &mut w.sessions {
                    s.pr = Some(vst_types::PrStatus {
                        state: PrState::Open,
                        number: Some(42),
                        url: Some("https://github.com/acme/widgets/pull/42".into()),
                        checked_at: "2026-01-01T00:00:00.000Z".into(),
                        error: None,
                        pr_branch: None,
                    });
                }
            }
            Ok(p.clone())
        })
        .await
        .unwrap();
    let pr = store.get_project("pr-status-proj").await.unwrap().worktrees[0].sessions[0]
        .pr
        .clone()
        .unwrap();
    assert_eq!(pr.state, PrState::Open);
    assert_eq!(pr.number, Some(42));
    assert_eq!(
        pr.url.as_deref(),
        Some("https://github.com/acme/widgets/pull/42")
    );
}

#[tokio::test]
async fn pr_branch_survives_round_trip_via_mutate_and_fast_path() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project_with_session(
            "pr-branch-proj",
            "pr-branch-wt",
            "pr-branch-sess",
        ))
        .await
        .unwrap();
    store
        .mutate_project("pr-branch-proj", |p| {
            for w in &mut p.worktrees {
                for s in &mut w.sessions {
                    s.pr = Some(vst_types::PrStatus {
                        state: PrState::Open,
                        number: Some(9),
                        url: Some("https://github.com/acme/widgets/pull/9".into()),
                        checked_at: "2026-01-01T00:00:00.000Z".into(),
                        error: None,
                        pr_branch: Some("feature-x".into()),
                    });
                }
            }
            Ok(p.clone())
        })
        .await
        .unwrap();
    let pr = store.get_project("pr-branch-proj").await.unwrap().worktrees[0].sessions[0]
        .pr
        .clone()
        .unwrap();
    assert_eq!(pr.pr_branch.as_deref(), Some("feature-x"));

    store
        .update_session_pr(
            "pr-branch-proj",
            "pr-branch-sess",
            vst_types::PrStatus {
                state: PrState::Merged,
                number: Some(9),
                url: Some("https://github.com/acme/widgets/pull/9".into()),
                checked_at: "2026-01-02T00:00:00.000Z".into(),
                error: None,
                pr_branch: Some("feature-y".into()),
            },
        )
        .await
        .unwrap();
    let pr = store.get_project("pr-branch-proj").await.unwrap().worktrees[0].sessions[0]
        .pr
        .clone()
        .unwrap();
    assert_eq!(pr.state, PrState::Merged);
    assert_eq!(pr.pr_branch.as_deref(), Some("feature-y"));
}

/// Two-axis status regression test (AGENTS.md § Status indicators; part 10,
/// task 2, bug 3). The historical bug: the lifecycle poller and the PR poller
/// shared ONE `LifecycleState` slot (`needs_review`) with uncoordinated
/// writers, so a PR write raced with a lifecycle write and silently destroyed
/// the "PR created" signal (and vice versa).
///
/// The fix is the two-axis model: `update_session_lifecycle` (the lifecycle
/// poller's ONLY write path) touches only `state`/`reason`/`lastTransitionAt`,
/// and `update_session_pr` (the PR poller's ONLY write path) touches only the
/// `pr*` columns. This test drives BOTH poller write-paths in sequence and
/// proves neither clobbers the other — the exact runtime property the shared-
/// slot bug violated.
#[tokio::test]
async fn two_axis_status_writers_do_not_clobber_each_other() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project_with_session(
            "two-axis-proj",
            "two-axis-wt",
            "two-axis-sess",
        ))
        .await
        .unwrap();

    // (1) PR poller writes a PR status first.
    store
        .update_session_pr(
            "two-axis-proj",
            "two-axis-sess",
            vst_types::PrStatus {
                state: PrState::Open,
                number: Some(7),
                url: Some("https://github.com/acme/widgets/pull/7".into()),
                checked_at: "2026-01-01T00:00:00.000Z".into(),
                error: None,
                pr_branch: Some("feat-two-axis".into()),
            },
        )
        .await
        .unwrap();

    // (2) Lifecycle poller writes a lifecycle state second. If the two shared a
    // slot (the historical bug), this would overwrite/clear the PR status.
    store
        .update_session_lifecycle(
            "two-axis-proj",
            "two-axis-sess",
            vst_types::SessionLifecycle {
                state: LifecycleState::Working,
                reason: Some("agent busy".into()),
                last_transition_at: "2026-01-02T00:00:00.000Z".into(),
            },
        )
        .await
        .unwrap();

    let project = store.get_project("two-axis-proj").await.unwrap();
    let session = &project.worktrees[0].sessions[0];

    // Lifecycle axis intact (the lifecycle write landed).
    assert_eq!(session.lifecycle.state, LifecycleState::Working);
    assert_eq!(session.lifecycle.reason.as_deref(), Some("agent busy"));

    // PR axis intact — NOT clobbered by the lifecycle write.
    let pr = session
        .pr
        .clone()
        .expect("PR status must survive the lifecycle poller's write");
    assert_eq!(pr.state, PrState::Open);
    assert_eq!(pr.number, Some(7));
    assert_eq!(pr.pr_branch.as_deref(), Some("feat-two-axis"));

    // (3) Reverse order: a lifecycle write, then a PR write — the PR write must
    // not clobber the lifecycle state either.
    store
        .update_session_lifecycle(
            "two-axis-proj",
            "two-axis-sess",
            vst_types::SessionLifecycle {
                state: LifecycleState::Idle,
                reason: None,
                last_transition_at: "2026-01-03T00:00:00.000Z".into(),
            },
        )
        .await
        .unwrap();
    store
        .update_session_pr(
            "two-axis-proj",
            "two-axis-sess",
            vst_types::PrStatus {
                state: PrState::Merged,
                number: Some(7),
                url: Some("https://github.com/acme/widgets/pull/7".into()),
                checked_at: "2026-01-04T00:00:00.000Z".into(),
                error: None,
                pr_branch: Some("feat-two-axis".into()),
            },
        )
        .await
        .unwrap();

    let project = store.get_project("two-axis-proj").await.unwrap();
    let session = &project.worktrees[0].sessions[0];
    assert_eq!(
        session.lifecycle.state,
        LifecycleState::Idle,
        "PR write must not clobber the lifecycle state"
    );
    assert_eq!(
        session.pr.as_ref().map(|p| p.state),
        Some(PrState::Merged),
        "lifecycle write must not clobber the PR state"
    );
}
