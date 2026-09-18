//! `JsonAgentSession` event-handling methods — handle_event,
//! handle_out_of_band_event, new_event, emit_user_event, update_turn_state.
//!
//! **Invariant:** `agentChatId` capture happens on `session_init` only;
//! a no-real-usage turn must not clobber `usage` — the `has_real_usage` gate
//! is a load-bearing check (per the TS doc comment on that function).

use vst_store::transcript::cap_tool_result_content;
use vst_types::{NormalizedEvent, NormalizedEventKind, Role, TurnState};

use super::{now_ms, JsonAgentSession};

impl JsonAgentSession {
    /// Handle an in-band stream event from the active ACP turn. Updates
    /// in-memory state and persists to the transcript.
    pub async fn handle_event(&self, ev: &mut NormalizedEvent) {
        // Session-init: capture model and agentChatId (write-once for chatId).
        if ev.kind == NormalizedEventKind::SessionInit {
            if let Some(m) = &ev.model {
                let mut s = self.0.state.lock().unwrap();
                s.model = Some(m.clone());
            }
            // Capture agentChatId: first time, OR if this is a fork turn.
            let ev_chat_id = ev.agent_chat_id.clone();
            let should_capture = {
                let s = self.0.state.lock().unwrap();
                if let Some(ref eid) = ev_chat_id {
                    let different = s.session.agent_chat_id.as_deref() != Some(eid.as_str());
                    different
                        && (s.session.agent_chat_id.is_none()
                            || s.active_fork_from_chat_id.is_some())
                } else {
                    false
                }
            };
            if should_capture {
                if let Some(chat_id) = ev_chat_id {
                    {
                        let mut s = self.0.state.lock().unwrap();
                        s.session.agent_chat_id = Some(chat_id.clone());
                    }
                    self.persist_chat_id(chat_id).await;
                }
            }
        }

        // Update model from any event that carries it.
        if let Some(m) = &ev.model {
            let mut s = self.0.state.lock().unwrap();
            s.model = Some(m.clone());
        }

        // Update usage only for turns that actually made a model call (hasRealUsage gate).
        if has_real_usage(ev.usage.as_ref()) {
            let usage = ev.usage.clone();
            let mut s = self.0.state.lock().unwrap();
            s.usage = usage;
        }

        // commands_update: full-replace (never merge).
        if ev.kind == NormalizedEventKind::CommandsUpdate {
            let cmds = ev.commands.clone();
            let mut s = self.0.state.lock().unwrap();
            s.commands = cmds;
        }

        cap_tool_result_content(ev);
        self.persist_event(ev);
        self.0.stream.emit_message(ev);
        self.update_turn_state(ev.kind);
        self.emit_meta();
    }

    /// Handle an out-of-band (subagent task-notification) event. Does NOT call
    /// `update_turn_state` — no lifecycle transitions for notifications.
    pub fn handle_out_of_band_event(&self, mut ev: NormalizedEvent) {
        if self.is_released() {
            return;
        }

        // Mint a burst-stable turnId. A burst is a sequence of notifications
        // within OUT_OF_BAND_BURST_GAP_MS of each other. A real turn starting
        // clears the id (in run_one_turn).
        let now = now_ms();
        {
            let mut s = self.0.state.lock().unwrap();
            if s.out_of_band_turn_id.is_none()
                || now.saturating_sub(s.out_of_band_last_at_ms) > super::OUT_OF_BAND_BURST_GAP_MS
            {
                s.out_of_band_turn_id = Some(format!("notif-{}", crate::util::new_uuid_v4()));
            }
            s.out_of_band_last_at_ms = now;
            ev.turn_id = s.out_of_band_turn_id.clone();
        }

        cap_tool_result_content(&mut ev);
        self.persist_event(&mut ev);
        self.0.stream.emit_message(&ev);

        // commands_update can arrive out-of-band — capture + broadcast.
        if ev.kind == NormalizedEventKind::CommandsUpdate {
            {
                let mut s = self.0.state.lock().unwrap();
                s.commands = ev.commands.clone();
            }
            self.emit_meta();
        }
    }

    /// Create a new `NormalizedEvent` stamped with the session's id, cli, and
    /// current timestamp.
    pub(super) fn new_event(
        &self,
        kind: NormalizedEventKind,
        ev: &mut NormalizedEvent,
    ) -> NormalizedEvent {
        let session_id = self.0.state.lock().unwrap().session.id.clone();
        ev.id = crate::util::new_uuid_v4();
        ev.session_id = session_id;
        ev.ts = crate::util::now_iso_8601();
        ev.kind = kind;
        ev.provider = self.0.cli;
        ev.clone()
    }

    /// Synthesize + persist the daemon-owned `user` event for a new turn.
    pub(super) fn emit_user_event(
        &self,
        turn_id: &str,
        message: &str,
        attachments: &[vst_types::Attachment],
        opts: EmitUserEventOpts,
    ) {
        let mut ev = NormalizedEvent::default();
        ev.turn_id = Some(turn_id.to_string());
        ev.role = Some(Role::User);
        ev.text = Some(message.to_string());
        if !attachments.is_empty() {
            ev.attachments = Some(attachments.to_vec());
        }
        if opts.edited {
            ev.edited = Some(true);
        }
        if opts.cancelled {
            ev.cancelled = Some(true);
        }
        if opts.silent {
            ev.silent = Some(true);
        }
        let mut ev = self.new_event(NormalizedEventKind::User, &mut ev);
        self.persist_event(&mut ev);
        self.0.stream.emit_message(&ev);
    }

    /// Transition `turn_state` based on the kind of an in-band event.
    pub(super) fn update_turn_state(&self, kind: NormalizedEventKind) {
        let ts = match kind {
            NormalizedEventKind::Thinking => TurnState::Thinking,
            NormalizedEventKind::Text => TurnState::Responding,
            NormalizedEventKind::ToolUse => TurnState::Tool,
            NormalizedEventKind::Result => TurnState::Idle,
            NormalizedEventKind::Error => TurnState::Error,
            _ => return, // session_init / tool_result / usage / user / status — no transition
        };
        let mut s = self.0.state.lock().unwrap();
        s.turn_state = ts;
    }
}

/// Options for `emit_user_event`.
#[derive(Default)]
pub(super) struct EmitUserEventOpts {
    pub edited: bool,
    pub cancelled: bool,
    pub silent: bool,
}

/// True when a usage record reflects a real model call (not a slash-command
/// that returned totalTokens: 0). Load-bearing — porting the TS's own
/// `hasRealUsage` doc-commented helper exactly.
pub(super) fn has_real_usage(usage: Option<&vst_types::UsageInfo>) -> bool {
    usage.map_or(false, |u| u.total_tokens > 0)
}
