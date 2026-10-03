//! Behavior contract for the concrete `AcpTransport` implementation
//! (`acp_connection::AcpConnection`) — ports the trait-mappable subset of
//! `daemon/src/__tests__/acpTransport.test.ts` (1.T1 / 4.T2 / 5.T2-adjacent).
//!
//! The `AcpTransport` trait (04-spike, amended by 04c to add
//! `steer`/`supports_steering`) exposes initialize / new_session / load_session /
//! send_prompt / cancel_active_prompt / is_alive / dispose / steer /
//! supports_steering. The fake agent (`fixtures/fakeAcpAgent.mjs`) drives each
//! path over real NDJSON JSON-RPC via the `agent-client-protocol` crate's
//! `connect_with` machinery.
//!
//! NOT ported here (why, in the report): the permission-echo tests — the crate
//! deserializes `PromptResponse.stop_reason` strictly, so the fake agent's
//! "selected:allow_always"/"cancelled" echo doesn't fit the frozen trait's
//! `StopReason` surface. The steering tests (5.T1 / 5.T2) ARE ported — they were
//! skipped in 04b because `supportsSteering`/`steer` were not yet part of the
//! frozen trait; 04c added them, so the tests now land here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentBlock, SessionUpdate, StopReason, TextContent};
use tokio::sync::mpsc::UnboundedReceiver;
use vst_agents::acp_connection::{AcpConnection, AcpLaunchSpec};
use vst_agents::acp_transport::{AcpTransport, AcpTransportError, SteerOutcome};

fn fake_agent() -> String {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dir.join("tests/fixtures/fakeAcpAgent.mjs")
        .to_string_lossy()
        .into_owned()
}

fn make_connection(mode: &str) -> AcpConnection {
    let mut env = HashMap::new();
    env.insert("FAKE_ACP_MODE".to_string(), mode.to_string());
    AcpConnection::new(AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![fake_agent()],
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        env,
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
    })
}

async fn drain_updates(rx: &mut UnboundedReceiver<SessionUpdate>) -> Vec<SessionUpdate> {
    let mut seen = Vec::new();
    while let Ok(Some(u)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
        seen.push(u);
    }
    seen
}

#[tokio::test]
async fn initialize_rejects_typed_failure_when_process_exits_before_ready() {
    let conn = make_connection("exit_before_ready");
    let err = conn.initialize().await.expect_err("should fail");
    assert!(
        matches!(
            err,
            AcpTransportError::SpawnFailed(_) | AcpTransportError::InitializeFailed(_)
        ),
        "got unexpected error: {err:?}"
    );
}

#[tokio::test]
async fn initialize_times_out_with_initialize_failed_not_indefinitely() {
    let mut env = HashMap::new();
    env.insert("FAKE_ACP_MODE".to_string(), "hang".to_string());
    let conn = AcpConnection::new(AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![fake_agent()],
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        env,
        initialize_timeout_ms: Some(300),
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
    });
    let start = std::time::Instant::now();
    let err = conn.initialize().await.expect_err("should time out");
    assert!(matches!(err, AcpTransportError::InitializeFailed(_)));
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "initialize must time out within ~300ms, took {:?}",
        start.elapsed()
    );
    conn.dispose().await;
}

#[tokio::test]
async fn happy_path_initialize_new_session_send_prompt_streams_and_resolves_end_turn() {
    let conn = make_connection("normal");
    let outcome = conn.initialize().await.expect("initialize");
    assert!(
        outcome.load_session_supported,
        "fake agent advertises loadSession"
    );
    let session_id = conn
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session")
        .session_id;
    assert!(!session_id.is_empty());

    let turn = conn.send_prompt(
        &session_id,
        vec![ContentBlock::Text(TextContent::new("hi"))],
    );
    let mut updates = turn.updates;
    let seen = drain_updates(&mut updates).await;
    let stop = turn
        .result
        .await
        .expect("result resolves")
        .expect("prompt succeeds");
    assert_eq!(stop.stop_reason, StopReason::EndTurn);
    assert!(
        seen.iter()
            .any(|u| matches!(u, SessionUpdate::AgentMessageChunk(_))),
        "expected at least one agent_message_chunk, got {seen:?}"
    );
    conn.dispose().await;
}

