//! Starting a draft with review comments (Decision 19): hold them for the first
//! turn and spawn the promoted session with them. Split from `sessions.rs`.

use vst_agents::json_agent_chat::{start_json_create_turn, StartJsonCreateTurnOpts};
use vst_types::{ProjectRecord, SessionRecord};

use crate::sessions::{SessionRoutes, SpawnChannelOpts, StartError, StartReview};

impl SessionRoutes {
    /// Validate and hold the review comments of a draft being started (Decision
    /// 19). `None` without ids. The promotion must stay inside the comments'
    /// scope: the draft's own worktree (or the project for a direct draft).
    pub(crate) async fn hold_start_review(
        &self,
        ids: &[String],
        project: &ProjectRecord,
        session: &SessionRecord,
        target_worktree_id: Option<&str>,
        json: bool,
        prompt: &str,
    ) -> Result<Option<StartReview>, StartError> {
        if ids.is_empty() {
            return Ok(None);
        }
        if target_worktree_id != session.worktree_id.as_deref() {
            return Err(StartError::ScopeChanged(
                "Starting in another worktree would leave the comments' scope".to_string(),
            ));
        }
        let scope = match &session.worktree_id {
            Some(w) => vst_types::artifacts::ScopeKey::worktree(w.clone()),
            None => vst_types::artifacts::ScopeKey::project(project.id.clone()),
        };
        let port = self
            .json_registry
            .review_port()
            .ok_or_else(|| StartError::Internal("Review comments are unavailable".to_string()))?;
        let turn_id = vst_agents::util::new_uuid_v4();
        let hold = port
            .hold_for_turn(vst_types::review::HoldRequest {
                hold_id: vst_agents::util::new_uuid_v4(),
                scope,
                session_id: session.id.clone(),
                turn_id: turn_id.clone(),
                comment_ids: ids.to_vec(),
                composer_key: Some(format!("session:{}", session.id)),
            })
            .await
            .map_err(StartError::Review)?;
        let hold = vst_agents::json_agent_session::ReviewTurn {
            hold_id: hold.hold_id,
            record: hold.record,
        };
        // A Terminal launch carries the block in the tmux command line, which
        // tmux caps (~16 KB): refuse before anything is promoted or spawned.
        // The check covers the whole quoted launch prompt (draft text + block).
        if !json {
            let launch = crate::reset_carry::carried_message_with_review(prompt, &hold);
            if let Some(too_large) = crate::reset_carry::terminal_launch_prompt_too_large(&launch) {
                self.restore_hold(&hold.hold_id, vst_types::review::RestoreReason::SendFailed)
                    .await;
                return Err(StartError::Review(too_large));
            }
        }
        Ok(Some(StartReview {
            turn_id,
            hold,
            json,
        }))
    }

    /// The detached spawn of a started draft. With review comments: a Rich Chat
    /// target enqueues turn 1 carrying the hold; a Terminal target gets the block
    /// appended to its LAUNCH prompt only (never the persisted prompt), and the
    /// hold is consumed once the launch succeeded and restored when it failed.
    pub(crate) async fn spawn_started_draft(
        &self,
        mut opts: SpawnChannelOpts,
        review: Option<StartReview>,
    ) {
        let Some(review) = review else {
            self.spawn_new_session_for_channel(opts).await;
            return;
        };
        if review.json {
            start_json_create_turn(
                StartJsonCreateTurnOpts {
                    silent: false,
                    session_id: opts.session.id.clone(),
                    prompt: opts.prompt.clone(),
                    daemon_port: opts.daemon_port,
                    store: self.store.clone(),
                    broadcaster: self.broadcaster.clone(),
                    review: Some(review.hold),
                    turn_id: Some(review.turn_id),
                },
                &self.json_registry,
            )
            .await;
            return;
        }
        let message = opts.prompt.clone().unwrap_or_default();
        opts.prompt = Some(crate::reset_carry::carried_message_with_review(
            &message,
            &review.hold,
        ));
        let spawned = self.spawn_new_session_for_channel_checked(opts).await;
        crate::reset_carry::settle_terminal_holds(self, &[review.hold.hold_id], &spawned).await;
    }
}
