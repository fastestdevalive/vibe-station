//! Behavior contract for `dbMigration.ts` (part 01-storage).
//! Ported from `daemon/src/__tests__/dbMigration.test.ts`.
//!
//! Note: the legacy `manifest.json` reader that `readManifest` (owned by part
//! 05, `manifest.ts`) normally provides is implemented here, scoped to the
//! migration's on-disk needs, so this part is self-contained and testable. It
//! is flagged in the part's report for reconciliation when part 05 lands.

use std::collections::BTreeSet;
use vst_store::StoreHandle;

fn legacy_manifest(id: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "absolutePath": format!("/fake/{id}"),
        "prefix": &id[..4],
        "isGit": true,
        "defaultBranch": "main",
        "createdAt": "2024-01-01T00:00:00.000Z",
        "directSessions": [],
        "worktrees": [{
            "id": format!("{id}-1"),
            "branch": "feature-x",
            "baseBranch": "main",
            "baseSha": "0".repeat(40),
            "createdAt": "2024-01-01T00:00:00.000Z",
            "sessions": [
                {"id": format!("{id}-1-m"), "slot": "m", "type": "agent", "modeId": "claude-default", "tmuxName": format!("vr-{id}-1-m"), "useTmux": true, "lifecycle": {"state": "working", "lastTransitionAt": "2024-01-01T00:00:00.000Z"}},
                {"id": format!("{id}-1-t1"), "slot": "t1", "type": "terminal", "name": "Terminal 1", "tmuxName": format!("vr-{id}-1-t1"), "useTmux": true, "lifecycle": {"state": "working", "lastTransitionAt": "2024-01-01T00:00:00.000Z"}}
            ]
        }]
    })
}

fn write_manifest(projects_dir: &std::path::Path, id: &str, content: &str) {
    let dir = projects_dir.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), content).unwrap();
}

fn write_manifest_value(projects_dir: &std::path::Path, id: &str, value: &serde_json::Value) {
    write_manifest(
        projects_dir,
        id,
        &serde_json::to_string_pretty(value).unwrap(),
    );
}

#[tokio::test]
async fn migrates_multi_project_fixture_with_correct_counts() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    write_manifest_value(&projects, "proj-a", &legacy_manifest("proj-a"));
    write_manifest_value(&projects, "proj-b", &legacy_manifest("proj-b"));

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();

    let conn = store.raw_conn();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM worktrees", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 4);

    let main: i64 = conn
        .query_row(
            "SELECT isMain FROM sessions WHERE id='proj-a-1-m'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(main, 1);
    let (is_main, name): (i64, String) = conn
        .query_row(
            "SELECT isMain, name FROM sessions WHERE id='proj-a-1-t1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(is_main, 0);
    assert_eq!(name, "Terminal 1");
}

#[tokio::test]
async fn quarantines_malformed_manifest_without_affecting_others() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    write_manifest_value(&projects, "proj-good", &legacy_manifest("proj-good"));
    write_manifest(&projects, "proj-bad", "{ not valid json");

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();

    let conn = store.raw_conn();
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM projects")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(ids, vec!["proj-good"]);
}

#[tokio::test]
async fn manifest_missing_worktrees_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let mut m = legacy_manifest("proj-noworktrees");
    m.as_object_mut().unwrap().remove("worktrees");
    write_manifest_value(&projects, "proj-noworktrees", &m);

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    let conn = store.raw_conn();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM worktrees WHERE projectId='proj-noworktrees'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn manifest_with_null_worktrees_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let mut m = legacy_manifest("proj-nullworktrees");
    m["worktrees"] = serde_json::Value::Null;
    write_manifest_value(&projects, "proj-nullworktrees", &m);

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    let conn = store.raw_conn();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn running_twice_is_noop() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    write_manifest_value(&projects, "proj-a", &legacy_manifest("proj-a"));

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    let conn = store.raw_conn();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);
}

