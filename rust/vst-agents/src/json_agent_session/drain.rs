//! `JsonAgentSession` drain loop — the sequential turn runner.
//!
//! **Invariant (steer-on-ready):** a queued turn is steered into the running
//!   turn at the first moment it can be (`steer_queued_head`, on prompt
//!   dispatch); otherwise it runs here, when the turn ends.
//! **Invariant (R5b):** Human queue always drains before the notice slot fires.
//! **Invariant (FIX-G):** `aborted_since_last_drain` prevents the notice slot
//!   from firing immediately after a user-initiated abort.
//! **Invariant (FIX-G2):** `broke_for_abort` suppresses the final notice-slot
//!   re-kick after the drain exits on an abort.

use tokio_util::sync::CancellationToken;
use vst_types::{LifecycleState, NormalizedEvent, NormalizedEventKind, TurnState};

use super::{events::EmitUserEventOpts, JsonAgentSession, QueuedTurn};
use crate::json_agent_chat::{BACKGROUND_REASON, SUBAGENT_NOTICE_REASON};
use crate::{
    plugin::{TurnContext, TurnInput},
    skill_resolution::{get_merged_skill_catalog, inject_attachments, resolve_skill_invocations},
};

/// R9: a child still counts as "waiting for the human" when it is
/// `WaitingForHuman`, or `Working` only because of an out-of-band
/// (`background`) window — that transition is invisible to parent notify.
fn counts_as_waiting(l: &vst_types::SessionLifecycle) -> bool {
    l.state == LifecycleState::WaitingForHuman
        || (l.state == LifecycleState::Working && l.reason.as_deref() == Some(BACKGROUND_REASON))
}

