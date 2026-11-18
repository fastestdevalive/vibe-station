//! Owner tests for the draft-text handle (plan 2.T1, hardened in 4.A.1): scope
//! and client validation, the byte cap, revisions + broadcast, scope existence,
//! concurrent writes, the `SessionDeleted` subscriber and R8 privacy (bodies are
//! never logged). Plain store + broadcaster; no daemon is spawned and no TCP
//! port is bound.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::join_all;
use tempfile::TempDir;

use vst_daemon::draft_text::{DraftTextError, DraftTextHandle, GLOBAL_NEW_SCOPE};
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

const ISO: &str = "2026-01-01T00:00:00.000Z";
const CLIENT: &str = "client-a";

/// Captures formatted `tracing` output for R8 (bodies are never logged).
///
/// Installed as the test binary's ONE global subscriber, not a thread-local
/// one: a `set_default` guard does not rebuild tracing's global interest cache,
/// so a callsite first touched by a subscriber-less test thread (every other
/// test here calls `put`) stays cached as `never` and the capture is flaky.
/// `set_global_default` rebuilds the cache, which makes this deterministic.
#[derive(Clone, Default)]
struct LogBuf(Arc<Mutex<Vec<u8>>>);

impl Write for LogBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> LogBuf {
        self.clone()
    }
}

/// The one global log sink of this test binary (installed lazily, once).
fn logs() -> &'static LogBuf {
    static LOGS: std::sync::OnceLock<LogBuf> = std::sync::OnceLock::new();
    LOGS.get_or_init(|| {
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::DEBUG)
            .finish();
        tracing::subscriber::set_global_default(subscriber)
            .expect("one global log subscriber per test binary");
        buf
    })
}

