//! `AgentPlugin` trait + supporting types — ports `services/spawn.ts`'s
//! `interface AgentPlugin` (moved here per Gotcha #11; the trait lives with
//! the plugins, not `vst-proc`).
//!
//! The trait is the single extension point for CLI-specific behaviour
//! (`AGENTS.md` § Agent plugin): every behaviour that differs between
//! `claude`, `cursor`, `opencode` and `agy` is a method on this trait, never
//! an `if/else` on a `CliId` in calling code (Gotcha #2). Calling code
//! resolves the plugin once via [`crate::registry::resolve_plugin`] and then
//! calls trait methods.
//!
//! Every **optional** method has a default body (returning `None` /
//! not-implemented / the documented default), exactly as the TS interface's
//! `?` methods are optional. The required methods (`get_launch_command`,
//! `get_environment`, `get_ready_signal`, `compose_launch_prompt`) must be
//! implemented by every plugin.
//!
//! `run_turn` / `TurnInput` / `TurnContext` / `get_acp_connection` belong to
//! `04b`/`04c` (the ACP transport and json-agent-chat application halves);
//! `supports_acp()` here is only a boolean marker. The `run_turn` bridge
//! (TurnContext/TurnInput/GetAcpConnection + the `AgentPlugin::run_turn`
//! method) is part of 04c, driven over the shared `crate::acp_run_turn`.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_types::{NormalizedEvent, ProjectRecord, SessionRecord, WorktreeRecord};

use crate::acp_connection::{AcpConnection, AcpLaunchSpec};
use crate::acp_transport::AcpTransportError;
use crate::normalize::AcpEnrichHook;

/// How a plugin delivers its system/task prompts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptDelivery {
    /// Prompts are passed via CLI flags / launch config (no post-launch paste).
    Inline,
    /// Prompts are sent to stdin after launch.
    PostLaunch,
}

/// The ready signal a plugin waits for after spawning: an optional sentinel
/// string searched in pane output, plus a fallback delay in ms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadySignal {
    pub sentinel: Option<&'static str>,
    pub fallback_ms: u64,
}

/// The context an agent session runs in — ports the slice of `ResolvedContext`
/// (04c) that 04a's plugin methods need: the working directory (`cwd`) and
/// whether it is a worktree or direct session.
#[derive(Clone, Debug)]
pub struct PluginContext {
    /// The worktree checkout path, or the project's absolute path for a direct
    /// session. Plugins derive paths from this, never from a worktree id.
    pub cwd: PathBuf,
    pub project_id: String,
    /// `Some` iff a worktree context; `None` for a direct (project) session.
    pub worktree: Option<WorktreeRecord>,
}

/// Everything a plugin needs to spawn / compose for a worktree OR direct
/// session — ports `LaunchConfig` from `spawn.ts`.
#[derive(Clone, Debug)]
pub struct LaunchConfig {
    pub project: ProjectRecord,
    pub ctx: PluginContext,
    pub session: SessionRecord,
    pub daemon_port: u16,
    /// Per-mode model override passed to the agent CLI when set.
    pub model: Option<String>,
}

/// An already-resolved skill invocation (skill-invocation-in-chat) — a plugin
/// only formats a directive from these; it never resolves skill names itself.
#[derive(Clone, Debug)]
pub struct SkillInvocation {
    pub name: String,
    pub args: String,
    pub path: Option<String>,
}

/// Input to [`AgentPlugin::compose_launch_prompt`].
#[derive(Clone, Debug)]
pub struct ComposePromptInput {
    pub system_prompt: String,
    pub task_prompt: Option<String>,
    pub session_id: String,
    pub system_prompt_file: String,
    pub launch_cfg: LaunchConfig,
}

/// Result of [`AgentPlugin::compose_launch_prompt`]. Mirrors the TS method's
/// `{ launchArgs?, postLaunchInput?, postLaunchSubmit?, useShell?, shellLine? }`.
#[derive(Clone, Debug, Default)]
pub struct ComposePromptResult {
    pub launch_args: Option<Vec<String>>,
    pub post_launch_input: Option<String>,
    pub post_launch_submit: bool,
    pub use_shell: bool,
    pub shell_line: Option<String>,
}

/// Result of [`AgentPlugin::list_models`].
#[derive(Clone, Debug, Default)]
pub struct ListModelsResult {
    pub models: Vec<String>,
    pub error: Option<String>,
}

/// Args passed to the chat-id methods (`provide_chat_id` / `capture_chat_id` /
/// `refresh_chat_id_on_toggle`).
#[derive(Clone, Debug)]
pub struct CaptureArgs<'a> {
    pub session: &'a SessionRecord,
    pub project: &'a ProjectRecord,
    /// The session's working directory (worktree checkout, or project path).
    pub cwd: &'a str,
    /// Only present for `refresh_chat_id_on_toggle` (a worktree session's record).
    pub worktree: Option<&'a WorktreeRecord>,
}

