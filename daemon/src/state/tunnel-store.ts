import { getDb } from "./db.js";

/** Persisted view of the cloudflared quick-tunnel's intent + last-known process. */
export interface TunnelStateRow {
  enabled: boolean;
  currentUrl: string | null;
  currentPid: number | null;
  startedAt: number | null;
  port: number | null;
}

const ROW_ID = 1;

const EMPTY_STATE: TunnelStateRow = {
  enabled: false,
  currentUrl: null,
  currentPid: null,
  startedAt: null,
  port: null,
};

/** Read the single `tunnel_state` row. Fail-open: DB hiccup returns the empty/disabled state. */
export function getState(): TunnelStateRow {
  try {
    const row = getDb()
      .prepare<
        [number],
        { enabled: number; currentUrl: string | null; currentPid: number | null; startedAt: string | null; port: number | null }
      >("SELECT enabled, currentUrl, currentPid, startedAt, port FROM tunnel_state WHERE id = ?")
      .get(ROW_ID);
    if (!row) return EMPTY_STATE;
    return {
      enabled: row.enabled === 1,
      currentUrl: row.currentUrl,
      currentPid: row.currentPid,
      startedAt: row.startedAt !== null ? Number(row.startedAt) : null,
      port: row.port,
    };
  } catch {
    return EMPTY_STATE;
  }
}

/** Upsert the full row — used on a successful `enable()` (cloudflared.ts). Best-effort. */
export function setState(state: TunnelStateRow): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO tunnel_state (id, enabled, currentUrl, currentPid, startedAt, port)
           VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled=excluded.enabled, currentUrl=excluded.currentUrl,
           currentPid=excluded.currentPid, startedAt=excluded.startedAt, port=excluded.port`,
      )
      .run(
        ROW_ID,
        state.enabled ? 1 : 0,
        state.currentUrl,
        state.currentPid,
        state.startedAt !== null ? String(state.startedAt) : null,
        state.port,
      );
  } catch {
    // best-effort
  }
}

/**
 * Full clear — the tunnel was explicitly disabled via the route. `enabled`
 * goes to false, so the next boot's restoreOnBoot() will NOT re-spawn.
 */
export function clear(): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO tunnel_state (id, enabled, currentUrl, currentPid, startedAt, port)
           VALUES (?, 0, NULL, NULL, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           enabled=0, currentUrl=NULL, currentPid=NULL, startedAt=NULL, port=NULL`,
      )
      .run(ROW_ID);
  } catch {
    // best-effort
  }
}

/**
 * Process-only clear — clears pid/url/startedAt but leaves `enabled` untouched.
 * Note: `shutdownKill()` now calls `clear()` instead, so this is only used
 * by code paths that need to clear process state without touching `enabled`.
 */
export function clearProcess(): void {
  try {
    getDb()
      .prepare(
        `UPDATE tunnel_state SET currentUrl=NULL, currentPid=NULL, startedAt=NULL WHERE id = ?`,
      )
      .run(ROW_ID);
  } catch {
    // best-effort
  }
}
