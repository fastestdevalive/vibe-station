//! `JsonAgentSession` turn-queue methods — enqueue, submit, abort_and_drain,
//! stop_active_turn, cancel_queued_turn, begin_edit_queued_turn,
//! resubmit_queued_turn, fork_turn, promote_queued_turn, kick_drain,
//! sync_idle_state.
//!
//! **Invariant:** turn ordering must survive cancel/promote/edit races — always
//! re-derive insert position from `ahead_ids`, never trust a cached index.

use vst_types::{Attachment, TurnState};

use super::{events::EmitUserEventOpts, JsonAgentSession, QueuedTurn, State};
use crate::{acp_transport::AcpTransport, util::new_uuid_v4};

/// Return value of `enqueue()`.
pub struct EnqueueResult {
    pub turn_id: String,
    pub queue_position: usize,
}

/// Return value of `submit()`.
pub struct SubmitResult {
    pub turn_id: String,
    pub queue_position: usize,
    pub delivery: SubmitDelivery,
}

pub enum SubmitDelivery {
    Queued,
    Steered,
}

/// Return value of `fork_turn()`.
pub enum ForkResult {
    Ok {
        turn_id: String,
        superseded_turn_ids: Vec<String>,
    },
    NotFound,
}

impl JsonAgentSession {
    /// Enqueue a human turn and kick the drain loop. Synthesizes the daemon-owned
    /// `user` event immediately (Decision 12) before pushing to the queue.
    ///
    /// If `system_prompt` is provided, writes it to the session's system-prompt
    /// file before the turn runs (it is applied at run time, not here — A1).
    pub fn enqueue(
        &self,
        message: String,
        attachments: Vec<Attachment>,
        system_prompt: Option<String>,
        fork_from_chat_id: Option<String>,
    ) -> EnqueueResult {
        // Optionally write the system prompt file now (idempotent for later turns).
        if let Some(sp) = system_prompt {
            let _ = std::fs::create_dir_all(&self.0.data_dir);
            let _ = std::fs::write(&self.0.system_prompt_file, sp);
        }

        let turn_id = new_uuid_v4();
        let queue_position = {
            let s = self.0.state.lock().unwrap();
            s.queue.len() + if s.running { 1 } else { 0 }
        };

        // Decision 12 — daemon-owned user event (raw text, attachments as chips).
        self.emit_user_event(
            &turn_id,
            &message,
            &attachments,
            EmitUserEventOpts::default(),
        );

        {
            let mut s = self.0.state.lock().unwrap();
            let order = s.enqueue_counter;
            s.enqueue_counter += 1;
            s.queue.push_back(QueuedTurn {
                turn_id: turn_id.clone(),
                enqueue_order: order,
                raw_message: message,
                attachments,
                fork_from_chat_id,
            });
            // Only flip to Queued when nothing is running. While a turn is
            // actively streaming (`s.running`), `queue_position` is always
            // >= 1 (the active turn counts as position 1), so clobbering
            // `turn_state` here would wrongly mask the running turn's real
            // state (Thinking/Responding/Tool) as "paused/Queued". In that
            // case `queue_depth` (s.queue.len(), sent via SessionMeta)
            // already communicates how many are queued; leave turn_state
            // untouched. Mirrors sync_idle_state_inner's `if s.running`.
            if !s.running && queue_position > 0 {
                s.turn_state = TurnState::Queued;
            }
        }
        self.emit_meta();
        self.kick_drain();
        EnqueueResult {
            turn_id,
            queue_position,
        }
    }

    /// Submit a user turn, steering it mid-turn when possible. Steers iff ALL
    /// are true: running, active_cancel not cancelled, queue empty, no
    /// attachments, not first turn pending, and the connection is alive and
    /// supports steering.
    pub async fn submit(
        &self,
        message: String,
        attachments: Vec<Attachment>,
        system_prompt: Option<String>,
        fork_from_chat_id: Option<String>,
    ) -> SubmitResult {
        let can_attempt_steer = {
            let s = self.0.state.lock().unwrap();
            s.running
                && s.active_cancel
                    .as_ref()
                    .map_or(false, |c| !c.is_cancelled())
                && s.queue.is_empty()
                && attachments.is_empty()
                && s.first_turn_done
                && s.connection.as_ref().map_or(false, |c| c.is_alive())
                && s.connection
                    .as_ref()
                    .map_or(false, |c| c.supports_steering())
                && self.0.plugin.supports_mid_turn_steering()
        };

        if can_attempt_steer {
            // Read the connection handle without holding the lock across .await.
            let conn = self.0.state.lock().unwrap().connection.clone();
            if let Some(conn) = conn {
                use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
                let blocks = vec![ContentBlock::Text(TextContent::new(message.clone()))];
                use crate::acp_transport::SteerOutcome;
                let outcome = conn.steer(blocks).await;
                if matches!(outcome, SteerOutcome::Injected) {
                    let turn_id = new_uuid_v4();
                    self.emit_user_event(&turn_id, &message, &[], EmitUserEventOpts::default());
                    return SubmitResult {
                        turn_id,
                        queue_position: 0,
                        delivery: SubmitDelivery::Steered,
                    };
                }
            }
        }

        let result = self.enqueue(message, attachments, system_prompt, fork_from_chat_id);
        SubmitResult {
            turn_id: result.turn_id,
            queue_position: result.queue_position,
            delivery: SubmitDelivery::Queued,
        }
    }

