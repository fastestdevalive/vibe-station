//! Behavior contract for the `run_turn` bridge — ports
//! `daemon/src/agent-plugins/{claude,cursor,opencode,agy}.ts`'s `runTurn` /
//! `runTurnAcp` and `services/spawn.ts`'s `TurnInput`/`TurnContext`.
//!
//! The ACP turn is driven over the shared free function
//! [`vst_agents::acp_run_turn::run_turn_acp`] (NOT duplicated per plugin, as
//! the TS does 4x), parameterized by a per-plugin [`RunTurnAcpParams`]. Each
//! plugin's [`AgentPlugin::run_turn`] is a thin wrapper that spawns
//! `run_turn_acp` and returns an `mpsc::UnboundedReceiver<NormalizedEvent>`.
//!
//! The frozen `AcpTransport` trait is NOT dyn-compatible (it uses `impl
//! Future` return types), so `TurnContext.get_acp_connection` returns the
//! concrete [`AcpConnection`] and tests drive a real connection against the
//! fake NDJSON agent (`fixtures/fakeAcpAgent.mjs`), exactly like
//! `tests/acp_transport.rs`.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::ContentBlock;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use vst_agents::acp_connection::{AcpConnection, AcpLaunchSpec};
use vst_agents::acp_run_turn::{run_turn_acp, RunTurnAcpParams};
use vst_agents::acp_transport::{AcpTransport, AcpTransportError};
use vst_agents::plugin::{GetAcpConnection, TurnContext, TurnInput};
use vst_types::{NormalizedEvent, NormalizedEventKind, NormalizedEventProvider};

fn fake_agent() -> String {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dir.join("tests/fixtures/fakeAcpAgent.mjs")
        .to_string_lossy()
        .into_owned()
}

fn spec_for(mode: &str) -> AcpLaunchSpec {
    AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![fake_agent()],
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        env: HashMap::from([("FAKE_ACP_MODE".to_string(), mode.to_string())]),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
    }
}

/// Build a `TurnContext` whose `get_acp_connection` creates a real
/// `AcpConnection` from the given spec, ESTABLISHES the ACP session
/// (initialize + session/new — the same setup the real JsonAgentSession's
/// `get_or_create_connection` does before handing the ready connection to
/// `run_turn_acp`), and captures a clone (for the test to `dispose`).
fn ctx_with_spec(spec: AcpLaunchSpec) -> (TurnContext, Arc<Mutex<Option<AcpConnection>>>) {
    let captured: Arc<Mutex<Option<AcpConnection>>> = Arc::new(Mutex::new(None));
    let captured2 = Arc::clone(&captured);
    let get_acp_connection: GetAcpConnection = Arc::new(move |given_spec, _enrich| {
        let captured = Arc::clone(&captured2);
        Box::pin(async move {
            let conn = AcpConnection::new(given_spec);
            conn.initialize().await?;
            let _sid = conn.new_session(&PathBuf::from("/tmp"), None).await?;
            *captured.lock().unwrap() = Some(conn.clone());
            Ok(conn)
        })
    });
    let _ = spec;
    (
        TurnContext {
            cwd: PathBuf::from("/tmp/worktree"),
            project: common::make_project("p1"),
            worktree: None,
            session: common::make_session("sess-1"),
            chat_id: None,
            fork_from_chat_id: None,
            model: None,
            system_prompt_file: PathBuf::from("/tmp/sp.md"),
            daemon_port: 0,
            on_spawn: None,
            get_acp_connection,
        },
        captured,
    )
}

fn base_params(provider: NormalizedEventProvider, mode: &str) -> RunTurnAcpParams {
    let spec = spec_for(mode);
    RunTurnAcpParams {
        provider,
        build_spec: Box::new(move |_ctx| spec.clone()),
        enrich: None,
        first_turn_session_init: None,
        build_prompt_blocks: Box::new(|_ctx, input, _system| {
            vec![ContentBlock::Text(
                agent_client_protocol::schema::v1::TextContent::new(input.message.clone()),
            )]
        }),
        emit_refusal_error: false,
        stuck_turn_idle_ms: None,
        stuck_turn_cancel_grace_ms: None,
    }
}

fn collect(rx: &mut mpsc::UnboundedReceiver<NormalizedEvent>) -> Vec<NormalizedEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
}

fn kinds(evs: &[NormalizedEvent]) -> Vec<NormalizedEventKind> {
    evs.iter().map(|e| e.kind).collect()
}

/// Dispose the captured connection (if any) WITHOUT holding the guard across
/// the await — clone the handle out first, then await dispose.
async fn dispose_captured(captured: &Arc<Mutex<Option<AcpConnection>>>) {
    let conn = captured.lock().unwrap().clone();
    if let Some(c) = conn {
        c.dispose().await;
    }
}

