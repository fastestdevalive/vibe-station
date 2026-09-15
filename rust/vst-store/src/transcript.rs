//! SQLite transcript store — ports `daemon/src/services/sqliteTranscriptStore.ts`,
//! `transcriptStore.ts` (the port interface), and `transcriptMigration.ts`.
//!
//! One DB file per session (`messages.db`), living beside the legacy
//! `messages.jsonl`. WAL mode + single writer. This is a **synchronous**,
//! per-session handle: production async callers MUST wrap it in
//! `spawn_blocking` (Gotcha #4). It is exercised synchronously by tests, exactly
//! as the TS tests do.

use std::path::Path;

use rusqlite::{params, Connection};
use vst_types::{NormalizedEvent, NormalizedEventKind};

/// Default page size for the bounded forward `since()` replay.
pub const SINCE_PAGE_SIZE: i64 = 200;

/// Max bytes for a `tool_result.content` / `tool_diff` before it is capped.
/// Mirrors `TOOL_RESULT_MAX_BYTES` in `toolResultCap.ts`.
pub const TOOL_RESULT_MAX_BYTES: usize = 20_000;

/// Outcome of a native-history import pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportOutcome {
    pub imported: i64,
    pub turns_imported: i64,
    pub turns_skipped: i64,
    pub cursor: String,
}

/// Options for `import_transaction`.
#[derive(Clone, Debug)]
pub struct ImportOptions {
    pub cli: String,
    pub cursor: String,
}

/// The native cursor watermark persisted for a session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeWatermark {
    pub cli: String,
    pub cursor: String,
}

/// Last model + last real-usage summary for the status-bar meta rebuild.
#[derive(Clone, Debug, Default)]
pub struct TranscriptMeta {
    pub model: Option<String>,
    pub usage: Option<vst_types::UsageInfo>,
    pub commands: Option<Vec<vst_types::Command>>,
}

/// A bounded backward window plus its keyset cursor.
#[derive(Clone, Debug)]
pub struct TranscriptPage {
    pub events: Vec<NormalizedEvent>,
    pub oldest_seq: Option<i64>,
    pub has_more: bool,
}

/// A bounded forward window plus its keyset cursor.
#[derive(Clone, Debug)]
pub struct SincePage {
    pub events: Vec<NormalizedEvent>,
    pub next_seq: Option<i64>,
    pub has_more: bool,
}

fn kind_str(kind: NormalizedEventKind) -> &'static str {
    match kind {
        NormalizedEventKind::SessionInit => "session_init",
        NormalizedEventKind::User => "user",
        NormalizedEventKind::Thinking => "thinking",
        NormalizedEventKind::Text => "text",
        NormalizedEventKind::ToolUse => "tool_use",
        NormalizedEventKind::ToolResult => "tool_result",
        NormalizedEventKind::Usage => "usage",
        NormalizedEventKind::Result => "result",
        NormalizedEventKind::Error => "error",
        NormalizedEventKind::Status => "status",
        NormalizedEventKind::ModeUpdate => "mode_update",
        NormalizedEventKind::CommandsUpdate => "commands_update",
        NormalizedEventKind::MessageGenerated => "message_generated",
    }
}

/// A usage event reflects a real model call only when it billed tokens.
fn has_real_usage(usage: &Option<vst_types::UsageInfo>) -> bool {
    usage.as_ref().is_some_and(|u| u.total_tokens > 0)
}

