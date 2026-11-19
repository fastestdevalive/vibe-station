//! Behavior contract for `native_chat_id`: the shared Resume candidate walk
//! (`first_resumable`, `resume_order`) and the per-vendor presence probes.
//! There is deliberately no "newest conversation in the worktree" helper left
//! to test: Resume only ever checks ids this session already owns.

use std::cell::RefCell;
use std::time::{Duration, SystemTime};

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::native_chat_id::{
    agy_conversation_presence, claude_presence, cursor_chat_presence, first_resumable,
    resume_order, Presence,
};

#[tokio::test]
async fn first_resumable_skips_only_missing_and_records_what_it_checked() {
    let probed = RefCell::new(Vec::new());
    let res = first_resumable(["a", "", "a", "b", "c"].map(String::from), |id: String| {
        probed.borrow_mut().push(id.clone());
        async move {
            match id.as_str() {
                "a" => Presence::Missing,
                _ => Presence::Unknown,
            }
        }
    })
    .await;
    assert_eq!(
        res.id.as_deref(),
        Some("b"),
        "Unknown is resumed, not skipped"
    );
    assert_eq!(
        res.checked,
        vec![
            ("a".to_string(), Presence::Missing),
            ("b".to_string(), Presence::Unknown)
        ]
    );
    assert_eq!(
        *probed.borrow(),
        vec!["a", "b"],
        "empty/duplicate ids never probed"
    );

    let none = first_resumable(["x".to_string()], |_| async { Presence::Missing }).await;
    assert_eq!(none.id, None);
}

#[test]
fn resume_order_is_stored_first_unless_the_recorded_one_is_newer() {
    let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
    let t1 = t0 + Duration::from_secs(1);
    let at = |s: Option<SystemTime>, r: Option<SystemTime>| {
        move |id: &str| if id == "s" { s } else { r }
    };
    assert_eq!(
        resume_order(Some("s"), Some("r"), at(Some(t1), Some(t0))),
        ["s", "r"]
    );
    assert_eq!(
        resume_order(Some("s"), Some("r"), at(Some(t0), Some(t1))),
        ["r", "s"]
    );
    // Unknown mtime (either side) keeps the stored id first.
    assert_eq!(
        resume_order(Some("s"), Some("r"), at(None, Some(t1))),
        ["s", "r"]
    );
    assert_eq!(resume_order(Some("s"), Some("s"), at(None, None)), ["s"]);
    assert_eq!(resume_order(None, Some("r"), at(None, None)), ["r"]);
    assert_eq!(
        resume_order(Some(""), None, at(None, None)),
        Vec::<String>::new()
    );
}

#[test]
fn claude_presence_finds_the_transcript_by_id_under_any_project_dir() {
    let dir = tempdir().unwrap();
    let projects = dir.path().join("projects");
    // claude's own slug (not one we would re-derive from any cwd).
    let p = projects.join("-private-var-my-project-wt");
    std::fs::create_dir_all(&p).unwrap();
    std::fs::write(p.join("abc-123.jsonl"), "{}\n").unwrap();
    assert_eq!(claude_presence(&projects, "abc-123"), Presence::Found);
    assert_eq!(claude_presence(&projects, "gone"), Presence::Missing);
    // Not an id: never a path component.
    assert_eq!(claude_presence(&projects, "."), Presence::Missing);
    assert_eq!(claude_presence(&projects, "../x"), Presence::Missing);
    // No projects dir at all: claude never wrote a transcript there.
    assert_eq!(
        claude_presence(&dir.path().join("nope"), "abc-123"),
        Presence::Missing
    );
}

#[cfg(unix)]
#[test]
fn claude_presence_is_unknown_when_the_projects_dir_is_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let projects = dir.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable = std::fs::read_dir(&projects).is_ok(); // root ignores modes
    let got = claude_presence(&projects, "abc-123");
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
    if !readable {
        assert_eq!(got, Presence::Unknown);
    }
}

#[tokio::test]
async fn cursor_missing_only_when_the_cli_chat_store_was_read() {
    let home = tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    // Only the IDE's projects dir exists: not proof the CLI store was read.
    std::fs::create_dir_all(home.path().join(".cursor/projects/repo/agent-transcripts")).unwrap();
    assert_eq!(cursor_chat_presence("chat-1").await, Presence::Unknown);
    // ...but a transcript there is positive evidence.
    std::fs::create_dir_all(
        home.path()
            .join(".cursor/projects/repo/agent-transcripts/chat-1"),
    )
    .unwrap();
    assert_eq!(cursor_chat_presence("chat-1").await, Presence::Found);
    // The CLI's own chat store, readable and without the id: a definite miss.
    std::fs::create_dir_all(home.path().join(".cursor/chats/ws-hash/chat-2")).unwrap();
    assert_eq!(cursor_chat_presence("chat-2").await, Presence::Found);
    assert_eq!(cursor_chat_presence("chat-3").await, Presence::Missing);
}

#[tokio::test]
async fn agy_presence_found_missing_unknown() {
    let home = tempdir().unwrap();
    let _guard = with_home(home.path().to_path_buf());
    assert_eq!(agy_conversation_presence("c1").await, Presence::Unknown);
    let conv = home.path().join(".gemini/antigravity-cli/conversations");
    std::fs::create_dir_all(&conv).unwrap();
    assert_eq!(agy_conversation_presence("c1").await, Presence::Missing);
    std::fs::write(conv.join("c1.db"), b"").unwrap();
    assert_eq!(agy_conversation_presence("c1").await, Presence::Found);
    assert_eq!(agy_conversation_presence("c1.db").await, Presence::Missing);
}
