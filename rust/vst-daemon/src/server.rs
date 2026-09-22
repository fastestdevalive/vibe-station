#![forbid(unsafe_code)]

//! Server assembly, Axum routing, auth & loopback middleware, static file serving, and WebSocket upgrade.
//! Ports `daemon/src/server.ts` and `daemon/src/ws/server.ts`.

use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tower_http::cors::{AllowOrigin, CorsLayer};

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_lifecycle::subagent_notify::{NotifyDeps, PillPayload, SessionLookup, SubagentNotifyHandle};
use vst_proc::tmux::Tmux;
use vst_routes::attachments::{
    AttachmentRouteError, AttachmentRoutes, UploadPart, MAX_BODY_BYTES, MAX_FILE_BYTES,
};
use vst_routes::auth::{
    extract_token_id_from_auth, parse_cookie_value, verify_token, AuthRouteError, AuthRoutes,
    AuthState, PersistEpochFn, COOKIE_NAME,
};
use vst_routes::fs::FsRoutes;
use vst_routes::health::HealthRoutes;
use vst_routes::mobile_auth::{MobileAuthRouteError, MobileAuthRoutes, OneTimeCodeStore};
use vst_routes::modes::{json_unsupported_cli, ModeRouteError, ModeRoutes};
use vst_routes::open::{OpenRouteError, OpenRoutes};
use vst_routes::ordered_lists::OrderedListsRoutes;
use vst_routes::projects::{ProjectRouteError, ProjectRoutes};
use vst_routes::sessions::{
    ChannelError, ChatRouteError, CreateError, DeleteError, DoneError, DraftError,
    HandoffRouteError, MutateError, ResetError, ResumeError, SessionRoutes, StartError,
    TranscriptError, TranscriptQuery, TranscriptResponse,
};
use vst_routes::settings::{SettingsRouteError, SettingsRoutes};
use vst_routes::skills::SkillsRoutes;
use vst_routes::tailscale::{TailscaleRouteError, TailscaleRoutes};
use vst_routes::worktrees::{DiffResponse, FileResponse, WorktreeRouteError, WorktreeRoutes};
use vst_store::StoreHandle;
use vst_types::domain::{TokenPayload, TokenScope, VerifyResult};
use vst_types::events::Broadcaster;
use vst_types::rest::attachments::{AttachmentsResult, DeleteAttachmentResult};
use vst_types::rest::auth::{AuthSessionsResult, OkResult, RevokeBrowserResult};
use vst_types::rest::modes::{
    CliModels, CreateModeBody, DeleteModeResult, SupportedCli, UpdateModeBody,
};
use vst_types::rest::open::{OpenBody, OpenResult};
use vst_types::rest::ordered_lists::{OrderedList, PutOrderedListBody, PutOrderedListResult};
use vst_types::rest::projects::{
    BranchesResult, CreateNewProjectBody, CreateNewProjectResult, CreateProjectBody,
    PatchProjectBody, PatchProjectResult, TreeEntry,
};
use vst_types::rest::sessions::{
    ChatBody, DelinkResult, EditQueuedResult, EnqueueChatResult, HandoffResult, InputBody,
    PatchChannelBody, PatchChannelResult, PatchDraftBody, PatchModelBody, PatchModelResult,
    PinBody, PinResult, RenameSessionBody, RenameSessionResult, ReorderSessionBody,
    ReorderSessionResult, ResetBody, ResubmitBody, SessionListItem, SessionOrDraft, SessionOutput,
    StartDraftBody, StartDraftResult, TurnActionResult,
};
use vst_types::rest::settings::{PatchSettingsBody, PatchSettingsResult, Settings};
use vst_types::rest::shared::{Mode, Project, Worktree};
use vst_types::rest::skills::SkillsResult;
use vst_types::rest::tailscale::{
    TailscaleQr, TailscaleServeDisableResult, TailscaleServeEnableResult, TailscaleStatus,
    TailscaleUpResult,
};
use vst_types::rest::worktrees::{
    ChangedPath, CommitsResult, CreateWorktreeBody, DiffStat, DiskUsage, FileListResult,
    FileSearchResult, OpenFileBody, PatchWorktreeResult, PatchWorktreeToggleBody, PrLookupResult,
    RenameWorktreeBody, RenameWorktreeResult, ReorderWorktreeBody, ReorderWorktreeResult,
    SearchResult, SubmodulesResult, WorktreeDoneResult,
};
use vst_types::ws::ClientMessage;
use vst_ws::broadcaster::{close_auth_expired, spawn_event_fanout, WsHub};
use vst_ws::connection::{WsConnection, WsSink};
use vst_ws::handlers::file_watch::{release_connection_file_watches, WatcherRegistry};
use vst_ws::handlers::session_open::DirectStreamRegistry;
use vst_ws::handlers::tree_watch::release_connection_tree_watches;
use vst_ws::server::{dispatch, send_parse_error, DispatchContext};

/// Options to build the Axum web application.
#[derive(Clone)]
pub struct BuildServerOptions {
    pub port: u16,
    pub auth_state: Option<AuthState>,
    pub no_auth: bool,
    pub dist_path: Option<PathBuf>,
    pub persist_epoch: Option<PersistEpochFn>,
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
    pub json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
    pub tmux: Tmux,
    pub started_at: Instant,
    pub version: String,
    pub paths: Paths,
}

/// Shared application state accessible to Axum request handlers and middleware.
#[derive(Clone)]
pub struct AppState {
    pub port: u16,
    pub auth_state: Option<AuthState>,
    pub no_auth: bool,
    pub dist_path: Option<PathBuf>,
    pub persist_epoch: Option<PersistEpochFn>,
    pub store: StoreHandle,
    pub broadcaster: Broadcaster,
    pub json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
    pub tmux: Tmux,
    pub started_at: Instant,
    pub version: String,
    pub paths: Paths,
    pub ws_hub: Arc<WsHub>,
    pub code_store: OneTimeCodeStore,

    // Routes
    pub health_routes: HealthRoutes,
    pub open_routes: OpenRoutes,
    pub project_routes: ProjectRoutes,
    pub worktree_routes: WorktreeRoutes,
    pub session_routes: SessionRoutes,
    pub attachment_routes: AttachmentRoutes,
    pub mode_routes: ModeRoutes,
    pub settings_routes: SettingsRoutes,
    pub skills_routes: SkillsRoutes,
    pub ordered_lists_routes: OrderedListsRoutes,
    pub fs_routes: FsRoutes,
    pub auth_routes: Option<AuthRoutes>,
    pub mobile_auth_routes: MobileAuthRoutes,
    pub tailscale_routes: TailscaleRoutes,

    // Dispatch context for WS
    pub dispatch_ctx: DispatchContext,
}

/// Implementation of `vst_ws::connection::WsSink` over Axum's `WebSocket`.
pub struct AxumWsSink {
    tx: mpsc::UnboundedSender<WsCommand>,
    buffered_amount: Arc<AtomicUsize>,
    ready_state: Arc<AtomicU8>,
    closed: Arc<std::sync::Mutex<Option<(u16, String)>>>,
}

pub(crate) enum WsCommand {
    Text(String),
    Ping,
    Close(u16, String),
}

impl AxumWsSink {
    pub(crate) fn new(
        tx: mpsc::UnboundedSender<WsCommand>,
        buffered_amount: Arc<AtomicUsize>,
        ready_state: Arc<AtomicU8>,
        closed: Arc<std::sync::Mutex<Option<(u16, String)>>>,
    ) -> Self {
        Self {
            tx,
            buffered_amount,
            ready_state,
            closed,
        }
    }
}

impl WsSink for AxumWsSink {
    fn ready_state(&self) -> u8 {
        self.ready_state.load(Ordering::SeqCst)
    }

    fn buffered_amount(&self) -> usize {
        self.buffered_amount.load(Ordering::SeqCst)
    }

    fn send_text(&self, text: String) {
        if self.ready_state() == 1 {
            let len = text.len();
            self.buffered_amount.fetch_add(len, Ordering::SeqCst);
            let _ = self.tx.send(WsCommand::Text(text));
        }
    }

    fn close(&self, code: u16, reason: &str) {
        if self.ready_state.swap(2, Ordering::SeqCst) == 1 {
            *self.closed.lock().unwrap() = Some((code, reason.to_string()));
            let _ = self.tx.send(WsCommand::Close(code, reason.to_string()));
        }
    }

    fn ping(&self) {
        if self.ready_state() == 1 {
            let _ = self.tx.send(WsCommand::Ping);
        }
    }

    fn closed_state(&self) -> Option<(u16, String)> {
        self.closed.lock().unwrap().clone()
    }
}

struct ProductionNotifyDeps {
    store: StoreHandle,
    json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
}

impl NotifyDeps for ProductionNotifyDeps {
    fn lookup(&self, id: &str) -> Option<SessionLookup> {
        let (_project, session) = self.store.find_session_cached(id)?;
        Some(SessionLookup {
            id: session.id,
            channel: session.channel.unwrap_or(vst_types::Channel::Tmux),
            parent_session_id: session.parent_session_id,
            name: session.name,
            archived_at: session.archived_at,
            superseded_by: session.superseded_by,
            lifecycle_state: Some(session.lifecycle.state),
        })
    }

    fn populate_notice_slot(&self, parent: &str, child_id: &str, child_name: &str) -> bool {
        if let Some(agent) = self.json_registry.get(parent) {
            agent.populate_notice_slot(child_id.to_string(), child_name.to_string())
        } else {
            false
        }
    }

    fn emit_pill(
        &self,
        parent: &str,
        payload: PillPayload,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        let agent = self.json_registry.get(parent);
        Box::pin(async move {
            if let Some(agent) = agent {
                agent.emit_system_event(vst_agents::json_agent_session::EmitSystemEventPayload {
                    subagent_id: payload.subagent_id,
                    subagent_name: payload.subagent_name,
                    subagent_state: payload.subagent_state,
                    text: payload.text,
                });
            }
        })
    }

    fn prune_notice_slot_child(&self, parent: &str, child: &str) {
        if let Some(agent) = self.json_registry.get(parent) {
            agent.prune_notice_slot_child(child);
        }
    }
}

fn spawn_subagent_notify_listener(
    handle: SubagentNotifyHandle,
    broadcaster: Broadcaster,
    deps: Arc<dyn NotifyDeps>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = broadcaster.subscribe();
        let mut last_states = std::collections::HashMap::<String, vst_types::LifecycleState>::new();
        loop {
            let event = match rx.recv().await {
                Ok(e) => e,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            match event {
                vst_types::events::ServerEvent::SessionState {
                    session_id,
                    state,
                    ..
                } => {
                    let prev = last_states
                        .get(&session_id)
                        .copied()
                        .unwrap_or(vst_types::LifecycleState::Working);
                    if prev != state {
                        last_states.insert(session_id.clone(), state);
                        handle.note_subagent_state_change(&session_id, prev, state, deps.as_ref());
                    }
                }
                vst_types::events::ServerEvent::SessionDeleted { session_id, .. } => {
                    last_states.remove(&session_id);
                    handle.forget_subagent_notify(&session_id);
                }
                _ => {}
            }
        }
    })
}

