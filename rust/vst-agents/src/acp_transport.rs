//! `AcpTransport` — the trait `04b-acp-transport` implements against.
//!
//! **Frozen by part `04-spike` (this file), per the arch doc — 04b may not
//! change this signature, only implement it.** Validated end to end against
//! a real `claude-agent-acp` process by `examples/acp_hello.rs` before this
//! trait was written; the shapes below (`initialize` -> `new_session`/
//! `load_session` -> `send_prompt` streaming `SessionUpdate`s -> `StopReason`)
//! are the same sequence that example exercised live, not a paper design.
//!
//! Deliberately mirrors the existing, load-bearing TS contract
//! (`daemon/src/services/acp/acpTransport.ts`'s `AcpConnection` class — see
//! its "Decision 1/2/3" comments) rather than re-deriving the shape from
//! scratch: one persistent connection per session, `initialize` once, one
//! ACP session per connection, `session/prompt` served per turn over that
//! SAME connection, `session/prompt`'s own resolution (not child-process
//! exit) is the turn-done signal.
//!
//! ## Deliberate simplifications vs. the TS class
//! - **No `AbortSignal` parameter on `send_prompt`.** The TS method takes a
//!   signal only to translate an external abort into a `cancel_active_prompt()`
//!   call internally — callers here just call `cancel_active_prompt()`
//!   directly on the same handle. One less type to freeze.
//! - **Streams the raw ACP `SessionUpdate` schema type, not
//!   `vst_types::NormalizedEvent`.** The TS class normalizes inline
//!   (`normalizeSessionUpdate`) because `acpTransport.ts` and
//!   `acpNormalize.ts` are both part-`04b`-owned files anyway. In Rust,
//!   `AcpTransport` stays a thin, protocol-shaped abstraction; `04b`'s own
//!   `normalize.rs` module consumes `PromptTurn::updates` and produces
//!   `NormalizedEvent`s on top of it. Keeps this trait free of any
//!   `vst-types` coupling, and free of needing a `vst-types` amendment to
//!   land this spike.
//! - **`&self`, not `&mut self`, everywhere** — per the part-00
//!   `XHandle(Arc<Inner>)` handle convention (Gotcha #14) every other crate in
//!   this workspace already follows (`StoreHandle`, `PtyHandle`): interior
//!   mutability behind the impl, not a borrowed-mutably API.

use std::path::Path;

use agent_client_protocol::schema::v1::{ContentBlock, SessionUpdate, StopReason};
use tokio::sync::{mpsc, oneshot};

/// Mirrors the TS class's typed failure modes (`ConnectionSpawnFailed`,
/// `InitializeFailed`, `SessionLoadFailed`) plus a catch-all for any other
/// JSON-RPC-level failure a `04b` implementation surfaces.
#[derive(Debug, thiserror::Error)]
pub enum AcpTransportError {
    #[error("agent process failed to spawn: {0}")]
    SpawnFailed(String),
    #[error("initialize failed: {0}")]
    InitializeFailed(String),
    #[error("session/load failed: {0}")]
    SessionLoadFailed(String),
    /// Any other ACP JSON-RPC error response, a request timeout, or the
    /// connection being disposed while a request was in flight.
    #[error("ACP request failed: {0}")]
    RequestFailed(String),
}

/// What `initialize()` reports back — mirrors the TS method's
/// `{ loadSession: boolean }` return shape (derived from
/// `agentCapabilities.loadSession`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InitializeOutcome {
    /// True iff the agent advertised `session/load` support — only then may
    /// a caller call [`AcpTransport::load_session`] instead of
    /// [`AcpTransport::new_session`].
    pub load_session_supported: bool,
}

/// The outcome of [`AcpTransport::steer`] — mirrors the TS `steer()` return
/// union `"injected" | "promptRequired" | "unsupported"` (`acpTransport.ts`).
/// Any error / method-not-found / disposed-connection collapses to
/// [`SteerOutcome::Unsupported`]; it never propagates as an `Err`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SteerOutcome {
    /// The agent accepted the injected mid-turn message.
    Injected,
    /// The agent requested a human re-prompt.
    PromptRequired,
    /// Steering is not available (no `_meta.steering.supported`, the method
    /// is not implemented by the agent, the connection is disposed, etc.).
    Unsupported,
}

/// The live handle to one `session/prompt` turn in flight — returned by
/// [`AcpTransport::send_prompt`].
///
/// `updates` yields every `session/update` notification the agent sends
/// while this turn is running (the "stream" leg of `initialize -> session/new
/// -> prompt -> stream`); it closes when the turn ends, whether that's
/// success, cancellation, or the connection dying mid-turn. `result` resolves
/// exactly once, with the same `session/prompt` response that ends the
/// stream — read it AFTER (or while) draining `updates`, not instead of it;
/// per the TS contract this resolution, not child-process exit, is the
/// authoritative turn-done signal.
pub struct PromptTurn {
    pub updates: mpsc::UnboundedReceiver<SessionUpdate>,
    pub result: oneshot::Receiver<Result<StopReason, AcpTransportError>>,
}

