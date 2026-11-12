//! FTS5 trigram search index and query engine for session transcripts.
//!
//! The index unit is a contiguous text run, not a single delta row, so words
//! split across streaming chunks still match. Run continuation is a pure
//! function of the row sequence; the in-memory `open_run` is only a cache.

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use vst_types::{NormalizedEvent, NormalizedEventKind};

use crate::transcript::TranscriptStore;

pub const SEARCH_MAX_MATCHES: usize = 1000;
pub(crate) const TOOL_INDEX_MAX_CHARS: usize = 3072;
pub const BACKFILL_CHUNK_ROWS: i64 = 5000;
/// Sample size for the "index is behind the live boundary" self-heal check.
const BEHIND_RUN: i64 = 32;
pub const BACKFILL_BUDGET: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchScope {
    Messages,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchCursor {
    pub seq: i64,
    pub occurrence: u32,
}

impl SearchCursor {
    pub fn parse(s: &str) -> Result<Self, SearchError> {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() != 2 {
            return Err(SearchError::QueryInvalid);
        }
        let seq_str = parts[0];
        let occ_str = parts[1];
        if seq_str.is_empty()
            || occ_str.is_empty()
            || seq_str.starts_with('+')
            || occ_str.starts_with('+')
        {
            return Err(SearchError::QueryInvalid);
        }
        let seq = seq_str
            .parse::<i64>()
            .map_err(|_| SearchError::QueryInvalid)?;
        let occurrence = occ_str
            .parse::<u32>()
            .map_err(|_| SearchError::QueryInvalid)?;
        if seq < 0 {
            return Err(SearchError::QueryInvalid);
        }
        Ok(Self { seq, occurrence })
    }
}

impl std::fmt::Display for SearchCursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.seq, self.occurrence)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchRequest {
    pub q: String,
    pub scope: SearchScope,
    pub after: Option<SearchCursor>,
    pub limit: usize,
    pub snippets: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    pub seq: i64,
    pub turn_id: Option<String>,
    pub turn_index: i64,
    pub kind: String,
    pub occurrence: u32,
    pub ts: Option<String>,
    pub snippet: Option<Vec<(String, bool)>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchOutcome {
    pub query: String,
    pub total: usize,
    pub total_capped: bool,
    pub hits: Vec<SearchHit>,
    pub next_cursor: Option<String>,
    pub indexed_through_seq: Option<i64>,
    pub backfilling: bool,
    pub turn_count: i64,
}

impl SearchOutcome {
    pub fn empty(query: String) -> Self {
        Self {
            query,
            total: 0,
            total_capped: false,
            hits: Vec::new(),
            next_cursor: None,
            indexed_through_seq: None,
            backfilling: false,
            turn_count: 0,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("invalid query")]
    QueryInvalid,
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
}

/// The Terms rule:
/// 1. trimmed = q.trim(); invalid when empty or longer than 200 Unicode scalars.
/// 2. words = trimmed split on Unicode whitespace, so interior whitespace (space, tab,
///    newline) is normalised away; non-whitespace control characters are rejected.
/// 3. terms = words of >=3 scalars, de-duplicated after folding. Not handled: a word
///    whose folded form is <3 scalars — the trigram index would match every row.
/// 4. If terms is empty: when trimmed has >=3 scalars use [trimmed] (one phrase; interior
///    whitespace is kept verbatim there, e.g. "a  b"),
///    otherwise the query is server-invalid.
pub fn query_terms(q: &str) -> Result<Vec<String>, SearchError> {
    let trimmed = q.trim();
    if trimmed
        .chars()
        .any(|c| c.is_control() && !c.is_whitespace())
    {
        return Err(SearchError::QueryInvalid);
    }
    let scalar_count = trimmed.chars().count();
    if scalar_count == 0 || scalar_count > 200 {
        return Err(SearchError::QueryInvalid);
    }

    let mut terms = Vec::new();
    let mut seen_folded = std::collections::HashSet::new();

    for word in trimmed.split_whitespace() {
        if word.chars().count() >= 3 {
            let folded = word.to_lowercase();
            if seen_folded.insert(folded) {
                terms.push(word.to_string());
            }
        }
    }

    if terms.is_empty() {
        if scalar_count >= 3 {
            terms.push(trimmed.to_string());
        } else {
            return Err(SearchError::QueryInvalid);
        }
    }

    Ok(terms)
}

pub(crate) fn format_fts_query(terms: &[String]) -> String {
    terms
        .iter()
        .map(|t| {
            let escaped = t.replace('"', "\"\"");
            format!("\"{escaped}\"")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The one definition of the FTS table's module and columns (after the table name).
pub(crate) const FTS_TABLE_SPEC: &str =
    "USING fts5(body, kind UNINDEXED, tokenize='trigram remove_diacritics 1')";

pub fn ensure_schema(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "
        CREATE VIRTUAL TABLE IF NOT EXISTS message_fts {FTS_TABLE_SPEC};
        CREATE TABLE IF NOT EXISTS message_fts_state (
            session_id TEXT PRIMARY KEY,
            live_from_seq INTEGER NOT NULL,
            backfill_next_seq INTEGER NOT NULL,
            stale INTEGER NOT NULL DEFAULT 0
        );
        "
    ))?;

    // Seed state row if missing: live_from_seq = MAX(seq) + 1, backfill_next_seq = 0
    let max_seq: Option<i64> = conn
        .query_row(
            "SELECT MAX(seq) FROM message WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let live_from_seq = max_seq.map_or(0, |m| m + 1);

    conn.execute(
        "INSERT OR IGNORE INTO message_fts_state (session_id, live_from_seq, backfill_next_seq, stale)
         VALUES (?1, ?2, 0, 0)",
        params![session_id, live_from_seq],
    )?;

    Ok(())
}

/// Persist the stale flag so the index is rebuilt before the next search, even
/// after a restart. Callers must also set the in-memory flag
/// ([`SearchWriter::mark_stale`]) because this write can fail.
fn mark_stale(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE message_fts_state SET stale = 1 WHERE session_id = ?1",
        params![session_id],
    )?;
    Ok(())
}

fn doc_kind(ev: &NormalizedEvent) -> Option<&'static str> {
    match ev.kind {
        NormalizedEventKind::User => {
            if ev.silent == Some(true) {
                None
            } else {
                Some("user")
            }
        }
        NormalizedEventKind::Text => Some("text"),
        NormalizedEventKind::Thinking => Some("thinking"),
        NormalizedEventKind::ToolUse => Some("tool_use"),
        NormalizedEventKind::ToolResult => Some("tool_result"),
        _ => None,
    }
}

fn is_run_kind(kind: &str) -> bool {
    kind == "text" || kind == "thinking"
}

fn index_text(ev: &NormalizedEvent) -> String {
    match ev.kind {
        NormalizedEventKind::User | NormalizedEventKind::Text | NormalizedEventKind::Thinking => {
            ev.text.clone().unwrap_or_default()
        }
        NormalizedEventKind::ToolUse => {
            let mut parts = Vec::new();
            if let Some(ref name) = ev.tool_name {
                if !name.is_empty() {
                    parts.push(name.clone());
                }
            }
            if let Some(ref input) = ev.tool_input {
                extract_strings_from_json(input, &mut parts);
            }
            let joined = parts.join("\n");
            truncate_chars(&joined, TOOL_INDEX_MAX_CHARS).to_string()
        }
        NormalizedEventKind::ToolResult => {
            let content = ev
                .tool_result
                .as_ref()
                .and_then(|r| r.content.as_deref())
                .unwrap_or("");
            truncate_chars(content, TOOL_INDEX_MAX_CHARS).to_string()
        }
        _ => String::new(),
    }
}

fn extract_strings_from_json(val: &serde_json::Value, out: &mut Vec<String>) {
    match val {
        serde_json::Value::String(s) => {
            out.push(s.clone());
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                extract_strings_from_json(v, out);
            }
        }
        serde_json::Value::Object(map) => {
            for v in map.values() {
                extract_strings_from_json(v, out);
            }
        }
        _ => {}
    }
}

fn truncate_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn sanitize(s: &str) -> String {
    s.chars()
        .filter(|&c| c != '\u{1}' && c != '\u{2}')
        .collect()
}

/// Cache of the currently open contiguous text run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum OpenRun {
    /// Run state has not been resolved from durable storage yet (e.g. after store reopen).
    Unknown,
    /// The preceding row did not start or continue a run (e.g. user, tool_use, or non-content event).
    None,
    /// The preceding row belongs to an active run described by [`Run`].
    Known(Run),
}

