//! Concrete [`AcpTransport`] implementation — one persistent ACP JSON-RPC
//! connection per session, driven by a background actor task. Ports
//! `daemon/src/services/acp/acpTransport.ts` (its "Decision 1/2/3" invariants).
//!
//! ## Actor pattern (why this shape)
//!
//! `agent_client_protocol`'s `Client.builder()...connect_with(agent, |cx| async
//! move { ... }).await` runs the WHOLE ACP connection as one closure that only
//! returns when the connection closes. The frozen [`AcpTransport`] trait, by
//! contrast, has methods (`initialize`/`new_session`/`send_prompt`/…) called
//! separately at different times on a persistent `&self` handle. These don't
//! fit together directly, so this module:
//!
//! - Spawns ONE background tokio task per [`AcpConnection`] that runs
//!   `connect_with` and, inside its closure, loops over an
//!   `mpsc::UnboundedReceiver<Command>`.
//! - Every trait method sends a [`Command`] and awaits its bundled oneshot
//!   reply. `dispose()` drops/closes the sender, which ends the loop, which
//!   lets the `connect_with` closure return, closing the connection (and, per
//!   `AcpAgent`'s contract, terminating the child process group on Unix).
//!
//! Inbound `session/update` notifications are routed to the CURRENT in-flight
//! prompt's `updates` receiver via a shared `Arc<Mutex<Option<Sender>>>` that
//! `send_prompt` sets and the actor clears.
//!
//! ## Deliberate simplifications vs. the TS class
//! - `AcpAgentConfig` (the spawn transport) has no `cwd` field, so the child
//!   is spawned in the daemon's working directory. `spec.cwd` is still used
//!   for the ACP `fs/*` path scoping. See the report for this known gap.
//! - The `outOfBandSink` (updates outside an active turn) is not surfaced by
//!   the frozen trait and is not ported.
//! - `steer()`/`supports_steering` are part of the trait (added by the 04c
//!   amendment); the `_session/steering` request is a custom JSON-RPC method,
//!   implemented here via the crate's derive macros (not a built-in schema
//!   type).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, CreateTerminalRequest,
    CreateTerminalResponse, FileSystemCapabilities, InitializeRequest, InitializeResponse,
    KillTerminalRequest, KillTerminalResponse, LoadSessionRequest, NewSessionRequest,
    PermissionOptionKind, PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionId,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest,
    SetSessionConfigOptionResponse, StopReason, TerminalExitStatus as AcpTerminalExitStatus,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{
    on_receive_notification, on_receive_request, AcpAgent, AcpAgentConfig, Agent, Client,
    ConnectionTo, JsonRpcRequest, JsonRpcResponse, LineDirection, Responder,
};
use tokio::sync::{mpsc, oneshot};

use crate::acp_file_system;
use crate::acp_terminal_manager::{TerminalCreateParams, TerminalManager};
use crate::acp_transport::{
    AcpTransport, AcpTransportError, InitializeOutcome, PromptTurn, SteerOutcome,
};

/// Launch spec for the agent process — a plugin supplies only this (argv/env
/// plus timeouts); everything below is identical for every plugin.
#[derive(Debug, Clone)]
pub struct AcpLaunchSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: std::path::PathBuf,
    pub env: std::collections::HashMap<String, String>,
    /// ms to wait for `initialize` to resolve before failing.
    pub initialize_timeout_ms: Option<u64>,
    /// ms of *inactivity* (no `session/update` notification received) before
    /// an in-flight `session/prompt` is rejected. This is an IDLE timeout, not
    /// a cap on total turn duration — each `session/update` notification
    /// resets the clock, so a turn that is actively streaming (tool calls,
    /// thinking chunks, diffs, …) can run indefinitely; only an agent that
    /// goes fully silent for this long is killed. See `do_send_prompt`.
    pub prompt_timeout_ms: Option<u64>,
}

