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
    /// Sum of the stored `payload` lengths (UTF-8 bytes) of the rows loaded
    /// for this page. Approximates the replay frame size: it counts rows
    /// `parse_row` may drop and excludes the re-serialised frame envelope.
    pub payload_bytes: usize,
}

/// A bounded forward window plus its keyset cursor.
#[derive(Clone, Debug)]
pub struct SincePage {
    pub events: Vec<NormalizedEvent>,
    pub next_seq: Option<i64>,
    pub has_more: bool,
    /// Sum of the stored `payload` lengths (UTF-8 bytes) of the rows loaded
    /// for this page; see `TranscriptPage::payload_bytes`.
    pub payload_bytes: usize,
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

/// A usage event reflects a real model call: billed tokens, or a context-window
/// snapshot (which carries window/cost the status bar needs even at zero tokens).
fn has_real_usage(usage: &Option<vst_types::UsageInfo>) -> bool {
    usage
        .as_ref()
        .is_some_and(|u| u.total_tokens > 0 || u.context_window.is_some())
}

/// Content fingerprint of one tool-less turn, the key for idempotent import:
/// `u:` + trimmed user text when the turn has a user row, else `a:` + trimmed
/// concatenation (seq order) of its assistant `text` rows (the prefixes keep a
/// prompt and an assistant reply with equal text apart). One normalization for
/// imported groups and for turns already in the log, so an autonomous turn
/// persisted live as many small streamed rows matches its one-row imported
/// copy. `None` (never matches) when there is no text.
fn fingerprint(user: Option<&str>, assistant: &str) -> Option<String> {
    let (tag, t) = match user {
        Some(u) => ("u:", u.trim()),
        None => ("a:", assistant.trim()),
    };
    (!t.is_empty()).then(|| format!("{tag}{t}"))
}

/// `fingerprint` of an imported group's events.
fn group_fingerprint(events: &[NormalizedEvent]) -> Option<String> {
    let user = events
        .iter()
        .find(|e| e.kind == NormalizedEventKind::User)
        .and_then(|e| e.text.as_deref());
    let assistant: String = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::Text)
        .filter_map(|e| e.text.as_deref())
        .collect();
    fingerprint(user, &assistant)
}

