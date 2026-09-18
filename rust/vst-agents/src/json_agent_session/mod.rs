//! `JsonAgentSession` — the JSON agent-chat turn engine (Decision 2/3/8/10/12).
//! Ports `services/jsonAgent.ts`.
//!
//! One long-lived session owning: a FIFO turn queue + sequential runner, transcript
//! persistence (SQLite via `vst-store`), `SessionMeta` accumulation, the
//! daemon-synthesized `user` event at enqueue, and `agentChatId` capture.
//!
//! Per the plan, the ~35 methods are split across separate `impl JsonAgentSession`
//! blocks in separate files (queue / drain / connection / pids / meta / events).
//! The no-live-session meta assembly free functions live in [`meta`].

pub mod connection;
pub mod drain;
pub mod events;
pub mod meta;
pub mod pids;
pub mod queue;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use vst_store::transcript::{
    open_transcript_store, transcript_db_path, ImportOutcome, SincePage, TranscriptMeta,
    TranscriptPage, TranscriptStore,
};
use vst_types::{
    Attachment, Broadcaster, Command, LifecycleState, NormalizedEvent, NormalizedEventKind,
    NormalizedEventProvider, ProjectRecord, ServerEvent, SessionLifecycle, SessionMeta,
    SessionRecord, TurnState, UsageInfo, WorktreeRecord,
};

use crate::acp_connection::AcpConnection;
use crate::acp_transport::AcpTransport;
use crate::json_agent_registry::JsonAgentRegistry;
use crate::json_agent_stream::JsonAgentStream;
use crate::native_history_importer::get_native_history_importer;
use crate::plugin::AgentPlugin;
use vst_store::StoreHandle;

/// How long `release()` waits for an aborted turn to unwind.
pub const RELEASE_DRAIN_TIMEOUT_MS: u64 = 2_000;
/// Quiet gap after which the next out-of-band ACP event starts a new pseudo-turn.
pub const OUT_OF_BAND_BURST_GAP_MS: u64 = 30_000;

// ---------------------------------------------------------------------------
// Queue / hold types
// ---------------------------------------------------------------------------

/// A single enqueued (not yet running) turn.
#[derive(Clone, Debug)]
pub struct QueuedTurn {
    pub turn_id: String,
    /// Monotonic enqueue order (never reused).
    pub enqueue_order: u64,
    /// RAW user text (pre-injection) — kept for editing.
    pub raw_message: String,
    /// Resolved attachment records — kept for editing + chip rendering.
    pub attachments: Vec<Attachment>,
    /// Edit-a-sent-message fork source (R3.2).
    pub fork_from_chat_id: Option<String>,
}

/// A turn withdrawn into the editing hold.
#[derive(Clone, Debug)]
pub struct HeldTurn {
    pub turn: QueuedTurn,
    /// Turn ids that were AHEAD of this turn at withdraw.
    pub ahead_ids: Vec<String>,
}

/// In-memory notice slot (subagent-ux-v2).
#[derive(Clone, Debug)]
pub struct NoticeSlotInner {
    /// childId → display name. Vec preserves insertion order (TS uses Map).
    pub children: Vec<(String, String)>,
}

impl NoticeSlotInner {
    pub fn new(child_id: String, child_name: String) -> Self {
        Self {
            children: vec![(child_id, child_name)],
        }
    }

    pub fn insert(&mut self, child_id: String, child_name: String) {
        if let Some(entry) = self.children.iter_mut().find(|(id, _)| id == &child_id) {
            entry.1 = child_name;
        } else {
            self.children.push((child_id, child_name));
        }
    }

    pub fn remove(&mut self, child_id: &str) -> bool {
        let before = self.children.len();
        self.children.retain(|(id, _)| id != child_id);
        self.children.len() < before
    }

    pub fn is_empty(&self) -> bool {
        self.children.is_empty()
    }

    /// Build the children map (BTreeMap) for SessionMeta wire representation.
    pub fn to_btree_map(&self) -> std::collections::BTreeMap<String, String> {
        self.children.iter().cloned().collect()
    }
}

// ---------------------------------------------------------------------------
// Session options
// ---------------------------------------------------------------------------

