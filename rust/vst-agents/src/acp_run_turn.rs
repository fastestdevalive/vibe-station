//! Shared `run_turn_acp` — ONE implementation of the ACP turn-driving core,
//! replacing the TS's 4x near-identical `async function* runTurnAcp` copies in
//! `claude.ts`/`cursor.ts`/`opencode.ts`/`agy.ts`.
//!
//! The genuinely-shared sequence is: get the persistent connection →
//! `session_id` from it → (first turn) optional synthetic `session_init` →
//! build prompt blocks → `send_prompt` → drain `PromptTurn.updates` through
//! `normalize::normalize_session_update` → await `PromptTurn.result` → emit a
//! terminal `result` event, mapping `StopReason::Refusal` to an `error` when
//! the plugin opts in.
//!
//! Per-plugin variation (the launch spec, the enrich hook, whether the ACP id
//! is surfaced as `agentChatId`, where the system prompt goes on the first
//! turn, and refusal handling) is captured by [`RunTurnAcpParams`], so the
//! shared function never branches on a CLI id (Gotcha #2) — each plugin's
//! `run_turn` wrapper supplies its own `RunTurnAcpParams`.
//!
//! ## Known gaps vs. the TS (flagged for the report, not silently hidden)
//! - The frozen `AcpTransport` surfaces only `StopReason` from `PromptTurn.result`
//!   — not the `usage` bag the TS reads there. So `usage` / `result` events
//!   here carry no usage figures; the `usage` event is omitted entirely.
//! - `TurnContext.on_spawn` is threaded through but the frozen `AcpLaunchSpec`
//!   has no `on_spawn` surface, so the ACP connection never reports child pids
//!   back for orphan-safe group-kill. Documented, not silently dropped.

use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, StopReason};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_types::{NormalizedEvent, NormalizedEventKind, NormalizedEventProvider};

use crate::acp_connection::AcpLaunchSpec;
use crate::acp_transport::AcpTransport;
use crate::normalize::{normalize_session_update, AcpEnrichHook};
use crate::plugin::{base_event, TurnContext, TurnInput};

/// Produce the optional first-turn `session_init` event (given the ACP session
/// id). `None` = Option B (cursor/agy); `Some` = Option A (claude/opencode).
pub type FirstTurnSessionInit = Arc<dyn Fn(&TurnContext, &str) -> NormalizedEvent + Send + Sync>;

/// Build the prompt content blocks for this turn.
pub type BuildPromptBlocks =
    Box<dyn Fn(&TurnContext, &TurnInput, Option<&str>) -> Vec<ContentBlock> + Send + Sync>;

/// Per-plugin parameterization of the shared [`run_turn_acp`]. This is where
/// every CLI-specific fact lives (AGENTS.md § Agent plugin), so the shared
/// function never inspects a CLI id.
pub struct RunTurnAcpParams {
    /// The `provider` stamped on every normalized event this turn yields.
    pub provider: NormalizedEventProvider,
    /// Build this CLI's ACP launch spec (argv/env — mirrors `get_launch_command`
    /// argv logic).
    pub build_spec: Box<dyn Fn(&TurnContext) -> AcpLaunchSpec + Send + Sync>,
    /// Per-CLI enrichment hook (identity for all four today; kept as a seam
    /// per the plan, not a no-op removed for tidiness).
    pub enrich: Option<Arc<AcpEnrichHook>>,
    /// Produce the optional first-turn `session_init` event (given the ACP
    /// session id). `None` = Option B (cursor/agy — do NOT surface the ACP id
    /// as `agentChatId`); `Some` = Option A (claude/opencode).
    pub first_turn_session_init: Option<FirstTurnSessionInit>,
    /// Build the prompt content blocks for this turn. `system` is the system
    /// prompt file's contents on the first turn (empty string when the file is
    /// missing/unreadable, `None` on later turns). The plugin decides system-
    /// prompt placement (append-as-second-block for claude, prepend-to-message
    /// for cursor/agy, none for opencode). The user message MUST remain
    /// prompt[0].
    pub build_prompt_blocks: BuildPromptBlocks,
    /// Whether a `StopReason::Refusal` yields a terminal `error` event
    /// (claude only today).
    pub emit_refusal_error: bool,
}

