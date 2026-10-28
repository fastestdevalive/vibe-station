//! `artifacts` table: schema, upsert/dedupe, caps, pin limit, purges, batch.

use rusqlite::Connection;
use vst_store::artifacts::{ArtifactWrite, PinOutcome};
use vst_store::schema::ensure_schema;
use vst_store::StoreHandle;
use vst_types::artifacts::{
    AddedVia, ScopeKey, ARTIFACT_CAP, ARTIFACT_MAX_WRITERS, ARTIFACT_PIN_CAP,
};
use vst_types::{LifecycleState, ProjectRecord, SessionRecord, SessionType, WorktreeRecord};

const T0: &str = "2026-01-01T00:00:00.000Z";

fn wt() -> ScopeKey {
    ScopeKey::worktree("wt-1")
}

fn write(scope: &ScopeKey, n: usize, now: &str) -> ArtifactWrite {
    ArtifactWrite {
        id: format!("id-{n}"),
        scope: scope.clone(),
        path: format!("/tmp/f{n}.md"),
        path_key: format!("/tmp/f{n}.md"),
        in_repo: false,
        hash: Some(format!("h{n}")),
        size: Some(10),
        mtime_ms: Some(1),
        writer: Some("sess-a".into()),
        added_via: AddedVia::Capture,
        now: now.into(),
    }
}

/// Distinct, sortable timestamps: n seconds after T0.
fn ts(n: usize) -> String {
    format!(
        "2026-01-01T{:02}:{:02}:{:02}.000Z",
        n / 3600,
        (n / 60) % 60,
        n % 60
    )
}

fn open() -> (tempfile::TempDir, StoreHandle) {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    (dir, store)
}

// ── 1.T2 ────────────────────────────────────────────────────────────────

#[test]
fn artifacts_schema_is_idempotent_unique_and_fk_free() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    ensure_schema(&conn).unwrap();

    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        !sql.contains("REFERENCES"),
        "artifacts must have no FK: {sql}"
    );

    let indexes: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='artifacts'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for want in [
        "idx_artifacts_scope_pathkey",
        "idx_artifacts_scope_written",
        "idx_artifacts_scope_hash",
    ] {
        assert!(
            indexes.iter().any(|i| i == want),
            "missing {want}: {indexes:?}"
        );
    }

    let insert = |id: &str| {
        conn.execute(
            "INSERT INTO artifacts (id, scopeKind, scopeId, path, pathKey, inRepo, createdAt, lastWrittenAt) \
             VALUES (?1, 'worktree', 'w', '/p', '/p', 0, 't', 't')",
            [id],
        )
    };
    insert("a").unwrap();
    assert!(
        insert("b").is_err(),
        "UNIQUE(scope, pathKey) must reject a duplicate"
    );
    // The same key in another scope kind is fine.
    conn.execute(
        "INSERT INTO artifacts (id, scopeKind, scopeId, path, pathKey, inRepo, createdAt, lastWrittenAt) \
         VALUES ('c', 'project', 'w', '/p', '/p', 0, 't', 't')",
        [],
    )
    .unwrap();
    // CHECK on scopeKind.
    assert!(conn
        .execute(
            "INSERT INTO artifacts (id, scopeKind, scopeId, path, pathKey, inRepo, createdAt, lastWrittenAt) \
             VALUES ('d', 'bogus', 'w', '/q', '/q', 0, 't', 't')",
            [],
        )
        .is_err());
}

// ── upsert semantics (R103) ─────────────────────────────────────────────

#[tokio::test]
async fn upsert_same_hash_adds_no_edit_and_no_reorder() {
    let (_d, store) = open();
    let first = store.upsert_artifact(write(&wt(), 1, T0)).await.unwrap();
    assert!(first.created && first.changed);
    assert_eq!(first.row.edit_count, 1);

    let again = store
        .upsert_artifact(write(&wt(), 1, &ts(60)))
        .await
        .unwrap();
    assert!(!again.created && !again.changed);
    assert_eq!(again.row.edit_count, 1);
    assert_eq!(again.row.last_written_at, T0);

    let mut changed = write(&wt(), 1, &ts(120));
    changed.hash = Some("other".into());
    let out = store.upsert_artifact(changed).await.unwrap();
    assert!(out.changed && !out.created);
    assert_eq!(out.row.edit_count, 2);
    assert_eq!(out.row.last_written_at, ts(120));
    assert_eq!(out.row.id, "id-1", "id is stable across rewrites");
}