const DEFAULT_INITIALIZE_TIMEOUT_MS: u64 = 30_000;
/// Default idle window for `session/prompt` — see the doc comment on
/// `AcpLaunchSpec::prompt_timeout_ms`. 60 minutes of *silence* (not total
/// turn time) is generous for a stalled agent/process — including a single
/// long-running tool call that emits no `session/update` output for a
/// while — while still failing fast on a genuinely hung connection.
const DEFAULT_PROMPT_TIMEOUT_MS: u64 = 60 * 60 * 1000;
/// How often `do_send_prompt` wakes up to check the idle clock while a
/// `session/prompt` request is in flight. Small relative to the timeout so
/// the idle check is timely, but never larger than the timeout itself (tests
/// use sub-second `prompt_timeout_ms` overrides).
const IDLE_POLL_INTERVAL_MS: u64 = 5_000;

/// Custom `_session/steering` request (ACP steering extension) — not a built-in
/// `agent_client_protocol` schema type, so defined here with the crate's derive
/// macros. Mirrors the TS `steer()` payload:
/// `{ sessionId, prompt: blocks, _meta: { steering: { idleBehavior: "promptRequired" } } }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "_session/steering", response = SteeringResponse)]
struct SteeringRequest {
    // ACP wire format is camelCase; without this rename the agent receives
    // `session_id`, rejects the request, and steering silently degrades to queueing.
    #[serde(rename = "sessionId")]
    session_id: String,
    prompt: Vec<ContentBlock>,
    #[serde(rename = "_meta")]
    meta: serde_json::Value,
}

/// Response to `_session/steering` — the agent reports an `outcome` string
/// (`"injected"` on success; anything else collapses to `PromptRequired`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcResponse)]
struct SteeringResponse {
    #[serde(default)]
    outcome: Option<String>,
}

/// Shared, interior-mutable state accessible from both the handle and the
/// actor task.
struct Shared {
    /// Routes `session/update` notifications to the current in-flight prompt.
    active_update: Mutex<Option<mpsc::UnboundedSender<SessionUpdate>>>,
    session_id: Mutex<Option<String>>,
    load_session_supported: AtomicBool,
    /// True iff the `initialize` response's `_meta.steering.supported === true`.
    steering_supported: AtomicBool,
    disposed: AtomicBool,
    /// Timestamp of the most recent `session/update` notification (any
    /// session), used by `do_send_prompt` to implement an IDLE timeout rather
    /// than a flat cap on total turn duration. Reset whenever a notification
    /// arrives, regardless of whether a sink is currently attached.
    last_activity: Mutex<Instant>,
}

impl Shared {
    fn new() -> Self {
        Self {
            active_update: Mutex::new(None),
            session_id: Mutex::new(None),
            load_session_supported: AtomicBool::new(false),
            steering_supported: AtomicBool::new(false),
            disposed: AtomicBool::new(false),
            last_activity: Mutex::new(Instant::now()),
        }
    }
}

/// A command the handle sends to the actor's connection loop.
enum Command {
    Initialize {
        reply: oneshot::Sender<Result<InitializeOutcome, AcpTransportError>>,
    },
    NewSession {
        cwd: std::path::PathBuf,
        meta: Option<serde_json::Value>,
        reply: oneshot::Sender<Result<String, AcpTransportError>>,
    },
    LoadSession {
        cwd: std::path::PathBuf,
        prior_session_id: String,
        meta: Option<serde_json::Value>,
        reply: oneshot::Sender<Result<(), AcpTransportError>>,
    },
    SendPrompt {
        session_id: String,
        prompt: Vec<ContentBlock>,
        result_tx: oneshot::Sender<Result<StopReason, AcpTransportError>>,
    },
    Steer {
        blocks: Vec<ContentBlock>,
        reply: oneshot::Sender<SteerOutcome>,
    },
    SetConfigOption {
        config_id: String,
        value: String,
        reply: oneshot::Sender<Result<(), AcpTransportError>>,
    },
    Cancel,
    Dispose {
        reply: oneshot::Sender<()>,
    },
}

struct Inner {
    cmd_tx: mpsc::UnboundedSender<Command>,
    shared: Arc<Shared>,
    /// `"<command> <args...>"` — captured at construction purely for
    /// diagnostics: when the actor's `connect_with` background transport
    /// future fails before `command_loop` ever runs (e.g. the child process
    /// exits immediately after a bad argv), the `Initialize` command's reply
    /// sender is dropped without ever being answered, so `initialize()`'s
    /// `rx.await` only sees a bare `RecvError` — no access to the real
    /// underlying error. Including the attempted command/args in the
    /// resulting message is the difference between "connection closed
    /// before initialize completed" (which command? spawned how?) and
    /// something a person can actually act on.
    command_desc: String,
}

