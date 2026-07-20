/**
 * One-time migration of a legacy `messages.jsonl` into the SQLite `message`
 * table (R0.4 / N2).
 *
 * Runs on the first open of a session's SQLite store. It is:
 *  - idempotent — a no-op once the DB already holds rows for the session;
 *  - transactional — the whole import is one transaction; on any failure it
 *    rolls back, leaving the `.jsonl` authoritative;
 *  - non-destructive — the `.jsonl` is KEPT as a read-only backup (never deleted
 *    and never written to again once migrated).
 *
 * Legacy lines carry no `logSeq`; each imported row gets a gap-free `seq` (the
 * line index over non-empty lines). Malformed/blank lines are skipped (mirroring
 * the legacy `readTranscript` reader) and do not consume a `seq`.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Database, Statement } from "better-sqlite3";
import type { NormalizedEvent } from "../types.js";

export interface MigrationResult {
  /** True if this call performed the import (false = already migrated / no file). */
  migrated: boolean;
  /** Rows inserted. */
  imported: number;
  /** Non-empty lines seen in the source `.jsonl` (for line-count reconciliation). */
  lines: number;
}

/**
 * Import a session's legacy `messages.jsonl` into `db` if the DB has no rows for
 * that session yet. Safe to call on every store open.
 */
export function migrateJsonlIntoDb(
  db: Database,
  sessionId: string,
  jsonlPath: string,
): MigrationResult {
  if (!existsSync(jsonlPath)) return { migrated: false, imported: 0, lines: 0 };

  // Idempotent: rows already present ⇒ migration ran (or a live turn wrote here).
  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ?")
    .get(sessionId) as { n: number };
  if (existing.n > 0) return { migrated: false, imported: 0, lines: 0 };

  const rawLines = readFileSync(jsonlPath, "utf8").split("\n");
  const nonEmpty = rawLines.filter((l) => l.trim().length > 0);

  const insert: Statement = db.prepare(
    "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
  );

  let imported = 0;
  const runImport = db.transaction(() => {
    for (const line of nonEmpty) {
      const trimmed = line.trim();
      let ev: NormalizedEvent;
      try {
        ev = JSON.parse(trimmed) as NormalizedEvent;
      } catch {
        continue; // skip malformed legacy line (does not consume a seq)
      }
      // Persist the original line verbatim — legacy events have no `logSeq`;
      // it is synthesized from the `seq` column on read (backward-compat, N3).
      insert.run(sessionId, imported, ev.ts ?? null, ev.kind ?? null, ev.turnId ?? null, trimmed);
      imported++;
    }
  });
  runImport();

  // Observability (N5): reconcile imported rows against the source line count.
  if (imported !== nonEmpty.length) {
    console.warn(
      `[transcript-migration] session=${sessionId} imported=${imported} of ${nonEmpty.length} lines ` +
        `(${nonEmpty.length - imported} malformed skipped)`,
    );
  } else {
    console.log(
      `[transcript-migration] session=${sessionId} imported=${imported} lines (jsonl kept as backup)`,
    );
  }

  return { migrated: true, imported, lines: nonEmpty.length };
}