/// How often the auth-expiry sweep checks open WS connections for expired
/// tokens. A socket opened just before its token expired would otherwise stay
/// fully live (terminal/agent panes keep streaming) because the WS layer is
/// only authenticated at connect time. The sweep closes such sockets with the
/// same 4401 code as a revoke so the client drops to its login screen.
const AUTH_EXPIRY_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Spawn a background task that periodically walks open WS connections and
/// actively closes any whose token has passed `token_expires_at`, using the
/// shared auth-expired close codepath (`WsHub::close_expired_auth` →
/// `close_auth_expired`, code 4401). Runs for the lifetime of the process,
/// consistent with the other fan-out/listener tasks spawned in `build_state`.
fn spawn_auth_expiry_sweep(hub: Arc<WsHub>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(AUTH_EXPIRY_SWEEP_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let closed = hub.close_expired_auth(now_ms);
            if closed > 0 {
                tracing::info!("[auth] closed {closed} expired WS connection(s) with 4401");
            }
        }
    });
}

/// Build all of the daemon's shared application state — every service, route
/// handler bundle, the WS `DispatchContext`, and `WorktreeRoutes`.
///
/// Extracted from `build_app` so tests can obtain an `AppState` (and therefore
/// `dispatch_ctx`/`worktree_routes`) directly, which `build_app`'s
/// `.with_state(state)` otherwise consumes and never returns.
pub fn build_state(opts: BuildServerOptions) -> AppState {
    let ws_hub = Arc::new(WsHub::new());
    spawn_event_fanout(ws_hub.clone(), opts.broadcaster.clone());
    spawn_auth_expiry_sweep(ws_hub.clone());

    let code_store = OneTimeCodeStore::new();

    let health_routes = HealthRoutes::new(opts.version.clone(), opts.port as i64, opts.started_at);
    let open_routes = OpenRoutes::new(opts.store.clone(), opts.broadcaster.clone());
    let project_routes = ProjectRoutes::new(
        opts.store.clone(),
        opts.broadcaster.clone(),
        opts.json_registry.clone(),
        opts.tmux.clone(),
        opts.port,
    )
    .with_paths(opts.paths.clone());
    let worktree_routes = WorktreeRoutes::new(
        opts.store.clone(),
        opts.broadcaster.clone(),
        opts.json_registry.clone(),
        opts.tmux.clone(),
        opts.port,
    );
    let mut worktree_routes = worktree_routes;
    worktree_routes.paths = opts.paths.clone();

    let subagent_notify = vst_lifecycle::subagent_notify::SubagentNotifyHandle::new();
    let notify_deps: Arc<dyn NotifyDeps> = Arc::new(ProductionNotifyDeps {
        store: opts.store.clone(),
        json_registry: opts.json_registry.clone(),
    });
    subagent_notify.set_deps(notify_deps.clone());
    spawn_subagent_notify_listener(
        subagent_notify.clone(),
        opts.broadcaster.clone(),
        notify_deps,
    );
    let attachment_registry = vst_ws::state::attachment_registry::AttachmentRegistry::new();
    let json_unsupported = Arc::new(json_unsupported_cli);

    // Shared with the WS `DispatchContext` below (same `Arc`) — `spawn_terminal`
    // (and any other `use_tmux: false` spawn path) populates this from here, and
    // `session:open`'s WS handler reads it from there. Without sharing the SAME
    // instance, a plain ("useTmux" unchecked) terminal session can never attach.
    let direct_streams: DirectStreamRegistry =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

    let session_routes = SessionRoutes {
        store: opts.store.clone(),
        broadcaster: opts.broadcaster.clone(),
        json_registry: opts.json_registry.clone(),
        direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
        direct_streams: direct_streams.clone(),
        tmux: opts.tmux.clone(),
        daemon_port: opts.port,
        json_unsupported,
        subagent_notify,
        attachment_registry: attachment_registry.clone(),
    };

    let attachment_routes =
        AttachmentRoutes::new(opts.store.clone(), opts.paths.clone(), attachment_registry);
    let mode_routes = ModeRoutes::new(opts.store.clone(), opts.broadcaster.clone())
        .with_paths(opts.paths.clone());
    let settings_routes = SettingsRoutes::new(opts.paths.clone(), opts.broadcaster.clone());
    // Reads the shared skill catalog singleton (seeded from user settings at
    // startup, see `main.rs`'s "Skill catalog" block) — no path config here.
    let skills_routes = SkillsRoutes::new();
    let ordered_lists_routes =
        OrderedListsRoutes::new(opts.store.clone(), opts.broadcaster.clone());
    let fs_routes = FsRoutes::new();

    let auth_routes = if let Some(ref auth_state) = opts.auth_state {
        let persist = opts
            .persist_epoch
            .clone()
            .unwrap_or_else(|| Arc::new(|_| Box::pin(async { Ok(()) })));
        Some(AuthRoutes::new(auth_state.clone(), persist).with_ws_hub(ws_hub.clone()))
    } else {
        None
    };

    let mobile_auth_routes = MobileAuthRoutes::new(
        opts.auth_state.clone(),
        code_store.clone(),
        opts.port,
        opts.no_auth,
    )
    .with_store(opts.store.clone());

    let tailscale_routes = TailscaleRoutes::new(code_store.clone(), opts.port);

    let paths_for_ws = opts.paths.clone();
    let store_for_ws = opts.store.clone();
    let worktree_path_resolver = Arc::new(move |wt_id: &str| {
        let projects = futures::executor::block_on(store_for_ws.get_all_projects());
        for p in projects {
            for w in p.worktrees {
                if w.id == wt_id {
                    return Some(paths_for_ws.worktree_path(&p.id, &w.id));
                }
            }
        }
        None
    });

    let watchers: WatcherRegistry = Arc::new(std::sync::Mutex::new(Default::default()));

    let dispatch_ctx = DispatchContext {
        hub: ws_hub.clone(),
        store: opts.store.clone(),
        json_registry: opts.json_registry.clone(),
        broadcaster: opts.broadcaster.clone(),
        daemon_port: opts.port,
        // SAME `Arc` as `session_routes.direct_streams` above — see its comment.
        direct_streams: direct_streams.clone(),
        watchers,
        resolve_worktree_root: worktree_path_resolver,
        // SAME `Arc<FileSearchIndex>` as `worktree_routes.file_search` (Decision 4):
        // the WS layer (tree_watch's on_changed/on_deleted) and the HTTP layer
        // (WorktreeRoutes::file_search) must observe the same index instance.
        file_search: worktree_routes.file_search.clone(),
    };

    let state = AppState {
        port: opts.port,
        auth_state: opts.auth_state,
        no_auth: opts.no_auth,
        dist_path: opts.dist_path,
        persist_epoch: opts.persist_epoch,
        store: opts.store,
        broadcaster: opts.broadcaster,
        json_registry: opts.json_registry,
        tmux: opts.tmux,
        started_at: opts.started_at,
        version: opts.version,
        paths: opts.paths,
        ws_hub,
        code_store,
        health_routes,
        open_routes,
        project_routes,
        worktree_routes,
        session_routes,
        attachment_routes,
        mode_routes,
        settings_routes,
        skills_routes,
        ordered_lists_routes,
        fs_routes,
        auth_routes,
        mobile_auth_routes,
        tailscale_routes,
        dispatch_ctx,
    };

    state
}

