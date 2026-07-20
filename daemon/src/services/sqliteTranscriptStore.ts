/**
 * SQLite concrete impl of `TranscriptStore` (R0.2 / R0.8).
 *
 * One DB file per session (`messages.db`), living beside the legacy
 * `messages.jsonl` under `sessionDataDir`. `session_id` stays in the primary key
 * so a future multi-session consolidation is a schema no-op.
 *
 * WAL mode + single writer: the owning `JsonAgentSession` is the sole writer, and
 * the durable `logSeq` is assigned inside the same transaction as the insert so
 * it stays gap-free/monotonic and never blocks concurrent reads. The writer seeds
 * its cursor from `MAX(seq)+1` on construction (bounded query).
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database as DB, Statement } from "better-sqlite3";
import type { NormalizedEvent, UsageInfo } from "../types.js";
import type {
  ImportOutcome,
  NativeWatermark,
  TranscriptMeta,
  TranscriptPage,
  TranscriptStore,
} from "./transcriptStore.js";
import { migrateJsonlIntoDb } from "./transcriptMigration.js";
import { capToolResultContent, TOOL_RESULT_MAX_BYTES } from "./toolResultCap.js";

/** A usage event reflects a real model call only when it billed tokens. */
function hasRealUsage(usage: UsageInfo | undefined): usage is UsageInfo {
  return !!usage && usage.totalTokens > 0;
}

/**
 * Content signature of a `user` event for round-trip dedup (R0.9): the trimmed
 * prompt text. Empty prompts return undefined (never dedup on an empty string).
 */
function userSignature(ev: NormalizedEvent): string | undefined {
  if (ev.kind !== "user" || typeof ev.text !== "string") return undefined;
  const t = ev.text.trim();
  return t.length ? t : undefined;
}

export interface SqliteTranscriptStoreOptions {
  /** Absolute path to the per-session DB file (created if absent). */
  dbPath: string;
  /** Per-session id — the first column of the primary key. */
  sessionId: string;
  /** Legacy `messages.jsonl` path to migrate from on first open (optional). */
  jsonlPath?: string;
}

export class SqliteTranscriptStore implements TranscriptStore {
  private readonly db: DB;
  private readonly sessionId: string;
  private readonly insertStmt: Statement;
  private readonly appendTxn: (seq: number, ev: NormalizedEvent, payload: string) => void;
  private readonly watermarkUpsertStmt: Statement;
  /** Next `logSeq` to assign — seeded from `MAX(seq)+1`. */
  private nextSeq: number;

  constructor(opts: SqliteTranscriptStoreOptions) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.sessionId = opts.sessionId;

    this.db.exec(`
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
    `);

    // Idempotent `superseded` column migration (P4/R3.4). P0 already created the
    // `message` table on existing DBs, so a plain ALTER would throw on re-open —
    // check `PRAGMA table_info` first and only add the column when it is absent.
    // Marks rows truncated by an edit-a-sent-message fork; excluded from every
    // read below so tail-N counts only LIVE turns (closes the P1↔P4 back-edge).
    const cols = this.db.prepare("PRAGMA table_info(message)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "superseded")) {
      this.db.exec("ALTER TABLE message ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0");
    }

    // One-time legacy import (idempotent + transactional; keeps the .jsonl).
    if (opts.jsonlPath) migrateJsonlIntoDb(this.db, this.sessionId, opts.jsonlPath);

    // Oversized `tool_result` backfill (json-mode-followups item 1, Decision 3).
    // Runs on every open but is naturally idempotent: once a row's payload is
    // capped, its length drops well under `TOOL_RESULT_MAX_BYTES` and it never
    // matches the WHERE clause again on a later open. Scans ALL rows for the
    // session INCLUDING `superseded = 1` — those stay reachable via `since()`
    // gap-fills even after a fork truncates them from the live branch, so they
    // must be capped too, not just live rows. `LENGTH(payload)` is a safe
    // superset filter (payload always includes the content plus JSON overhead,
    // so it's never shorter than the raw content), avoiding a full parse of
    // every row just to find the rare oversized ones.
    const oversizedRows = this.db
      .prepare(
        "SELECT seq, payload FROM message WHERE session_id = ? AND kind = 'tool_result' AND LENGTH(payload) > ?",
      )
      .all(this.sessionId, TOOL_RESULT_MAX_BYTES) as { seq: number; payload: string }[];
    if (oversizedRows.length > 0) {
      const backfillUpdateStmt = this.db.prepare(
        "UPDATE message SET payload = ? WHERE session_id = ? AND seq = ?",
      );
      const backfill = this.db.transaction(() => {
        for (const r of oversizedRows) {
          const ev = JSON.parse(r.payload) as NormalizedEvent;
          capToolResultContent(ev);
          backfillUpdateStmt.run(JSON.stringify(ev), this.sessionId, r.seq);
        }
      });
      backfill();
    }

