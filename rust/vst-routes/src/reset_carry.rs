//! The review-comment half of a session reset's queued-message carry (plan 04).
//!
//! A reset withdraws the old session's queued turns and carries them to the
//! replacement. A turn that carried review comments keeps its hold across
//! the move, so the comments are neither lost nor delivered twice:
//!
//! - **Rich Chat target:** the hold is rehomed to the NEW turn id (the key boot
//!   reconcile uses) before the enqueue; an enqueue error restores it.
//! - **Terminal target:** the block rides the launch prompt
//!   ([`carried_message_with_review`]); the hold is consumed once the launch
//!   succeeded and restored when it failed.

use vst_agents::json_agent_chat::{enqueue_chat_turn, EnqueueChatTurnOpts};
use vst_agents::json_agent_session::ReviewTurn;
use vst_types::domain::Mention;
use vst_types::review::RestoreReason;

use crate::sessions::SessionRoutes;

/// A queued message carried through a reset: text, `@`-mention sidecar, and the
/// review comments it carried (their hold keeps them until delivered).
pub type CarriedMessage = (String, Vec<Mention>, Option<ReviewTurn>);

/// A carried message's wire-form text with its review block appended, for a
/// Terminal target's launch prompt (the block is escaped like any daemon-made
/// text so a quoted `{/x y}` can never parse as a skill token).
pub fn carried_message_with_review(message: &str, review: &ReviewTurn) -> String {
    let block = vst_agents::skill_tokens::escape_skill_text(
        &vst_types::review_format::render_review_block(
            &review.record.name,
            &review.record.comments,
        ),
    );
    if message.trim().is_empty() {
        block
    } else {
        format!("{message}\n\n{block}")
    }
}

/// Budget for the whole shell-quoted launch prompt of a Terminal (tmux) agent
/// that carries review comments. The prompt rides the `sh -c "exec <cli>
/// '<prompt>'"` argv given to `tmux new-session`, and tmux refuses a command
/// message over ~16 KB with `command too long`; 14 KiB leaves room for the
/// wrapper (`exec`, CLI flags, session env). Measured AFTER quoting, because
/// every `'` in the prompt grows to the four bytes `'\''`. Rich Chat has no
/// such limit and does not use this.
pub const TMUX_LAUNCH_COMMAND_BUDGET: usize = 14 * 1024;

/// `Some(TooLarge)` when the quoted `launch_prompt` exceeds
/// [`TMUX_LAUNCH_COMMAND_BUDGET`].
pub fn terminal_launch_prompt_too_large(
    launch_prompt: &str,
) -> Option<vst_types::review::ReviewError> {
    (vst_proc::shell::sq(launch_prompt).len() > TMUX_LAUNCH_COMMAND_BUDGET).then_some(
        vst_types::review::ReviewError::TooLarge {
            limit: TMUX_LAUNCH_COMMAND_BUDGET as u32,
            unit: "bytes",
        },
    )
}

/// Compose the launch-prompt parts of a Terminal target: `base` parts (summary,
/// user prompt) then every carried message, each with its review block.
pub fn terminal_launch_parts<'a>(
    base: &[String],
    carried: impl IntoIterator<Item = (&'a str, Option<&'a ReviewTurn>)>,
) -> Vec<String> {
    let mut parts = base.to_vec();
    parts.extend(carried.into_iter().map(|(m, r)| match r {
        Some(r) => carried_message_with_review(m, r),
        None => m.to_string(),
    }));
    parts
}

/// Separator between launch-prompt parts.
pub const LAUNCH_PART_SEP: &str = "\n\n---\n\n";

/// Enqueue carried messages on the replacement Rich Chat session, FIFO.
pub async fn carry_to_json(
    routes: &SessionRoutes,
    session_id: &str,
    daemon_port: u16,
    messages: Vec<CarriedMessage>,
) {
    for (message, mentions, review) in messages {
        // A carried review keeps its hold but moves to the NEW turn (a fresh turn
        // id: the boot-reconcile key) BEFORE the enqueue, so a crash anywhere in
        // between restores it exactly once.
        let hold_id = review.as_ref().map(|r| r.hold_id.clone());
        let turn_id = review.as_ref().map(|_| vst_agents::util::new_uuid_v4());
        if let (Some(h), Some(t), Some(port)) =
            (&hold_id, &turn_id, routes.json_registry.review_port())
        {
            port.rehome_hold(h, session_id, t).await;
        }
        let res = enqueue_chat_turn(
            EnqueueChatTurnOpts {
                session_id: session_id.to_string(),
                message,
                attachments: vec![],
                mentions,
                daemon_port,
                steer: Some(false),
                silent: false,
                turn_id,
                review,
                store: routes.store.clone(),
                broadcaster: routes.broadcaster.clone(),
            },
            &routes.json_registry,
        )
        .await;
        if let Err(e) = res {
            eprintln!("reset: carrying a queued message to {session_id} failed: {e:?}");
            if let (Some(h), Some(port)) = (&hold_id, routes.json_registry.review_port()) {
                port.restore_hold(h, RestoreReason::SendFailed).await;
            }
        }
    }
}