/// Args passed to `capture_native_chat_id`.
#[derive(Clone, Debug)]
pub struct CaptureNativeChatIdArgs<'a> {
    pub session: &'a SessionRecord,
    pub project: &'a ProjectRecord,
    pub cwd: &'a str,
    pub acp_session_id: &'a str,
}

/// Args passed to `get_restore_command`.
#[derive(Clone, Debug)]
pub struct RestoreArgs<'a> {
    pub session: &'a SessionRecord,
    pub project: &'a ProjectRecord,
    pub cwd: &'a str,
    pub model: Option<&'a str>,
}

/// The user's message + attachments for one turn — ports `TurnInput` from
/// `spawn.ts`. Skill invocations are ALREADY RESOLVED by the caller
/// (`jsonAgent.ts`'s `runOneTurn` via `resolveSkillInvocations`); the plugin
/// only FORMATS them (`format_skill_directive`), never resolves.
#[derive(Clone, Debug)]
pub struct TurnInput {
    pub message: String,
    /// Absolute paths to attached files (already injected into `message` too).
    pub attachment_paths: Vec<String>,
    /// True for turn 1 — the plugin applies the system prompt (per-CLI
    /// transport). Resumed turns rely on the CLI's own session state.
    pub is_first_turn: bool,
    /// Zero, one, or many resolved skill invocations. `None` (not `[]`) when
    /// no token resolved.
    pub skill_invocations: Option<Vec<SkillInvocation>>,
}

/// Callback the plugin invokes with each spawned child PID (the child MUST be
/// its own process group so the core can group-kill orphans on boot/abort).
pub type OnSpawn = Arc<dyn Fn(u32) + Send + Sync>;

/// The lazy create-or-return callback for this session's ONE persistent
/// `AcpConnection`. The plugin builds the launch spec (argv/env — CLI-specific,
/// AGENTS.md § Agent plugin) and an optional per-CLI `enrich` hook; the core
/// (`JsonAgentSession`) owns caching, `initialize`, `session/new`-or-`load`,
/// and disposal. Only present for plugins that call it.
///
/// The frozen `AcpTransport` trait is NOT dyn-compatible (it uses `impl
/// Future` return types, RPITIT), so the callback returns the concrete
/// [`AcpConnection`] (cheap to clone — it's `Arc<Inner>`) rather than a trait
/// object. This matches the TS, where `getAcpConnection` returns a concrete
/// `AcpConnection`.
pub type GetAcpConnection = Arc<
    dyn Fn(
            AcpLaunchSpec,
            Option<Arc<AcpEnrichHook>>,
        )
            -> Pin<Box<dyn Future<Output = Result<AcpConnection, AcpTransportError>> + Send>>
        + Send
        + Sync,
>;

/// Everything a plugin needs to run a JSON-channel turn for a worktree OR
/// direct session — ports `TurnContext` from `spawn.ts`. `cwd` is the worktree
/// path OR the project path (direct). `chatId` is reused across turns.
pub struct TurnContext {
    pub cwd: PathBuf,
    pub project: ProjectRecord,
    pub worktree: Option<WorktreeRecord>,
    pub session: SessionRecord,
    /// Harness chat/session id, when captured (turn ≥ 2).
    pub chat_id: Option<String>,
    /// Edit-a-sent-message fork: branch the harness's OWN session from this
    /// chat id into a NEW session id. Takes precedence over `chat_id`.
    pub fork_from_chat_id: Option<String>,
    /// Per-mode model override.
    pub model: Option<String>,
    /// Absolute path to the system-prompt file (applied on the first turn).
    pub system_prompt_file: PathBuf,
    pub daemon_port: u16,
    pub on_spawn: Option<OnSpawn>,
    /// Lazy create-or-return this session's persistent ACP connection.
    pub get_acp_connection: GetAcpConnection,
}

/// The `VSTPRMT:<sessionId>` verification needle (`promptVerificationNeedle`).
pub fn prompt_verification_needle(session_id: &str) -> String {
    format!("VSTPRMT:{session_id}")
}

/// Async result helper — `Box<dyn Future>` (implicitly `'static`) is used for
/// dyn-compatibility of the trait's async methods with `Box<dyn AgentPlugin>`.
/// Implementations move owned data into their futures, so a `'static` bound is
/// sound (no method returns a future borrowing `&self`).
pub type AsyncResult<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// The agent-plugin extension point (`AgentPlugin` in `spawn.ts`).
///
/// Implementations are stateless singletons; `resolve_plugin` returns a fresh
/// boxed instance per call, matching the TS `createXPlugin()` factories.
pub trait AgentPlugin: Send + Sync {
    fn name(&self) -> &str;
    /// Default model id for the UI when creating modes for this CLI.
    fn default_model(&self) -> &str;
    fn prompt_delivery(&self) -> PromptDelivery;
    /// Extra settle time after ready sentinel, before stdin paste.
    fn post_sentinel_delay_ms(&self) -> Option<u64> {
        None
    }

