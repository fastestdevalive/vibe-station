//! `routes/sessions.ts` — Group A (dispatch #1) + Group B1 (dispatch #2) +
//! Group B2 (dispatch #3) + Group C (dispatch #4) + Group D (dispatch #5).
//!
//! Group A ports the slice of `daemon/src/routes/sessions.ts` (lines 1-1069):
//! `findSessionContext`, `findWorktreeContext`, `serializeSession` /
//! `serializeGlobalDraft`, `runAgentSpawnJob` / `runDirectAgentSpawnJob` /
//! `spawnNewSessionForChannel`, and the `GET /sessions`, `GET /sessions/:id`,
//! `GET /sessions/:id/output`, `POST /sessions` handlers.
//!
//! Group B1 ports `DELETE /sessions/:id`, `PATCH .../draft`, `POST .../start`
//! (draft promotion), and `PATCH .../pin|rename|reorder|delink` (lines
//! 1072-~1770).
//!
//! Group B2 ports `POST .../done|resume|reset|handoff` (lines ~1770-2224).
//!
//! Group C ports the send/chat/queue slice (lines 2226-2606): `sendHandler`
//! (`POST .../send`), `POST .../chat`, `.../chat/dismiss-notice`,
//! `.../chat/promote-notice`, `.../chat/stop`,
//! `DELETE .../chat/queue/:turnId`, `.../chat/queue/:turnId/edit|resubmit|promote`,
//! and `PATCH .../chat/model`. These are mostly thin dispatch into
//! `vst-agents::JsonAgentSession` / `json_agent_chat` (part 04c).
//!
//! `.../chat/fork` (edit-a-sent-message) was ported here in dispatch #4 but
//! removed in a later pass per an architecture decision to drop the whole
//! one-shot-per-turn fork path entirely (no ACP equivalent; claude-only;
//! `vst-agents`' underlying `fork_turn`/`get_fork_command` machinery from
//! parts 04a-04c is left in place pending those parts' own descoping — not
//! touched here, since removing it would reopen already-gated crates outside
//! this part's scope).
//!
//! Group D ports `spawnTtyForAgent` helper, `PATCH .../channel`,
//! `GET .../transcript`, and `GET .../meta` (approx lines 2608-3009).
//!
//! Handler bodies are exposed as methods on [`SessionRoutes`] (taking a
//! [`StoreHandle`] plus the runtime handles the spawn paths need) so part 08
//! can wire them to axum. Wire shapes come exclusively from `vst-types::rest`
//! (07a defines no new `Serialize`/`Deserialize` types).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vst_agents::context::{
    build_vst_env, resolved_context_of, session_data_dir_for, system_prompt_path_for,
    BuildVstEnvOptions,
};
use vst_agents::json_agent_chat::{
    enqueue_chat_turn, find_json_session_context, read_session_meta, read_session_page_before,
    read_session_since, read_session_tail, read_session_transcript, resolve_json_agent,
    start_json_create_turn, EnqueueChatTurnOpts, EnqueueDelivery, ResolveJsonAgentError,
    StartJsonCreateTurnOpts,
};
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_agents::native_history_importer::has_native_history_importer;
use vst_agents::plugin::{CaptureArgs, RestoreArgs};
use vst_agents::prompt_builder::{
    build_direct_prompt, build_prompt, BuildDirectPromptInput, BuildPromptInput,
};
use vst_agents::session_runtime::{release_session_runtime, ReleaseOpts};
use vst_agents::{resolve_plugin, AgentPlugin, LaunchConfig, PluginContext};
use vst_git::direct_pty::PtyKill;
use vst_git::naming::{slugify_prompt, slugify_prompt_with};
use vst_git::paths::Paths;
use vst_git::session_id::{generate_session_id, tmux_name_for_session};
use vst_git::worktree_service::CreateWorktreeOpts;
use vst_git::{create_worktree_record, DirectPtyRegistry};
use vst_lifecycle::channel::{channel_transition, resolve_channel, session_channel};
use vst_lifecycle::handoff::{read_handoff_file_or_null, run_handoff_turn};
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_proc::pty::{spawn_child, PtyHandle, SpawnChildOptions};
use vst_proc::resolve_use_tmux::resolve_use_tmux;
use vst_proc::tmux::{CapturePaneOptions, NewSessionOptions, Tmux};
use vst_store::global_drafts::{GlobalDraftPatch, GlobalDraftRow};
use vst_store::{StoreError, StoreHandle};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::sessions::{
    AllEvents, ChatBody, CreateDraftSessionBody, CreateSessionBody, CreateTarget, DelinkResult,
    Delivery, DraftTarget, EditQueuedResult, EnqueueChatResult, HandoffResult, InputBody,
    PatchChannelBody, PatchChannelResult, PatchDraftBody, PatchModelBody, PatchModelResult,
    PinResult, RenameSessionResult, ReorderSessionResult, ResetBody, ResetResult, ResubmitBody,
    SessionOutput, SincePage, StartDraftBody, StartDraftResult, TranscriptPage, TurnActionResult,
};
use vst_types::rest::shared::{GlobalDraft, Mode, Session};
use vst_types::{
    Channel, CliId, DraftConfig, DraftEntryPoint, LifecycleState, NormalizedEventKind,
    NormalizedEventProvider, PrStatus, ProjectRecord, SessionLifecycle, SessionNameSource,
    SessionRecord, SessionType, TranscriptKind, TranscriptRef, WorktreeChoice, WorktreeRecord,
};
use vst_ws::connection::SessionStream;
use vst_ws::handlers::session_open::DirectStreamRegistry;
use vst_ws::state::attachment_registry::AttachmentRegistry;
use vst_ws::streams::pty_stream::PtySessionStream;

use crate::modes::{find_mode, resolve_mode_id};

pub use vst_types::rest::sessions::SessionOrDraft;

/// The `jsonUnsupported` callback's type — factored out to keep `SessionRoutes`
/// well-typed and satisfy clippy's `type_complexity`.
pub type JsonUnsupportedFn = Arc<dyn Fn(&str) -> Option<vst_types::CliId> + Send + Sync>;

/// One of the three places a session can live (mirrors the TS `SessionContext`).
///
/// The `Worktree`/`Direct` variants carry full records; `Global` carries only a
/// small row. The size difference is inherent to the domain model (mirrors the
/// TS shape exactly), so the large-enum-variant lint is deliberately allowed.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug)]
pub enum SessionContext {
    Worktree {
        project: ProjectRecord,
        worktree: WorktreeRecord,
        session: SessionRecord,
    },
    Direct {
        project: ProjectRecord,
        session: SessionRecord,
    },
    Global {
        row: GlobalDraftRow,
    },
}

/// Locate a session (worktree, then direct, then global draft) across all
/// projects. Mirrors the TS `findSessionContext`.
pub async fn find_session_context(store: &StoreHandle, session_id: &str) -> Option<SessionContext> {
    let projects = store.get_all_projects().await;
    for project in projects {
        for worktree in &project.worktrees {
            if let Some(session) = worktree.sessions.iter().find(|s| s.id == session_id) {
                return Some(SessionContext::Worktree {
                    project: project.clone(),
                    worktree: worktree.clone(),
                    session: session.clone(),
                });
            }
        }
        if let Some(session) = project.direct_sessions.iter().find(|s| s.id == session_id) {
            return Some(SessionContext::Direct {
                project: project.clone(),
                session: session.clone(),
            });
        }
    }
    store
        .get_global_draft(session_id)
        .await
        .map(|row| SessionContext::Global { row })
}

/// Locate a worktree across all projects. Mirrors the TS `findWorktreeContext`.
pub async fn find_worktree_context(
    store: &StoreHandle,
    worktree_id: &str,
) -> Option<(ProjectRecord, WorktreeRecord)> {
    let projects = store.get_all_projects().await;
    for project in projects {
        if let Some(worktree) = project.worktrees.iter().find(|w| w.id == worktree_id) {
            return Some((project.clone(), worktree.clone()));
        }
    }
    None
}

/// Flatten a `SessionRecord` into the REST `Session` wire shape. Mirrors the
/// TS `serializeSession`.
pub fn serialize_session(
    worktree_id: Option<&str>,
    project_id: &str,
    s: &SessionRecord,
) -> Session {
    Session {
        id: s.id.clone(),
        worktree_id: worktree_id.map(str::to_string),
        project_id: project_id.to_string(),
        is_main: s.is_main,
        r#type: s.r#type,
        mode_id: s.mode_id.clone(),
        name: s.name.clone(),
        name_source: s.name_source,
        tmux_name: s.tmux_name.clone(),
        use_tmux: s.use_tmux,
        channel: session_channel(s.channel, Some(s.use_tmux)),
        state: s.lifecycle.state,
        lifecycle_state: s.lifecycle.state,
        created_at: s.lifecycle.last_transition_at.clone(),
        pinned_at: s.pinned_at.clone(),
        archived_at: s.archived_at.clone(),
        sort_order: s.sort_order,
        handoff_summary: s.handoff_summary.clone(),
        parent_session_id: s.parent_session_id.clone(),
        superseded_by: s.superseded_by.clone(),
        pr: s.pr.clone(),
        draft_prompt: s.draft_prompt.clone(),
        draft_config: s.draft_config.clone(),
    }
}

/// Flatten a `GlobalDraftRow` into the REST `GlobalDraft` wire shape. Mirrors
/// the TS `serializeGlobalDraft`.
pub fn serialize_global_draft(row: &GlobalDraftRow) -> GlobalDraft {
    let sort_order = row
        .sort_order
        .unwrap_or_else(|| parse_ms(&row.created_at).unwrap_or(0.0));
    let draft_config = row
        .draft_config
        .as_deref()
        .and_then(|s| serde_json::from_str::<DraftConfig>(s).ok());
    GlobalDraft {
        id: row.id.clone(),
        worktree_id: None,
        project_id: None,
        is_main: false,
        r#type: SessionType::Agent,
        mode_id: None,
        name: row.name.clone(),
        name_source: row
            .name_source
            .as_deref()
            .and_then(|s| serde_json::from_str::<SessionNameSource>(&format!("\"{s}\"")).ok()),
        tmux_name: format!("__draft__-{}", row.id),
        use_tmux: false,
        channel: Channel::Json,
        state: LifecycleState::Drafting,
        lifecycle_state: LifecycleState::Drafting,
        created_at: row.created_at.clone(),
        pinned_at: None,
        archived_at: None,
        sort_order,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        draft_prompt: row.draft_prompt.clone(),
        draft_config,
    }
}

/// Parse an ISO8601 timestamp as unix-ms (best-effort; `None` on failure).
fn parse_ms(iso: &str) -> Option<f64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month: i64 = iso.get(5..7)?.parse().ok()?;
    let day: i64 = iso.get(8..10)?.parse().ok()?;
    let hour: i64 = iso.get(11..13)?.parse().ok()?;
    let min: i64 = iso.get(14..16)?.parse().ok()?;
    let sec: i64 = iso.get(17..19)?.parse().ok()?;
    let days = days_from_civil(year, month, day) as f64;
    let secs = days * 86400.0 + hour as f64 * 3600.0 + min as f64 * 60.0 + sec as f64;
    Some((secs * 1000.0).floor())
}

/// Days since epoch from a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Runtime handles the route handlers need.
pub struct SessionRoutes {
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
    pub json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
    /// Direct-pty streams keyed by session id (spawned by this crate's spawn
    /// path). Provides `get_recent_output` for `GET /sessions/:id/output`.
    pub direct_ptys: std::sync::RwLock<HashMap<String, PtyHandle>>,
    /// Shared with `vst-ws`'s `DispatchContext` (same `Arc` — NOT re-created
    /// per clone, unlike `direct_ptys` above): `session:open`'s handler reads
    /// this to find the `SessionStream` for a `use_tmux: false` session.
    /// Without this being populated from the SAME spawn path that inserts
    /// into `direct_ptys`, every non-tmux ("plain terminal", `useTmux`
    /// unchecked in `NewTerminalDialog`) session's `session:open` fails with
    /// "Session '<id>' not running" the moment it (re-)attaches — surfacing
    /// to the user as the session appearing to close/terminate. Confirmed:
    /// `PtySessionStream` (the adapter this registry is supposed to hold)
    /// was previously constructed nowhere in the codebase.
    pub direct_streams: DirectStreamRegistry,
    pub tmux: Tmux,
    pub daemon_port: u16,
    pub json_unsupported: JsonUnsupportedFn,
    /// Subagent-notify coalescer state — `DELETE`/`delink` clear a removed
    /// session's entries (mirrors `forgetSubagentNotify`).
    pub subagent_notify: SubagentNotifyHandle,
    /// Uploaded-attachment registry — resolves `attachmentIds` → `Attachment`
    /// records for `/send`, `/chat`, `/resubmit` (mirrors
    /// `attachmentRegistry.ts`).
    pub attachment_registry: AttachmentRegistry,
}

impl std::fmt::Debug for SessionRoutes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionRoutes").finish_non_exhaustive()
    }
}

impl Clone for SessionRoutes {
    fn clone(&self) -> Self {
        // `SessionRoutes` holds only cheap handles; the RwLock is re-created
        // on clone so the clone shares no mutable state (spawn jobs clone the
        // routes to run in the background).
        SessionRoutes {
            store: self.store.clone(),
            broadcaster: self.broadcaster.clone(),
            json_registry: self.json_registry.clone(),
            direct_ptys: std::sync::RwLock::new(
                self.direct_ptys
                    .read()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ),
            // Shared `Arc` — clone it, don't snapshot-copy it (unlike
            // `direct_ptys` above), so an insert from a background spawn
            // job's clone is visible to every other clone, including the
            // one serving `session:open` over WS.
            direct_streams: self.direct_streams.clone(),
            tmux: self.tmux.clone(),
            daemon_port: self.daemon_port,
            json_unsupported: self.json_unsupported.clone(),
            subagent_notify: self.subagent_notify.clone(),
            attachment_registry: self.attachment_registry.clone(),
        }
    }
}

impl SessionRoutes {
    /// `GET /sessions` — filter by worktree, project, or all (worktree +
    /// direct + global drafts).
    pub async fn list_sessions(
        &self,
        worktree: Option<&str>,
        project: Option<&str>,
    ) -> Result<Vec<SessionOrDraft>, String> {
        if let Some(wt_id) = worktree {
            let (project, worktree) = find_worktree_context(&self.store, wt_id)
                .await
                .ok_or_else(|| format!("Worktree '{wt_id}' not found"))?;
            return Ok(worktree
                .sessions
                .iter()
                .map(|s| {
                    SessionOrDraft::Session(serialize_session(Some(&worktree.id), &project.id, s))
                })
                .collect());
        }

        if let Some(project_id) = project {
            let project = self
                .store
                .get_project(project_id)
                .await
                .ok_or_else(|| format!("Project '{project_id}' not found"))?;
            let mut items: Vec<SessionOrDraft> = Vec::new();
            for w in &project.worktrees {
                for s in &w.sessions {
                    items.push(SessionOrDraft::Session(serialize_session(
                        Some(&w.id),
                        &project.id,
                        s,
                    )));
                }
            }
            for s in &project.direct_sessions {
                items.push(SessionOrDraft::Session(serialize_session(
                    None,
                    &project.id,
                    s,
                )));
            }
            return Ok(items);
        }

        let mut items: Vec<SessionOrDraft> = Vec::new();
        for project in self.store.get_all_projects().await {
            for w in &project.worktrees {
                for s in &w.sessions {
                    items.push(SessionOrDraft::Session(serialize_session(
                        Some(&w.id),
                        &project.id,
                        s,
                    )));
                }
            }
            for s in &project.direct_sessions {
                items.push(SessionOrDraft::Session(serialize_session(
                    None,
                    &project.id,
                    s,
                )));
            }
        }
        for row in self.store.get_all_global_drafts().await {
            items.push(SessionOrDraft::GlobalDraft(serialize_global_draft(&row)));
        }
        Ok(items)
    }