/// The concrete [`AcpTransport`] — one per session, spawn-on-construction.
#[derive(Clone)]
pub struct AcpConnection(Arc<Inner>);

impl std::fmt::Debug for AcpConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpConnection")
            .field("disposed", &self.0.shared.disposed.load(Ordering::Relaxed))
            .field("session_id", &self.0.shared.session_id.lock().unwrap())
            .finish()
    }
}

impl AcpConnection {
    /// Build a connection handle and spawn its background actor. Must be
    /// called from within a tokio runtime (as all tests and the daemon are).
    pub fn new(spec: AcpLaunchSpec) -> Self {
        let command_desc = format!("{} {}", spec.command, spec.args.join(" "));
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<Command>();
        let shared = Arc::new(Shared::new());
        let spec = Arc::new(spec);
        spawn_actor(Arc::clone(&spec), Arc::clone(&shared), cmd_rx);
        Self(Arc::new(Inner {
            cmd_tx,
            shared,
            command_desc,
        }))
    }

    fn send(&self, cmd: Command) -> bool {
        self.0.cmd_tx.send(cmd).is_ok()
    }
}

impl AcpTransport for AcpConnection {
    async fn initialize(&self) -> Result<InitializeOutcome, AcpTransportError> {
        if self.0.shared.disposed.load(Ordering::Relaxed) {
            return Err(AcpTransportError::RequestFailed(
                "ACP connection is disposed; cannot initialize".to_string(),
            ));
        }
        let (tx, rx) = oneshot::channel();
        if !self.send(Command::Initialize { reply: tx }) {
            return Err(AcpTransportError::SpawnFailed(
                "connection is not running".to_string(),
            ));
        }
        rx.await.map_err(|_| {
            AcpTransportError::SpawnFailed(format!(
                "agent connection closed before initialize completed (command: {})",
                self.0.command_desc
            ))
        })?
    }

    async fn new_session(
        &self,
        cwd: &Path,
        meta: Option<serde_json::Value>,
    ) -> Result<String, AcpTransportError> {
        if self.0.shared.disposed.load(Ordering::Relaxed) {
            return Err(AcpTransportError::RequestFailed(
                "ACP connection is disposed; cannot create session".to_string(),
            ));
        }
        let (tx, rx) = oneshot::channel();
        if !self.send(Command::NewSession {
            cwd: cwd.to_path_buf(),
            meta,
            reply: tx,
        }) {
            return Err(AcpTransportError::RequestFailed(
                "connection is not running".to_string(),
            ));
        }
        rx.await
            .map_err(|_| AcpTransportError::RequestFailed("connection closed".to_string()))?
    }

    async fn load_session(
        &self,
        cwd: &Path,
        prior_session_id: &str,
        meta: Option<serde_json::Value>,
    ) -> Result<(), AcpTransportError> {
        if self.0.shared.disposed.load(Ordering::Relaxed) {
            return Err(AcpTransportError::SessionLoadFailed(
                "ACP connection is disposed; cannot load session".to_string(),
            ));
        }
        let (tx, rx) = oneshot::channel();
        if !self.send(Command::LoadSession {
            cwd: cwd.to_path_buf(),
            prior_session_id: prior_session_id.to_string(),
            meta,
            reply: tx,
        }) {
            return Err(AcpTransportError::SessionLoadFailed(
                "connection is not running".to_string(),
            ));
        }
        rx.await
            .map_err(|_| AcpTransportError::SessionLoadFailed("connection closed".to_string()))?
    }

    fn current_session_id(&self) -> Option<String> {
        self.0.shared.session_id.lock().unwrap().clone()
    }