    /// Abort the active turn AND clear the queue + holds (Decision 13/A5).
    /// Sets the FIX-G latch so the notice slot does not fire immediately.
    pub fn abort_and_drain(&self) {
        let cancel = {
            let mut s = self.0.state.lock().unwrap();
            s.queue.clear();
            s.holds.clear();
            // Kill live PIDs BEFORE aborting — must freeze the process tree
            // while ancestry is intact (a killed parent reparents to init).
            for pid in s.live_pids.iter().copied().collect::<Vec<_>>() {
                super::pids::kill_process_tree(std::iter::once(pid));
            }
            s.live_pids.clear();
            s.aborted_since_last_drain = true; // FIX-G
            let c = s.active_cancel.take();
            s.turn_state = TurnState::Idle;
            c
        };
        if let Some(c) = cancel {
            c.cancel();
        }
        self.emit_meta();
    }

    /// Stop the active turn only, keeping queued turns (Decision 8).
    /// Returns true when there was an active turn to abort.
    pub fn stop_active_turn(&self) -> bool {
        let cancel = {
            let mut s = self.0.state.lock().unwrap();
            if !s.running {
                return false;
            }
            // If there's an ACP connection: cancel only the in-flight prompt,
            // never kill the process group (Decision 3).
            let has_connection = s.connection.as_ref().map_or(false, |c| c.is_alive());
            let conn = if has_connection {
                s.connection.clone()
            } else {
                None
            };
            if !has_connection {
                // Legacy per-turn spawn: kill the whole descendant tree.
                for pid in s.live_pids.iter().copied().collect::<Vec<_>>() {
                    super::pids::kill_process_tree(std::iter::once(pid));
                }
            }
            s.aborted_since_last_drain = true; // FIX-G
            let c = s.active_cancel.clone();
            (c, conn)
        };
        let (c_opt, conn_opt) = cancel;
        if let Some(conn) = conn_opt {
            conn.cancel_active_prompt();
        }
        if let Some(c) = c_opt {
            c.cancel();
        }
        true
    }

    /// Cancel ONE not-yet-started turn by id (queued OR held). Emits a
    /// superseding `user` event with `cancelled: true`.
    pub fn cancel_queued_turn(&self, turn_id: &str) -> bool {
        // Capture the turn before removal so we can re-emit.
        let removed = {
            let mut s = self.0.state.lock().unwrap();
            let in_queue = s.queue.iter().position(|t| t.turn_id == turn_id);
            let from_queue = if let Some(idx) = in_queue {
                Some(s.queue.remove(idx).unwrap())
            } else {
                None
            };
            let from_hold = s.holds.remove(turn_id).map(|h| h.turn);
            from_queue.or(from_hold)
        };

        if let Some(turn) = removed {
            self.emit_user_event(
                turn_id,
                &turn.raw_message,
                &turn.attachments,
                EmitUserEventOpts {
                    cancelled: true,
                    ..Default::default()
                },
            );
            {
                let mut s = self.0.state.lock().unwrap();
                Self::sync_idle_state_inner(&mut s);
            }
            self.emit_meta();
            true
        } else {
            false
        }
    }

    /// Withdraw a queued turn into the editing hold. Returns the draft content
    /// or `None` if the turn is not in the queue. Idempotent for already-held
    /// turns (returns the held content, no double-hold).
    pub fn begin_edit_queued_turn(
        &self,
        turn_id: &str,
    ) -> Option<(String, Vec<Attachment>, usize)> {
        let mut s = self.0.state.lock().unwrap();
        // Already held — idempotent re-acquire.
        if let Some(held) = s.holds.get(turn_id) {
            let msg = held.turn.raw_message.clone();
            let att = held.turn.attachments.clone();
            let qi = held.ahead_ids.len();
            return Some((msg, att, qi));
        }
        let idx = s.queue.iter().position(|t| t.turn_id == turn_id)?;
        let ahead_ids: Vec<String> = s
            .queue
            .iter()
            .take(idx)
            .map(|t| t.turn_id.clone())
            .collect();
        let turn = s.queue.remove(idx).unwrap();
        let msg = turn.raw_message.clone();
        let att = turn.attachments.clone();
        let qi = idx;
        s.holds
            .insert(turn_id.to_string(), super::HeldTurn { turn, ahead_ids });
        Self::sync_idle_state_inner(&mut s);
        drop(s);
        self.emit_meta();
        Some((msg, att, qi))
    }