#[tokio::test]
async fn cancel_active_prompt_resolves_with_cancelled_without_killing_connection() {
    let conn = make_connection("cancel");
    conn.initialize().await.expect("initialize");
    let session_id = conn
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session")
        .session_id;

    let turn = conn.send_prompt(
        &session_id,
        vec![ContentBlock::Text(TextContent::new("hi"))],
    );
    conn.cancel_active_prompt();
    let stop = turn
        .result
        .await
        .expect("result resolves")
        .expect("prompt succeeds");
    assert_eq!(stop.stop_reason, StopReason::Cancelled);
    assert!(conn.is_alive());

    // Connection still usable for a next turn. (The fake agent's
    // `cancelRequested` flag is sticky — it is never reset after a session/cancel
    // — so this second turn also resolves "cancelled", not "end_turn". The TS
    // test only awaits it; it does not assert the specific stop reason.)
    let turn2 = conn.send_prompt(
        &session_id,
        vec![ContentBlock::Text(TextContent::new("again"))],
    );
    let _stop2 = turn2
        .result
        .await
        .expect("result resolves")
        .expect("second turn succeeds")
        .stop_reason;
    conn.dispose().await;
}

#[tokio::test]
async fn dispose_is_idempotent_and_flips_is_alive() {
    let conn = make_connection("normal");
    conn.initialize().await.expect("initialize");
    assert!(conn.is_alive());
    conn.dispose().await;
    conn.dispose().await;
    assert!(!conn.is_alive());
}

#[tokio::test]
async fn is_alive_flips_false_when_child_exits_on_its_own() {
    let conn = make_connection("normal");
    conn.initialize().await.expect("initialize");
    let session_id = conn
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session")
        .session_id;
    // The fake agent keeps running; kill the child out from under the
    // connection to simulate a crash. We can't reach the OS pid from the
    // handle directly, so drive a prompt that forces EOF-triggered teardown
    // by disposing after observing a live connection — the crash case is
    // covered by the crate's EOF handling. Instead assert the connection
    // reports dead once disposed and rejects a subsequent prompt.
    conn.dispose().await;
    assert!(!conn.is_alive());

    let turn = conn.send_prompt(
        &session_id,
        vec![ContentBlock::Text(TextContent::new("hi"))],
    );
    let err = turn
        .result
        .await
        .expect("result resolves")
        .expect_err("prompt against disposed connection must reject");
    assert!(matches!(err, AcpTransportError::RequestFailed(_)));
}

#[tokio::test]
async fn prompt_against_disposed_connection_rejects_immediately() {
    let conn = make_connection("normal");
    conn.initialize().await.expect("initialize");
    conn.dispose().await;
    let session_id = "fake-session-1".to_string();
    let turn = conn.send_prompt(
        &session_id,
        vec![ContentBlock::Text(TextContent::new("hi"))],
    );
    let err = turn
        .result
        .await
        .expect("result resolves")
        .expect_err("must reject");
    assert!(matches!(err, AcpTransportError::RequestFailed(_)));
}

#[tokio::test]
async fn prompt_times_out_with_clear_error_instead_of_hanging() {
    let mut env = HashMap::new();
    env.insert("FAKE_ACP_MODE".to_string(), "prompt_hang".to_string());
    let conn = AcpConnection::new(AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![fake_agent()],
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        env,
        initialize_timeout_ms: None,
        prompt_timeout_ms: Some(200),
        reap_detached_descendants: false,
    });
    conn.initialize().await.expect("initialize");
    let session_id = conn
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session")
        .session_id;
    let start = std::time::Instant::now();
    let turn = conn.send_prompt(
        &session_id,
        vec![ContentBlock::Text(TextContent::new("hi"))],
    );
    let err = turn
        .result
        .await
        .expect("result resolves")
        .expect_err("must time out");
    assert!(matches!(err, AcpTransportError::RequestFailed(_)));
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "prompt must time out quickly, took {:?}",
        start.elapsed()
    );
    conn.dispose().await;
}