    fn send_prompt(&self, session_id: &str, prompt: Vec<ContentBlock>) -> PromptTurn {
        let (updates_tx, updates_rx) = mpsc::unbounded_channel::<SessionUpdate>();
        let (result_tx, result_rx) = oneshot::channel::<Result<StopReason, AcpTransportError>>();

        if self.0.shared.disposed.load(Ordering::Relaxed) {
            // Reject immediately — never let a dead connection hang a caller.
            let _ = result_tx.send(Err(AcpTransportError::RequestFailed(
                "ACP connection is disposed; cannot send prompt".to_string(),
            )));
            return PromptTurn {
                updates: updates_rx,
                result: result_rx,
            };
        }

        // Route notifications for this turn into `updates_tx`; the actor
        // clears the sink once the request resolves.
        *self.0.shared.active_update.lock().unwrap() = Some(updates_tx);

        if !self.send(Command::SendPrompt {
            session_id: session_id.to_string(),
            prompt,
            result_tx,
        }) {
            let _ = updates_rx;
            let mut guard = self.0.shared.active_update.lock().unwrap();
            let _ = guard.take();
        }

        PromptTurn {
            updates: updates_rx,
            result: result_rx,
        }
    }

    fn cancel_active_prompt(&self) {
        let _ = self.send(Command::Cancel);
    }

    fn supports_steering(&self) -> bool {
        self.0.shared.steering_supported.load(Ordering::SeqCst)
    }

    async fn steer(&self, blocks: Vec<ContentBlock>) -> SteerOutcome {
        if self.0.shared.disposed.load(Ordering::Relaxed) {
            // Disposed connection collapses to Unsupported (TS catch).
            return SteerOutcome::Unsupported;
        }
        let (tx, rx) = oneshot::channel();
        if !self.send(Command::Steer { blocks, reply: tx }) {
            return SteerOutcome::Unsupported;
        }
        rx.await.unwrap_or(SteerOutcome::Unsupported)
    }

    async fn set_config_option(&self, config_id: &str, value: &str) -> Result<(), AcpTransportError> {
        if self.0.shared.disposed.load(Ordering::Relaxed) {
            return Err(AcpTransportError::RequestFailed(
                "ACP connection is disposed; cannot set config option".to_string(),
            ));
        }
        let (tx, rx) = oneshot::channel();
        if !self.send(Command::SetConfigOption {
            config_id: config_id.to_string(),
            value: value.to_string(),
            reply: tx,
        }) {
            return Err(AcpTransportError::RequestFailed(
                "connection is not running".to_string(),
            ));
        }
        rx.await
            .map_err(|_| AcpTransportError::RequestFailed("connection closed".to_string()))?
    }

    fn is_alive(&self) -> bool {
        !self.0.shared.disposed.load(Ordering::Relaxed)
    }

    async fn dispose(&self) {
        if self.0.shared.disposed.swap(true, Ordering::SeqCst) {
            return; // idempotent
        }
        // Clear any active sink so late notifications are dropped.
        self.0.shared.active_update.lock().unwrap().take();
        // Ask the actor to stop its loop, which lets the `connect_with` closure
        // return, closing the connection and terminating the child process.
        let (tx, _rx) = oneshot::channel::<()>();
        let _ = self.send(Command::Dispose { reply: tx });
    }
}