#[tokio::test]
async fn upsert_tracks_writers_newest_first_capped_and_unhides() {
    let (_d, store) = open();
    store.upsert_artifact(write(&wt(), 1, T0)).await.unwrap();
    for i in 0..7 {
        let mut w = write(&wt(), 1, T0);
        w.writer = Some(format!("s{i}"));
        store.upsert_artifact(w).await.unwrap();
    }
    let row = store.get_artifact("id-1").await.unwrap().unwrap();
    assert_eq!(row.writers.len(), ARTIFACT_MAX_WRITERS);
    assert_eq!(row.writers[0], "s6");

    // Re-adding an existing writer moves it to the front without growing.
    let mut w = write(&wt(), 1, T0);
    w.writer = Some("s4".into());
    store.upsert_artifact(w).await.unwrap();
    let row = store.get_artifact("id-1").await.unwrap().unwrap();
    assert_eq!(row.writers[0], "s4");
    assert_eq!(row.writers.len(), ARTIFACT_MAX_WRITERS);

    // Remove, then a write brings it back (edit count untouched for same bytes).
    store.hide_artifact("id-1").await.unwrap().unwrap();
    let out = store
        .upsert_artifact(write(&wt(), 1, &ts(5)))
        .await
        .unwrap();
    assert!(out.changed && !out.row.hidden);
    assert_eq!(out.row.edit_count, 1);
}

#[tokio::test]
async fn upsert_without_hash_uses_size_and_mtime() {
    let (_d, store) = open();
    let mut w = write(&wt(), 1, T0);
    w.hash = None;
    store.upsert_artifact(w.clone()).await.unwrap();
    let same = store.upsert_artifact(w.clone()).await.unwrap();
    assert!(!same.changed);
    w.mtime_ms = Some(2);
    let out = store.upsert_artifact(w).await.unwrap();
    assert_eq!(out.row.edit_count, 2);
}

// ── 1.T3 ────────────────────────────────────────────────────────────────

