//! `GET /api/sessions/:id/transcript/outline` (summary) and `.../outline/window`.
//! Thin route owner: validates query params and dispatches to vst-agents.

use serde::Deserialize;
use vst_agents::json_agent_chat::{
    find_json_session_context, read_session_outline_summary, read_session_outline_window,
};
use vst_lifecycle::channel::session_channel;
use vst_store::transcript_outline::{
    OutlineSummary, OUTLINE_WINDOW_DEFAULT_LIMIT, OUTLINE_WINDOW_MAX_LIMIT,
};
use vst_types::domain::Channel;
use vst_types::rest::sessions::{
    TranscriptOutlineCounts, TranscriptOutlineSummary, TranscriptOutlineTurn,
    TranscriptOutlineWindow,
};

use crate::sessions::SessionRoutes;

/// Query parameters for `GET /api/sessions/:id/transcript/outline/window`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct TranscriptOutlineWindowParams {
    pub from: Option<String>,
    pub limit: Option<String>,
}

/// Errors returned by the transcript outline routes.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TranscriptOutlineRouteError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    NotJson(String),
    #[error("invalid query: {0}")]
    QueryInvalid(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("internal error: {0}")]
    Internal(String),
}

/// The outline summary together with the ETag it is served under (ready only).
pub struct TranscriptOutlineSummaryReply {
    pub summary: TranscriptOutlineSummary,
    pub etag: Option<String>,
}

impl SessionRoutes {
    /// `GET /api/sessions/:id/transcript/outline`.
    pub async fn get_session_transcript_outline(
        &self,
        id: &str,
    ) -> Result<TranscriptOutlineSummaryReply, TranscriptOutlineRouteError> {
        let ctx = self.outline_context(id).await?;
        let registry = self.json_registry.clone();
        let summary = blocking_read(id, move || read_session_outline_summary(&ctx, &registry))
            .await?
            .ok_or_else(|| unavailable(id))?;
        let etag = summary
            .ready
            .then(|| format!("\"{}-{}\"", summary.revision, summary.max_seq));
        Ok(TranscriptOutlineSummaryReply {
            summary: summary_wire(summary),
            etag,
        })
    }

    /// `GET /api/sessions/:id/transcript/outline/window?from=&limit=`.
    pub async fn get_session_transcript_outline_window(
        &self,
        id: &str,
        params: TranscriptOutlineWindowParams,
    ) -> Result<TranscriptOutlineWindow, TranscriptOutlineRouteError> {
        let from = match params.from.as_deref() {
            None | Some("") => {
                return Err(TranscriptOutlineRouteError::QueryInvalid(
                    "from must be an integer >= 0".to_string(),
                ));
            }
            Some(s) => match s.parse::<i64>() {
                Ok(v) if v >= 0 => v,
                _ => {
                    return Err(TranscriptOutlineRouteError::QueryInvalid(
                        "from must be an integer >= 0".to_string(),
                    ));
                }
            },
        };
        let limit = match params.limit.as_deref() {
            None | Some("") => OUTLINE_WINDOW_DEFAULT_LIMIT,
            Some(s) => match s.parse::<usize>() {
                Ok(l) if (1..=OUTLINE_WINDOW_MAX_LIMIT).contains(&l) => l,
                _ => {
                    return Err(TranscriptOutlineRouteError::QueryInvalid(format!(
                        "limit must be an integer 1..={OUTLINE_WINDOW_MAX_LIMIT}"
                    )));
                }
            },
        };

        let ctx = self.outline_context(id).await?;
        let registry = self.json_registry.clone();
        let window = blocking_read(id, move || {
            read_session_outline_window(&ctx, &registry, from, limit)
        })
        .await?
        .ok_or_else(|| unavailable(id))?;

        Ok(TranscriptOutlineWindow {
            ready: window.ready,
            total_turns: window.total_turns,
            revision: window.revision.to_string(),
            from: window.from,
            turns: window
                .turns
                .into_iter()
                .map(|t| TranscriptOutlineTurn {
                    seq: t.seq,
                    turn_key: t.turn_key,
                    label: t.label,
                    ts: t.ts,
                    counts: TranscriptOutlineCounts {
                        tools: t.tools,
                        edits: t.edits,
                        errors: t.errors,
                    },
                })
                .collect(),
        })
    }

    /// The Rich Chat session behind an outline request; anything else is `NOT_JSON`.
    async fn outline_context(
        &self,
        id: &str,
    ) -> Result<vst_agents::json_agent_chat::JsonSessionContext, TranscriptOutlineRouteError> {
        let ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| {
                TranscriptOutlineRouteError::NotFound(format!("Session '{id}' not found"))
            })?;
        if session_channel(ctx.session.channel, Some(ctx.session.use_tmux)) != Channel::Json {
            return Err(TranscriptOutlineRouteError::NotJson(format!(
                "Session '{id}' has no event log (not a Rich Chat session)"
            )));
        }
        Ok(ctx)
    }
}

fn unavailable(id: &str) -> TranscriptOutlineRouteError {
    TranscriptOutlineRouteError::Unavailable(format!("Outline unavailable for session '{id}'"))
}

/// Runs a blocking outline read, mapping a join or SQLite failure to `INTERNAL`.
async fn blocking_read<T, E, F>(id: &str, read: F) -> Result<T, TranscriptOutlineRouteError>
where
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    tokio::task::spawn_blocking(read)
        .await
        .map_err(|e| {
            tracing::warn!(session_id = id, "transcript outline task failed: {e}");
            TranscriptOutlineRouteError::Internal(e.to_string())
        })?
        .map_err(|e| {
            tracing::warn!(session_id = id, "transcript outline read failed: {e}");
            TranscriptOutlineRouteError::Internal(e.to_string())
        })
}

fn summary_wire(s: OutlineSummary) -> TranscriptOutlineSummary {
    TranscriptOutlineSummary {
        ready: s.ready,
        total_turns: s.total_turns,
        revision: s.revision.to_string(),
        bucket_size: s.bucket_size,
        tools: s.tools,
        edits: s.edits,
        errors: s.errors,
    }
}