/// Constructor arguments for `JsonAgentSession`.
pub struct JsonAgentSessionOptions {
    pub project: ProjectRecord,
    /// `None` for direct (project) sessions.
    pub worktree: Option<WorktreeRecord>,
    pub session: SessionRecord,
    pub plugin: Arc<dyn AgentPlugin>,
    pub daemon_port: u16,
    /// CLI / provider id (from the session's mode).
    pub cli: NormalizedEventProvider,
    pub model: Option<String>,
    pub mode_id: Option<String>,
    pub mode_name: Option<String>,
    /// For lifecycle persistence and project mutations.
    pub store_handle: StoreHandle,
    pub broadcaster: Broadcaster,
}

// ---------------------------------------------------------------------------
// Interior state (mutex-guarded)
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub(super) struct State {
    // ---- persisted from opts ----
    pub(super) project: ProjectRecord,
    pub(super) worktree: Option<WorktreeRecord>,
    pub(super) session: SessionRecord,
    pub(super) mode_id: Option<String>,
    pub(super) mode_name: Option<String>,

    // ---- turn execution ----
    /// REQUESTED model (what we spawn with — never drift to observed model).
    pub(super) requested_model: Option<String>,
    /// OBSERVED/display model (from harness events).
    pub(super) model: Option<String>,
    pub(super) usage: Option<UsageInfo>,
    pub(super) turn_state: TurnState,
    pub(super) first_turn_done: bool,
    pub(super) commands: Option<Vec<Command>>,

    // ---- queue ----
    pub(super) queue: std::collections::VecDeque<QueuedTurn>,
    pub(super) holds: HashMap<String, HeldTurn>,
    pub(super) enqueue_counter: u64,
    pub(super) running: bool,
    pub(super) active_cancel: Option<CancellationToken>,
    pub(super) aborted_since_last_drain: bool,
    pub(super) promoted_notice: bool,
    pub(super) active_fork_from_chat_id: Option<String>,

    // ---- PIDs ----
    pub(super) live_pids: HashSet<i32>,

    // ---- ACP connection ----
    pub(super) connection: Option<AcpConnection>,
    pub(super) connection_first_turn_pending: bool,
    pub(super) out_of_band_turn_id: Option<String>,
    pub(super) out_of_band_last_at_ms: u64,

    // ---- notice slot ----
    pub(super) notice_slot: Option<NoticeSlotInner>,
    pub(super) active_notice: Option<NoticeSlotInner>,
    // (The release latch lives on `Inner` as an `AtomicBool`, and the
    // transcript store in `Inner::store` — both hoisted OUT of this struct so
    // a synchronous SQLite write never blocks turn-queue / running-flag /
    // cancel-token / ACP bookkeeping. See `Inner`.)
}

// ---------------------------------------------------------------------------
// Inner (arc payload)
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub(super) struct Inner {
    pub(super) state: Mutex<State>,
    /// The per-session SQLite transcript store, in its OWN lock — deliberately
    /// a sibling of `state`, not a field inside it.
    ///
    /// `persist_event` appends synchronously (SQLite has no async API here). It
    /// used to do that while holding the `state` mutex, which guards the turn
    /// queue, running flag, cancel token, live PIDs and the ACP connection — so
    /// every concurrent WS handler that touched any of those blocked for the
    /// duration of a disk write. The reproducible symptom: `chat:open`'s
    /// snapshot (`read_session_tail` → `tail()`) stalling during a worktree
    /// switch whenever an agent in that worktree was actively streaming.
    ///
    /// The four readers (`read_transcript`/`tail`/`page_before`/`since`) and
    /// both writers now take ONLY this lock. Append ordering and `next_seq`
    /// monotonicity are unchanged — it is still exactly one exclusive lock
    /// guarding the store.
    ///
    /// LOCK ORDER: never acquire `state` while holding this lock (and vice
    /// versa) — every call site takes one, finishes with it, drops it, then
    /// takes the other. `release()` is the one place that cares about both and
    /// it does so sequentially, for the reason documented there.
    ///
    /// `None` after `dispose()`.
    pub(super) store: Mutex<Option<TranscriptStore>>,
    /// Release latch. An `AtomicBool` on `Inner` rather than a `State` field so
    /// that the "is released, then append" pair in `persist_event` stays atomic
    /// now that the append is guarded by `store` instead of `state`:
    /// `persist_event` reads it while holding the store lock, and `release()`
    /// sets it while holding the store lock, so no straggler event from an
    /// unwinding turn can slip in after the latch is set.
    pub(super) released: AtomicBool,
    pub(super) stream: JsonAgentStream,
    pub(super) store_handle: StoreHandle,
    pub(super) broadcaster: Broadcaster,
    pub(super) plugin: Arc<dyn AgentPlugin>,
    /// Immutable configuration
    pub(super) cli: NormalizedEventProvider,
    pub(super) cwd: PathBuf,
    pub(super) data_dir: PathBuf,
    pub(super) system_prompt_file: PathBuf,
    pub(super) daemon_port: u16,
    /// `true` = idle (drain complete). Written by drain loop; read by `settled()`.
    pub(super) drain_tx: watch::Sender<bool>,
}

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