fn session(id: &str, project_id: &str, worktree_id: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree_id.map(Into::into),
        project_id: project_id.into(),
        is_main: worktree_id.is_some(),
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: Some("m".into()),
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: true,
        channel: None,
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: T0.into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
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

fn project(id: &str, worktree_id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/fake/{id}"),
        prefix: "prj".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: T0.into(),
        hidden: None,
        direct_sessions: vec![session("direct-1", id, None)],
        direct_session_seq: None,
        worktrees: vec![WorktreeRecord {
            id: worktree_id.into(),
            name: None,
            branch: "b".into(),
            branch_is_placeholder: None,
            base_branch: "main".into(),
            base_sha: "a".repeat(40),
            created_at: T0.into(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 0.0,
            terminal_seq: Some(0),
            agent_seq: Some(0),
            lsp_enabled: None,
            sessions: vec![session("sess-1", id, Some(worktree_id))],
            open_files: vec![],
        }],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

#[tokio::test]
async fn project_save_leaves_artifact_rows_intact() {
    let (_d, store) = open();
    store.add_project(project("p1", "wt-1")).await.unwrap();
    store.upsert_artifact(write(&wt(), 1, T0)).await.unwrap();
    store
        .upsert_artifact(write(&ScopeKey::project("p1"), 2, T0))
        .await
        .unwrap();

    // A project save deletes and re-inserts the project's worktrees and sessions.
    store
        .mutate_project("p1", |p| {
            p.worktrees[0]
                .sessions
                .push(session("sess-2", "p1", Some("wt-1")));
            Ok(p.clone())
        })
        .await
        .unwrap();
    store
        .mutate_project("p1", |p| {
            p.worktrees.clear();
            p.direct_sessions.clear();
            Ok(p.clone())
        })
        .await
        .unwrap();
    store
        .mutate_project("p1", |_| Ok(project("p1", "wt-1")))
        .await
        .unwrap();

    assert_eq!(store.list_artifacts(&wt()).await.unwrap().len(), 1);
    assert_eq!(
        store
            .list_artifacts(&ScopeKey::project("p1"))
            .await
            .unwrap()
            .len(),
        1
    );
}

// ── 1.T4 ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn eviction_drops_hidden_then_oldest_and_never_pinned() {
    let (_d, store) = open();
    let n = ARTIFACT_CAP as usize + 5;
    let writes: Vec<_> = (0..n).map(|i| write(&wt(), i, &ts(i))).collect();
    store.apply_artifact_batch(writes).await.unwrap();

    // The three OLDEST rows are pinned (would be first to go by age), and four
    // YOUNG rows are hidden (would be last to go by age).
    for i in 0..3 {
        assert!(matches!(
            store
                .set_pinned(&format!("id-{i}"), true, T0)
                .await
                .unwrap(),
            PinOutcome::Updated(_)
        ));
    }
    let hidden: Vec<String> = (n - 4..n).map(|i| format!("id-{i}")).collect();
    for id in &hidden {
        store.hide_artifact(id).await.unwrap().unwrap();
    }

    let evicted = store.evict_over_cap(&wt()).await.unwrap();
    assert_eq!(evicted.len(), 5);
    for id in &hidden {
        assert!(
            evicted.contains(id),
            "hidden {id} must go first: {evicted:?}"
        );
    }
    // The fifth is the oldest UNPINNED row (id-3), not a pinned one.
    assert!(evicted.contains(&"id-3".to_string()), "{evicted:?}");
    for i in 0..3 {
        assert!(store
            .get_artifact(&format!("id-{i}"))
            .await
            .unwrap()
            .is_some());
    }
    assert_eq!(
        store.list_artifacts(&wt()).await.unwrap().len(),
        ARTIFACT_CAP as usize
    );
    // Under the cap: nothing more to evict.
    assert!(store.evict_over_cap(&wt()).await.unwrap().is_empty());
}

#[tokio::test]
async fn pin_limit_and_hide_frees_the_slot() {
    let (_d, store) = open();
    let n = ARTIFACT_PIN_CAP as usize + 2;
    store
        .apply_artifact_batch((0..n).map(|i| write(&wt(), i, &ts(i))).collect())
        .await
        .unwrap();
    for i in 0..ARTIFACT_PIN_CAP as usize {
        assert!(matches!(
            store
                .set_pinned(&format!("id-{i}"), true, T0)
                .await
                .unwrap(),
            PinOutcome::Updated(_)
        ));
    }
    let last = ARTIFACT_PIN_CAP as usize;
    assert_eq!(
        store
            .set_pinned(&format!("id-{last}"), true, T0)
            .await
            .unwrap(),
        PinOutcome::PinLimit
    );
    // Re-pinning an already pinned row is not a new pin.
    assert!(matches!(
        store.set_pinned("id-0", true, T0).await.unwrap(),
        PinOutcome::Updated(_)
    ));

    // Hiding a pinned row clears its pin and frees the slot.
    let hidden = store.hide_artifact("id-0").await.unwrap().unwrap();
    assert!(hidden.hidden && !hidden.pinned && hidden.pinned_at.is_none());
    assert!(matches!(
        store
            .set_pinned(&format!("id-{last}"), true, T0)
            .await
            .unwrap(),
        PinOutcome::Updated(_)
    ));
    // A hidden row cannot be pinned; unknown ids are NotFound.
    assert_eq!(
        store.set_pinned("id-0", true, T0).await.unwrap(),
        PinOutcome::NotFound
    );
    assert_eq!(
        store.set_pinned("nope", true, T0).await.unwrap(),
        PinOutcome::NotFound
    );
    // Unpin works at the cap.
    let un = store.set_pinned("id-1", false, T0).await.unwrap();
    assert!(matches!(un, PinOutcome::Updated(r) if !r.pinned && r.pinned_at.is_none()));
}

// ── 1.T5 ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn purge_orphans_removes_unknown_scopes_and_refuses_when_projects_empty() {
    let (_d, store) = open();
    store.upsert_artifact(write(&wt(), 1, T0)).await.unwrap();
    store
        .upsert_artifact(write(&ScopeKey::worktree("gone"), 2, T0))
        .await
        .unwrap();
    store
        .upsert_artifact(write(&ScopeKey::project("p1"), 3, T0))
        .await
        .unwrap();
    store
        .upsert_artifact(write(&ScopeKey::project("gone-p"), 4, T0))
        .await
        .unwrap();

    // No projects at all: refuse, never guess.
    assert_eq!(store.purge_orphan_artifacts().await.unwrap(), 0);
    assert_eq!(store.list_artifacts(&wt()).await.unwrap().len(), 1);
    assert_eq!(
        store
            .list_artifacts(&ScopeKey::worktree("gone"))
            .await
            .unwrap()
            .len(),
        1
    );

    store.add_project(project("p1", "wt-1")).await.unwrap();
    assert_eq!(store.purge_orphan_artifacts().await.unwrap(), 2);
    assert!(store.get_artifact("id-2").await.unwrap().is_none());
    assert!(store.get_artifact("id-4").await.unwrap().is_none());
    assert!(store.get_artifact("id-1").await.unwrap().is_some());
    assert!(store.get_artifact("id-3").await.unwrap().is_some());
}

#[tokio::test]
async fn purge_scope_deletes_only_that_scope() {
    let (_d, store) = open();
    store.upsert_artifact(write(&wt(), 1, T0)).await.unwrap();
    store
        .upsert_artifact(write(&ScopeKey::worktree("other"), 2, T0))
        .await
        .unwrap();
    assert_eq!(store.purge_scope(&wt()).await.unwrap(), 1);
    assert!(store.get_artifact("id-2").await.unwrap().is_some());
}

// ── misc store ops ──────────────────────────────────────────────────────

#[tokio::test]
async fn missing_path_update_and_delete() {
    let (_d, store) = open();
    store.upsert_artifact(write(&wt(), 1, T0)).await.unwrap();
    store.upsert_artifact(write(&wt(), 2, T0)).await.unwrap();

    let flipped = store.set_missing("id-1", true, T0).await.unwrap();
    assert!(flipped.is_some_and(|r| r.missing));
    assert!(store.set_missing("id-1", true, T0).await.unwrap().is_none());

    // Move keeps id/edits/writers and clears missing; a taken key is refused.
    let moved = store
        .update_path("id-1", "/tmp/new.md", "/tmp/new.md", false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moved.id, "id-1");
    assert!(!moved.missing);
    assert_eq!(moved.writers, vec!["sess-a".to_string()]);
    assert!(store
        .update_path("id-1", "/tmp/f2.md", "/tmp/f2.md", false)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .find_by_path_key(&wt(), "/tmp/new.md")
        .await
        .unwrap()
        .is_some());
}

// ── 1.T6 ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn batch_of_50_upserts_commits_once() {
    let (dir, store) = open();
    // `PRAGMA data_version` on a SECOND connection advances once per commit
    // made by any other connection, so it counts the batch's commits.
    let observer = Connection::open(dir.path().join("vibe-station.db")).unwrap();
    let version = |c: &Connection| -> i64 {
        c.query_row("PRAGMA data_version", [], |r| r.get(0))
            .unwrap()
    };
    let before = version(&observer);

    let writes: Vec<_> = (0..50).map(|i| write(&wt(), i, &ts(i))).collect();
    let out = store.apply_artifact_batch(writes).await.unwrap();
    assert_eq!(out.len(), 50);
    assert!(out.iter().all(|o| o.created));
    assert_eq!(
        version(&observer) - before,
        1,
        "one commit for the whole batch"
    );
    assert_eq!(store.list_artifacts(&wt()).await.unwrap().len(), 50);
}

