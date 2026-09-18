//! `JsonAgentSession` drain loop — the sequential turn runner.
//!
//! **Invariant (R5b):** Human queue always drains before the notice slot fires.
//! **Invariant (FIX-G):** `aborted_since_last_drain` prevents the notice slot
//!   from firing immediately after a user-initiated abort.
//! **Invariant (FIX-G2):** `broke_for_abort` suppresses the final notice-slot
//!   re-kick after the drain exits on an abort.

use tokio_util::sync::CancellationToken;
use vst_types::{LifecycleState, NormalizedEvent, NormalizedEventKind, TurnState};

use super::{JsonAgentSession, QueuedTurn};
use crate::{
    plugin::{TurnContext, TurnInput},
    skill_resolution::{inject_attachments, resolve_skill_invocations},
    user_skill_catalog::get_merged_skill_catalog,
};

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
        // poller skips JSON sessions, so this is the only mechanism.
        self.persist_lifecycle(LifecycleState::WaitingForHuman)
            .await;

        // Signal idle to any settled() waiter.
        let _ = self.0.drain_tx.send(true);

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
        {
            let mut s = self.0.state.lock().unwrap();
            s.active_cancel = Some(cancel.clone());
            // A real turn closes any open out-of-band burst.
            s.out_of_band_turn_id = None;
        }
        {
            let mut s = self.0.state.lock().unwrap();
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
            get_acp_connection,
        };

        // Drive the turn.
        let mut receiver = self.0.plugin.run_turn(input, ctx, cancel.clone());
        let mut saw_result = false;

        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => { break; }
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
            s.active_cancel = None;
            s.active_fork_from_chat_id = None;
            s.live_pids.clear();
        }
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
                        if s.lifecycle.state == LifecycleState::WaitingForHuman {
                            pruned.children.push((child_id.clone(), child_name.clone()));
                        }
                        found = true;
                        break 'outer;
                    }
                }
                if let Some(s) = project.direct_sessions.iter().find(|s| s.id == *child_id) {
                    if s.lifecycle.state == LifecycleState::WaitingForHuman {
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
            &notice_text,
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

        let synthetic_turn = QueuedTurn {
            turn_id: turn_id.clone(),
            enqueue_order: {
                let mut s = self.0.state.lock().unwrap();
                let o = s.enqueue_counter;
                s.enqueue_counter += 1;
                o
            },
            raw_message: notice_text,
            attachments: vec![],
            fork_from_chat_id: None,
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