/// Content signature of a `user` event for round-trip dedup: trimmed prompt
/// text. Empty prompts return `None` (never dedup on an empty string).
fn user_signature(ev: &NormalizedEvent) -> Option<String> {
    if ev.kind != NormalizedEventKind::User {
        return None;
    }
    let t = ev.text.as_deref()?.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Mutates `ev` in place, capping oversized `tool_result.content` and
/// `tool_diff` text. Ported from `capToolResultContent` (`toolResultCap.ts`).
///
/// NOTE: `toolResultCap.ts` is file-mapped to part 05; this crate holds a
/// private copy because the transcript store's constructor backfill and
/// `import_transaction` invoke it directly (flagged in the part's report for
/// reconciliation when part 05 lands).
pub(crate) fn cap_tool_result_content(ev: &mut NormalizedEvent) {
    if ev.kind == NormalizedEventKind::ToolResult {
        if let Some(tr) = ev.tool_result.as_mut() {
            if let Some(content) = tr.content.as_ref() {
                let size = content.len();
                if size > TOOL_RESULT_MAX_BYTES {
                    tr.content = Some(format!("(tool result omitted — {size} bytes)"));
                }
            }
        }
    }
    if let Some(diffs) = ev.tool_diffs.as_mut() {
        for diff in diffs.iter_mut() {
            let old_size = diff.old_text.as_ref().map_or(0, String::len);
            let new_size = diff.new_text.len();
            if old_size <= TOOL_RESULT_MAX_BYTES && new_size <= TOOL_RESULT_MAX_BYTES {
                continue;
            }
            if old_size > TOOL_RESULT_MAX_BYTES {
                diff.old_text = None;
            }
            if new_size > TOOL_RESULT_MAX_BYTES {
                diff.new_text = format!("(diff omitted — {new_size} bytes)");
            }
        }
    }
}

/// A migration result for a legacy `messages.jsonl` import.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigrationResult {
    pub migrated: bool,
    pub imported: i64,
    pub lines: i64,
}

/// Import a session's legacy `messages.jsonl` into `db` if the DB has no rows
/// for that session yet. Idempotent + non-destructive. Ported from
/// `migrateJsonlIntoDb` (`transcriptMigration.ts`).
fn migrate_jsonl_into_db(
    conn: &mut Connection,
    session_id: &str,
    jsonl_path: &Path,
) -> rusqlite::Result<MigrationResult> {
    if !jsonl_path.exists() {
        return Ok(MigrationResult {
            migrated: false,
            imported: 0,
            lines: 0,
        });
    }
    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) AS n FROM message WHERE session_id = ?1",
        [session_id],
        |r| r.get(0),
    )?;
    if existing > 0 {
        return Ok(MigrationResult {
            migrated: false,
            imported: 0,
            lines: 0,
        });
    }

    let raw = std::fs::read_to_string(jsonl_path).unwrap_or_default();
    let non_empty: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();

    let mut imported: i64 = 0;
    let txn = conn.transaction()?;
    {
        let mut insert = txn.prepare(
            "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for line in &non_empty {
            let trimmed = line.trim();
            let Ok(ev) = serde_json::from_str::<NormalizedEvent>(trimmed) else {
                continue; // skip malformed legacy line (does not consume a seq)
            };
            insert.execute(params![
                session_id,
                imported,
                ev.ts,
                Some(kind_str(ev.kind)),
                ev.turn_id,
                trimmed
            ])?;
            imported += 1;
        }
    }
    txn.commit()?;

    if imported != non_empty.len() as i64 {
        tracing::warn!(
            "[transcript-migration] session={} imported={} of {} lines ({} malformed skipped)",
            session_id,
            imported,
            non_empty.len(),
            non_empty.len() as i64 - imported
        );
    }

    Ok(MigrationResult {
        migrated: true,
        imported,
        lines: non_empty.len() as i64,
    })
}

/// The synchronous, per-session SQLite transcript store.
pub struct TranscriptStore {
    conn: Connection,
    session_id: String,
    /// Next `log_seq` to assign — seeded from `MAX(seq)+1`.
    next_seq: i64,
}

