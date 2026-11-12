//! Persisted per-turn outline index: one `turn_outline` row per user turn.
//!
//! Every row reaches the index through one apply path: `OutlineFact` is derived
//! from a `NormalizedEvent` (live, inside the message insert's transaction) or
//! from a stored row (catch-up), then `OutlineWriter::apply` folds it into the
//! table and the in-memory tail. A turn row and `turn_outline_state.through_seq`
//! always commit together, so the table is the fold of every row up to
//! `through_seq`. A writer that loses that agreement drops its tail and resumes
//! from the table (`rebuild_tail`), which reads only the last turn's rows.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use vst_types::{AcpToolKind, NormalizedEvent, NormalizedEventKind, ToolStatus};

use crate::transcript::TranscriptStore;
use crate::transcript_outline::outline_label;
use crate::transcript_search::BACKFILL_CHUNK_ROWS;

/// Bumped when the derived facts change: a stored different version is wiped and rebuilt.
pub(crate) const OUTLINE_VERSION: i64 = 1;

/// One catch-up row: `(seq, ts, kind, turn_id, payload)`.
type CatchUpRow = (i64, Option<String>, Option<String>, Option<String>, String);

const LIVE_SAVEPOINT: &str = "turn_outline_live";
const CATCH_UP_KINDS: &str = "('user', 'tool_use', 'tool_result', 'error')";

/// Creates the index tables and seeds the state row. Failure disables the outline
/// for this open; it never fails the transcript open.
pub(crate) fn ensure_schema(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS turn_outline (
           session_id TEXT NOT NULL,
           ord INTEGER NOT NULL,
           seq INTEGER NOT NULL,
           turn_key TEXT NOT NULL,
           label TEXT NOT NULL,
           ts TEXT,
           tools INTEGER NOT NULL,
           edits INTEGER NOT NULL,
           errors INTEGER NOT NULL,
           PRIMARY KEY (session_id, ord),
           UNIQUE (session_id, turn_key)
         );
         CREATE INDEX IF NOT EXISTS idx_turn_outline_seq ON turn_outline (session_id, seq);
         CREATE TABLE IF NOT EXISTS turn_outline_state (
           session_id TEXT PRIMARY KEY,
           version INTEGER NOT NULL,
           revision INTEGER NOT NULL,
           through_seq INTEGER NOT NULL
         );",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO turn_outline_state (session_id, version, revision, through_seq)
         VALUES (?1, ?2, 0, -1)",
        params![session_id, OUTLINE_VERSION],
    )?;
    Ok(())
}

/// What one row contributes to the outline. A row with no fact contributes nothing.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OutlineFact {
    /// A non-silent user row: opens a turn when its key is new.
    Turn { key: String, label: String },
    /// A top-level tool call or result, counted once per tool id.
    Tool {
        id: String,
        write: bool,
        failed: bool,
    },
    /// An `error` row.
    Error,
}

/// Light parse of the stored payload: only the fields the outline reads.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFacts {
    text: Option<String>,
    silent: Option<bool>,
    parent_tool_use_id: Option<String>,
    tool_id: Option<String>,
    tool_name: Option<String>,
    tool_kind: Option<String>,
    tool_status: Option<String>,
    tool_result: Option<StoredResult>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredResult {
    is_error: Option<bool>,
}

/// Mirror of `isWriteToolName` in `web-ui/src/components/chat/toolFormat.ts`.
fn is_write_name(name: Option<&str>) -> bool {
    let Some(name) = name else {
        return false;
    };
    let lower: String = name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')
        .collect();
    matches!(
        lower.as_str(),
        "write"
            | "writefile"
            | "write_file"
            | "writetofile"
            | "write_to_file"
            | "create_file"
            | "new_file"
    ) || lower.starts_with("write_")
        || lower.ends_with("_write")
}

