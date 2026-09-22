//! `JsonAgentSession` ACP connection methods — get_or_create_connection,
//! maybe_capture_native_chat_id, persist_acp_session_id, persist_chat_id.
//!
//! **Invariant:** `is_alive()` is re-checked on every call (self-healing
//! respawn) — a cached-but-dead connection must never be reused.

use std::sync::Arc;

use vst_types::NormalizedEventKind;

use super::JsonAgentSession;
use crate::{
    acp_connection::{AcpConnection, AcpLaunchSpec},
    acp_transport::{AcpTransport, AcpTransportError},
    context::{build_vst_env, BuildVstEnvOptions},
    normalize::AcpEnrichHook,
};

impl JsonAgentSession {
    /// Get the live ACP connection, creating it if necessary.
    ///
    /// First call: spawns + `initialize`s, then `session/load`s the existing
    /// `acpSessionId` (if `initialize` advertised `loadSession` AND an id already
    /// exists) or else `session/new`s. A failed/unsupported load falls through to
    /// a fresh session with a `status` event, never silently. Subsequent calls
    /// return the cached connection after an `is_alive()` check.
    pub async fn get_or_create_connection(
        &self,
        spec: AcpLaunchSpec,
        _enrich: Option<Arc<AcpEnrichHook>>,
    ) -> Result<AcpConnection, AcpTransportError> {
        // Check liveness of any cached connection.
        let existing = {
            let s = self.0.state.lock().unwrap();
            s.connection.clone()
        };
        if let Some(conn) = existing {
            if conn.is_alive() {
                return Ok(conn);
            }
            // Dead connection — clear it (self-healing respawn path).
            self.0.state.lock().unwrap().connection = None;
        }

        // Build spec with merged VST environment (Decision 1).
        let (project, worktree, session, daemon_port) = {
            let s = self.0.state.lock().unwrap();
            (
                s.project.clone(),
                s.worktree.clone(),
                s.session.clone(),
                self.0.daemon_port,
            )
        };
        let vst_env = build_vst_env(&BuildVstEnvOptions {
            project: project.clone(),
            worktree: worktree.clone(),
            session: session.clone(),
            daemon_port,
        });
        let mut merged_env = vst_env;
        // spec.env wins (plugin keeps the last word on its own vars).
        merged_env.extend(spec.env);
        let spec_with_vst_env = AcpLaunchSpec {
            env: merged_env,
            ..spec
        };

        let conn = AcpConnection::new(spec_with_vst_env);

        // Initialize the connection.
        let init_outcome = conn.initialize().await?;

        // Reconnect id: prefer acpSessionId (Option B), fall back to agentChatId (Option A).
        let prior_acp_id = {
            let s = self.0.state.lock().unwrap();
            s.session
                .acp_session_id
                .clone()
                .or_else(|| s.session.agent_chat_id.clone())
        };

        // ACP meta for the agent adapter (forward model & options without branching on CLI id).
        let active_model = {
            let s = self.0.state.lock().unwrap();
            s.session
                .model_override
                .clone()
                .or_else(|| s.requested_model.clone())
                .unwrap_or_else(|| self.0.plugin.default_model().to_string())
        };
        let acp_meta = self.0.plugin.acp_meta(&active_model);

        let cwd = self.0.cwd.clone();
        let mut used_fresh_session = true;

        if init_outcome.load_session_supported {
            if let Some(prior_id) = prior_acp_id {
                match conn.load_session(&cwd, &prior_id, acp_meta.clone()).await {
                    Ok(()) => {
                        used_fresh_session = false;
                    }
                    Err(AcpTransportError::SessionLoadFailed(_)) => {
                        // Emit a status event noting the fallback to a fresh session.
                        let mut ev = vst_types::NormalizedEvent::default();
                        ev.text = Some(
                            "resumed with a fresh agent session — prior context may not be visible to the CLI"
                                .to_string(),
                        );
                        let mut ev = self.new_event(NormalizedEventKind::Status, &mut ev);
                        self.persist_event(&mut ev);
                        self.0.stream.emit_message(&ev);
                    }
                    Err(e) => return Err(e),
                }
            }
        }

        if used_fresh_session {
            let acp_session_id = conn.new_session(&cwd, acp_meta).await?;
            self.persist_acp_session_id(acp_session_id).await;
        }

        // Some adapters (e.g. openab's agy-acp) ignore `_meta` at
        // `session/new`/`session/load` entirely and only accept a model via
        // this explicit follow-up call — see `AgentPlugin::acp_initial_config_option`'s
        // doc comment. Best-effort: most plugins return `None` here (they
        // already carried the model via `acp_meta` above), and any failure
        // (including method-not-found on an adapter that doesn't implement
        // it) just means the turn proceeds with whatever the adapter already
        // defaulted to — never fails the connection setup over this.
        if let Some((config_id, value)) = self.0.plugin.acp_initial_config_option(&active_model) {
            if let Err(e) = conn.set_config_option(&config_id, &value).await {
                tracing::warn!(
                    config_id = %config_id,
                    value = %value,
                    error = %e,
                    "acp_initial_config_option: session/set_config_option failed (non-fatal)"
                );
            }
        }

        // Store connection and set the first-turn-pending flag.
        {
            let mut s = self.0.state.lock().unwrap();
            s.connection = Some(conn.clone());
            s.connection_first_turn_pending = true;
        }

        Ok(conn)
    }