/// Build the full Axum router.
pub fn build_app(opts: BuildServerOptions) -> Router {
    let state = build_state(opts);

    // CORS configuration: reflect origin (allow Any credentials), allow headers and methods
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::HEAD,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    // All REST API routes live under /api so every client — Tauri (absolute
    // URL), browser via Vite proxy (no rewrite needed), Tailscale/LAN/prod
    // (relative /api/…) — uses the same path convention without any
    // prefix-stripping tricks.
    let api = Router::new()
        // Open
        .route("/open", post(handle_open))
        // Projects
        .route(
            "/projects",
            get(handle_list_projects).post(handle_create_project),
        )
        .route("/projects/create", post(handle_create_new_project))
        .route("/projects/:id/branches", get(handle_list_project_branches))
        .route(
            "/projects/:id",
            patch(handle_patch_project).delete(handle_delete_project),
        )
        .route("/projects/:id/tree", get(handle_project_tree))
        .route("/projects/:id/file-list", get(handle_project_file_list))
        .route("/projects/:id/files/*path", get(handle_project_get_file))
        // Worktrees
        .route(
            "/worktrees",
            get(handle_list_worktrees).post(handle_create_worktree),
        )
        .route("/worktrees/disk-usage", get(handle_worktrees_disk_usage))
        .route("/worktrees/:id/pin", patch(handle_worktree_pin))
        .route("/worktrees/:id/hide", patch(handle_worktree_hide))
        .route("/worktrees/:id/rename", patch(handle_worktree_rename))
        .route("/worktrees/:id/reorder", patch(handle_worktree_reorder))
        .route("/worktrees/:id/done", post(handle_worktree_done))
        .route("/worktrees/:id", delete(handle_delete_worktree))
        .route("/worktrees/:id/tree", get(handle_worktree_tree))
        .route("/worktrees/:id/file-list", get(handle_worktree_file_list))
        .route("/worktrees/:id/search", get(handle_worktree_search))
        .route("/worktrees/:id/file-search", get(handle_worktree_file_search))
        .route("/worktrees/:id/files/*path", get(handle_worktree_get_file))
        .route("/worktrees/:id/gutter/*path", get(handle_worktree_gutter))
        .route("/worktrees/:id/diff/*path", get(handle_worktree_diff))
        .route(
            "/worktrees/:id/changed-paths",
            get(handle_worktree_changed_paths),
        )
        .route("/worktrees/:id/diffstat", get(handle_worktree_diffstat))
        .route("/worktrees/:id/commits", get(handle_worktree_commits))
        .route("/worktrees/:id/submodules", get(handle_worktree_submodules))
        .route("/worktrees/:id/pr", get(handle_worktree_pr))
        .route("/worktrees/:id/open-file", post(handle_worktree_open_file))
        .route(
            "/worktrees/:id/pending-file-opens",
            get(handle_worktree_get_pending_file_opens)
                .delete(handle_worktree_delete_pending_file_opens),
        )
        // Sessions
        .route(
            "/sessions",
            get(handle_list_sessions).post(handle_create_session),
        )
        .route(
            "/sessions/:id",
            get(handle_get_session).delete(handle_delete_session),
        )
        .route("/sessions/:id/output", get(handle_session_output))
        .route("/sessions/:id/draft", patch(handle_patch_session_draft))
        .route("/sessions/:id/start", post(handle_start_session))
        .route("/sessions/:id/pin", patch(handle_pin_session))
        .route("/sessions/:id/rename", patch(handle_rename_session))
        .route("/sessions/:id/reorder", patch(handle_reorder_session))
        .route("/sessions/:id/delink", patch(handle_delink_session))
        .route("/sessions/:id/done", post(handle_done_session))
        .route("/sessions/:id/resume", post(handle_resume_session))
        .route("/sessions/:id/reset", post(handle_reset_session))
        .route("/sessions/:id/handoff", post(handle_handoff_session))
        .route("/sessions/:id/send", post(handle_send_session))
        .route("/sessions/:id/chat", post(handle_chat_session))
        .route(
            "/sessions/:id/chat/dismiss-notice",
            post(handle_dismiss_notice),
        )
        .route(
            "/sessions/:id/chat/promote-notice",
            post(handle_promote_notice),
        )
        .route("/sessions/:id/chat/stop", post(handle_stop_active_turn))
        .route(
            "/sessions/:id/chat/queue/:turnId",
            delete(handle_cancel_queued_turn),
        )
        .route(
            "/sessions/:id/chat/queue/:turnId/edit",
            post(handle_edit_queued_turn),
        )
        .route(
            "/sessions/:id/chat/queue/:turnId/resubmit",
            post(handle_resubmit_queued_turn),
        )
        .route(
            "/sessions/:id/chat/queue/:turnId/promote",
            post(handle_promote_queued_turn),
        )
        .route("/sessions/:id/chat/model", patch(handle_patch_chat_model))
        .route("/sessions/:id/channel", patch(handle_patch_session_channel))
        .route(
            "/sessions/:id/transcript",
            get(handle_get_session_transcript),
        )
        .route("/sessions/:id/meta", get(handle_get_session_meta))
        // Attachments
        //
        // `route_layer` (not `layer`) so this only widens the limit for this
        // exact route, not the whole router. Without it, axum's `Multipart`
        // extractor applies its own DEFAULT_LIMIT (2 MiB, via
        // `RequestExt::with_limited_body`) BEFORE the handler ever runs,
        // regardless of the handler's own MAX_FILE_BYTES/MAX_BODY_BYTES
        // streaming checks below — so a 5 MB file (well under the intended
        // 20 MB per-file cap) would 400 with a generic "invalid multipart
        // body" error, never reaching this handler's own 413 messaging.
        // Sized to MAX_BODY_BYTES (25 MB), the same overall cap the handler
        // already enforces.
        .route(
            "/sessions/:id/attachments",
            post(handle_upload_attachments)
                .route_layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES)),
        )
        .route(
            "/sessions/:id/attachments/:uploadId",
            delete(handle_delete_attachment),
        )
        // Modes
        .route("/supported-clis", get(handle_supported_clis))
        .route("/cli-models", get(handle_cli_models))
        .route("/modes", get(handle_get_modes).post(handle_create_mode))
        .route(
            "/modes/:id",
            put(handle_update_mode).delete(handle_delete_mode),
        )
        // Settings
        .route(
            "/settings",
            get(handle_get_settings).patch(handle_patch_settings),
        )
        // Skills
        .route("/skills", get(handle_get_skills))
        // Ordered lists
        .route(
            "/user/ordered-lists/:scopeKey",
            get(handle_get_ordered_list).put(handle_put_ordered_list),
        )
        // Filesystem
        .route("/fs/check", get(handle_fs_check))
        .route("/fs/complete", get(handle_fs_complete))
        // Auth
        .route("/auth/check", get(handle_auth_check))
        .route("/auth/logout", post(handle_auth_logout))
        .route("/auth/sessions", get(handle_auth_sessions))
        .route(
            "/auth/sessions/:id/revoke",
            post(handle_auth_revoke_session),
        )
        .route("/auth/revoke-browser", post(handle_auth_revoke_browser))
        // Mobile Auth & Tunnel
        .route("/auth/tunnel/enable", post(handle_auth_tunnel_enable))
        .route("/auth/tunnel/disable", post(handle_auth_tunnel_disable))
        .route("/auth/tunnel/status", get(handle_auth_tunnel_status))
        .route("/auth/local-qr", post(handle_auth_local_qr))
        .route("/auth/mobile-qr", post(handle_auth_mobile_qr))
        // Tailscale
        .route("/tailscale/status", get(handle_tailscale_status))
        .route(
            "/tailscale/serve/enable",
            post(handle_tailscale_serve_enable),
        )
        .route(
            "/tailscale/serve/disable",
            post(handle_tailscale_serve_disable),
        )
        .route("/tailscale/up", post(handle_tailscale_up))
        .route("/tailscale/qr", get(handle_tailscale_qr));

    Router::new()
        // Utility & protocol routes stay at root (not under /api)
        .route("/health", get(handle_health))
        .route("/mobile-auth", get(handle_mobile_auth))
        .route("/ws", get(handle_ws_upgrade))
        // All REST API routes under /api
        .nest("/api", api)
        // Fallback for static SPA / dist
        .fallback(handle_fallback)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(cors)
        .with_state(state)
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────────────────────────────────────

async fn auth_middleware(
    State(state): State<AppState>,
    req: Request,
    next: axum::middleware::Next,
) -> Response {
    let mut req = req;
    let original_uri = req.uri().clone();
    let mut path = original_uri.path().to_string();

    // Vite dev proxy compatibility: rewrite /api/* -> /*
    if path.starts_with("/api/") {
        path = path[4..].to_string();
    } else if path == "/api" {
        path = "/".to_string();
    }

    if path != original_uri.path() {
        let mut parts = original_uri.into_parts();
        let query_str = parts.path_and_query.as_ref().and_then(|pq| pq.query());
        let new_pq = if let Some(q) = query_str {
            format!("{path}?{q}")
        } else {
            path.to_string()
        };
        if let Ok(pq) = new_pq.parse() {
            parts.path_and_query = Some(pq);
            if let Ok(uri) = Uri::from_parts(parts) {
                *req.uri_mut() = uri;
            }
        }
    }

    let method = req.method().clone();
    let headers = req.headers().clone();

    if state.no_auth || state.auth_state.is_none() {
        return next.run(req).await;
    }

    let auth_state = state.auth_state.as_ref().unwrap();

    // Determine client IP (trusting loopback proxy headers)
    let via_tunnel = headers.contains_key("cf-connecting-ip");
    let connect_info = req.extensions().get::<ConnectInfo<SocketAddr>>().copied();
    let peer_ip = connect_info.map(|ci| ci.0.ip());

    let client_ip = if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
    {
        // If TCP peer is loopback, trust rightmost trusted hop from X-Forwarded-For
        if peer_ip.map_or(false, |ip| ip.is_loopback()) {
            xff.split(',').next_back().unwrap_or("").trim().to_string()
        } else {
            peer_ip.map_or("".to_string(), |ip| ip.to_string())
        }
    } else {
        peer_ip.map_or("".to_string(), |ip| ip.to_string())
    };

    let is_loopback = !via_tunnel
        && (client_ip == "127.0.0.1"
            || client_ip == "::1"
            || client_ip == "::ffff:127.0.0.1"
            || client_ip.is_empty()); // empty peer in unit test mock defaults to loopback

    if is_loopback {
        // CSRF guard: if Origin header present, must match localhost / 127.0.0.1 or tauri://
        if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            let is_localhost = origin.starts_with("http://localhost")
                || origin.starts_with("https://localhost")
                || origin.starts_with("http://127.0.0.1")
                || origin.starts_with("https://127.0.0.1");
            let is_tauri = origin == "tauri://localhost"
                || origin == "http://tauri.localhost"
                || origin == "https://tauri.localhost";
            if !is_localhost && !is_tauri {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({ "error": "Forbidden." })),
                )
                    .into_response();
            }
        }

        // Attach TokenPayload if token is present
        let auth_hdr = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());
        let cookie_hdr = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
        let raw_token = if let Some(auth) = auth_hdr {
            if let Some(b) = auth.strip_prefix("Bearer ") {
                b.trim()
            } else {
                ""
            }
        } else if let Some(cookie) = cookie_hdr {
            parse_cookie_value(cookie, COOKIE_NAME)
                .unwrap_or_default()
                .leak()
        } else {
            ""
        };

        if !raw_token.is_empty() {
            if let VerifyResult::Ok { payload } = verify_token(raw_token, auth_state) {
                req.extensions_mut().insert(payload);
            }
        }

        return next.run(req).await;
    }

    // Exempt routes (health, ws, mobile-auth stay at root; auth/logout is under /api)
    let key = format!("{} {}", method, path);
    if key == "GET /health"
        || key == "GET /ws"
        || key == "POST /api/auth/logout"
        || key == "GET /mobile-auth"
    {
        return next.run(req).await;
    }

    // Static assets / fallback
    if method == Method::GET
        && (path.starts_with("/assets/") || path == "/" || path == "/index.html")
    {
        return next.run(req).await;
    }

    // Non-loopback request: verify token
    let auth_hdr = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let cookie_hdr = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let raw_token = if let Some(auth) = auth_hdr {
        if let Some(b) = auth.strip_prefix("Bearer ") {
            b.trim()
        } else {
            ""
        }
    } else if let Some(cookie) = cookie_hdr {
        parse_cookie_value(cookie, COOKIE_NAME)
            .unwrap_or_default()
            .leak()
    } else {
        ""
    };

    if raw_token.is_empty() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Not authenticated." })),
        )
            .into_response();
    }

    match verify_token(raw_token, auth_state) {
        VerifyResult::Ok { payload } => {
            req.extensions_mut().insert(payload);
            next.run(req).await
        }
        VerifyResult::Err { .. } => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Not authenticated." })),
        )
            .into_response(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Upgrade & Dispatch
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    req: Request,
) -> Response {
    let auth_state = state.auth_state.clone();
    let no_auth = state.no_auth;

    // WebSocket authentication gate
    let mut scope = None;
    let mut token_id = None;
    let mut token_issued_at = None;
    let mut token_expires_at = None;
    // True when a non-loopback request presented a missing/invalid/expired
    // token. We still accept the upgrade, but immediately close the new socket
    // with the auth-expired code (4401) instead of returning a bare HTTP 401:
    // the browser sees a 401-before-upgrade as close code 1006, which the
    // client treats as an ordinary disconnect and reconnects forever. This is
    // the common remote-session path (token expires while the socket is down,
    // then the client reconnects and hits this gate), so it must emit 4401 so
    // the client shows the login screen instead of looping.
    let mut auth_rejected = false;

    if let Some(ref auth_state) = auth_state {
        if !no_auth {
            let via_tunnel = headers.contains_key("cf-connecting-ip");
            let connect_info = req.extensions().get::<ConnectInfo<SocketAddr>>().copied();
            let peer_ip = connect_info.map(|ci| ci.0.ip());
            let is_loopback = !via_tunnel && peer_ip.map_or(true, |ip| ip.is_loopback());

            let auth_hdr = headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok());
            let cookie_hdr = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
            let raw_token = if let Some(auth) = auth_hdr {
                if let Some(b) = auth.strip_prefix("Bearer ") {
                    b.trim()
                } else {
                    ""
                }
            } else if let Some(cookie) = cookie_hdr {
                parse_cookie_value(cookie, COOKIE_NAME)
                    .unwrap_or_default()
                    .leak()
            } else if let Some(ref q) = query.token {
                q.as_str()
            } else {
                ""
            };

            if !raw_token.is_empty() {
                if let VerifyResult::Ok { payload } = verify_token(raw_token, auth_state) {
                    scope = Some(payload.scope);
                    token_issued_at = Some(payload.iat);
                    token_expires_at = payload.exp;
                    if let Some(dot) = raw_token.rfind('.') {
                        token_id = Some(raw_token[..dot].to_string());
                    }
                } else if !is_loopback {
                    auth_rejected = true;
                }
            } else if !is_loopback {
                auth_rejected = true;
            }
        }
    }

    let dispatch_ctx = state.dispatch_ctx.clone();
    let open_routes = state.open_routes.clone();

    ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            dispatch_ctx,
            open_routes,
            scope,
            token_id,
            token_issued_at,
            token_expires_at,
            auth_rejected,
        )
    })
}