/// Spawn the actor task that owns the `connect_with` connection.
fn spawn_actor(
    spec: Arc<AcpLaunchSpec>,
    shared: Arc<Shared>,
    cmd_rx: mpsc::UnboundedReceiver<Command>,
) {
    tokio::spawn(async move {
        // Surface the child's stderr to the daemon's own logs. Without this,
        // a failure the adapter only reports on stderr (e.g. openab agy-acp's
        // "jetski: no output produced — a tool required the ... permission
        // that headless mode cannot prompt for, so it was auto-denied")
        // vanishes entirely — nothing in `docker logs`/journal ever mentions
        // it, and the turn just silently ends with zero updates. See
        // .vibekit/reports/2026-09-22-agy-toggle-no-reply.md (B2/A3). This is
        // plugin-agnostic (every ACP-driven CLI benefits), so it lives here
        // rather than in any one plugin.
        let debug_command = spec.command.clone();
        let agent = AcpAgent::new(
            AcpAgentConfig::new(spec.command.clone())
                .args(spec.args.clone())
                .envs(spec.env.clone()),
        )
        .with_debug(move |line, direction| {
            if direction == LineDirection::Stderr {
                tracing::warn!(command = %debug_command, "acp agent stderr: {line}");
            }
        });

        let terminals = TerminalManager::default();
        let cwd = spec.cwd.clone();

        // Notification handler: route session/update to the active prompt sink.
        let notif_shared = Arc::clone(&shared);
        let notif_handler = async move |notification: SessionNotification, _cx| {
            // Any inbound notification counts as activity for the idle-timeout
            // clock in `do_send_prompt`, whether or not a sink is currently
            // attached (a sink is only attached while a prompt is in flight,
            // which is exactly when this matters).
            *notif_shared.last_activity.lock().unwrap() = Instant::now();
            if let Some(tx) = notif_shared.active_update.lock().unwrap().as_ref() {
                let _ = tx.send(notification.update);
            }
            Ok(())
        };

        // --- agent -> client request handlers ---
        let perm_handler = async move |request: RequestPermissionRequest,
                                       responder: Responder<RequestPermissionResponse>,
                                       _cx| {
            let chosen = request
                .options
                .iter()
                .find(|o| o.kind == PermissionOptionKind::AllowAlways)
                .or_else(|| {
                    request
                        .options
                        .iter()
                        .find(|o| o.kind == PermissionOptionKind::AllowOnce)
                });
            match chosen {
                Some(opt) => {
                    let _ = responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                            opt.option_id.clone(),
                        )),
                    ));
                }
                None => {
                    let _ = responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ));
                }
            }
            Ok(())
        };

        let fs_cwd = cwd.clone();
        let fs_read_handler = async move |request: ReadTextFileRequest,
                                          responder: Responder<ReadTextFileResponse>,
                                          _cx| {
            let result = acp_file_system::read_text_file(
                &fs_cwd,
                &request.path.to_string_lossy(),
                request.line.map(|l| l as usize),
                request.limit.map(|l| l as usize),
            )
            .await;
            match result {
                Ok(content) => {
                    let _ = responder.respond(ReadTextFileResponse::new(content));
                }
                Err(e) => {
                    let _ = responder.respond_with_internal_error(e.to_string());
                }
            }
            Ok(())
        };

        let fs_cwd = cwd.clone();
        let fs_write_handler = async move |request: WriteTextFileRequest,
                                           responder: Responder<WriteTextFileResponse>,
                                           _cx| {
            let result = acp_file_system::write_text_file(
                &fs_cwd,
                &request.path.to_string_lossy(),
                &request.content,
            )
            .await;
            match result {
                Ok(()) => {
                    let _ = responder.respond(WriteTextFileResponse::new());
                }
                Err(e) => {
                    let _ = responder.respond_with_internal_error(e.to_string());
                }
            }
            Ok(())
        };

        let mgr = terminals.clone();
        let term_create_handler = async move |request: CreateTerminalRequest,
                                              responder: Responder<CreateTerminalResponse>,
                                              _cx| {
            let params = TerminalCreateParams {
                command: request.command.clone(),
                args: request.args.clone(),
                cwd: request.cwd.clone(),
                env: request
                    .env
                    .iter()
                    .map(|v| (v.name.clone(), v.value.clone()))
                    .collect(),
                output_byte_limit: request.output_byte_limit.map(|l| l as usize),
            };
            let terminal_id = mgr.create(
                params,
                &request.session_id.to_string(),
                &request.session_id.to_string(),
                None,
            );
            let _ = responder.respond(CreateTerminalResponse::new(terminal_id));
            Ok(())
        };

        let mgr = terminals.clone();
        let term_output_handler = async move |request: TerminalOutputRequest,
                                              responder: Responder<TerminalOutputResponse>,
                                              _cx| {
            match mgr.output(&request.terminal_id.to_string()) {
                Ok(out) => {
                    let _ =
                        responder.respond(TerminalOutputResponse::new(out.output, out.truncated));
                }
                Err(e) => {
                    let _ = responder.respond_with_internal_error(e.to_string());
                }
            }
            Ok(())
        };

        let mgr = terminals.clone();
        let term_wait_handler = async move |request: WaitForTerminalExitRequest,
                                            responder: Responder<WaitForTerminalExitResponse>,
                                            _cx| {
            match mgr.wait_for_exit(&request.terminal_id.to_string()).await {
                Ok(status) => {
                    let mut s = AcpTerminalExitStatus::new();
                    if status.exited {
                        s = s.exit_code(0);
                    }
                    let _ = responder.respond(WaitForTerminalExitResponse::new(s));
                }
                Err(e) => {
                    let _ = responder.respond_with_internal_error(e.to_string());
                }
            }
            Ok(())
        };

        let mgr = terminals.clone();
        let term_kill_handler = async move |request: KillTerminalRequest,
                                            responder: Responder<KillTerminalResponse>,
                                            _cx| {
            mgr.kill(&request.terminal_id.to_string());
            let _ = responder.respond(KillTerminalResponse::new());
            Ok(())
        };

        let mgr = terminals.clone();
        let term_release_handler = async move |request: ReleaseTerminalRequest,
                                               responder: Responder<ReleaseTerminalResponse>,
                                               _cx| {
            mgr.release(&request.terminal_id.to_string());
            let _ = responder.respond(ReleaseTerminalResponse::new());
            Ok(())
        };

        let shared_after = Arc::clone(&shared);
        let _ = Client
            .builder()
            .name("vst-acp")
            .on_receive_notification(notif_handler, on_receive_notification!())
            .on_receive_request(perm_handler, on_receive_request!())
            .on_receive_request(fs_read_handler, on_receive_request!())
            .on_receive_request(fs_write_handler, on_receive_request!())
            .on_receive_request(term_create_handler, on_receive_request!())
            .on_receive_request(term_output_handler, on_receive_request!())
            .on_receive_request(term_wait_handler, on_receive_request!())
            .on_receive_request(term_kill_handler, on_receive_request!())
            .on_receive_request(term_release_handler, on_receive_request!())
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let shared = Arc::clone(&shared);
                let spec = Arc::clone(&spec);
                async move { command_loop(cx, cmd_rx, shared, spec).await }
            })
            .await;

        // The connection has closed for any reason (crash, our dispose, or the
        // command loop ending). Mark it dead so `is_alive()` reports false and
        // any late commands fail fast.
        shared_after.disposed.store(true, Ordering::SeqCst);
        shared_after.active_update.lock().unwrap().take();
    });
}