    /// Decision 6 Option B: called once per connection, at the `result` event
    /// of that connection's FIRST turn (never earlier). Write-once: never
    /// overwrites an `agentChatId` already captured by the terminal path.
    pub(super) async fn maybe_capture_native_chat_id(&self) {
        let should_run = {
            let s = self.0.state.lock().unwrap();
            s.connection_first_turn_pending
        };
        if !should_run {
            return;
        }
        {
            let mut s = self.0.state.lock().unwrap();
            s.connection_first_turn_pending = false;
        }

        let (acp_session_id, agent_chat_id_already_set) = {
            let s = self.0.state.lock().unwrap();
            let sid = s.connection.as_ref().and_then(|c| c.current_session_id());
            let already = s.session.agent_chat_id.is_some();
            (sid, already)
        };
        let Some(acp_session_id) = acp_session_id else {
            return;
        };
        if agent_chat_id_already_set {
            return; // write-once
        }

        let (session, project, cwd) = {
            let s = self.0.state.lock().unwrap();
            (s.session.clone(), s.project.clone(), self.0.cwd.clone())
        };

        let captured = self
            .0
            .plugin
            .capture_native_chat_id(crate::plugin::CaptureNativeChatIdArgs {
                session: &session,
                project: &project,
                cwd: cwd.to_str().unwrap_or(""),
                acp_session_id: &acp_session_id,
            })
            .await;

        if let Some(captured_id) = captured {
            {
                let mut s = self.0.state.lock().unwrap();
                s.session.agent_chat_id = Some(captured_id.clone());
            }
            self.persist_chat_id(captured_id).await;
        }
    }

    /// Decision 6 Option B: persist `sessions.acpSessionId` to the project store.
    pub(super) async fn persist_acp_session_id(&self, acp_session_id: String) {
        let (project_id, worktree_id, session_id, already_current) = {
            let s = self.0.state.lock().unwrap();
            let already = s.session.acp_session_id.as_deref() == Some(acp_session_id.as_str());
            (
                s.project.id.clone(),
                s.worktree.as_ref().map(|w| w.id.clone()),
                s.session.id.clone(),
                already,
            )
        };
        if already_current {
            return;
        }
        {
            let mut s = self.0.state.lock().unwrap();
            s.session.acp_session_id = Some(acp_session_id.clone());
        }
        let sid = session_id.clone();
        let oid = acp_session_id.clone();
        let _ = self
            .0
            .store_handle
            .mutate_project(&project_id, move |p| {
                if let Some(wid) = &worktree_id {
                    for wt in p.worktrees.iter_mut() {
                        if wt.id == *wid {
                            for sess in wt.sessions.iter_mut() {
                                if sess.id == sid {
                                    sess.acp_session_id = Some(oid.clone());
                                }
                            }
                        }
                    }
                } else {
                    for sess in p.direct_sessions.iter_mut() {
                        if sess.id == sid {
                            sess.acp_session_id = Some(oid.clone());
                        }
                    }
                }
                Ok(p.clone())
            })
            .await;
    }

    /// Persist the `agentChatId` to the project store (terminal path).
    pub(super) async fn persist_chat_id(&self, chat_id: String) {
        let (project_id, worktree_id, session_id) = {
            let s = self.0.state.lock().unwrap();
            (
                s.project.id.clone(),
                s.worktree.as_ref().map(|w| w.id.clone()),
                s.session.id.clone(),
            )
        };
        let sid = session_id.clone();
        let cid = chat_id.clone();
        let _ = self
            .0
            .store_handle
            .mutate_project(&project_id, move |p| {
                if let Some(wid) = &worktree_id {
                    for wt in p.worktrees.iter_mut() {
                        if wt.id == *wid {
                            for sess in wt.sessions.iter_mut() {
                                if sess.id == sid {
                                    sess.agent_chat_id = Some(cid.clone());
                                }
                            }
                        }
                    }
                } else {
                    for sess in p.direct_sessions.iter_mut() {
                        if sess.id == sid {
                            sess.agent_chat_id = Some(cid.clone());
                        }
                    }
                }
                Ok(p.clone())
            })
            .await;
    }
}