/// Queue depth per dispatch lane. Bounded on purpose: the read loop `await`s a
/// full lane, which throttles a client flooding one session instead of letting
/// it queue without limit in daemon memory. No lane worker depends on the read
/// loop making progress, so parking there cannot deadlock.
const LANE_QUEUE_CAP: usize = 256;

/// Hard cap on lanes per connection. Lane keys come from CLIENT-supplied
/// session ids and lanes are created before any lookup, so without a cap a
/// client could spin up a task + channel per garbage id it invents. Legitimate
/// use is bounded by the sessions in a worktree, orders of magnitude below this.
const MAX_LANES_PER_CONNECTION: usize = 256;

/// How long connection teardown waits for its lanes to drain before giving up
/// on them. A bounded race is better than an unbounded hang: without this, a
/// client that floods a lane and then disconnects could delay `conn.cleanup()`
/// — and therefore the `detach()` that kills this connection's
/// `tmux attach-session` clients — indefinitely, which is the phantom-client
/// leak class commit 6fcad49 fixed. On expiry the stragglers are aborted so
/// cleanup can proceed deterministically.
const LANE_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// One ordered dispatch worker for a connection: a bounded queue plus the task
/// draining it, so messages on the same lane are still handled strictly in
/// arrival order while different lanes progress independently.
struct DispatchLane {
    tx: mpsc::Sender<ClientMessage>,
    handle: tokio::task::JoinHandle<()>,
}

impl DispatchLane {
    fn spawn(conn: WsConnection, ctx: DispatchContext) -> Self {
        let (tx, mut rx) = mpsc::channel::<ClientMessage>(LANE_QUEUE_CAP);
        let handle = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                dispatch(&conn, &ctx, &msg).await;
            }
        });
        DispatchLane { tx, handle }
    }
}

/// The ordering lane a message belongs to, or `None` for message types handled
/// inline on the read loop.
///
/// Anything that can block (a tmux attach, a SQLite read, an inotify
/// registration) gets a lane keyed by the thing it actually contends for, so
/// unrelated work never queues behind it:
///
/// - `session:*` → one lane per session id. This is the close/open ordering
///   `WsConnection::with_session_lock` depends on, and it also keeps a
///   session's `input`/`resize` behind its own `open`.
/// - `chat:*` → a SEPARATE lane per session id (`chat:` prefix). Chat
///   open/close must not reorder against each other, but a chat snapshot read
///   has no interaction with that session's terminal attach, so the two run
///   concurrently.
/// - watcher messages → a single lane per connection. `file:`/`tree:`
///   watch/unwatch are refcounted per watch key, so a `watch` must never
///   overtake the `unwatch` that preceded it; one shared lane keeps all of them
///   ordered without blocking any session.
/// - everything else (`subscribe`/`unsubscribe`/`ping`/`debug:log`) → `None`:
///   their handlers are synchronous, so the read loop runs them itself.
///
/// Lanes deliberately live until the connection closes rather than being torn
/// down on `session:close`: removing a lane while its worker may still be
/// finishing that close would let the NEXT `session:open` for the same session
/// start on a fresh lane concurrently — exactly the close/open race the
/// ordering exists to prevent. An idle lane is one parked task.
fn dispatch_lane_key(msg: &ClientMessage) -> Option<String> {
    match msg {
        ClientMessage::SessionOpen { session_id, .. }
        | ClientMessage::SessionClose { session_id }
        | ClientMessage::SessionInput { session_id, .. }
        | ClientMessage::SessionResize { session_id, .. } => Some(format!("session:{session_id}")),
        ClientMessage::ChatOpen { session_id, .. } | ClientMessage::ChatClose { session_id } => {
            Some(format!("chat:{session_id}"))
        }
        ClientMessage::FileWatch { .. }
        | ClientMessage::FileUnwatch { .. }
        | ClientMessage::TreeWatch { .. }
        | ClientMessage::TreeUnwatch { .. } => Some("watch".to_string()),
        ClientMessage::Subscribe { .. }
        | ClientMessage::Unsubscribe { .. }
        | ClientMessage::Ping
        | ClientMessage::DebugLog { .. } => None,
    }
}

async fn handle_socket(
    socket: WebSocket,
    dispatch_ctx: DispatchContext,
    open_routes: OpenRoutes,
    scope: Option<TokenScope>,
    token_id: Option<String>,
    token_issued_at: Option<i64>,
    token_expires_at: Option<i64>,
    auth_rejected: bool,
) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<WsCommand>();

    let buffered_amount = Arc::new(AtomicUsize::new(0));
    let ready_state = Arc::new(AtomicU8::new(1));
    let closed_state = Arc::new(std::sync::Mutex::new(None));

    let sink = AxumWsSink::new(
        tx,
        buffered_amount.clone(),
        ready_state.clone(),
        closed_state,
    );

    let conn = WsConnection::new(sink);
    conn.set_scope(scope);
    conn.set_token_id(token_id);
    conn.set_token_issued_at(token_issued_at);
    conn.set_token_expires_at(token_expires_at);

    dispatch_ctx.hub.register_connection(&conn);

    // The upgrade gate accepted the socket but the token was missing/invalid/
    // expired for a non-loopback client. Close it immediately with the
    // auth-expired code (4401) so the client shows the login screen rather than
    // treating it as a normal disconnect and reconnecting forever.
    if auth_rejected {
        close_auth_expired(&conn);
    }

    // Replay pending navigate event if any
    if let Some(project_id) = open_routes.replay_navigate() {
        conn.send(vst_types::ws::ServerMessage::Navigate { project_id });
    }

    // Outbound forwarder task
    let buf_clone = buffered_amount.clone();
    let rstate_clone = ready_state.clone();
    let forwarder_handle = tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            match cmd {
                WsCommand::Text(txt) => {
                    let len = txt.len();
                    if sender.send(Message::Text(txt)).await.is_err() {
                        break;
                    }
                    buf_clone.fetch_sub(len, Ordering::SeqCst);
                }
                WsCommand::Ping => {
                    if sender.send(Message::Ping(vec![])).await.is_err() {
                        break;
                    }
                }
                WsCommand::Close(code, reason) => {
                    let _ = sender
                        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            }
        }
        rstate_clone.store(3, Ordering::SeqCst);
    });

    // Inbound listener
    let conn_clone = conn.clone();
    let ctx_clone = dispatch_ctx.clone();
    // Per-(connection, lane-key) ordered workers — see `dispatch_lane_key`.
    let mut lanes: std::collections::HashMap<String, DispatchLane> =
        std::collections::HashMap::new();
    while let Some(msg_res) = receiver.next().await {
        let msg = match msg_res {
            Ok(m) => m,
            Err(_) => break,
        };

        // Once we've initiated a close (revoke/expiry/upgrade-rejection via the
        // auth-expired code), stop dispatching any further incoming messages
        // (including terminal input) from this socket. tungstenite keeps
        // delivering already-buffered/in-flight frames after a server-initiated
        // close, so without this guard the read loop would keep processing
        // client messages until the client's own Close arrives or TCP times out.
        if conn_clone.closed().is_some() {
            break;
        }

        match msg {
            Message::Text(text) => {
                conn_clone.touch_last_seen();
                match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(val) => match serde_json::from_value::<ClientMessage>(val) {
                        Ok(client_msg) => {
                            // IMPORTANT: ordering is preserved PER LANE, and every
                            // message belongs to exactly one lane — either a
                            // dedicated ordered worker task (`dispatch_lane_key`)
                            // or this read loop itself.
                            //
                            // The invariant this protects is the original one: the
                            // TS daemon (daemon/src/ws/server.ts) started its
                            // `socket.on("message", async ...)` handlers
                            // synchronously in arrival order, which is what lets
                            // `WSConnection.withSessionLock` (AGENTS.md: "WebSocket
                            // — serialize session:open / session:close") preserve
                            // FIFO ordering per (connection, sessionId). A
                            // session:close immediately followed by a session:open
                            // (a terminal remount / rapid tap) must NOT interleave,
                            // or the DirectStreamRegistry/tmux attach-detach races
                            // and keystrokes are lost. Both land on the same lane
                            // key here, so they still run strictly in arrival
                            // order.
                            //
                            // What this no longer does is serialize *unrelated*
                            // work: awaiting every dispatch inline made one
                            // connection a single global FIFO, so a worktree switch
                            // queued N+M `session:open`s, every `chat:open` and a
                            // `tree:watch` behind each other — and the user's
                            // keystrokes behind all of them. Do NOT replace the
                            // lanes with a bare per-message `tokio::spawn`: that
                            // loses the per-session ordering above.
                            match dispatch_lane_key(&client_msg) {
                                Some(key) => {
                                    if !lanes.contains_key(&key)
                                        && lanes.len() >= MAX_LANES_PER_CONNECTION
                                    {
                                        // Refuse to grow further rather than
                                        // letting client-chosen ids allocate
                                        // tasks without bound.
                                        tracing::warn!(
                                            "[WS] connection hit the {MAX_LANES_PER_CONNECTION}-lane cap; dropping message for lane {key}"
                                        );
                                        continue;
                                    }
                                    let lane = lanes.entry(key.clone()).or_insert_with(|| {
                                        DispatchLane::spawn(conn_clone.clone(), ctx_clone.clone())
                                    });
                                    // A worker only ends when its sender is
                                    // dropped (teardown) or it panicked. In the
                                    // latter case nothing of this lane is in
                                    // flight any more, so replacing it cannot
                                    // reorder anything.
                                    if lane.tx.is_closed() {
                                        *lane = DispatchLane::spawn(
                                            conn_clone.clone(),
                                            ctx_clone.clone(),
                                        );
                                    }
                                    // Awaits when the lane is full — see
                                    // `LANE_QUEUE_CAP`.
                                    if lane.tx.send(client_msg).await.is_err() {
                                        tracing::warn!(
                                            "[WS] dropping message for dead dispatch lane {key}"
                                        );
                                    }
                                }
                                // Lane-less message types: their handlers are
                                // fully synchronous (no `.await` inside), so
                                // running them here is both ordered and
                                // non-blocking — and it keeps mutations of the
                                // connection's explicit subscription set in
                                // arrival order. That last part holds only
                                // because NOTHING dispatched on a lane touches
                                // that set: `chat:open`/`chat:close` keep their
                                // own `chat_subscriptions` membership precisely
                                // so a queued chat message cannot undo a
                                // `subscribe` that ran here after it. Anything
                                // added here that mutates shared connection
                                // state from a lane needs the same treatment.
                                None => dispatch(&conn_clone, &ctx_clone, &client_msg).await,
                            }
                        }
                        Err(_) => send_parse_error(&conn_clone, false),
                    },
                    Err(_) => send_parse_error(&conn_clone, true),
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Connection teardown. Stop accepting new work and let every lane drain in
    // order FIRST: `conn.cleanup()` detaches this connection's live streams, so
    // it must not race a worker still parked inside `attach()` (which would
    // leave a `tmux attach-session` client attached with nothing to detach it).
    // Dropping a lane's sender is what ends its worker, so this also guarantees
    // no task is leaked per connection.
    //
    // Every sender is dropped BEFORE awaiting any handle: a worker cannot
    // notice its queue is finished until its sender is gone, so awaiting them
    // one at a time while later lanes still hold senders would make teardown
    // cost the SUM of the lanes' drains instead of the slowest one.
    let mut lane_handles: Vec<tokio::task::JoinHandle<()>> = Vec::with_capacity(lanes.len());
    for (_key, lane) in lanes.drain() {
        let DispatchLane { tx, handle } = lane;
        drop(tx);
        lane_handles.push(handle);
    }
    let drain_deadline = tokio::time::Instant::now() + LANE_DRAIN_TIMEOUT;
    let mut drain_timed_out = false;
    for mut handle in lane_handles {
        if drain_timed_out {
            handle.abort();
            continue;
        }
        if tokio::time::timeout_at(drain_deadline, &mut handle)
            .await
            .is_err()
        {
            tracing::warn!(
                "[WS] dispatch lanes did not drain within {LANE_DRAIN_TIMEOUT:?}; aborting the rest so cleanup can proceed"
            );
            drain_timed_out = true;
            handle.abort();
        }
    }
    dispatch_ctx.hub.unregister_connection(&conn);
    // Release every file watcher this connection was still holding, so a
    // reload / crashed tab / lost socket can't leak an inotify fd forever.
    // Must run BEFORE `conn.cleanup()` clears the connection's watcher maps,
    // or `file_watch_keys()` would report nothing to release.
    release_connection_file_watches(&conn, &dispatch_ctx.watchers).await;
    // Release every tree watcher this connection was still holding, so a
    // reload / crashed tab / lost socket can't leak a watcher (or its inotify
    // fds) forever. Must run BEFORE `conn.cleanup()` clears the connection's
    // watcher maps, or `tree_watch_keys()` would report nothing to release.
    release_connection_tree_watches(&conn, &dispatch_ctx.watchers, &dispatch_ctx.file_search)
        .await;
    conn.cleanup().await;
    ready_state.store(3, Ordering::SeqCst);
    let _ = forwarder_handle.await;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Handlers
// ─────────────────────────────────────────────────────────────────────────────

async fn handle_health(State(state): State<AppState>) -> Json<vst_types::rest::health::Health> {
    Json(state.health_routes.health())
}

async fn handle_open(
    State(state): State<AppState>,
    Json(body): Json<OpenBody>,
) -> Result<Json<OpenResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .open_routes
        .open(body)
        .await
        .map(Json)
        .map_err(|e| match e {
            OpenRouteError::InvalidPath(detail) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_path",
                    "detail": detail
                })),
            ),
            OpenRouteError::PathNotFound => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "path_not_found" })),
            ),
            OpenRouteError::PathNotDirectory => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "path_not_directory" })),
            ),
            OpenRouteError::Internal(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "internal_error", "detail": err })),
            ),
        })
}