impl TranscriptStore {
    fn new(db_path: &Path, session_id: &str, jsonl_path: Option<&Path>) -> rusqlite::Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let mut conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS message (
              session_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              ts TEXT,
              kind TEXT,
              turn_id TEXT,
              payload TEXT NOT NULL,
              PRIMARY KEY (session_id, seq)
            );
            CREATE INDEX IF NOT EXISTS idx_message_turn ON message (session_id, turn_id);
            CREATE TABLE IF NOT EXISTS native_watermark (
              session_id TEXT PRIMARY KEY,
              cli TEXT,
              cursor TEXT
            );
        ",
        )?;

        // Idempotent `superseded` column migration.
        let cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(message)")?;
            let result = stmt
                .query_map([], |r| r.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            result
        };
        if !cols.iter().any(|c| c == "superseded") {
            conn.execute_batch(
                "ALTER TABLE message ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0",
            )?;
        }

        if let Some(jsonl) = jsonl_path {
            migrate_jsonl_into_db(&mut conn, session_id, jsonl)?;
        }

        // Oversized `tool_result` backfill — runs on every open, idempotent.
        let oversized: Vec<(i64, String)> = {
            let mut stmt = conn.prepare(
                "SELECT seq, payload FROM message WHERE session_id = ?1 AND kind = 'tool_result' AND LENGTH(payload) > ?2",
            )?;
            let result = stmt
                .query_map(params![session_id, TOOL_RESULT_MAX_BYTES as i64], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            result
        };
        if !oversized.is_empty() {
            let txn = conn.transaction()?;
            {
                let mut upd = txn.prepare(
                    "UPDATE message SET payload = ?1 WHERE session_id = ?2 AND seq = ?3",
                )?;
                for (seq, payload) in &oversized {
                    if let Ok(mut ev) = serde_json::from_str::<NormalizedEvent>(payload) {
                        cap_tool_result_content(&mut ev);
                        let out = serde_json::to_string(&ev).unwrap_or_default();
                        upd.execute(params![out, session_id, seq])?;
                    }
                }
            }
            txn.commit()?;
        }

        // Seed the writer cursor from the durable max.
        let max_seq: Option<i64> = conn.query_row(
            "SELECT MAX(seq) FROM message WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )?;
        let next_seq = max_seq.map_or(0, |m| m + 1);

        Ok(TranscriptStore {
            conn,
            session_id: session_id.to_string(),
            next_seq,
        })
    }

    /// Append one event, returning the durable monotonic `log_seq` (also set on
    /// the passed event).
    pub fn append(&mut self, ev: &mut NormalizedEvent) -> i64 {
        let seq = self.next_seq;
        ev.log_seq = Some(seq);
        self.insert_row(seq, ev);
        self.next_seq = seq + 1;
        seq
    }

    fn insert_row(&self, seq: i64, ev: &NormalizedEvent) {
        let payload = serde_json::to_string(ev).unwrap_or_default();
        self.conn
            .execute(
                "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![self.session_id, seq, ev.ts, Some(kind_str(ev.kind)), ev.turn_id, payload],
            )
            .expect("insert into message");
    }

    /// Full transcript in insertion (`logSeq`) order, live rows only.
    pub fn read_all(&self) -> Vec<NormalizedEvent> {
        let rows: Vec<(i64, String)> = (|| -> rusqlite::Result<Vec<(i64, String)>> {
            let mut stmt = self.conn.prepare(
                "SELECT seq, payload FROM message WHERE session_id = ?1 AND superseded = 0 ORDER BY seq ASC",
            )?;
            let result = stmt
                .query_map([&self.session_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .unwrap_or_default();
        rows.iter()
            .filter_map(|(seq, p)| self.parse_row(*seq, p))
            .collect()
    }

    /// Number of persisted live events for this session.
    pub fn count(&self) -> i64 {
        self.conn
            .query_row(
                "SELECT COUNT(*) AS n FROM message WHERE session_id = ?1 AND superseded = 0",
                [&self.session_id],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// Mark every row at/after `seq` superseded; return the distinct `turnId`s
    /// flagged (for the fork broadcast).
    pub fn mark_superseded_from(&self, seq: i64) -> Vec<String> {
        let turns: Vec<String> = (|| -> rusqlite::Result<Vec<String>> {
            let mut stmt = self.conn.prepare(
                "SELECT DISTINCT turn_id AS t FROM message WHERE session_id = ?1 AND seq >= ?2 AND turn_id IS NOT NULL AND superseded = 0",
            )?;
            let result = stmt
                .query_map(params![self.session_id, seq], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .unwrap_or_default();
        self.conn
            .execute(
                "UPDATE message SET superseded = 1 WHERE session_id = ?1 AND seq >= ?2",
                params![self.session_id, seq],
            )
            .ok();
        turns
    }

    /// First (live) `logSeq` of a turn, if any.
    pub fn first_seq_of_turn(&self, turn_id: &str) -> Option<i64> {
        self.conn
            .query_row(
                "SELECT MIN(seq) AS firstSeq FROM message WHERE session_id = ?1 AND turn_id = ?2 AND superseded = 0",
                params![self.session_id, turn_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
    }

    /// Last model + last real usage + last commands_update, via a bounded
    /// reverse scan.
    pub fn last_meta(&self) -> TranscriptMeta {
        let mut meta = TranscriptMeta::default();
        let mut have_model = false;
        let mut have_usage = false;
        let mut have_commands = false;
        let rows: Vec<(i64, String)> = (|| -> rusqlite::Result<Vec<(i64, String)>> {
            let mut stmt = self.conn.prepare(
                "SELECT seq, payload FROM message WHERE session_id = ?1 AND superseded = 0 ORDER BY seq DESC",
            )?;
            let result = stmt
                .query_map([&self.session_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .unwrap_or_default();
        for (seq, payload) in &rows {
            let Some(ev) = self.parse_row(*seq, payload) else {
                continue;
            };
            if !have_model && ev.model.is_some() {
                meta.model = ev.model.clone();
                have_model = true;
            }
            if !have_usage && has_real_usage(&ev.usage) {
                meta.usage = ev.usage.clone();
                have_usage = true;
            }
            if !have_commands
                && ev.kind == NormalizedEventKind::CommandsUpdate
                && ev.commands.is_some()
            {
                meta.commands = ev.commands.clone();
                have_commands = true;
            }
            if have_model && have_usage && have_commands {
                break;
            }
        }
        meta
    }

    /// Import native-history events in a single transaction, deduping by
    /// turnId or user-content signature, and persisting the watermark.
    pub fn import_transaction(
        &mut self,
        events: Vec<NormalizedEvent>,
        opts: ImportOptions,
    ) -> ImportOutcome {
        let mut existing_turn_ids: std::collections::HashSet<String> = (|| -> rusqlite::Result<Vec<String>> {
            let mut stmt = self.conn.prepare(
                "SELECT DISTINCT turn_id AS t FROM message WHERE session_id = ?1 AND turn_id IS NOT NULL",
            )?;
            let result = stmt
                .query_map([&self.session_id], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .unwrap_or_default()
        .into_iter()
        .collect();
        let mut existing_user_sigs: std::collections::HashSet<String> = {
            let rows: Vec<String> = (|| -> rusqlite::Result<Vec<String>> {
                let mut stmt = self.conn.prepare(
                    "SELECT payload FROM message WHERE session_id = ?1 AND kind = 'user'",
                )?;
                let result = stmt
                    .query_map([&self.session_id], |r| r.get(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(result)
            })()
            .unwrap_or_default();
            let mut set = std::collections::HashSet::new();
            for r in rows {
                if let Ok(ev) = serde_json::from_str::<NormalizedEvent>(&r) {
                    if let Some(sig) = user_signature(&ev) {
                        set.insert(sig);
                    }
                }
            }
            set
        };

        // Group events into turns, preserving first-seen order.
        let mut groups: Vec<(Option<String>, Vec<NormalizedEvent>)> = Vec::new();
        let mut by_turn: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        for ev in events {
            match &ev.turn_id {
                None => groups.push((None, vec![ev])),
                Some(tid) => {
                    if let Some(&idx) = by_turn.get(tid) {
                        groups[idx].1.push(ev);
                    } else {
                        by_turn.insert(tid.clone(), groups.len());
                        groups.push((Some(tid.clone()), vec![ev]));
                    }
                }
            }
        }

        let mut imported: i64 = 0;
        let mut turns_imported: i64 = 0;
        let mut turns_skipped: i64 = 0;
        let mut local_next = self.next_seq;

        let result = (|| -> rusqlite::Result<()> {
            let txn = self.conn.transaction()?;
            for (turn_id, group_events) in &groups {
                let user_sig = group_events.iter().filter_map(user_signature).next();
                let dup_by_turn = turn_id
                    .as_ref()
                    .is_some_and(|t| existing_turn_ids.contains(t));
                let dup_by_content = user_sig
                    .as_ref()
                    .is_some_and(|s| existing_user_sigs.contains(s));
                if dup_by_turn || dup_by_content {
                    turns_skipped += 1;
                    continue;
                }
                for ev in group_events {
                    let mut ev = ev.clone();
                    ev.log_seq = Some(local_next);
                    cap_tool_result_content(&mut ev);
                    let payload = serde_json::to_string(&ev).unwrap_or_default();
                    txn.execute(
                        "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![self.session_id, local_next, ev.ts, Some(kind_str(ev.kind)), ev.turn_id, payload],
                    )?;
                    local_next += 1;
                    imported += 1;
                }
                turns_imported += 1;
                if let Some(t) = turn_id {
                    existing_turn_ids.insert(t.clone());
                }
                if let Some(s) = user_sig {
                    existing_user_sigs.insert(s);
                }
            }
            txn.execute(
                "INSERT INTO native_watermark (session_id, cli, cursor) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET cli = excluded.cli, cursor = excluded.cursor",
                params![self.session_id, opts.cli, opts.cursor],
            )?;
            txn.commit()
        })();

        match result {
            Ok(()) => self.next_seq = local_next,
            Err(e) => {
                // Rolled back: rows + watermark unchanged, nextSeq untouched.
                tracing::warn!(
                    "[native-import] rollback for session={}: {e}",
                    self.session_id
                );
            }
        }

        tracing::info!(
            "[native-import] session={} cli={} turnsImported={} turnsSkipped={} events={} cursor={}",
            self.session_id,
            opts.cli,
            turns_imported,
            turns_skipped,
            imported,
            opts.cursor
        );
        ImportOutcome {
            imported,
            turns_imported,
            turns_skipped,
            cursor: opts.cursor,
        }
    }

    /// The persisted native cursor watermark, if any.
    pub fn get_native_watermark(&self) -> Option<NativeWatermark> {
        self.conn
            .query_row(
                "SELECT cli, cursor FROM native_watermark WHERE session_id = ?1",
                [&self.session_id],
                |r| {
                    Ok(NativeWatermark {
                        cli: r.get(0)?,
                        cursor: r.get(1)?,
                    })
                },
            )
            .ok()
    }

    /// The last `n_turns` whole turns, turn-aligned, plus a cursor.
    pub fn tail(&self, n_turns: i64) -> TranscriptPage {
        let n = n_turns.max(1);
        let starts: Vec<i64> = (|| -> rusqlite::Result<Vec<i64>> {
            let mut stmt = self.conn.prepare(
                "SELECT MIN(seq) AS firstSeq FROM message WHERE session_id = ?1 AND superseded = 0 GROUP BY turn_id ORDER BY firstSeq DESC LIMIT ?2",
            )?;
            let result = stmt
                .query_map(params![self.session_id, n], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .unwrap_or_default();
        if starts.is_empty() {
            return TranscriptPage {
                events: vec![],
                oldest_seq: None,
                has_more: false,
            };
        }
        let cut_seq = *starts.last().unwrap();
        self.page_from(cut_seq)
    }

    /// Keyset page of events strictly before `seq`, turn-aligned.
    pub fn page_before(&self, seq: i64, limit: i64) -> TranscriptPage {
        let lim = limit.max(1);
        let rows: Vec<(i64, Option<String>)> = (|| -> rusqlite::Result<Vec<(i64, Option<String>)>> {
            let mut stmt = self.conn.prepare(
                "SELECT seq, turn_id AS turnId FROM message WHERE session_id = ?1 AND superseded = 0 AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
            )?;
            let result = stmt
                .query_map(params![self.session_id, seq, lim], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .unwrap_or_default();
        if rows.is_empty() {
            return TranscriptPage {
                events: vec![],
                oldest_seq: None,
                has_more: false,
            };
        }
        let (oldest_seq, oldest_turn) = rows.last().unwrap();
        let start_seq = match oldest_turn {
            Some(t) => self.turn_first_seq(t),
            None => *oldest_seq,
        };
        let events = self.range_asc(start_seq, seq);
        TranscriptPage {
            events,
            oldest_seq: Some(start_seq),
            has_more: self.exists_before(start_seq),
        }
    }

    /// Bounded forward page of events strictly newer than `seq`, with a cursor.
    pub fn since(&self, seq: i64, limit: Option<i64>) -> SincePage {
        let lim = limit.unwrap_or(SINCE_PAGE_SIZE).max(1);
        let rows: Vec<(i64, String)> = (|| -> rusqlite::Result<Vec<(i64, String)>> {
            let mut stmt = self.conn.prepare(
                "SELECT seq, payload FROM message WHERE session_id = ?1 AND superseded = 0 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
            )?;
            let result = stmt
                .query_map(params![self.session_id, seq, lim], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .unwrap_or_default();
        if rows.is_empty() {
            return SincePage {
                events: vec![],
                next_seq: None,
                has_more: false,
            };
        }
        let events: Vec<NormalizedEvent> = rows
            .iter()
            .filter_map(|(s, p)| self.parse_row(*s, p))
            .collect();
        let last_seq = rows.last().unwrap().0;
        SincePage {
            events,
            next_seq: Some(last_seq),
            has_more: self.exists_after(last_seq),
        }
    }

    fn page_from(&self, from_seq: i64) -> TranscriptPage {
        let rows: Vec<(i64, String)> = (|| -> rusqlite::Result<Vec<(i64, String)>> {
            let mut stmt = self.conn.prepare(
                "SELECT seq, payload FROM message WHERE session_id = ?1 AND superseded = 0 AND seq >= ?2 ORDER BY seq ASC",
            )?;
            let result = stmt
                .query_map(params![self.session_id, from_seq], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .unwrap_or_default();
        let events: Vec<NormalizedEvent> = rows
            .iter()
            .filter_map(|(s, p)| self.parse_row(*s, p))
            .collect();
        TranscriptPage {
            oldest_seq: (!events.is_empty()).then_some(from_seq),
            has_more: self.exists_before(from_seq),
            events,
        }
    }

    fn range_asc(&self, start_seq: i64, end_seq: i64) -> Vec<NormalizedEvent> {
        let rows: Vec<(i64, String)> = (|| -> rusqlite::Result<Vec<(i64, String)>> {
            let mut stmt = self.conn.prepare(
                "SELECT seq, payload FROM message WHERE session_id = ?1 AND superseded = 0 AND seq >= ?2 AND seq < ?3 ORDER BY seq ASC",
            )?;
            let result = stmt
                .query_map(params![self.session_id, start_seq, end_seq], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .unwrap_or_default();
        rows.iter()
            .filter_map(|(s, p)| self.parse_row(*s, p))
            .collect()
    }

    fn turn_first_seq(&self, turn_id: &str) -> i64 {
        self.conn
            .query_row(
                "SELECT MIN(seq) AS firstSeq FROM message WHERE session_id = ?1 AND turn_id = ?2 AND superseded = 0",
                params![self.session_id, turn_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
            .unwrap_or(0)
    }

    fn exists_before(&self, seq: i64) -> bool {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM message WHERE session_id = ?1 AND superseded = 0 AND seq < ?2)",
                params![self.session_id, seq],
                |r| r.get::<_, i64>(0),
            )
            .map(|e| e == 1)
            .unwrap_or(false)
    }

    fn exists_after(&self, seq: i64) -> bool {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM message WHERE session_id = ?1 AND superseded = 0 AND seq > ?2)",
                params![self.session_id, seq],
                |r| r.get::<_, i64>(0),
            )
            .map(|e| e == 1)
            .unwrap_or(false)
    }

    /// Parse a stored payload; synthesize `logSeq` for legacy rows (N3).
    /// Returns `None` for a malformed row (skipped, matching the TS reader).
    fn parse_row(&self, seq: i64, payload: &str) -> Option<NormalizedEvent> {
        let mut ev = serde_json::from_str::<NormalizedEvent>(payload).ok()?;
        if ev.log_seq.is_none() {
            ev.log_seq = Some(seq);
        }
        Some(ev)
    }

    /// Release the underlying handle.
    pub fn close(self) {
        self.conn.close().ok();
    }
}

/// Standard per-session DB path beside the legacy transcript.
pub fn transcript_db_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("messages.db")
}

/// Open (create) the SQLite store for a session's data dir, migrating any
/// legacy `messages.jsonl` on first open.
pub fn open_transcript_store(data_dir: &Path, session_id: &str) -> TranscriptStore {
    let db_path = transcript_db_path(data_dir);
    let jsonl_path = data_dir.join("messages.jsonl");
    TranscriptStore::new(&db_path, session_id, Some(&jsonl_path)).expect("open transcript store")
}