/// Live JSON agent-chat turn engine. `Arc`-wrapped interior-mutable handle per
/// the workspace convention. `Clone` is cheap (Arc clone).
#[derive(Clone, Debug)]
pub struct JsonAgentSession(pub(super) Arc<Inner>);

impl std::fmt::Debug for Inner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self.state.lock().unwrap();
        f.debug_struct("JsonAgentSession::Inner")
            .field("session_id", &state.session.id)
            .field("running", &state.running)
            .field("queue_depth", &state.queue.len())
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

impl JsonAgentSession {
    /// Create a new session from `opts`. Opens the per-session SQLite transcript
    /// store, seeds meta from the transcript tail, and primes `first_turn_done`.
    pub fn new(opts: JsonAgentSessionOptions) -> Self {
        let cwd: PathBuf = match &opts.worktree {
            Some(wt) => {
                let paths = crate::paths::Paths::default();
                paths
                    .project_dir(&opts.project.id)
                    .join("worktrees")
                    .join(&wt.id)
            }
            None => PathBuf::from(&opts.project.absolute_path),
        };

        let data_dir: PathBuf = match &opts.worktree {
            Some(wt) => {
                let paths = crate::paths::Paths::default();
                paths.session_data_dir(&opts.project.id, &wt.id, &opts.session.id)
            }
            None => {
                let paths = crate::paths::Paths::default();
                paths.direct_session_data_dir(&opts.project.id, &opts.session.id)
            }
        };

        let system_prompt_file: PathBuf = match &opts.worktree {
            Some(wt) => {
                let paths = crate::paths::Paths::default();
                paths.system_prompt_path(&opts.project.id, &wt.id, &opts.session.id)
            }
            None => {
                let paths = crate::paths::Paths::default();
                paths.direct_system_prompt_path(&opts.project.id, &opts.session.id)
            }
        };

        // Open the transcript store; create data_dir if needed.
        let _ = std::fs::create_dir_all(&data_dir);
        let store = open_transcript_store(&data_dir, &opts.session.id);

        // Seed display model from requested model, then from transcript tail.
        let meta_tail = store.last_meta();
        let first_turn_done = store.count() > 0;

        let mut model = opts.model.clone();
        if let Some(m) = &meta_tail.model {
            // Transcript's observed model wins unless there's an explicit override.
            if opts.model.is_none() {
                model = Some(m.clone());
            }
        }
        // Session-level model override wins over everything.
        if let Some(ov) = &opts.session.model_override {
            model = Some(ov.clone());
        }

        let commands = meta_tail.commands.clone();
        let usage = meta_tail.usage.clone();

        let (drain_tx, _) = watch::channel(true); // true = idle initially

        let state = State {
            project: opts.project,
            worktree: opts.worktree,
            session: opts.session,
            mode_id: opts.mode_id,
            mode_name: opts.mode_name,
            requested_model: opts.model,
            model,
            usage,
            turn_state: TurnState::Idle,
            first_turn_done,
            commands,
            queue: std::collections::VecDeque::new(),
            holds: HashMap::new(),
            enqueue_counter: 0,
            running: false,
            active_cancel: None,
            aborted_since_last_drain: false,
            promoted_notice: false,
            active_fork_from_chat_id: None,
            live_pids: HashSet::new(),
            connection: None,
            connection_first_turn_pending: false,
            out_of_band_turn_id: None,
            out_of_band_last_at_ms: 0,
            notice_slot: None,
            active_notice: None,
        };

        let inner = Inner {
            state: Mutex::new(state),
            store: Mutex::new(Some(store)),
            released: AtomicBool::new(false),
            stream: JsonAgentStream::new(),
            store_handle: opts.store_handle,
            broadcaster: opts.broadcaster,
            plugin: opts.plugin,
            cli: opts.cli,
            cwd,
            data_dir,
            system_prompt_file,
            daemon_port: opts.daemon_port,
            drain_tx,
        };

        Self(Arc::new(inner))
    }
}