/// Description of an active contiguous run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Run {
    pub kind: &'static str,
    pub turn_id: Option<String>,
    /// The `rowid` of the document in `message_fts`, or `None` if all rows in this run so far were empty.
    pub doc_seq: Option<i64>,
}

pub struct SearchWriter {
    pub(crate) open_run: OpenRun,
    pub(crate) stale: bool,
}

impl SearchWriter {
    pub fn new() -> Self {
        Self {
            open_run: OpenRun::Unknown,
            stale: false,
        }
    }

    /// Flag the index stale in memory and, best effort, durably. A failed durable
    /// write is logged; the in-memory flag still forces a rebuild before the next
    /// search in this process.
    pub fn mark_stale(&mut self, conn: &Connection, session_id: &str) {
        self.stale = true;
        if let Err(e) = mark_stale(conn, session_id) {
            tracing::warn!(
                session_id,
                "transcript_search: persisting stale flag failed: {e}"
            );
        }
    }

    /// Forget the cached open run, e.g. after a transaction that wrote it rolled
    /// back; the next row re-derives it from durable storage.
    pub(crate) fn reset_open_run(&mut self) {
        self.open_run = OpenRun::Unknown;
    }

    /// Run continuation is a pure function of the row sequence, so it survives a daemon restart:
    /// the in-memory `open_run` is only a cache of "what did the previous row start".
    fn resolve_open_run(
        &mut self,
        conn: &Connection,
        session_id: &str,
        seq: i64,
    ) -> rusqlite::Result<Option<Run>> {
        match &self.open_run {
            OpenRun::Known(run) => Ok(Some(run.clone())),
            OpenRun::None => Ok(None),
            OpenRun::Unknown => {
                let prev_row: Option<(String, Option<String>)> = conn
                    .query_row(
                        "SELECT kind, turn_id FROM message WHERE session_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT 1",
                        params![session_id, seq],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;

                let Some((prev_kind, prev_turn_id)) = prev_row else {
                    self.open_run = OpenRun::None;
                    return Ok(None);
                };

                let kind_static = match prev_kind.as_str() {
                    "text" => "text",
                    "thinking" => "thinking",
                    _ => {
                        self.open_run = OpenRun::None;
                        return Ok(None);
                    }
                };

                let not_same_max: Option<i64> = conn
                    .query_row(
                        "SELECT MAX(seq) FROM message WHERE session_id = ?1 AND seq < ?2 AND (kind != ?3 OR turn_id IS NOT ?4)",
                        params![session_id, seq, kind_static, prev_turn_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();

                let run_start = match not_same_max {
                    Some(s) => s + 1,
                    None => conn
                        .query_row(
                            "SELECT MIN(seq) FROM message WHERE session_id = ?1",
                            params![session_id],
                            |r| r.get(0),
                        )
                        .optional()?
                        .flatten()
                        .unwrap_or(seq),
                };

                let doc_seq: Option<i64> = conn
                    .query_row(
                        "SELECT MAX(rowid) FROM message_fts WHERE rowid >= ?1 AND rowid < ?2",
                        params![run_start, seq],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();

                let run = Run {
                    kind: kind_static,
                    turn_id: prev_turn_id,
                    doc_seq,
                };
                self.open_run = OpenRun::Known(run.clone());
                Ok(Some(run))
            }
        }
    }

    pub fn index_event(
        &mut self,
        txn: &Transaction,
        session_id: &str,
        seq: i64,
        ev: &NormalizedEvent,
    ) -> rusqlite::Result<()> {
        if self.stale {
            return Ok(());
        }
        let Some(kind) = doc_kind(ev) else {
            self.open_run = OpenRun::None;
            return Ok(());
        };
        let body = sanitize(&index_text(ev));
        if is_run_kind(kind) {
            let cont = self
                .resolve_open_run(txn, session_id, seq)?
                .filter(|r| r.kind == kind && r.turn_id == ev.turn_id);
            match cont {
                Some(mut run) if run.doc_seq.is_some() => {
                    if !body.is_empty() {
                        let updated = txn.execute(
                            "UPDATE message_fts SET body = body || ?1 WHERE rowid = ?2",
                            params![body, run.doc_seq],
                        )?;
                        // The cached document is gone (its transaction rolled back after
                        // the cache was set): start a new document here rather than
                        // dropping this text.
                        if updated == 0 {
                            txn.execute(
                                "INSERT INTO message_fts (rowid, body, kind) VALUES (?1, ?2, ?3)",
                                params![seq, body, kind],
                            )?;
                            run.doc_seq = Some(seq);
                        }
                    }
                    self.open_run = OpenRun::Known(run);
                }
                _ => {
                    let doc = if body.is_empty() {
                        None
                    } else {
                        txn.execute(
                            "INSERT INTO message_fts (rowid, body, kind) VALUES (?1, ?2, ?3)",
                            params![seq, body, kind],
                        )?;
                        Some(seq)
                    };
                    self.open_run = OpenRun::Known(Run {
                        kind,
                        turn_id: ev.turn_id.clone(),
                        doc_seq: doc,
                    });
                }
            }
        } else {
            self.open_run = OpenRun::None;
            if !body.is_empty() {
                txn.execute(
                    "INSERT INTO message_fts (rowid, body, kind) VALUES (?1, ?2, ?3)",
                    params![seq, body, kind],
                )?;
            }
        }
        Ok(())
    }
}

struct ParsedHighlight {
    pub text_chars: Vec<char>,
    pub occ_spans: Vec<(usize, usize)>,
}

/// Parses the output of `highlight(message_fts, 0, char(1), char(2))`
/// into character buffer and occurrence spans.
fn parse_highlight_spans(highlighted: &str) -> ParsedHighlight {
    let mut occ_spans = Vec::new();
    let mut in_match = false;
    let mut match_start_char = 0usize;
    let mut text_chars = Vec::new();

    for c in highlighted.chars() {
        if c == '\u{1}' {
            in_match = true;
            match_start_char = text_chars.len();
        } else if c == '\u{2}' {
            if in_match {
                let match_end_char = text_chars.len();
                occ_spans.push((match_start_char, match_end_char));
                in_match = false;
            }
        } else {
            text_chars.push(c);
        }
    }

    ParsedHighlight {
        text_chars,
        occ_spans,
    }
}

fn build_snippet(
    text_chars: &[char],
    occ_spans: &[(usize, usize)],
    m_start: usize,
    m_end: usize,
) -> Vec<(String, bool)> {
    let total_len = text_chars.len();
    let match_len = m_end.saturating_sub(m_start);
    let budget = 160usize;

    let (win_start, win_end) = if match_len >= budget {
        (m_start, m_start + budget)
    } else {
        let rem = budget - match_len;
        let want_before = rem / 2;
        let want_after = rem - want_before;

        let avail_before = m_start;
        let avail_after = total_len.saturating_sub(m_end);

        let take_before = if avail_before < want_before {
            avail_before
        } else if avail_after < want_after {
            (want_before + (want_after - avail_after)).min(avail_before)
        } else {
            want_before
        };

        let start = m_start - take_before;
        let remaining_budget = budget.saturating_sub(m_end - start);
        let end = (m_end + remaining_budget).min(total_len);
        (start, end)
    };

    // Build segments inside [win_start, win_end)
    // Mark any span in occ_spans that intersects [win_start, win_end) as hit = true.
    let mut segments = Vec::new();
    let mut cur = win_start;

    // Find all spans overlapping [win_start, win_end)
    for &(os, oe) in occ_spans {
        if oe <= win_start || os >= win_end {
            continue;
        }
        let hit_s = os.max(win_start);
        let hit_e = oe.min(win_end);

        if hit_s > cur {
            let s: String = text_chars[cur..hit_s].iter().collect();
            let collapsed = collapse_whitespace(&s);
            if !collapsed.is_empty() {
                segments.push((collapsed, false));
            }
        }
        let s: String = text_chars[hit_s..hit_e].iter().collect();
        let collapsed = collapse_whitespace(&s);
        if !collapsed.is_empty() {
            segments.push((collapsed, true));
        }
        cur = hit_e;
    }

    if cur < win_end {
        let s: String = text_chars[cur..win_end].iter().collect();
        let collapsed = collapse_whitespace(&s);
        if !collapsed.is_empty() {
            segments.push((collapsed, false));
        }
    }

    // Merge adjacent segments with same hit flag
    let mut merged: Vec<(String, bool)> = Vec::new();
    for (text, hit) in segments {
        if let Some(last) = merged.last_mut() {
            if last.1 == hit {
                last.0.push_str(&text);
                continue;
            }
        }
        merged.push((text, hit));
    }

    // Ensure total chars <= 160
    let mut total_chars = 0;
    let mut capped = Vec::new();
    for (text, hit) in merged {
        let c_count = text.chars().count();
        if total_chars + c_count <= 160 {
            total_chars += c_count;
            capped.push((text, hit));
        } else {
            let take = 160 - total_chars;
            if take > 0 {
                let sub: String = text.chars().take(take).collect();
                capped.push((sub, hit));
            }
            break;
        }
    }

    capped
}

fn collapse_whitespace(s: &str) -> String {
    let mut res = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !in_ws {
                res.push(' ');
                in_ws = true;
            }
        } else {
            res.push(c);
            in_ws = false;
        }
    }
    res
}

/// Resets the index inside `txn`: drop and recreate the (single-session) fts
/// table (cheap: the dropped pages go to the freelist, the file does not
/// shrink), then restart backfill from seq 0.
fn rebuild_stale_in(txn: &Transaction<'_>, session_id: &str) -> rusqlite::Result<()> {
    txn.execute_batch(&format!(
        "DROP TABLE IF EXISTS message_fts;
         CREATE VIRTUAL TABLE message_fts {FTS_TABLE_SPEC};"
    ))?;
    let max_seq: Option<i64> = txn
        .query_row(
            "SELECT MAX(seq) FROM message WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let live_from_seq = max_seq.map_or(0, |m| m + 1);
    txn.execute(
        "UPDATE message_fts_state SET live_from_seq = ?1, backfill_next_seq = 0, stale = 0 WHERE session_id = ?2",
        params![live_from_seq, session_id],
    )?;
    Ok(())
}

/// Self-heal: rows written past `live_from_seq` without going through
/// `insert_message` (a raw import/seed after the state row was created) were
/// never indexed live and backfill never covers them. Samples the OLDEST
/// `BEHIND_RUN` non-silent `user`/`tool_use` rows at or past `live_from_seq`
/// (streamed `text`/`thinking` deltas merge into one document, so they are
/// excluded): live appends only ever land after them, so later live rows cannot
/// hide a raw run the way a newest-rows sample would. Behind when a full sample
/// is mostly without a document. A full sample, not one row, so a few
/// legitimately unindexed rows (empty text) never trigger a rebuild; a rebuild
/// moves `live_from_seq` past the last row, so it cannot trigger twice for the
/// same rows.
fn index_misses_live_tail(conn: &Connection, session_id: &str) -> rusqlite::Result<bool> {
    let live: Option<i64> = conn
        .query_row(
            "SELECT live_from_seq FROM message_fts_state WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(live) = live else { return Ok(false) };
    let (sampled, missing): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN f.rowid IS NULL THEN 1 ELSE 0 END), 0)
           FROM (SELECT seq FROM message WHERE session_id = ?1 AND seq >= ?2
                   AND superseded = 0 AND kind IN ('user','tool_use')
                   AND COALESCE(json_extract(payload, '$.silent'), 0) = 0
                  ORDER BY seq ASC LIMIT ?3) s
           LEFT JOIN message_fts f ON f.rowid = s.seq",
        params![session_id, live, BEHIND_RUN],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(sampled >= BEHIND_RUN && missing * 2 > sampled)
}

impl TranscriptStore {
    /// One backfill chunk. State and chunk rows are read inside an immediate
    /// transaction so two connections cannot both index the same chunk. A stale
    /// index is rebuilt first, so chunk work is never wiped afterwards.
    pub fn backfill_step(&mut self) -> rusqlite::Result<bool> {
        // Lock-free fast path: a complete, non-stale index needs no write txn.
        // Anything else re-reads inside the Immediate txn below.
        if !self.search.stale {
            let pre: Option<(i64, i64, i64)> = self
                .conn
                .query_row(
                    "SELECT live_from_seq, backfill_next_seq, stale FROM message_fts_state WHERE session_id = ?1",
                    params![self.session_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((live, next, stale)) = pre {
                if stale != 1 && next >= live {
                    return Ok(true);
                }
            }
        }
        let txn = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let persisted_stale: Option<i64> = txn
            .query_row(
                "SELECT stale FROM message_fts_state WHERE session_id = ?1",
                params![self.session_id],
                |r| r.get(0),
            )
            .optional()?;
        let mut rebuilt = false;
        if persisted_stale == Some(1) || self.search.stale {
            rebuild_stale_in(&txn, &self.session_id)?;
            rebuilt = true;
        }
        let state: Option<(i64, i64)> = txn
            .query_row(
                "SELECT live_from_seq, backfill_next_seq FROM message_fts_state WHERE session_id = ?1",
                params![self.session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let Some((live_from_seq, backfill_next_seq)) = state else {
            txn.commit()?;
            self.finish_rebuild(rebuilt);
            return Ok(true);
        };

        let chunk_limit = (live_from_seq - backfill_next_seq).min(BACKFILL_CHUNK_ROWS);
        if chunk_limit <= 0 {
            txn.commit()?;
            self.finish_rebuild(rebuilt);
            return Ok(true);
        }

        let next_target = backfill_next_seq + chunk_limit;

        let rows: Vec<(i64, String)> = {
            let mut stmt = txn.prepare(
                "SELECT seq, payload FROM message WHERE session_id = ?1 AND seq >= ?2 AND seq < ?3 ORDER BY seq ASC",
            )?;
            let result = stmt
                .query_map(
                    params![self.session_id, backfill_next_seq, next_target],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            result
        };

        let mut local_writer = SearchWriter::new();
        for (seq, payload) in rows {
            match serde_json::from_str::<NormalizedEvent>(&payload) {
                Ok(ev) => local_writer.index_event(&txn, &self.session_id, seq, &ev)?,
                // An unparseable row is not indexed; re-derive the run for the next
                // row from the row sequence instead of trusting the cache across it.
                Err(_) => local_writer.reset_open_run(),
            }
        }

        txn.execute(
            "UPDATE message_fts_state SET backfill_next_seq = ?1 WHERE session_id = ?2",
            params![next_target, self.session_id],
        )?;

        txn.commit()?;
        self.finish_rebuild(rebuilt);

        Ok(next_target >= live_from_seq)
    }

    /// In-memory side of a rebuild, only after its txn committed.
    fn finish_rebuild(&mut self, rebuilt: bool) {
        if rebuilt {
            self.search.stale = false;
            self.search.open_run = OpenRun::Unknown;
        }
    }

    /// Read-only pre-check: only decides whether to enter `rebuild_stale`,
    /// which re-checks everything under its write lock and does all writes.
    fn check_stale(&self) -> Result<bool, SearchError> {
        let is_stale: Option<i64> = self
            .conn
            .query_row(
                "SELECT stale FROM message_fts_state WHERE session_id = ?1",
                params![self.session_id],
                |r| r.get(0),
            )
            .optional()?;
        if is_stale == Some(1) || self.search.stale {
            return Ok(true);
        }
        Ok(index_misses_live_tail(&self.conn, &self.session_id)?)
    }

    fn rebuild_stale(&mut self) -> Result<(), SearchError> {
        let txn = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Another connection may have rebuilt since check_stale; re-check under the lock.
        let persisted: Option<i64> = txn
            .query_row(
                "SELECT stale FROM message_fts_state WHERE session_id = ?1",
                params![self.session_id],
                |r| r.get(0),
            )
            .optional()?;
        let rebuilt = persisted == Some(1)
            || self.search.stale
            || index_misses_live_tail(&txn, &self.session_id)?;
        if rebuilt {
            rebuild_stale_in(&txn, &self.session_id)?;
        }
        txn.commit()?;
        self.finish_rebuild(rebuilt);
        Ok(())
    }

    pub fn search(&mut self, req: &SearchRequest) -> Result<SearchOutcome, SearchError> {
        let terms = query_terms(&req.q)?;

        if self.check_stale()? {
            self.rebuild_stale()?;
        }

        let fts_query = format_fts_query(&terms);
        let cursor_seq = req.after.map(|c| c.seq).unwrap_or(0);
        let sql_limit = (SEARCH_MAX_MATCHES + 1 + usize::from(req.after.is_some())) as i64;

        const MESSAGES_SCOPE: &str = "AND message_fts.kind IN ('user', 'text')";
        let scope_clause = match req.scope {
            SearchScope::Messages => MESSAGES_SCOPE,
            SearchScope::All => "",
        };
        let query_sql = format!(
            "SELECT message_fts.rowid, message_fts.kind, m.turn_id, m.ts, highlight(message_fts, 0, char(1), char(2))
             FROM message_fts
             JOIN message m ON m.session_id = ?1 AND m.seq = message_fts.rowid AND m.superseded = 0
             WHERE message_fts MATCH ?2 AND message_fts.rowid >= ?3
               {scope_clause}
             ORDER BY message_fts.rowid LIMIT ?4"
        );
        let mut stmt = self.conn.prepare(&query_sql)?;
        type SqlRow = (i64, String, Option<String>, Option<String>, String);
        let sql_rows: Vec<SqlRow> = stmt
            .query_map(
                params![self.session_id, fts_query, cursor_seq, sql_limit],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )?
            .collect::<Result<Vec<_>, _>>()?;

        let indexed_through_seq: Option<i64> = self
            .conn
            .query_row(
                "SELECT MAX(seq) FROM message WHERE session_id = ?1 AND superseded = 0",
                params![self.session_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();

        let state_info: Option<(i64, i64)> = self
            .conn
            .query_row(
                "SELECT live_from_seq, backfill_next_seq FROM message_fts_state WHERE session_id = ?1",
                params![self.session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let backfilling = match state_info {
            Some((live, backfill)) => backfill < live,
            None => false,
        };

        let mut hits = Vec::new();
        let mut total = 0usize;
        let mut total_capped = false;

        'outer: for (seq, kind, turn_id, ts, highlighted) in sql_rows {
            let parsed = parse_highlight_spans(&highlighted);
            for (occ_idx, &(m_start, m_end)) in parsed.occ_spans.iter().enumerate() {
                let occurrence = occ_idx as u32;
                if let Some(cursor) = req.after {
                    if seq < cursor.seq || (seq == cursor.seq && occurrence <= cursor.occurrence) {
                        continue;
                    }
                }

                total += 1;
                if total > SEARCH_MAX_MATCHES {
                    total_capped = true;
                    total = SEARCH_MAX_MATCHES;
                    break 'outer;
                }

                if hits.len() < req.limit {
                    let snippet = if req.snippets {
                        Some(build_snippet(
                            &parsed.text_chars,
                            &parsed.occ_spans,
                            m_start,
                            m_end,
                        ))
                    } else {
                        None
                    };
                    hits.push(SearchHit {
                        seq,
                        turn_id: turn_id.clone(),
                        // Filled in below once the turn starts are known.
                        turn_index: 0,
                        kind: kind.clone(),
                        occurrence,
                        ts: ts.clone(),
                        snippet,
                    });
                }
            }
        }

        // Turn starts need a scan of every user row, so read them only when a hit
        // needs its turn index; otherwise counting the turns is enough.
        let turn_count = if hits.is_empty() {
            self.user_turn_count()?
        } else {
            let starts = self.user_turn_starts()?;
            for hit in &mut hits {
                hit.turn_index = starts.partition_point(|&s| s <= hit.seq) as i64;
            }
            starts.len() as i64
        };

        let next_cursor = if hits.len() < total || total_capped {
            hits.last().map(|h| {
                SearchCursor {
                    seq: h.seq,
                    occurrence: h.occurrence,
                }
                .to_string()
            })
        } else {
            None
        };

        Ok(SearchOutcome {
            query: req.q.trim().to_string(),
            total,
            total_capped,
            hits,
            next_cursor,
            indexed_through_seq,
            backfilling,
            turn_count,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::open_transcript_store;
    use rusqlite::OptionalExtension;
    use vst_types::{NormalizedEventKind, NormalizedEventProvider, Role};

    const SESSION_ID: &str = "test-session";

    fn ev(kind: NormalizedEventKind, turn_id: Option<&str>, text: Option<&str>) -> NormalizedEvent {
        NormalizedEvent {
            id: "ev".to_string(),
            session_id: SESSION_ID.to_string(),
            ts: "2026-11-12T00:00:00.000Z".to_string(),
            provider: NormalizedEventProvider::Claude,
            kind,
            role: match kind {
                NormalizedEventKind::User => Some(Role::User),
                NormalizedEventKind::Text | NormalizedEventKind::Thinking => Some(Role::Assistant),
                _ => None,
            },
            text: text.map(|s| s.to_string()),
            tool_name: None,
            tool_id: None,
            tool_input: None,
            tool_result: None,
            usage: None,
            model: None,
            turn_id: turn_id.map(|s| s.to_string()),
            log_seq: None,
            attachments: None,
            mentions: None,
            edited: None,
            cancelled: None,
            superseded: None,
            agent_chat_id: None,
            blocks: None,
            tool_diffs: None,
            tool_locations: None,
            tool_kind: None,
            tool_status: None,
            mode_id: None,
            commands: None,
            subagent_id: None,
            subagent_name: None,
            subagent_state: None,
            silent: None,
            break_kind: None,
            from_provider: None,
            to_provider: None,
            carry_over: None,
            from_mode: None,
            to_mode: None,
            parent_tool_use_id: None,
            task_signal: None,
            review: None,
        }
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct SearchTestCase {
        pub q: String,
        pub terms: Vec<String>,
        pub text: String,
        pub ranges: Vec<[usize; 2]>,
    }

    fn highlight_ranges_utf16(text: &str, terms: &[String]) -> Vec<[usize; 2]> {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE message_fts {FTS_TABLE_SPEC};"
        ))
        .unwrap();
        conn.execute(
            "INSERT INTO message_fts (rowid, body, kind) VALUES (1, ?1, 'text');",
            params![text],
        )
        .unwrap();

        let fts_query = format_fts_query(terms);
        let highlighted: Option<String> = conn
            .query_row(
                "SELECT highlight(message_fts, 0, char(1), char(2)) FROM message_fts WHERE message_fts MATCH ?1",
                params![fts_query],
                |r| r.get(0),
            )
            .optional()
            .unwrap();

        let mut ranges: Vec<[usize; 2]> = Vec::new();
        if let Some(h) = highlighted {
            let mut cur_utf16 = 0usize;
            let mut start_utf16 = 0usize;
            let mut in_match = false;
            for c in h.chars() {
                if c == '\u{1}' {
                    in_match = true;
                    start_utf16 = cur_utf16;
                } else if c == '\u{2}' {
                    if in_match {
                        ranges.push([start_utf16, cur_utf16]);
                        in_match = false;
                    }
                } else {
                    cur_utf16 += c.len_utf16();
                }
            }
        }

        ranges.sort_by_key(|r| r[0]);
        let mut merged: Vec<[usize; 2]> = Vec::new();
        for r in ranges {
            if let Some(last) = merged.last_mut() {
                if r[0] <= last[1] {
                    last[1] = last[1].max(r[1]);
                    continue;
                }
            }
            merged.push(r);
        }
        merged
    }

    #[test]
    #[ignore]
    fn generate_transcript_search_cases() {
        let raw_cases = vec![
            ("refresh", "Please refresh the page to continue."),
            ("refresh token", "The token needs a refresh."),
            ("ReFresh Token", "refresh token is ready"),
            ("café Résumé", "Welcome to the cafe, here is my resume."),
            ("Tiếng Việt", "hoc tieng viet rat hay"),
            ("крайний случай", "В крайнем случае это крайний случай."),
            ("große Straße", "Eine große Straße in Berlin"),
            ("İstanbul", "Welcome to istanbul city"),
            ("数据库系统", "现代关系型数据库系统的架构设计"),
            ("rocket launch", "🚀 Ready for rocket launch now!"),
            ("foo\"bar", "The special key foo\"bar was updated."),
            ("to refresh", "Time to refresh the session."),
            ("to be", "To be or not to be, that is the question."),
            ("foo bar", "The foobar variable is defined."),
            ("abc bcd", "Sequence abcd contains both."),
        ];

        let mut out_cases = Vec::new();

        for (q, text) in raw_cases {
            let terms = query_terms(q).unwrap();
            let ranges = highlight_ranges_utf16(text, &terms);

            out_cases.push(SearchTestCase {
                q: q.to_string(),
                terms,
                text: text.to_string(),
                ranges,
            });
        }

        let json = serde_json::to_string_pretty(&out_cases).unwrap();
        std::fs::write("tests/fixtures/transcript_search_cases.json", json).unwrap();
    }

    #[test]
    fn fixture_parity() {
        let cases_json = include_str!("../tests/fixtures/transcript_search_cases.json");
        let cases: Vec<SearchTestCase> = serde_json::from_str(cases_json).unwrap();

        for case in &cases {
            let dir = tempfile::tempdir().unwrap();
            let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
            store.append(&mut ev(
                NormalizedEventKind::Text,
                Some("t1"),
                Some(&case.text),
            ));

            let terms = query_terms(&case.q).unwrap();
            assert_eq!(terms, case.terms, "terms match for q={}", case.q);
            assert_eq!(
                highlight_ranges_utf16(&case.text, &terms),
                case.ranges,
                "ranges match for q={}",
                case.q
            );

            let res = store
                .search(&SearchRequest {
                    q: case.q.clone(),
                    scope: SearchScope::All,
                    after: None,
                    limit: 100,
                    snippets: false,
                })
                .unwrap();

            assert_eq!(
                res.total,
                case.ranges.len(),
                "total matches ranges count for q={}",
                case.q
            );
        }
    }
}