    // Seed the writer cursor from the durable max (bounded query, R0.3/J8).
    const row = this.db
      .prepare("SELECT MAX(seq) AS maxSeq FROM message WHERE session_id = ?")
      .get(this.sessionId) as { maxSeq: number | null };
    this.nextSeq = (row.maxSeq ?? -1) + 1;

    this.insertStmt = this.db.prepare(
      "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    // seq assigned + inserted atomically (R0.8) — gap-free/monotonic.
    this.appendTxn = this.db.transaction((seq: number, ev: NormalizedEvent, payload: string) => {
      this.insertStmt.run(this.sessionId, seq, ev.ts ?? null, ev.kind ?? null, ev.turnId ?? null, payload);
    });
    this.watermarkUpsertStmt = this.db.prepare(
      "INSERT INTO native_watermark (session_id, cli, cursor) VALUES (?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET cli = excluded.cli, cursor = excluded.cursor",
    );
  }

  append(ev: NormalizedEvent): number {
    const seq = this.nextSeq;
    ev.logSeq = seq;
    this.appendTxn(seq, ev, JSON.stringify(ev));
    this.nextSeq = seq + 1;
    return seq;
  }

  readAll(): NormalizedEvent[] {
    // Superseded (forked-away) rows are excluded so a full replay shows only the
    // live branch (R3.4); the durable `logSeq` stays gap-real for `since` deltas.
    const rows = this.db
      .prepare("SELECT seq, payload FROM message WHERE session_id = ? AND superseded = 0 ORDER BY seq ASC")
      .all(this.sessionId) as { seq: number; payload: string }[];
    return rows.map((r) => this.parseRow(r.seq, r.payload));
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ? AND superseded = 0")
      .get(this.sessionId) as { n: number };
    return row.n;
  }

  /**
   * Mark every row at/after `seq` superseded (fork truncation, R3.4). Append-only
   * store → we never delete: the old branch is kept (git-style, decision R3.3) but
   * hidden from all reads. Returns the DISTINCT `turnId`s it flagged so the caller
   * can broadcast the fork to other tabs for a re-sync (R3.6).
   */
  markSupersededFrom(seq: number): string[] {
    const turns = this.db
      .prepare(
        "SELECT DISTINCT turn_id AS t FROM message WHERE session_id = ? AND seq >= ? AND turn_id IS NOT NULL AND superseded = 0",
      )
      .all(this.sessionId, seq) as { t: string }[];
    this.db
      .prepare("UPDATE message SET superseded = 1 WHERE session_id = ? AND seq >= ?")
      .run(this.sessionId, seq);
    return turns.map((r) => r.t);
  }

  /** First `logSeq` of a turn (live rows only) — the fork cut point (R3.4). */
  firstSeqOfTurn(turnId: string): number | undefined {
    const row = this.db
      .prepare(
        "SELECT MIN(seq) AS firstSeq FROM message WHERE session_id = ? AND turn_id = ? AND superseded = 0",
      )
      .get(this.sessionId, turnId) as { firstSeq: number | null };
    return row.firstSeq ?? undefined;
  }

  lastMeta(): TranscriptMeta {
    // Bounded reverse scan (R2.6 / J11): walk newest→oldest and stop as soon as
    // both the last model-bearing and last REAL-usage-bearing event are found —
    // never reads the whole table. The last model/usage may sit OLDER than the
    // pagination tail window, so this cannot be derived from `tail()` alone.
    const meta: TranscriptMeta = {};
    let haveModel = false;
    let haveUsage = false;
    const iter = this.db
      .prepare("SELECT seq, payload FROM message WHERE session_id = ? AND superseded = 0 ORDER BY seq DESC")
      .iterate(this.sessionId) as Iterable<{ seq: number; payload: string }>;
    for (const row of iter) {
      const ev = this.parseRow(row.seq, row.payload);
      if (!haveModel && ev.model) {
        meta.model = ev.model;
        haveModel = true;
      }
      if (!haveUsage && hasRealUsage(ev.usage)) {
        meta.usage = ev.usage;
        haveUsage = true;
      }
      if (haveModel && haveUsage) break;
    }
    return meta;
  }

  // --- P2 native-history import (single txn, dedup, watermark) ---