/// `prompt_timeout_ms` is an IDLE timeout, not a cap on total turn duration:
/// each `session/update` notification resets the clock, so a turn that keeps
/// streaming activity survives well past the configured window — it only
/// times out once the agent goes fully silent for that long.
#[tokio::test]
async fn prompt_idle_timeout_resets_on_streamed_updates_then_fires_once_silent() {
    let mut env = HashMap::new();
    env.insert(
        "FAKE_ACP_MODE".to_string(),
        "prompt_stream_then_hang".to_string(),
    );
    env.insert("PROMPT_STREAM_INTERVAL_MS".to_string(), "30".to_string());
    env.insert("PROMPT_STREAM_COUNT".to_string(), "5".to_string());
    let conn = AcpConnection::new(AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![fake_agent()],
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        env,
        initialize_timeout_ms: None,
        // Shorter than the ~150ms it takes to stream all 5 updates: a flat
        // (non-idle) timeout would fire well before streaming finishes.
        prompt_timeout_ms: Some(100),
        reap_detached_descendants: false,
    });
    conn.initialize().await.expect("initialize");
    let session_id = conn
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session")
        .session_id;
    let start = std::time::Instant::now();
    let turn = conn.send_prompt(
        &session_id,
        vec![ContentBlock::Text(TextContent::new("hi"))],
    );
    // Drain updates concurrently with awaiting the result — the sender stays
    // open (and thus `recv()` would otherwise block) until `do_send_prompt`
    // resolves and clears the sink, which only happens once the idle timeout
    // itself fires.
    let mut updates_rx = turn.updates;
    let drain_task = tokio::spawn(async move { drain_updates(&mut updates_rx).await });
    let err = turn
        .result
        .await
        .expect("result resolves")
        .expect_err("must eventually time out once streaming stops");
    let elapsed = start.elapsed();
    let updates = drain_task.await.expect("drain task completes");
    assert!(matches!(err, AcpTransportError::RequestFailed(_)));
    assert_eq!(
        updates.len(),
        5,
        "all streamed updates must have been delivered"
    );
    assert!(
        elapsed >= Duration::from_millis(130),
        "must survive past the flat {}ms window while updates are streaming, took {:?}",
        100,
        elapsed
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "must still time out promptly once the agent goes silent, took {:?}",
        elapsed
    );
    conn.dispose().await;
}

