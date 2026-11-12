//! `GET /api/sessions/:id/transcript/search` and aroundSeq handler.
//! Thin route owner: validates query params and dispatches to vst-agents.

use serde::Deserialize;
use vst_agents::json_agent_chat::{
    find_json_session_context, read_session_page_around, search_session_transcript,
};
use vst_lifecycle::channel::session_channel;
use vst_store::transcript::{WINDOW_BYTE_BUDGET, WINDOW_TURNS};
use vst_store::transcript_search::{
    query_terms, SearchCursor, SearchError, SearchRequest, SearchScope, SEARCH_MAX_MATCHES,
};
use vst_types::domain::Channel;
use vst_types::rest::sessions::{
    SnippetSegment, TranscriptAroundPage, TranscriptSearchMatch, TranscriptSearchPage,
};

use crate::sessions::SessionRoutes;

/// Query parameters for `GET /api/sessions/:id/transcript/search`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct TranscriptSearchParams {
    pub q: Option<String>,
    pub scope: Option<String>,
    pub after: Option<String>,
    pub limit: Option<String>,
    pub snippets: Option<String>,
}

/// Errors returned by transcript search / around-page routes.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TranscriptSearchRouteError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    NotJson(String),
    /// Bad search parameters; wire code `QUERY_INVALID`.
    #[error("invalid query: {0}")]
    SearchQueryInvalid(String),
    /// Bad `aroundSeq`/`limit`; wire code `INVALID_QUERY`, the code the other
    /// transcript paging parameters already return.
    #[error("invalid query: {0}")]
    AroundQueryInvalid(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl SessionRoutes {
    /// `GET /api/sessions/:id/transcript/search`.
    pub async fn search_session_transcript(
        &self,
        id: &str,
        params: TranscriptSearchParams,
    ) -> Result<TranscriptSearchPage, TranscriptSearchRouteError> {
        let ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| {
                TranscriptSearchRouteError::NotFound(format!("Session '{id}' not found"))
            })?;

        if session_channel(ctx.session.channel, Some(ctx.session.use_tmux)) != Channel::Json {
            return Err(TranscriptSearchRouteError::NotJson(format!(
                "Session '{id}' has no event log (not a Rich Chat session)"
            )));
        }

        let raw_q = params.q.ok_or_else(|| {
            TranscriptSearchRouteError::SearchQueryInvalid("q is required".to_string())
        })?;

        if query_terms(&raw_q).is_err() {
            return Err(TranscriptSearchRouteError::SearchQueryInvalid(
                "q must be 1..=200 characters and contain usable terms".to_string(),
            ));
        }

        let scope = match params.scope.as_deref() {
            None | Some("") | Some("messages") => SearchScope::Messages,
            Some("all") => SearchScope::All,
            Some(_) => {
                return Err(TranscriptSearchRouteError::SearchQueryInvalid(
                    "scope must be 'messages' or 'all'".to_string(),
                ));
            }
        };

        let after = match params.after.as_deref() {
            None | Some("") => None,
            Some(s) => match SearchCursor::parse(s) {
                Ok(c) => Some(c),
                Err(_) => {
                    return Err(TranscriptSearchRouteError::SearchQueryInvalid(
                        "after must be '<seq>:<occurrence>'".to_string(),
                    ));
                }
            },
        };

        let limit = match params.limit.as_deref() {
            None | Some("") => SEARCH_MAX_MATCHES,
            Some(s) => {
                let l = s.parse::<usize>().map_err(|_| {
                    TranscriptSearchRouteError::SearchQueryInvalid(
                        "limit must be an integer".to_string(),
                    )
                })?;
                if !(1..=SEARCH_MAX_MATCHES).contains(&l) {
                    return Err(TranscriptSearchRouteError::SearchQueryInvalid(format!(
                        "limit must be 1..={SEARCH_MAX_MATCHES}"
                    )));
                }
                l
            }
        };

        let snippets = match params.snippets.as_deref() {
            None | Some("") | Some("0") => false,
            Some("1") => true,
            Some(_) => {
                return Err(TranscriptSearchRouteError::SearchQueryInvalid(
                    "snippets must be '0' or '1'".to_string(),
                ));
            }
        };

        let req = SearchRequest {
            q: raw_q.trim().to_string(),
            scope,
            after,
            limit,
            snippets,
        };

        let registry = self.json_registry.clone();
        let outcome =
            tokio::task::spawn_blocking(move || search_session_transcript(&ctx, &registry, &req))
                .await
                .map_err(|e| {
                    tracing::warn!(session_id = id, "transcript search task failed: {e}");
                    TranscriptSearchRouteError::Internal(e.to_string())
                })?
                .map_err(|e| match e {
                    SearchError::QueryInvalid => {
                        TranscriptSearchRouteError::SearchQueryInvalid("invalid query".to_string())
                    }
                    SearchError::Db(err) => {
                        tracing::warn!(session_id = id, "transcript search failed: {err}");
                        TranscriptSearchRouteError::Internal(err.to_string())
                    }
                })?;

        let matches = outcome
            .hits
            .into_iter()
            .map(|hit| TranscriptSearchMatch {
                seq: hit.seq,
                turn_id: hit.turn_id,
                turn_index: hit.turn_index,
                kind: hit.kind,
                occurrence: hit.occurrence,
                ts: hit.ts,
                snippet: hit.snippet.map(|segs| {
                    segs.into_iter()
                        .map(|(text, is_hit)| SnippetSegment {
                            text,
                            hit: if is_hit { Some(true) } else { None },
                        })
                        .collect()
                }),
            })
            .collect();

        Ok(TranscriptSearchPage {
            query: outcome.query,
            total: outcome.total,
            total_capped: outcome.total_capped,
            matches,
            next_cursor: outcome.next_cursor,
            indexed_through_seq: outcome.indexed_through_seq,
            backfilling: outcome.backfilling,
            turn_count: outcome.turn_count,
        })
    }

    /// `GET /api/sessions/:id/transcript?aroundSeq=<n>&limit=<l>`.
    pub async fn get_session_transcript_around(
        &self,
        id: &str,
        around_seq: &str,
        limit: Option<&str>,
    ) -> Result<TranscriptAroundPage, TranscriptSearchRouteError> {
        let ctx = find_json_session_context(&self.store, id)
            .await
            .ok_or_else(|| {
                TranscriptSearchRouteError::NotFound(format!("Session '{id}' not found"))
            })?;

        if session_channel(ctx.session.channel, Some(ctx.session.use_tmux)) != Channel::Json {
            return Err(TranscriptSearchRouteError::NotJson(format!(
                "Session '{id}' has no event log (not a Rich Chat session)"
            )));
        }

        let seq = match around_seq.parse::<i64>() {
            Ok(s) if s >= 0 => s,
            _ => {
                return Err(TranscriptSearchRouteError::AroundQueryInvalid(
                    "aroundSeq must be an integer >= 0".to_string(),
                ));
            }
        };

        let limit = match limit {
            None | Some("") => WINDOW_TURNS,
            Some(s) => match s.parse::<i64>() {
                Ok(l) if (1..=50).contains(&l) => l,
                _ => {
                    return Err(TranscriptSearchRouteError::AroundQueryInvalid(
                        "limit must be an integer 1..=50".to_string(),
                    ));
                }
            },
        };

        let registry = self.json_registry.clone();
        let page = tokio::task::spawn_blocking(move || {
            read_session_page_around(&ctx, &registry, seq, limit, WINDOW_BYTE_BUDGET)
        })
        .await
        .map_err(|e| {
            tracing::warn!(session_id = id, "transcript around task failed: {e}");
            TranscriptSearchRouteError::Internal(e.to_string())
        })?
        .map_err(|e| {
            tracing::warn!(session_id = id, "transcript around read failed: {e}");
            TranscriptSearchRouteError::Internal(e.to_string())
        })?;

        Ok(TranscriptAroundPage {
            events: page.events,
            oldest_seq: page.oldest_seq,
            has_more: page.has_more,
            turns_before: page.turns_before,
        })
    }
}