  /**
   * Import native-history `events` in a single transaction (R0.9). Turns already
   * mirrored — matched by `turnId` (same-CLI re-import) OR by the user prompt's
   * content (a JSON→tty→JSON round trip whose turn ids differ, J5) — are skipped
   * whole. `logSeq` continues gap-free from `MAX(seq)+1`, and the native `cursor`
   * watermark is persisted in the SAME transaction. Any failure rolls the whole
   * thing back, so neither the rows nor the watermark advance (J14).
   */
  importTransaction(events: NormalizedEvent[], opts: { cli: string; cursor: string }): ImportOutcome {
    // Existing turn ids + user-content signatures already in the store.
    const existingTurnIds = new Set(
      (
        this.db
          .prepare("SELECT DISTINCT turn_id AS t FROM message WHERE session_id = ? AND turn_id IS NOT NULL")
          .all(this.sessionId) as { t: string }[]
      ).map((r) => r.t),
    );
    const existingUserSigs = new Set<string>();
    for (const r of this.db
      .prepare("SELECT payload FROM message WHERE session_id = ? AND kind = 'user'")
      .all(this.sessionId) as { payload: string }[]) {
      const sig = userSignature(JSON.parse(r.payload) as NormalizedEvent);
      if (sig) existingUserSigs.add(sig);
    }

    // Group events into turns, preserving first-seen order. Events with no
    // turnId (e.g. a store that opens mid-turn) each form their own group and
    // are always imported (cannot be deduped).
    const groups: { turnId: string | undefined; events: NormalizedEvent[] }[] = [];
    const byTurn = new Map<string, NormalizedEvent[]>();
    for (const ev of events) {
      if (ev.turnId == null) {
        groups.push({ turnId: undefined, events: [ev] });
        continue;
      }
      let g = byTurn.get(ev.turnId);
      if (!g) {
        g = [];
        byTurn.set(ev.turnId, g);
        groups.push({ turnId: ev.turnId, events: g });
      }
      g.push(ev);
    }

    let imported = 0;
    let turnsImported = 0;
    let turnsSkipped = 0;
    let localNext = this.nextSeq;

    const run = this.db.transaction(() => {
      for (const group of groups) {
        const userSig = group.events.map(userSignature).find((s) => s != null);
        const dupByTurn = group.turnId != null && existingTurnIds.has(group.turnId);
        const dupByContent = userSig != null && existingUserSigs.has(userSig);
        if (dupByTurn || dupByContent) {
          turnsSkipped++;
          continue;
        }
        for (const ev of group.events) {
          ev.logSeq = localNext;
          capToolResultContent(ev);
          this.insertStmt.run(
            this.sessionId,
            localNext,
            ev.ts ?? null,
            ev.kind ?? null,
            ev.turnId ?? null,
            JSON.stringify(ev),
          );
          localNext++;
          imported++;
        }
        turnsImported++;
        // Later groups in this same batch dedup against what we just imported.
        if (group.turnId != null) existingTurnIds.add(group.turnId);
        if (userSig != null) existingUserSigs.add(userSig);
      }
      // Advance the native watermark inside the same transaction (R0.9).
      this.watermarkUpsertStmt.run(this.sessionId, opts.cli, opts.cursor);
    });
    run(); // throws ⇒ rollback: rows + watermark unchanged, nextSeq untouched.
    this.nextSeq = localNext;

    // Observability (N5): import counts + dedup skips.
    console.log(
      `[native-import] session=${this.sessionId} cli=${opts.cli} ` +
        `turnsImported=${turnsImported} turnsSkipped=${turnsSkipped} events=${imported} cursor=${opts.cursor}`,
    );
    return { imported, turnsImported, turnsSkipped, cursor: opts.cursor };
  }

  getNativeWatermark(): NativeWatermark | undefined {
    const row = this.db
      .prepare("SELECT cli, cursor FROM native_watermark WHERE session_id = ?")
      .get(this.sessionId) as { cli: string; cursor: string } | undefined;
    return row ? { cli: row.cli, cursor: row.cursor } : undefined;
  }

  // --- P1 pagination (keyset, bounded — never a full scan) ---

  /**
   * The last `nTurns` turns, turn-aligned (R2.4): resolve the first `seq` of the
   * Nth-newest distinct `turn_id` via the `(session_id, turn_id)` index and
   * return every row from there on — a turn is never split. `hasMore` reflects
   * whether any older rows exist before the window.
   */
  tail(nTurns: number): TranscriptPage {
    const n = Math.max(1, Math.floor(nTurns));
    // First `seq` of each turn, newest-first; the Nth row is the window boundary.
    // Index-only over `(session_id, turn_id)` — reads no payloads.
    const starts = this.db
      .prepare(
        "SELECT MIN(seq) AS firstSeq FROM message WHERE session_id = ? AND superseded = 0 GROUP BY turn_id ORDER BY firstSeq DESC LIMIT ?",
      )
      .all(this.sessionId, n) as { firstSeq: number }[];
    if (starts.length === 0) return { events: [], hasMore: false };
    // The oldest of the newest-N turn starts is the turn-aligned cut point.
    const cutSeq = starts[starts.length - 1]!.firstSeq;
    return this.pageFrom(cutSeq);
  }