    /// `GET /sessions/:id`.
    pub async fn get_session(&self, id: &str) -> Result<SessionOrDraft, String> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| format!("Session '{id}' not found"))?;
        match ctx {
            SessionContext::Worktree {
                project,
                worktree,
                session,
            } => Ok(SessionOrDraft::Session(serialize_session(
                Some(&worktree.id),
                &project.id,
                &session,
            ))),
            SessionContext::Direct { project, session } => Ok(SessionOrDraft::Session(
                serialize_session(None, &project.id, &session),
            )),
            SessionContext::Global { row } => {
                Ok(SessionOrDraft::GlobalDraft(serialize_global_draft(&row)))
            }
        }
    }

    /// `GET /sessions/:id/output?lines=N`.
    pub async fn session_output(
        &self,
        id: &str,
        lines: Option<&str>,
    ) -> Result<SessionOutput, String> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| format!("Session '{id}' not found"))?;
        if let SessionContext::Global { .. } = ctx {
            return Ok(SessionOutput {
                id: id.to_string(),
                output: String::new(),
            });
        }
        let (project_id, session) = match &ctx {
            SessionContext::Worktree {
                project, session, ..
            } => (project.id.clone(), session.clone()),
            SessionContext::Direct { project, session } => (project.id.clone(), session.clone()),
            SessionContext::Global { .. } => unreachable!(),
        };
        let n = lines
            .and_then(|l| l.parse::<i64>().ok())
            .unwrap_or(100)
            .clamp(1, 10_000);
        let _ = project_id;

        if session_channel(session.channel, Some(session.use_tmux)) == Channel::Json {
            let json_ctx = find_json_session_context(&self.store, id)
                .await
                .ok_or_else(|| format!("json session context missing for '{id}'"))?;
            let page = read_session_tail(&json_ctx, &self.json_registry, n);
            let output = group_json_output(&page.events);
            return Ok(SessionOutput {
                id: id.to_string(),
                output,
            });
        }

        if !session.use_tmux {
            let output = self
                .direct_ptys
                .read()
                .unwrap()
                .get(id)
                .map(|h| h.get_recent_output((n as usize).saturating_mul(200)))
                .unwrap_or_default();
            return Ok(SessionOutput {
                id: id.to_string(),
                output,
            });
        }

        let output = self
            .tmux
            .capture_pane(
                &session.tmux_name,
                &CapturePaneOptions {
                    escape: false,
                    lines: Some(n as usize),
                },
            )
            .unwrap_or_default();
        Ok(SessionOutput {
            id: id.to_string(),
            output,
        })
    }

    /// `POST /sessions` — draft branch and normal create. Returns the created
    /// session/draft (wire shape) on success.
    pub async fn create_session(
        &self,
        body: &serde_json::Value,
    ) -> Result<SessionOrDraft, CreateError> {
        if body.get("state").and_then(|v| v.as_str()) == Some("drafting") {
            return self.create_draft_session(body).await;
        }
        let parsed: CreateSessionBody = serde_json::from_value(body.clone())
            .map_err(|e| CreateError::Validation(format!("Validation error: {e}")))?;
        self.create_normal_session(parsed).await
    }

    async fn create_draft_session(
        &self,
        body: &serde_json::Value,
    ) -> Result<SessionOrDraft, CreateError> {
        let draft: CreateDraftSessionBody = serde_json::from_value(body.clone())
            .map_err(|e| CreateError::Validation(format!("Validation error: {e}")))?;
        let session_type = draft.r#type;

        if draft.target == Some(DraftTarget::Global) {
            let session_id = generate_session_id("global", session_type);
            let row = GlobalDraftRow {
                id: session_id.clone(),
                draft_prompt: draft.draft_prompt.clone(),
                draft_config: draft
                    .draft_config
                    .as_ref()
                    .and_then(|v| serde_json::to_string(v).ok()),
                name: None,
                name_source: None,
                sort_order: Some(ms_now() as f64),
                created_at: now_iso(),
            };
            self.store
                .add_global_draft(&row)
                .await
                .map_err(create_err)?;
            let global_draft = serialize_global_draft(&row);
            self.broadcaster.send(ServerEvent::SessionCreated {
                session_id,
                project_id: None,
                worktree_id: None,
                session_type: session_type_str(session_type).to_string(),
                mode: None,
                snapshot: Some((&global_draft).into()),
                parent_session_id: None,
            });
            return Ok(SessionOrDraft::GlobalDraft(global_draft));
        }

        let (derived_project_id, derived_worktree_id) = if let Some(wt_id) = &draft.worktree_id {
            let (project, _) = find_worktree_context(&self.store, wt_id)
                .await
                .ok_or_else(|| CreateError::NotFound(format!("Worktree '{wt_id}' not found")))?;
            (Some(project.id), Some(wt_id.clone()))
        } else {
            (draft.project_id.clone(), None)
        };

        let project_id = derived_project_id.ok_or_else(|| {
            CreateError::Validation(
                "projectId or worktreeId is required for draft sessions".to_string(),
            )
        })?;
        if self.store.get_project(&project_id).await.is_none() {
            return Err(CreateError::NotFound(format!(
                "Project '{project_id}' not found"
            )));
        }

        let session_id = generate_session_id(&project_id, session_type);
        let record = draft_session_record(
            &session_id,
            &project_id,
            &derived_worktree_id,
            session_type,
            &draft,
        );

        if let Some(wt_id) = &derived_worktree_id {
            let wt_id = wt_id.clone();
            let rec = record.clone();
            self.store
                .mutate_project(&project_id, move |p| {
                    for w in &mut p.worktrees {
                        if w.id == wt_id {
                            w.sessions.push(rec.clone());
                            return Ok(p.clone());
                        }
                    }
                    Err(vst_store::StoreError::Mutation(format!(
                        "worktree '{wt_id}' not found in project"
                    )))
                })
                .await
                .map_err(create_err)?;
        } else {
            let rec = record.clone();
            self.store
                .mutate_project(&project_id, move |p| {
                    p.direct_sessions.push(rec.clone());
                    Ok(p.clone())
                })
                .await
                .map_err(create_err)?;
        }

        let serialized = serialize_session(derived_worktree_id.as_deref(), &project_id, &record);
        self.broadcaster.send(ServerEvent::SessionCreated {
            session_id: session_id.clone(),
            project_id: Some(project_id.clone()),
            worktree_id: derived_worktree_id.clone(),
            session_type: session_type_str(session_type).to_string(),
            mode: None,
            snapshot: Some((&serialized).into()),
            parent_session_id: None,
        });

        Ok(SessionOrDraft::Session(serialized))
    }

    async fn create_normal_session(
        &self,
        data: CreateSessionBody,
    ) -> Result<SessionOrDraft, CreateError> {
        let r#type = data.r#type;
        let prompt = data.prompt.clone();
        let mut mode_id = data.mode_id.clone();

        // Decision 2: subagent inherits parent mode + channel.
        let mut inherited_channel: Option<Channel> = None;
        if let Some(source_agent_id) = &data.source_agent_id {
            if let Some(source) = find_session_context(&self.store, source_agent_id).await {
                match &source {
                    SessionContext::Worktree { session, .. }
                    | SessionContext::Direct { session, .. } => {
                        if mode_id.is_none() {
                            mode_id = session.mode_id.clone();
                        }
                        if data.channel.is_none() {
                            inherited_channel = session.channel;
                        }
                    }
                    SessionContext::Global { .. } => {}
                }
            }
        }

        let resolved_channel = data.channel.or(inherited_channel);
        let no_channel = resolved_channel.is_none();
        let no_use_tmux = data.use_tmux.is_none();
        let defaulted_channel = if no_channel && no_use_tmux {
            Some(if r#type == SessionType::Terminal {
                Channel::Tmux
            } else {
                Channel::Json
            })
        } else {
            None
        };
        let use_tmux = if let Some(c) = resolved_channel {
            c == Channel::Tmux
        } else if let Some(c) = defaulted_channel {
            c == Channel::Tmux
        } else {
            resolve_use_tmux(data.use_tmux)
        };
        let channel = defaulted_channel
            .or(resolved_channel)
            .unwrap_or_else(|| resolve_channel(use_tmux, false));
        let is_json = channel == Channel::Json;

        if r#type == SessionType::Agent && mode_id.is_none() {
            return Err(CreateError::Validation(
                "'modeId' is required for agent sessions".to_string(),
            ));
        }

        if r#type == SessionType::Agent {
            if let Some(mid) = &mode_id {
                let resolved = resolve_mode_id(mid)
                    .ok_or_else(|| CreateError::Validation(format!("Mode '{mid}' not found")))?;
                mode_id = Some(resolved);
            }
        }

        if is_json && r#type == SessionType::Agent {
            if let Some(mid) = &mode_id {
                if let Some(cli) = (self.json_unsupported)(mid) {
                    return Err(CreateError::Validation(format!(
                        "{} does not support JSON chat mode",
                        cli_name(cli)
                    )));
                }
            }
        }

        let is_direct = data.target == Some(CreateTarget::Direct) || data.worktree_id.is_none();
        if is_direct {
            self.create_direct_session(&data, r#type, mode_id, prompt, use_tmux, channel, is_json)
                .await
        } else {
            self.create_worktree_session(&data, r#type, mode_id, prompt, use_tmux, channel, is_json)
                .await
        }
    }

    /// The 8 parameters mirror the TS `POST /sessions` direct arm's destructured
    /// create inputs; a params struct is deferred (07a continuation scope).
    #[allow(clippy::too_many_arguments)]
    async fn create_direct_session(
        &self,
        data: &CreateSessionBody,
        r#type: SessionType,
        mode_id: Option<String>,
        prompt: Option<String>,
        use_tmux: bool,
        channel: Channel,
        is_json: bool,
    ) -> Result<SessionOrDraft, CreateError> {
        let project_id = data.project_id.clone().ok_or_else(|| {
            CreateError::Validation("projectId is required for direct sessions".to_string())
        })?;
        let project =
            self.store.get_project(&project_id).await.ok_or_else(|| {
                CreateError::NotFound(format!("Project '{project_id}' not found"))
            })?;

        let session_id = generate_session_id(&project_id, r#type);
        let tmux_name = if use_tmux {
            vst_git::session_id::tmux_name_for_session(&session_id)
        } else {
            format!("__direct__-{session_id}")
        };
        let next_direct_seq = project.direct_session_seq.unwrap_or(0) + 1;
        let (session_name, name_source) = derive_name(
            &data.name,
            r#type,
            &prompt,
            NameFallback::Direct(next_direct_seq),
        );

        let mut record = SessionRecord {
            id: session_id.clone(),
            worktree_id: None,
            project_id: project.id.clone(),
            is_main: false,
            sort_order: ms_now() as f64,
            r#type,
            mode_id: if r#type == SessionType::Agent {
                mode_id.clone()
            } else {
                None
            },
            name: Some(session_name),
            name_source,
            tmux_name,
            use_tmux,
            channel: Some(channel),
            lifecycle: SessionLifecycle {
                state: LifecycleState::NotStarted,
                reason: None,
                last_transition_at: now_iso(),
            },
            draft_prompt: None,
            draft_config: None,
            initial_prompt: if r#type == SessionType::Agent {
                prompt.clone()
            } else {
                None
            },
            parent_session_id: data.source_agent_id.clone(),
            transcript_ref: transcript_ref_for_direct(project_id.clone(), &session_id, is_json),
            archived_at: None,
            handoff_summary: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            superseded_by: None,
            pr: None,
        };

        if r#type == SessionType::Terminal {
            let res = self.spawn_terminal(&project, &record, None, use_tmux).await;
            match res {
                Ok(()) => {
                    record.lifecycle = SessionLifecycle {
                        state: LifecycleState::Working,
                        reason: None,
                        last_transition_at: now_iso(),
                    };
                }
                Err(e) => {
                    return Err(CreateError::Internal(format!(
                        "Failed to spawn terminal: {e}"
                    )));
                }
            }
        }

        let rec = record.clone();
        let seq = next_direct_seq;
        self.store
            .mutate_project(&project.id, move |p| {
                p.direct_session_seq = Some(seq);
                p.direct_sessions.push(rec.clone());
                Ok(p.clone())
            })
            .await
            .map_err(create_err)?;

        let serialized = serialize_session(None, &project.id, &record);
        self.broadcaster.send(ServerEvent::SessionCreated {
            session_id: session_id.clone(),
            project_id: Some(project.id.clone()),
            worktree_id: None,
            session_type: session_type_str(r#type).to_string(),
            mode: mode_id.clone(),
            snapshot: Some((&serialized).into()),
            parent_session_id: record.parent_session_id.clone(),
        });

        if r#type == SessionType::Agent && mode_id.is_some() {
            let opts = SpawnChannelOpts {
                project: project.clone(),
                worktree: None,
                session: record.clone(),
                mode_id: mode_id.clone().unwrap(),
                prompt: prompt.clone(),
                daemon_port: self.daemon_port,
                skip_auto_turn: data.skip_auto_turn.unwrap_or(false),
            };
            let routes = self.clone();
            tokio::spawn(async move {
                routes.spawn_new_session_for_channel(opts).await;
            });
        }

        Ok(SessionOrDraft::Session(serialized))
    }

    /// See `create_direct_session`'s comment on the parameter count.
    #[allow(clippy::too_many_arguments)]
    async fn create_worktree_session(
        &self,
        data: &CreateSessionBody,
        r#type: SessionType,
        mode_id: Option<String>,
        prompt: Option<String>,
        use_tmux: bool,
        channel: Channel,
        is_json: bool,
    ) -> Result<SessionOrDraft, CreateError> {
        let worktree_id = data.worktree_id.clone().ok_or_else(|| {
            CreateError::Validation("worktreeId is required for worktree sessions".to_string())
        })?;
        let (project, worktree) = find_worktree_context(&self.store, &worktree_id)
            .await
            .ok_or_else(|| CreateError::NotFound(format!("Worktree '{worktree_id}' not found")))?;

        let session_id = generate_session_id(&worktree_id, r#type);
        let tmux_name = if use_tmux {
            vst_git::session_id::tmux_name_for_session(&session_id)
        } else {
            format!("__direct__-{session_id}")
        };

        let mut next_terminal_seq: Option<i64> = None;
        let mut next_agent_seq: Option<i64> = None;
        let (session_name, name_source) = {
            if let Some(n) = data.name.as_ref().filter(|n| !n.is_empty()) {
                (n.clone(), Some(SessionNameSource::User))
            } else if r#type == SessionType::Agent
                && prompt.as_deref().is_some_and(|p| !p.is_empty())
            {
                let slug = slugify_prompt(prompt.as_deref().unwrap_or(""));
                if !slug.is_empty() {
                    (slug, Some(SessionNameSource::Auto))
                } else {
                    let seq = worktree.agent_seq.unwrap_or(0) + 1;
                    next_agent_seq = Some(seq);
                    (format!("Agent {seq}"), None)
                }
            } else if r#type == SessionType::Terminal {
                let seq = worktree.terminal_seq.unwrap_or(0) + 1;
                next_terminal_seq = Some(seq);
                (format!("Terminal {seq}"), None)
            } else {
                let seq = worktree.agent_seq.unwrap_or(0) + 1;
                next_agent_seq = Some(seq);
                (format!("Agent {seq}"), None)
            }
        };
        if r#type == SessionType::Agent && next_agent_seq.is_none() {
            next_agent_seq = Some(worktree.agent_seq.unwrap_or(0) + 1);
        }

        let mut record = SessionRecord {
            id: session_id.clone(),
            worktree_id: Some(worktree_id.clone()),
            project_id: project.id.clone(),
            is_main: false,
            sort_order: ms_now() as f64,
            r#type,
            mode_id: if r#type == SessionType::Agent {
                mode_id.clone()
            } else {
                None
            },
            name: Some(session_name),
            name_source,
            tmux_name,
            use_tmux,
            channel: Some(channel),
            transcript_ref: transcript_ref_for_worktree(
                project.id.clone(),
                &worktree_id,
                &session_id,
                is_json,
            ),
            lifecycle: SessionLifecycle {
                state: LifecycleState::NotStarted,
                reason: None,
                last_transition_at: now_iso(),
            },
            draft_prompt: None,
            draft_config: None,
            initial_prompt: if r#type == SessionType::Agent {
                prompt.clone()
            } else {
                None
            },
            parent_session_id: data.source_agent_id.clone(),
            archived_at: None,
            handoff_summary: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            superseded_by: None,
            pr: None,
        };

        if r#type == SessionType::Terminal {
            let wt_path = Paths::default()
                .worktree_path(&project.id, &worktree.id)
                .display()
                .to_string();
            let res = self
                .spawn_terminal(&project, &record, Some(&wt_path), use_tmux)
                .await;
            match res {
                Ok(()) => {
                    record.lifecycle = SessionLifecycle {
                        state: LifecycleState::Working,
                        reason: None,
                        last_transition_at: now_iso(),
                    };
                }
                Err(e) => {
                    return Err(CreateError::Internal(format!(
                        "Failed to spawn terminal: {e}"
                    )));
                }
            }
        }

        let rec = record.clone();
        let wt_id = worktree_id.clone();
        let term_seq = next_terminal_seq;
        let agent_seq = next_agent_seq;
        self.store
            .mutate_project(&project.id, move |p| {
                for w in &mut p.worktrees {
                    if w.id == wt_id {
                        if let Some(t) = term_seq {
                            w.terminal_seq = Some(t);
                        }
                        if let Some(a) = agent_seq {
                            w.agent_seq = Some(a);
                        }
                        w.sessions.push(rec.clone());
                        return Ok(p.clone());
                    }
                }
                Err(vst_store::StoreError::Mutation(format!(
                    "worktree '{wt_id}' not found in project"
                )))
            })
            .await
            .map_err(create_err)?;

        // This is the "new agent tab inside an already-open worktree" path —
        // a live TabsStrip is almost certainly already mounted and listening
        // for this exact broadcast (bug #3: previously silently dropped
        // twice over, both by the subscriber-only routing this event never
        // qualified for, and by the missing `snapshot` every listener gates
        // on — see `spawn_event_fanout`'s and `SessionCreated`'s comments).
        let serialized = serialize_session(Some(&worktree_id), &project.id, &record);
        self.broadcaster.send(ServerEvent::SessionCreated {
            session_id: session_id.clone(),
            project_id: Some(project.id.clone()),
            worktree_id: Some(worktree_id.clone()),
            session_type: session_type_str(r#type).to_string(),
            mode: mode_id.clone(),
            snapshot: Some((&serialized).into()),
            parent_session_id: record.parent_session_id.clone(),
        });

        if r#type == SessionType::Agent && mode_id.is_some() {
            let opts = SpawnChannelOpts {
                project: project.clone(),
                worktree: Some(worktree.clone()),
                session: record.clone(),
                mode_id: mode_id.clone().unwrap(),
                prompt: prompt.clone(),
                daemon_port: self.daemon_port,
                skip_auto_turn: data.skip_auto_turn.unwrap_or(false),
            };
            let routes = self.clone();
            tokio::spawn(async move {
                routes.spawn_new_session_for_channel(opts).await;
            });
        }

        Ok(SessionOrDraft::Session(serialized))
    }

    /// Spawn a terminal session's TTY (tmux or direct pty). Mirrors the
    /// type=terminal branch of `POST /sessions`.
    async fn spawn_terminal(
        &self,
        project: &ProjectRecord,
        session: &SessionRecord,
        worktree_path: Option<&str>,
        use_tmux: bool,
    ) -> Result<(), String> {
        let cwd = worktree_path
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&project.absolute_path));
        if use_tmux {
            self.tmux
                .new_session(&NewSessionOptions {
                    name: session.tmux_name.clone(),
                    cwd: Some(cwd),
                    env: HashMap::new(),
                    command: None,
                })
                .map_err(|e| e.to_string())
        } else {
            let handle = spawn_child(SpawnChildOptions {
                command: std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
                args: vec![],
                cwd,
                env: HashMap::new(),
                cols: 80,
                rows: 24,
                session_id: session.id.clone(),
                project_id: project.id.clone(),
                worktree_id: None,
            })
            .map_err(|e| e.to_string())?;
            self.direct_ptys
                .write()
                .unwrap()
                .insert(session.id.clone(), handle.clone());
            // Without this, `session:open`'s direct-pty branch
            // (`vst-ws`'s `session_open.rs`) finds nothing in
            // `direct_streams` and rejects the attach with "Session '<id>'
            // not running" — the confirmed cause of a `useTmux: false`
            // plain terminal appearing to close/terminate as soon as it
            // (re-)attaches.
            self.direct_streams.lock().unwrap().insert(
                session.id.clone(),
                Arc::new(PtySessionStream::new(handle)) as Arc<dyn SessionStream>,
            );
            Ok(())
        }
    }

    /// `spawnNewSessionForChannel` — branch a freshly-created agent session's
    /// runtime on its channel: JSON never spawns a TTY at create; tmux/pty go
    /// through the guarded spawn jobs.
    pub async fn spawn_new_session_for_channel(&self, opts: SpawnChannelOpts) {
        let is_json = opts.session.channel == Some(Channel::Json);
        if is_json {
            if opts.skip_auto_turn {
                return;
            }
            let routes = self.clone();
            let registry = self.json_registry.clone();
            tokio::spawn(async move {
                start_json_create_turn(
                    StartJsonCreateTurnOpts {
                        session_id: opts.session.id.clone(),
                        prompt: opts.prompt.clone(),
                        daemon_port: opts.daemon_port,
                        store: routes.store.clone(),
                        broadcaster: routes.broadcaster.clone(),
                    },
                    &registry,
                )
                .await;
            });
            return;
        }
        if opts.worktree.is_some() {
            self.run_agent_spawn_job(opts).await;
        } else {
            self.run_direct_agent_spawn_job(opts).await;
        }
    }

    async fn run_agent_spawn_job(&self, opts: SpawnChannelOpts) {
        let session_id = opts.session.id.clone();
        let result = self.try_run_agent_spawn_job(opts).await;
        let (state, reason) = match result {
            Ok(()) => (LifecycleState::Working, None),
            Err(r) => (LifecycleState::Exited, Some(r)),
        };
        if self.release_if_retired_during_spawn(&session_id).await {
            return;
        }
        self.persist_spawn_state(&session_id, state, reason.as_deref())
            .await;
        self.broadcaster.send(ServerEvent::SessionState {
            session_id,
            state,
            reason,
        });
    }

    async fn run_direct_agent_spawn_job(&self, opts: SpawnChannelOpts) {
        let session_id = opts.session.id.clone();
        let result = self.try_run_direct_agent_spawn_job(opts).await;
        let (state, reason) = match result {
            Ok(()) => (LifecycleState::Working, None),
            Err(r) => (LifecycleState::Exited, Some(r)),
        };
        if self.release_if_retired_during_spawn(&session_id).await {
            return;
        }
        self.persist_spawn_state(&session_id, state, reason.as_deref())
            .await;
        self.broadcaster.send(ServerEvent::SessionState {
            session_id,
            state,
            reason,
        });
    }

    async fn try_run_agent_spawn_job(&self, opts: SpawnChannelOpts) -> Result<(), String> {
        let mode =
            find_mode(&opts.mode_id).ok_or_else(|| format!("Mode '{}' not found", opts.mode_id))?;
        let plugin = resolve_plugin(mode.cli);
        let worktree = opts
            .worktree
            .clone()
            .ok_or_else(|| "worktree context missing".to_string())?;
        let built = build_prompt(&BuildPromptInput {
            project: opts.project.clone(),
            worktree: worktree.clone(),
            mode_context: Some(mode.context.clone()),
            user_prompt: opts.prompt.clone(),
            rich_chat: false,
        });
        spawn_session(&SpawnSessionOpts {
            project: &opts.project,
            worktree: Some(&worktree),
            session: &opts.session,
            plugin: &*plugin,
            daemon_port: opts.daemon_port,
            system_prompt: built.system_prompt,
            task_prompt: built.task_prompt,
            model: mode.model,
            tmux: &self.tmux,
            direct_ptys: &self.direct_ptys,
        })
        .await
    }

    async fn try_run_direct_agent_spawn_job(&self, opts: SpawnChannelOpts) -> Result<(), String> {
        let mode =
            find_mode(&opts.mode_id).ok_or_else(|| format!("Mode '{}' not found", opts.mode_id))?;
        let plugin = resolve_plugin(mode.cli);
        let built = build_direct_prompt(&BuildDirectPromptInput {
            project: opts.project.clone(),
            mode_context: Some(mode.context.clone()),
            user_prompt: opts.prompt.clone(),
            rich_chat: false,
        });
        spawn_session(&SpawnSessionOpts {
            project: &opts.project,
            worktree: None,
            session: &opts.session,
            plugin: &*plugin,
            daemon_port: opts.daemon_port,
            system_prompt: built.system_prompt,
            task_prompt: built.task_prompt,
            model: mode.model,
            tmux: &self.tmux,
            direct_ptys: &self.direct_ptys,
        })
        .await
    }

    /// `releaseIfRetiredDuringSpawn` — if the session is gone or done by the
    /// time a spawn lands, release its runtime and return true (skip write).
    async fn release_if_retired_during_spawn(&self, session_id: &str) -> bool {
        let Some(ctx) = find_session_context(&self.store, session_id).await else {
            return true;
        };
        let session = match &ctx {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                session
            }
            SessionContext::Global { .. } => return false,
        };
        if session.lifecycle.state != LifecycleState::Done {
            return false;
        }
        let session_id = session.id.clone();
        let use_tmux = session.use_tmux;
        let tmux_name = session.tmux_name.clone();
        let tmux = self.tmux.clone();
        let direct_ptys = self.direct_ptys.read().unwrap().get(&session_id).cloned();
        tokio::spawn(async move {
            let _ = tmux_name;
            let _ = tmux;
            if !use_tmux {
                if let Some(pty) = direct_ptys {
                    pty.kill();
                }
            }
        });
        true
    }

    async fn persist_spawn_state(
        &self,
        session_id: &str,
        state: LifecycleState,
        reason: Option<&str>,
    ) {
        let Some(ctx) = find_session_context(&self.store, session_id).await else {
            return;
        };
        let project_id = match &ctx {
            SessionContext::Worktree { project, .. } | SessionContext::Direct { project, .. } => {
                project.id.clone()
            }
            SessionContext::Global { .. } => return,
        };
        let lifecycle = SessionLifecycle {
            state,
            reason: reason.map(str::to_string),
            last_transition_at: now_iso(),
        };
        let _ = self
            .store
            .update_session_lifecycle(&project_id, session_id, lifecycle)
            .await;
    }

    // ---------------------------------------------------------------------
    // Group B1: DELETE /sessions/:id, PATCH .../draft, POST .../start,
    // PATCH .../pin|rename|reorder|delink
    // ---------------------------------------------------------------------

    /// `DELETE /sessions/:id`. Global drafts are removed directly; direct
    /// sessions are plain-deleted; worktree sessions re-derive the
    /// main/promotion decision INSIDE the locked `mutate_project` callback
    /// (never off pre-lock state) — this closes the promotion race.
    pub async fn delete_session(&self, id: &str) -> Result<DeleteResult, DeleteError> {
        if self.store.get_global_draft(id).await.is_some() {
            let removed = self
                .store
                .remove_global_draft(id)
                .await
                .map_err(|e| DeleteError::Internal(e.to_string()))?;
            if !removed {
                return Err(DeleteError::NotFound(format!("Session '{id}' not found")));
            }
            self.broadcaster.send(ServerEvent::SessionDeleted {
                session_id: id.to_string(),
            });
            return Ok(DeleteResult {
                promoted_session_id: None,
            });
        }

        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| DeleteError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(DeleteError::NotFound(format!("Session '{id}' not found")));
        }

        match &ctx {
            SessionContext::Direct { project, session } => {
                let session = session.clone();
                let project_id = project.id.clone();
                self.release_session_runtime(&session, true).await;
                cleanup_direct_session_data_dir(&project_id, id);
                let sid = id.to_string();
                let pid = project_id.clone();
                self.store
                    .mutate_project(&pid, move |p| {
                        p.direct_sessions.retain(|s| s.id != sid);
                        Ok(p.clone())
                    })
                    .await
                    .map_err(delete_err)?;
                self.prune_notice_and_forget(id, session.parent_session_id.as_deref());
                self.broadcaster.send(ServerEvent::SessionDeleted {
                    session_id: id.to_string(),
                });
                Ok(DeleteResult {
                    promoted_session_id: None,
                })
            }
            SessionContext::Worktree {
                project,
                worktree,
                session,
            } => {
                self.delete_worktree_session(project, worktree, session)
                    .await
            }
            SessionContext::Global { .. } => unreachable!(),
        }
    }

    /// `DELETE /sessions/:id` for a worktree session — the promotion-critical
    /// path. See [`SessionRoutes::delete_session`].
    async fn delete_worktree_session(
        &self,
        project: &ProjectRecord,
        worktree: &WorktreeRecord,
        session: &SessionRecord,
    ) -> Result<DeleteResult, DeleteError> {
        const NO_SIBLING_ERROR: &str =
            "Cannot delete the main session: no other agent session exists in this worktree \
             to promote to main. Use DELETE /worktrees/:id to remove the whole worktree.";

        let id = session.id.clone();
        let wt_id = worktree.id.clone();
        let project_id = project.id.clone();

        // Fast-path pre-check OUTSIDE the lock — a pure optimization so the
        // common "main, sole session" case 400s without a DB round trip. It is
        // NOT authoritative; the real check happens inside the locked callback
        // (a false negative here only skips the optimization).
        if session.is_main {
            let has_any = worktree.sessions.iter().any(|s| {
                s.id != id
                    && s.r#type == SessionType::Agent
                    && s.archived_at.is_none()
                    && s.lifecycle.state != LifecycleState::Drafting
            });
            if !has_any {
                return Err(DeleteError::NoEligibleSibling(NO_SIBLING_ERROR.to_string()));
            }
        }

        let decision = Arc::new(Mutex::new(DeleteDecision::GenuineError));
        let decision_c = decision.clone();
        let session_id = id.clone();
        let wt_id_c = wt_id.clone();
        let res = self
            .store
            .mutate_project(&project_id, move |p| {
                let Some(w) = p.worktrees.iter_mut().find(|x| x.id == wt_id_c) else {
                    return Err(StoreError::Mutation(format!(
                        "Worktree '{}' not found",
                        wt_id_c
                    )));
                };
                let Some(fresh) = w.sessions.iter().find(|s| s.id == session_id).cloned() else {
                    *decision_c.lock().unwrap() = DeleteDecision::SessionGone;
                    return Err(StoreError::Mutation("session gone at commit".into()));
                };
                if !fresh.is_main {
                    w.sessions.retain(|s| s.id != session_id);
                    return Ok(p.clone());
                }
                let mut siblings: Vec<SessionRecord> = w
                    .sessions
                    .iter()
                    .filter(|s| {
                        s.id != session_id
                            && s.r#type == SessionType::Agent
                            && s.archived_at.is_none()
                            && s.lifecycle.state != LifecycleState::Drafting
                    })
                    .cloned()
                    .collect();
                siblings.sort_by(|a, b| {
                    a.sort_order
                        .partial_cmp(&b.sort_order)
                        .unwrap_or(Ordering::Equal)
                });
                let Some(promoted) = siblings.into_iter().next() else {
                    *decision_c.lock().unwrap() = DeleteDecision::NoSibling;
                    return Err(StoreError::Mutation("no eligible sibling at commit".into()));
                };
                let promoted_id = promoted.id.clone();
                let promoted_pr = fresh.pr.clone();
                *decision_c.lock().unwrap() = DeleteDecision::Promoted {
                    promoted_id: promoted_id.clone(),
                    promoted_pr: promoted_pr.clone(),
                };
                for s in &mut w.sessions {
                    if s.id == promoted_id {
                        s.is_main = true;
                        s.pr = promoted_pr.clone();
                    }
                }
                w.sessions.retain(|s| s.id != session_id);
                Ok(p.clone())
            })
            .await;

        match res {
            Ok(_) => {
                let promoted = match &*decision.lock().unwrap() {
                    DeleteDecision::Promoted {
                        promoted_id,
                        promoted_pr,
                    } => Some((promoted_id.clone(), promoted_pr.clone())),
                    _ => None,
                };
                self.release_session_runtime(session, true).await;
                cleanup_session_data_dir(&project_id, &wt_id, &id);
                if let Some((promoted_id, promoted_pr)) = &promoted {
                    self.broadcaster.send(ServerEvent::SessionUpdated {
                        session_id: promoted_id.clone(),
                        pinned_at: None,
                        channel: None,
                        name: None,
                        archived_at: None,
                        sort_order: None,
                        pr: promoted_pr.clone().map(Box::new),
                        superseded_by: None,
                        is_main: Some(true),
                        parent_session_id: None,
                        worktree_id: None,
                        draft_prompt: None,
                        draft_config: None,
                    });
                }
                self.prune_notice_and_forget(&id, session.parent_session_id.as_deref());
                self.broadcaster.send(ServerEvent::SessionDeleted {
                    session_id: id.clone(),
                });
                Ok(DeleteResult {
                    promoted_session_id: promoted.map(|(pid, _)| pid),
                })
            }
            Err(_) => match *decision.lock().unwrap() {
                DeleteDecision::SessionGone => {
                    Err(DeleteError::NotFound(format!("Session '{id}' not found")))
                }
                DeleteDecision::NoSibling => {
                    Err(DeleteError::NoEligibleSibling(NO_SIBLING_ERROR.to_string()))
                }
                DeleteDecision::GenuineError => Err(DeleteError::Internal(format!(
                    "Failed to delete session '{id}'"
                ))),
                DeleteDecision::Promoted { .. } => Err(DeleteError::Internal(format!(
                    "Unexpected error deleting session '{id}'"
                ))),
            },
        }
    }

    /// `PATCH /sessions/:id/draft` — update `draftPrompt`/`draftConfig` on a
    /// drafting session, deriving a slug name when `nameSource != "user"`.
    pub async fn patch_session_draft(
        &self,
        id: &str,
        body: &PatchDraftBody,
    ) -> Result<DraftPatchResult, DraftError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| DraftError::NotFound(format!("Session '{id}' not found")))?;

        if let SessionContext::Global { row } = &ctx {
            let mut patch = GlobalDraftPatch::default();
            let mut derived_name: Option<String> = None;
            if let Some(p) = body
                .draft_prompt
                .as_deref()
                .filter(|p| !p.trim().is_empty())
            {
                let slug = slugify_prompt_with(p, 5, 60);
                derived_name = if slug.is_empty() { None } else { Some(slug) };
            }
            let should_rename =
                derived_name.is_some() && row.name_source.as_deref() != Some("user");
            if let Some(p) = &body.draft_prompt {
                patch.draft_prompt = Some(p.clone());
            }
            if let Some(c) = &body.draft_config {
                patch.draft_config = Some(serde_json::to_string(c).unwrap_or_default());
            }
            if should_rename {
                patch.name = derived_name.clone();
                patch.name_source = Some("auto".into());
            }
            self.store
                .update_global_draft(id, patch)
                .await
                .map_err(|e| DraftError::Internal(e.to_string()))?;
            self.broadcaster.send(ServerEvent::SessionUpdated {
                session_id: id.to_string(),
                pinned_at: None,
                channel: None,
                name: if should_rename {
                    derived_name.clone()
                } else {
                    None
                },
                archived_at: None,
                sort_order: None,
                pr: None,
                superseded_by: None,
                is_main: None,
                parent_session_id: None,
                worktree_id: None,
                draft_prompt: body.draft_prompt.clone(),
                draft_config: body.draft_config.clone().map(Box::new),
            });
            return Ok(DraftPatchResult {
                ok: true,
                name: if should_rename { derived_name } else { None },
            });
        }

        let session = match &ctx {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                session
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        if session.lifecycle.state != LifecycleState::Drafting {
            return Err(DraftError::NotDrafting(
                "Session is not in drafting state".to_string(),
            ));
        }

        let mut derived_name: Option<String> = None;
        if let Some(p) = body
            .draft_prompt
            .as_deref()
            .filter(|p| !p.trim().is_empty())
        {
            let slug = slugify_prompt_with(p, 5, 60);
            derived_name = if slug.is_empty() { None } else { Some(slug) };
        }
        let should_rename =
            derived_name.is_some() && session.name_source != Some(SessionNameSource::User);

        let worktree_id = match &ctx {
            SessionContext::Worktree { worktree, .. } => Some(worktree.id.clone()),
            _ => None,
        };
        let sid = id.to_string();
        let project_id = match &ctx {
            SessionContext::Worktree { project, .. } | SessionContext::Direct { project, .. } => {
                project.id.clone()
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        let draft_prompt = body.draft_prompt.clone();
        let draft_config = body.draft_config.clone();
        let rename = if should_rename {
            derived_name.clone()
        } else {
            None
        };
        self.store
            .mutate_project(&project_id, move |p| match &worktree_id {
                Some(wt_id) => {
                    for w in &mut p.worktrees {
                        if w.id == *wt_id {
                            for s in &mut w.sessions {
                                if s.id == sid {
                                    if let Some(dp) = &draft_prompt {
                                        s.draft_prompt = Some(dp.clone());
                                    }
                                    if let Some(dc) = &draft_config {
                                        s.draft_config = serde_json::from_value(dc.clone()).ok();
                                    }
                                    if let Some(n) = &rename {
                                        s.name = Some(n.clone());
                                        s.name_source = Some(SessionNameSource::Auto);
                                    }
                                }
                            }
                            return Ok(p.clone());
                        }
                    }
                    Err(StoreError::Mutation(format!(
                        "worktree '{wt_id}' not found"
                    )))
                }
                None => {
                    for s in &mut p.direct_sessions {
                        if s.id == sid {
                            if let Some(dp) = &draft_prompt {
                                s.draft_prompt = Some(dp.clone());
                            }
                            if let Some(dc) = &draft_config {
                                s.draft_config = serde_json::from_value(dc.clone()).ok();
                            }
                            if let Some(n) = &rename {
                                s.name = Some(n.clone());
                                s.name_source = Some(SessionNameSource::Auto);
                            }
                        }
                    }
                    Ok(p.clone())
                }
            })
            .await
            .map_err(|e| DraftError::Internal(e.to_string()))?;

        self.broadcaster.send(ServerEvent::SessionUpdated {
            session_id: id.to_string(),
            pinned_at: None,
            channel: None,
            name: if should_rename {
                derived_name.clone()
            } else {
                None
            },
            archived_at: None,
            sort_order: None,
            pr: None,
            superseded_by: None,
            is_main: None,
            parent_session_id: None,
            worktree_id: None,
            draft_prompt: body.draft_prompt.clone(),
            draft_config: body.draft_config.clone().map(Box::new),
        });
        Ok(DraftPatchResult {
            ok: true,
            name: if should_rename { derived_name } else { None },
        })
    }

    /// `POST /sessions/:id/start` — promote a drafting session to not_started
    /// and spawn. Builds its response from fully-persisted state BEFORE the
    /// fire-and-forget spawn (invariant #2).
    pub async fn start_session(
        &self,
        id: &str,
        body: &StartDraftBody,
    ) -> Result<StartDraftResult, StartError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| StartError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(StartError::Validation(
                "A global draft must have a project selected before it can be started".to_string(),
            ));
        }
        let session = match &ctx {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                session.clone()
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        if session.lifecycle.state != LifecycleState::Drafting {
            return Err(StartError::NotDrafting(
                "Session is not in drafting state".to_string(),
            ));
        }

        let trimmed_prompt = body.draft_prompt.trim().to_string();
        if trimmed_prompt.is_empty() {
            return Err(StartError::Validation(
                "draftPrompt cannot be empty".to_string(),
            ));
        }

        let draft_config = &body.draft_config;
        let skip_auto_turn = body.skip_auto_turn.unwrap_or(false);
        let project = match &ctx {
            SessionContext::Worktree { project, .. } | SessionContext::Direct { project, .. } => {
                project.clone()
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        let daemon_port = self.daemon_port;

        let mode_id = draft_config.mode_id.clone().ok_or_else(|| {
            StartError::Validation("draftConfig.modeId is required to start a session".to_string())
        })?;

        let entry_point = draft_config.entry_point;
        // "global" and "direct" both render the New/Existing worktree radios
        // + worktree select whenever `useWorktree` is checked
        // (DraftComposer.tsx's `entryPoint !== "tab" && useWorktree` guard),
        // so both must honor `worktreeChoice`/`existingWorktreeId` here — not
        // just entryPoint "worktree". Mirrors the identical fix in
        // `daemon/src/routes/sessions.ts` (TS had the exact same bug: (a)
        // "global" + useWorktree unconditionally minted a NEW worktree
        // regardless of an "existing worktree" selection, live-reproduced
        // against :7141; (b) "direct" ignored `useWorktree` entirely).
        let wants_new_worktree = (entry_point == DraftEntryPoint::Worktree
            && draft_config.worktree_choice == Some(WorktreeChoice::New))
            || ((entry_point == DraftEntryPoint::Global || entry_point == DraftEntryPoint::Direct)
                && draft_config.use_worktree == Some(true)
                && draft_config.worktree_choice != Some(WorktreeChoice::Existing));
        let is_worktree_new = wants_new_worktree;
        let is_direct = entry_point == DraftEntryPoint::Tab
            || (entry_point == DraftEntryPoint::Worktree
                && draft_config.worktree_choice == Some(WorktreeChoice::Existing))
            || (entry_point == DraftEntryPoint::Global && draft_config.use_worktree == Some(false))
            || ((entry_point == DraftEntryPoint::Global || entry_point == DraftEntryPoint::Direct)
                && draft_config.use_worktree == Some(true)
                && draft_config.worktree_choice == Some(WorktreeChoice::Existing))
            // entryPoint "direct" with no worktree opinion at all
            // (`use_worktree` unset) keeps its original meaning: stay
            // direct/in-place. This must NOT be widened to also swallow
            // entryPoint "global" with no `use_worktree` opinion, which
            // must fall through to the "Unknown entryPoint" validation
            // error below — see `start_unknown_entry_point_400`, which
            // constructs exactly that case (`DraftEntryPoint::Global` with
            // `use_worktree: None`) and expects it to be neither direct
            // nor worktree-new.
            || (entry_point == DraftEntryPoint::Direct && draft_config.use_worktree != Some(true));

        if is_worktree_new {
            return self
                .start_new_worktree(
                    &project,
                    &session,
                    draft_config,
                    &trimmed_prompt,
                    &mode_id,
                    skip_auto_turn,
                    daemon_port,
                )
                .await;
        }

        if is_direct {
            return self
                .start_direct(
                    &project,
                    &session,
                    draft_config,
                    &trimmed_prompt,
                    &mode_id,
                    skip_auto_turn,
                    daemon_port,
                )
                .await;
        }

        Err(StartError::Validation(format!(
            "Unknown entryPoint: {}",
            entry_point_str(entry_point)
        )))
    }

    /// `POST /start` — the isWorktreeNew arm: create a new git worktree and
    /// promote the drafting session into it as its main session.
    #[allow(clippy::too_many_arguments)]
    async fn start_new_worktree(
        &self,
        project: &ProjectRecord,
        session: &SessionRecord,
        draft_config: &DraftConfig,
        trimmed_prompt: &str,
        mode_id: &str,
        skip_auto_turn: bool,
        daemon_port: u16,
    ) -> Result<StartDraftResult, StartError> {
        let base_branch = draft_config
            .base_branch
            .clone()
            .unwrap_or_else(|| "main".to_string());
        let new_worktree = create_worktree_record(
            &self.store,
            &Paths::default(),
            CreateWorktreeOpts {
                project: project.clone(),
                branch: draft_config.branch.clone(),
                base_branch,
                prompt: Some(trimmed_prompt.to_string()),
                name: None,
                build_sessions: Box::new(|_| vec![]),
            },
        )
        .await
        .map_err(|e| StartError::Internal(format!("Failed to create worktree: {e}")))?;

        let wt_id = new_worktree.id.clone();
        let channel = draft_config.channel.unwrap_or(Channel::Json);
        let use_tmux = channel == Channel::Tmux;
        let is_json = channel == Channel::Json;
        let new_tmux_name = if use_tmux {
            tmux_name_for_session(&session.id)
        } else {
            format!("__direct__-{}", session.id)
        };

        let updated_session = self.build_promoted_session(
            session,
            Some(&wt_id),
            true,
            use_tmux,
            channel,
            &new_tmux_name,
            trimmed_prompt,
            mode_id,
            is_json,
            &project.id,
        );

        let sid = session.id.clone();
        let wt_id_c = wt_id.clone();
        let project_id = project.id.clone();
        let us = updated_session.clone();
        self.store
            .mutate_project(&project_id, move |p| {
                p.direct_sessions.retain(|s| s.id != sid);
                for w in &mut p.worktrees {
                    if w.id == wt_id_c {
                        w.sessions = vec![us.clone()];
                        return Ok(p.clone());
                    }
                }
                Err(StoreError::Mutation(format!(
                    "worktree '{wt_id_c}' not found"
                )))
            })
            .await
            .map_err(|e| StartError::Internal(e.to_string()))?;

        // Serialize the FULLY-PERSISTED worktree (with the real promoted
        // session attached) so `mainSessionId` resolves correctly — never the
        // pre-mutation `sessions: []` object.
        let mut wt_with_session = new_worktree.clone();
        wt_with_session.sessions = vec![updated_session.clone()];
        let serialized_wt = serialize_worktree_json(&project.id, &wt_with_session);

        self.broadcaster.send(ServerEvent::WorktreeCreated {
            worktree: serialized_wt.clone(),
        });
        self.broadcaster.send(ServerEvent::SessionUpdated {
            session_id: session.id.clone(),
            pinned_at: None,
            channel: updated_session.channel,
            name: None,
            archived_at: None,
            sort_order: None,
            pr: None,
            superseded_by: None,
            is_main: Some(true),
            parent_session_id: None,
            worktree_id: Some(wt_id.clone()),
            draft_prompt: None,
            draft_config: None,
        });
        self.broadcaster.send(ServerEvent::SessionState {
            session_id: session.id.clone(),
            state: LifecycleState::NotStarted,
            reason: None,
        });

        let opts = SpawnChannelOpts {
            project: project.clone(),
            worktree: Some(new_worktree),
            session: updated_session,
            mode_id: mode_id.to_string(),
            prompt: Some(trimmed_prompt.to_string()),
            daemon_port,
            skip_auto_turn,
        };
        let routes = self.clone();
        tokio::spawn(async move {
            routes.spawn_new_session_for_channel(opts).await;
        });

        // Report the full worktree record too, not just its id — the web-ui
        // navigates off this HTTP response synchronously, before the
        // `worktree:created` broadcast above is guaranteed to have been
        // processed by this same client. Without it the caller has no way to
        // register the worktree in its store immediately and has to wait on
        // that broadcast to land; if it's ever delayed (reconnect, event
        // ordering), the pane stays blank until a manual refresh re-fetches
        // everything over REST.
        Ok(StartDraftResult {
            ok: true,
            worktree_id: Some(wt_id),
            worktree: Some(serialized_wt),
        })
    }

    /// `POST /start` — the isDirect arm: promote the draft into a direct
    /// session or an existing worktree.
    #[allow(clippy::too_many_arguments)]
    async fn start_direct(
        &self,
        project: &ProjectRecord,
        session: &SessionRecord,
        draft_config: &DraftConfig,
        trimmed_prompt: &str,
        mode_id: &str,
        skip_auto_turn: bool,
        daemon_port: u16,
    ) -> Result<StartDraftResult, StartError> {
        let mut existing_worktree: Option<WorktreeRecord> = None;
        // Determine worktree if the user picked "Existing worktree" — for
        // entryPoint "worktree" directly, or for "global"/"direct" when
        // `useWorktree` is checked (see `is_direct`'s comment in the
        // caller for why all three need this; mirrors
        // `daemon/src/routes/sessions.ts`'s identical fix).
        let wants_existing_worktree = matches!(
            draft_config.entry_point,
            DraftEntryPoint::Worktree | DraftEntryPoint::Global | DraftEntryPoint::Direct
        ) && draft_config.worktree_choice
            == Some(WorktreeChoice::Existing);
        if wants_existing_worktree {
            if let Some(wt_id) = &draft_config.existing_worktree_id {
                let (_, wt) = find_worktree_context(&self.store, wt_id)
                    .await
                    .ok_or_else(|| {
                        StartError::NotFound("Existing worktree not found".to_string())
                    })?;
                existing_worktree = Some(wt);
            }
        }
        if draft_config.entry_point == DraftEntryPoint::Tab {
            if let Some(wt_id) = &session.worktree_id {
                if let Some((_, wt)) = find_worktree_context(&self.store, wt_id).await {
                    existing_worktree = Some(wt);
                }
            }
        }

        let channel = draft_config.channel.unwrap_or(Channel::Json);
        let use_tmux = channel == Channel::Tmux;
        let is_json = channel == Channel::Json;
        let new_tmux_name = if use_tmux {
            tmux_name_for_session(&session.id)
        } else {
            format!("__direct__-{}", session.id)
        };

        let target_wt_id = existing_worktree.as_ref().map(|w| w.id.clone());
        let worktree_id = target_wt_id.clone().or_else(|| session.worktree_id.clone());
        let updated_session = self.build_promoted_session(
            session,
            worktree_id.as_deref(),
            session.is_main,
            use_tmux,
            channel,
            &new_tmux_name,
            trimmed_prompt,
            mode_id,
            is_json,
            &project.id,
        );

        let sid = session.id.clone();
        let project_id = project.id.clone();
        let us = updated_session.clone();
        if let Some(wt) = &existing_worktree {
            let wt_id = wt.id.clone();
            self.store
                .mutate_project(&project_id, move |p| {
                    p.direct_sessions.retain(|s| s.id != sid);
                    for w in &mut p.worktrees {
                        if w.id == wt_id {
                            w.sessions.retain(|s| s.id != sid);
                            w.sessions.push(us.clone());
                            return Ok(p.clone());
                        }
                    }
                    Err(StoreError::Mutation(format!(
                        "worktree '{wt_id}' not found"
                    )))
                })
                .await
                .map_err(|e| StartError::Internal(e.to_string()))?;
        } else {
            self.store
                .mutate_project(&project_id, move |p| {
                    for s in &mut p.direct_sessions {
                        if s.id == sid {
                            *s = us.clone();
                        }
                    }
                    Ok(p.clone())
                })
                .await
                .map_err(|e| StartError::Internal(e.to_string()))?;
        }

        if let Some(wt) = &existing_worktree {
            self.broadcaster.send(ServerEvent::SessionUpdated {
                session_id: session.id.clone(),
                pinned_at: None,
                channel: updated_session.channel,
                name: None,
                archived_at: None,
                sort_order: None,
                pr: None,
                superseded_by: None,
                is_main: None,
                parent_session_id: None,
                worktree_id: Some(wt.id.clone()),
                draft_prompt: None,
                draft_config: None,
            });
        } else {
            self.broadcaster.send(ServerEvent::SessionUpdated {
                session_id: session.id.clone(),
                pinned_at: None,
                channel: updated_session.channel,
                name: None,
                archived_at: None,
                sort_order: None,
                pr: None,
                superseded_by: None,
                is_main: None,
                parent_session_id: None,
                worktree_id: None,
                draft_prompt: None,
                draft_config: None,
            });
        }
        self.broadcaster.send(ServerEvent::SessionState {
            session_id: session.id.clone(),
            state: LifecycleState::NotStarted,
            reason: None,
        });

        let opts = SpawnChannelOpts {
            project: project.clone(),
            worktree: existing_worktree,
            session: updated_session,
            mode_id: mode_id.to_string(),
            prompt: Some(trimmed_prompt.to_string()),
            daemon_port,
            skip_auto_turn,
        };
        let routes = self.clone();
        tokio::spawn(async move {
            routes.spawn_new_session_for_channel(opts).await;
        });

        // Report the worktree even though it already existed (entryPoint
        // "tab", or "worktree" with an existing choice) — without this the
        // caller sees `worktreeId: undefined`/`None` and falls back to the
        // direct-session `/session/:id` route, even though this session now
        // lives inside a worktree.
        Ok(StartDraftResult {
            ok: true,
            worktree_id: target_wt_id,
            worktree: None,
        })
    }

    /// Build the promoted `SessionRecord` shared by the `start` arms.
    #[allow(clippy::too_many_arguments)]
    fn build_promoted_session(
        &self,
        session: &SessionRecord,
        worktree_id: Option<&str>,
        is_main: bool,
        use_tmux: bool,
        channel: Channel,
        new_tmux_name: &str,
        trimmed_prompt: &str,
        mode_id: &str,
        is_json: bool,
        project_id: &str,
    ) -> SessionRecord {
        let transcript_ref = if is_json {
            let path = match worktree_id {
                Some(wt_id) => format!(
                    "{}/messages.jsonl",
                    Paths::default()
                        .session_data_dir(project_id, wt_id, &session.id)
                        .display()
                ),
                None => format!(
                    "{}/messages.jsonl",
                    Paths::default()
                        .direct_session_data_dir(project_id, &session.id)
                        .display()
                ),
            };
            Some(TranscriptRef {
                kind: TranscriptKind::VstJson,
                path: Some(path),
            })
        } else {
            None
        };
        SessionRecord {
            id: session.id.clone(),
            worktree_id: worktree_id.map(str::to_string),
            project_id: project_id.to_string(),
            is_main,
            sort_order: session.sort_order,
            r#type: session.r#type,
            mode_id: Some(mode_id.to_string()),
            name: session.name.clone(),
            name_source: session.name_source,
            tmux_name: new_tmux_name.to_string(),
            use_tmux,
            channel: Some(channel),
            lifecycle: SessionLifecycle {
                state: LifecycleState::NotStarted,
                reason: None,
                last_transition_at: now_iso(),
            },
            transcript_ref,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: session.model_override.clone(),
            pinned_at: session.pinned_at.clone(),
            initial_prompt: Some(trimmed_prompt.to_string()),
            draft_prompt: None,
            draft_config: None,
            archived_at: session.archived_at.clone(),
            handoff_summary: session.handoff_summary.clone(),
            parent_session_id: session.parent_session_id.clone(),
            superseded_by: session.superseded_by.clone(),
            pr: session.pr.clone(),
        }
    }

    /// `PATCH /sessions/:id/pin` — idempotent toggle of `pinnedAt`.
    pub async fn pin_session(&self, id: &str, pinned: bool) -> Result<PinResult, MutateError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| MutateError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(MutateError::NotFound(format!("Session '{id}' not found")));
        }
        let session = match &ctx {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                session
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        let already = session.pinned_at.is_some();
        if already == pinned {
            return Ok(PinResult {
                ok: true,
                pinned_at: session.pinned_at.clone(),
            });
        }
        let next_pinned_at = if pinned { Some(now_iso()) } else { None };
        let pin_value = next_pinned_at.clone();
        let f: Arc<dyn Fn(&mut SessionRecord) + Send + Sync> = Arc::new(move |s| {
            s.pinned_at = pin_value.clone();
        });
        self.apply_session_mutation(&ctx, id, f).await?;
        self.broadcaster.send(ServerEvent::SessionUpdated {
            session_id: id.to_string(),
            pinned_at: next_pinned_at.clone(),
            channel: None,
            name: None,
            archived_at: None,
            sort_order: None,
            pr: None,
            superseded_by: None,
            is_main: None,
            parent_session_id: None,
            worktree_id: None,
            draft_prompt: None,
            draft_config: None,
        });
        Ok(PinResult {
            ok: true,
            pinned_at: next_pinned_at,
        })
    }

    /// `PATCH /sessions/:id/rename` — set a user override name; empty clears it.
    pub async fn rename_session(
        &self,
        id: &str,
        name: &str,
    ) -> Result<RenameSessionResult, MutateError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| MutateError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(MutateError::NotFound(format!("Session '{id}' not found")));
        }
        let trimmed = name.trim();
        let value = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(60).collect::<String>())
        };
        let value_for_broadcast = value.clone();
        let f: Arc<dyn Fn(&mut SessionRecord) + Send + Sync> = Arc::new(move |s| {
            s.name_source = Some(SessionNameSource::User);
            s.name = value.clone();
        });
        self.apply_session_mutation(&ctx, id, f).await?;
        self.broadcaster.send(ServerEvent::SessionUpdated {
            session_id: id.to_string(),
            pinned_at: None,
            channel: None,
            name: value_for_broadcast.clone(),
            archived_at: None,
            sort_order: None,
            pr: None,
            superseded_by: None,
            is_main: None,
            parent_session_id: None,
            worktree_id: None,
            draft_prompt: None,
            draft_config: None,
        });
        Ok(RenameSessionResult {
            ok: true,
            name: value_for_broadcast,
        })
    }

    /// `PATCH /sessions/:id/reorder` — persist a display-order rank.
    pub async fn reorder_session(
        &self,
        id: &str,
        sort_order: f64,
    ) -> Result<ReorderSessionResult, MutateError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| MutateError::NotFound(format!("Session '{id}' not found")))?;
        if let SessionContext::Global { .. } = &ctx {
            let patch = GlobalDraftPatch {
                sort_order: Some(sort_order),
                ..Default::default()
            };
            self.store
                .update_global_draft(id, patch)
                .await
                .map_err(|e| MutateError::Internal(e.to_string()))?;
            self.broadcaster.send(ServerEvent::SessionUpdated {
                session_id: id.to_string(),
                pinned_at: None,
                channel: None,
                name: None,
                archived_at: None,
                sort_order: Some(sort_order),
                pr: None,
                superseded_by: None,
                is_main: None,
                parent_session_id: None,
                worktree_id: None,
                draft_prompt: None,
                draft_config: None,
            });
            return Ok(ReorderSessionResult {
                ok: true,
                sort_order,
            });
        }
        let f: Arc<dyn Fn(&mut SessionRecord) + Send + Sync> =
            Arc::new(move |s| s.sort_order = sort_order);
        self.apply_session_mutation(&ctx, id, f).await?;
        self.broadcaster.send(ServerEvent::SessionUpdated {
            session_id: id.to_string(),
            pinned_at: None,
            channel: None,
            name: None,
            archived_at: None,
            sort_order: Some(sort_order),
            pr: None,
            superseded_by: None,
            is_main: None,
            parent_session_id: None,
            worktree_id: None,
            draft_prompt: None,
            draft_config: None,
        });
        Ok(ReorderSessionResult {
            ok: true,
            sort_order,
        })
    }

    /// `PATCH /sessions/:id/delink` — clear `parentSessionId`.
    pub async fn delink_session(&self, id: &str) -> Result<DelinkResult, MutateError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| MutateError::NotFound("session_not_found".to_string()))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(MutateError::NotFound("session_not_found".to_string()));
        }
        let session = match &ctx {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                session
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        if session.archived_at.is_some() {
            return Err(MutateError::Archived("session_archived".to_string()));
        }
        let parent_id = session.parent_session_id.clone();
        let f: Arc<dyn Fn(&mut SessionRecord) + Send + Sync> =
            Arc::new(|s| s.parent_session_id = None);
        self.apply_session_mutation(&ctx, id, f).await?;
        self.prune_notice_and_forget(id, parent_id.as_deref());
        self.broadcaster.send(ServerEvent::SessionUpdated {
            session_id: id.to_string(),
            pinned_at: None,
            channel: None,
            name: None,
            archived_at: None,
            sort_order: None,
            pr: None,
            superseded_by: None,
            is_main: None,
            parent_session_id: Some(None),
            worktree_id: None,
            draft_prompt: None,
            draft_config: None,
        });
        Ok(DelinkResult {})
    }

    // ---------------------------------------------------------------------
    // Group B2: POST /sessions/:id/done, /resume, /reset, /handoff
    // ---------------------------------------------------------------------

    /// `POST /sessions/:id/done` — retire an agent session: release its runtime
    /// resources and mark it `done`. Everything a later `POST /:id/resume`
    /// needs survives (the manifest record with its `agentChatId`, data dir,
    /// attachments, CLI history) — "done" is a pause, not a delete. Terminals
    /// have no "done" concept, so reject them.
    pub async fn done_session(&self, id: &str) -> Result<DoneResult, DoneError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| DoneError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(DoneError::NotFound(format!("Session '{id}' not found")));
        }
        let session = match &ctx {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                session
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        if session.r#type != SessionType::Agent {
            return Err(DoneError::NotAgent(
                "Only agent sessions can be marked done.".to_string(),
            ));
        }
        // Idempotent: a repeat call has nothing left to release.
        if session.lifecycle.state == LifecycleState::Done {
            return Ok(DoneResult { ok: true });
        }

        // Release BEFORE persisting so the `done` broadcast is the last word
        // the clients hear (mirrors the TS ordering).
        self.release_session_runtime(session, false).await;

        let project_id = match &ctx {
            SessionContext::Worktree { project, .. } | SessionContext::Direct { project, .. } => {
                project.id.clone()
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        let lifecycle = SessionLifecycle {
            state: LifecycleState::Done,
            reason: None,
            last_transition_at: now_iso(),
        };
        self.store
            .update_session_lifecycle(&project_id, id, lifecycle)
            .await
            .map_err(|e| DoneError::Internal(e.to_string()))?;
        self.broadcaster.send(ServerEvent::SessionState {
            session_id: id.to_string(),
            state: LifecycleState::Done,
            reason: None,
        });

        // Clean up notify state for the done session.
        self.subagent_notify.forget_subagent_notify(id);

        // Drop the replay-only initial prompt now the session is explicitly
        // done — a future resume must never re-issue it.
        if session.initial_prompt.is_some() {
            self.apply_session_mutation(&ctx, id, Arc::new(|s| s.initial_prompt = None))
                .await
                .map_err(|e| DoneError::Internal(mutate_err_str(e)))?;
        }
        Ok(DoneResult { ok: true })
    }

    /// `POST /sessions/:id/resume` — bring a done/exited agent (or terminal)
    /// session back up. Branches on restore-argv vs fresh-launch, self-heals a
    /// missing `agentChatId`, and deliberately resets the lifecycle axis to
    /// `working` (mirrors the two-axis lifecycle model — this is a documented
    /// invariant, see AGENTS.md).
    pub async fn resume_session(&self, id: &str) -> Result<Session, ResumeError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| ResumeError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(ResumeError::NotRunning(
                "Session is not running — start a new session instead".to_string(),
            ));
        }
        let (project, worktree, session) = match &ctx {
            SessionContext::Worktree {
                project,
                worktree,
                session,
            } => (project.clone(), Some(worktree.clone()), session.clone()),
            SessionContext::Direct { project, session } => (project.clone(), None, session.clone()),
            SessionContext::Global { .. } => unreachable!(),
        };
        // An archived session is retired history — never resume against it.
        if session.archived_at.is_some() {
            return Err(ResumeError::Archived(
                "Session is archived — start a new session instead".to_string(),
            ));
        }

        let ctx_resolved = resolved_context_of(project.clone(), worktree.clone());
        let cwd = ctx_resolved.cwd.clone();

        // Already-running guard: a live pane/pty must not be torn down by a
        // redundant resume (double-click, or resume racing the create-time
        // spawn). If something is already alive, report current state.
        let already_running = if session.use_tmux {
            self.tmux.has_session(&session.tmux_name)
        } else {
            self.direct_ptys.read().unwrap().contains_key(id)
        };
        if already_running {
            return Ok(serialize_session(
                worktree.as_ref().map(|w| w.id.as_str()),
                &project.id,
                &session,
            ));
        }

        let (restored_from_history, newly_captured_chat_id) = self
            .resume_spawn(&project, &worktree, &session, &cwd)
            .await
            .map_err(ResumeError::Internal)?;

        let mut updated = session.clone();
        if newly_captured_chat_id.is_some() {
            updated.agent_chat_id = newly_captured_chat_id;
        }
        updated.lifecycle = SessionLifecycle {
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: now_iso(),
        };

        let project_id = project.id.clone();
        match &worktree {
            Some(w) => {
                let wt_id = w.id.clone();
                let sid = id.to_string();
                let upd = updated.clone();
                self.store
                    .mutate_project(&project_id, move |p| {
                        for wt in &mut p.worktrees {
                            if wt.id == wt_id {
                                for s in &mut wt.sessions {
                                    if s.id == sid {
                                        *s = upd.clone();
                                    }
                                }
                                return Ok(p.clone());
                            }
                        }
                        Err(StoreError::Mutation(format!(
                            "worktree '{wt_id}' not found"
                        )))
                    })
                    .await
                    .map_err(|e| ResumeError::Internal(e.to_string()))?;
            }
            None => {
                let sid = id.to_string();
                let upd = updated.clone();
                self.store
                    .mutate_project(&project_id, move |p| {
                        for s in &mut p.direct_sessions {
                            if s.id == sid {
                                *s = upd.clone();
                            }
                        }
                        Ok(p.clone())
                    })
                    .await
                    .map_err(|e| ResumeError::Internal(e.to_string()))?;
            }
        }

        // Cross-part gap: `ServerEvent` has no `SessionResumed` variant (the
        // wire `ServerMessage::SessionResumed` exists but the internal event +
        // vst-ws mapping lack it), so we emit the lifecycle `working` change
        // instead — the status signal the client's `sessionStates` resolution
        // needs. `restoredFromHistory` is therefore not delivered on the wire.
        let _ = restored_from_history;
        self.broadcaster.send(ServerEvent::SessionState {
            session_id: id.to_string(),
            state: LifecycleState::Working,
            reason: None,
        });

        Ok(serialize_session(
            worktree.as_ref().map(|w| w.id.as_str()),
            &project.id,
            &updated,
        ))
    }

    /// The agent-or-terminal spawn branch of `resume_session`. Returns
    /// `(restored_from_history, newly_captured_chat_id)`.
    async fn resume_spawn(
        &self,
        project: &ProjectRecord,
        worktree: &Option<WorktreeRecord>,
        session: &SessionRecord,
        cwd: &str,
    ) -> Result<(bool, Option<String>), String> {
        if session.r#type == SessionType::Agent && session.mode_id.is_some() {
            let mode = self.resolve_resume_mode(session);
            let plugin = resolve_plugin(mode.cli);
            let restore_argv = plugin
                .get_restore_command(RestoreArgs {
                    session,
                    project,
                    cwd,
                    model: mode.model.as_deref(),
                })
                .await;

            if let Some(argv) = restore_argv {
                // Resume path: spawn from explicit restore argv.
                plugin.setup_workspace_hooks(cwd).await;
                let launch_cfg = LaunchConfig {
                    project: project.clone(),
                    ctx: PluginContext {
                        cwd: PathBuf::from(cwd),
                        project_id: project.id.clone(),
                        worktree: worktree.clone(),
                    },
                    session: session.clone(),
                    daemon_port: self.daemon_port,
                    model: mode.model.clone(),
                };
                let mut env = build_vst_env(&BuildVstEnvOptions {
                    project: project.clone(),
                    worktree: worktree.clone(),
                    session: session.clone(),
                    daemon_port: self.daemon_port,
                });
                for (k, v) in plugin.get_environment(&launch_cfg) {
                    env.insert(k, v);
                }
                let fallback_ms = plugin.get_ready_signal().fallback_ms;
                self.spawn_session_from_argv(
                    session,
                    cwd,
                    worktree.as_ref().map(|w| w.id.as_str()),
                    argv,
                    env,
                    fallback_ms,
                )
                .await?;

                // Self-heal a missing chat id (fills a GAP — never overwrites).
                let mut captured = None;
                if session.agent_chat_id.is_none() {
                    if let Some(cid) = plugin
                        .capture_chat_id(CaptureArgs {
                            session,
                            project,
                            cwd,
                            worktree: worktree.as_ref(),
                        })
                        .await
                    {
                        captured = Some(cid);
                    }
                }
                return Ok((true, captured));
            }

            // Fresh launch path: re-deliver the original create prompt ONLY
            // when no conversation was ever established (`agentChatId` absent).
            let replay_initial_prompt =
                session.agent_chat_id.is_none() && session.initial_prompt.is_some();
            let user_prompt = if replay_initial_prompt {
                session.initial_prompt.clone()
            } else {
                None
            };
            let plugin = resolve_plugin(mode.cli);
            match worktree {
                Some(w) => {
                    let built = build_prompt(&BuildPromptInput {
                        project: project.clone(),
                        worktree: w.clone(),
                        mode_context: Some(mode.context.clone()),
                        user_prompt,
                        rich_chat: false,
                    });
                    spawn_session(&SpawnSessionOpts {
                        project,
                        worktree: Some(w),
                        session,
                        plugin: &*plugin,
                        daemon_port: self.daemon_port,
                        system_prompt: built.system_prompt,
                        task_prompt: built.task_prompt,
                        model: mode.model.clone(),
                        tmux: &self.tmux,
                        direct_ptys: &self.direct_ptys,
                    })
                    .await?;
                }
                None => {
                    let built = build_direct_prompt(&BuildDirectPromptInput {
                        project: project.clone(),
                        mode_context: Some(mode.context.clone()),
                        user_prompt,
                        rich_chat: false,
                    });
                    spawn_session(&SpawnSessionOpts {
                        project,
                        worktree: None,
                        session,
                        plugin: &*plugin,
                        daemon_port: self.daemon_port,
                        system_prompt: built.system_prompt,
                        task_prompt: built.task_prompt,
                        model: mode.model.clone(),
                        tmux: &self.tmux,
                        direct_ptys: &self.direct_ptys,
                    })
                    .await?;
                }
            }
            return Ok((false, None));
        }

        // Terminal session — spawn a new shell session (best-effort).
        let wt_path = worktree.as_ref().map(|_| cwd);
        self.spawn_terminal(project, session, wt_path, session.use_tmux)
            .await?;
        Ok((false, None))
    }

    /// Resolve the mode for a resume, falling back to the live JSON agent's
    /// frozen cli/name (or claude defaults) when the mode was deleted. A
    /// deleted in-use mode must not hard-fail the resume.
    fn resolve_resume_mode(&self, session: &SessionRecord) -> Mode {
        let mode_id = session.mode_id.clone().unwrap_or_default();
        if let Some(m) = find_mode(&mode_id) {
            return m;
        }
        let mut mode = Mode {
            id: mode_id,
            name: "(deleted mode)".to_string(),
            cli: CliId::Claude,
            context: String::new(),
            created_at: now_iso(),
            model: None,
        };
        if let Some(live) = self.json_registry.get(&session.id) {
            if let Some(n) = live.get_mode_name() {
                mode.name = n;
            }
            mode.cli = provider_to_cli(live.get_cli());
        }
        mode
    }

    /// `spawnSessionFromArgv` orchestration (services/spawn.ts) — spawn a
    /// session from an explicit argv with no prompt composition. Ported here
    /// because the resume path needs it and no other crate exposes it.
    async fn spawn_session_from_argv(
        &self,
        session: &SessionRecord,
        cwd: &str,
        worktree_id: Option<&str>,
        argv: Vec<String>,
        env: HashMap<String, String>,
        fallback_ms: u64,
    ) -> Result<(), String> {
        if !session.use_tmux {
            let command = argv.first().cloned().unwrap_or_default();
            let args = if argv.len() > 1 {
                argv[1..].to_vec()
            } else {
                vec![]
            };
            let handle = spawn_child(SpawnChildOptions {
                command,
                args,
                cwd: PathBuf::from(cwd),
                env,
                cols: 80,
                rows: 24,
                session_id: session.id.clone(),
                project_id: session.project_id.clone(),
                worktree_id: worktree_id.map(str::to_string),
            })
            .map_err(|e| e.to_string())?;
            self.direct_ptys
                .write()
                .unwrap()
                .insert(session.id.clone(), handle);
            tokio::time::sleep(Duration::from_millis(fallback_ms)).await;
            return Ok(());
        }
        if self.tmux.has_session(&session.tmux_name) {
            self.tmux.kill_session(&session.tmux_name);
        }
        self.tmux
            .new_session(&NewSessionOptions {
                name: session.tmux_name.clone(),
                cwd: Some(PathBuf::from(cwd)),
                env,
                command: Some(argv),
            })
            .map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(fallback_ms)).await;
        Ok(())
    }

    /// `POST /sessions/:id/reset` — archive the current agent session and spawn
    /// a fresh one in its place: same tab position (isMain/sortOrder/worktreeId
    /// inherited), same name unless a new prompt re-derives it. Optionally
    /// switches mode (reset-with-mode-switch). The archive + replacement happen
    /// in the SAME `mutate_project` call so a worktree never has zero live main
    /// sessions in persisted state (Risk #2).
    pub async fn reset_session(
        &self,
        id: &str,
        body: &ResetBody,
    ) -> Result<ResetResult, ResetError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| ResetError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(ResetError::NotFound(format!("Session '{id}' not found")));
        }
        let (project, worktree, session) = match &ctx {
            SessionContext::Worktree {
                project,
                worktree,
                session,
            } => (project.clone(), Some(worktree.clone()), session.clone()),
            SessionContext::Direct { project, session } => (project.clone(), None, session.clone()),
            SessionContext::Global { .. } => unreachable!(),
        };
        if session.r#type != SessionType::Agent {
            return Err(ResetError::NotAgent(
                "Reset only applies to agent sessions".to_string(),
            ));
        }
        if session.archived_at.is_some() {
            return Err(ResetError::Archived("Session already archived".to_string()));
        }
        // A session whose mode was deleted must fail loudly here, not silently
        // archive the old session with no replacement ever spawned.
        let mode_id = session
            .mode_id
            .clone()
            .ok_or_else(|| ResetError::NoMode("Session has no mode; cannot reset".to_string()))?;
        find_mode(&mode_id)
            .ok_or_else(|| ResetError::ModeNotFound(format!("Mode '{mode_id}' not found")))?;

        // reset-with-mode-switch: resolve + validate the REQUESTED mode (id or
        // name) before any teardown — a typo'd mode must not archive the old
        // session with nothing to replace it.
        let mut effective_mode_id = mode_id;
        if let Some(req) = &body.mode_id {
            let resolved = resolve_mode_id(req)
                .ok_or_else(|| ResetError::ModeNotFound(format!("Mode '{req}' not found")))?;
            find_mode(&resolved)
                .ok_or_else(|| ResetError::ModeNotFound(format!("Mode '{req}' not found")))?;
            effective_mode_id = resolved;
        }

        // Direct delivery bypasses paste+poll; otherwise run the bounded
        // paste-then-poll handoff turn.
        let mut handoff_text: Option<String> = body.handoff_text.clone();
        if handoff_text.is_none() && body.handoff.unwrap_or(false) {
            let handoff_path = handoff_path_for(&session.id);
            let channel = session_channel(session.channel, Some(session.use_tmux));
            let instruction = handoff_instruction(&handoff_path);
            match run_handoff_turn(&session.tmux_name, channel, &handoff_path, &instruction).await {
                Ok(true) => {
                    handoff_text = read_handoff_file_or_null(&handoff_path)
                        .await
                        .ok()
                        .flatten()
                }
                _ => handoff_text = None,
            }
        }

        // Kill the process/pane BEFORE the archive. (forceCloseSessionStreams
        // is a cross-part gap — vst-ws owns the connection hub, so the route
        // crate cannot close open WS streams here.)
        self.release_session_runtime(&session, false).await;

        // Name: keep the old name UNLESS an explicit new prompt was given.
        let new_name = match &body.prompt {
            Some(p) => {
                let slug = slugify_prompt(p);
                if slug.is_empty() {
                    session.name.clone().unwrap_or_default()
                } else {
                    slug
                }
            }
            None => session.name.clone().unwrap_or_default(),
        };
        // Prompt: never the ORIGINAL creation prompt. Handoff summary + explicit
        // prompt combine when both are given.
        let new_initial_prompt = {
            let parts: Vec<String> = [handoff_text.as_deref(), body.prompt.as_deref()]
                .into_iter()
                .flatten()
                .map(str::to_string)
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n---\n\n"))
            }
        };

        let scope_id = worktree
            .as_ref()
            .map(|w| w.id.clone())
            .unwrap_or_else(|| project.id.clone());
        let new_id = generate_session_id(&scope_id, SessionType::Agent);

        // reset-with-mode-switch: a session switching INTO a mode whose CLI
        // can't do JSON can't keep a "json" channel — silently downgrade to a
        // normal tmux terminal rather than erroring.
        let wants_json = session.channel == Some(Channel::Json);
        let downgrade_to_tmux = wants_json && (self.json_unsupported)(&effective_mode_id).is_some();
        let is_json_channel = wants_json && !downgrade_to_tmux;
        let new_channel = if downgrade_to_tmux {
            Channel::Tmux
        } else {
            session.channel.unwrap_or(Channel::Tmux)
        };
        let new_use_tmux = if downgrade_to_tmux {
            true
        } else {
            session.use_tmux
        };

        let new_session = SessionRecord {
            id: new_id.clone(),
            worktree_id: session.worktree_id.clone(),
            project_id: project.id.clone(),
            is_main: session.is_main,
            sort_order: session.sort_order,
            r#type: SessionType::Agent,
            mode_id: Some(effective_mode_id.clone()),
            name: Some(new_name),
            name_source: if body.prompt.is_some() {
                Some(SessionNameSource::Auto)
            } else {
                session.name_source
            },
            tmux_name: tmux_name_for_session(&new_id),
            use_tmux: new_use_tmux,
            channel: Some(new_channel),
            lifecycle: SessionLifecycle {
                state: LifecycleState::NotStarted,
                reason: None,
                last_transition_at: now_iso(),
            },
            initial_prompt: new_initial_prompt.clone(),
            parent_session_id: session.parent_session_id.clone(),
            archived_at: None,
            handoff_summary: None,
            superseded_by: None,
            pr: None,
            transcript_ref: if is_json_channel {
                match &worktree {
                    Some(w) => {
                        transcript_ref_for_worktree(project.id.clone(), &w.id, &new_id, true)
                    }
                    None => transcript_ref_for_direct(project.id.clone(), &new_id, true),
                }
            } else {
                None
            },
            draft_prompt: None,
            draft_config: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
        };

        // Archive the old row + append the replacement in this SAME
        // mutateProject call (Risk #2). The archived row's isMain is explicitly
        // cleared (Bug 3 fix) so `find(isMain)` resolves to the live new row.
        let archived_at = now_iso();
        let old_id = session.id.clone();
        let old_id_c = old_id.clone();
        let wt_id_opt = worktree.as_ref().map(|w| w.id.clone());
        let project_id = project.id.clone();
        let new_rec = new_session.clone();
        let archived_at_c = archived_at.clone();
        let new_id_c = new_id.clone();
        let handoff_text_c = handoff_text.clone();
        self.store
            .mutate_project(&project_id, move |p| {
                let archive = |s: &mut SessionRecord| {
                    s.archived_at = Some(archived_at_c.clone());
                    s.handoff_summary = handoff_text_c.clone();
                    s.is_main = false;
                    s.superseded_by = Some(new_id_c.clone());
                };
                if let Some(wt_id) = &wt_id_opt {
                    for w in &mut p.worktrees {
                        if w.id == *wt_id {
                            for s in &mut w.sessions {
                                if s.id == old_id_c {
                                    archive(s);
                                }
                            }
                            w.sessions.push(new_rec.clone());
                            return Ok(p.clone());
                        }
                    }
                    return Err(StoreError::Mutation(format!(
                        "worktree '{wt_id}' not found"
                    )));
                }
                for s in &mut p.direct_sessions {
                    if s.id == old_id_c {
                        archive(s);
                    }
                }
                p.direct_sessions.push(new_rec.clone());
                Ok(p.clone())
            })
            .await
            .map_err(|e| ResetError::Internal(e.to_string()))?;

        self.subagent_notify.forget_subagent_notify(&old_id);

        let wt_id_for_serialize = worktree.as_ref().map(|w| w.id.clone());
        self.broadcaster.send(ServerEvent::SessionUpdated {
            session_id: old_id.clone(),
            pinned_at: None,
            channel: None,
            name: None,
            archived_at: Some(archived_at),
            sort_order: None,
            pr: None,
            superseded_by: Some(new_id.clone()),
            is_main: None,
            parent_session_id: None,
            worktree_id: None,
            draft_prompt: None,
            draft_config: None,
        });
        // `ServerEvent::SessionCreated` now carries `snapshot`/`parentSessionId`
        // (the former cross-part gap noted here is closed — see the field's
        // doc comment in `vst-types/src/events.rs`).
        let new_session_serialized =
            serialize_session(wt_id_for_serialize.as_deref(), &project.id, &new_session);
        self.broadcaster.send(ServerEvent::SessionCreated {
            session_id: new_id.clone(),
            worktree_id: wt_id_for_serialize,
            project_id: Some(project.id.clone()),
            session_type: "agent".to_string(),
            mode: Some(new_session.mode_id.clone().unwrap_or_default()),
            snapshot: Some((&new_session_serialized).into()),
            parent_session_id: new_session.parent_session_id.clone(),
        });

        // Spawn the replacement through the SAME channel-aware, guarded helper
        // session creation uses — never a raw unguarded spawn.
        let opts = SpawnChannelOpts {
            project: project.clone(),
            worktree: worktree.clone(),
            session: new_session,
            mode_id: effective_mode_id,
            prompt: new_initial_prompt,
            daemon_port: self.daemon_port,
            skip_auto_turn: false,
        };
        let routes = self.clone();
        tokio::spawn(async move {
            routes.spawn_new_session_for_channel(opts).await;
        });

        Ok(ResetResult {
            ok: true,
            archived_session_id: old_id,
            new_session_id: new_id,
        })
    }

    /// `POST /sessions/:id/handoff` — write-only: runs the handoff turn but
    /// does NOT archive or respawn (unlike reset's `--handoff` option). No
    /// archivedAt guard (a standalone handoff summary is meaningful even after
    /// a session is archived).
    pub async fn handoff_session(&self, id: &str) -> Result<HandoffResult, HandoffRouteError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| HandoffRouteError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(HandoffRouteError::NotFound(format!(
                "Session '{id}' not found"
            )));
        }
        let session = match &ctx {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                session
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        if session.r#type != SessionType::Agent {
            return Err(HandoffRouteError::NotAgent(
                "Handoff only applies to agent sessions".to_string(),
            ));
        }

        let handoff_path = handoff_path_for(&session.id);
        let channel = session_channel(session.channel, Some(session.use_tmux));
        let instruction = handoff_instruction(&handoff_path);
        let summary = match run_handoff_turn(
            &session.tmux_name,
            channel,
            &handoff_path,
            &instruction,
        )
        .await
        {
            Ok(true) => read_handoff_file_or_null(&handoff_path)
                .await
                .ok()
                .flatten(),
            _ => None,
        };
        Ok(HandoffResult {
            ok: true,
            handoff_summary: summary,
        })
    }

    // -----------------------------------------------------------------------
    // Group C — send / chat / queue (lines 2226-2606)
    // -----------------------------------------------------------------------

    /// `POST /sessions/:id/send` — the one way to deliver a message to a
    /// session: raw bytes to a pane for tmux/pty, a chat turn for Rich Chat.
    pub async fn send_session(
        &self,
        id: &str,
        body: InputBody,
    ) -> Result<ChatActionResult, ChatRouteError> {
        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChatRouteError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(ChatRouteError::NotFound(format!(
                "Session '{id}' not found"
            )));
        }
        let session = match &ctx {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                session
            }
            SessionContext::Global { .. } => unreachable!(),
        };

        // Rich Chat (json) — "input" means a chat turn, not PTY bytes.
        if session_channel(session.channel, Some(session.use_tmux)) == Channel::Json {
            if session.archived_at.is_some() {
                return Err(ChatRouteError::Archived(
                    "Session is archived — start a new session instead".to_string(),
                ));
            }
            let attachments = self
                .resolve_attachments(id, body.attachment_ids.as_deref())
                .await?;
            enqueue_chat_turn(
                EnqueueChatTurnOpts {
                    session_id: id.to_string(),
                    message: body.data.clone(),
                    attachments,
                    daemon_port: self.daemon_port,
                    // D8 — steer a running turn by default; `queue: true` opts out.
                    steer: Some(!body.queue.unwrap_or(false)),
                    store: self.store.clone(),
                    broadcaster: self.broadcaster.clone(),
                },
                &self.json_registry,
            )
            .await
            .map_err(ChatRouteError::from_enqueue)?;
            // Mark it working, exactly as POST /chat does — otherwise
            // `vst session send --wait` returns before the turn even starts.
            if let Some(jctx) = find_json_session_context(&self.store, id).await {
                self.persist_working(&jctx).await;
            }
            self.subagent_notify.note_human_turn(id);
            return Ok(ChatActionResult { ok: true });
        }

        // Attachments only make sense on the json channel (D5).
        if let Some(ids) = body.attachment_ids.as_deref() {
            if !ids.is_empty() {
                return Err(ChatRouteError::AttachmentsRequireJson(
                    "Attachments require a Rich Chat (json) session".to_string(),
                ));
            }
        }

        if !session.use_tmux {
            let stream = self.direct_ptys.read().unwrap().get(id).cloned();
            let Some(stream) = stream else {
                return Err(ChatRouteError::NotRunning(
                    "Session not running".to_string(),
                ));
            };
            let data = body.data.clone();
            let send_enter = body.send_enter.unwrap_or(false);
            // `PtyHandle::write` is a fast in-memory writer lock — no
            // spawn_blocking needed (matches the direct-pty spawn path).
            stream.write(&data);
            if send_enter {
                stream.write("\r");
            }
            return Ok(ChatActionResult { ok: true });
        }

        let buffer_id = format!("_vst_send-{id}");
        let tmux_name = session.tmux_name.clone();
        // Paste-then-submit: pasteBuffer wraps in bracketed-paste markers, so a
        // trailing Enter is required as a separate send-keys (not a "\n" baked
        // into the data) — matches the spawn.ts convention.
        self.tmux
            .paste_buffer(&tmux_name, &buffer_id, &body.data)
            .map_err(|e| ChatRouteError::Internal(format!("Failed to send input: {e}")))?;
        if body.send_enter.unwrap_or(false) {
            self.tmux
                .send_keys(&tmux_name, "", true)
                .map_err(|e| ChatRouteError::Internal(format!("Failed to send input: {e}")))?;
        }
        Ok(ChatActionResult { ok: true })
    }

    /// `POST /sessions/:id/chat` — enqueue a user turn. Always accepted (never
    /// 409): queued behind any running turn (FIFO). Returns 202
    /// `{ turnId, queuePosition }`.
    pub async fn chat_session(
        &self,
        id: &str,
        body: ChatBody,
    ) -> Result<EnqueueChatResult, ChatRouteError> {
        // Bug 4 fix: an archived session is displayed read-only — never let a
        // chat turn spawn/run a live agent process against it.
        let pre_ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChatRouteError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(pre_ctx, SessionContext::Global { .. }) {
            return Err(ChatRouteError::NotFound(format!(
                "Session '{id}' not found"
            )));
        }
        let pre_session = match &pre_ctx {
            SessionContext::Worktree { session, .. } | SessionContext::Direct { session, .. } => {
                session
            }
            SessionContext::Global { .. } => unreachable!(),
        };
        if pre_session.archived_at.is_some() {
            return Err(ChatRouteError::Archived(
                "Session is archived — start a new session instead".to_string(),
            ));
        }

        let attachments = self
            .resolve_attachments(id, body.attachment_ids.as_deref())
            .await?;
        let result = enqueue_chat_turn(
            EnqueueChatTurnOpts {
                session_id: id.to_string(),
                message: body.message.clone(),
                attachments,
                daemon_port: self.daemon_port,
                steer: Some(!body.queue.unwrap_or(false)),
                store: self.store.clone(),
                broadcaster: self.broadcaster.clone(),
            },
            &self.json_registry,
        )
        .await
        .map_err(ChatRouteError::from_enqueue)?;

        // Mark the session working while the turn runs (JSON lifecycle, D11).
        if let Some(jctx) = find_json_session_context(&self.store, id).await {
            self.persist_working(&jctx).await;
        }
        // Someone is actively driving this session, so the unattended
        // subagent-notice budget starts over.
        self.subagent_notify.note_human_turn(id);

        Ok(EnqueueChatResult {
            turn_id: result.turn_id,
            queue_position: result.queue_position as i64,
            delivery: result.delivery.map(|d| match d {
                EnqueueDelivery::Queued => Delivery::Queued,
                EnqueueDelivery::Steered => Delivery::Steered,
            }),
        })
    }

    /// `POST /sessions/:id/chat/dismiss-notice` — dismiss the pending notice
    /// slot (subagent-ux-v2). Idempotent: 204 whether or not a slot exists.
    /// 404 if the session is not found or is not a JSON session.
    pub async fn dismiss_notice(&self, id: &str) -> Result<(), ChatRouteError> {
        let ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChatRouteError::NotFound(format!("Session '{id}' not found")))?;
        // FIX-F: idempotent — no agent means no active slot; still 204.
        if let Some(agent) = self.json_registry.get(id) {
            agent.dismiss_notice_slot();
        }
        drop(ctx);
        Ok(())
    }

    /// `POST /sessions/:id/chat/promote-notice` — run pending notice slot
    /// immediately (subagent-ux-v2). Idempotent: 204 whether or not a slot
    /// exists. 404 if the session is not found or is not a JSON session.
    pub async fn promote_notice(&self, id: &str) -> Result<(), ChatRouteError> {
        let _ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChatRouteError::NotFound(format!("Session '{id}' not found")))?;
        if let Some(agent) = self.json_registry.get(id) {
            agent.promote_notice_slot();
        }
        Ok(())
    }

    /// `POST /sessions/:id/chat/stop` — abort the ACTIVE turn, keep queued
    /// turns (D8/13). No-op (200) when only queued turns exist; 409 when no
    /// JSON agent has ever run for this session.
    pub async fn stop_active_turn(&self, id: &str) -> Result<ChatActionResult, ChatRouteError> {
        let _ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChatRouteError::NotFound(format!("Session '{id}' not found")))?;
        let Some(agent) = self.json_registry.get(id) else {
            return Err(ChatRouteError::NoActiveTurn("No active turn".to_string()));
        };
        agent.stop_active_turn();
        Ok(ChatActionResult { ok: true })
    }

    /// `DELETE /sessions/:id/chat/queue/:turnId` — cancel ONE queued
    /// (not-yet-started) turn.
    pub async fn cancel_queued_turn(
        &self,
        id: &str,
        turn_id: &str,
    ) -> Result<ChatActionResult, ChatRouteError> {
        let _ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChatRouteError::NotFound(format!("Session '{id}' not found")))?;
        let removed = self
            .json_registry
            .get(id)
            .map(|a| a.cancel_queued_turn(turn_id))
            .unwrap_or(false);
        if !removed {
            return Err(ChatRouteError::TurnNotFound(format!(
                "Queued turn '{turn_id}' not found"
            )));
        }
        Ok(ChatActionResult { ok: true })
    }

    /// `POST …/chat/queue/:turnId/edit` — withdraw a queued turn into the
    /// editing hold (queue-controls). Returns its raw content + original queue
    /// index. Re-editing an already-held turn re-acquires it (recovery, A5).
    /// 404 when not queued/held.
    pub async fn edit_queued_turn(
        &self,
        id: &str,
        turn_id: &str,
    ) -> Result<EditQueuedResult, ChatRouteError> {
        let _ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChatRouteError::NotFound(format!("Session '{id}' not found")))?;
        let Some(agent) = self.json_registry.get(id) else {
            return Err(ChatRouteError::TurnNotQueued("not_queued".to_string()));
        };
        let Some((message, attachments, queue_index)) = agent.begin_edit_queued_turn(turn_id)
        else {
            return Err(ChatRouteError::TurnNotQueued("not_queued".to_string()));
        };
        Ok(EditQueuedResult {
            turn_id: turn_id.to_string(),
            message,
            attachments,
            queue_index: queue_index as i64,
        })
    }

    /// `POST …/chat/queue/:turnId/resubmit` — re-enqueue a held turn
    /// (queue-controls). `edited:true` overwrites text/attachments + emits a
    /// superseding user event; `edited:false` restores it unchanged. 404 when
    /// the turn isn't held.
    pub async fn resubmit_queued_turn(
        &self,
        id: &str,
        turn_id: &str,
        body: ResubmitBody,
    ) -> Result<TurnActionResult, ChatRouteError> {
        let ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChatRouteError::NotFound(format!("Session '{id}' not found")))?;
        let Some(agent) = self.json_registry.get(id) else {
            return Err(ChatRouteError::NotEditing("not_editing".to_string()));
        };

        // Resolve attachment ids only when editing (D5 / A11).
        let mut attachments = vec![];
        if body.edited {
            attachments = self
                .resolve_attachments(id, body.attachment_ids.as_deref())
                .await?;
        }

        let message = if body.edited {
            body.message.clone().unwrap_or_default()
        } else {
            String::new()
        };
        let ok = agent.resubmit_queued_turn(turn_id, message, attachments, body.edited);
        if !ok {
            return Err(ChatRouteError::NotEditing("not_editing".to_string()));
        }

        // Drain may have persisted `idle` while the turn was held (R17) — the
        // re-enqueued turn will run, so re-flip the lifecycle to working (A4).
        self.persist_working(&ctx).await;
        Ok(TurnActionResult {
            ok: true,
            turn_id: turn_id.to_string(),
        })
    }

    /// `POST …/chat/queue/:turnId/promote` — "Send now": preempt. Jumps the
    /// target to the front AND aborts the active turn so it runs next; the
    /// aborted turn is dropped (not re-queued).
    pub async fn promote_queued_turn(
        &self,
        id: &str,
        turn_id: &str,
    ) -> Result<TurnActionResult, ChatRouteError> {
        let _ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChatRouteError::NotFound(format!("Session '{id}' not found")))?;
        let Some(agent) = self.json_registry.get(id) else {
            return Err(ChatRouteError::TurnNotQueued("not_queued".to_string()));
        };
        if !agent.promote_queued_turn(turn_id) {
            return Err(ChatRouteError::TurnNotQueued("not_queued".to_string()));
        }
        Ok(TurnActionResult {
            ok: true,
            turn_id: turn_id.to_string(),
        })
    }

    /// `PATCH …/chat/model` — live-switch the session's model (status-bar
    /// switcher). `model: null` clears the override back to the mode default.
    /// Applies to the NEXT spawned turn; never interrupts a running turn.
    pub async fn patch_chat_model(
        &self,
        id: &str,
        body: PatchModelBody,
    ) -> Result<PatchModelResult, ChatRouteError> {
        let model = body.model;
        // `resolve_json_agent` lazily re-creates a released JsonAgentSession.
        // For a session the user marked `done`, refuse instead — sending a
        // message is the deliberate way to bring a done session back.
        let model_ctx = find_session_context(&self.store, id).await;
        if let Some(model_ctx) = &model_ctx {
            if !matches!(model_ctx, SessionContext::Global { .. }) {
                let session = match model_ctx {
                    SessionContext::Worktree { session, .. }
                    | SessionContext::Direct { session, .. } => session,
                    SessionContext::Global { .. } => unreachable!(),
                };
                if session.lifecycle.state == LifecycleState::Done {
                    return Err(ChatRouteError::Done(
                        "Session is done — send a message to resume it before switching model."
                            .to_string(),
                    ));
                }
            }
        }

        let resolved = resolve_json_agent(
            id,
            self.daemon_port,
            &self.store,
            &self.json_registry,
            self.broadcaster.clone(),
        )
        .await
        .map_err(ChatRouteError::from_enqueue)?;

        // Soft validation: when the CLI's model list is available, reject an
        // unknown model. If the list can't be fetched, accept free text.
        if let Some(m) = &model {
            let plugin = resolve_plugin(provider_to_cli(resolved.mode.cli));
            let list = plugin.list_models().await;
            if list.error.is_none() && !list.models.is_empty() && !list.models.contains(m) {
                return Err(ChatRouteError::UnknownModel(format!(
                    "Unknown model '{m}' for {:?}",
                    resolved.mode.cli
                )));
            }
        }

        resolved
            .agent
            .set_model(model.clone(), resolved.mode.model.clone())
            .await;
        Ok(PatchModelResult {
            ok: true,
            model: model.or(resolved.mode.model),
        })
    }

    /// `spawnTtyForAgent` helper (Group D, daemon/src/routes/sessions.ts lines 2617-2708).
    /// Spawns tmux/pty process for an EXISTING agent session (worktree OR direct),
    /// resuming its `agentChatId` when one exists (P3 json→tty, R1.2/R1.3).
    /// Reuses the same restore primitives as POST /resume — `get_restore_command` ->
    /// `spawn_session_from_argv` — with a fresh-launch fallback for an empty session.
    async fn spawn_tty_for_agent(
        &self,
        project: &ProjectRecord,
        worktree: Option<&WorktreeRecord>,
        session: &mut SessionRecord,
        plugin: &dyn AgentPlugin,
        model: Option<&str>,
        context: Option<&str>,
    ) -> Result<(), String> {
        let cwd = match worktree {
            Some(w) => Paths::default()
                .project_dir(&project.id)
                .join("worktrees")
                .join(&w.id)
                .display()
                .to_string(),
            None => project.absolute_path.clone(),
        };

        let restore_argv = plugin
            .get_restore_command(RestoreArgs {
                session,
                project,
                cwd: &cwd,
                model,
            })
            .await;

        if let Some(argv) = restore_argv {
            // Resume path — same as POST /resume: self-heal hooks, then spawn the argv.
            plugin.setup_workspace_hooks(&cwd).await;
            let launch_cfg = LaunchConfig {
                project: project.clone(),
                ctx: PluginContext {
                    cwd: PathBuf::from(&cwd),
                    project_id: project.id.clone(),
                    worktree: worktree.cloned(),
                },
                session: session.clone(),
                daemon_port: self.daemon_port,
                model: model.map(str::to_string),
            };
            let mut env = build_vst_env(&BuildVstEnvOptions {
                project: project.clone(),
                worktree: worktree.cloned(),
                session: session.clone(),
                daemon_port: self.daemon_port,
            });
            for (k, v) in plugin.get_environment(&launch_cfg) {
                env.insert(k, v);
            }
            let fallback_ms = plugin.get_ready_signal().fallback_ms;
            self.spawn_session_from_argv(
                session,
                &cwd,
                worktree.map(|w| w.id.as_str()),
                argv,
                env,
                fallback_ms,
            )
            .await?;

            // Self-heal only — never overwrite an already-known id.
            if session.agent_chat_id.is_none() {
                let captured_id = plugin
                    .capture_chat_id(CaptureArgs {
                        session,
                        project,
                        cwd: &cwd,
                        worktree,
                    })
                    .await;
                if captured_id.is_some() {
                    session.agent_chat_id = captured_id;
                }
            }
        } else {
            // Fresh launch — an empty session with nothing to resume (J12).
            let built = match worktree {
                Some(w) => build_prompt(&BuildPromptInput {
                    project: project.clone(),
                    worktree: w.clone(),
                    mode_context: context.map(str::to_string),
                    user_prompt: None,
                    rich_chat: false,
                }),
                None => build_direct_prompt(&BuildDirectPromptInput {
                    project: project.clone(),
                    mode_context: context.map(str::to_string),
                    user_prompt: None,
                    rich_chat: false,
                }),
            };

            spawn_session(&SpawnSessionOpts {
                project,
                worktree,
                session,
                plugin,
                daemon_port: self.daemon_port,
                system_prompt: built.system_prompt,
                task_prompt: built.task_prompt,
                model: model.map(str::to_string),
                tmux: &self.tmux,
                direct_ptys: &self.direct_ptys,
            })
            .await?;
        }

        Ok(())
    }

    /// `PATCH /sessions/:id/channel` — live JSON↔terminal toggle (P3, R1.1–R1.7).
    /// Idle-gated (409 when a turn is active/queued/held for edit). Supports BOTH
    /// worktree-backed and direct/project-scoped sessions (R1.5).
    ///
    /// Critical invariant: json→tty resets `lifecycle` to `working`, mirroring
    /// `/resume`. Without this, a record left at `exited` stays `exited` forever
    /// because the lifecycle poller explicitly refuses to touch non-working/idle sessions.
    pub async fn patch_session_channel(
        &self,
        id: &str,
        body: PatchChannelBody,
    ) -> Result<PatchChannelResult, ChannelError> {
        let target = body.channel;

        let ctx = find_session_context(&self.store, id)
            .await
            .ok_or_else(|| ChannelError::NotFound(format!("Session '{id}' not found")))?;
        if matches!(ctx, SessionContext::Global { .. }) {
            return Err(ChannelError::NotFound(format!("Session '{id}' not found")));
        }

        let (project, worktree, mut session) = match ctx {
            SessionContext::Worktree {
                project,
                worktree,
                session,
            } => (project, Some(worktree), session),
            SessionContext::Direct { project, session } => (project, None, session),
            SessionContext::Global { .. } => unreachable!(),
        };

        if session.r#type != SessionType::Agent {
            return Err(ChannelError::NotAgent(
                "Only agent sessions can switch channel".to_string(),
            ));
        }

        let current = session_channel(session.channel, Some(session.use_tmux));
        if current == target {
            return Ok(PatchChannelResult {
                ok: true,
                channel: current,
                history_imported: false,
            });
        }

        let mode = self.resolve_resume_mode(&session);
        let plugin = resolve_plugin(mode.cli);

        let from_json = current == Channel::Json;
        let to_json = target == Channel::Json;

        // R1.1 idle gate — only a live JSON session has a turn queue/holds to protect.
        if from_json {
            if let Some(agent) = self.json_registry.get(id) {
                if !agent.is_idle_for_toggle() {
                    return Err(ChannelError::NotIdle);
                }
            }
        }

        let (new_channel, new_use_tmux) = channel_transition(target);
        let json_tmux_name = format!("__direct__-{}", session.id);
        let tty_tmux_name = if new_use_tmux {
            tmux_name_for_session(&session.id)
        } else {
            json_tmux_name.clone()
        };

        let switch_result: Result<(), String> = async {
            if from_json {
                // json → tty: detach the in-memory JSON session, then spawn TTY resuming agentChatId.
                let json_agent_to_close = self.json_registry.get(id);
                self.json_registry.remove(id);
                if let Some(agent) = json_agent_to_close {
                    agent.release().await;
                }
                session.tmux_name = tty_tmux_name.clone();
                session.channel = Some(new_channel);
                session.use_tmux = new_use_tmux;
                self.spawn_tty_for_agent(
                    &project,
                    worktree.as_ref(),
                    &mut session,
                    &*plugin,
                    mode.model.as_deref(),
                    if mode.context.is_empty() {
                        None
                    } else {
                        Some(&mode.context)
                    },
                )
                .await?;
            } else {
                // tty → json: tear the TTY down.
                if session.use_tmux {
                    if self.tmux.has_session(&session.tmux_name) {
                        self.tmux.kill_session(&session.tmux_name);
                    }
                } else {
                    let mut ptys = self.direct_ptys.write().unwrap();
                    if let Some(handle) = ptys.remove(id) {
                        handle.kill();
                    }
                    self.direct_streams.lock().unwrap().remove(id);
                }

                // Self-heal agentChatId against CLI's own live state. Overwrites even an already-set id.
                let cwd = match &worktree {
                    Some(w) => Paths::default()
                        .project_dir(&project.id)
                        .join("worktrees")
                        .join(&w.id)
                        .display()
                        .to_string(),
                    None => project.absolute_path.clone(),
                };
                if let Some(refreshed_id) = plugin
                    .refresh_chat_id_on_toggle(CaptureArgs {
                        session: &session,
                        project: &project,
                        cwd: &cwd,
                        worktree: worktree.as_ref(),
                    })
                    .await
                {
                    session.agent_chat_id = Some(refreshed_id);
                }

                session.tmux_name = json_tmux_name.clone();
                session.channel = Some(new_channel);
                session.use_tmux = new_use_tmux;
            }
            Ok(())
        }
        .await;

        if let Err(err) = switch_result {
            return Err(ChannelError::Internal(format!(
                "Failed to switch channel: {err}"
            )));
        }

        // Persist the flipped channel + useTmux + tmuxName, and reset lifecycle to Working if from_json.
        let mut patched_session = session.clone();
        patched_session.channel = Some(new_channel);
        patched_session.use_tmux = new_use_tmux;
        patched_session.tmux_name = session.tmux_name.clone();
        if from_json {
            patched_session.lifecycle = SessionLifecycle {
                state: LifecycleState::Working,
                reason: None,
                last_transition_at: now_iso(),
            };
        }

        let project_id = project.id.clone();
        let sid = id.to_string();
        let upd = patched_session.clone();
        match &worktree {
            Some(w) => {
                let wt_id = w.id.clone();
                self.store
                    .mutate_project(&project_id, move |p| {
                        for wt in &mut p.worktrees {
                            if wt.id == wt_id {
                                for s in &mut wt.sessions {
                                    if s.id == sid {
                                        *s = upd.clone();
                                    }
                                }
                                return Ok(p.clone());
                            }
                        }
                        Err(StoreError::Mutation(format!(
                            "worktree '{wt_id}' not found"
                        )))
                    })
                    .await
                    .map_err(|e| ChannelError::Internal(e.to_string()))?;
            }
            None => {
                self.store
                    .mutate_project(&project_id, move |p| {
                        for s in &mut p.direct_sessions {
                            if s.id == sid {
                                *s = upd.clone();
                            }
                        }
                        Ok(p.clone())
                    })
                    .await
                    .map_err(|e| ChannelError::Internal(e.to_string()))?;
            }
        }

        // Compute fresh meta and handle history backfill.
        let mut history_imported = false;
        let _meta: vst_types::SessionMeta = if to_json {
            let resolved = resolve_json_agent(
                id,
                self.daemon_port,
                &self.store,
                &self.json_registry,
                self.broadcaster.clone(),
            )
            .await;
            match resolved {
                Ok(res) => {
                    let cli_str = cli_name(provider_to_cli(res.mode.cli));
                    if has_native_history_importer(cli_str) {
                        res.agent.import_native_history().await;
                        history_imported = true;
                    }
                    res.agent.get_meta()
                }
                Err(_) => {
                    let cli_str = cli_name(mode.cli);
                    vst_types::SessionMeta {
                        session_id: id.to_string(),
                        channel: new_channel,
                        cli: cli_str.to_string(),
                        mode_id: if mode.id.is_empty() {
                            None
                        } else {
                            Some(mode.id.clone())
                        },
                        mode_name: if mode.name.is_empty() {
                            None
                        } else {
                            Some(mode.name.clone())
                        },
                        model: mode.model.clone(),
                        turn_state: vst_types::TurnState::Idle,
                        queue_depth: 0,
                        queued_turn_ids: vec![],
                        editing_turn_ids: vec![],
                        usage: None,
                        cwd: None,
                        can_steer: None,
                        commands: None,
                        notice_slot: None,
                    }
                }
            }
        } else {
            let cli_str = cli_name(mode.cli);
            vst_types::SessionMeta {
                session_id: id.to_string(),
                channel: new_channel,
                cli: cli_str.to_string(),
                mode_id: if mode.id.is_empty() {
                    None
                } else {
                    Some(mode.id.clone())
                },
                mode_name: if mode.name.is_empty() {
                    None
                } else {
                    Some(mode.name.clone())
                },
                model: mode.model.clone(),
                turn_state: vst_types::TurnState::Idle,
                queue_depth: 0,
                queued_turn_ids: vec![],
                editing_turn_ids: vec![],
                usage: None,
                cwd: None,
                can_steer: None,
                commands: None,
                notice_slot: None,
            }
        };

        // Mirror switch to other tabs (R1.7).
        self.broadcaster.send(ServerEvent::SessionUpdated {
            session_id: id.to_string(),
            pinned_at: None,
            channel: Some(new_channel),
            name: None,
            archived_at: None,
            sort_order: None,
            pr: None,
            superseded_by: None,
            is_main: None,
            parent_session_id: None,
            worktree_id: None,
            draft_prompt: None,
            draft_config: None,
        });
        // Note: ServerEvent does not have a SessionMeta variant in vst-types::events (cross-part gap).
        if from_json {
            self.broadcaster.send(ServerEvent::SessionState {
                session_id: id.to_string(),
                state: LifecycleState::Working,
                reason: None,
            });
        }

        Ok(PatchChannelResult {
            ok: true,
            channel: new_channel,
            history_imported,
        })
    }

    /// `GET /sessions/:id/transcript` — bounded normalized history (R2.1–R2.3).
    ///   ?beforeSeq=<n>&limit=<n> → keyset "load earlier" page { events, oldestSeq, hasMore }
    ///   ?since=<logSeq>          → reconnect delta { events, nextSeq, hasMore }
    ///   ?all=1                   → whole transcript { events }
    ///   (no query / limit only)  → tail-N turns { events, oldestSeq, hasMore }
    pub async fn get_session_transcript(
        &self,
        id: &str,
        query: TranscriptQuery,
    ) -> Result<TranscriptResponse, TranscriptError> {
        let ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| TranscriptError::NotFound(format!("Session '{id}' not found")))?;

        if session_channel(ctx.session.channel, Some(ctx.session.use_tmux)) != Channel::Json {
            return Err(TranscriptError::NotJson(format!(
                "Session '{id}' has no event log (not a Rich Chat session)"
            )));
        }

        if query.all.as_deref() == Some("1") || query.all.as_deref() == Some("true") {
            let events = read_session_transcript(&ctx, &self.json_registry);
            return Ok(TranscriptResponse::All(AllEvents { events }));
        }

        if let Some(since_str) = &query.since {
            let since_seq = since_str
                .parse::<i64>()
                .map_err(|_| TranscriptError::InvalidQuery("invalid since".to_string()))?;
            let page = read_session_since(&ctx, &self.json_registry, since_seq);
            return Ok(TranscriptResponse::Since(SincePage {
                events: page.events,
                next_seq: page.next_seq,
                has_more: page.has_more,
            }));
        }

        if let Some(before_str) = &query.before_seq {
            let before_seq = before_str.parse::<i64>().map_err(|_| {
                TranscriptError::InvalidQuery("invalid beforeSeq/limit".to_string())
            })?;
            let limit = match &query.limit {
                Some(l) => l.parse::<i64>().map_err(|_| {
                    TranscriptError::InvalidQuery("invalid beforeSeq/limit".to_string())
                })?,
                None => 20,
            };
            if limit <= 0 {
                return Err(TranscriptError::InvalidQuery(
                    "invalid beforeSeq/limit".to_string(),
                ));
            }
            let page = read_session_page_before(&ctx, &self.json_registry, before_seq, limit);
            return Ok(TranscriptResponse::Page(TranscriptPage {
                events: page.events,
                oldest_seq: page.oldest_seq,
                has_more: page.has_more,
            }));
        }

        let limit = match &query.limit {
            Some(l) => l
                .parse::<i64>()
                .map_err(|_| TranscriptError::InvalidQuery("invalid limit".to_string()))?,
            None => 20,
        };
        if limit <= 0 {
            return Err(TranscriptError::InvalidQuery("invalid limit".to_string()));
        }
        let page = read_session_tail(&ctx, &self.json_registry, limit);
        Ok(TranscriptResponse::Page(TranscriptPage {
            events: page.events,
            oldest_seq: page.oldest_seq,
            has_more: page.has_more,
        }))
    }

    /// Helper for reading transcript tail directly.
    pub async fn get_session_transcript_tail(
        &self,
        id: &str,
        limit: i64,
    ) -> Result<TranscriptPage, TranscriptError> {
        let resp = self
            .get_session_transcript(
                id,
                TranscriptQuery {
                    limit: Some(limit.to_string()),
                    ..Default::default()
                },
            )
            .await?;
        match resp {
            TranscriptResponse::Page(p) => Ok(p),
            _ => unreachable!(),
        }
    }

    /// Helper for reading full transcript directly.
    pub async fn get_session_transcript_all(&self, id: &str) -> Result<AllEvents, TranscriptError> {
        let resp = self
            .get_session_transcript(
                id,
                TranscriptQuery {
                    all: Some("1".to_string()),
                    ..Default::default()
                },
            )
            .await?;
        match resp {
            TranscriptResponse::All(a) => Ok(a),
            _ => unreachable!(),
        }
    }

    /// `GET /sessions/:id/meta` — latest cross-harness meta (rebuilt from
    /// transcript tail when no live session is registered, Decision 8).
    pub async fn get_session_meta(
        &self,
        id: &str,
    ) -> Result<vst_types::SessionMeta, TranscriptError> {
        let ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| TranscriptError::NotFound(format!("Session '{id}' not found")))?;
        Ok(read_session_meta(&ctx, &self.json_registry).await)
    }

    /// Resolve `attachmentIds` → `Attachment` records (D5). Shared by `/send`,
    /// `/chat`, and `/resubmit` (edited). Returns 400 on any missing id.
    async fn resolve_attachments(
        &self,
        session_id: &str,
        attachment_ids: Option<&[String]>,
    ) -> Result<Vec<vst_types::domain::Attachment>, ChatRouteError> {
        let mut attachments = vec![];
        for upload_id in attachment_ids.unwrap_or_default() {
            let Some(value) = self
                .attachment_registry
                .get_attachment(session_id, upload_id)
            else {
                return Err(ChatRouteError::AttachmentNotFound(format!(
                    "Attachment '{upload_id}' not found"
                )));
            };
            let att =
                serde_json::from_value::<vst_types::domain::Attachment>(value).map_err(|e| {
                    ChatRouteError::Internal(format!("Invalid attachment '{upload_id}': {e}"))
                })?;
            attachments.push(att);
        }
        Ok(attachments)
    }

    /// Persist the session's lifecycle axis to `working` and broadcast the
    /// state change (JSON lifecycle, D11). Mirrors `persistLifecycleState`.
    async fn persist_working(&self, ctx: &vst_agents::json_agent_chat::JsonSessionContext) {
        let lifecycle = SessionLifecycle {
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: now_iso(),
        };
        let _ = self
            .store
            .update_session_lifecycle(&ctx.project.id, &ctx.session.id, lifecycle)
            .await;
        self.broadcaster.send(ServerEvent::SessionState {
            session_id: ctx.session.id.clone(),
            state: LifecycleState::Working,
            reason: None,
        });
    }

    /// Apply a mutation closure to a worktree or direct session. The closure
    /// runs inside the store's locked mutation callback.
    async fn apply_session_mutation(
        &self,
        ctx: &SessionContext,
        id: &str,
        f: Arc<dyn Fn(&mut SessionRecord) + Send + Sync>,
    ) -> Result<(), MutateError> {
        let project_id = match ctx {
            SessionContext::Worktree { project, .. } | SessionContext::Direct { project, .. } => {
                project.id.clone()
            }
            SessionContext::Global { .. } => return Ok(()),
        };
        match ctx {
            SessionContext::Worktree { worktree, .. } => {
                let wt_id = worktree.id.clone();
                let sid = id.to_string();
                let f = f.clone();
                self.store
                    .mutate_project(&project_id, move |p| {
                        for w in &mut p.worktrees {
                            if w.id == wt_id {
                                for s in &mut w.sessions {
                                    if s.id == sid {
                                        f(s);
                                    }
                                }
                                return Ok(p.clone());
                            }
                        }
                        Err(StoreError::Mutation(format!(
                            "worktree '{wt_id}' not found"
                        )))
                    })
                    .await
                    .map_err(|e| MutateError::Internal(e.to_string()))?;
            }
            SessionContext::Direct { .. } => {
                let sid = id.to_string();
                let f = f;
                self.store
                    .mutate_project(&project_id, move |p| {
                        for s in &mut p.direct_sessions {
                            if s.id == sid {
                                f(s);
                            }
                        }
                        Ok(p.clone())
                    })
                    .await
                    .map_err(|e| MutateError::Internal(e.to_string()))?;
            }
            SessionContext::Global { .. } => {}
        }
        Ok(())
    }

    /// Release a session's live runtime resources (JSON agent, tmux/direct
    /// pty, idle-hash entry). Cross-part gap: `PtyHandle` doesn't yet impl
    /// `PtyKill`, so the direct-pty registry is built locally per call.
    async fn release_session_runtime(&self, session: &SessionRecord, clear_attachments: bool) {
        let direct_pty = self.build_direct_pty_registry();
        let on_clear_idle: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
        let on_clear_attachments: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
        release_session_runtime(
            session,
            ReleaseOpts { clear_attachments },
            &self.json_registry,
            &direct_pty,
            &self.tmux,
            on_clear_idle,
            on_clear_attachments,
        )
        .await;
    }

    /// Build a `DirectPtyRegistry` snapshot from the local direct-pty map.
    fn build_direct_pty_registry(&self) -> DirectPtyRegistry {
        let reg = DirectPtyRegistry::new();
        for (sid, handle) in self.direct_ptys.read().unwrap().iter() {
            reg.insert(sid.clone(), Arc::new(PtyHandleKill(handle.clone())));
        }
        reg
    }

    /// Prune a child from its parent's live notice slot, then forget its
    /// subagent-notify state (mirrors `pruneNoticeSlotChild` +
    /// `forgetSubagentNotify`).
    fn prune_notice_and_forget(&self, id: &str, parent_session_id: Option<&str>) {
        if let Some(pid) = parent_session_id {
            if let Some(parent) = self.json_registry.get(pid) {
                parent.prune_notice_slot_child(id);
            }
        }
        self.subagent_notify.forget_subagent_notify(id);
    }
}