impl JsonAgentSession {
    /// Outer drain loop: runs turns from the queue + notice slot in order.
    /// Called by `kick_drain()` in a spawned task; owns `running=true`.
    pub(super) async fn drain_loop(&self) {
        // FIX-G: reset the abort flag at the start of every drain cycle.
        {
            let mut s = self.0.state.lock().unwrap();
            s.aborted_since_last_drain = false;
        }
        let mut broke_for_abort = false;

        // Outer loop: human queue first, then notice slot. Re-checks both each
        // iteration so a notice slot that arrives during human-queue drain is
        // still consumed before we exit.
        loop {
            let (has_queue, has_notice, promoted) = {
                let s = self.0.state.lock().unwrap();
                (
                    !s.queue.is_empty(),
                    s.notice_slot.is_some(),
                    s.promoted_notice,
                )
            };

            if !has_queue && !has_notice {
                break;
            }

            // Promoted notice: run it immediately (ahead of the human queue).
            if promoted && has_notice {
                {
                    let mut s = self.0.state.lock().unwrap();
                    s.promoted_notice = false;
                    s.aborted_since_last_drain = false;
                }
                self.run_notice_slot_turn().await;
                continue;
            }

            // Drain the human queue entirely before the notice slot (R5b).
            loop {
                let (promoted_now, has_notice_now) = {
                    let s = self.0.state.lock().unwrap();
                    (s.promoted_notice, s.notice_slot.is_some())
                };
                if promoted_now && has_notice_now {
                    break;
                }
                let turn = {
                    let mut s = self.0.state.lock().unwrap();
                    s.queue.pop_front()
                };
                let Some(turn) = turn else { break };
                // Persist the human turn's `user` event at POP time (Decision 1),
                // so its `logSeq` ordering key is minted now — after every event
                // already persisted — not at enqueue time. Must NOT live inside
                // `run_one_turn`: the notice-slot path calls that directly and
                // already emits its own (silent) user event before it.
                self.emit_user_event(
                    &turn.turn_id,
                    &turn.raw_message,
                    &turn.attachments,
                    EmitUserEventOpts {
                        silent: turn.silent,
                        mentions: turn.mentions.clone(),
                        ..Default::default()
                    },
                );
                self.run_one_turn(turn).await;
            }

            // Check again for a notice promoted during the inner drain.
            let (promoted_now, has_notice_now) = {
                let s = self.0.state.lock().unwrap();
                (s.promoted_notice, s.notice_slot.is_some())
            };
            if promoted_now && has_notice_now {
                {
                    let mut s = self.0.state.lock().unwrap();
                    s.promoted_notice = false;
                    s.aborted_since_last_drain = false;
                }
                self.run_notice_slot_turn().await;
                continue;
            }

            // FIX-G: if a user-initiated abort happened during the human queue,
            // skip the notice slot for now — it survives (R14) and fires on
            // the next kickDrain, not immediately after a Stop.
            let aborted = {
                let mut s = self.0.state.lock().unwrap();
                let a = s.aborted_since_last_drain;
                s.aborted_since_last_drain = false;
                a
            };
            if aborted {
                let has_queue = !self.0.state.lock().unwrap().queue.is_empty();
                if has_queue {
                    continue;
                }
                broke_for_abort = true;
                break;
            }

            // Consume the notice slot if still present.
            let still_has_notice = self.0.state.lock().unwrap().notice_slot.is_some();
            if still_has_notice {
                self.run_notice_slot_turn().await;
            }
        }

        // --- Finally block ---
        {
            let mut s = self.0.state.lock().unwrap();
            s.running = false;
            if !s.queue.is_empty() {
                s.turn_state = TurnState::Queued;
            } else if s.turn_state != TurnState::Error {
                s.turn_state = TurnState::Idle;
            }
        }
        self.emit_meta();

        // Persist lifecycle → waiting_for_human (Decision 11). The lifecycle
        // poller skips JSON sessions, so this is the only mechanism. Written
        // under `lifecycle_lock`: if a newer drain already started, it owns the
        // final write; if out-of-band content arrived since `running=false`,
        // write the plain waiting then re-enter `working(background)`, and let the
        // quiet timer settle.
        {
            let _guard = self.0.lifecycle_lock.lock().await;
            let (running, bg) = {
                let s = self.0.state.lock().unwrap();
                (s.running, s.bg_working)
            };
            if !running {
                // The turn's real end is always written (reason `None`, visible
                // to parent notify: "subagent finished"). If an out-of-band
                // window opened in the tail, re-enter `working(background)`
                // right after — both reasons `background*` are silent to the
                // notify listener, so skipping the plain write would hide this
                // turn end from the parent (R1F-12).
                self.write_lifecycle_locked(LifecycleState::WaitingForHuman, None)
                    .await;
                // Re-read: `note_background_activity` does not take `lifecycle_lock`, so a chunk can land
                // between the read above and the plain write (it would then see `last_written == Working`
                // and skip its own write), leaving the session showing waiting while output flows.
                let bg_now = bg || self.0.state.lock().unwrap().bg_working;
                if bg_now {
                    self.write_lifecycle_locked(LifecycleState::Working, Some(BACKGROUND_REASON))
                        .await;
                }
            }
        }

        // Signal idle — but only if no new drain started while we awaited the
        // persist above (`kick_drain` sets `running` and signals busy under this
        // same lock); otherwise we'd overwrite its "busy" with a stale "idle".
        {
            let s = self.0.state.lock().unwrap();
            if !s.running {
                self.0.drain_tx.send_replace(true);
            }
        }

        // KD-2 race fix: if a notice slot arrived while the finally block was
        // awaiting persistLifecycle, re-kick drain. FIX-G2: only if we did NOT
        // break for an abort — otherwise the slot waits for the next
        // user interaction, defeating FIX-G.
        // Also re-kick drain if human queue has turns (prevent queue starvation).
        let (has_queue, still_has_notice) = {
            let s = self.0.state.lock().unwrap();
            (!s.queue.is_empty(), s.notice_slot.is_some())
        };
        if has_queue || (still_has_notice && !broke_for_abort) {
            self.kick_drain();
        }
    }