/// Mutates `ev` in place, capping oversized `tool_result.content` and
/// `tool_diff` text. Ported from `capToolResultContent` (`toolResultCap.ts`).
///
/// `pub` so `vst-agents` (JsonAgentSession's event handling) can apply the same
/// cap on live-session events. The transcript store's constructor backfill and
/// `import_transaction` invoke it directly (flagged in the part's report for
/// reconciliation when part 05 lands).
pub fn cap_tool_result_content(ev: &mut NormalizedEvent) {
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
            match conn.execute_batch(
                "ALTER TABLE message ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0",
            ) {
                Ok(()) => {}
                // Two `TranscriptStore::new` calls can race to open the same
                // brand-new session's messages.db concurrently (e.g. a
                // freshly-created direct-agent session's `chat:open` racing
                // its own auto-enqueued turn-1) — both see the column
                // missing via the PRAGMA check above, both attempt the
                // ALTER, and the loser hits this exact SQLite error. That is
                // benign: the column now exists (the winner just added it),
                // which is exactly the postcondition this migration wants.
                // Live-reproduced: this used to propagate all the way to
                // `open_transcript_store`'s `.expect()` and abort the whole
                // daemon process on ONE session's race, taking down every
                // other user's session with it.
                Err(rusqlite::Error::SqliteFailure(_, Some(ref msg)))
                    if msg.contains("duplicate column name") => {}
                Err(e) => return Err(e),
            }
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
        // Fingerprints of every turn already in the log (rows without a turn id
        // count as their own one-row turn), folded straight from the payload's
        // text. A turn holding a cancelled/silent user row (queue-cancel, notice
        // turns) is not real prompt content, so it never suppresses a re-typed
        // prompt.
        let mut existing_fps: std::collections::HashSet<String> = {
            type Row = (Option<String>, String, Option<String>, bool);
            let rows: Vec<Row> = (|| -> rusqlite::Result<Vec<Row>> {
                let mut stmt = self.conn.prepare(
                    "SELECT turn_id, kind, json_extract(payload, '$.text'),
                            COALESCE(json_extract(payload, '$.cancelled'), 0)
                              OR COALESCE(json_extract(payload, '$.silent'), 0)
                     FROM message
                     WHERE session_id = ?1 AND superseded = 0 AND kind IN ('user', 'text')
                     ORDER BY seq",
                )?;
                let result = stmt
                    .query_map([&self.session_id], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(result)
            })()
            .unwrap_or_default();
            // turn key -> (user text, assistant text, has cancelled/silent user row)
            let mut turns: std::collections::HashMap<String, (Option<String>, String, bool)> =
                std::collections::HashMap::new();
            for (i, (turn_id, kind, text, void)) in rows.into_iter().enumerate() {
                let t = turns
                    .entry(turn_id.unwrap_or_else(|| format!("\0{i}")))
                    .or_default();
                if kind == "user" {
                    t.2 |= void;
                    if t.0.is_none() {
                        t.0 = text;
                    }
                } else {
                    t.1.push_str(&text.unwrap_or_default());
                }
            }
            turns
                .values()
                .filter(|(_, _, void)| !void)
                .filter_map(|(u, a, _)| fingerprint(u.as_deref(), a))
                .collect()
        };
        // Existing `tool_use` ids in the live log — a group whose tool_use id
        // already exists was already imported (Decision 4c). Parse the payloads
        // of `kind = 'tool_use'` rows.
        let existing_tool_ids: std::collections::HashSet<String> = {
            let rows: Vec<String> = (|| -> rusqlite::Result<Vec<String>> {
                let mut stmt = self.conn.prepare(
                    "SELECT payload FROM message WHERE session_id = ?1 AND kind = 'tool_use'",
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
                    if let Some(id) = ev.tool_id {
                        set.insert(id);
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
                let has_tools = group_events
                    .iter()
                    .any(|e| e.kind == NormalizedEventKind::ToolUse);
                // Tool-less groups are decided by content; a group with tool use
                // by ids alone (its text may legitimately repeat, e.g. /loop
                // wake-ups that each do new work).
                let fp = (!has_tools)
                    .then(|| group_fingerprint(group_events))
                    .flatten();
                let dup_by_turn = turn_id
                    .as_ref()
                    .is_some_and(|t| existing_turn_ids.contains(t));
                let dup_by_tool = group_events
                    .iter()
                    .filter(|e| e.kind == NormalizedEventKind::ToolUse)
                    .filter_map(|e| e.tool_id.as_deref())
                    .any(|id| existing_tool_ids.contains(id));
                let dup_by_content = fp.as_ref().is_some_and(|f| existing_fps.contains(f));
                if dup_by_turn || dup_by_tool || dup_by_content {
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
                if let Some(f) = fp {
                    existing_fps.insert(f);
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
    ///
    /// The candidate window is the last `n_turns` turns (newest-first, from
    /// the `MIN(seq) GROUP BY turn_id` query). The returned turns are then
    /// narrowed by a **byte** budget: the newest turn is ALWAYS included whole
    /// (turn-aligned windows are a client invariant — tool_call/result pairing
    /// would render a broken latest turn if cut inside), and each older turn
    /// is included only while `acc_bytes + turn_bytes <= max_bytes`, stopping
    /// at the FIRST turn that does not fit (a contiguous new-turns window).
    /// `max_bytes == 0` means the newest turn only. Because the newest turn is
    /// always whole, the worst-case window is `max_bytes + one turn` (a single
    /// turn is unbounded; 1.9 MB observed) — per-event truncation of oversized
    /// turns is a follow-up.
    ///
    /// Sizing uses ONE query over only the candidate window —
    /// `SELECT seq, LENGTH(CAST(payload AS BLOB)) FROM message WHERE ... AND
    /// seq >= starts.last()` — and attributes each row to the turn whose seq
    /// range it sits in (`turn i` owns `[starts[i], starts[i-1])`), matching
    /// exactly what `page_from` loads whatever the turn ids (NULL / interleaved).
    /// It deliberately does NOT add `SUM(LENGTH(payload))` to the GROUP BY
    /// query, which would read every payload in history. Bytes are UTF-8
    /// bytes (`CAST AS BLOB`), not chars.
    pub fn tail(&self, n_turns: i64, max_bytes: usize) -> TranscriptPage {
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
                payload_bytes: 0,
            };
        }
        let cut_seq = *starts.last().unwrap();
        // Size ONLY the candidate window (`seq >= cut_seq`). The query is ASC
        // by seq; `starts` is DESC (newest first), which is how the per-turn
        // attribution below walks newest -> oldest.
        let sizes: Option<Vec<(i64, usize)>> = (|| -> rusqlite::Result<Vec<(i64, usize)>> {
            let mut stmt = self.conn.prepare(
                "SELECT seq, LENGTH(CAST(payload AS BLOB)) FROM message WHERE session_id = ?1 AND superseded = 0 AND seq >= ?2 ORDER BY seq ASC",
            )?;
            let result = stmt
                .query_map(params![self.session_id, cut_seq], |r| {
                    Ok((r.get(0)?, r.get::<_, i64>(1)? as usize))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(result)
        })()
        .ok();
        // Fail closed: if the sizes can't be read, the budget can't be
        // enforced, so serve the newest turn only rather than the whole window.
        let Some(sizes) = sizes else {
            return self.page_from(starts[0]);
        };

        // Attribute each sized row to the turn whose seq range it sits in —
        // `turn i` owns `[starts[i], starts[i-1])`, newest (`i = 0`) owns
        // `[starts[0], inf)`. The sizes query is ASC and `starts` is DESC, so
        // walk backwards through the ASC tail for each turn.
        let mut turn_sizes = vec![0usize; starts.len()];
        let mut pos = sizes.len();
        for i in 0..starts.len() {
            let lo = starts[i];
            let hi = if i == 0 { i64::MAX } else { starts[i - 1] };
            while pos > 0 && sizes[pos - 1].0 >= lo && sizes[pos - 1].0 < hi {
                pos -= 1;
                turn_sizes[i] += sizes[pos].1;
            }
        }

        // Walk newest -> oldest, always including the newest; stop at the
        // first older turn that does not fit.
        let mut cut_index = 0usize; // oldest included turn (newest-first index)
        let mut acc = turn_sizes[0];
        while cut_index + 1 < starts.len() && acc + turn_sizes[cut_index + 1] <= max_bytes {
            cut_index += 1;
            acc += turn_sizes[cut_index];
        }
        self.page_from(starts[cut_index])
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
                payload_bytes: 0,
            };
        }
        let (oldest_seq, oldest_turn) = rows.last().unwrap();
        let start_seq = match oldest_turn {
            Some(t) => self.turn_first_seq(t),
            None => *oldest_seq,
        };
        let (events, payload_bytes) = self.range_asc(start_seq, seq);
        TranscriptPage {
            events,
            oldest_seq: Some(start_seq),
            has_more: self.exists_before(start_seq),
            payload_bytes,
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
                payload_bytes: 0,
            };
        }
        let payload_bytes: usize = rows.iter().map(|(_, p)| p.len()).sum();
        let events: Vec<NormalizedEvent> = rows
            .iter()
            .filter_map(|(s, p)| self.parse_row(*s, p))
            .collect();
        let last_seq = rows.last().unwrap().0;
        SincePage {
            events,
            next_seq: Some(last_seq),
            has_more: self.exists_after(last_seq),
            payload_bytes,
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
        let payload_bytes: usize = rows.iter().map(|(_, p)| p.len()).sum();
        let events: Vec<NormalizedEvent> = rows
            .iter()
            .filter_map(|(s, p)| self.parse_row(*s, p))
            .collect();
        TranscriptPage {
            oldest_seq: (!events.is_empty()).then_some(from_seq),
            has_more: self.exists_before(from_seq),
            events,
            payload_bytes,
        }
    }

    fn range_asc(&self, start_seq: i64, end_seq: i64) -> (Vec<NormalizedEvent>, usize) {
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
        let payload_bytes: usize = rows.iter().map(|(_, p)| p.len()).sum();
        let events = rows
            .iter()
            .filter_map(|(s, p)| self.parse_row(*s, p))
            .collect();
        (events, payload_bytes)
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