/// Options for the channel-aware spawn entry point.
#[derive(Clone)]
pub struct SpawnChannelOpts {
    pub project: ProjectRecord,
    pub worktree: Option<WorktreeRecord>,
    pub session: SessionRecord,
    pub mode_id: String,
    pub prompt: Option<String>,
    pub daemon_port: u16,
    pub skip_auto_turn: bool,
}

/// Options for the low-level `spawn_session` orchestration.
pub struct SpawnSessionOpts<'a> {
    pub project: &'a ProjectRecord,
    pub worktree: Option<&'a WorktreeRecord>,
    pub session: &'a SessionRecord,
    pub plugin: &'a dyn AgentPlugin,
    pub daemon_port: u16,
    pub system_prompt: String,
    pub task_prompt: Option<String>,
    pub model: Option<String>,
    pub tmux: &'a Tmux,
    pub direct_ptys: &'a std::sync::RwLock<HashMap<String, PtyHandle>>,
}

/// `spawnSession` / `spawnDirectSession` orchestration from `services/spawn.ts`.
/// Branches on `session.use_tmux`. Shared by worktree and direct sessions.
pub async fn spawn_session(opts: &SpawnSessionOpts<'_>) -> Result<(), String> {
    let ctx = resolved_context_of(opts.project.clone(), opts.worktree.cloned());
    let cwd = ctx.cwd.clone();

    let launch_cfg = LaunchConfig {
        project: opts.project.clone(),
        ctx: PluginContext {
            cwd: PathBuf::from(&cwd),
            project_id: opts.project.id.clone(),
            worktree: opts.worktree.cloned(),
        },
        session: opts.session.clone(),
        daemon_port: opts.daemon_port,
        model: opts.model.clone(),
    };

    let pre_spawn_chat_id = opts
        .plugin
        .provide_chat_id(CaptureArgs {
            session: opts.session,
            project: opts.project,
            cwd: &cwd,
            worktree: None,
        })
        .await;
    if let Some(id) = pre_spawn_chat_id {
        // The session record is immutable here; the caller persists chat ids
        // via the plugin's own capture path on the post-ready side.
        let _ = id;
    }

    let data_dir = session_data_dir_for(&ctx, &opts.session.id);
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let prompt_file = system_prompt_path_for(&ctx, &opts.session.id);
    std::fs::write(&prompt_file, &opts.system_prompt).map_err(|e| e.to_string())?;

    let composed = opts
        .plugin
        .compose_launch_prompt(vst_agents::plugin::ComposePromptInput {
            system_prompt: opts.system_prompt.clone(),
            task_prompt: opts.task_prompt.clone(),
            session_id: opts.session.id.clone(),
            system_prompt_file: prompt_file,
            launch_cfg: launch_cfg.clone(),
        });

    let mut base_env: HashMap<String, String> = build_vst_env(&BuildVstEnvOptions {
        project: opts.project.clone(),
        worktree: opts.worktree.cloned(),
        session: opts.session.clone(),
        daemon_port: opts.daemon_port,
    });
    for (k, v) in opts.plugin.get_environment(&launch_cfg) {
        base_env.insert(k, v);
    }

    let command_parts: Vec<String> = if composed.use_shell && composed.shell_line.is_some() {
        vec![
            "sh".to_string(),
            "-lc".to_string(),
            composed.shell_line.clone().unwrap(),
        ]
    } else {
        let mut parts = opts.plugin.get_launch_command(&launch_cfg);
        if let Some(args) = &composed.launch_args {
            parts.extend(args.iter().cloned());
        }
        parts
    };

    let ready = opts.plugin.get_ready_signal();

    if !opts.session.use_tmux {
        let command = command_parts.first().cloned().unwrap_or_default();
        let args = if command_parts.len() > 1 {
            command_parts[1..].to_vec()
        } else {
            vec![]
        };
        let stream = spawn_child(SpawnChildOptions {
            command,
            args,
            cwd: PathBuf::from(&cwd),
            env: base_env,
            cols: 80,
            rows: 24,
            session_id: opts.session.id.clone(),
            project_id: opts.project.id.clone(),
            worktree_id: opts.worktree.map(|w| w.id.clone()),
        })
        .map_err(|e| e.to_string())?;
        opts.direct_ptys
            .write()
            .unwrap()
            .insert(opts.session.id.clone(), stream.clone());
        if let Some(sentinel) = ready.sentinel {
            let ok = stream
                .wait_for_output(sentinel, Duration::from_millis(ready.fallback_ms))
                .await;
            if !ok {
                eprintln!(
                    "[spawn] Ready sentinel not found for {} ({}); proceeding anyway",
                    opts.session.id,
                    opts.plugin.name()
                );
            }
        } else {
            tokio::time::sleep(Duration::from_millis(ready.fallback_ms)).await;
        }
        if let Some(d) = opts.plugin.post_sentinel_delay_ms() {
            tokio::time::sleep(Duration::from_millis(d)).await;
        }
        if let Some(input) = &composed.post_launch_input {
            stream.write(input);
            if composed.post_launch_submit {
                stream.write("\r");
            }
        }
        return Ok(());
    }

    // Tmux path.
    opts.tmux
        .new_session(&NewSessionOptions {
            name: opts.session.tmux_name.clone(),
            cwd: Some(PathBuf::from(&cwd)),
            env: base_env,
            command: Some(command_parts),
        })
        .map_err(|e| e.to_string())?;

    if let Some(sentinel) = ready.sentinel {
        wait_for_sentinel(
            opts.tmux,
            &opts.session.tmux_name,
            sentinel,
            ready.fallback_ms,
        )
        .await;
    } else {
        tokio::time::sleep(Duration::from_millis(ready.fallback_ms)).await;
    }
    if let Some(d) = opts.plugin.post_sentinel_delay_ms() {
        tokio::time::sleep(Duration::from_millis(d)).await;
    }
    if let Some(input) = &composed.post_launch_input {
        if !opts.tmux.has_session(&opts.session.tmux_name) {
            eprintln!(
                "[spawn] Skipping post-launch prompt for {}: pane {} is gone",
                opts.session.id, opts.session.tmux_name
            );
            return Ok(());
        }
        let _ = opts.tmux.paste_buffer(
            &opts.session.tmux_name,
            &format!("vst-prompt-{}", opts.session.id),
            input.as_str(),
        );
        if composed.post_launch_submit {
            let _ = opts.tmux.send_keys(&opts.session.tmux_name, "", true);
        }
    }
    Ok(())
}