async fn handle_list_projects(State(state): State<AppState>) -> Json<Vec<Project>> {
    Json(state.project_routes.list_projects().await)
}

async fn handle_create_project(
    State(state): State<AppState>,
    Json(body): Json<CreateProjectBody>,
) -> Result<Json<Project>, (StatusCode, Json<serde_json::Value>)> {
    state
        .project_routes
        .create_project(body)
        .await
        .map(Json)
        .map_err(project_err_to_response)
}

async fn handle_create_new_project(
    State(state): State<AppState>,
    Json(body): Json<CreateNewProjectBody>,
) -> Result<Json<CreateNewProjectResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .project_routes
        .create_new_project(body)
        .await
        .map(Json)
        .map_err(project_err_to_response)
}

async fn handle_list_project_branches(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<BranchesResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .project_routes
        .list_project_branches(&id)
        .await
        .map(Json)
        .map_err(project_err_to_response)
}

async fn handle_patch_project(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PatchProjectBody>,
) -> Result<Json<PatchProjectResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .project_routes
        .patch_project(&id, body)
        .await
        .map(Json)
        .map_err(project_err_to_response)
}

async fn handle_delete_project(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    // 200 {"ok":true}, not bare 204 — see `handle_delete_session`'s comment;
    // `web-ui/src/api/client.ts:387` unconditionally `.json()`s this response.
    state
        .project_routes
        .delete_project(&id)
        .await
        .map(|_| Json(serde_json::json!({ "ok": true })))
        .map_err(project_err_to_response)
}

#[derive(Deserialize)]
struct PathQuery {
    path: Option<String>,
    #[serde(rename = "showHidden")]
    show_hidden: Option<bool>,
}

async fn handle_project_tree(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<PathQuery>,
) -> Result<Json<Vec<TreeEntry>>, (StatusCode, Json<serde_json::Value>)> {
    state
        .project_routes
        .tree(&id, query.path.as_deref(), query.show_hidden)
        .await
        .map(Json)
        .map_err(project_err_to_response)
}

async fn handle_project_file_list(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<FileListResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .project_routes
        .file_list(&id)
        .await
        .map(Json)
        .map_err(project_err_to_response)
}

async fn handle_project_get_file(
    State(state): State<AppState>,
    axum::extract::Path((id, file_path)): axum::extract::Path<(String, String)>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let resp = state
        .project_routes
        .get_file(&id, &file_path)
        .await
        .map_err(project_err_to_response)?;
    match resp {
        FileResponse::Text { etag, content } => Ok((
            [
                (header::ETAG, etag),
                (
                    header::CONTENT_TYPE,
                    "text/plain; charset=utf-8".to_string(),
                ),
            ],
            content,
        )
            .into_response()),
        FileResponse::Image { mime, content } => {
            Ok(([(header::CONTENT_TYPE, mime)], content).into_response())
        }
    }
}

fn project_err_to_response(err: ProjectRouteError) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        ProjectRouteError::Validation(m) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": m })),
        ),
        ProjectRouteError::NotFound(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m })),
        ),
        ProjectRouteError::Conflict {
            message,
            conflict_with,
        } => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": message, "conflictWith": conflict_with })),
        ),
        ProjectRouteError::AccessDenied(m) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": m })),
        ),
        ProjectRouteError::Unprocessable { message, reason } => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": message, "reason": reason })),
        ),
        ProjectRouteError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": m })),
        ),
    }
}

// ── Worktrees ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct WorktreeListQuery {
    project: Option<String>,
}

