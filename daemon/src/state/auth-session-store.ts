import { getDb } from "./db.js";

export interface AuthSessionMeta {
  createdVia: "password" | "qr";
  userAgent?: string;
  createdIp?: string;
  label?: string;
}

export interface AuthSessionRow {
  nonce: string;
  label: string | null;
  createdVia: "password" | "qr";
  createdAt: string;
  lastSeenAt: string;
  createdIp: string | null;
  expiresAt: string;
}

// In-memory cache: nonce → { expiresAt, revokedAt, lastSeenAt } (epoch ms)
const cache = new Map<string, { expiresAt: number; revokedAt: number | null; lastSeenAt: number }>();

/** Returns true if nonce is live (not expired, not revoked). Fail-open on DB error. */
export function isLive(nonce: string): boolean {
  const now = Date.now();
  const cached = cache.get(nonce);
  if (cached) {
    if (cached.revokedAt !== null) return false;
    if (cached.expiresAt <= now) return false;
    return true;
  }
  try {
    const row = getDb()
      .prepare<[string], { expiresAt: string; revokedAt: string | null }>(
        "SELECT expiresAt, revokedAt FROM auth_sessions WHERE nonce = ?",
      )
      .get(nonce);
    if (!row) return false;
    const expiresAt = Number(row.expiresAt);
    const revokedAt = row.revokedAt !== null ? Number(row.revokedAt) : null;
    cache.set(nonce, { expiresAt, revokedAt, lastSeenAt: now });
    if (revokedAt !== null) return false;
    return expiresAt > now;
  } catch {
    return true; // fail-open: DB hiccup must not lock out the developer
  }
}

/** Insert a new session row and update cache. */
export function issue(nonce: string, meta: AuthSessionMeta): void {
  const now = Date.now();
  const nowStr = String(now);
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
  const expiresAtStr = String(expiresAt);
  const label = meta.label ?? deriveLabel(meta.userAgent ?? null);
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO auth_sessions
          (nonce, createdAt, issuedAt, expiresAt, lastSeenAt, createdVia, label, userAgent, createdIp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nonce, nowStr, nowStr, expiresAtStr, nowStr, meta.createdVia, label, meta.userAgent ?? null, meta.createdIp ?? null);
    cache.set(nonce, { expiresAt, revokedAt: null, lastSeenAt: now });
  } catch {
    // best-effort
  }
}

/**
 * Update issuedAt, expiresAt, lastSeenAt for sliding bump.
 * Returns true if lastSeenAt was more than 1h ago (bump was needed).
 */
export function needsBump(nonce: string): boolean {
  const cached = cache.get(nonce);
  if (!cached) return false;
  return Date.now() - cached.lastSeenAt > 60 * 60 * 1000;
}

/** Slide the session expiry window forward and re-issue the HMAC clock. */
export function bump(nonce: string): void {
  const now = Date.now();
  const nowStr = String(now);
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
  const expiresAtStr = String(expiresAt);
  try {
    getDb()
      .prepare(
        "UPDATE auth_sessions SET issuedAt=?, expiresAt=?, lastSeenAt=? WHERE nonce=?",
      )
      .run(nowStr, expiresAtStr, nowStr, nonce);
    const prev = cache.get(nonce);
    if (prev) cache.set(nonce, { ...prev, expiresAt, lastSeenAt: now });
  } catch {
    // best-effort
  }
}

/** Stamp revokedAt and update cache. */
export function revoke(nonce: string): void {
  const now = Date.now();
  try {
    getDb()
      .prepare("UPDATE auth_sessions SET revokedAt=? WHERE nonce=?")
      .run(String(now), nonce);
    const prev = cache.get(nonce);
    if (prev) cache.set(nonce, { ...prev, revokedAt: now });
  } catch {
    // best-effort
  }
}

/** Revoke all sessions except the given nonce. Returns count. */
export function revokeAllExcept(exceptNonce: string): number {
  const now = Date.now();
  try {
    const result = getDb()
      .prepare(
        "UPDATE auth_sessions SET revokedAt=? WHERE nonce != ? AND revokedAt IS NULL AND expiresAt > ?",
      )
      .run(String(now), exceptNonce, String(now));
    // Invalidate cache for all non-excepted entries
    for (const [n, entry] of cache) {
      if (n !== exceptNonce && entry.revokedAt === null) {
        cache.set(n, { ...entry, revokedAt: now });
      }
    }
    return result.changes;
  } catch {
    return 0;
  }
}

/** List active sessions (not expired, not revoked), newest first. */
export function list(): AuthSessionRow[] {
  const now = String(Date.now());
  try {
    return getDb()
      .prepare<[string], AuthSessionRow>(
        `SELECT nonce, label, createdVia, createdAt, lastSeenAt, createdIp, expiresAt
           FROM auth_sessions
          WHERE expiresAt > ? AND revokedAt IS NULL
          ORDER BY issuedAt DESC`,
      )
      .all(now) as AuthSessionRow[];
  } catch {
    return [];
  }
}

/** Get a single session row by nonce (for revoke validation). */
export function get(nonce: string): { nonce: string; revokedAt: string | null } | null {
  try {
    return (
      getDb()
        .prepare<[string], { nonce: string; revokedAt: string | null }>(
          "SELECT nonce, revokedAt FROM auth_sessions WHERE nonce=?",
        )
        .get(nonce) ?? null
    );
  } catch {
    return null;
  }
}

function deriveLabel(ua: string | null): string | null {
  if (!ua) return null;
  if (/iPhone|iPad|iOS/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return null;
}