/// Poll a tmux pane for a ready sentinel (bounded; timeout is the caller's
/// fallback). Mirrors `waitForSentinel`.
async fn wait_for_sentinel(tmux: &Tmux, tmux_name: &str, sentinel: &str, timeout_ms: u64) {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let poll = Duration::from_millis(200);
    while std::time::Instant::now() < deadline {
        if !tmux.has_session(tmux_name) {
            return;
        }
        if let Ok(output) = tmux.capture_pane(
            tmux_name,
            &CapturePaneOptions {
                escape: false,
                lines: Some(50),
            },
        ) {
            if output.contains(sentinel) {
                return;
            }
        }
        tokio::time::sleep(poll).await;
    }
}

enum NameFallback {
    Direct(i64),
}

/// Derive a session's display name + source, mirroring the create handlers.
fn derive_name(
    provided: &Option<String>,
    r#type: SessionType,
    prompt: &Option<String>,
    fallback: NameFallback,
) -> (String, Option<SessionNameSource>) {
    if let Some(n) = provided.as_ref().filter(|n| !n.is_empty()) {
        return (n.clone(), Some(SessionNameSource::User));
    }
    if r#type == SessionType::Agent {
        if let Some(p) = prompt.as_deref().filter(|p| !p.is_empty()) {
            let slug = slugify_prompt(p);
            if !slug.is_empty() {
                return (slug, Some(SessionNameSource::Auto));
            }
        }
    }
    match fallback {
        NameFallback::Direct(seq) => {
            if r#type == SessionType::Terminal {
                (format!("Terminal {seq}"), None)
            } else {
                (format!("Direct {seq}"), None)
            }
        }
    }
}

