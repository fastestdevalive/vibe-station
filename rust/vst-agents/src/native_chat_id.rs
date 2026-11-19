//! Which conversation a Terminal Resume may hand back to the CLI.
//!
//! Every helper here checks a chat id the daemon already knows about — the
//! session's stored `agent_chat_id`, or an id THIS session's own hook / log
//! recorded — against the CLI's own on-disk store, by id. Nothing here ever
//! guesses "the newest conversation in the worktree": that is whichever
//! sibling agent wrote last, not this session's.
//!
//! - [`Presence`] / [`first_resumable`]: the shared candidate walk. Only a
//!   definite [`Presence::Missing`] skips a candidate; an unreadable store is
//!   [`Presence::Unknown`] and is resumed rather than silently dropped.
//! - [`resume_order`]: the one candidate order claude and codex share.
//! - One probe per vendor store: [`claude_presence`] (on
//!   [`crate::claude_import::find_claude_conversation`]),
//!   [`agy_conversation_presence`], [`cursor_chat_presence`].
//!
//! See `AGENTS.md` § Agent plugin "The two session identities (ACP)".

use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tokio::fs;

use crate::home::home_dir;

/// Whether a CLI's own store still has a conversation, as far as we can tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    /// The store holds the id.
    Found,
    /// The store was read and does not hold the id: resuming it would fail.
    Missing,
    /// The store could not be read (permissions, I/O error, unverified layout).
    Unknown,
}

/// The outcome of [`first_resumable`]: the id to resume (if any) and what each
/// probed candidate turned out to be (ids only, for logging).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Resolution {
    pub id: Option<String>,
    pub checked: Vec<(String, Presence)>,
}

impl Resolution {
    /// Logs a quiet fall-back to a fresh launch (ids only; never paths/bodies).
    /// No-op when an id was chosen or there was nothing to check.
    pub fn log_fresh_launch(&self, cli: &str, session_id: &str) {
        if self.id.is_some() || self.checked.is_empty() {
            return;
        }
        tracing::info!(
            cli,
            session_id,
            checked = ?self.checked,
            "resume: no candidate conversation is on disk, launching fresh"
        );
    }
}

/// The first candidate whose conversation is not definitely gone. Empty and
/// duplicate ids are dropped; only [`Presence::Missing`] skips a candidate, so
/// an [`Presence::Unknown`] store errs on the side of resuming.
pub async fn first_resumable<I, F, Fut>(candidates: I, mut probe: F) -> Resolution
where
    I: IntoIterator<Item = String>,
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Presence>,
{
    let mut out = Resolution::default();
    for id in candidates {
        if id.is_empty() || out.checked.iter().any(|(seen, _)| *seen == id) {
            continue;
        }
        let presence = probe(id.clone()).await;
        out.checked.push((id.clone(), presence));
        if presence != Presence::Missing {
            out.id = Some(id);
            break;
        }
    }
    out
}

/// The one candidate order for a CLI with both a stored `agent_chat_id` and a
/// hook- or log-recorded id (claude, codex, agy): **stored first**, unless both
/// conversations exist and the recorded one was written more recently.
///
/// Why: the stored id is the persisted identity the daemon owns (Rich Chat
/// moves it), while the hook's token file is only deleted by
/// `capture_chat_id` and can be stale — after a Rich Chat run, a json→tty
/// switch would otherwise resume the older terminal conversation. But the hook
/// rewrites the token on `/clear` (a new conversation inside the same pane),
/// which the stored id never sees. The two requirements conflict exactly when
/// both conversations exist; then the one the user touched last (newer
/// transcript mtime) is the one they were in. `modified` is only called when
/// both ids are present and differ.
pub fn resume_order(
    stored: Option<&str>,
    recorded: Option<&str>,
    modified: impl Fn(&str) -> Option<SystemTime>,
) -> Vec<String> {
    let stored = stored.filter(|s| !s.is_empty());
    let recorded = recorded.filter(|r| !r.is_empty());
    match (stored, recorded) {
        (Some(s), Some(r)) if s != r => match (modified(s), modified(r)) {
            (Some(ms), Some(mr)) if mr > ms => vec![r.to_string(), s.to_string()],
            _ => vec![s.to_string(), r.to_string()],
        },
        (s, r) => s.or(r).map(str::to_string).into_iter().collect(),
    }
}

/// `<account>/projects` for an account folder (`CLAUDE_CONFIG_DIR`, Decision
/// 6), else the System login's `~/.claude/projects`.
pub fn claude_projects_dir(account_dir: Option<&Path>) -> PathBuf {
    match account_dir {
        Some(dir) => dir.join("projects"),
        None => home_dir().join(".claude").join("projects"),
    }
}

/// Whether claude still has a transcript for `id` (`claude --resume <id>`
/// with none prints "No conversation found" and exits 1). Located by chat id
/// through [`crate::claude_import::find_claude_conversation`], never a
/// re-derived slug. Blocking: call from `spawn_blocking`.
///
/// A projects dir that does not exist means claude never wrote a transcript
/// there (`Missing`); one that cannot be read is `Unknown`.
pub fn claude_presence(projects_dir: &Path, id: &str) -> Presence {
    if !is_safe_id(id) {
        return Presence::Missing;
    }
    match std::fs::read_dir(projects_dir) {
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Presence::Missing,
        Err(_) => return Presence::Unknown,
    }
    match crate::claude_import::find_claude_conversation(projects_dir, id) {
        Some(_) => Presence::Found,
        None => Presence::Missing,
    }
}