impl OutlineFact {
    /// The fact of a live event at `seq`. Nested (`parentToolUseId`) rows contribute nothing.
    pub(crate) fn from_event(seq: i64, ev: &NormalizedEvent) -> Option<Self> {
        if ev.parent_tool_use_id.is_some() {
            return None;
        }
        match ev.kind {
            NormalizedEventKind::User => (ev.silent != Some(true))
                .then(|| Self::turn(seq, ev.turn_id.as_deref(), ev.text.as_deref())),
            NormalizedEventKind::ToolUse | NormalizedEventKind::ToolResult => {
                let edit = matches!(
                    ev.tool_kind,
                    Some(AcpToolKind::Edit | AcpToolKind::Delete | AcpToolKind::Move)
                );
                let failed = ev.tool_status == Some(ToolStatus::Failed)
                    || ev.tool_result.as_ref().and_then(|r| r.is_error) == Some(true);
                Some(Self::tool(
                    seq,
                    ev.tool_id.as_deref(),
                    ev.tool_name.as_deref(),
                    edit,
                    failed,
                ))
            }
            NormalizedEventKind::Error => Some(Self::Error),
            _ => None,
        }
    }

    /// The fact of a stored row. A payload that does not parse contributes nothing.
    fn from_stored(kind: &str, seq: i64, turn_id: Option<&str>, payload: &str) -> Option<Self> {
        let facts: StoredFacts = serde_json::from_str(payload).ok()?;
        if facts.parent_tool_use_id.is_some() {
            return None;
        }
        match kind {
            "user" => (facts.silent != Some(true))
                .then(|| Self::turn(seq, turn_id, facts.text.as_deref())),
            "tool_use" | "tool_result" => {
                let edit = matches!(facts.tool_kind.as_deref(), Some("edit" | "delete" | "move"));
                let failed = facts.tool_status.as_deref() == Some("failed")
                    || facts.tool_result.as_ref().and_then(|r| r.is_error) == Some(true);
                Some(Self::tool(
                    seq,
                    facts.tool_id.as_deref(),
                    facts.tool_name.as_deref(),
                    edit,
                    failed,
                ))
            }
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    fn turn(seq: i64, turn_id: Option<&str>, text: Option<&str>) -> Self {
        Self::Turn {
            key: turn_id.map_or_else(|| format!("seq:{seq}"), str::to_string),
            label: outline_label(text.unwrap_or("")),
        }
    }

    fn tool(seq: i64, tool_id: Option<&str>, name: Option<&str>, edit: bool, failed: bool) -> Self {
        Self::Tool {
            id: tool_id.map_or_else(|| format!("seq:{seq}"), str::to_string),
            write: edit || is_write_name(name),
            failed,
        }
    }
}

/// The turn being filled: its ord, its tool ids and the absolute counts.
struct Tail {
    ord: i64,
    /// Tool id -> (writes files, failed).
    ids: HashMap<String, (bool, bool)>,
    tools: u32,
    edits: u32,
    errors: u32,
}

impl Tail {
    fn new(ord: i64) -> Self {
        Self {
            ord,
            ids: HashMap::new(),
            tools: 0,
            edits: 0,
            errors: 0,
        }
    }

    /// Folds one tool or error fact into the counts; true when a count moved.
    fn fold(&mut self, fact: &OutlineFact) -> bool {
        match fact {
            OutlineFact::Turn { .. } => false,
            OutlineFact::Error => {
                self.errors += 1;
                true
            }
            OutlineFact::Tool { id, write, failed } => {
                let is_new = !self.ids.contains_key(id);
                let flags = self.ids.entry(id.clone()).or_insert((false, false));
                let mut changed = is_new;
                if *write && !flags.0 {
                    flags.0 = true;
                    self.edits += 1;
                    changed = true;
                }
                if *failed && !flags.1 {
                    flags.1 = true;
                    self.errors += 1;
                    changed = true;
                }
                if is_new {
                    self.tools += 1;
                }
                changed
            }
        }
    }
}

fn write_counts(txn: &Transaction, sid: &str, tail: &Tail) -> rusqlite::Result<()> {
    txn.execute(
        "UPDATE turn_outline SET tools = ?3, edits = ?4, errors = ?5 WHERE session_id = ?1 AND ord = ?2",
        params![sid, tail.ord, tail.tools, tail.edits, tail.errors],
    )?;
    Ok(())
}

/// In-memory state of one store's outline writer.
pub(crate) struct OutlineWriter {
    enabled: bool,
    caught_up: bool,
    /// `through_seq` as this writer last committed it; `None` until the tail is rebuilt.
    cursor: Option<i64>,
    tail: Option<Tail>,
    /// `tail` reflects the table. A current index leaves it false until the first
    /// live apply (or a catch-up that has rows to fold) needs it.
    tail_ready: bool,
}

impl OutlineWriter {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            caught_up: false,
            cursor: None,
            tail: None,
            tail_ready: false,
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn caught_up(&self) -> bool {
        self.caught_up
    }

    /// Drops the in-memory state; the next catch-up resumes from the table.
    pub(crate) fn reset(&mut self) {
        self.caught_up = false;
        self.cursor = None;
        self.tail = None;
        self.tail_ready = false;
    }

    fn apply(
        &mut self,
        txn: &Transaction,
        sid: &str,
        seq: i64,
        ts: Option<&str>,
        fact: &OutlineFact,
    ) -> rusqlite::Result<()> {
        match fact {
            OutlineFact::Turn { key, label } => {
                let ord: i64 = txn.query_row(
                    "SELECT COALESCE(MAX(ord), -1) + 1 FROM turn_outline WHERE session_id = ?1",
                    params![sid],
                    |r| r.get(0),
                )?;
                let inserted = txn.execute(
                    "INSERT INTO turn_outline (session_id, ord, seq, turn_key, label, ts, tools, edits, errors)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 0)
                     ON CONFLICT(session_id, turn_key) DO NOTHING",
                    params![sid, ord, seq, key, label, ts],
                )?;
                // A repeated turn key does not move the tail.
                if inserted == 1 {
                    self.tail = Some(Tail::new(ord));
                }
            }
            _ => {
                if let Some(tail) = self.tail.as_mut() {
                    if tail.fold(fact) {
                        write_counts(txn, sid, tail)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Applies a row just inserted by `txn`. The row's fact and the `through_seq`
    /// advance commit with it. Never fails the insert: a failure rolls back to the
    /// savepoint and drops the index until the next read rebuilds it.
    pub(crate) fn apply_live(
        &mut self,
        txn: &Transaction,
        sid: &str,
        seq: i64,
        ev: &NormalizedEvent,
    ) {
        if !self.caught_up {
            return;
        }
        let Some(prev) = self.cursor else {
            self.reset();
            return;
        };
        let fact = OutlineFact::from_event(seq, ev);
        if let Err(e) = txn.execute_batch(&format!("SAVEPOINT {LIVE_SAVEPOINT}")) {
            self.fail_live(txn, sid, seq, &e.to_string());
            return;
        }
        let applied = (|| -> rusqlite::Result<bool> {
            if !self.tail_ready {
                rebuild_tail(txn, self, sid, prev)?;
            }
            let moved = txn.execute(
                "UPDATE turn_outline_state SET through_seq = ?3 WHERE session_id = ?1 AND through_seq = ?2",
                params![sid, prev, seq],
            )?;
            if moved == 1 {
                if let Some(fact) = &fact {
                    self.apply(txn, sid, seq, Some(&ev.ts), fact)?;
                }
            }
            Ok(moved == 1)
        })();
        match applied {
            Ok(true) => match txn.execute_batch(&format!("RELEASE {LIVE_SAVEPOINT}")) {
                Ok(()) => self.cursor = Some(seq),
                Err(e) => self.fail_live(txn, sid, seq, &e.to_string()),
            },
            Ok(false) => self.fail_live(txn, sid, seq, "through_seq diverged"),
            Err(e) => self.fail_live(txn, sid, seq, &e.to_string()),
        }
    }

    fn fail_live(&mut self, txn: &Transaction, sid: &str, seq: i64, reason: &str) {
        let _ = txn.execute_batch(&format!("ROLLBACK TO {LIVE_SAVEPOINT}"));
        let _ = txn.execute_batch(&format!("RELEASE {LIVE_SAVEPOINT}"));
        self.reset();
        tracing::warn!(
            session_id = sid,
            seq,
            "[outline] live apply failed; index rebuilds on next read: {reason}"
        );
    }
}

/// Rebuilds the tail of the last turn from the rows after its start up to
/// `through`. Writes only when the stored counts disagree (a fork recounts).
fn rebuild_tail(
    txn: &Transaction,
    w: &mut OutlineWriter,
    sid: &str,
    through: i64,
) -> rusqlite::Result<()> {
    let last: Option<(i64, i64, u32, u32, u32)> = txn
        .query_row(
            "SELECT ord, seq, tools, edits, errors FROM turn_outline
             WHERE session_id = ?1 ORDER BY ord DESC LIMIT 1",
            params![sid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((ord, start_seq, tools, edits, errors)) = last else {
        w.tail = None;
        w.tail_ready = true;
        return Ok(());
    };
    let rows: Vec<(i64, Option<String>, Option<String>, String)> = {
        let mut stmt = txn.prepare(&format!(
            "SELECT seq, kind, turn_id, payload FROM message
             WHERE session_id = ?1 AND seq > ?2 AND seq <= ?3
               AND superseded = 0 AND kind IN {CATCH_UP_KINDS}
             ORDER BY seq ASC"
        ))?;
        let rows = stmt
            .query_map(params![sid, start_seq, through], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut tail = Tail::new(ord);
    for (seq, kind, turn_id, payload) in rows {
        let kind = kind.unwrap_or_default();
        if let Some(fact) = OutlineFact::from_stored(&kind, seq, turn_id.as_deref(), &payload) {
            tail.fold(&fact);
        }
    }
    if (tail.tools, tail.edits, tail.errors) != (tools, edits, errors) {
        write_counts(txn, sid, &tail)?;
    }
    w.tail = Some(tail);
    w.tail_ready = true;
    Ok(())
}

fn catch_up_locked(
    conn: &mut Connection,
    w: &mut OutlineWriter,
    sid: &str,
) -> rusqlite::Result<bool> {
    let txn = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    txn.execute(
        "INSERT OR IGNORE INTO turn_outline_state (session_id, version, revision, through_seq)
         VALUES (?1, ?2, 0, -1)",
        params![sid, OUTLINE_VERSION],
    )?;
    let (version, revision, stored): (i64, i64, i64) = txn.query_row(
        "SELECT version, revision, through_seq FROM turn_outline_state WHERE session_id = ?1",
        params![sid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let through = if version == OUTLINE_VERSION {
        // Another writer moved the index since this one last committed: start over.
        if w.cursor.is_some_and(|c| c != stored) {
            w.reset();
            txn.commit()?;
            return Ok(false);
        }
        stored
    } else {
        txn.execute(
            "DELETE FROM turn_outline WHERE session_id = ?1",
            params![sid],
        )?;
        txn.execute(
            "UPDATE turn_outline_state SET version = ?2, revision = ?3, through_seq = -1 WHERE session_id = ?1",
            params![sid, OUTLINE_VERSION, revision + 1],
        )?;
        w.reset();
        -1
    };
    let max_seq: i64 = txn.query_row(
        "SELECT COALESCE(MAX(seq), -1) FROM message WHERE session_id = ?1",
        params![sid],
        |r| r.get(0),
    )?;
    let start = through + 1;
    let end = start.saturating_add(BACKFILL_CHUNK_ROWS).min(max_seq + 1);
    if end > start {
        if !w.tail_ready {
            rebuild_tail(&txn, w, sid, through)?;
        }
        let rows: Vec<CatchUpRow> = {
            let mut stmt = txn.prepare(&format!(
                "SELECT seq, ts, kind, turn_id, payload FROM message
                 WHERE session_id = ?1 AND seq >= ?2 AND seq < ?3
                   AND superseded = 0 AND kind IN {CATCH_UP_KINDS}
                 ORDER BY seq ASC"
            ))?;
            let rows = stmt
                .query_map(params![sid, start, end], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (seq, ts, kind, turn_id, payload) in rows {
            let kind = kind.unwrap_or_default();
            if let Some(fact) = OutlineFact::from_stored(&kind, seq, turn_id.as_deref(), &payload) {
                w.apply(&txn, sid, seq, ts.as_deref(), &fact)?;
            }
        }
    }
    let new_through = if end > start { end - 1 } else { through };
    if new_through != through {
        txn.execute(
            "UPDATE turn_outline_state SET through_seq = ?2 WHERE session_id = ?1",
            params![sid, new_through],
        )?;
    }
    txn.commit()?;
    w.cursor = Some(new_through);
    w.caught_up = new_through >= max_seq;
    Ok(w.caught_up)
}

/// Supersedes every row at or after `seq`. The message update never depends on the
/// outline: with the outline disabled it runs alone, and if the index statements
/// fail the supersede still commits while the index is wiped and disabled for this
/// open. Otherwise the index rows of the turns the rows opened are dropped in the
/// same transaction; the surviving last turn is recounted by the next catch-up,
/// since `through_seq` is pulled back below `seq`.
pub(crate) fn supersede_from(
    conn: &mut Connection,
    w: &mut OutlineWriter,
    sid: &str,
    seq: i64,
) -> rusqlite::Result<()> {
    let txn = conn.transaction()?;
    txn.execute(
        "UPDATE message SET superseded = 1 WHERE session_id = ?1 AND seq >= ?2",
        params![sid, seq],
    )?;
    if w.enabled {
        txn.execute_batch(&format!("SAVEPOINT {LIVE_SAVEPOINT}"))?;
        let outline = (|| -> rusqlite::Result<()> {
            txn.execute(
                "DELETE FROM turn_outline WHERE session_id = ?1 AND seq >= ?2",
                params![sid, seq],
            )?;
            txn.execute(
                "UPDATE turn_outline_state
                 SET revision = revision + 1, through_seq = MIN(through_seq, ?2 - 1)
                 WHERE session_id = ?1",
                params![sid, seq],
            )?;
            Ok(())
        })();
        match outline {
            Ok(()) => txn.execute_batch(&format!("RELEASE {LIVE_SAVEPOINT}"))?,
            Err(e) => {
                txn.execute_batch(&format!(
                    "ROLLBACK TO {LIVE_SAVEPOINT}; RELEASE {LIVE_SAVEPOINT}"
                ))?;
                tracing::warn!(
                    session_id = sid,
                    seq,
                    "[outline] supersede failed; outline disabled for this open: {e}"
                );
                // Best effort: a stale index must not survive into the next open.
                let _ = txn.execute(
                    "DELETE FROM turn_outline WHERE session_id = ?1",
                    params![sid],
                );
                let _ = txn.execute(
                    "UPDATE turn_outline_state SET version = -1 WHERE session_id = ?1",
                    params![sid],
                );
                w.enabled = false;
            }
        }
    }
    txn.commit()
}

impl TranscriptStore {
    /// Advances the outline index by one chunk of rows; `Ok(true)` once the index
    /// covers every row. Mirrors `backfill_step`: the caller holds the store lock
    /// for one call and releases it between calls.
    ///
    /// # Errors
    /// Any SQLite error. The writer then resumes from the table on the next call.
    pub fn catch_up_step(&mut self) -> rusqlite::Result<bool> {
        if !self.outline.enabled() || self.outline.caught_up() {
            return Ok(true);
        }
        let res = catch_up_locked(&mut self.conn, &mut self.outline, &self.session_id);
        if res.is_err() {
            self.outline.reset();
        }
        res
    }
}