#[tokio::test]
async fn failed_project_retried_once_fixed() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    write_manifest(&projects, "proj-retry", "{ not valid json");

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    let status: String = {
        let conn = store.raw_conn();
        conn.query_row(
            "SELECT status FROM manifest_migrations WHERE projectId='proj-retry'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(status, "failed");

    write_manifest_value(&projects, "proj-retry", &legacy_manifest("proj-retry"));
    store.migrate_manifests(&projects).await.unwrap();
    let (row_exists, status): (i64, String) = {
        let conn = store.raw_conn();
        let row_exists = conn
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE id='proj-retry'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let status = conn
            .query_row(
                "SELECT status FROM manifest_migrations WHERE projectId='proj-retry'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (row_exists, status)
    };
    assert_eq!(row_exists, 1);
    assert_eq!(status, "ok");
}

#[tokio::test]
async fn succeeded_project_not_reprocessed_live_rename_survives() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    write_manifest_value(
        &projects,
        "proj-norereprocess",
        &legacy_manifest("proj-norereprocess"),
    );

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    {
        let conn = store.raw_conn();
        conn.execute(
            "UPDATE projects SET absolutePath='/renamed/elsewhere' WHERE id='proj-norereprocess'",
            [],
        )
        .unwrap();
    }

    store.migrate_manifests(&projects).await.unwrap();
    let path: String = {
        let conn = store.raw_conn();
        conn.query_row(
            "SELECT absolutePath FROM projects WHERE id='proj-norereprocess'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(path, "/renamed/elsewhere");
}

#[tokio::test]
async fn new_project_picked_up_on_second_pass() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    write_manifest_value(&projects, "proj-a", &legacy_manifest("proj-a"));

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    write_manifest_value(&projects, "proj-b", &legacy_manifest("proj-b"));
    store.migrate_manifests(&projects).await.unwrap();

    let conn = store.raw_conn();
    let ids: BTreeSet<String> = conn
        .prepare("SELECT id FROM projects")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        ids.into_iter().collect::<Vec<_>>(),
        vec!["proj-a".to_string(), "proj-b".to_string()]
    );
}

#[tokio::test]
async fn preserves_transcript_ref_and_leaves_file_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let session_data_dir = projects
        .join("proj-transcript")
        .join("worktrees")
        .join("proj-transcript-1")
        .join("sessions")
        .join("proj-transcript-1-m");
    std::fs::create_dir_all(&session_data_dir).unwrap();
    let transcript_path = session_data_dir.join("messages.db");
    let content = "not a real sqlite file, just distinctive byte content for a diff check";
    std::fs::write(&transcript_path, content).unwrap();

    let mut m = legacy_manifest("proj-transcript");
    m["worktrees"][0]["sessions"][0]["transcriptRef"] =
        serde_json::json!({"kind": "vst-json", "path": transcript_path.to_string_lossy()});
    write_manifest_value(&projects, "proj-transcript", &m);

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    let conn = store.raw_conn();
    let (kind, path): (String, String) = conn
        .query_row(
            "SELECT transcriptKind, transcriptPath FROM sessions WHERE id='proj-transcript-1-m'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(kind, "vst-json");
    assert_eq!(path, transcript_path.to_string_lossy());

    let after = std::fs::read_to_string(&transcript_path).unwrap();
    assert_eq!(after, content);
}

#[tokio::test]
async fn copies_tmux_identity_verbatim_across_rerun() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let mut m = legacy_manifest("proj-tmux");
    m["worktrees"][0]["sessions"][0]["id"] = serde_json::json!("proj-tmux-1-m");
    m["worktrees"][0]["sessions"][0]["tmuxName"] = serde_json::json!("vr-proj-tmux-7-a3");
    write_manifest_value(&projects, "proj-tmux", &m);

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    let conn = store.raw_conn();
    let (id, tmux): (String, String) = conn
        .query_row(
            "SELECT id, tmuxName FROM sessions WHERE id='proj-tmux-1-m'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(id, "proj-tmux-1-m");
    assert_eq!(tmux, "vr-proj-tmux-7-a3");
}

#[tokio::test]
async fn preserves_agent_chat_id() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let mut m = legacy_manifest("proj-chatid");
    m["worktrees"][0]["sessions"][0]["agentChatId"] =
        serde_json::json!("chat_9f3a1e7b-resume-token");
    write_manifest_value(&projects, "proj-chatid", &m);

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    let conn = store.raw_conn();
    let chat: String = conn
        .query_row(
            "SELECT agentChatId FROM sessions WHERE id='proj-chatid-1-m'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(chat, "chat_9f3a1e7b-resume-token");
}

#[tokio::test]
async fn migrated_session_fk_points_at_migrated_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    write_manifest_value(&projects, "proj-fk", &legacy_manifest("proj-fk"));

    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.migrate_manifests(&projects).await.unwrap();
    let conn = store.raw_conn();
    let (wt, wt_proj): (String, String) = conn
        .query_row(
            "SELECT w.id, w.projectId FROM sessions s JOIN worktrees w ON w.id = s.worktreeId WHERE s.id='proj-fk-1-m'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(wt, "proj-fk-1");
    assert_eq!(wt_proj, "proj-fk");
}

fn manifest_with_worktrees(id: &str, prefix: &str, ids: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "absolutePath": format!("/fake/{id}"),
        "prefix": prefix,
        "isGit": true,
        "defaultBranch": "main",
        "createdAt": "2024-01-01T00:00:00.000Z",
        "directSessions": [],
        "worktrees": ids.iter().map(|wt_id| serde_json::json!({
            "id": wt_id,
            "branch": format!("b-{wt_id}"),
            "baseBranch": "main",
            "baseSha": "0".repeat(40),
            "createdAt": "2024-01-01T00:00:00.000Z",
            "sessions": []
        })).collect::<Vec<_>>()
    })
}

