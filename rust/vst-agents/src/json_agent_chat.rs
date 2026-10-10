//! JSON agent-chat turn orchestration — ports `services/jsonAgentChat.ts`.
//!
//! The single place that turns a session id + user message into an enqueued
//! turn: resolves mode → plugin, pins cwd (worktree or project), builds + writes
//! the first-turn system prompt, injects attachment paths, and enqueues.
//! Reused by REST chat endpoints, the WS `chat:open` bridge, and the
//! create-time turn-1 auto-enqueue.

use std::path::PathBuf;
use std::sync::Arc;

use vst_store::transcript::{SincePage, TranscriptMeta, TranscriptPage};
use vst_store::StoreHandle;
use vst_types::domain::{
    Attachment, Channel, CliId, LifecycleState, NormalizedEventProvider, ProjectRecord,
    ScheduledFailedMeta, ScheduledMessageMeta, SessionLifecycle, SessionMeta, SessionRecord,
    WorktreeRecord,
};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::shared::Mode;

use crate::json_agent_registry::JsonAgentRegistry;
use crate::json_agent_session::{
    self, get_or_create_json_agent_session,
    meta::{build_meta_from_store_meta, MetaOptions},
    read_meta_from_data_dir, read_page_before_from_data_dir, read_since_from_data_dir,
    read_tail_from_data_dir, read_transcript_from_data_dir, JsonAgentSession,
    JsonAgentSessionOptions,
};
use crate::paths::Paths;
use crate::plugin::AgentPlugin;
use crate::prompt_builder::{
    build_direct_prompt, build_prompt, BuildDirectPromptInput, BuildPromptInput,
};
use crate::registry::resolve_plugin;
use crate::skill_resolution::inject_attachments;
use crate::util::now_iso_8601;

// ---------------------------------------------------------------------------
// Helpers: convert between CliId and NormalizedEventProvider
// (identical variant sets, no From impl in vst-types)
// ---------------------------------------------------------------------------

fn cli_id_to_provider(id: CliId) -> NormalizedEventProvider {
    match id {
        CliId::Claude => NormalizedEventProvider::Claude,
        CliId::Cursor => NormalizedEventProvider::Cursor,
        CliId::Opencode => NormalizedEventProvider::Opencode,
        CliId::Agy => NormalizedEventProvider::Agy,
        CliId::Codex => NormalizedEventProvider::Codex,
        CliId::Pi => NormalizedEventProvider::Pi,
    }
}