    /// Return argv (binary + flags) — tmux execs this directly, no shell.
    fn get_launch_command(&self, cfg: &LaunchConfig) -> Vec<String>;
    /// Extra env vars for the process.
    fn get_environment(&self, cfg: &LaunchConfig) -> BTreeMap<String, String>;
    fn get_ready_signal(&self) -> ReadySignal;
    fn compose_launch_prompt(&self, input: ComposePromptInput) -> ComposePromptResult;

    /// One-time-per-worktree setup of CLI-specific workspace files (hook
    /// scripts, settings, plugin files). Idempotent — safe to re-run.
    fn setup_workspace_hooks(&self, _workspace_path: &str) -> AsyncResult<()> {
        Box::pin(async {})
    }

    /// Pre-spawn: obtain a chat id before launching (e.g. cursor-agent
    /// create-chat).
    fn provide_chat_id(&self, _args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        Box::pin(async { None })
    }

    /// Post-ready: capture the agent's chat id written to a token file.
    fn capture_chat_id(&self, _args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        Box::pin(async { None })
    }

    /// Self-heal the chat id on a tty→json toggle.
    fn refresh_chat_id_on_toggle(&self, _args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        Box::pin(async { None })
    }

    /// Return the list of models available for this CLI.
    fn list_models(&self) -> AsyncResult<ListModelsResult>;

    /// Fork capability (claude only, `--fork-session`). Presence is the gate.
    fn get_fork_command(&self) -> Option<Vec<String>> {
        None
    }

    /// Return argv for resuming a prior session, or null for fresh launch.
    fn get_restore_command(&self, _args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        Box::pin(async { None })
    }

    /// Whether this plugin can run in the JSON (Rich Chat) channel.
    fn supports_json(&self) -> bool {
        false
    }

    /// ACP migration marker: true once this plugin drives a persistent ACP
    /// connection. In this part this is only a boolean; the actual connection
    /// is `04b`'s territory.
    fn supports_acp(&self) -> bool {
        false
    }

    /// Run ONE JSON-channel turn (Decision 2). The plugin spawns its CLI (own
    /// process group for orphan safety), drives the turn over the persistent
    /// ACP connection, and pushes each normalized event into the returned
    /// receiver. Rust has no native async generators, so a spawned task
    /// pushing into the `mpsc::UnboundedReceiver` (matching 04b's own
    /// `PromptTurn.updates` idiom) is the direct equivalent of the TS
    /// `AsyncIterable`.
    ///
    /// The default returns an already-closed receiver, meaning "not
    /// supported" — mirrors the TS optional `runTurn?` method.
    ///
    /// The stream terminates with either a `result` event (normal), an `error`
    /// event (transport/CLI failure), or closes silently on cancel.
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        _cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        drop(tx); // closed = not supported
        rx
    }

    /// Format (never resolve) a `<skill-invocations>` directive. Presence is
    /// the gate for offering skills. Default: return the message unchanged.
    fn format_skill_directive(
        &self,
        message: &str,
        _skill_invocations: Option<&[SkillInvocation]>,
    ) -> String {
        message.to_string()
    }

    /// Whether this CLI's mid-turn steering is trusted to reach the model.
    fn supports_mid_turn_steering(&self) -> bool {
        false
    }

    /// The `bridged` / `unavailable` strategies: read the NATIVE chat id out of
    /// band. `identical` plugins (claude, opencode) deliberately do NOT
    /// implement this.
    fn capture_native_chat_id(
        &self,
        _args: CaptureNativeChatIdArgs<'_>,
    ) -> AsyncResult<Option<String>> {
        Box::pin(async { None })
    }

    /// The `unavailable` strategy's declaration: whether a json session can
    /// resume when toggled to the Terminal channel. Default `true`.
    fn supports_json_to_terminal_resume(&self) -> bool {
        true
    }

    /// Optional extension metadata payload passed in `session/new` and `session/load`.
    /// Enables plugins (e.g. Claude) to pass CLI-specific options (model, betas, etc.)
    /// without calling code inspecting CLI IDs (AGENTS.md Plugin Invariant).
    fn acp_meta(&self, _model: &str) -> Option<serde_json::Value> {
        None
    }
}

/// A short ISO8601-ish timestamp for event `ts`/`id` fields. Exact values are
/// not part of the wire contract (the TS stamps `new Date().toISOString()`),
/// so a monotonic system-clock string is sufficient for the parser tests.
pub(crate) fn now_iso() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis}")
}

/// Build a [`vst_types::NormalizedEvent`] with the shared stamping fields set,
/// ready for the per-plugin parsers to fill in kind-specific fields.
pub(crate) fn base_event(
    session_id: &str,
    provider: vst_types::NormalizedEventProvider,
    kind: vst_types::NormalizedEventKind,
) -> vst_types::NormalizedEvent {
    let ts = now_iso();
    vst_types::NormalizedEvent {
        id: ts.clone(),
        session_id: session_id.to_string(),
        ts,
        provider,
        kind,
        ..Default::default()
    }
}