async fn migrate_num(projects: &std::path::Path, store: &StoreHandle, id: &str) -> i64 {
    store.migrate_manifests(projects).await.unwrap();
    let conn = store.raw_conn();
    conn.query_row(
        "SELECT nextWorktreeNum FROM projects WHERE id=?1",
        [id],
        |r| r.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn next_worktree_num_floor_derived_above_existing() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let id = "proj-seed";
    write_manifest_value(
        &projects,
        id,
        &manifest_with_worktrees(id, "napi", &["napi-1", "napi-2", "napi-3", "napi-4"]),
    );
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    assert_eq!(migrate_num(&projects, &store, id).await, 5);
}

#[tokio::test]
async fn next_worktree_num_keeps_declared_above_floor() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let id = "proj-declared";
    let mut m = manifest_with_worktrees(id, "napi", &["napi-1", "napi-2"]);
    m["nextWorktreeNum"] = serde_json::json!(9);
    write_manifest_value(&projects, id, &m);
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    assert_eq!(migrate_num(&projects, &store, id).await, 9);
}

#[tokio::test]
async fn next_worktree_num_overrides_stale_declared() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let id = "proj-stale";
    let mut m = manifest_with_worktrees(id, "napi", &["napi-1", "napi-2", "napi-3"]);
    m["nextWorktreeNum"] = serde_json::json!(2);
    write_manifest_value(&projects, id, &m);
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    assert_eq!(migrate_num(&projects, &store, id).await, 4);
}

#[tokio::test]
async fn next_worktree_num_falls_back_to_1_for_no_worktrees() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let id = "proj-empty";
    write_manifest_value(&projects, id, &manifest_with_worktrees(id, "napi", &[]));
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    assert_eq!(migrate_num(&projects, &store, id).await, 1);
}

#[tokio::test]
async fn next_worktree_num_ignores_non_matching_ids() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let id = "proj-renamed";
    write_manifest_value(
        &projects,
        id,
        &manifest_with_worktrees(id, "napi", &["napi-1", "napi-hotfix", "other-9"]),
    );
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    assert_eq!(migrate_num(&projects, &store, id).await, 2);
}

#[tokio::test]
async fn next_worktree_num_treats_regex_prefix_literally() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let id = "proj-regex";
    write_manifest_value(
        &projects,
        id,
        &manifest_with_worktrees(id, "a.b", &["a.b-2", "axb-3"]),
    );
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    assert_eq!(migrate_num(&projects, &store, id).await, 3);
}
