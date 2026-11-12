//! Whole-chat outline reads over the persisted `turn_outline` index (written by
//! `turn_outline.rs`): a fixed-size bucketed summary and a window of turns by index.

use rusqlite::params;
use vst_types::review_format::sanitize_review_text;

use crate::transcript::TranscriptStore;

/// The summary aims for this many buckets: `bucket_size = max(1, ceil(total / 1000))`.
pub const OUTLINE_BUCKET_COUNT: i64 = 1000;
pub const OUTLINE_WINDOW_DEFAULT_LIMIT: usize = 40;
pub const OUTLINE_WINDOW_MAX_LIMIT: usize = 100;
pub const OUTLINE_LABEL_MAX_CHARS: usize = 80;

/// Fixed-size outline summary: per-bucket counts over the turn index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlineSummary {
    /// False while the index is still being built; the other fields are then empty.
    pub ready: bool,
    pub total_turns: i64,
    pub revision: i64,
    pub bucket_size: i64,
    pub tools: Vec<u32>,
    pub edits: Vec<u32>,
    pub errors: Vec<u32>,
    /// Newest seq of the transcript, including superseded rows.
    pub max_seq: i64,
}

impl OutlineSummary {
    /// A session with no transcript: ready, and no turns.
    pub fn empty() -> Self {
        Self {
            ready: true,
            ..Self::building()
        }
    }

    /// The index is still being built.
    pub fn building() -> Self {
        Self {
            ready: false,
            total_turns: 0,
            revision: 0,
            bucket_size: 1,
            tools: Vec::new(),
            edits: Vec::new(),
            errors: Vec::new(),
            max_seq: -1,
        }
    }
}

/// One user turn of the outline window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlineTurn {
    /// First seq of the turn.
    pub seq: i64,
    /// `turn_id`, or `seq:<seq>` for a row without one.
    pub turn_key: String,
    pub label: String,
    pub ts: Option<String>,
    pub tools: u32,
    pub edits: u32,
    pub errors: u32,
}

/// Turns `from..from + turns.len()` of the outline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlineWindow {
    pub ready: bool,
    pub total_turns: i64,
    pub revision: i64,
    pub from: i64,
    pub turns: Vec<OutlineTurn>,
}

impl OutlineWindow {
    /// A session with no transcript: ready, and no turns.
    pub fn empty(from: i64) -> Self {
        Self {
            ready: true,
            total_turns: 0,
            revision: 0,
            from,
            turns: Vec::new(),
        }
    }
}

/// First non-empty trimmed line of `text`, sanitized, cut to `OUTLINE_LABEL_MAX_CHARS` chars.
pub fn outline_label(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    sanitize_review_text(line, false)
        .chars()
        .take(OUTLINE_LABEL_MAX_CHARS)
        .collect()
}

fn count_u32(n: i64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

impl TranscriptStore {
    /// The bucketed summary, or `None` when the outline is unavailable for this
    /// session (its schema could not be created).
    ///
    /// # Errors
    /// Any SQLite error reading the index.
    pub fn outline_summary(&self) -> rusqlite::Result<Option<OutlineSummary>> {
        if !self.outline.enabled() {
            return Ok(None);
        }
        if !self.outline.caught_up() {
            return Ok(Some(OutlineSummary::building()));
        }
        let (total, revision): (i64, i64) = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM turn_outline WHERE session_id = ?1),
                    COALESCE((SELECT revision FROM turn_outline_state WHERE session_id = ?1), 0)",
            params![self.session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let max_seq: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(seq), -1) FROM message WHERE session_id = ?1",
            params![self.session_id],
            |r| r.get(0),
        )?;
        let bucket_size = ((total + OUTLINE_BUCKET_COUNT - 1) / OUTLINE_BUCKET_COUNT).max(1);
        let buckets = usize::try_from((total + bucket_size - 1) / bucket_size).unwrap_or(0);
        let mut summary = OutlineSummary {
            ready: true,
            total_turns: total,
            revision,
            bucket_size,
            tools: vec![0; buckets],
            edits: vec![0; buckets],
            errors: vec![0; buckets],
            max_seq,
        };
        let mut stmt = self.conn.prepare(
            "SELECT ord / ?2, SUM(tools), SUM(edits), SUM(errors) FROM turn_outline
             WHERE session_id = ?1 GROUP BY ord / ?2",
        )?;
        let rows = stmt
            .query_map(params![self.session_id, bucket_size], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (bucket, tools, edits, errors) in rows {
            let Ok(b) = usize::try_from(bucket) else {
                continue;
            };
            if b < buckets {
                summary.tools[b] = count_u32(tools);
                summary.edits[b] = count_u32(edits);
                summary.errors[b] = count_u32(errors);
            }
        }
        Ok(Some(summary))
    }

    /// Up to `limit` turns starting at turn index `from` (clamped to 1..=100).
    /// `None` when the outline is unavailable; a not-ready index answers with no turns.
    ///
    /// # Errors
    /// Any SQLite error reading the index.
    pub fn outline_window(
        &self,
        from: i64,
        limit: usize,
    ) -> rusqlite::Result<Option<OutlineWindow>> {
        if !self.outline.enabled() {
            return Ok(None);
        }
        if !self.outline.caught_up() {
            return Ok(Some(OutlineWindow {
                ready: false,
                total_turns: 0,
                revision: 0,
                from,
                turns: Vec::new(),
            }));
        }
        let (total, revision): (i64, i64) = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM turn_outline WHERE session_id = ?1),
                    COALESCE((SELECT revision FROM turn_outline_state WHERE session_id = ?1), 0)",
            params![self.session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let limit = limit.clamp(1, OUTLINE_WINDOW_MAX_LIMIT) as i64;
        let end = from.saturating_add(limit);
        let mut stmt = self.conn.prepare(
            "SELECT seq, turn_key, label, ts, tools, edits, errors FROM turn_outline
             WHERE session_id = ?1 AND ord >= ?2 AND ord < ?3
             ORDER BY ord ASC",
        )?;
        let turns = stmt
            .query_map(params![self.session_id, from, end], |r| {
                Ok(OutlineTurn {
                    seq: r.get(0)?,
                    turn_key: r.get(1)?,
                    label: r.get(2)?,
                    ts: r.get(3)?,
                    tools: r.get(4)?,
                    edits: r.get(5)?,
                    errors: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(OutlineWindow {
            ready: true,
            total_turns: total,
            revision,
            from,
            turns,
        }))
    }
}