/// The actor's command loop — runs inside the `connect_with` closure.
async fn command_loop(
    cx: ConnectionTo<Agent>,
    mut rx: mpsc::UnboundedReceiver<Command>,
    shared: Arc<Shared>,
    spec: Arc<AcpLaunchSpec>,
) -> Result<(), agent_client_protocol::Error> {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            Command::Initialize { reply } => {
                let result = do_initialize(&cx, &shared, spec.initialize_timeout_ms).await;
                let _ = reply.send(result);
            }
            Command::NewSession { cwd, meta, reply } => {
                let result = do_new_session(&cx, &shared, &cwd, meta).await;
                let _ = reply.send(result);
            }
            Command::LoadSession {
                cwd,
                prior_session_id,
                meta,
                reply,
            } => {
                let result = do_load_session(&cx, &shared, &cwd, &prior_session_id, meta).await;
                let _ = reply.send(result);
            }
            Command::SendPrompt {
                session_id,
                prompt,
                result_tx,
            } => {
                // Spawn the prompt request so the loop stays free to process
                // `session/cancel` and `dispose` while the turn is in flight
                // (the single loop must not block on `block_task` or it can
                // never answer the Cancel command, deadlocking the turn).
                let timeout_ms = spec.prompt_timeout_ms;
                let cx2 = cx.clone();
                let shared2 = Arc::clone(&shared);
                let spawned = cx.spawn(async move {
                    let result =
                        do_send_prompt(&cx2, &shared2, &session_id, prompt, timeout_ms).await;
                    // The turn is over — stop routing notifications to its sink.
                    shared2.active_update.lock().unwrap().take();
                    let _ = result_tx.send(result);
                    Ok(())
                });
                if spawned.is_err() {
                    // Connection is dead; clear the sink (the result channel is
                    // dropped, surfacing as a closed-receiver error to the caller).
                    shared.active_update.lock().unwrap().take();
                }
            }
            Command::Cancel => {
                do_cancel(&cx, &shared);
            }
            Command::Steer { blocks, reply } => {
                let outcome = do_steer(&cx, &shared, blocks).await;
                let _ = reply.send(outcome);
            }
            Command::SetConfigOption {
                config_id,
                value,
                reply,
            } => {
                let result = do_set_config_option(&cx, &shared, &config_id, &value).await;
                let _ = reply.send(result);
            }
            Command::Dispose { reply } => {
                shared.disposed.store(true, Ordering::SeqCst);
                shared.active_update.lock().unwrap().take();
                let _ = reply.send(());
                break;
            }
        }
    }
    Ok(())
}