async fn handle_list_worktrees(
    State(state): State<AppState>,
    Query(query): Query<WorktreeListQuery>,
) -> Result<Json<Vec<Worktree>>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .list_worktrees(query.project.as_deref())
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_create_worktree(
    State(state): State<AppState>,
    Json(body): Json<CreateWorktreeBody>,
) -> Result<Json<Worktree>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .create_worktree(body)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktrees_disk_usage(
    State(state): State<AppState>,
) -> Result<Json<DiskUsage>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .disk_usage()
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_pin(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PatchWorktreeToggleBody>,
) -> Result<Json<PatchWorktreeResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .patch_pin(&id, body)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_hide(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PatchWorktreeToggleBody>,
) -> Result<Json<PatchWorktreeResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .patch_hide(&id, body)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_rename(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<RenameWorktreeBody>,
) -> Result<Json<RenameWorktreeResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .patch_rename(&id, body)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_reorder(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<ReorderWorktreeBody>,
) -> Result<Json<ReorderWorktreeResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .patch_reorder(&id, body)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_done(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<WorktreeDoneResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .worktree_done(&id)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

#[derive(Deserialize)]
struct DeleteWorktreeQuery {
    enforce_done: Option<bool>,
}

async fn handle_delete_worktree(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(q): Query<DeleteWorktreeQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    // 200 {"ok":true}, not bare 204 — see `handle_delete_session`'s comment;
    // `web-ui/src/api/client.ts:451` unconditionally `.json()`s this response.
    state
        .worktree_routes
        .delete_worktree(&id, q.enforce_done.unwrap_or(false))
        .await
        .map(|_| Json(serde_json::json!({ "ok": true })))
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_tree(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<PathQuery>,
) -> Result<Json<Vec<TreeEntry>>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .tree(&id, query.path.as_deref(), query.show_hidden)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_file_list(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<FileListResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .file_list(&id)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    re: Option<bool>,
    case: Option<bool>,
    word: Option<bool>,
    glob: Option<String>,
    limit: Option<usize>,
}

async fn handle_worktree_search(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<SearchResult>, (StatusCode, Json<serde_json::Value>)> {
    let q = query.q.as_deref().unwrap_or("");
    state
        .worktree_routes
        .search(
            &id,
            q,
            query.re.unwrap_or(false),
            query.case.unwrap_or(false),
            query.word.unwrap_or(false),
            query.glob.as_deref(),
            query.limit,
        )
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

#[derive(Deserialize)]
struct FileSearchQuery {
    q: Option<String>,
    limit: Option<usize>,
}

async fn handle_worktree_file_search(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<FileSearchQuery>,
) -> Result<Json<FileSearchResult>, (StatusCode, Json<serde_json::Value>)> {
    let q = query.q.as_deref().unwrap_or("");
    state
        .worktree_routes
        .file_search(&id, q, query.limit)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_get_file(
    State(state): State<AppState>,
    axum::extract::Path((id, file_path)): axum::extract::Path<(String, String)>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let resp = state
        .worktree_routes
        .get_file(&id, &file_path)
        .await
        .map_err(worktree_err_to_response)?;
    match resp {
        FileResponse::Text { etag, content } => Ok((
            [
                (header::ETAG, etag),
                (
                    header::CONTENT_TYPE,
                    "text/plain; charset=utf-8".to_string(),
                ),
            ],
            content,
        )
            .into_response()),
        FileResponse::Image { mime, content } => {
            Ok(([(header::CONTENT_TYPE, mime)], content).into_response())
        }
    }
}

async fn handle_worktree_gutter(
    State(state): State<AppState>,
    axum::extract::Path((id, file_path)): axum::extract::Path<(String, String)>,
) -> Result<Json<vst_types::rest::worktrees::GutterResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .gutter(&id, &file_path)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

#[derive(Deserialize)]
struct DiffQuery {
    scope: Option<String>,
    sha: Option<String>,
}

#[derive(Deserialize)]
struct DiffstatQuery {
    scope: Option<String>,
}

#[derive(Deserialize)]
struct CommitsQuery {
    limit: Option<usize>,
}

async fn handle_worktree_diff(
    State(state): State<AppState>,
    axum::extract::Path((id, file_path)): axum::extract::Path<(String, String)>,
    Query(q): Query<DiffQuery>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let DiffResponse { etag, content } = state
        .worktree_routes
        .diff(&id, &file_path, q.scope.as_deref(), q.sha.as_deref())
        .await
        .map_err(worktree_err_to_response)?;
    Ok((
        [
            (header::ETAG, etag),
            (
                header::CONTENT_TYPE,
                "text/plain; charset=utf-8".to_string(),
            ),
        ],
        content,
    )
        .into_response())
}

async fn handle_worktree_changed_paths(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(q): Query<DiffQuery>,
) -> Result<Json<Vec<ChangedPath>>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .changed_paths(&id, q.scope.as_deref(), q.sha.as_deref())
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_diffstat(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(q): Query<DiffstatQuery>,
) -> Result<Json<DiffStat>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .diffstat(&id, q.scope.as_deref())
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_commits(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(q): Query<CommitsQuery>,
) -> Result<Json<CommitsResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .commits(&id, q.limit)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_submodules(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<SubmodulesResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .submodules(&id)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_pr(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<PrLookupResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .pr(&id)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_open_file(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<OpenFileBody>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    state
        .worktree_routes
        .open_file(&id, body)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_get_pending_file_opens(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<vst_types::rest::worktrees::PendingFileOpens>, (StatusCode, Json<serde_json::Value>)>
{
    state
        .worktree_routes
        .get_pending_file_opens(&id)
        .await
        .map(Json)
        .map_err(worktree_err_to_response)
}

async fn handle_worktree_delete_pending_file_opens(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    // 200 {"ok":true}, not bare 204 — see `handle_delete_session`'s comment;
    // `web-ui/src/api/client.ts:466` unconditionally `.json()`s this response.
    state
        .worktree_routes
        .delete_pending_file_opens(&id)
        .await
        .map(|_| Json(serde_json::json!({ "ok": true })))
        .map_err(worktree_err_to_response)
}

fn worktree_err_to_response(err: WorktreeRouteError) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        WorktreeRouteError::Validation(m) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": m })),
        ),
        WorktreeRouteError::NotFound(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m })),
        ),
        WorktreeRouteError::Conflict(m) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": m })),
        ),
        WorktreeRouteError::AccessDenied(m) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": m })),
        ),
        WorktreeRouteError::Unprocessable(m) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": m })),
        ),
        WorktreeRouteError::WorktreeNotDone { sessions } => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "WORKTREE_NOT_DONE", "sessions": sessions })),
        ),
        WorktreeRouteError::ServiceUnavailable(m) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": m })),
        ),
        WorktreeRouteError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": m })),
        ),
    }
}

// ── Sessions ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SessionListQuery {
    worktree: Option<String>,
    project: Option<String>,
}

async fn handle_list_sessions(
    State(state): State<AppState>,
    Query(q): Query<SessionListQuery>,
) -> Result<Json<Vec<SessionListItem>>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .list_sessions(q.worktree.as_deref(), q.project.as_deref())
        .await
        .map(Json)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e })),
            )
        })
}

async fn handle_get_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<SessionOrDraft>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .get_session(&id)
        .await
        .map(Json)
        .map_err(|e| {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": e })),
            )
        })
}

#[derive(Deserialize)]
struct OutputQuery {
    lines: Option<String>,
}

async fn handle_session_output(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(q): Query<OutputQuery>,
) -> Result<Json<SessionOutput>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .session_output(&id, q.lines.as_deref())
        .await
        .map(Json)
        .map_err(|e| {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": e })),
            )
        })
}

async fn handle_create_session(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<SessionOrDraft>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .create_session(&body)
        .await
        .map(Json)
        .map_err(|e| match e {
            CreateError::Validation(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            CreateError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            CreateError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_delete_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .delete_session(&id)
        .await
        // TS (`daemon/src/routes/sessions.ts`) sends `200 {"ok":true}` with a
        // JSON content-type on every successful delete/discard branch. This
        // previously returned bare `StatusCode::NO_CONTENT` (204, empty
        // body, no Content-Type), which is valid HTTP but breaks every
        // client caller — `web-ui/src/api/client.ts`'s `terminateSession`
        // unconditionally calls `res.json()` on any 2xx response via
        // `parseJson`, so discarding a draft (or deleting any session)
        // always threw `SyntaxError: Unexpected end of JSON input` even
        // though the delete itself succeeded. Live-reproduced against the
        // :7141 sandbox with the exact same error text the user reported.
        .map(|_| Json(serde_json::json!({ "ok": true })))
        .map_err(|e| match e {
            DeleteError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            DeleteError::NoEligibleSibling(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            DeleteError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_patch_session_draft(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PatchDraftBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .patch_session_draft(&id, &body)
        .await
        .map(|res| Json(serde_json::json!({ "ok": res.ok, "name": res.name })))
        .map_err(|e| match e {
            DraftError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            DraftError::NotDrafting(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            DraftError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_start_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<StartDraftBody>,
) -> Result<Json<StartDraftResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .start_session(&id, &body)
        .await
        .map(Json)
        .map_err(|e| match e {
            StartError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            StartError::NotDrafting(m) | StartError::Validation(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            StartError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_pin_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PinBody>,
) -> Result<Json<PinResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .pin_session(&id, body.pinned)
        .await
        .map(Json)
        .map_err(mutate_err_to_response)
}

async fn handle_rename_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<RenameSessionBody>,
) -> Result<Json<RenameSessionResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .rename_session(&id, &body.name)
        .await
        .map(Json)
        .map_err(mutate_err_to_response)
}

async fn handle_reorder_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<ReorderSessionBody>,
) -> Result<Json<ReorderSessionResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .reorder_session(&id, body.sort_order)
        .await
        .map(Json)
        .map_err(mutate_err_to_response)
}

async fn handle_delink_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<DelinkResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .delink_session(&id)
        .await
        .map(Json)
        .map_err(mutate_err_to_response)
}

fn mutate_err_to_response(err: MutateError) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        MutateError::NotFound(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m })),
        ),
        MutateError::Archived(m) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": m })),
        ),
        MutateError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": m })),
        ),
    }
}