/// Drive ONE ACP turn and push every resulting event into `tx`. Terminates
/// with a `result` event (normal), an `error` event (transport/CLI failure or
/// refusal), or closes silently on cancel.
pub async fn run_turn_acp(
    tx: mpsc::UnboundedSender<NormalizedEvent>,
    input: TurnInput,
    ctx: TurnContext,
    cancel: CancellationToken,
    params: RunTurnAcpParams,
) {
    let conn =
        match (ctx.get_acp_connection)((params.build_spec)(&ctx), params.enrich.clone()).await {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(error_event(&ctx, &params.provider, format!("{e}")));
                return;
            }
        };

    let Some(acp_session_id) = conn.current_session_id() else {
        let _ = tx.send(error_event(
            &ctx,
            &params.provider,
            format!(
                "{} ACP session was not established",
                provider_name(params.provider)
            ),
        ));
        return;
    };

    // Read the system prompt file once, on the first turn only (best-effort —
    // mirrors the TS `fs.readFile(...).catch(() => "")`).
    let mut system: Option<String> = None;
    if input.is_first_turn {
        if let Some(first) = &params.first_turn_session_init {
            let _ = tx.send(first(&ctx, &acp_session_id));
        }
        system = Some(
            tokio::fs::read_to_string(&ctx.system_prompt_file)
                .await
                .unwrap_or_default(),
        );
    }

    let prompt_blocks = (params.build_prompt_blocks)(&ctx, &input, system.as_deref());
    let turn = conn.send_prompt(&acp_session_id, prompt_blocks);

    // Drain the raw `SessionUpdate`s through normalize. A cancel interrupts the
    // drain at any point (even while parked on an idle `recv`), and a killed
    // harness may still flush late updates after the abort — both must stop
    // the turn cleanly without an error event.
    let mut updates = turn.updates;
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            update = updates.recv() => {
                match update {
                    Some(update) => {
                        if let Some(ev) = normalize_session_update(
                            &update,
                            &acp_session_id,
                            params.provider,
                            params.enrich.as_deref(),
                        ) {
                            let _ = tx.send(ev);
                        }
                    }
                    None => break, // stream closed — the turn is ending
                }
            }
        }
    }

    let stop_reason = match turn.result.await {
        Ok(Ok(reason)) => reason,
        Ok(Err(e)) => {
            if !cancel.is_cancelled() {
                let _ = tx.send(error_event(&ctx, &params.provider, format!("{e}")));
            }
            return;
        }
        Err(_) => {
            // The result sender was dropped without a reply (connection died,
            // or the turn was torn down). A cancelled turn is not an error.
            if !cancel.is_cancelled() {
                let _ = tx.send(error_event(
                    &ctx,
                    &params.provider,
                    "ACP turn ended without a result".to_string(),
                ));
            }
            return;
        }
    };

    // Terminal `result` event. No usage figures (frozen trait gap — see the
    // module doc). The TS yields `result` first, then a refusal `error` AFTER
    // it (so the error is the terminal event), matching claude.ts.
    let mut result = base_event(
        &ctx.session.id,
        params.provider,
        NormalizedEventKind::Result,
    );
    result.turn_id = None;
    let _ = tx.send(result);

    if params.emit_refusal_error && stop_reason == StopReason::Refusal {
        let _ = tx.send(error_event(
            &ctx,
            &params.provider,
            "turn refused".to_string(),
        ));
    }
}

fn provider_name(p: NormalizedEventProvider) -> &'static str {
    match p {
        NormalizedEventProvider::Claude => "claude",
        NormalizedEventProvider::Cursor => "cursor",
        NormalizedEventProvider::Opencode => "opencode",
        NormalizedEventProvider::Agy => "agy",
    }
}

fn error_event(
    ctx: &TurnContext,
    provider: &NormalizedEventProvider,
    text: String,
) -> NormalizedEvent {
    let mut ev = base_event(&ctx.session.id, *provider, NormalizedEventKind::Error);
    ev.text = Some(text);
    ev
}