fn session(id: &str, worktree: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree.map(Into::into),
        project_id: "p1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        account_id: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: true,
        channel: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: ISO.into(),
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

fn worktree(id: &str) -> WorktreeRecord {
    WorktreeRecord {
        id: id.into(),
        name: None,
        branch: format!("feat-{id}"),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "a".repeat(40),
        created_at: ISO.into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: Some(0),
        agent_seq: Some(1),
        lsp_enabled: None,
        sessions: vec![session("s1", Some(id))],
        open_files: vec![],
    }
}

fn project() -> ProjectRecord {
    ProjectRecord {
        id: "p1".into(),
        absolute_path: "/tmp/p1".into(),
        prefix: "vs".into(),
        is_git: false,
        default_branch: None,
        created_at: ISO.into(),
        hidden: None,
        direct_sessions: vec![session("sd1", None)],
        direct_session_seq: Some(1),
        worktrees: vec![worktree("w1")],
        next_worktree_num: Some(2),
        lsp_enabled: None,
        open_files: vec![],
    }
}

struct H {
    _tmp: TempDir,
    store: StoreHandle,
    broadcaster: Broadcaster,
    handle: DraftTextHandle,
}

impl H {
    async fn empty() -> H {
        let tmp = tempfile::tempdir().unwrap();
        let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
        let broadcaster = Broadcaster::new(64);
        let handle = DraftTextHandle::new(store.clone(), broadcaster.clone());
        H {
            _tmp: tmp,
            store,
            broadcaster,
            handle,
        }
    }

    /// `p1` with worktree `w1` (session `s1`) and direct session `sd1`.
    async fn with_project() -> H {
        let h = H::empty().await;
        h.store.add_project(project()).await.unwrap();
        h
    }
}

#[tokio::test]
async fn put_broadcasts_once_with_revision() {
    let h = H::empty().await;
    let mut rx = h.broadcaster.subscribe();

    let doc = h
        .handle
        .put(GLOBAL_NEW_SCOPE, "hello", CLIENT)
        .await
        .unwrap();
    assert_eq!(doc.scope, GLOBAL_NEW_SCOPE);
    assert_eq!(doc.text, "hello");
    assert_eq!(doc.revision, 1);
    assert_eq!(doc.client_id.as_deref(), Some(CLIENT));
    assert!(doc.updated_at.as_deref().unwrap().ends_with('Z'));

    match rx.try_recv().expect("one event per real change") {
        ServerEvent::DraftTextChanged {
            scope,
            text,
            revision,
            updated_at,
            client_id,
        } => {
            assert_eq!(scope, GLOBAL_NEW_SCOPE);
            assert_eq!(text, "hello");
            assert_eq!(revision, 1);
            assert!(updated_at.ends_with('Z'));
            assert_eq!(client_id.as_deref(), Some(CLIENT));
        }
        other => panic!("unexpected event: {other:?}"),
    }
    assert!(rx.try_recv().is_err(), "exactly one event per PUT");

    let doc = h
        .handle
        .put(GLOBAL_NEW_SCOPE, "hello!", CLIENT)
        .await
        .unwrap();
    assert_eq!(doc.revision, 2);
    assert!(rx.try_recv().is_ok());
}

#[tokio::test]
async fn put_unchanged_no_event() {
    let h = H::empty().await;
    h.handle
        .put(GLOBAL_NEW_SCOPE, "same", CLIENT)
        .await
        .unwrap();
    let mut rx = h.broadcaster.subscribe();

    let doc = h
        .handle
        .put(GLOBAL_NEW_SCOPE, "same", "client-b")
        .await
        .unwrap();
    assert_eq!(doc.revision, 1, "unchanged text keeps the revision");
    assert_eq!(doc.client_id.as_deref(), Some(CLIENT), "row untouched");
    assert!(
        rx.try_recv().is_err(),
        "rewriting the stored text must not broadcast"
    );
}

#[tokio::test]
async fn cap_boundary_65536_ok_65537_too_large() {
    let h = H::empty().await;
    let at_cap = "a".repeat(65_536);
    let doc = h
        .handle
        .put(GLOBAL_NEW_SCOPE, &at_cap, CLIENT)
        .await
        .unwrap();
    assert_eq!(doc.revision, 1);

    let over = "a".repeat(65_537);
    assert!(matches!(
        h.handle.put(GLOBAL_NEW_SCOPE, &over, CLIENT).await,
        Err(DraftTextError::TooLarge { limit: 65_536 })
    ));
    assert_eq!(
        h.handle.get(GLOBAL_NEW_SCOPE).await.unwrap().text,
        at_cap,
        "an over-cap PUT writes nothing"
    );
}

#[tokio::test]
async fn cap_counts_utf8_bytes() {
    let h = H::empty().await;
    // "é" is two UTF-8 bytes: 32 768 chars == 65 536 bytes.
    let at_cap = "é".repeat(32_768);
    assert_eq!(at_cap.len(), 65_536);
    assert!(h
        .handle
        .put(GLOBAL_NEW_SCOPE, &at_cap, CLIENT)
        .await
        .is_ok());

    let over = "é".repeat(32_769);
    assert_eq!(over.len(), 65_538);
    assert!(matches!(
        h.handle.put(GLOBAL_NEW_SCOPE, &over, CLIENT).await,
        Err(DraftTextError::TooLarge { .. })
    ));
}

#[tokio::test]
async fn bad_scope_rejected() {
    let h = H::empty().await;
    for scope in ["", "has space", "a/b", "emoji-🙂"] {
        assert!(
            matches!(
                h.handle.put(scope, "t", CLIENT).await,
                Err(DraftTextError::BadScope)
            ),
            "scope {scope:?} must be rejected"
        );
        assert!(matches!(
            h.handle.get(scope).await,
            Err(DraftTextError::BadScope)
        ));
    }
    let too_long = "x".repeat(161);
    assert!(matches!(
        h.handle.put(&too_long, "t", CLIENT).await,
        Err(DraftTextError::BadScope)
    ));
    // 160 chars is inside the grammar: an unknown session, not a bad scope.
    let at_max = "x".repeat(160);
    assert!(matches!(
        h.handle.put(&at_max, "t", CLIENT).await,
        Err(DraftTextError::NotFound)
    ));
}

#[tokio::test]
async fn bad_client_id_rejected_empty_and_65() {
    let h = H::empty().await;
    assert!(matches!(
        h.handle.put(GLOBAL_NEW_SCOPE, "t", "").await,
        Err(DraftTextError::BadClientId)
    ));
    let long = "c".repeat(65);
    assert!(matches!(
        h.handle.put(GLOBAL_NEW_SCOPE, "t", &long).await,
        Err(DraftTextError::BadClientId)
    ));
    let max = "c".repeat(64);
    assert!(h.handle.put(GLOBAL_NEW_SCOPE, "t", &max).await.is_ok());
}

#[tokio::test]
async fn unknown_session_not_found() {
    let h = H::with_project().await;
    assert!(matches!(
        h.handle.put("vs-nope", "t", CLIENT).await,
        Err(DraftTextError::NotFound)
    ));
}

#[tokio::test]
async fn unknown_picker_worktree_not_found() {
    let h = H::with_project().await;
    for scope in [
        "review-picker:worktree:nope",
        "review-picker:project:nope",
        "review-picker:comment:x",
    ] {
        assert!(
            matches!(
                h.handle.put(scope, "t", CLIENT).await,
                Err(DraftTextError::NotFound)
            ),
            "scope {scope:?} must be NotFound"
        );
    }
}

#[tokio::test]
async fn known_picker_worktree_ok() {
    let h = H::with_project().await;
    let doc = h
        .handle
        .put("review-picker:worktree:w1", "review me", CLIENT)
        .await
        .unwrap();
    assert_eq!(doc.revision, 1);
    assert_eq!(doc.scope, "review-picker:worktree:w1");

    let doc = h
        .handle
        .put("review-picker:project:p1", "review me", CLIENT)
        .await
        .unwrap();
    assert_eq!(doc.revision, 1);

    let doc = h.handle.put("s1", "live draft", CLIENT).await.unwrap();
    assert_eq!(doc.revision, 1);
    let doc = h.handle.put("sd1", "direct draft", CLIENT).await.unwrap();
    assert_eq!(doc.revision, 1);
}

#[tokio::test]
async fn global_new_needs_no_check() {
    let h = H::empty().await;
    assert!(h.store.get_all_projects().await.is_empty());
    let doc = h
        .handle
        .put(GLOBAL_NEW_SCOPE, "tier 2 prompt", CLIENT)
        .await
        .unwrap();
    assert_eq!(doc.revision, 1);
}

#[tokio::test]
async fn concurrent_puts_distinct_increasing_revisions() {
    let h = H::empty().await;
    let puts = (0..8).map(|i| {
        let handle = h.handle.clone();
        async move {
            let text = format!("text-{i}");
            handle
                .put(GLOBAL_NEW_SCOPE, &text, CLIENT)
                .await
                .unwrap()
                .revision
        }
    });
    let mut revisions = join_all(puts).await;
    revisions.sort_unstable();
    assert_eq!(revisions, (1..=8).collect::<Vec<_>>());
}

#[tokio::test]
async fn session_deleted_removes_row() {
    let h = H::with_project().await;
    h.handle.put("s1", "draft", CLIENT).await.unwrap();
    assert_eq!(h.handle.get("s1").await.unwrap().revision, 1);

    let subscriber = h.handle.spawn_session_deleted_subscriber();
    h.broadcaster.send(ServerEvent::SessionDeleted {
        session_id: "s1".into(),
    });

    let mut gone = false;
    for _ in 0..200 {
        if h.store.get_draft_text("s1").await.unwrap().is_none() {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    subscriber.abort();
    assert!(gone, "the session's draft row must be deleted");
    // The scope itself still exists, so a GET is the revision-0 empty doc.
    let doc = h.handle.get("s1").await.unwrap();
    assert_eq!(doc.revision, 0);
    assert_eq!(doc.text, "");
}

/// R8: the write path logs `scope` and byte length only — never the body. A
/// unique sentinel makes a leak impossible to miss.
#[tokio::test]
async fn put_logging_never_contains_text() {
    let h = H::empty().await;
    let sentinel = "SENTINEL-draft-body-4a1-do-not-log-9f7c";
    let logs = logs();
    // Other tests in this binary log into the same sink; only our own tail
    // matters (the sentinel and bodies below exist in this test alone).
    let start = logs.0.lock().unwrap().len();

    let doc = h
        .handle
        .put(GLOBAL_NEW_SCOPE, sentinel, CLIENT)
        .await
        .unwrap();
    assert_eq!(doc.text, sentinel);

    // A second, real change logs again; a cleared tombstone too.
    h.handle
        .put(GLOBAL_NEW_SCOPE, "second body", CLIENT)
        .await
        .unwrap();
    h.handle.put(GLOBAL_NEW_SCOPE, "", CLIENT).await.unwrap();

    let text = String::from_utf8(logs.0.lock().unwrap()[start..].to_vec()).unwrap();
    assert!(
        text.contains("draft text written"),
        "expected the write debug line, got: {text}"
    );
    assert!(
        text.contains(GLOBAL_NEW_SCOPE) && text.contains("len="),
        "the log carries the scope and byte length only: {text}"
    );
    assert!(
        !text.contains("SENTINEL"),
        "draft bodies must never be logged: {text}"
    );
    assert!(
        !text.contains("second body"),
        "draft bodies must never be logged: {text}"
    );
}

/// An over-cap PUT is rejected before the store is touched: the row (text,
/// revision, clientId) is untouched and nothing is broadcast.
#[tokio::test]
async fn over_cap_put_writes_nothing() {
    let h = H::empty().await;
    let kept = h
        .handle
        .put(GLOBAL_NEW_SCOPE, "keep me", CLIENT)
        .await
        .unwrap();
    assert_eq!(kept.revision, 1);
    let mut rx = h.broadcaster.subscribe();

    let over = "x".repeat(65_537);
    assert!(matches!(
        h.handle.put(GLOBAL_NEW_SCOPE, &over, "client-b").await,
        Err(DraftTextError::TooLarge { limit: 65_536 })
    ));

    let doc = h.handle.get(GLOBAL_NEW_SCOPE).await.unwrap();
    assert_eq!(doc.text, "keep me", "over-cap text is never stored");
    assert_eq!(doc.revision, 1, "no revision bump");
    assert_eq!(doc.client_id.as_deref(), Some(CLIENT), "clientId untouched");
    assert_eq!(doc.updated_at, kept.updated_at, "updatedAt untouched");
    assert!(rx.try_recv().is_err(), "no event for a rejected PUT");
}