    /// Run one complete turn (human message).
    pub(super) async fn run_one_turn(&self, turn: QueuedTurn) {
        // Check whether the plugin supports run_turn.
        if !self.0.plugin.supports_acp() {
            let mut ev = NormalizedEvent::default();
            ev.turn_id = Some(turn.turn_id.clone());
            ev.text = Some(format!(
                "Plugin '{}' does not support the JSON channel",
                "unknown" // plugin name not exposed as a trait method
            ));
            let mut ev = self.new_event(NormalizedEventKind::Error, &mut ev);
            self.persist_event(&mut ev);
            self.0.stream.emit_message(&ev);
            {
                let mut s = self.0.state.lock().unwrap();
                s.turn_state = TurnState::Error;
            }
            self.emit_meta();
            return;
        }

        let cancel = CancellationToken::new();
        let dispatched = std::sync::Arc::new(tokio::sync::Notify::new());
        {
            let mut s = self.0.state.lock().unwrap();
            s.active_turn = Some(super::ActiveTurn {
                turn_id: turn.turn_id.clone(),
                cancel: cancel.clone(),
                prompt_dispatched: false,
                steer_wake: dispatched.clone(),
            });
            // A real turn closes any open out-of-band burst.
            s.out_of_band_turn_id = None;
            s.turn_state = TurnState::Thinking;
        }
        self.emit_meta();

        // Resolve skill invocations at RUN time (never enqueue time — A1).
        let (project, worktree, session, requested_model, first_turn_done, fork_from_chat_id) = {
            let s = self.0.state.lock().unwrap();
            (
                s.project.clone(),
                s.worktree.clone(),
                s.session.clone(),
                s.requested_model.clone(),
                s.first_turn_done,
                turn.fork_from_chat_id.clone(),
            )
        };

        let merged_catalog = {
            let s = self.0.state.lock().unwrap();
            let cmds = s.commands.clone().unwrap_or_default();
            get_merged_skill_catalog(&cmds)
        };
        let result = resolve_skill_invocations(&turn.raw_message, &merged_catalog);
        let resolved_message = result.message;
        let skill_invocations: Vec<crate::plugin::SkillInvocation> = result
            .skill_invocations
            .into_iter()
            .map(|r| crate::plugin::SkillInvocation {
                name: r.name,
                args: r.args,
                path: r.path,
            })
            .collect();

        // Build TurnInput (A1: inject attachment paths into resolved message).
        let message = inject_attachments(
            &resolved_message,
            &turn.attachments,
            !skill_invocations.is_empty(),
        );
        let message = crate::mention_context::append_mention_block(
            message,
            &turn.mentions,
            &self.0.store_handle,
            &self.0.paths,
        )
        .await;
        let attachment_paths: Vec<String> =
            turn.attachments.iter().map(|a| a.path.clone()).collect();
        let input = TurnInput {
            message,
            attachment_paths,
            is_first_turn: !first_turn_done,
            skill_invocations: if skill_invocations.is_empty() {
                None
            } else {
                Some(skill_invocations)
            },
        };

        // Set active_fork_from_chat_id so handle_event adopts the new forked id.
        {
            let mut s = self.0.state.lock().unwrap();
            s.active_fork_from_chat_id = fork_from_chat_id.clone();
        }

        // Build TurnContext.
        let this_clone = self.clone();
        let get_acp_connection: crate::plugin::GetAcpConnection =
            std::sync::Arc::new(move |spec, enrich| {
                let session = this_clone.clone();
                Box::pin(async move { session.get_or_create_connection(spec, enrich).await })
            });

        let on_spawn: Option<crate::plugin::OnSpawn> = {
            let this = self.clone();
            Some(std::sync::Arc::new(move |pid: u32| {
                let pid_file = this.0.data_dir.join("turn.pids");
                let pids = {
                    let mut s = this.0.state.lock().unwrap();
                    s.live_pids.insert(pid as i32);
                    s.live_pids.iter().copied().collect::<Vec<_>>()
                };
                super::pids::write_pid_file(&pid_file, &pids);
            }))
        };

        // Prompt-dispatch signal: flips `can_steer` and wakes the select below
        // to steer the queue head (CLI-agnostic — fired by `run_turn_acp`).
        let on_prompt_dispatched: Option<crate::plugin::OnPromptDispatched> = {
            let this = self.clone();
            let notify = dispatched.clone();
            let turn_id = turn.turn_id.clone();
            Some(std::sync::Arc::new(move || {
                {
                    let mut s = this.0.state.lock().unwrap();
                    match s.active_turn.as_mut() {
                        Some(t) if t.turn_id == turn_id => t.prompt_dispatched = true,
                        _ => return,
                    }
                }
                this.emit_meta();
                notify.notify_one();
            }))
        };

        let ctx = TurnContext {
            cwd: self.0.cwd.clone(),
            project,
            worktree,
            session,
            chat_id: {
                let s = self.0.state.lock().unwrap();
                s.session.agent_chat_id.clone()
            },
            fork_from_chat_id,
            model: requested_model,
            system_prompt_file: self.0.system_prompt_file.clone(),
            daemon_port: self.0.daemon_port,
            on_spawn,
            on_prompt_dispatched,
            get_acp_connection,
        };

        // Drive the turn.
        let mut receiver = self.0.plugin.run_turn(input, ctx, cancel.clone());
        let mut saw_result = false;

        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => { break; }
                _ = dispatched.notified() => {
                    self.steer_queued_head(&cancel).await;
                }
                maybe_ev = receiver.recv() => {
                    let Some(mut ev) = maybe_ev else { break; };
                    if cancel.is_cancelled() { break; }
                    if ev.kind == NormalizedEventKind::Result {
                        saw_result = true;
                    }
                    ev.turn_id = Some(turn.turn_id.clone());
                    ev.session_id = self.0.state.lock().unwrap().session.id.clone();
                    self.handle_event(&mut ev).await;
                }
            }
        }

        // Only a turn that reached `result` without abort counts as turn-1 done.
        if !cancel.is_cancelled() || saw_result {
            let mut s = self.0.state.lock().unwrap();
            s.first_turn_done = true;
        }

        // Decision 6 Option B: capture native chat id after the first result.
        let supports_acp = self.0.plugin.supports_acp();
        if saw_result && supports_acp {
            self.maybe_capture_native_chat_id().await;
        }

        // Finally: emit stopped marker if aborted before result (and not a notice turn).
        let is_notice_turn = self.0.state.lock().unwrap().active_notice.is_some();
        if cancel.is_cancelled() && !saw_result && !is_notice_turn {
            self.emit_stopped(&turn.turn_id);
        }
        {
            let mut s = self.0.state.lock().unwrap();
            s.active_turn = None;
            s.active_fork_from_chat_id = None;
            s.live_pids.clear();
        }
        // A turn that ended (result, cancel, crash) can no longer finish its
        // synchronous subagents.
        self.0.tasks.turn_ended(&turn.turn_id);
        // Clear pid file on turn completion.
        super::pids::clear_pid_file(&self.0.data_dir);
    }

    /// Run the notice slot turn (subagent-ux-v2 aggregated message).
    async fn run_notice_slot_turn(&self) {
        let slot = {
            let mut s = self.0.state.lock().unwrap();
            s.notice_slot.take()
        };
        let Some(slot) = slot else { return };

        // R9: prune children no longer waiting_for_human at run time.
        let projects = self.0.store_handle.get_all_projects().await;
        let mut pruned = super::NoticeSlotInner { children: vec![] };
        for (child_id, child_name) in &slot.children {
            let mut found = false;
            'outer: for project in &projects {
                for wt in &project.worktrees {
                    if let Some(s) = wt.sessions.iter().find(|s| s.id == *child_id) {
                        if counts_as_waiting(&s.lifecycle) {
                            pruned.children.push((child_id.clone(), child_name.clone()));
                        }
                        found = true;
                        break 'outer;
                    }
                }
                if let Some(s) = project.direct_sessions.iter().find(|s| s.id == *child_id) {
                    if counts_as_waiting(&s.lifecycle) {
                        pruned.children.push((child_id.clone(), child_name.clone()));
                    }
                    found = true;
                    break;
                }
            }
            // Defensive: not found in store → keep (may be a very fresh session).
            if !found {
                pruned.children.push((child_id.clone(), child_name.clone()));
            }
        }

        if pruned.is_empty() {
            self.emit_meta();
            return;
        }

        let child_names: Vec<&str> = pruned.children.iter().map(|(_, n)| n.as_str()).collect();
        let child_list = child_names.join(", ");
        let notice_text = if child_names.len() == 1 {
            format!("{child_list} is waiting for your reply")
        } else {
            format!("{child_list} are waiting for your reply")
        };

        // Wire form (skill grammar) for BOTH the transcript row and the turn:
        // `run_one_turn` un-escapes it, so the agent sees `notice_text`
        // verbatim and a child name like `{/x y}` is never parsed as a token.
        let wire_notice = crate::skill_tokens::escape_skill_text(&notice_text);

        // Emit notification pill(s) for the children when the notice turn is dequeued
        for (child_id, child_name) in &pruned.children {
            self.emit_system_event(super::EmitSystemEventPayload {
                subagent_id: child_id.clone(),
                subagent_name: child_name.clone(),
                subagent_state: LifecycleState::WaitingForHuman,
                text: String::new(),
            });
        }

        let turn_id = crate::util::new_uuid_v4();

        // KD-4: emit the silent user event BEFORE run_one_turn.
        self.emit_user_event(
            &turn_id,
            &wire_notice,
            &[],
            super::events::EmitUserEventOpts {
                silent: true,
                ..Default::default()
            },
        );

        // Move to active state.
        {
            let mut s = self.0.state.lock().unwrap();
            s.active_notice = Some(pruned);
        }
        self.emit_meta();

        // A: the daemon-started notice turn is real work — show `working`
        // (the drain's final write is the bound).
        self.write_lifecycle(LifecycleState::Working, Some(SUBAGENT_NOTICE_REASON))
            .await;

        let synthetic_turn = QueuedTurn {
            turn_id: turn_id.clone(),
            enqueue_order: {
                let mut s = self.0.state.lock().unwrap();
                let o = s.enqueue_counter;
                s.enqueue_counter += 1;
                o
            },
            // `run_one_turn` un-escapes wire-form text; escape the daemon-made
            // notice (it embeds user-set child names, e.g. `{/x y}`) so it
            // round-trips verbatim and can never parse as a skill token.
            raw_message: wire_notice,
            attachments: vec![],
            silent: true,
            fork_from_chat_id: None,
            mentions: vec![],
        };

        // Run the notice turn. A dismiss while running aborts it via stop_active_turn.
        self.run_one_turn(synthetic_turn).await;

        {
            let mut s = self.0.state.lock().unwrap();
            s.active_notice = None;
        }
        self.emit_meta();
    }

    /// Append + broadcast a synthetic terminal marker for a stopped/aborted turn.
    fn emit_stopped(&self, turn_id: &str) {
        let mut ev = NormalizedEvent::default();
        ev.turn_id = Some(turn_id.to_string());
        ev.text = Some("Turn stopped".to_string());
        let mut ev = self.new_event(NormalizedEventKind::Status, &mut ev);
        self.persist_event(&mut ev);
        self.0.stream.emit_message(&ev);
    }

    /// Record + persist a live turn PID.
    #[allow(dead_code)]
    pub(super) fn record_turn_pid(&self, pid: i32) {
        let pid_file = self.0.data_dir.join("turn.pids");
        let pids = {
            let mut s = self.0.state.lock().unwrap();
            s.live_pids.insert(pid);
            s.live_pids.iter().copied().collect::<Vec<_>>()
        };
        super::pids::write_pid_file(&pid_file, &pids);
    }

    /// Kill all live PIDs and clear tracking.
    #[allow(dead_code)]
    pub(super) async fn kill_live_pids(&self) {
        let pids: Vec<i32> = {
            let s = self.0.state.lock().unwrap();
            s.live_pids.iter().copied().collect()
        };
        for pid in pids {
            super::pids::kill_process_tree(std::iter::once(pid));
        }
        {
            let mut s = self.0.state.lock().unwrap();
            s.live_pids.clear();
        }
        super::pids::clear_pid_file(&self.0.data_dir.join("turn.pids"));
    }

    /// Clear PID tracking for a completed turn.
    #[allow(dead_code)]
    pub(super) fn clear_turn_pids(&self) {
        {
            let mut s = self.0.state.lock().unwrap();
            s.live_pids.clear();
        }
        super::pids::clear_pid_file(&self.0.data_dir.join("turn.pids"));
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::time::Duration;

    use agent_client_protocol::schema::v1::{
        ContentBlock, ContentChunk, SessionUpdate, TextContent,
    };
    use tokio::sync::{broadcast, mpsc, Notify};
    use tokio_util::sync::CancellationToken;
    use vst_types::{
        Broadcaster, Channel, LifecycleState, NormalizedEvent, NormalizedEventKind, ServerEvent,
    };

    use super::super::{JsonAgentSession, JsonAgentSessionOptions};
    use crate::json_agent_chat::BACKGROUND_REASON;
    use crate::plugin::{
        AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
        PromptDelivery, ReadySignal, TurnContext, TurnInput,
    };

    struct Gated(Arc<Notify>);

    impl AgentPlugin for Gated {
        fn name(&self) -> &str {
            "gated"
        }
        fn default_model(&self) -> &str {
            "m"
        }
        fn default_mode_icon(&self, _m: Option<&str>) -> &'static str {
            "m"
        }
        fn prompt_delivery(&self) -> PromptDelivery {
            PromptDelivery::Inline
        }
        fn get_launch_command(&self, _c: &LaunchConfig) -> Vec<String> {
            vec![]
        }
        fn get_environment(&self, _c: &LaunchConfig) -> BTreeMap<String, String> {
            BTreeMap::new()
        }
        fn get_ready_signal(&self) -> ReadySignal {
            ReadySignal {
                sentinel: None,
                fallback_ms: 0,
            }
        }
        fn compose_launch_prompt(&self, _i: ComposePromptInput) -> ComposePromptResult {
            ComposePromptResult::default()
        }
        fn default_channel(&self) -> Channel {
            Channel::Json
        }
        fn list_models(&self) -> crate::plugin::AsyncResult<ListModelsResult> {
            Box::pin(async { ListModelsResult::default() })
        }
        fn supports_json(&self) -> bool {
            true
        }
        fn supports_acp(&self) -> bool {
            true
        }
        fn run_turn(
            &self,
            _i: TurnInput,
            _c: TurnContext,
            cancel: CancellationToken,
        ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
            let (tx, rx) = mpsc::unbounded_channel();
            let gate = self.0.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = cancel.cancelled() => {}
                    _ = gate.notified() => {
                        let mut ev = NormalizedEvent::default();
                        ev.kind = NormalizedEventKind::Result;
                        let _ = tx.send(ev);
                    }
                }
            });
            rx
        }
    }

    fn session_record() -> vst_types::SessionRecord {
        vst_types::SessionRecord {
            id: "s1".into(),
            worktree_id: None,
            project_id: "p1".into(),
            is_main: false,
            sort_order: 0.0,
            r#type: vst_types::SessionType::Agent,
            mode_id: None,
            mode_icon: None,
            name: None,
            name_source: None,
            tmux_name: "vst-s1".into(),
            use_tmux: true,
            channel: None,
            lifecycle: vst_types::SessionLifecycle {
                state: LifecycleState::WaitingForHuman,
                reason: None,
                last_transition_at: "2026-01-01T00:00:00.000Z".into(),
            },
            transcript_ref: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            initial_prompt: None,
            draft_prompt: None,
            draft_config: None,
            archived_at: None,
            handoff_summary: None,
            carry_over: None,
            parent_session_id: None,
            superseded_by: None,
            pr: None,
            last_activity_at: None,
            last_line: None,
            last_tool: None,
        }
    }

    fn project_record() -> vst_types::ProjectRecord {
        vst_types::ProjectRecord {
            id: "p1".into(),
            absolute_path: "/repos/p1".into(),
            prefix: "vs".into(),
            is_git: true,
            default_branch: Some("main".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            hidden: None,
            direct_sessions: vec![],
            direct_session_seq: None,
            worktrees: vec![],
            next_worktree_num: None,
            lsp_enabled: None,
            open_files: vec![],
        }
    }

    fn lifecycle_events(
        rx: &mut broadcast::Receiver<ServerEvent>,
    ) -> Vec<(LifecycleState, Option<String>)> {
        let mut out = vec![];
        while let Ok(ev) = rx.try_recv() {
            if let ServerEvent::SessionState { state, reason, .. } = ev {
                out.push((state, reason));
            }
        }
        out
    }

    /// R1F-12 — an out-of-band window opening between `running=false` and the
    /// drain's final write must still emit the turn's plain
    /// `waiting_for_human` (None) BEFORE `working(background)`, so the parent
    /// notify listener (which ignores `background*`) sees the turn end.
    #[tokio::test]
    async fn bg_in_drain_tail_emits_plain_waiting_before_background_working() {
        let dir = tempfile::tempdir().unwrap();
        let _home = crate::home::with_home(dir.path().to_path_buf());
        let store = vst_store::StoreHandle::open(dir.path().join("t.db")).unwrap();
        let (tx, mut rx) = broadcast::channel(64);
        let gate = Arc::new(Notify::new());
        let mut rec = session_record();
        rec.lifecycle.state = LifecycleState::WaitingForHuman;
        let s = JsonAgentSession::new(JsonAgentSessionOptions {
            project: project_record(),
            worktree: None,
            session: rec,
            plugin: Arc::new(Gated(gate.clone())),
            daemon_port: 0,
            cli: vst_types::NormalizedEventProvider::Claude,
            model: None,
            mode_id: None,
            mode_name: None,
            store_handle: store,
            broadcaster: Broadcaster(tx),
        });
        s.enqueue("hi".into(), vec![], None, None);
        s.kick_drain();
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(s.0.state.lock().unwrap().running, "turn must be in flight");
        let _ = lifecycle_events(&mut rx);

        // Hold the lifecycle lock so the drain parks right after running=false.
        let guard = s.0.lifecycle_lock.lock().await;
        gate.notify_one();
        for _ in 0..400 {
            if !s.0.state.lock().unwrap().running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            !s.0.state.lock().unwrap().running,
            "drain must have finished its turn"
        );
        // OOB content lands in the tail window (running=false, final write pending).
        s.ingest_out_of_band_update(
            &SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("late"),
            ))),
            "acp",
            None,
        );
        assert!(s.0.state.lock().unwrap().bg_working);
        drop(guard);
        tokio::time::sleep(Duration::from_millis(300)).await;

        let seen = lifecycle_events(&mut rx);
        let pos_plain = seen
            .iter()
            .position(|e| *e == (LifecycleState::WaitingForHuman, None))
            .unwrap_or_else(|| panic!("no plain waiting in {seen:?}"));
        let pos_bg = seen
            .iter()
            .position(|e| *e == (LifecycleState::Working, Some(BACKGROUND_REASON.to_string())))
            .unwrap_or_else(|| panic!("no background working in {seen:?}"));
        assert!(pos_plain < pos_bg, "got {seen:?}");
        assert_eq!(seen.last().unwrap().1.as_deref(), Some(BACKGROUND_REASON));
    }
}