fn provider_to_cli_id(p: NormalizedEventProvider) -> CliId {
    match p {
        NormalizedEventProvider::Claude => CliId::Claude,
        NormalizedEventProvider::Cursor => CliId::Cursor,
        NormalizedEventProvider::Opencode => CliId::Opencode,
        NormalizedEventProvider::Agy => CliId::Agy,
        NormalizedEventProvider::Codex => CliId::Codex,
        NormalizedEventProvider::Pi => CliId::Pi,
    }
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/// Resolved project + worktree + session for a JSON-channel session.
#[derive(Clone, Debug)]
pub struct JsonSessionContext {
    pub project: ProjectRecord,
    /// `None` for direct (no-worktree) sessions.
    pub worktree: Option<WorktreeRecord>,
    pub session: SessionRecord,
}

/// Resolved mode fields for a session.
#[derive(Clone, Debug)]
pub struct ResolvedMode {
    pub cli: NormalizedEventProvider,
    pub model: Option<String>,
    pub mode_id: Option<String>,
    pub mode_name: Option<String>,
    pub context: Option<String>,
    /// True when the mode was deleted and this is a best-effort fallback.
    pub is_fallback: bool,
}

// ---------------------------------------------------------------------------
// Find context
// ---------------------------------------------------------------------------

/// Locate a session (worktree or direct) across all projects in the store.
pub async fn find_json_session_context(
    store: &StoreHandle,
    session_id: &str,
) -> Option<JsonSessionContext> {
    let projects = store.get_all_projects().await;
    for project in projects {
        for worktree in &project.worktrees {
            if let Some(session) = worktree.sessions.iter().find(|s| s.id == session_id) {
                return Some(JsonSessionContext {
                    project: project.clone(),
                    worktree: Some(worktree.clone()),
                    session: session.clone(),
                });
            }
        }
        if let Some(session) = project.direct_sessions.iter().find(|s| s.id == session_id) {
            return Some(JsonSessionContext {
                project: project.clone(),
                worktree: None,
                session: session.clone(),
            });
        }
    }
    None
}

/// Absolute per-session data dir (holds the transcript store + system prompt).
pub fn session_data_dir_for(ctx: &JsonSessionContext) -> PathBuf {
    let paths = Paths::default();
    match &ctx.worktree {
        Some(w) => paths.session_data_dir(&ctx.project.id, &w.id, &ctx.session.id),
        None => paths.direct_session_data_dir(&ctx.project.id, &ctx.session.id),
    }
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

const FALLBACK_CLI: NormalizedEventProvider = NormalizedEventProvider::Claude;

/// Load all modes from `~/.vibe-station/modes.json`. Returns empty vec on any error.
async fn load_modes() -> Vec<Mode> {
    let paths = Paths::default();
    let modes_path = paths.vst_home().join("modes.json");
    match tokio::fs::read_to_string(&modes_path).await {
        Ok(text) => serde_json::from_str::<Vec<Mode>>(&text).unwrap_or_default(),
        Err(_) => vec![],
    }
}

/// Resolve a session's mode → cli/model/context.
/// Missing modes fall back rather than error (mode deletion is allowed).
async fn resolve_mode(
    session: &SessionRecord,
    registry: &JsonAgentRegistry<JsonAgentSession>,
) -> Result<ResolvedMode, String> {
    let mode_id = session
        .mode_id
        .as_deref()
        .ok_or_else(|| "Session has no mode; JSON chat requires an agent mode".to_string())?;

    let modes = load_modes().await;
    if let Some(mode) = modes.iter().find(|m| m.id == mode_id) {
        return Ok(ResolvedMode {
            cli: cli_id_to_provider(mode.cli),
            model: mode.model.clone(),
            mode_id: Some(mode.id.clone()),
            mode_name: Some(mode.name.clone()),
            context: if mode.context.is_empty() {
                None
            } else {
                Some(mode.context.clone())
            },
            is_fallback: false,
        });
    }

    let live = registry.get(session.id.as_str());
    let cli = live.as_ref().map_or(FALLBACK_CLI, |a| a.get_cli());
    let live_mode_id = live.as_ref().and_then(|a| a.get_mode_id());
    let live_mode_name = live.as_ref().and_then(|a| a.get_mode_name());
    eprintln!(
        "[json-chat] mode '{}' not found for session {} — falling back to {:?}",
        mode_id, session.id, cli
    );
    Ok(ResolvedMode {
        cli,
        model: None,
        mode_id: live_mode_id.or_else(|| Some(mode_id.to_string())),
        mode_name: live_mode_name,
        context: None,
        is_fallback: true,
    })
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/// Build the layered system prompt. Always passes `rich_chat: true` (Decision 3).
pub(crate) fn build_system_prompt(ctx: &JsonSessionContext, mode: &ResolvedMode) -> String {
    if let Some(worktree) = &ctx.worktree {
        build_prompt(&BuildPromptInput {
            project: ctx.project.clone(),
            worktree: worktree.clone(),
            mode_context: mode.context.clone(),
            user_prompt: None,
            rich_chat: true,
        })
        .system_prompt
    } else {
        build_direct_prompt(&BuildDirectPromptInput {
            project: ctx.project.clone(),
            mode_context: mode.context.clone(),
            user_prompt: None,
            rich_chat: true,
        })
        .system_prompt
    }
}

/// Test-only export of `build_system_prompt` (mirrors `_buildSystemPromptForTest`).
pub fn build_system_prompt_for_test(ctx: &JsonSessionContext, mode: &ResolvedMode) -> String {
    build_system_prompt(ctx, mode)
}

// ---------------------------------------------------------------------------
// Resolve agent
// ---------------------------------------------------------------------------

/// Resolved agent + context returned by `resolve_json_agent`.
pub struct ResolvedJsonAgent {
    pub agent: JsonAgentSession,
    pub ctx: JsonSessionContext,
    pub mode: ResolvedMode,
}

/// Errors from `resolve_json_agent`.
#[derive(Debug)]
pub enum ResolveJsonAgentError {
    NotFound { session_id: String },
    NotJson { session_id: String },
    ModeError(String),
}

/// Resolve (or lazily create + register) the `JsonAgentSession`.
/// Does NOT spawn anything — the process only starts when a turn is enqueued.
pub async fn resolve_json_agent(
    session_id: &str,
    daemon_port: u16,
    store: &StoreHandle,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    broadcaster: Broadcaster,
) -> Result<ResolvedJsonAgent, ResolveJsonAgentError> {
    let ctx = find_json_session_context(store, session_id)
        .await
        .ok_or_else(|| ResolveJsonAgentError::NotFound {
            session_id: session_id.to_string(),
        })?;

    if ctx.session.channel != Some(Channel::Json) {
        return Err(ResolveJsonAgentError::NotJson {
            session_id: session_id.to_string(),
        });
    }

    let mode = resolve_mode(&ctx.session, registry)
        .await
        .map_err(ResolveJsonAgentError::ModeError)?;

    let plugin: Arc<dyn AgentPlugin> = Arc::from(resolve_plugin(provider_to_cli_id(mode.cli)));
    let seed_model = ctx
        .session
        .model_override
        .clone()
        .or_else(|| mode.model.clone());

    let agent = get_or_create_json_agent_session(
        registry,
        JsonAgentSessionOptions {
            project: ctx.project.clone(),
            worktree: ctx.worktree.clone(),
            session: ctx.session.clone(),
            plugin,
            daemon_port,
            cli: mode.cli,
            model: seed_model,
            mode_id: mode.mode_id.clone(),
            mode_name: mode.mode_name.clone(),
            store_handle: store.clone(),
            broadcaster,
        },
    );

    Ok(ResolvedJsonAgent { agent, ctx, mode })
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/// Return type from `enqueue_chat_turn`.
#[derive(Debug)]
pub struct EnqueueChatResult {
    pub turn_id: String,
    pub queue_position: usize,
    pub delivery: Option<EnqueueDelivery>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueDelivery {
    Queued,
    Steered,
}

/// Options for `enqueue_chat_turn`.
pub struct EnqueueChatTurnOpts {
    pub session_id: String,
    pub message: String,
    pub attachments: Vec<Attachment>,
    pub daemon_port: u16,
    /// `Some(false)` skips steering and always enqueues FIFO (D8).
    pub steer: Option<bool>,
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
}

/// Enqueue a user turn on a session's JSON agent.
pub async fn enqueue_chat_turn(
    opts: EnqueueChatTurnOpts,
    registry: &JsonAgentRegistry<JsonAgentSession>,
) -> Result<EnqueueChatResult, ResolveJsonAgentError> {
    let resolved = resolve_json_agent(
        &opts.session_id,
        opts.daemon_port,
        &opts.store,
        registry,
        opts.broadcaster,
    )
    .await?;

    let ResolvedJsonAgent { agent, ctx, mode } = resolved;

    let system_prompt = if agent.is_first_turn_pending() {
        Some(build_system_prompt(&ctx, &mode))
    } else {
        None
    };

    let message = inject_attachments(&opts.message, &opts.attachments, false);

    let result = if opts.steer == Some(false) {
        let r = agent.enqueue(
            message,
            opts.attachments,
            system_prompt,
            None, // fork_from_chat_id
        );
        EnqueueChatResult {
            turn_id: r.turn_id,
            queue_position: r.queue_position,
            delivery: Some(EnqueueDelivery::Queued),
        }
    } else {
        let r = agent
            .submit(
                message,
                opts.attachments,
                system_prompt,
                None, // fork_from_chat_id
            )
            .await;
        EnqueueChatResult {
            turn_id: r.turn_id,
            queue_position: r.queue_position,
            delivery: Some(match r.delivery {
                json_agent_session::queue::SubmitDelivery::Queued => EnqueueDelivery::Queued,
                json_agent_session::queue::SubmitDelivery::Steered => EnqueueDelivery::Steered,
            }),
        }
    };

    Ok(result)
}

// ---------------------------------------------------------------------------
// Auto-enqueue turn 1 at create time
// ---------------------------------------------------------------------------

/// `reason` on the `waiting_for_human` transition of a prompt-less json session.
pub const READY_REASON: &str = "ready";

/// Options for `start_json_create_turn`.
pub struct StartJsonCreateTurnOpts {
    pub session_id: String,
    pub prompt: Option<String>,
    pub daemon_port: u16,
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
}

/// Auto-enqueue the create-dialog prompt as turn 1 (Decision 8 / CUJ 1).
pub async fn start_json_create_turn(
    opts: StartJsonCreateTurnOpts,
    registry: &JsonAgentRegistry<JsonAgentSession>,
) {
    let prompt = match opts.prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(p) => p.to_string(),
        None => {
            // No turn 1 (e.g. a plain reset of a Rich Chat agent): nothing will
            // ever move the session off `not_started`, and the UI shows a
            // "Starting…" placeholder with no composer for that state — the
            // agent would be stuck forever. Mark it ready for the user's first
            // message instead.
            if let Some(ctx) = find_json_session_context(&opts.store, &opts.session_id).await {
                if ctx.session.lifecycle.state == LifecycleState::NotStarted {
                    // reason "ready": a never-prompted session being idle is not
                    // "a subagent finished" — the subagent-notify listener skips it
                    // so a reset/prompt-less child doesn't wake its parent.
                    let lifecycle = SessionLifecycle {
                        state: LifecycleState::WaitingForHuman,
                        reason: Some(READY_REASON.to_string()),
                        last_transition_at: now_iso_8601(),
                    };
                    let _ = opts
                        .store
                        .update_session_lifecycle(&ctx.project.id, &ctx.session.id, lifecycle)
                        .await;
                    opts.broadcaster.send(ServerEvent::SessionState {
                        session_id: ctx.session.id.clone(),
                        state: LifecycleState::WaitingForHuman,
                        reason: Some(READY_REASON.to_string()),
                    });
                }
            }
            return;
        }
    };

    // Guard: skip if the session was already marked done.
    let pre_ctx = find_json_session_context(&opts.store, &opts.session_id).await;
    let done = pre_ctx
        .as_ref()
        .map_or(true, |c| c.session.lifecycle.state == LifecycleState::Done);
    if done {
        return;
    }

    let res = enqueue_chat_turn(
        EnqueueChatTurnOpts {
            session_id: opts.session_id.clone(),
            message: prompt,
            attachments: vec![],
            daemon_port: opts.daemon_port,
            steer: None,
            store: opts.store.clone(),
            broadcaster: opts.broadcaster.clone(),
        },
        registry,
    )
    .await;

    if let Err(e) = res {
        eprintln!(
            "[json-chat] turn-1 auto-enqueue failed for {}: {:?}",
            opts.session_id, e
        );
        return;
    }

    // Persist lifecycle → working.
    if let Some(ctx) = find_json_session_context(&opts.store, &opts.session_id).await {
        let lifecycle = SessionLifecycle {
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: now_iso_8601(),
        };
        let _ = opts
            .store
            .update_session_lifecycle(&ctx.project.id, &ctx.session.id, lifecycle)
            .await;
        opts.broadcaster.send(ServerEvent::SessionState {
            session_id: ctx.session.id.clone(),
            state: LifecycleState::Working,
            reason: None,
        });
    }
}

// ---------------------------------------------------------------------------
// Transcript / meta read helpers
// ---------------------------------------------------------------------------

/// Full transcript for a session (live if registered, else disk).
pub fn read_session_transcript(
    ctx: &JsonSessionContext,
    registry: &JsonAgentRegistry<JsonAgentSession>,
) -> Vec<vst_types::domain::NormalizedEvent> {
    if let Some(live) = registry.get(&ctx.session.id) {
        return live.read_transcript();
    }
    read_transcript_from_data_dir(&session_data_dir_for(ctx), &ctx.session.id)
}

/// Bounded tail-N turns + cursor.
pub fn read_session_tail(
    ctx: &JsonSessionContext,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    n_turns: i64,
) -> TranscriptPage {
    if let Some(live) = registry.get(&ctx.session.id) {
        return live.tail(n_turns);
    }
    read_tail_from_data_dir(&session_data_dir_for(ctx), &ctx.session.id, n_turns)
}

/// Keyset "load earlier" page.
pub fn read_session_page_before(
    ctx: &JsonSessionContext,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    before_seq: i64,
    limit: i64,
) -> TranscriptPage {
    if let Some(live) = registry.get(&ctx.session.id) {
        return live.page_before(before_seq, limit);
    }
    read_page_before_from_data_dir(
        &session_data_dir_for(ctx),
        &ctx.session.id,
        before_seq,
        limit,
    )
}

/// Reconnect delta — bounded forward page of events newer than `since_seq`.
pub fn read_session_since(
    ctx: &JsonSessionContext,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    since_seq: i64,
) -> SincePage {
    if let Some(live) = registry.get(&ctx.session.id) {
        return live.since(since_seq, None);
    }
    read_since_from_data_dir(&session_data_dir_for(ctx), &ctx.session.id, since_seq)
}

/// Rebuild a session's meta with the store-backed scheduled-send fields filled
/// in. `scheduled_sends` is ALWAYS `Some` (an empty list when nothing is
/// pending): the client treats `None` as "this event doesn't carry the field,
/// keep what you have", so an empty `Some([])` is the only way to clear the
/// tray after the last pending message fires or is cancelled.
pub async fn read_session_meta_with_schedule(
    store: &StoreHandle,
    ctx: &JsonSessionContext,
    registry: &JsonAgentRegistry<JsonAgentSession>,
) -> SessionMeta {
    let mut meta = read_session_meta(ctx, registry).await;
    apply_schedule_state(store, &ctx.session.id, &mut meta).await;
    meta
}

/// The store-backed scheduled-send state of a session — each list authoritative
/// (empty = nothing; a client treats an absent field as "keep what you have").
pub struct ScheduleState {
    pub sends: Vec<ScheduledMessageMeta>,
    pub failed: Vec<ScheduledFailedMeta>,
    pub turn_ids: Vec<String>,
}

pub async fn read_schedule_state(store: &StoreHandle, session_id: &str) -> ScheduleState {
    // One transaction, so pending / failed / sent can't be a mixed snapshot.
    let snap = store
        .read_schedule_snapshot(session_id)
        .await
        .unwrap_or_else(|_| vst_store::ScheduleSnapshot {
            pending: vec![],
            failed: vec![],
            sent_turn_ids: vec![],
        });
    ScheduleState {
        sends: snap
            .pending
            .into_iter()
            .map(|r| ScheduledMessageMeta {
                attachments: parse_attachments_json(r.attachments.as_deref()),
                id: r.id,
                message: r.message,
                fire_at: r.fire_at,
            })
            .collect(),
        failed: snap
            .failed
            .into_iter()
            .map(|r| ScheduledFailedMeta {
                attachments: parse_attachments_json(r.attachments.as_deref()),
                id: r.id,
                message: r.message,
                fire_at: r.fire_at,
                failure_reason: r
                    .failure_reason
                    .unwrap_or_else(|| "Delivery failed".to_string()),
            })
            .collect(),
        turn_ids: snap.sent_turn_ids,
    }
}

/// Fill the store-backed scheduled-send fields of `meta`. Live agent meta never
/// carries them, so any path that hands a client a FRESH full snapshot —
/// `chat:open`, `GET /meta` — must apply this. (Schedule *changes* go out as
/// the slim `session:scheduled` event instead; see `broadcast_scheduled_meta`.)
pub async fn apply_schedule_state(store: &StoreHandle, session_id: &str, meta: &mut SessionMeta) {
    let st = read_schedule_state(store, session_id).await;
    meta.scheduled_sends = Some(st.sends);
    meta.scheduled_failed = Some(st.failed);
    meta.scheduled_turn_ids = Some(st.turn_ids);
}

fn parse_attachments_json(json: Option<&str>) -> Option<Vec<Attachment>> {
    json.and_then(|s| serde_json::from_str::<Vec<Attachment>>(s).ok())
}

/// Persist the session's lifecycle axis to `working` and broadcast the state
/// change (JSON lifecycle, D11) — what every human-originated turn does once
/// it has been handed to the agent.
pub async fn persist_session_working(
    store: &StoreHandle,
    broadcaster: &Broadcaster,
    ctx: &JsonSessionContext,
) {
    let lifecycle = SessionLifecycle {
        state: LifecycleState::Working,
        reason: None,
        last_transition_at: now_iso_8601(),
    };
    let _ = store
        .update_session_lifecycle(&ctx.project.id, &ctx.session.id, lifecycle)
        .await;
    broadcaster.send(ServerEvent::SessionState {
        session_id: ctx.session.id.clone(),
        state: LifecycleState::Working,
        reason: None,
    });
}

/// Deliver a claimed scheduled message exactly as if the user had pressed
/// Send on freshly typed text: `submit()` steers a running turn when it can
/// and otherwise queues, and the session is marked working. Returns a
/// human-readable reason on failure (shown to the user with Retry / Dismiss).
pub async fn deliver_scheduled_message(
    row: &vst_types::rest::sessions::ScheduledMessageRow,
    daemon_port: u16,
    store: &StoreHandle,
    broadcaster: &Broadcaster,
    registry: &JsonAgentRegistry<JsonAgentSession>,
) -> Result<EnqueueChatResult, String> {
    let ctx = find_json_session_context(store, &row.session_id)
        .await
        .ok_or_else(|| "The session no longer exists.".to_string())?;
    if ctx.session.archived_at.is_some() {
        return Err("The session was archived before this message was due.".to_string());
    }
    let result = enqueue_chat_turn(
        EnqueueChatTurnOpts {
            session_id: row.session_id.clone(),
            message: row.message.clone(),
            attachments: parse_attachments_json(row.attachments.as_deref()).unwrap_or_default(),
            daemon_port,
            steer: Some(true),
            store: store.clone(),
            broadcaster: broadcaster.clone(),
        },
        registry,
    )
    .await
    .map_err(|e| match e {
        ResolveJsonAgentError::NotFound { .. } => "The session no longer exists.".to_string(),
        ResolveJsonAgentError::NotJson { .. } => {
            "The session is no longer a Rich Chat session.".to_string()
        }
        ResolveJsonAgentError::ModeError(m) => format!("The agent could not be started: {m}"),
    })?;
    persist_session_working(store, broadcaster, &ctx).await;
    Ok(result)
}

/// Tell every client a session's scheduled-send state changed. Sends only the
/// scheduled fields (never a full `SessionMeta`): a turn-state snapshot taken
/// here could land after a fresher live `session:meta` and overwrite it.
pub async fn broadcast_scheduled_meta(
    store: &StoreHandle,
    broadcaster: &Broadcaster,
    session_id: &str,
) {
    let st = read_schedule_state(store, session_id).await;
    broadcaster.send(ServerEvent::SessionScheduledChanged {
        session_id: session_id.to_string(),
        scheduled_sends: st.sends,
        scheduled_failed: st.failed,
        scheduled_turn_ids: st.turn_ids,
    });
}

/// Latest meta for a session (live if registered, else rebuilt from transcript).
pub async fn read_session_meta(
    ctx: &JsonSessionContext,
    registry: &JsonAgentRegistry<JsonAgentSession>,
) -> SessionMeta {
    if let Some(live) = registry.get(&ctx.session.id) {
        return live.get_meta();
    }
    // No live session — rebuild from the transcript tail.
    let mut cli = NormalizedEventProvider::Claude;
    let mut mode_id = None;
    let mut mode_name = None;
    if let Ok(mode) = resolve_mode(&ctx.session, registry).await {
        cli = mode.cli;
        mode_id = mode.mode_id;
        mode_name = mode.mode_name;
    }
    let cwd = ctx.worktree.as_ref().map_or_else(
        || ctx.project.absolute_path.clone(),
        |w| {
            Paths::default()
                .project_dir(&ctx.project.id)
                .join("worktrees")
                .join(&w.id)
                .display()
                .to_string()
        },
    );
    let opts = MetaOptions {
        session_id: ctx.session.id.clone(),
        cli: crate::json_agent_session::provider_str(cli),
        mode_id,
        mode_name,
        model_override: ctx.session.model_override.clone(),
        cwd: Some(cwd),
        model_overridden: ctx.session.model_override.is_some(),
    };
    let meta: TranscriptMeta = read_meta_from_data_dir(&session_data_dir_for(ctx), &ctx.session.id);
    build_meta_from_store_meta(&opts, &meta)
}