fn default_input(first: bool) -> TurnInput {
    TurnInput {
        message: "hello".to_string(),
        attachment_paths: vec![],
        is_first_turn: first,
        skill_invocations: None,
    }
}

/// `run_turn_acp` drains the fake agent's streamed update through normalize
/// and terminates with a `result` event.
#[tokio::test]
async fn run_turn_acp_drains_updates_and_emits_result() {
    let (ctx, captured) = ctx_with_spec(spec_for("normal"));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let params = base_params(NormalizedEventProvider::Claude, "normal");
    let task = tokio::spawn(run_turn_acp(
        tx,
        default_input(true),
        ctx,
        CancellationToken::new(),
        params,
    ));
    task.await.unwrap();
    dispose_captured(&captured).await;

    let events = collect(&mut rx);
    assert_eq!(
        kinds(&events),
        vec![NormalizedEventKind::Text, NormalizedEventKind::Result],
        "expected one streamed text event then a terminal result"
    );
    assert_eq!(events[0].text.as_deref(), Some("hi from fake agent"));
    assert_eq!(events[0].provider, NormalizedEventProvider::Claude);
}

/// On first turn with a claude-style `first_turn_session_init` hook, a
/// `session_init` event surfaces the ACP session id as `agentChatId` BEFORE
/// any streamed content.
#[tokio::test]
async fn first_turn_session_init_surfaces_acp_id_as_agent_chat_id() {
    let (ctx, captured) = ctx_with_spec(spec_for("normal"));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut params = base_params(NormalizedEventProvider::Claude, "normal");
    params.first_turn_session_init = Some(Arc::new(|ctx, acp_id| {
        let mut ev = vst_types::NormalizedEvent::default();
        ev.id = "x".into();
        ev.session_id = ctx.session.id.clone();
        ev.ts = "t".into();
        ev.provider = NormalizedEventProvider::Claude;
        ev.kind = NormalizedEventKind::SessionInit;
        ev.agent_chat_id = Some(acp_id.to_string());
        ev
    }));
    let task = tokio::spawn(run_turn_acp(
        tx,
        default_input(true),
        ctx,
        CancellationToken::new(),
        params,
    ));
    task.await.unwrap();
    dispose_captured(&captured).await;

    let events = collect(&mut rx);
    assert_eq!(events[0].kind, NormalizedEventKind::SessionInit);
    assert_eq!(events[0].agent_chat_id.as_deref(), Some("fake-session-1"));
    assert_eq!(
        events[0].session_id, "sess-1",
        "synthetic events use the vibe-station session id, not the ACP id"
    );
}

/// cursor/agy (Option B) surface NO `session_init` on first turn.
#[tokio::test]
async fn option_b_surfaces_no_session_init() {
    let (ctx, captured) = ctx_with_spec(spec_for("normal"));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let params = base_params(NormalizedEventProvider::Cursor, "normal"); // first_turn_session_init = None
    let task = tokio::spawn(run_turn_acp(
        tx,
        default_input(true),
        ctx,
        CancellationToken::new(),
        params,
    ));
    task.await.unwrap();
    dispose_captured(&captured).await;

    let events = collect(&mut rx);
    assert!(
        events
            .iter()
            .all(|e| e.kind != NormalizedEventKind::SessionInit),
        "Option B must not surface an ACP session id as agentChatId"
    );
    assert_eq!(events.last().unwrap().kind, NormalizedEventKind::Result);
}

/// A `refusal` stop reason yields a terminal `error` event (claude only).
#[tokio::test]
async fn refusal_emits_error_event() {
    let (ctx, captured) = ctx_with_spec(spec_for("refusal"));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut params = base_params(NormalizedEventProvider::Claude, "refusal");
    params.emit_refusal_error = true;
    let task = tokio::spawn(run_turn_acp(
        tx,
        default_input(false),
        ctx,
        CancellationToken::new(),
        params,
    ));
    task.await.unwrap();
    dispose_captured(&captured).await;

    let events = collect(&mut rx);
    assert_eq!(events.last().unwrap().kind, NormalizedEventKind::Error);
    assert_eq!(events.last().unwrap().text.as_deref(), Some("turn refused"));
}

