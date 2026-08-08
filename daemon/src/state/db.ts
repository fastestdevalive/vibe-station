/**
 * Singleton owner of the `vibe-station.db` connection. Every other module
 * reads/writes through `getDb()` — nothing else ever opens its own connection
 * (Phase 1.3).
 *
 * The cache is keyed on the resolved `dbPath()`, not just "has it ever been
 * opened": tests mock `services/paths.js` with a fresh temp-dir `vstHome()`
 * per test case, so `dbPath()` changes between tests even though this module
 * itself is only ever imported once per test file. Re-resolving the path on
 * every call and reopening when it changes gives each test its own isolated
 * database for free, with no per-test-file plumbing required.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { dbPath } from "../services/paths.js";
import { ensureSchema } from "../services/dbSchema.js";

let cached: { path: string; db: DB } | undefined;

/** Open (or reuse) the singleton `vibe-station.db` connection. */
export function getDb(): DB {
  const path = dbPath();
  if (cached && cached.path === path) return cached.db;

  // Path changed (or first call) — close any stale handle before reopening.
  if (cached) {
    try {
      cached.db.close();
    } catch {
      // best-effort
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  ensureSchema(db);
  cached = { path, db };
  return db;
}

/** For testing: close and drop the cached connection so the next `getDb()` reopens fresh. */
export function _resetDbForTest(): void {
  if (cached) {
    try {
      cached.db.close();
    } catch {
      // best-effort
    }
  }
  cached = undefined;
}