  /**
   * Keyset page of events strictly before `seq` (`WHERE seq < ? ORDER BY seq DESC
   * LIMIT ?`, re-sorted asc), then turn-aligned at the older boundary so the
   * page never starts mid-turn (R2.2/R2.4).
   */
  pageBefore(seq: number, limit: number): TranscriptPage {
    const lim = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        "SELECT seq, turn_id AS turnId FROM message WHERE session_id = ? AND superseded = 0 AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(this.sessionId, seq, lim) as { seq: number; turnId: string | null }[];
    if (rows.length === 0) return { events: [], hasMore: false };
    // Oldest candidate in the page (rows are DESC, so the last one).
    const oldest = rows[rows.length - 1]!;
    // Turn-align the older boundary: extend back to the first seq of the oldest
    // candidate's turn so we never return a partial (split) turn.
    const startSeq = oldest.turnId == null ? oldest.seq : this.turnFirstSeq(oldest.turnId);
    // Fetch the aligned window [startSeq, seq).
    const events = this.rangeAsc(startSeq, seq);
    return {
      events,
      oldestSeq: startSeq,
      hasMore: this.existsBefore(startSeq),
    };
  }

  since(seq: number): NormalizedEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, payload FROM message WHERE session_id = ? AND superseded = 0 AND seq > ? ORDER BY seq ASC",
      )
      .all(this.sessionId, seq) as { seq: number; payload: string }[];
    return rows.map((r) => this.parseRow(r.seq, r.payload));
  }

  /** Every row with `seq >= fromSeq`, asc, as a page with `hasMore` before it. */
  private pageFrom(fromSeq: number): TranscriptPage {
    const rows = this.db
      .prepare("SELECT seq, payload FROM message WHERE session_id = ? AND superseded = 0 AND seq >= ? ORDER BY seq ASC")
      .all(this.sessionId, fromSeq) as { seq: number; payload: string }[];
    return {
      events: rows.map((r) => this.parseRow(r.seq, r.payload)),
      ...(rows.length ? { oldestSeq: fromSeq } : {}),
      hasMore: this.existsBefore(fromSeq),
    };
  }

  /** Rows in `[startSeq, endSeq)`, ascending. */
  private rangeAsc(startSeq: number, endSeq: number): NormalizedEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, payload FROM message WHERE session_id = ? AND superseded = 0 AND seq >= ? AND seq < ? ORDER BY seq ASC",
      )
      .all(this.sessionId, startSeq, endSeq) as { seq: number; payload: string }[];
    return rows.map((r) => this.parseRow(r.seq, r.payload));
  }

  /** First `seq` of a turn (index-only over `(session_id, turn_id)`). */
  private turnFirstSeq(turnId: string): number {
    const row = this.db
      .prepare("SELECT MIN(seq) AS firstSeq FROM message WHERE session_id = ? AND turn_id = ? AND superseded = 0")
      .get(this.sessionId, turnId) as { firstSeq: number | null };
    return row.firstSeq ?? 0;
  }

  /** True when any live row exists strictly before `seq` (bounded EXISTS). */
  private existsBefore(seq: number): boolean {
    const row = this.db
      .prepare("SELECT EXISTS(SELECT 1 FROM message WHERE session_id = ? AND superseded = 0 AND seq < ?) AS e")
      .get(this.sessionId, seq) as { e: number };
    return row.e === 1;
  }

  close(): void {
    this.db.close();
  }

  /** Parse a stored payload; synthesize `logSeq` for legacy rows (N3). */
  private parseRow(seq: number, payload: string): NormalizedEvent {
    const ev = JSON.parse(payload) as NormalizedEvent;
    if (ev.logSeq === undefined) ev.logSeq = seq;
    return ev;
  }
}

/** Standard per-session DB path beside the legacy transcript. */
export function transcriptDbPath(dataDir: string): string {
  return join(dataDir, "messages.db");
}

/**
 * Open (create) the SQLite store for a session's data dir, migrating any legacy
 * `messages.jsonl` on first open. Callers own `close()`.
 */
export function openSqliteTranscriptStore(dataDir: string, sessionId: string): SqliteTranscriptStore {
  return new SqliteTranscriptStore({
    dbPath: transcriptDbPath(dataDir),
    sessionId,
    jsonlPath: join(dataDir, "messages.jsonl"),
  });
}