    /// Re-enqueue a held turn after editing. Re-derives insert position from
    /// `ahead_ids` (robust to cancels/promotes that happened during the edit).
    pub fn resubmit_queued_turn(
        &self,
        turn_id: &str,
        message: String,
        attachments: Vec<Attachment>,
        edited: bool,
    ) -> bool {
        let mut s = self.0.state.lock().unwrap();
        let Some(held) = s.holds.remove(turn_id) else {
            return false;
        };
        let mut turn = held.turn;

        if edited {
            turn.raw_message = message.clone();
            turn.attachments = attachments.clone();
            // Emit the superseding user event outside the lock (below).
        }

        let insert_at = Self::insert_position_after_ahead_ids(&s.queue, &held.ahead_ids);
        s.queue.insert(insert_at, turn);
        Self::sync_idle_state_inner(&mut s);
        drop(s);

        if edited {
            self.emit_user_event(
                turn_id,
                &message,
                &attachments,
                EmitUserEventOpts {
                    edited: true,
                    ..Default::default()
                },
            );
        }

        self.emit_meta();
        self.kick_drain();
        true
    }

    /// Edit an already-ANSWERED turn → fork (R3.1/R3.4/R3.5). Truncates the
    /// branch at turn N's first logSeq (rows onwards → superseded), then
    /// enqueues a new turn with `fork_from_chat_id = agentChatId`.
    pub fn fork_turn(
        &self,
        from_turn_id: &str,
        message: String,
        attachments: Vec<Attachment>,
    ) -> ForkResult {
        let fork_seq = {
            let store = self.0.store.lock().unwrap();
            store
                .as_ref()
                .and_then(|st| st.first_seq_of_turn(from_turn_id))
        };
        let Some(fork_seq) = fork_seq else {
            return ForkResult::NotFound;
        };
        let superseded_turn_ids = {
            let mut store = self.0.store.lock().unwrap();
            store
                .as_mut()
                .map_or_else(Vec::new, |st| st.mark_superseded_from(fork_seq))
        };
        self.rebuild_meta_from_transcript();

        let agent_chat_id = self.0.state.lock().unwrap().session.agent_chat_id.clone();
        let result = self.enqueue(message, attachments, None, agent_chat_id);
        ForkResult::Ok {
            turn_id: result.turn_id,
            superseded_turn_ids,
        }
    }

    /// Splice a queued turn to the front and abort the active turn so it runs
    /// next immediately ("Send now" / promote).
    pub fn promote_queued_turn(&self, turn_id: &str) -> bool {
        {
            let mut s = self.0.state.lock().unwrap();
            let Some(idx) = s.queue.iter().position(|t| t.turn_id == turn_id) else {
                return false;
            };
            if idx > 0 {
                let turn = s.queue.remove(idx).unwrap();
                s.queue.push_front(turn);
                // hold the lock here only for the reorder; drop before emit_meta
            }
        }
        self.emit_meta();
        self.stop_active_turn();
        self.kick_drain();
        true
    }

    /// Fire the drain loop if not already running and there is work to do.
    pub fn kick_drain(&self) {
        if self.is_released() {
            return;
        }
        let should_start = {
            let mut s = self.0.state.lock().unwrap();
            // Re-check `is_released()` INSIDE the `state` lock, not just the
            // fast-path check above: `release()` latches `released` (under the
            // `store` lock) strictly before it ever takes `state`
            // (`Inner::store`/`Inner::released` doc comment), so a caller that
            // wins `state` here after the latch is guaranteed to observe it.
            // Without this recheck, a `kick_drain` that raced past the
            // fast-path check just before `release()` latched could still win
            // `state`, set `running = true`, and spawn a `drain_loop` on an
            // already-released session — whose turn could then run to
            // completion (spawning a real CLI process) after `release()` has
            // already returned and `dispose()`d the session.
            if s.running || self.is_released() {
                return;
            }
            let has_work = !s.queue.is_empty() || s.notice_slot.is_some() || s.promoted_notice;
            if !has_work {
                return;
            }
            // Atomically mark running=true BEFORE spawning (no race between check
            // and spawn where a second caller could also spawn).
            s.running = true;
            true
        };
        if should_start {
            // Signal not-idle to any settled() waiter.
            let _ = self.0.drain_tx.send(false);
            let this = self.clone();
            tokio::spawn(async move {
                this.drain_loop().await;
            });
        }
    }

    /// Recompute the global turn-state from the queue when no turn is running.
    #[allow(dead_code)]
    pub(super) fn sync_idle_state(s: &mut State) {
        Self::sync_idle_state_inner(s);
    }

    fn sync_idle_state_inner(s: &mut State) {
        if s.running {
            return;
        }
        s.turn_state = if s.queue.is_empty() {
            TurnState::Idle
        } else {
            TurnState::Queued
        };
    }

    /// Re-derive the insertion index AFTER the last entry in `ahead_ids` that
    /// is still present in `queue` (or 0 if none remain).
    pub fn insert_position_after_ahead_ids(
        queue: &std::collections::VecDeque<QueuedTurn>,
        ahead_ids: &[String],
    ) -> usize {
        let mut last_pos = 0usize;
        for (i, t) in queue.iter().enumerate() {
            if ahead_ids.contains(&t.turn_id) {
                last_pos = i + 1;
            }
        }
        last_pos.min(queue.len())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