/// mtime of claude's transcript for `id`, if it exists. Blocking.
pub fn claude_transcript_modified(projects_dir: &Path, id: &str) -> Option<SystemTime> {
    let path = crate::claude_import::find_claude_conversation(projects_dir, id)?;
    std::fs::metadata(path).ok()?.modified().ok()
}

/// Whether cursor-agent still has chat `id`, for `--resume <id>`.
///
/// UNVERIFIED layout (binary absent, V6). `Missing` only when the CLI's own
/// chat store `~/.cursor/chats/<workspace-hash>/<id>` was fully read and no
/// workspace holds the id. `~/.cursor/projects/*/agent-transcripts/<id>` (also
/// written by the IDE) only ever counts as positive evidence, never as proof
/// the CLI store was read. Anything else is `Unknown`.
pub async fn cursor_chat_presence(id: &str) -> Presence {
    if !is_safe_id(id) {
        return Presence::Missing;
    }
    let cursor = home_dir().join(".cursor");
    let chats = scan_for_entry(&cursor.join("chats"), id, |ws, id| ws.join(id)).await;
    if chats == Presence::Found {
        return Presence::Found;
    }
    let projects = scan_for_entry(&cursor.join("projects"), id, |p, id| {
        p.join("agent-transcripts").join(id)
    })
    .await;
    if projects == Presence::Found {
        return Presence::Found;
    }
    match chats {
        Presence::Missing => Presence::Missing,
        _ => Presence::Unknown,
    }
}

/// For every entry `e` of `root`, whether `path(e, id)` exists. A `root` that
/// cannot be listed, a mid-scan listing error, or a probe error other than
/// "not found" makes the answer `Unknown` rather than a definite miss.
async fn scan_for_entry(root: &Path, id: &str, path: impl Fn(&Path, &str) -> PathBuf) -> Presence {
    let Ok(mut rd) = fs::read_dir(root).await else {
        return Presence::Unknown;
    };
    let mut unsure = false;
    loop {
        match rd.next_entry().await {
            Ok(Some(entry)) => match fs::metadata(path(&entry.path(), id)).await {
                Ok(_) => return Presence::Found,
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(_) => unsure = true,
            },
            Ok(None) => break,
            Err(_) => return Presence::Unknown,
        }
    }
    if unsure {
        Presence::Unknown
    } else {
        Presence::Missing
    }
}

/// Whether agy still has conversation `id`, for `agy --conversation <id>`:
/// `~/.gemini/antigravity-cli/conversations/<id>.db` (the conversation store)
/// or `brain/<id>/` (its transcript/artifact dir). agy ships without accounts
/// (V9), so the store is always under the home `~/.gemini`. `Missing` only
/// when a store dir is readable and neither path exists.
pub async fn agy_conversation_presence(id: &str) -> Presence {
    if !is_safe_id(id) {
        return Presence::Missing;
    }
    let root = home_dir().join(".gemini").join("antigravity-cli");
    let conversations = root.join("conversations");
    let brain = root.join("brain");
    let mut unsure = false;
    for (path, want_dir) in [
        (conversations.join(format!("{id}.db")), false),
        (brain.join(id), true),
    ] {
        match fs::metadata(&path).await {
            Ok(m) if m.is_dir() == want_dir => return Presence::Found,
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(_) => unsure = true,
        }
    }
    let readable = fs::read_dir(&conversations).await.is_ok() || fs::read_dir(&brain).await.is_ok();
    if readable && !unsure {
        Presence::Missing
    } else {
        Presence::Unknown
    }
}

/// mtime of agy's conversation `id` (`conversations/<id>.db`, else
/// `brain/<id>`), if it exists.
pub async fn agy_conversation_modified(id: &str) -> Option<SystemTime> {
    if !is_safe_id(id) {
        return None;
    }
    let root = home_dir().join(".gemini").join("antigravity-cli");
    for path in [
        root.join("conversations").join(format!("{id}.db")),
        root.join("brain").join(id),
    ] {
        if let Ok(t) = fs::metadata(&path).await.and_then(|m| m.modified()) {
            return Some(t);
        }
    }
    None
}

/// An id usable as one path component: non-empty `[A-Za-z0-9_-]+` (rejects
/// `.`, `..`, separators and anything else a vendor id never contains).
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

pub(crate) fn extract_codex_thread_id(filename: &str) -> Option<String> {
    let stem = filename.strip_suffix(".jsonl")?;
    if stem.len() >= 36 {
        // `get`, not slicing: a non-ASCII filename must not panic on a char boundary.
        if let Some(candidate) = stem.get(stem.len() - 36..) {
            if is_uuid(candidate) {
                return Some(candidate.to_string());
            }
        }
    }
    None
}