/// The hold ids of the carried messages that have a review.
pub fn terminal_holds(messages: &[CarriedMessage]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|(_, _, r)| r.as_ref().map(|r| r.hold_id.clone()))
        .collect()
}

/// Point the holds at the replacement session (a fresh turn id: nothing is ever
/// persisted under it, so a restart before [`settle_terminal_holds`] restores).
pub async fn rehome_terminal_holds(routes: &SessionRoutes, holds: &[String], session_id: &str) {
    let Some(port) = routes.json_registry.review_port() else {
        return;
    };
    for h in holds {
        port.rehome_hold(h, session_id, &vst_agents::util::new_uuid_v4())
            .await;
    }
}

/// After the Terminal launch: consume the holds when it succeeded (the comments
/// were in the launch prompt), restore them when it failed.
pub async fn settle_terminal_holds(
    routes: &SessionRoutes,
    holds: &[String],
    spawned: &Result<(), String>,
) {
    let Some(port) = routes.json_registry.review_port() else {
        return;
    };
    for h in holds {
        match spawned {
            Ok(()) => port.consume_hold(h).await,
            Err(_) => port.restore_hold(h, RestoreReason::SendFailed).await,
        }
    }
}

use crate::sessions::WithdrawnTurn;
use vst_agents::json_agent_session::JsonAgentSession;

impl SessionRoutes {
    /// Re-enqueue the turns this reset withdrew (failure / cancel restore). A
    /// review goes back onto its turn first; a turn that no longer exists
    /// (cancelled meanwhile) restores its comments to the panel instead.
    pub(crate) async fn restore_withdrawn(
        &self,
        agent: &JsonAgentSession,
        withdrawn: &[WithdrawnTurn],
    ) {
        for turn in withdrawn {
            if let Some(review) = &turn.review {
                if !agent.restore_review(&turn.turn_id, review.clone()) {
                    self.restore_hold(
                        &review.hold_id,
                        vst_types::review::RestoreReason::TurnCancelled,
                    )
                    .await;
                }
            }
            agent.resubmit_queued_turn(
                &turn.turn_id,
                turn.message.clone(),
                turn.attachments.clone(),
                turn.mentions.clone(),
                false,
            );
        }
    }

    /// Restore a review hold to the panel (no-op without a review port).
    pub(crate) async fn restore_hold(
        &self,
        hold_id: &str,
        reason: vst_types::review::RestoreReason,
    ) {
        if let Some(port) = self.json_registry.review_port() {
            port.restore_hold(hold_id, reason).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_types::review::{ReviewError, ReviewRecord};

    fn review(text_len: usize) -> ReviewTurn {
        let c = serde_json::from_value(serde_json::json!({
            "id": "c1", "pin": 1, "path": "src/a.rs", "pathKind": "repo",
            "surface": "file", "quote": "let x = 1;", "text": "x".repeat(text_len),
            "anchor": "anchored", "lines": { "start": 3, "end": 3 },
            "lineStart": 3, "lineEnd": 3
        }))
        .unwrap();
        ReviewTurn {
            hold_id: "h".into(),
            record: ReviewRecord {
                name: "feat".into(),
                comments: vec![c],
            },
        }
    }

    #[test]
    fn terminal_launch_cap_measures_the_quoted_prompt() {
        assert!(terminal_launch_prompt_too_large(&"a".repeat(1000)).is_none());
        let err = terminal_launch_prompt_too_large(&"a".repeat(15 * 1024)).unwrap();
        assert!(matches!(
            err,
            ReviewError::TooLarge {
                limit: 14336,
                unit: "bytes"
            }
        ));
        // 5000 apostrophes are 5000 bytes raw but 20000 once quoted.
        let quotes = "'".repeat(5000);
        assert!(quotes.len() < TMUX_LAUNCH_COMMAND_BUDGET);
        assert!(terminal_launch_prompt_too_large(&quotes).is_some());
        // The same bytes without quoting growth fit.
        assert!(terminal_launch_prompt_too_large(&"a".repeat(5000)).is_none());
    }

    #[test]
    fn user_text_plus_a_quote_heavy_block_is_refused() {
        // 6 KiB draft prompt + a block full of apostrophes: each part fits
        // under the old 12 KiB block check, together they do not.
        let r = review(0);
        let mut r = r;
        r.record.comments[0].text = "'".repeat(2500);
        let launch = carried_message_with_review(&"w".repeat(6 * 1024), &r);
        assert!(terminal_launch_prompt_too_large(&launch).is_some());
    }

    #[test]
    fn launch_parts_append_blocks_to_carried_messages() {
        let r = review(10);
        let parts =
            terminal_launch_parts(&["base".to_string()], [("one", None), ("two", Some(&r))]);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[1], "one");
        assert!(parts[2].starts_with("two\n\n"));
    }
}