fn draft_session_record(
    session_id: &str,
    project_id: &str,
    worktree_id: &Option<String>,
    r#type: SessionType,
    draft: &CreateDraftSessionBody,
) -> SessionRecord {
    let draft_config = draft
        .draft_config
        .as_ref()
        .and_then(|v| serde_json::from_value::<DraftConfig>(v.clone()).ok());
    SessionRecord {
        id: session_id.to_string(),
        worktree_id: worktree_id.clone(),
        project_id: project_id.to_string(),
        is_main: false,
        sort_order: ms_now() as f64,
        r#type,
        mode_id: None,
        name: None,
        name_source: None,
        tmux_name: format!("__draft__-{session_id}"),
        use_tmux: false,
        channel: Some(Channel::Json),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Drafting,
            reason: None,
            last_transition_at: now_iso(),
        },
        transcript_ref: None,
        draft_prompt: draft.draft_prompt.clone(),
        draft_config,
        archived_at: None,
        handoff_summary: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    }
}

fn transcript_ref_for_direct(
    project_id: String,
    session_id: &str,
    is_json: bool,
) -> Option<TranscriptRef> {
    if !is_json {
        return None;
    }
    let dir = Paths::default().direct_session_data_dir(&project_id, session_id);
    Some(TranscriptRef {
        kind: TranscriptKind::VstJson,
        path: Some(format!("{}/messages.jsonl", dir.display())),
    })
}

