//! Native chat-id recovery helpers — ports `native-chat-id/{claude,cursor,agy}.ts`
//! (part `04b`).
//!
//! Adopted from the 04a stopgap (which pulled this file forward because 04a's
//! tests exercise it through the plugin methods `get_restore_command` /
//! `capture_native_chat_id`); 04b now owns it for real. No second
//! implementation exists — this is the single one.
//!
//! See `AGENTS.md` § Agent plugin "The two session identities (ACP)" for the
//! strategy matrix these serve. All are best-effort reads of the CLI's own
//! on-disk transcript stores; every failure mode returns `None` rather than
//! throwing.

use std::path::PathBuf;

use tokio::fs;

use crate::home::home_dir;

/// `~/.claude/projects/<slug>` slug for a worktree path: replace BOTH `/` and
/// `.` with `-` (`/home/gb/.vibe-station/...` → `-home-gb--vibe-station-...`).
fn claude_slug(worktree_path: &str) -> String {
    worktree_path.replace(['/', '.'], "-")
}

/// Find the latest Claude chat UUID for a worktree path (filename without
/// `.jsonl`), or `None` if no chats exist. Mirrors
/// `native-chat-id/claude.ts`'s `findLatestChatUuid`.
pub async fn find_latest_claude_chat_uuid(worktree_path: &str) -> Option<String> {
    let slug = claude_slug(worktree_path);
    let projects_dir = home_dir().join(".claude").join("projects").join(slug);
    list_latest_jsonl_uuid(&projects_dir).await
}

async fn list_latest_jsonl_uuid(projects_dir: &PathBuf) -> Option<String> {
    let entries = fs::read_dir(projects_dir).await.ok()?;
    let mut files: Vec<(String, std::time::SystemTime)> = Vec::new();
    let mut rd = entries;
    while let Ok(Some(entry)) = rd.next_entry().await {
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if meta.is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".jsonl") {
                files.push((name, meta.modified().unwrap_or(std::time::UNIX_EPOCH)));
            }
        }
    }
    if files.is_empty() {
        return None;
    }
    files.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));
    let newest = files[0].0.clone();
    Some(newest.trim_end_matches(".jsonl").to_string())
}

/// Cursor's flattened workspace path: strip leading `/`, drop `.` characters,
/// replace remaining `/` with `-`.
fn flatten_workspace_path(worktree_path: &str) -> String {
    let stripped = worktree_path.trim_start_matches('/');
    stripped.replace('.', "").replace('/', "-")
}

/// Find the latest cursor chatId for a worktree path (newest chatId-named
/// subdirectory under `agent-transcripts`), or `None`. Mirrors
/// `native-chat-id/cursor.ts`'s `findLatestCursorChatId`.
pub async fn find_latest_cursor_chat_id(worktree_path: &str) -> Option<String> {
    let slug = flatten_workspace_path(worktree_path);
    let transcripts_dir = home_dir()
        .join(".cursor")
        .join("projects")
        .join(slug)
        .join("agent-transcripts");
    let entries = fs::read_dir(&transcripts_dir).await.ok()?;
    let mut dirs: Vec<(String, std::time::SystemTime)> = Vec::new();
    let mut rd = entries;
    while let Ok(Some(entry)) = rd.next_entry().await {
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if meta.is_dir() {
            dirs.push((
                entry.file_name().to_string_lossy().into_owned(),
                meta.modified().unwrap_or(std::time::UNIX_EPOCH),
            ));
        }
    }
    if dirs.is_empty() {
        return None;
    }
    dirs.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));
    Some(dirs[0].0.clone())
}

/// `~/.gemini/antigravity-cli/cache/last_conversations.json`
fn agy_last_conversations_path() -> PathBuf {
    home_dir()
        .join(".gemini")
        .join("antigravity-cli")
        .join("cache")
        .join("last_conversations.json")
}

/// Read the latest agy conversation id for a workspace cwd (last-resort
/// fallback only). Mirrors `native-chat-id/agy.ts`'s `readLatestAgyConversationId`.
pub async fn read_latest_agy_conversation_id(cwd: &str) -> Option<String> {
    let raw = fs::read_to_string(agy_last_conversations_path())
        .await
        .ok()?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&raw).ok()?;
    match map.get(cwd) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// The ACP-id → native-id BRIDGE for agy: read the openab `agy-acp` adapter's
/// own session store, keyed by ACP session id. The store path is owned by
/// `vst-agy-acp` (the same one the adapter writes via `AGY_ACP_STATE_DIR`), so
/// the bridge and the adapter can never disagree. Mirrors
/// `native-chat-id/agy.ts`'s `readAgyAcpSessionConversationId`.
pub async fn read_agy_acp_session_conversation_id(acp_session_id: &str) -> Option<String> {
    vst_agy_acp::conversation_id_for_acp_session(acp_session_id)
}