fn meta_map(meta: Option<serde_json::Value>) -> Option<serde_json::Map<String, serde_json::Value>> {
    meta.and_then(|v| v.as_object().cloned())
}

async fn do_initialize(
    cx: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    timeout_ms: Option<u64>,
) -> Result<InitializeOutcome, AcpTransportError> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_INITIALIZE_TIMEOUT_MS));
    let future = cx
        .send_request(
            // Parity with the TS daemon: advertise the fs + terminal client
            // handlers wired below. Without this the agent is told we support
            // none of them and the handlers are never called.
            InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
                ClientCapabilities::new()
                    .fs(FileSystemCapabilities::new()
                        .read_text_file(true)
                        .write_text_file(true))
                    .terminal(true),
            ),
        )
        .block_task();
    let response: Result<InitializeResponse, _> = match tokio::time::timeout(timeout, future).await
    {
        Ok(r) => r,
        Err(_) => {
            return Err(AcpTransportError::InitializeFailed(format!(
                "initialize timed out after {}ms",
                timeout.as_millis()
            )));
        }
    };
    let response = response.map_err(|e| {
        if e.to_string().contains("spawn") || e.to_string().contains("process") {
            AcpTransportError::SpawnFailed(e.to_string())
        } else {
            AcpTransportError::InitializeFailed(e.to_string())
        }
    })?;
    shared
        .load_session_supported
        .store(response.agent_capabilities.load_session, Ordering::SeqCst);
    // Capture `_meta.steering.supported` for `supports_steering` — mirrors the
    // TS `this._initMeta.steering?.supported === true`.
    let steering_supported = response
        .meta
        .as_ref()
        .and_then(|meta| meta.get("steering"))
        .and_then(|steering| steering.get("supported"))
        .and_then(|supported| supported.as_bool())
        .unwrap_or(false);
    shared
        .steering_supported
        .store(steering_supported, Ordering::SeqCst);
    Ok(InitializeOutcome {
        load_session_supported: response.agent_capabilities.load_session,
    })
}

async fn do_new_session(
    cx: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    cwd: &Path,
    meta: Option<serde_json::Value>,
) -> Result<String, AcpTransportError> {
    let req = NewSessionRequest::new(cwd.to_path_buf()).meta(meta_map(meta));
    let response = cx
        .send_request(req)
        .block_task()
        .await
        .map_err(|e| AcpTransportError::RequestFailed(e.to_string()))?;
    let session_id = response.session_id.to_string();
    *shared.session_id.lock().unwrap() = Some(session_id.clone());
    Ok(session_id)
}

async fn do_load_session(
    cx: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    cwd: &Path,
    prior_session_id: &str,
    meta: Option<serde_json::Value>,
) -> Result<(), AcpTransportError> {
    let req = LoadSessionRequest::new(prior_session_id.to_string(), cwd.to_path_buf())
        .meta(meta_map(meta));
    cx.send_request(req)
        .block_task()
        .await
        .map_err(|e| AcpTransportError::SessionLoadFailed(e.to_string()))?;
    *shared.session_id.lock().unwrap() = Some(prior_session_id.to_string());
    Ok(())
}

/// Sends `session/prompt` and waits for its response, enforcing an IDLE
/// timeout rather than a flat cap on total turn duration: the clock resets on
/// every `session/update` notification (see `notif_handler` in
/// `spawn_actor`), so a turn that keeps streaming activity can run
/// indefinitely — only an agent that goes fully silent for `timeout_ms`
/// (default `DEFAULT_PROMPT_TIMEOUT_MS`) is rejected.
async fn do_send_prompt(
    cx: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    session_id: &str,
    prompt: Vec<ContentBlock>,
    timeout_ms: Option<u64>,
) -> Result<StopReason, AcpTransportError> {
    let idle_timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_PROMPT_TIMEOUT_MS));
    // Reset the clock right before issuing the request so a notification left
    // over from a previous turn (or from `initialize`/`new_session`) can't
    // pre-arm — or falsely extend — this turn's idle window.
    *shared.last_activity.lock().unwrap() = Instant::now();

    let future = cx
        .send_request(PromptRequest::new(session_id.to_string(), prompt))
        .block_task();
    tokio::pin!(future);

    let poll_interval = Duration::from_millis(IDLE_POLL_INTERVAL_MS).min(idle_timeout);
    loop {
        match tokio::time::timeout(poll_interval, &mut future).await {
            Ok(response) => {
                let response: PromptResponse =
                    response.map_err(|e| AcpTransportError::RequestFailed(e.to_string()))?;
                return Ok(response.stop_reason);
            }
            Err(_) => {
                let idle_for = shared.last_activity.lock().unwrap().elapsed();
                if idle_for >= idle_timeout {
                    return Err(AcpTransportError::RequestFailed(format!(
                        "session/prompt idle-timed out after {}ms with no session/update activity",
                        idle_timeout.as_millis()
                    )));
                }
                // Still receiving activity within the window — keep waiting.
            }
        }
    }
}