// ---------------------------------------------------------------------------
// Getters (public read-only)
// ---------------------------------------------------------------------------

impl JsonAgentSession {
    pub fn get_cli(&self) -> NormalizedEventProvider {
        self.0.cli
    }

    pub fn get_mode_id(&self) -> Option<String> {
        self.0.state.lock().unwrap().mode_id.clone()
    }

    pub fn get_mode_name(&self) -> Option<String> {
        self.0.state.lock().unwrap().mode_name.clone()
    }

    /// True while turn 1 (system-prompt turn) has not yet completed.
    pub fn is_first_turn_pending(&self) -> bool {
        !self.0.state.lock().unwrap().first_turn_done
    }

    /// True only when NOTHING is in flight (idle gate for channel-toggle).
    pub fn is_idle_for_toggle(&self) -> bool {
        let s = self.0.state.lock().unwrap();
        !s.running && s.turn_state == TurnState::Idle && s.queue.is_empty() && s.holds.is_empty()
    }

    /// Arc-shared stream for WS fan-out.
    pub fn stream(&self) -> &JsonAgentStream {
        &self.0.stream
    }
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

impl JsonAgentSession {
    /// Latest cross-harness meta (rebuilt from session state).
    pub fn get_meta(&self) -> SessionMeta {
        use crate::skill_resolution::merge_with_skill_catalog;
        let s = self.0.state.lock().unwrap();

        let commands = merge_with_skill_catalog(s.commands.as_deref(), true);

        let notice_slot_meta = {
            let slot = s.active_notice.as_ref().or(s.notice_slot.as_ref());
            slot.map(|ns| vst_types::NoticeSlot {
                children: ns.to_btree_map(),
                running: s.active_notice.is_some(),
            })
        };

        SessionMeta {
            session_id: s.session.id.clone(),
            channel: vst_types::Channel::Json,
            mode_id: s.mode_id.clone(),
            mode_name: s.mode_name.clone(),
            cli: provider_str(self.0.cli),
            model: s.model.clone(),
            turn_state: s.turn_state,
            queue_depth: s.queue.len() as i64,
            queued_turn_ids: s.queue.iter().map(|t| t.turn_id.clone()).collect(),
            editing_turn_ids: s.holds.keys().cloned().collect(),
            usage: s.usage.clone(),
            cwd: Some(self.0.cwd.display().to_string()),
            can_steer: Some(
                s.running
                    && s.connection.as_ref().map_or(false, |c| {
                        use crate::acp_transport::AcpTransport;
                        c.is_alive() && c.supports_steering()
                    })
                    && self.0.plugin.supports_mid_turn_steering(),
            ),
            commands,
            notice_slot: notice_slot_meta,
        }
    }

    pub(super) fn emit_meta(&self) {
        let meta = self.get_meta();
        self.0.stream.emit_meta(&meta);
    }

    #[allow(dead_code)]
    pub(super) fn set_turn_state(state: &mut State, ts: TurnState) {
        state.turn_state = ts;
    }

    /// Change the model for subsequent turns (status-bar switcher).
    pub async fn set_model(&self, override_model: Option<String>, mode_default: Option<String>) {
        let requested = override_model.clone().or(mode_default);
        let conn_to_dispose = {
            let mut s = self.0.state.lock().unwrap();
            let changed = s.requested_model != requested;
            s.requested_model = requested.clone();
            s.model = requested;
            if changed {
                s.connection.take()
            } else {
                None
            }
        };
        if let Some(conn) = conn_to_dispose {
            conn.dispose().await;
        }
        self.persist_model_override(override_model).await;
        self.emit_meta();
    }