/// One persistent ACP JSON-RPC connection to an external agent CLI (spawned
/// via `agent-client-protocol`'s [`agent_client_protocol::AcpAgent`], per
/// `examples/acp_hello.rs`).
///
/// A single production implementation is expected (spawn once, drive the
/// real JSON-RPC connection); this is a trait — not a concrete struct —
/// purely so `04b`'s session-driving logic (and later `04c`'s) can be unit
/// tested against a fake transport without spawning a real process for every
/// test, matching this workspace's existing test-seam pattern (e.g.
/// `vst-git::recover`'s `SessionLiveness` trait).
pub trait AcpTransport: Send + Sync {
    /// Spawn the agent process (if not already spawned) and perform the ACP
    /// `initialize` handshake. Idempotent: calling it again on an already-
    /// initialized transport returns the same outcome without re-spawning.
    fn initialize(
        &self,
    ) -> impl std::future::Future<Output = Result<InitializeOutcome, AcpTransportError>> + Send;

    /// `session/new` — mint a fresh ACP session rooted at `cwd`. `meta` is
    /// the raw `_meta` extension bag (e.g. Claude Code's `options.betas`);
    /// left as `serde_json::Value` rather than a typed `AcpSessionMeta`
    /// struct so this trait doesn't need amending every time a plugin needs
    /// a new `_meta` field — same reasoning as the TS type's index signature.
    fn new_session(
        &self,
        cwd: &Path,
        meta: Option<serde_json::Value>,
    ) -> impl std::future::Future<Output = Result<String, AcpTransportError>> + Send;

    /// `session/load` — resume a prior ACP session. Callers must only call
    /// this when the prior [`InitializeOutcome::load_session_supported`] was
    /// `true`; an implementation is free to return
    /// [`AcpTransportError::SessionLoadFailed`] otherwise rather than
    /// enforcing it itself (mirrors the TS doc comment's "never call this
    /// unless `initialize()` reported `loadSession: true`").
    fn load_session(
        &self,
        cwd: &Path,
        prior_session_id: &str,
        meta: Option<serde_json::Value>,
    ) -> impl std::future::Future<Output = Result<(), AcpTransportError>> + Send;

    /// The ACP session id established by the most recent successful
    /// `new_session`/`load_session` call, if any.
    fn current_session_id(&self) -> Option<String>;

    /// Run one turn (`session/prompt`). Returns immediately with a
    /// [`PromptTurn`] handle; the actual request runs in the background.
    fn send_prompt(&self, session_id: &str, prompt: Vec<ContentBlock>) -> PromptTurn;

    /// ACP `session/cancel` — a notification, no response expected. No-op if
    /// there is no active session or no turn in flight.
    fn cancel_active_prompt(&self);

    /// True when the agent reported `_meta.steering.supported === true` during
    /// `initialize` — derived from the `initialize` response's `_meta`, so it
    /// is only meaningful after a successful [`AcpTransport::initialize`].
    fn supports_steering(&self) -> bool;

    /// Inject a mid-turn user message via the `_session/steering` ACP steering
    /// extension. Returns [`SteerOutcome::Injected`] on success,
    /// [`SteerOutcome::PromptRequired`] when the agent requested a human
    /// re-prompt, or [`SteerOutcome::Unsupported`] on any error (method-not-
    /// found, disposed connection, closed stdin). Callers fall back to
    /// `enqueue()` on anything other than `Injected` — the TS contract.
    fn steer(
        &self,
        blocks: Vec<ContentBlock>,
    ) -> impl std::future::Future<Output = SteerOutcome> + Send;

    /// `session/set_config_option` — set a named session configuration
    /// option (e.g. `"model"`) on the agent, targeting the session
    /// established by the most recent `new_session`/`load_session` call.
    ///
    /// Best-effort by design: some adapters carry model/options entirely
    /// through `session/new`'s `_meta` (see [`crate::AgentPlugin::acp_meta`])
    /// and never need this; others ignore `_meta` at session creation and
    /// require this explicit follow-up call instead (e.g. openab's
    /// `agy-acp`, which hardcodes `model_id: None` in its `session/new`
    /// handler — see
    /// `.vibekit/reports/2026-09-22-agy-toggle-no-reply.md`). Callers should
    /// treat any error (including method-not-found on an adapter that
    /// doesn't implement it at all) as non-fatal and proceed with whatever
    /// the adapter already defaulted to.
    fn set_config_option(
        &self,
        config_id: &str,
        value: &str,
    ) -> impl std::future::Future<Output = Result<(), AcpTransportError>> + Send;

    /// True until this connection has been (or is being) torn down — by
    /// [`AcpTransport::dispose`], an idle timeout, or the child process
    /// exiting/crashing on its own.
    fn is_alive(&self) -> bool;

    /// Hard teardown: terminate the child process and release resources.
    /// Idempotent — safe to call on an already-disposed transport.
    fn dispose(&self) -> impl std::future::Future<Output = ()> + Send;
}