fn transcript_ref_for_worktree(
    project_id: String,
    worktree_id: &str,
    session_id: &str,
    is_json: bool,
) -> Option<TranscriptRef> {
    if !is_json {
        return None;
    }
    let dir = Paths::default().session_data_dir(&project_id, worktree_id, session_id);
    Some(TranscriptRef {
        kind: TranscriptKind::VstJson,
        path: Some(format!("{}/messages.jsonl", dir.display())),
    })
}

fn session_type_str(t: SessionType) -> &'static str {
    match t {
        SessionType::Agent => "agent",
        SessionType::Terminal => "terminal",
    }
}

fn cli_name(cli: vst_types::CliId) -> &'static str {
    match cli {
        vst_types::CliId::Claude => "claude",
        vst_types::CliId::Cursor => "cursor",
        vst_types::CliId::Opencode => "opencode",
        vst_types::CliId::Agy => "agy",
    }
}

/// Map a live JSON agent's `NormalizedEventProvider` back to a `CliId` for the
/// resume mode-fallback (the two enums share the same four variants).
fn provider_to_cli(p: NormalizedEventProvider) -> CliId {
    match p {
        NormalizedEventProvider::Claude => CliId::Claude,
        NormalizedEventProvider::Cursor => CliId::Cursor,
        NormalizedEventProvider::Opencode => CliId::Opencode,
        NormalizedEventProvider::Agy => CliId::Agy,
    }
}