    /// Persist + broadcast a system annotation event.
    pub fn emit_system_event(&self, payload: EmitSystemEventPayload) {
        let ev = self.new_event(
            NormalizedEventKind::MessageGenerated,
            &mut vst_types::NormalizedEvent {
                text: Some(payload.text),
                subagent_id: Some(payload.subagent_id),
                subagent_name: Some(payload.subagent_name),
                subagent_state: Some(payload.subagent_state),
                ..Default::default()
            },
        );
        self.persist_event(&ev);
        self.0.stream.emit_message(&ev);
    }
}

/// Payload for `emit_system_event`.
pub struct EmitSystemEventPayload {
    pub subagent_id: String,
    pub subagent_name: String,
    pub subagent_state: LifecycleState,
    pub text: String,
}

// ---------------------------------------------------------------------------
// Transcript reads (live session, delegates to the store)
// ---------------------------------------------------------------------------

impl JsonAgentSession {
    /// Is this session's `JsonAgentSession` released (torn down)?
    pub(super) fn is_released(&self) -> bool {
        self.0.released.load(Ordering::SeqCst)
    }

    pub fn read_transcript(&self) -> Vec<NormalizedEvent> {
        let store = self.0.store.lock().unwrap();
        store.as_ref().map_or_else(Vec::new, |st| st.read_all())
    }

    pub fn tail(&self, n_turns: i64) -> TranscriptPage {
        let store = self.0.store.lock().unwrap();
        store.as_ref().map_or(
            TranscriptPage {
                events: Vec::new(),
                oldest_seq: None,
                has_more: false,
            },
            |st| st.tail(n_turns),
        )
    }

    pub fn page_before(&self, before_seq: i64, limit: i64) -> TranscriptPage {
        let store = self.0.store.lock().unwrap();
        store.as_ref().map_or(
            TranscriptPage {
                events: Vec::new(),
                oldest_seq: None,
                has_more: false,
            },
            |st| st.page_before(before_seq, limit),
        )
    }

    pub fn since(&self, since_seq: i64, limit: Option<i64>) -> SincePage {
        let store = self.0.store.lock().unwrap();
        store.as_ref().map_or(
            SincePage {
                events: Vec::new(),
                next_seq: None,
                has_more: false,
            },
            |st| st.since(since_seq, limit),
        )
    }

    /// Backfill terminal-phase turns from the CLI's native store on tty→json toggle.
    pub async fn import_native_history(&self) -> Option<ImportOutcome> {
        let (agent_chat_id, cwd) = {
            let s = self.0.state.lock().unwrap();
            (s.session.agent_chat_id.clone()?, self.0.cwd.clone())
        };

        let cli = provider_str(self.0.cli);
        let importer = get_native_history_importer(&cli)?;

        let watermark = {
            let store = self.0.store.lock().unwrap();
            store.as_ref().and_then(|st| st.get_native_watermark())
        };
        let session_id = self.0.state.lock().unwrap().session.id.clone();

        let req = crate::native_history_importer::NativeImportRequest {
            session_id,
            agent_chat_id,
            cwd: cwd.display().to_string(),
            watermark: watermark.as_ref().map(|w| w.cursor.clone()),
        };
        let result = tokio::task::spawn_blocking(move || importer.import(&req))
            .await
            .ok()?;

        let next_watermark = result.next_watermark;
        let events = result.events;

        let outcome = {
            let mut store = self.0.store.lock().unwrap();
            let opts = vst_store::transcript::ImportOptions {
                cli: cli.clone(),
                cursor: next_watermark,
            };
            store.as_mut()?.import_transaction(events, opts)
        };

        // Rebuild meta so status bar reflects backfilled context.
        self.rebuild_meta_from_transcript();
        self.emit_meta();
        Some(outcome)
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

impl JsonAgentSession {
    /// Close the SQLite handle. Idempotent.
    pub fn dispose(&self) {
        let mut store = self.0.store.lock().unwrap();
        if let Some(store) = store.take() {
            store.close();
        }
    }

    /// Full teardown: latch released, abort + queue clear, wait for drain to
    /// unwind (bounded), tear down ACP connection, close the SQLite handle.
    pub async fn release(&self) {
        // Latch WHILE HOLDING THE STORE LOCK. `persist_event` checks the latch
        // and appends under that same lock, so this keeps "is released, then
        // append" atomic across the state/store lock split: an in-flight
        // append either completes before the latch is set, or observes it and
        // no-ops. Set here and nowhere else, and never while `state` is held
        // (lock order — see `Inner::store`).
        {
            let _store = self.0.store.lock().unwrap();
            if self.0.released.swap(true, Ordering::SeqCst) {
                return;
            }
        }
        {
            let mut s = self.0.state.lock().unwrap();
            s.notice_slot = None;
            s.active_notice = None;
            s.promoted_notice = false;
        }
        self.abort_and_drain();
        // Wait for drain to unwind (bounded).
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(RELEASE_DRAIN_TIMEOUT_MS),
            self.settled(),
        )
        .await;
        // Tear down the ACP connection (Decision 9).
        let conn = {
            let mut s = self.0.state.lock().unwrap();
            s.connection.take()
        };
        if let Some(c) = conn {
            use crate::acp_transport::AcpTransport;
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(RELEASE_DRAIN_TIMEOUT_MS),
                c.dispose(),
            )
            .await;
        }
        self.dispose();
    }