fn do_cancel(cx: &ConnectionTo<Agent>, shared: &Arc<Shared>) {
    let Some(session_id) = shared.session_id.lock().unwrap().clone() else {
        return;
    };
    let _ = cx.send_notification(CancelNotification::new(SessionId::new(session_id)));
}

/// `_session/steering` — inject a mid-turn user message. Any failure (error
/// response, method-not-found, no active session, closed connection) collapses
/// to [`SteerOutcome::Unsupported`]; it never propagates (TS `steer()` catch).
async fn do_steer(
    cx: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    blocks: Vec<ContentBlock>,
) -> SteerOutcome {
    let Some(session_id) = shared.session_id.lock().unwrap().clone() else {
        return SteerOutcome::Unsupported;
    };
    let req = SteeringRequest {
        session_id,
        prompt: blocks,
        meta: serde_json::json!({ "steering": { "idleBehavior": "promptRequired" } }),
    };
    let response: Result<SteeringResponse, _> = cx.send_request(req).block_task().await;
    match response {
        Ok(resp) if resp.outcome.as_deref() == Some("injected") => SteerOutcome::Injected,
        Ok(resp) => {
            tracing::debug!(outcome = ?resp.outcome, "_session/steering: not injected");
            SteerOutcome::PromptRequired
        }
        Err(e) => {
            tracing::warn!(error = %e, "_session/steering failed; falling back to queue");
            SteerOutcome::Unsupported
        }
    }
}

/// `session/set_config_option` — set a named option (e.g. `"model"`) on the
/// current session. See [`AcpTransport::set_config_option`]'s doc comment for
/// why this exists; failures are returned to the caller (unlike `do_steer`,
/// which collapses to an enum), but callers are expected to treat them as
/// non-fatal.
async fn do_set_config_option(
    cx: &ConnectionTo<Agent>,
    shared: &Arc<Shared>,
    config_id: &str,
    value: &str,
) -> Result<(), AcpTransportError> {
    let Some(session_id) = shared.session_id.lock().unwrap().clone() else {
        return Err(AcpTransportError::RequestFailed(
            "no active session".to_string(),
        ));
    };
    let req = SetSessionConfigOptionRequest::new(session_id, config_id.to_string(), value);
    let _resp: SetSessionConfigOptionResponse = cx
        .send_request(req)
        .block_task()
        .await
        .map_err(|e| AcpTransportError::RequestFailed(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    /// ACP is camelCase on the wire. A snake_case `session_id` makes the agent
    /// reject `_session/steering`, which silently degrades steering to queueing.
    #[test]
    fn steering_request_serializes_camel_case_session_id() {
        let v = serde_json::to_value(SteeringRequest {
            session_id: "abc".into(),
            prompt: vec![],
            meta: serde_json::json!({ "steering": { "idleBehavior": "promptRequired" } }),
        })
        .unwrap();
        assert_eq!(v["sessionId"], "abc");
        assert!(v.get("session_id").is_none());
        assert_eq!(v["_meta"]["steering"]["idleBehavior"], "promptRequired");
    }

    // `client_capabilities(...)` is actually reached by `do_initialize` and
    // observed on the wire by `initialize_sends_fs_and_terminal_client_capabilities_on_the_wire`
    // in tests/acp_transport.rs, rather than re-asserted here against an
    // isolated builder call (which would still pass if `do_initialize` never
    // called `.client_capabilities(...)` at all).
}