async fn handle_done_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .done_session(&id)
        .await
        .map(|res| Json(serde_json::json!({ "ok": res.ok })))
        .map_err(|e| match e {
            DoneError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            DoneError::NotAgent(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            DoneError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_resume_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<vst_types::rest::shared::Session>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .resume_session(&id)
        .await
        .map(Json)
        .map_err(|e| match e {
            ResumeError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            ResumeError::NotRunning(m) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": m })),
            ),
            ResumeError::Archived(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            ResumeError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_reset_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<ResetBody>,
) -> Result<Json<vst_types::rest::sessions::ResetResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .reset_session(&id, &body)
        .await
        .map(Json)
        .map_err(|e| match e {
            ResetError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            ResetError::NotAgent(m)
            | ResetError::Archived(m)
            | ResetError::NoMode(m)
            | ResetError::ModeNotFound(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            ResetError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_handoff_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<HandoffResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .handoff_session(&id)
        .await
        .map(Json)
        .map_err(|e| match e {
            HandoffRouteError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            HandoffRouteError::NotAgent(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            HandoffRouteError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_send_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<InputBody>,
) -> Result<Json<OkResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .send_session(&id, body)
        .await
        .map(|res| Json(OkResult { ok: res.ok }))
        .map_err(chat_err_to_response)
}

async fn handle_chat_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<ChatBody>,
) -> Result<(StatusCode, Json<EnqueueChatResult>), (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .chat_session(&id, body)
        .await
        .map(|res| (StatusCode::ACCEPTED, Json(res)))
        .map_err(chat_err_to_response)
}

async fn handle_dismiss_notice(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .dismiss_notice(&id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(chat_err_to_response)
}

async fn handle_promote_notice(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .promote_notice(&id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(chat_err_to_response)
}

async fn handle_stop_active_turn(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<OkResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .stop_active_turn(&id)
        .await
        .map(|res| Json(OkResult { ok: res.ok }))
        .map_err(chat_err_to_response)
}

async fn handle_cancel_queued_turn(
    State(state): State<AppState>,
    axum::extract::Path((id, turn_id)): axum::extract::Path<(String, String)>,
) -> Result<Json<OkResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .cancel_queued_turn(&id, &turn_id)
        .await
        .map(|res| Json(OkResult { ok: res.ok }))
        .map_err(chat_err_to_response)
}

async fn handle_edit_queued_turn(
    State(state): State<AppState>,
    axum::extract::Path((id, turn_id)): axum::extract::Path<(String, String)>,
) -> Result<Json<EditQueuedResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .edit_queued_turn(&id, &turn_id)
        .await
        .map(Json)
        .map_err(chat_err_to_response)
}

async fn handle_resubmit_queued_turn(
    State(state): State<AppState>,
    axum::extract::Path((id, turn_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<ResubmitBody>,
) -> Result<Json<TurnActionResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .resubmit_queued_turn(&id, &turn_id, body)
        .await
        .map(Json)
        .map_err(chat_err_to_response)
}

async fn handle_promote_queued_turn(
    State(state): State<AppState>,
    axum::extract::Path((id, turn_id)): axum::extract::Path<(String, String)>,
) -> Result<Json<TurnActionResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .promote_queued_turn(&id, &turn_id)
        .await
        .map(Json)
        .map_err(chat_err_to_response)
}

async fn handle_patch_chat_model(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PatchModelBody>,
) -> Result<Json<PatchModelResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .patch_chat_model(&id, body)
        .await
        .map(Json)
        .map_err(chat_err_to_response)
}

async fn handle_patch_session_channel(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PatchChannelBody>,
) -> Result<Json<PatchChannelResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .patch_session_channel(&id, body)
        .await
        .map(Json)
        .map_err(|e| match e {
            ChannelError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            ChannelError::NotAgent(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            ChannelError::NotIdle => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "NOT_IDLE" })),
            ),
            ChannelError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

#[derive(Deserialize)]
struct TranscriptReqQuery {
    #[serde(rename = "beforeSeq")]
    before_seq: Option<String>,
    limit: Option<String>,
    since: Option<String>,
    all: Option<String>,
}

async fn handle_get_session_transcript(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(q): Query<TranscriptReqQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let query = TranscriptQuery {
        before_seq: q.before_seq,
        limit: q.limit,
        since: q.since,
        all: q.all,
    };
    state
        .session_routes
        .get_session_transcript(&id, query)
        .await
        .map(|res| match res {
            TranscriptResponse::All(a) => Json(serde_json::to_value(a).unwrap()),
            TranscriptResponse::Since(s) => Json(serde_json::to_value(s).unwrap()),
            TranscriptResponse::Page(p) => Json(serde_json::to_value(p).unwrap()),
        })
        .map_err(|e| match e {
            TranscriptError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            TranscriptError::NotJson(m) | TranscriptError::InvalidQuery(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            TranscriptError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_get_session_meta(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<vst_types::domain::SessionMeta>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .get_session_meta(&id)
        .await
        .map(Json)
        .map_err(|e| match e {
            TranscriptError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            TranscriptError::NotJson(m) | TranscriptError::InvalidQuery(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            TranscriptError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

fn chat_err_to_response(err: ChatRouteError) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        ChatRouteError::NotFound(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m })),
        ),
        ChatRouteError::Archived(m)
        | ChatRouteError::AttachmentNotFound(m)
        | ChatRouteError::AttachmentsRequireJson(m)
        | ChatRouteError::NotJson(m)
        | ChatRouteError::UnknownModel(m) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": m })),
        ),
        ChatRouteError::NotRunning(m)
        | ChatRouteError::NoActiveTurn(m)
        | ChatRouteError::Done(m) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": m })),
        ),
        ChatRouteError::TurnNotFound(m)
        | ChatRouteError::NotEditing(m)
        | ChatRouteError::TurnNotQueued(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m })),
        ),
        ChatRouteError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": m })),
        ),
    }
}

// ── Attachments ───────────────────────────────────────────────────────────
//
// The web-ui client (`web-ui/src/api/client.ts`'s `uploadAttachments`) sends a
// real `multipart/form-data` request (browser `FormData`, field name `files`,
// no explicit Content-Type so the browser sets the boundary). This must be
// parsed with axum's `Multipart` extractor, NOT `Json<...>` — a `Json`
// extractor rejects any non-`application/json` request before the handler
// body ever runs. See `.vibekit/reports/2026-09-22-attachment-upload-debug.md`
// for the full root-cause writeup of the regression this fixes.
//
// We enforce `MAX_FILE_BYTES`/`MAX_BODY_BYTES` while streaming field chunks so
// an oversized upload is rejected (413) without buffering the whole body into
// memory first; `AttachmentRoutes::upload_attachments` re-checks per-file size
// too, so this is a belt-and-braces early-exit, not the only enforcement.
async fn handle_upload_attachments(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<AttachmentsResult>, (StatusCode, Json<serde_json::Value>)> {
    fn bad_request(msg: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg.into() })),
        )
    }

    let mut parts: Vec<UploadPart> = Vec::new();
    let mut total_bytes: usize = 0;

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(e) => {
                return Err(bad_request(format!("invalid multipart body: {e}")));
            }
        };

        if field.name() != Some("files") {
            // Ignore unrelated fields rather than rejecting the whole request.
            continue;
        }

        let filename = field
            .file_name()
            .map(str::to_string)
            .unwrap_or_else(|| "upload".to_string());
        let content_type = field.content_type().map(str::to_string);

        let mut field = field;
        let mut data: Vec<u8> = Vec::new();
        loop {
            match field.chunk().await {
                Ok(Some(chunk)) => {
                    total_bytes += chunk.len();
                    if total_bytes > MAX_BODY_BYTES {
                        return Err((
                            StatusCode::PAYLOAD_TOO_LARGE,
                            Json(serde_json::json!({
                                "error": format!("request body exceeds {MAX_BODY_BYTES} bytes")
                            })),
                        ));
                    }
                    if data.len() + chunk.len() > MAX_FILE_BYTES {
                        return Err((
                            StatusCode::PAYLOAD_TOO_LARGE,
                            Json(serde_json::json!({
                                "error": format!(
                                    "file '{filename}' exceeds {MAX_FILE_BYTES} bytes"
                                )
                            })),
                        ));
                    }
                    data.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => {
                    return Err(bad_request(format!("invalid multipart body: {e}")));
                }
            }
        }

        parts.push(UploadPart {
            filename,
            content_type,
            data,
        });
    }

    state
        .attachment_routes
        .upload_attachments(&id, parts)
        .await
        .map(Json)
        .map_err(|e| match e {
            AttachmentRouteError::SessionNotFound(m) | AttachmentRouteError::UploadNotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            AttachmentRouteError::NotAgentSession(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            AttachmentRouteError::NoFilesProvided => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "No files provided" })),
            ),
            AttachmentRouteError::InvalidFilename(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            AttachmentRouteError::FileTooLarge(m) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({ "error": m })),
            ),
            AttachmentRouteError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_delete_attachment(
    State(state): State<AppState>,
    axum::extract::Path((id, upload_id)): axum::extract::Path<(String, String)>,
) -> Result<Json<DeleteAttachmentResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .attachment_routes
        .delete_attachment(&id, &upload_id)
        .await
        .map(Json)
        .map_err(|e| match e {
            AttachmentRouteError::SessionNotFound(m) | AttachmentRouteError::UploadNotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m })),
            ),
            AttachmentRouteError::NotAgentSession(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            AttachmentRouteError::NoFilesProvided => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "No files provided" })),
            ),
            AttachmentRouteError::InvalidFilename(m) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": m })),
            ),
            AttachmentRouteError::FileTooLarge(m) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({ "error": m })),
            ),
            AttachmentRouteError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

// ── Modes ─────────────────────────────────────────────────────────────────

async fn handle_supported_clis(State(state): State<AppState>) -> Json<Vec<SupportedCli>> {
    Json(state.mode_routes.list_supported_clis())
}

#[derive(Deserialize)]
struct CliQuery {
    cli: Option<String>,
}

async fn handle_cli_models(
    State(state): State<AppState>,
    Query(q): Query<CliQuery>,
) -> Result<Json<CliModels>, (StatusCode, Json<serde_json::Value>)> {
    let cli_id = match q.cli.as_deref() {
        Some("claude") => vst_types::CliId::Claude,
        Some("cursor") => vst_types::CliId::Cursor,
        Some("opencode") => vst_types::CliId::Opencode,
        Some("agy") => vst_types::CliId::Agy,
        _ => vst_types::CliId::Claude,
    };
    Ok(Json(state.mode_routes.resolve_cli_models(cli_id).await))
}

async fn handle_get_modes(State(state): State<AppState>) -> Json<Vec<Mode>> {
    Json(state.mode_routes.list_modes().await)
}

async fn handle_create_mode(
    State(state): State<AppState>,
    Json(body): Json<CreateModeBody>,
) -> Result<Json<Mode>, (StatusCode, Json<serde_json::Value>)> {
    state
        .mode_routes
        .create_mode(body)
        .await
        .map(Json)
        .map_err(mode_err_to_response)
}

async fn handle_update_mode(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<UpdateModeBody>,
) -> Result<Json<Mode>, (StatusCode, Json<serde_json::Value>)> {
    state
        .mode_routes
        .update_mode(&id, body)
        .await
        .map(Json)
        .map_err(mode_err_to_response)
}

async fn handle_delete_mode(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<DeleteModeResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .mode_routes
        .delete_mode(&id)
        .await
        .map(Json)
        .map_err(mode_err_to_response)
}

fn mode_err_to_response(err: ModeRouteError) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        ModeRouteError::Validation(m) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": m })),
        ),
        ModeRouteError::Conflict {
            message,
            conflict_with,
        } => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": message, "conflictWith": conflict_with })),
        ),
        ModeRouteError::NotFound(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m })),
        ),
        ModeRouteError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": m })),
        ),
    }
}

// ── Settings ──────────────────────────────────────────────────────────────

async fn handle_get_settings(State(state): State<AppState>) -> Json<Settings> {
    Json(state.settings_routes.get_settings().await)
}

async fn handle_patch_settings(
    State(state): State<AppState>,
    Json(body): Json<PatchSettingsBody>,
) -> Result<Json<PatchSettingsResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .settings_routes
        .patch_settings(body)
        .await
        .map(Json)
        .map_err(|e| match e {
            SettingsRouteError::DefaultProjectsDirNotAbsolute
            | SettingsRouteError::SkillPathsNotAbsolute
            | SettingsRouteError::InvalidMarkdownStyle => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e.to_string() })),
            ),
            SettingsRouteError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

// ── Skills ────────────────────────────────────────────────────────────────

async fn handle_get_skills(State(state): State<AppState>) -> Json<SkillsResult> {
    Json(state.skills_routes.get_skills().await)
}

// ── Ordered Lists ─────────────────────────────────────────────────────────

async fn handle_get_ordered_list(
    State(state): State<AppState>,
    axum::extract::Path(scope_key): axum::extract::Path<String>,
) -> Result<Json<OrderedList>, (StatusCode, Json<serde_json::Value>)> {
    state
        .ordered_lists_routes
        .get_ordered_list(&scope_key)
        .await
        .map(Json)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
        })
}

async fn handle_put_ordered_list(
    State(state): State<AppState>,
    axum::extract::Path(scope_key): axum::extract::Path<String>,
    Json(body): Json<PutOrderedListBody>,
) -> Result<Json<PutOrderedListResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .ordered_lists_routes
        .put_ordered_list(&scope_key, body)
        .await
        .map(Json)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
        })
}

// ── Filesystem ────────────────────────────────────────────────────────────

async fn handle_fs_check(
    State(state): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<Json<vst_types::rest::fs::FsCheck>, (StatusCode, Json<serde_json::Value>)> {
    state
        .fs_routes
        .check(q.path.as_deref().unwrap_or(""))
        .await
        .map(Json)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
        })
}

async fn handle_fs_complete(
    State(state): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<Json<vst_types::rest::fs::FsComplete>, (StatusCode, Json<serde_json::Value>)> {
    state
        .fs_routes
        .complete(q.path.as_deref().unwrap_or(""))
        .await
        .map(Json)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
        })
}

// ── Auth ──────────────────────────────────────────────────────────────────

async fn handle_auth_check(State(state): State<AppState>, req: Request) -> Json<OkResult> {
    if state.no_auth || state.auth_routes.is_none() {
        return Json(OkResult { ok: true });
    }
    let payload = req.extensions().get::<TokenPayload>();
    Json(state.auth_routes.as_ref().unwrap().check(payload).await)
}