/// A fresh one-off handoff path for a call (Decision 3) — the pasted
/// instruction and the poll loop must name the same path.
fn handoff_path_for(session_id: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("vst-handoff-{session_id}-{nanos}.md"))
}

/// The instruction pasted to the agent, naming the path it must write the
/// summary to (mirrors `handoffInstruction` in services/handoff.ts).
fn handoff_instruction(path: &std::path::Path) -> String {
    format!(
        "Before this session ends, write a concise handoff summary of the current state, remaining work, and anything the next session should know to `{}`, then reply once done.",
        path.display()
    )
}

fn now_iso() -> String {
    format!("{}", ms_now())
}

fn ms_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Error for create-session handlers, mapping to HTTP status at the wiring layer.
#[derive(Debug)]
pub enum CreateError {
    Validation(String),
    NotFound(String),
    Internal(String),
}

fn create_err(e: vst_store::StoreError) -> CreateError {
    CreateError::Internal(e.to_string())
}

/// Outcome of a `DELETE /sessions/:id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteResult {
    /// Set when the delete promoted a sibling session to main.
    pub promoted_session_id: Option<String>,
}

/// Error for `DELETE /sessions/:id`, mapping to HTTP status at the wiring layer.
#[derive(Debug)]
pub enum DeleteError {
    NotFound(String),
    NoEligibleSibling(String),
    Internal(String),
}