/// A transport failure from `get_acp_connection` surfaces as an `error` event.
#[tokio::test]
async fn get_acp_connection_failure_emits_error() {
    let get_acp_connection: GetAcpConnection = Arc::new(|_spec, _enrich| {
        Box::pin(async move {
            Err::<AcpConnection, _>(AcpTransportError::SpawnFailed("boom".to_string()))
        })
    });
    let ctx = TurnContext {
        cwd: PathBuf::from("/tmp"),
        project: common::make_project("p1"),
        worktree: None,
        session: common::make_session("sess-1"),
        chat_id: None,
        fork_from_chat_id: None,
        model: None,
        system_prompt_file: PathBuf::from("/tmp/sp.md"),
        daemon_port: 0,
        on_spawn: None,
        get_acp_connection,
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let params = base_params(NormalizedEventProvider::Claude, "normal");
    tokio::spawn(run_turn_acp(
        tx,
        default_input(true),
        ctx,
        CancellationToken::new(),
        params,
    ))
    .await
    .unwrap();

    let events = collect(&mut rx);
    assert_eq!(events.last().unwrap().kind, NormalizedEventKind::Error);
}

/// A turn cancelled before it resolves stops cleanly (no `error` event).
#[tokio::test]
async fn cancel_stops_cleanly_without_error() {
    let (ctx, captured) = ctx_with_spec(spec_for("normal"));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let params = base_params(NormalizedEventProvider::Claude, "normal");

    let task = tokio::spawn(run_turn_acp(
        tx,
        default_input(true),
        ctx,
        cancel.clone(),
        params,
    ));

    // Cancel immediately — the drain loop must stop cleanly (select! races
    // cancel against the stream) without emitting an error event.
    cancel.cancel();
    let _ = task.await;
    dispose_captured(&captured).await;

    let events = collect(&mut rx);
    assert!(
        events.iter().all(|e| e.kind != NormalizedEventKind::Error),
        "a cancelled turn must not emit an error event"
    );
}

/// The stuck-working watchdog: an adapter that streams a few updates then
/// goes fully silent — never resolves `session/prompt`, and (via
/// `prompt_stream_then_hang`, which never observes `session/cancel` either)
/// never even acknowledges the daemon's own cancel. This is the exact shape
/// observed in the field (claude-agent-acp abandoning a turn after mid-turn
/// steering — see docs/STUCK-WORKING-WATCHDOG.md): no result, no error,
/// nothing, forever, from the adapter's side. With the watchdog thresholds
/// cranked down to milliseconds (the same override seam `prompt_timeout_ms`
/// already uses on `AcpLaunchSpec`), `run_turn_acp` must still return with a
/// terminal `result` event well within a bounded time — this is the
/// contract that lets `drain_loop` ever reach its `WaitingForHuman` finally
/// block instead of leaving the session pinned at `working`.
#[tokio::test]
async fn stuck_turn_watchdog_recovers_when_adapter_abandons_the_turn() {
    let mut env = HashMap::new();
    env.insert(
        "FAKE_ACP_MODE".to_string(),
        "prompt_stream_then_hang".to_string(),
    );
    env.insert("PROMPT_STREAM_INTERVAL_MS".to_string(), "5".to_string());
    env.insert("PROMPT_STREAM_COUNT".to_string(), "3".to_string());
    let spec = AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![fake_agent()],
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        env,
        initialize_timeout_ms: None,
        // Deliberately not overridden: this test's whole point is that the
        // stuck-turn watchdog — not `do_send_prompt`'s hour-long idle net —
        // is what recovers this turn.
        prompt_timeout_ms: None,
    };
    let (ctx, captured) = ctx_with_spec(spec.clone());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut params = base_params(NormalizedEventProvider::Claude, "prompt_stream_then_hang");
    params.build_spec = Box::new(move |_ctx| spec.clone());
    params.stuck_turn_idle_ms = Some(50);
    params.stuck_turn_cancel_grace_ms = Some(50);

    let start = std::time::Instant::now();
    let task = tokio::spawn(run_turn_acp(
        tx,
        default_input(true),
        ctx,
        CancellationToken::new(),
        params,
    ));
    task.await
        .expect("run_turn_acp must return, not hang forever, once the adapter abandons the turn");
    let elapsed = start.elapsed();
    dispose_captured(&captured).await;

    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "watchdog must recover well within its configured 50ms+50ms window, took {elapsed:?}"
    );

    let events = collect(&mut rx);
    assert_eq!(
        events.last().map(|e| e.kind),
        Some(NormalizedEventKind::Result),
        "an abandoned, never-cancel-acked turn must still emit a terminal result \
         so drain_loop can reach its WaitingForHuman finally block"
    );
    // The 3 streamed chunks sent before the agent went silent must still
    // have been delivered — the watchdog recovers the turn, it doesn't
    // discard what already streamed.
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == NormalizedEventKind::Text)
            .count(),
        3
    );
}