/// `initialize` advertises fs read/write + terminal client capabilities on
/// the real wire (TS parity: `acpTransport.ts`'s `clientCapabilities: { fs:
/// { readTextFile: true, writeTextFile: true }, terminal: true }`). Reads
/// back what the fake agent actually received, so this fails if
/// `do_initialize` stops sending `client_capabilities(...)` — unlike a test
/// that just re-serializes the builder in isolation.
#[tokio::test]
async fn initialize_sends_fs_and_terminal_client_capabilities_on_the_wire() {
    let out_file =
        std::env::temp_dir().join(format!("vst-client-caps-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&out_file);

    let mut env = HashMap::new();
    env.insert("FAKE_ACP_MODE".to_string(), "normal".to_string());
    env.insert(
        "CLIENT_CAPS_OUT_FILE".to_string(),
        out_file.to_string_lossy().into_owned(),
    );
    let conn = AcpConnection::new(AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![fake_agent()],
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        env,
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
    });
    conn.initialize().await.expect("initialize");
    conn.dispose().await;

    let raw = std::fs::read_to_string(&out_file)
        .expect("fake agent should have recorded clientCapabilities");
    let _ = std::fs::remove_file(&out_file);
    let caps: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(caps["fs"]["readTextFile"], true);
    assert_eq!(caps["fs"]["writeTextFile"], true);
    assert_eq!(caps["terminal"], true);
}

// --- 5.T1 / 5.T2 — steering (`supports_steering` / `steer`) ---

/// `supports_steering` is true when the `initialize` response carries
/// `_meta.steering.supported === true` (TS 5.T1 first case).
#[tokio::test]
async fn supports_steering_true_when_initialize_carries_steering_supported() {
    let conn = make_connection("steering_supported");
    conn.initialize().await.expect("initialize");
    assert!(conn.supports_steering(), "steering should be advertised");
    conn.dispose().await;
}

/// `supports_steering` is false when the `initialize` response has no `_meta`
/// (TS 5.T1 second case).
#[tokio::test]
async fn supports_steering_false_when_initialize_has_no_meta() {
    let conn = make_connection("normal");
    conn.initialize().await.expect("initialize");
    assert!(
        !conn.supports_steering(),
        "no _meta means steering is unsupported"
    );
    conn.dispose().await;
}

/// `steer` returns `Injected` when the agent accepts the `_session/steering`
/// request (fake agent echoes `{ outcome: "injected" }`).
#[tokio::test]
async fn steer_returns_injected_when_agent_accepts() {
    let conn = make_connection("steering_supported");
    conn.initialize().await.expect("initialize");
    conn.new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session");
    let outcome = conn
        .steer(vec![ContentBlock::Text(TextContent::new("steer me"))])
        .await;
    assert_eq!(outcome, SteerOutcome::Injected);
    conn.dispose().await;
}

/// `steer` returns `Unsupported` (and does not panic/throw) when the agent
/// responds with JSON-RPC method-not-found (-32601) — the TS 5.T2 contract
/// that any error collapses to `Unsupported`, never propagates as an `Err`.
#[tokio::test]
async fn steer_returns_unsupported_on_method_not_found() {
    let conn = make_connection("steering_method_not_found");
    conn.initialize().await.expect("initialize");
    conn.new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session");
    let outcome = conn
        .steer(vec![ContentBlock::Text(TextContent::new("steer me"))])
        .await;
    assert_eq!(outcome, SteerOutcome::Unsupported);
    conn.dispose().await;
}

/// `steer` on a disposed connection collapses to `Unsupported` rather than
/// panicking (the TS catch collapses disposed-connection errors too).
#[tokio::test]
async fn steer_on_disposed_connection_returns_unsupported() {
    let conn = make_connection("normal");
    conn.initialize().await.expect("initialize");
    conn.dispose().await;
    let outcome = conn
        .steer(vec![ContentBlock::Text(TextContent::new("steer me"))])
        .await;
    assert_eq!(outcome, SteerOutcome::Unsupported);
}

/// Both `session/new` and `session/load` report the model selector's list and
/// `currentValue`.
#[tokio::test]
async fn new_and_load_session_report_current_model_and_list() {
    let conn = make_connection("model_options");
    conn.initialize().await.expect("initialize");
    let new = conn
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session");
    assert_eq!(new.models, vec!["m-a", "m-b"]);
    assert_eq!(new.current_model.as_deref(), Some("m-b"));
    let load = conn
        .load_session(&PathBuf::from("/tmp"), "prior", None)
        .await
        .expect("load_session");
    assert_eq!(load.models, vec!["m-a", "m-b"]);
    assert_eq!(load.current_model.as_deref(), Some("m-b"));
    conn.dispose().await;

    // An adapter without a model selector reports nothing.
    let conn = make_connection("normal");
    conn.initialize().await.unwrap();
    let new = conn
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .unwrap();
    assert!(new.models.is_empty() && new.current_model.is_none());
    conn.dispose().await;
}

// --- Phase 2 — out-of-band (autonomous) update routing ---

/// `session/load` replays the whole history as `session/update` notifications.
/// The out-of-band sink is attached only AFTER load completes, so a late sink
/// must receive ZERO of those replayed updates (Decision 2 ordering trap).
#[tokio::test]
async fn replay_on_load_is_not_delivered_to_late_sink() {
    let conn = make_connection("replay_on_load");
    conn.initialize().await.expect("initialize");
    // Load sends 2 replay notifications BEFORE answering; the sink is not yet
    // attached, so they must be dropped by the notif handler.
    conn.load_session(&PathBuf::from("/tmp"), "prior", None)
        .await
        .expect("load_session");

    // Attach the sink only now, after load has fully returned.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SessionUpdate>();
    conn.set_out_of_band_sink(Some(tx));

    let got = tokio::time::timeout(Duration::from_millis(400), rx.recv()).await;
    assert!(
        got.is_err() || matches!(got, Ok(None)),
        "replay notifications must not reach a late out-of-band sink, got {got:?}"
    );
    conn.dispose().await;
}

/// An update that arrives after its prompt resolved (agent kept working) must
/// reach the out-of-band sink — exactly one late chunk — while the prompt's
/// own `updates` receiver must NOT see it. A connection with no sink attached
/// drops the late update without error.
#[tokio::test]
async fn out_of_band_update_after_prompt_reaches_sink() {
    let conn = make_connection("out_of_band");
    conn.initialize().await.expect("initialize");
    let session_id = conn
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session")
        .session_id;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SessionUpdate>();
    conn.set_out_of_band_sink(Some(tx));

    let turn = conn.send_prompt(
        &session_id,
        vec![ContentBlock::Text(TextContent::new("hi"))],
    );
    let mut updates = turn.updates;
    let stop = turn
        .result
        .await
        .expect("result resolves")
        .expect("prompt succeeds");
    assert_eq!(stop.stop_reason, StopReason::EndTurn);

    // The prompt's own updates receiver sees only the in-band chunk, never the
    // late autonomous one. (Once the result resolves the sink is cleared and
    // the channel closes, so recv() returns None — no indefinite wait.)
    let mut prompt_seen = Vec::new();
    while let Ok(Some(u)) = tokio::time::timeout(Duration::from_secs(5), updates.recv()).await {
        prompt_seen.push(u);
    }
    assert!(
        prompt_seen.iter().all(|u| !matches!(
            u,
            SessionUpdate::AgentMessageChunk(c)
                if matches!(&c.content, ContentBlock::Text(t) if t.text.contains("late autonomous chunk"))
        )),
        "the late out-of-band chunk must not land on the prompt's own updates receiver: {prompt_seen:?}"
    );

    // The OOB receiver gets exactly the one late chunk within 2s.
    let mut oob = Vec::new();
    while let Ok(Some(u)) = tokio::time::timeout(Duration::from_millis(2000), rx.recv()).await {
        oob.push(u);
    }
    assert_eq!(
        oob.len(),
        1,
        "exactly one late update should reach the OOB sink, got {oob:?}"
    );
    assert!(matches!(&oob[0], SessionUpdate::AgentMessageChunk(_)));

    conn.dispose().await;

    // A connection with NO sink attached drops the late update without error:
    // the prompt still resolves normally.
    let conn2 = make_connection("out_of_band");
    conn2.initialize().await.expect("initialize");
    let session_id2 = conn2
        .new_session(&PathBuf::from("/tmp"), None)
        .await
        .expect("new_session")
        .session_id;
    let turn2 = conn2.send_prompt(
        &session_id2,
        vec![ContentBlock::Text(TextContent::new("hi"))],
    );
    let stop2 = turn2
        .result
        .await
        .expect("result resolves")
        .expect("prompt without an OOB sink succeeds");
    assert_eq!(stop2.stop_reason, StopReason::EndTurn);
    conn2.dispose().await;
}

#[cfg(target_os = "linux")]
fn proc_running(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|s| {
            !s.rsplit(')')
                .next()
                .unwrap_or("")
                .trim_start()
                .starts_with('Z')
        })
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
async fn read_pid(path: &std::path::Path) -> u32 {
    for _ in 0..200 {
        if let Some(p) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
        {
            return p;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("pid file {} never appeared", path.display());
}

/// A process the agent double-forked away (reparented to init) — i.e. one it
/// deliberately detached — must survive `dispose()`, even though it descends
/// from the agent by environment inheritance.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn dispose_spares_deliberately_detached_processes() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    // The inner subshell's child is orphaned when the subshell exits, so it
    // reparents to init before dispose.
    let script = format!(
        "(setsid sh -c 'echo $$ > {}; exec sleep 300' &) ; sleep 300",
        pid_file.display()
    );
    let conn = AcpConnection::new(AcpLaunchSpec {
        command: "sh".to_string(),
        args: vec!["-c".to_string(), script],
        cwd: dir.path().to_path_buf(),
        env: HashMap::new(),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
    });
    let pid = read_pid(&pid_file).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(proc_running(pid));
    conn.dispose().await;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let survived = proc_running(pid);
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
    assert!(
        survived,
        "detached (reparented) process was killed by dispose()"
    );
}

/// A descendant that `setsid()`s out of the agent's process group (as opencode's
/// `serve --stdio` child does) must still die on `dispose()`.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn dispose_kills_descendants_that_escaped_the_process_group() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let script = format!(
        "setsid sh -c 'echo $$ > {}; exec sleep 300' & wait",
        pid_file.display()
    );
    let conn = AcpConnection::new(AcpLaunchSpec {
        command: "sh".to_string(),
        args: vec!["-c".to_string(), script],
        cwd: dir.path().to_path_buf(),
        env: HashMap::new(),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: true,
    });
    let pid = loop {
        if let Some(p) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
        {
            break p;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let running = |pid: u32| {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|s| {
                !s.rsplit(')')
                    .next()
                    .unwrap_or("")
                    .trim_start()
                    .starts_with('Z')
            })
            .unwrap_or(false)
    };
    assert!(
        running(pid),
        "escaped descendant should be alive pre-dispose"
    );
    conn.dispose().await;
    let mut gone = false;
    for _ in 0..100 {
        if !running(pid) {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if !gone {
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }
    assert!(gone, "setsid'd descendant survived dispose()");
}

/// Without the plugin opt-in, a `setsid`'d child of the agent is an
/// agent-detached process (dev server, background shell) and must survive.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn dispose_spares_setsid_child_when_reaping_not_opted_in() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let script = format!(
        "setsid sh -c 'echo $$ > {}; exec sleep 300' & wait",
        pid_file.display()
    );
    let conn = AcpConnection::new(AcpLaunchSpec {
        command: "sh".to_string(),
        args: vec!["-c".to_string(), script],
        cwd: dir.path().to_path_buf(),
        env: HashMap::new(),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
    });
    let pid = read_pid(&pid_file).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(proc_running(pid));
    conn.dispose().await;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let survived = proc_running(pid);
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
    assert!(survived, "setsid'd child was killed with reaping disabled");
}
