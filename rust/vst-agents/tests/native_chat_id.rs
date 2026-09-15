//! Behavior contract for `native_chat_id::find_latest_claude_chat_uuid` —
//! ports `daemon/src/__tests__/nativeChatIdClaude.test.ts` (3.T1-T5).
//!
//! `native_chat_id.rs` was pulled forward by 04a as a stopgap; this part
//! owns it for real. The claude strategy is `identical` (ACP id IS the native
//! id), so this file serves only the terminal-channel restore path.

use std::fs;
use std::thread;
use std::time::Duration;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::native_chat_id::find_latest_claude_chat_uuid;

#[tokio::test]
async fn returns_none_when_projects_dir_does_not_exist() {
    let dir = tempdir().unwrap();
    let _guard = with_home(dir.path().to_path_buf());
    let uuid = find_latest_claude_chat_uuid("/some/nonexistent/worktree").await;
    assert!(uuid.is_none());
}

#[tokio::test]
async fn returns_uuid_of_newest_jsonl_by_mtime() {
    let dir = tempdir().unwrap();
    let _guard = with_home(dir.path().to_path_buf());
    let projects = dir
        .path()
        .join(".claude")
        .join("projects")
        .join("-test-path-to-worktree");
    fs::create_dir_all(&projects).unwrap();
    fs::write(projects.join("old-uuid.jsonl"), "old content").unwrap();
    thread::sleep(Duration::from_millis(10));
    fs::write(projects.join("new-uuid.jsonl"), "new content").unwrap();
    let uuid = find_latest_claude_chat_uuid("/test/path/to/worktree").await;
    assert_eq!(uuid.as_deref(), Some("new-uuid"));
}

#[tokio::test]
async fn returns_uuid_when_only_one_jsonl_exists() {
    let dir = tempdir().unwrap();
    let _guard = with_home(dir.path().to_path_buf());
    let projects = dir
        .path()
        .join(".claude")
        .join("projects")
        .join("-single-file-test");
    fs::create_dir_all(&projects).unwrap();
    fs::write(projects.join("chat-uuid-12345.jsonl"), "chat content").unwrap();
    let uuid = find_latest_claude_chat_uuid("/single/file/test").await;
    assert_eq!(uuid.as_deref(), Some("chat-uuid-12345"));
}

#[tokio::test]
async fn slug_strips_dots() {
    let dir = tempdir().unwrap();
    let _guard = with_home(dir.path().to_path_buf());
    // Worktree path with a dot dir mid-path matches the real ~/.vibe-station layout.
    let slug = "-home-gb--vibe-station-projects-console-home-worktrees-ch-2";
    let projects = dir.path().join(".claude").join("projects").join(slug);
    fs::create_dir_all(&projects).unwrap();
    fs::write(projects.join("abc-123.jsonl"), "chat").unwrap();
    let uuid =
        find_latest_claude_chat_uuid("/home/gb/.vibe-station/projects/console-home/worktrees/ch-2")
            .await;
    assert_eq!(uuid.as_deref(), Some("abc-123"));
}

#[tokio::test]
async fn ignores_non_jsonl_files_and_directories() {
    let dir = tempdir().unwrap();
    let _guard = with_home(dir.path().to_path_buf());
    let projects = dir
        .path()
        .join(".claude")
        .join("projects")
        .join("-mixed-files-test");
    fs::create_dir_all(&projects).unwrap();
    fs::write(projects.join("valid-uuid.jsonl"), "chat").unwrap();
    fs::write(projects.join("readme.txt"), "not a chat").unwrap();
    fs::create_dir(projects.join("subdir")).unwrap();
    let uuid = find_latest_claude_chat_uuid("/mixed/files/test").await;
    assert_eq!(uuid.as_deref(), Some("valid-uuid"));
}