    /// Resolves when the queue has fully drained.
    pub async fn settled(&self) {
        let mut rx = self.0.drain_tx.subscribe();
        // wait_for returns once the value is true (idle)
        let _ = rx.wait_for(|&v| v).await;
    }

    /// Persist lifecycle state for this session (JSON-channel authoritative writer).
    #[allow(dead_code)]
    pub(super) async fn persist_lifecycle(&self, new_state: LifecycleState) {
        let (project_id, session_id) = {
            let s = self.0.state.lock().unwrap();
            (s.project.id.clone(), s.session.id.clone())
        };
        if self.is_released() {
            return;
        }
        let lifecycle = SessionLifecycle {
            state: new_state,
            reason: None,
            last_transition_at: crate::util::now_iso_8601(),
        };
        let _ = self
            .0
            .store_handle
            .update_session_lifecycle(&project_id, &session_id, lifecycle)
            .await;
        self.0.broadcaster.send(ServerEvent::SessionState {
            session_id,
            state: new_state,
            reason: None,
        });
    }

    /// Persist the per-session model override.
    pub(super) async fn persist_model_override(&self, override_model: Option<String>) {
        let (project_id, worktree_id, session_id) = {
            let s = self.0.state.lock().unwrap();
            (
                s.project.id.clone(),
                s.worktree.as_ref().map(|w| w.id.clone()),
                s.session.id.clone(),
            )
        };
        // Update in-memory session record.
        {
            let mut s = self.0.state.lock().unwrap();
            s.session.model_override = override_model.clone();
        }
        let _ = self
            .0
            .store_handle
            .mutate_project(&project_id, move |p| {
                let ov = override_model.clone();
                if let Some(wid) = &worktree_id {
                    for wt in p.worktrees.iter_mut() {
                        if wt.id == *wid {
                            for sess in wt.sessions.iter_mut() {
                                if sess.id == session_id {
                                    sess.model_override = ov.clone();
                                }
                            }
                        }
                    }
                } else {
                    for sess in p.direct_sessions.iter_mut() {
                        if sess.id == session_id {
                            sess.model_override = ov.clone();
                        }
                    }
                }
                Ok(p.clone())
            })
            .await;
    }
}

// ---------------------------------------------------------------------------
// Meta rebuild helper
// ---------------------------------------------------------------------------

impl JsonAgentSession {
    /// Rebuild `usage`/`model`/`commands` from the last usage/result/model/
    /// `commands_update` events in the store.
    pub(super) fn rebuild_meta_from_transcript(&self) {
        let meta = {
            let store = self.0.store.lock().unwrap();
            store.as_ref().map(|st| st.last_meta())
        };
        if let Some(TranscriptMeta {
            model,
            usage,
            commands,
        }) = meta
        {
            let mut s = self.0.state.lock().unwrap();
            if model.is_some() {
                s.model = model;
            }
            if usage.is_some() {
                s.usage = usage;
            }
            if commands.is_some() {
                s.commands = commands;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Notice slot (subagent-ux-v2)
// ---------------------------------------------------------------------------

impl JsonAgentSession {
    /// Populate (or merge into) the notice slot.
    pub fn populate_notice_slot(&self, child_id: String, child_name: String) -> bool {
        {
            let mut s = self.0.state.lock().unwrap();
            if let Some(slot) = s.notice_slot.as_mut() {
                slot.insert(child_id, child_name);
            } else {
                s.notice_slot = Some(NoticeSlotInner::new(child_id, child_name));
            }
        }
        self.emit_meta();
        // Defer kickDrain by one microtask (matches TS `void Promise.resolve().then`)
        let this = self.clone();
        tokio::spawn(async move { this.kick_drain() });
        true
    }

    /// Proactively remove a child from the pending notice slot (R16).
    pub fn prune_notice_slot_child(&self, child_id: &str) {
        let removed = {
            let mut s = self.0.state.lock().unwrap();
            let Some(slot) = s.notice_slot.as_mut() else {
                return;
            };
            let r = slot.remove(child_id);
            if slot.is_empty() {
                s.notice_slot = None;
            }
            r
        };
        if removed {
            self.emit_meta();
        }
    }

    /// "Send now" on the pending notice slot.
    pub fn promote_notice_slot(&self) {
        {
            let mut s = self.0.state.lock().unwrap();
            if s.notice_slot.is_none() {
                return;
            }
            s.promoted_notice = true;
        }
        self.stop_active_turn();
        self.kick_drain();
    }

    /// Dismiss the pending notice slot silently.
    pub fn dismiss_notice_slot(&self) {
        let was_active = {
            let mut s = self.0.state.lock().unwrap();
            s.notice_slot = None;
            s.promoted_notice = false;
            let wa = s.active_notice.is_some();
            wa
        };
        if was_active {
            self.stop_active_turn();
        }
        self.emit_meta();
    }
}

// ---------------------------------------------------------------------------
// Registry constructor (getOrCreateJsonAgentSession)
// ---------------------------------------------------------------------------

/// Get (or lazily create + register) the `JsonAgentSession` for a session.
/// Registered on first turn and reused for later turns.
pub fn get_or_create_json_agent_session(
    registry: &JsonAgentRegistry<JsonAgentSession>,
    opts: JsonAgentSessionOptions,
) -> JsonAgentSession {
    let session_id = opts.session.id.clone();
    // `get_or_insert_with` holds the registry's lock across the whole
    // check-and-construct — see its doc comment for why a separate
    // `get()` ... `set()` here was a lost-update race that could silently
    // build and immediately discard a whole `JsonAgentSession` (with its
    // own turn stream nobody was listening to).
    let session = registry.get_or_insert_with(&session_id, || JsonAgentSession::new(opts));
    (*session).clone()
}

// ---------------------------------------------------------------------------
// Persist event helper (called from events.rs + queue.rs)
// ---------------------------------------------------------------------------

impl JsonAgentSession {
    /// Append an event to the SQLite store. No-op when `released` (handles
    /// straggler events from an unwinding turn after `release()`).
    ///
    /// Takes ONLY the store lock — never `state` — so a synchronous SQLite
    /// write can no longer block turn-queue/cancel-token/ACP bookkeeping. The
    /// `released` check happens under that same lock, which is what keeps it
    /// atomic with the append (see `Inner::released` and `release()`).
    pub(super) fn persist_event(&self, ev: &NormalizedEvent) {
        let mut store = self.0.store.lock().unwrap();
        if self.0.released.load(Ordering::SeqCst) {
            return;
        }
        if let Some(store) = store.as_mut() {
            let mut ev_clone = ev.clone();
            store.append(&mut ev_clone);
        }
    }

    /// Test-only: append through the exact production path (`persist_event`).
    ///
    /// The store/`state` lock split (and the `released` latch that guards it)
    /// can only be exercised by really appending while something else reads or
    /// releases, and every production append path needs a live CLI turn.
    /// Mirrors the `StoreHandle::raw_conn` test-seam precedent in `vst-store`.
    #[doc(hidden)]
    pub fn persist_event_for_test(&self, ev: &NormalizedEvent) {
        self.persist_event(ev);
    }

    /// Test-only: run `f` while holding the session-`state` mutex.
    ///
    /// Lets a test pin the point of item 8: transcript appends and reads take
    /// ONLY the store lock, so they must complete while `state` (turn queue,
    /// running flag, cancel token, ACP connection) is held by someone else.
    #[doc(hidden)]
    pub fn with_state_locked_for_test<T>(&self, f: impl FnOnce() -> T) -> T {
        let _s = self.0.state.lock().unwrap();
        f()
    }

    /// Same as `persist_event` but mutates the event in-place (assigns `log_seq`).
    #[allow(dead_code)]
    pub(super) fn persist_event_mut(&self, ev: &mut NormalizedEvent) {
        let mut store = self.0.store.lock().unwrap();
        if self.0.released.load(Ordering::SeqCst) {
            return;
        }
        if let Some(store) = store.as_mut() {
            store.append(ev);
        }
    }
}

// ---------------------------------------------------------------------------
// Disk-access free functions (no live session)
// ---------------------------------------------------------------------------

/// Open the per-session store from disk, run `f`, and close it.
fn with_disk_store<T>(
    data_dir: &Path,
    session_id: &str,
    f: impl FnOnce(&TranscriptStore) -> T,
    fallback: T,
) -> T {
    let has_db = transcript_db_path(data_dir).exists();
    let has_legacy = data_dir.join("messages.jsonl").exists();
    if !has_db && !has_legacy {
        return fallback;
    }
    let store = open_transcript_store(data_dir, session_id);
    let out = f(&store);
    store.close();
    out
}

/// Read a session's full transcript from disk (no live session).
pub fn read_transcript_from_data_dir(data_dir: &Path, session_id: &str) -> Vec<NormalizedEvent> {
    with_disk_store(data_dir, session_id, |s| s.read_all(), Vec::new())
}

/// Bounded tail-N turns page from disk (no live session).
pub fn read_tail_from_data_dir(data_dir: &Path, session_id: &str, n_turns: i64) -> TranscriptPage {
    with_disk_store(
        data_dir,
        session_id,
        |s| s.tail(n_turns),
        TranscriptPage {
            events: Vec::new(),
            oldest_seq: None,
            has_more: false,
        },
    )
}

/// Keyset "load earlier" page from disk (no live session).
pub fn read_page_before_from_data_dir(
    data_dir: &Path,
    session_id: &str,
    before_seq: i64,
    limit: i64,
) -> TranscriptPage {
    with_disk_store(
        data_dir,
        session_id,
        |s| s.page_before(before_seq, limit),
        TranscriptPage {
            events: Vec::new(),
            oldest_seq: None,
            has_more: false,
        },
    )
}

/// Reconnect delta from disk (no live session).
pub fn read_since_from_data_dir(data_dir: &Path, session_id: &str, since_seq: i64) -> SincePage {
    with_disk_store(
        data_dir,
        session_id,
        |s| s.since(since_seq, None),
        SincePage {
            events: Vec::new(),
            next_seq: None,
            has_more: false,
        },
    )
}

/// Bounded last model + last real usage from disk (no live session).
pub fn read_meta_from_data_dir(data_dir: &Path, session_id: &str) -> TranscriptMeta {
    with_disk_store(
        data_dir,
        session_id,
        |s| s.last_meta(),
        TranscriptMeta::default(),
    )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert `NormalizedEventProvider` to its snake_case string representation
/// (matching the wire format). Used for `SessionMeta.cli` and
/// `NormalizedEvent.provider` string comparisons.
pub(crate) fn provider_str(p: NormalizedEventProvider) -> String {
    match p {
        NormalizedEventProvider::Claude => "claude".to_string(),
        NormalizedEventProvider::Cursor => "cursor".to_string(),
        NormalizedEventProvider::Opencode => "opencode".to_string(),
        NormalizedEventProvider::Agy => "agy".to_string(),
    }
}

/// Current wall-clock milliseconds (for out-of-band burst gap check).
#[allow(dead_code)]
pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