fn delete_err(e: vst_store::StoreError) -> DeleteError {
    DeleteError::Internal(e.to_string())
}

/// Outcome of a `PATCH /sessions/:id/draft`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftPatchResult {
    pub ok: bool,
    pub name: Option<String>,
}

/// Error for `PATCH /sessions/:id/draft`.
#[derive(Debug)]
pub enum DraftError {
    NotFound(String),
    NotDrafting(String),
    Internal(String),
}

/// Error for `POST /sessions/:id/start`.
#[derive(Debug)]
pub enum StartError {
    NotFound(String),
    NotDrafting(String),
    Validation(String),
    Internal(String),
}

/// Error for the pin/rename/reorder/delink handlers.
#[derive(Debug)]
pub enum MutateError {
    NotFound(String),
    Archived(String),
    Internal(String),
}

/// Flatten a `MutateError` into a generic internal error string.
fn mutate_err_str(e: MutateError) -> String {
    match e {
        MutateError::NotFound(m) => m,
        MutateError::Archived(m) => m,
        MutateError::Internal(m) => m,
    }
}

/// `POST /sessions/:id/done` success — `{ ok: true }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoneResult {
    pub ok: bool,
}

/// Error for `POST /sessions/:id/done`.
#[derive(Debug)]
pub enum DoneError {
    NotFound(String),
    NotAgent(String),
    Internal(String),
}

/// Error for `POST /sessions/:id/resume`.
#[derive(Debug)]
pub enum ResumeError {
    NotFound(String),
    NotRunning(String),
    Archived(String),
    Internal(String),
}

/// Error for `POST /sessions/:id/reset`.
#[derive(Debug)]
pub enum ResetError {
    NotFound(String),
    NotAgent(String),
    Archived(String),
    NoMode(String),
    ModeNotFound(String),
    Internal(String),
}

/// Error for `POST /sessions/:id/handoff`.
#[derive(Debug)]
pub enum HandoffRouteError {
    NotFound(String),
    NotAgent(String),
    Internal(String),
}

/// `{ ok: true }` — success body shared by `/send`, `/stop`, and
/// `DELETE .../queue/:turnId`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatActionResult {
    pub ok: bool,
}

/// Error for the Group C chat/send/queue handlers, mapping to HTTP status at
/// the wiring layer.
#[derive(Debug)]
pub enum ChatRouteError {
    /// 404 — session not found / not a JSON session.
    NotFound(String),
    /// 400 — session is archived (read-only).
    Archived(String),
    /// 400 — an attachment id didn't resolve.
    AttachmentNotFound(String),
    /// 400 — attachments given to a non-json session.
    AttachmentsRequireJson(String),
    /// 409 — tmux/pty target with no live stream.
    NotRunning(String),
    /// 409 — `stop` with no JSON agent ever run.
    NoActiveTurn(String),
    /// 400 — `resolve_json_agent` found the session but it isn't json-channel.
    NotJson(String),
    /// 404 — `DELETE .../queue/:turnId` target not queued.
    TurnNotFound(String),
    /// 404 — resubmit target isn't held.
    NotEditing(String),
    /// 404 — edit/promote target not queued.
    TurnNotQueued(String),
    /// 400 — model not in the CLI's available list.
    UnknownModel(String),
    /// 409 — model switch on a `done` session.
    Done(String),
    /// 500 — internal failure.
    Internal(String),
}

/// Error for `PATCH /sessions/:id/channel`.
#[derive(Debug)]
pub enum ChannelError {
    /// 404 — session not found.
    NotFound(String),
    /// 400 — non-agent session.
    NotAgent(String),
    /// 409 — JSON session has an active turn or queued turns.
    NotIdle,
    /// 500 — internal failure.
    Internal(String),
}

/// Query parameters for `GET /sessions/:id/transcript`.
#[derive(Debug, Clone, Default)]
pub struct TranscriptQuery {
    pub before_seq: Option<String>,
    pub limit: Option<String>,
    pub since: Option<String>,
    pub all: Option<String>,
}

/// Result envelope for `GET /sessions/:id/transcript`.
#[derive(Debug, Clone, PartialEq)]
pub enum TranscriptResponse {
    All(AllEvents),
    Since(SincePage),
    Page(TranscriptPage),
}

/// Error for `GET /sessions/:id/transcript` and `GET /sessions/:id/meta`.
#[derive(Debug)]
pub enum TranscriptError {
    /// 404 — session not found.
    NotFound(String),
    /// 404 — session exists but is not a Rich Chat (json) session.
    NotJson(String),
    /// 400 — query validation failed (e.g. invalid sequence number or limit).
    InvalidQuery(String),
    /// 500 — internal failure.
    Internal(String),
}

impl ChatRouteError {
    /// Map a `resolve_json_agent` error to the route's status. Mirrors the TS
    /// `reason === "not_found" ? 404 : 400` mapping (mode-resolution failures
    /// are thrown in TS and surface as 500 via the try/catch).
    fn from_enqueue(e: ResolveJsonAgentError) -> ChatRouteError {
        match e {
            ResolveJsonAgentError::NotFound { session_id } => {
                ChatRouteError::NotFound(format!("Session '{session_id}' not found"))
            }
            ResolveJsonAgentError::NotJson { session_id } => {
                ChatRouteError::NotJson(format!("Session '{session_id}' is not a JSON session"))
            }
            ResolveJsonAgentError::ModeError(m) => ChatRouteError::Internal(m),
        }
    }
}

/// The in-lock delete decision communicated out of the `mutate_project`
/// callback. `GenuineError` is the default and maps to 500.
enum DeleteDecision {
    GenuineError,
    Promoted {
        promoted_id: String,
        promoted_pr: Option<PrStatus>,
    },
    SessionGone,
    NoSibling,
}

/// Adapt a `PtyHandle` (which has an inherent `kill`) to the `PtyKill` trait
/// `release_session_runtime` needs. Kept local to vst-routes (cross-part gap:
/// `PtyHandle` doesn't yet impl `PtyKill`).
struct PtyHandleKill(PtyHandle);

impl PtyKill for PtyHandleKill {
    fn kill(&self) {
        self.0.kill();
    }
}

/// Best-effort `rm -rf` of a worktree session's data dir (mirrors
/// `cleanupSessionDataDir`).
fn cleanup_session_data_dir(project_id: &str, worktree_id: &str, session_id: &str) {
    let dir = Paths::default().session_data_dir(project_id, worktree_id, session_id);
    let _ = std::fs::remove_dir_all(dir);
}

/// Best-effort `rm -rf` of a direct session's data dir (mirrors
/// `cleanupDirectSessionDataDir`).
fn cleanup_direct_session_data_dir(project_id: &str, session_id: &str) {
    let dir = Paths::default().direct_session_data_dir(project_id, session_id);
    let _ = std::fs::remove_dir_all(dir);
}

/// Serialize a `WorktreeRecord` to the REST wire shape as a JSON map (for the
/// `worktree:created` broadcast). `mainSessionId` is computed from the
/// worktree's (already-persisted) sessions — see AGENTS.md's draft-promotion
/// note: never serialize the pre-mutation `sessions: []` object.
fn serialize_worktree_json(
    project_id: &str,
    w: &WorktreeRecord,
) -> serde_json::Map<String, serde_json::Value> {
    let main_session_id = w.sessions.iter().find(|s| s.is_main).map(|s| s.id.clone());
    let worktree = vst_types::rest::shared::Worktree {
        id: w.id.clone(),
        project_id: project_id.to_string(),
        name: w.name.clone(),
        branch: w.branch.clone(),
        branch_is_placeholder: w.branch_is_placeholder.unwrap_or(false),
        base_branch: w.base_branch.clone(),
        base_sha: w.base_sha.clone(),
        created_at: w.created_at.clone(),
        pinned_at: w.pinned_at.clone(),
        hidden_at: w.hidden_at.clone(),
        sort_order: w.sort_order,
        main_session_id,
    };
    serde_json::to_value(worktree)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// String form of a `DraftEntryPoint` for error messages.
fn entry_point_str(e: DraftEntryPoint) -> &'static str {
    match e {
        DraftEntryPoint::Worktree => "worktree",
        DraftEntryPoint::Direct => "direct",
        DraftEntryPoint::Tab => "tab",
        DraftEntryPoint::Global => "global",
    }
}

/// Group a JSON transcript's text events by turn, joining consecutive turns
/// with a blank line. Mirrors the `GET /sessions/:id/output` json branch.
pub fn group_json_output(events: &[vst_types::NormalizedEvent]) -> String {
    let mut turns: Vec<String> = Vec::new();
    let mut current_turn: Option<String> = None;
    let mut buf = String::new();
    for e in events {
        let text = e.text.as_deref().unwrap_or("");
        if e.kind != NormalizedEventKind::Text || text.is_empty() {
            continue;
        }
        if e.turn_id != current_turn {
            if !buf.is_empty() {
                turns.push(std::mem::take(&mut buf));
            }
            current_turn = e.turn_id.clone();
        }
        buf.push_str(text);
    }
    if !buf.is_empty() {
        turns.push(buf);
    }
    turns.join("\n\n")
}