#[tokio::test]
async fn failing_batch_rolls_everything_back() {
    let (_d, store) = open();
    store.upsert_artifact(write(&wt(), 0, T0)).await.unwrap();
    // A trigger that aborts on one specific path makes the 26th write fail.
    store
        .raw_conn()
        .execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON artifacts WHEN NEW.pathKey = '/tmp/f25.md'
             BEGIN SELECT RAISE(ABORT, 'forced'); END;",
        )
        .unwrap();

    let writes: Vec<_> = (1..=50).map(|i| write(&wt(), i, &ts(i))).collect();
    assert!(store.apply_artifact_batch(writes).await.is_err());
    let rows = store.list_artifacts(&wt()).await.unwrap();
    assert_eq!(
        rows.len(),
        1,
        "no partial batch may survive: {}",
        rows.len()
    );
    assert_eq!(rows[0].id, "id-0");
}

#[tokio::test]
async fn merge_artifact_into_is_all_or_nothing() {
    let (_d, store) = open();
    store.upsert_artifact(write(&wt(), 1, T0)).await.unwrap(); // old
    store.upsert_artifact(write(&wt(), 2, T0)).await.unwrap(); // new
    store.upsert_artifact(write(&wt(), 3, T0)).await.unwrap(); // third
    store.set_missing("id-1", true, T0).await.unwrap();

    let new = store.get_artifact("id-2").await.unwrap().unwrap();
    let merged = store
        .merge_artifact_into("id-1", new.clone(), T0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(merged.id, "id-1");
    assert_eq!(merged.path_key, "/tmp/f2.md");
    assert_eq!(merged.hash.as_deref(), Some("h2"));
    assert!(!merged.missing);
    assert!(store.get_artifact("id-2").await.unwrap().is_none());

    // A stale `new` (already gone) changes nothing.
    assert!(store
        .merge_artifact_into("id-1", new, T0)
        .await
        .unwrap()
        .is_none());

    // The path key now belongs to a third row: nothing is deleted or moved.
    store.upsert_artifact(write(&wt(), 4, T0)).await.unwrap();
    let mut stale = store.get_artifact("id-4").await.unwrap().unwrap();
    stale.path_key = "/tmp/f3.md".into();
    assert!(store
        .merge_artifact_into("id-1", stale, T0)
        .await
        .unwrap()
        .is_none());
    assert!(store.get_artifact("id-4").await.unwrap().is_some());
    assert_eq!(
        store.get_artifact("id-1").await.unwrap().unwrap().path_key,
        "/tmp/f2.md"
    );
}