async fn handle_auth_logout(
    State(state): State<AppState>,
) -> (StatusCode, [(HeaderName, HeaderValue); 1], Json<OkResult>) {
    use axum::http::header::SET_COOKIE;
    if state.no_auth || state.auth_routes.is_none() {
        let cookie = format!(
            "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
            COOKIE_NAME
        );
        return (
            StatusCode::OK,
            [(SET_COOKIE, HeaderValue::from_str(&cookie).unwrap())],
            Json(OkResult { ok: true }),
        );
    }
    let (code, cookie, res) = state.auth_routes.as_ref().unwrap().logout().await;
    (
        StatusCode::from_u16(code).unwrap_or(StatusCode::OK),
        [(SET_COOKIE, HeaderValue::from_str(&cookie).unwrap())],
        Json(res),
    )
}

async fn handle_auth_sessions(
    State(state): State<AppState>,
    req: Request,
) -> Json<AuthSessionsResult> {
    if state.no_auth || state.auth_routes.is_none() {
        return Json(AuthSessionsResult {
            sessions: vec![],
            is_desktop: true,
            current_scope: "tauri".to_string(),
            current_token_id: None,
        });
    }

    let auth_hdr = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let cookie_hdr = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok());
    let current_token_id = extract_token_id_from_auth(auth_hdr, cookie_hdr);
    let payload = req.extensions().get::<TokenPayload>();

    Json(
        state
            .auth_routes
            .as_ref()
            .unwrap()
            .sessions(payload, current_token_id)
            .await,
    )
}

async fn handle_auth_revoke_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    req: Request,
) -> Result<Json<OkResult>, (StatusCode, Json<serde_json::Value>)> {
    if state.no_auth || state.auth_routes.is_none() {
        return Ok(Json(OkResult { ok: true }));
    }
    let payload = req.extensions().get::<TokenPayload>();
    state
        .auth_routes
        .as_ref()
        .unwrap()
        .revoke_session(&id, payload)
        .await
        .map(Json)
        .map_err(|e| match e {
            AuthRouteError::DesktopOnly => (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": "DESKTOP_ONLY" })),
            ),
            AuthRouteError::NotFound => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Session not found." })),
            ),
            AuthRouteError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

async fn handle_auth_revoke_browser(
    State(state): State<AppState>,
    req: Request,
) -> Result<Json<RevokeBrowserResult>, (StatusCode, Json<serde_json::Value>)> {
    if state.no_auth || state.auth_routes.is_none() {
        return Ok(Json(RevokeBrowserResult {
            ok: true,
            browser_epoch: 0,
        }));
    }
    let payload = req.extensions().get::<TokenPayload>();
    state
        .auth_routes
        .as_ref()
        .unwrap()
        .revoke_browser(payload)
        .await
        .map(Json)
        .map_err(|e| match e {
            AuthRouteError::DesktopOnly => (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": "DESKTOP_ONLY" })),
            ),
            AuthRouteError::NotFound => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Session not found." })),
            ),
            AuthRouteError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": m })),
            ),
        })
}

// ── Mobile Auth & Tunnel ──────────────────────────────────────────────────

use axum::http::header::HeaderName;

async fn handle_auth_tunnel_enable(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<
    Json<vst_types::rest::mobile_auth::TunnelEnableResult>,
    (StatusCode, Json<serde_json::Value>),
> {
    let is_remote = headers.contains_key("cf-connecting-ip");
    state
        .mobile_auth_routes
        .enable_tunnel(is_remote)
        .await
        .map(Json)
        .map_err(mobile_auth_err_to_response)
}

async fn handle_auth_tunnel_disable(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<
    Json<vst_types::rest::mobile_auth::TunnelDisableResult>,
    (StatusCode, Json<serde_json::Value>),
> {
    let is_remote = headers.contains_key("cf-connecting-ip");
    state
        .mobile_auth_routes
        .disable_tunnel(is_remote)
        .await
        .map(Json)
        .map_err(mobile_auth_err_to_response)
}

async fn handle_auth_tunnel_status(
    State(state): State<AppState>,
) -> Result<Json<vst_types::rest::mobile_auth::TunnelStatus>, (StatusCode, Json<serde_json::Value>)>
{
    state
        .mobile_auth_routes
        .tunnel_status()
        .await
        .map(Json)
        .map_err(mobile_auth_err_to_response)
}

async fn handle_auth_local_qr(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<vst_types::rest::mobile_auth::LocalQrResult>, (StatusCode, Json<serde_json::Value>)>
{
    let is_remote = headers.contains_key("cf-connecting-ip");
    state
        .mobile_auth_routes
        .local_qr(is_remote)
        .await
        .map(Json)
        .map_err(mobile_auth_err_to_response)
}

async fn handle_auth_mobile_qr(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<vst_types::rest::mobile_auth::MobileQrResult>, (StatusCode, Json<serde_json::Value>)>
{
    let is_remote = headers.contains_key("cf-connecting-ip");
    state
        .mobile_auth_routes
        .mobile_qr(is_remote)
        .await
        .map(Json)
        .map_err(mobile_auth_err_to_response)
}

#[derive(Deserialize)]
struct CodeQuery {
    code: Option<String>,
}

async fn handle_mobile_auth(
    State(state): State<AppState>,
    Query(q): Query<CodeQuery>,
    headers: HeaderMap,
    req: Request,
) -> Response {
    let via_tunnel = headers.contains_key("cf-connecting-ip");
    let connect_info = req.extensions().get::<ConnectInfo<SocketAddr>>().copied();
    let peer_ip = connect_info.map(|ci| ci.0.ip().to_string());
    let client_ip = if let Some(cf_ip) = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
    {
        Some(cf_ip)
    } else {
        peer_ip.as_deref()
    };
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let res = state
        .mobile_auth_routes
        .mobile_auth(q.code, client_ip, via_tunnel, user_agent)
        .await;

    let mut response = (
        StatusCode::from_u16(res.status).unwrap_or(StatusCode::OK),
        Html(res.html),
    )
        .into_response();
    if let Some(cookie) = res.set_cookie {
        if let Ok(val) = HeaderValue::from_str(&cookie) {
            response.headers_mut().insert(header::SET_COOKIE, val);
        }
    }
    response
}

fn mobile_auth_err_to_response(err: MobileAuthRouteError) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        MobileAuthRouteError::TunnelOnlyBlocked => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "TUNNEL_ONLY_BLOCKED" })),
        ),
        MobileAuthRouteError::NoAuthMode => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "Tunnel unavailable in no-auth mode" })),
        ),
        MobileAuthRouteError::AlreadyEnabled { tunnel_url } => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "Tunnel already enabled", "tunnelUrl": tunnel_url })),
        ),
        MobileAuthRouteError::TunnelNotEnabled => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "Tunnel not enabled" })),
        ),
        MobileAuthRouteError::NoNetworkInterface => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "No network interface found" })),
        ),
        MobileAuthRouteError::RateLimitExceeded => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Rate limit exceeded" })),
        ),
        MobileAuthRouteError::MissingCode => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Missing code parameter" })),
        ),
        MobileAuthRouteError::AuthNotConfigured => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "Auth not configured" })),
        ),
        MobileAuthRouteError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": m })),
        ),
    }
}

// ── Tailscale ─────────────────────────────────────────────────────────────

async fn handle_tailscale_status(State(state): State<AppState>) -> Json<TailscaleStatus> {
    Json(state.tailscale_routes.status().await)
}

async fn handle_tailscale_serve_enable(
    State(state): State<AppState>,
) -> Result<Json<TailscaleServeEnableResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .tailscale_routes
        .enable_serve()
        .await
        .map(Json)
        .map_err(tailscale_err_to_response)
}

async fn handle_tailscale_serve_disable(
    State(state): State<AppState>,
) -> Result<Json<TailscaleServeDisableResult>, (StatusCode, Json<serde_json::Value>)> {
    state
        .tailscale_routes
        .disable_serve()
        .await
        .map(Json)
        .map_err(tailscale_err_to_response)
}

async fn handle_tailscale_up(
    State(state): State<AppState>,
    req: Request,
) -> Result<Json<TailscaleUpResult>, (StatusCode, Json<serde_json::Value>)> {
    let payload = req.extensions().get::<TokenPayload>();
    state
        .tailscale_routes
        .up(payload)
        .await
        .map(Json)
        .map_err(tailscale_err_to_response)
}

async fn handle_tailscale_qr(
    State(state): State<AppState>,
) -> Result<Json<TailscaleQr>, (StatusCode, Json<serde_json::Value>)> {
    state
        .tailscale_routes
        .qr()
        .await
        .map(Json)
        .map_err(tailscale_err_to_response)
}

fn tailscale_err_to_response(err: TailscaleRouteError) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        TailscaleRouteError::DesktopOnly => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "DESKTOP_ONLY" })),
        ),
        TailscaleRouteError::ServeNotActive => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "TAILSCALE_SERVE_NOT_ACTIVE" })),
        ),
        TailscaleRouteError::CertNeedsEnablement { enable_url } => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "CERT_NEEDS_ENABLEMENT", "enableUrl": enable_url })),
        ),
        TailscaleRouteError::RuleNotOurs { actual_port } => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "RULE_NOT_OURS", "actualPort": actual_port })),
        ),
        TailscaleRouteError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": m })),
        ),
    }
}

// ── Static SPA / dist fallback ────────────────────────────────────────────

async fn handle_fallback(State(state): State<AppState>, req: Request) -> Response {
    let Some(ref dist) = state.dist_path else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };

    let path = req.uri().path().trim_start_matches('/');
    let target = dist.join(path);

    if target.is_file() {
        if let Ok(bytes) = tokio::fs::read(&target).await {
            let mime = mime_guess::from_path(&target)
                .first_or_octet_stream()
                .to_string();
            return ([(header::CONTENT_TYPE, mime)], bytes).into_response();
        }
    }

    let index = dist.join("index.html");
    if index.is_file() {
        if let Ok(content) = tokio::fs::read_to_string(&index).await {
            return (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                content,
            )
                .into_response();
        }
    }

    (StatusCode::NOT_FOUND, "Not found").into_response()
}

mod mime_guess {
    use std::path::Path;

    pub struct MimeGuess(&'static str);

    impl MimeGuess {
        pub fn first_or_octet_stream(&self) -> &'static str {
            self.0
        }
    }

    pub fn from_path(p: &Path) -> MimeGuess {
        let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
        let mime = match ext.to_ascii_lowercase().as_str() {
            "html" => "text/html; charset=utf-8",
            "js" | "mjs" => "application/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "json" => "application/json",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "ico" => "image/x-icon",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            _ => "application/octet-stream",
        };
        MimeGuess(mime)
    }
}
