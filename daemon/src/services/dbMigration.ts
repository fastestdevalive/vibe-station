/**
 * Boot migration: `manifest.json` (per project) -> `vibe-station.db`
 * (Decision 3). Additive and non-destructive — `manifest.json` is never
 * deleted, and one corrupt project's migration failure never blocks boot for
 * the others (per-project try/catch).
 *
 * Gated PER-PROJECT via the `manifest_migrations` table, not a global
 * `PRAGMA user_version` flag. Every boot re-scans `~/.vibe-station/projects`
 * (`listMigratableProjectIds`), but a project with a `status: 'ok'` row is
 * skipped outright — its manifest.json is not re-read, so a live DB value
 * that has since diverged from that stale JSON snapshot (e.g. a rename after
 * migration) is never clobbered. A project with no row, or a `status:
 * 'failed'` row, is (re-)attempted, so:
 *   - a project that failed on a previous boot is automatically retried on
 *     the next one once its manifest.json is fixed (no more silent,
 *     permanent quarantine), and
 *   - a manifest.json that appears after earlier boots (restored backup,
 *     copied project dir) is picked up on the next boot.
 * Forcing a re-migration of one project is just deleting/resetting its
 * `manifest_migrations` row — no other project is affected.
 */
import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { readManifest } from "./manifest.js";
import { vstHome, manifestPath } from "./paths.js";
import { ensureSchema } from "./dbSchema.js";
import type { Channel, SessionLifecycle, TranscriptRef } from "../types.js";

/**
 * Shape of a session as it actually exists in an on-disk `manifest.json`
 * today — includes the legacy `slot` field being removed everywhere else in
 * this migration, and lacks the new columns (`worktreeId`/`isMain`/`sortOrder`
 * etc.) that `SessionRecord` now requires. `readManifest`'s declared return
 * type is the NEW `ProjectRecord` shape, but at runtime it's just parsed JSON
 * — this interface describes what's actually there so the migration reads it
 * defensively instead of trusting the (now-inaccurate for old files) type.
 */
interface LegacySessionRecord {
  id: string;
  slot?: string;
  type: "agent" | "terminal";
  modeId?: string;
  name?: string;
  tmuxName: string;
  useTmux: boolean;
  channel?: Channel;
  lifecycle: SessionLifecycle;
  transcriptRef?: TranscriptRef;
  agentChatId?: string;
  modelOverride?: string;
  pinnedAt?: string;
  initialPrompt?: string;
}
interface LegacyWorktreeRecord {
  id: string;
  name?: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  createdAt: string;
  pinnedAt?: string;
  terminalSeq?: number;
  agentSeq?: number;
  sessions: LegacySessionRecord[];
}
interface LegacyProjectRecord {
  id: string;
  absolutePath: string;
  prefix: string;
  isGit: boolean;
  defaultBranch?: string;
  createdAt: string;
  hidden?: boolean;
  directSessions: LegacySessionRecord[];
  directSessionSeq?: number;
  worktrees: LegacyWorktreeRecord[];
  nextWorktreeNum?: number;
}

/** `~/.vibe-station/projects/*` entries that look like a project (have a manifest.json). */
async function listMigratableProjectIds(): Promise<string[]> {
  const projectsDir = join(vstHome(), "projects");
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return [];
  }
  const migratable: string[] = [];
  for (const entry of entries) {
    try {
      await access(manifestPath(entry));
      migratable.push(entry);
    } catch {
      // No manifest.json here — not a project dir (or already fully SQL-only).
    }
  }
  return migratable;
}

/**
 * Migrate one legacy session row. `id`/`tmuxName` are copied VERBATIM
 * (grandfathered, Decision 1) — never regenerated, so an existing tmux pane
 * keeps matching its record across the migration.
 *
 * `isMain` backfills from the removed `slot === "m"` check. A missing `name`
 * on an agent session is backfilled from the old `a{n}` slot number (best
 * effort, judgment call — the plan doesn't specify this, but leaving every
 * migrated agent's default label completely blank instead of "Agent N" would
 * be a visible regression for existing users).
 */
function insertLegacySession(
  db: Database,
  s: LegacySessionRecord,
  opts: { worktreeId: string | null; projectId: string; sortOrder: number },
): void {
  const isMain = s.slot === "m";
  let name = s.name ?? null;
  if (name == null && s.type === "agent" && s.slot) {
    const m = /^a(\d+)$/.exec(s.slot);
    if (m) name = `Agent ${m[1]}`;
  }
  // ON CONFLICT DO NOTHING, not DO UPDATE: this only ever fires when
  // retrying a project whose `manifest_migrations` row is 'failed' (an
  // 'ok' project is skipped before we get here — see
  // migrateManifestsToSqlite). A failed attempt may have partially
  // inserted some rows before it threw; DO NOTHING lets the retry
  // re-insert the rows that never made it in without erroring on the ones
  // that already did, while never overwriting anything with the (possibly
  // stale) manifest.json snapshot being replayed.
  db.prepare(
    `INSERT INTO sessions (id, worktreeId, projectId, isMain, sortOrder, type, modeId, name, nameSource, tmuxName, useTmux, channel, state, reason, lastTransitionAt, transcriptKind, transcriptPath, agentChatId, modelOverride, pinnedAt, initialPrompt, archivedAt, handoffSummary)
     VALUES (@id, @worktreeId, @projectId, @isMain, @sortOrder, @type, @modeId, @name, @nameSource, @tmuxName, @useTmux, @channel, @state, @reason, @lastTransitionAt, @transcriptKind, @transcriptPath, @agentChatId, @modelOverride, @pinnedAt, @initialPrompt, @archivedAt, @handoffSummary)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    id: s.id,
    worktreeId: opts.worktreeId,
    projectId: opts.projectId,
    isMain: isMain ? 1 : 0,
    sortOrder: opts.sortOrder,
    type: s.type,
    modeId: s.modeId ?? null,
    name,
    nameSource: name != null ? "auto" : null,
    tmuxName: s.tmuxName,
    useTmux: s.useTmux ? 1 : 0,
    channel: s.channel ?? null,
    state: s.lifecycle.state,
    reason: s.lifecycle.reason ?? null,
    lastTransitionAt: s.lifecycle.lastTransitionAt,
    transcriptKind: s.transcriptRef?.kind ?? null,
    transcriptPath: s.transcriptRef?.path ?? null,
    agentChatId: s.agentChatId ?? null,
    modelOverride: s.modelOverride ?? null,
    pinnedAt: s.pinnedAt ?? null,
    initialPrompt: s.initialPrompt ?? null,
    archivedAt: null,
    handoffSummary: null,
  });
}

function insertLegacyProject(db: Database, p: LegacyProjectRecord): void {
  const txn = db.transaction((legacy: LegacyProjectRecord) => {
    db.prepare(
      `INSERT INTO projects (id, absolutePath, prefix, isGit, defaultBranch, createdAt, hidden, directSessionSeq, nextWorktreeNum)
       VALUES (@id, @absolutePath, @prefix, @isGit, @defaultBranch, @createdAt, @hidden, @directSessionSeq, @nextWorktreeNum)
       ON CONFLICT(id) DO NOTHING`,
    ).run({
      id: legacy.id,
      absolutePath: legacy.absolutePath,
      prefix: legacy.prefix,
      isGit: legacy.isGit ? 1 : 0,
      defaultBranch: legacy.defaultBranch ?? null,
      createdAt: legacy.createdAt,
      hidden: legacy.hidden ? 1 : 0,
      directSessionSeq: legacy.directSessionSeq ?? 0,
      nextWorktreeNum: legacy.nextWorktreeNum ?? 1,
    });

    legacy.worktrees.forEach((w, wi) => {
      db.prepare(
        `INSERT INTO worktrees (id, projectId, name, branch, baseBranch, baseSha, createdAt, pinnedAt, sortOrder, terminalSeq, agentSeq, branchIsPlaceholder)
         VALUES (@id, @projectId, @name, @branch, @baseBranch, @baseSha, @createdAt, @pinnedAt, @sortOrder, @terminalSeq, @agentSeq, @branchIsPlaceholder)
         ON CONFLICT(id) DO NOTHING`,
      ).run({
        id: w.id,
        projectId: legacy.id,
        name: w.name ?? null,
        branch: w.branch,
        baseBranch: w.baseBranch ?? null,
        baseSha: w.baseSha ?? null,
        createdAt: w.createdAt,
        pinnedAt: w.pinnedAt ?? null,
        sortOrder: wi,
        terminalSeq: w.terminalSeq ?? 0,
        agentSeq: w.agentSeq ?? 0,
        // Every worktree that existed before this feature always had an
        // explicit branch (the old code required one) — never a placeholder.
        branchIsPlaceholder: 0,
      });
      w.sessions.forEach((s, si) =>
        insertLegacySession(db, s, { worktreeId: w.id, projectId: legacy.id, sortOrder: si }),
      );
    });

    legacy.directSessions.forEach((s, si) =>
      insertLegacySession(db, s, { worktreeId: null, projectId: legacy.id, sortOrder: si }),
    );
  });
  txn(p);
}

/** The current `manifest_migrations` row for a project, if any. */
function getMigrationStatus(db: Database, projectId: string): { status: "ok" | "failed" } | undefined {
  return db.prepare(`SELECT status FROM manifest_migrations WHERE projectId = ?`).get(projectId) as
    | { status: "ok" | "failed" }
    | undefined;
}

/** Record the outcome of a migration attempt for one project (upsert). */
function recordMigrationOutcome(
  db: Database,
  projectId: string,
  outcome: { status: "ok" } | { status: "failed"; error: string },
): void {
  db.prepare(
    `INSERT INTO manifest_migrations (projectId, migratedAt, status, error)
     VALUES (@projectId, @migratedAt, @status, @error)
     ON CONFLICT(projectId) DO UPDATE SET migratedAt = excluded.migratedAt, status = excluded.status, error = excluded.error`,
  ).run({
    projectId,
    migratedAt: new Date().toISOString(),
    status: outcome.status,
    error: outcome.status === "failed" ? outcome.error : null,
  });
}

/**
 * Migrate every not-yet-successfully-migrated `manifest.json` project into
 * `vibe-station.db`. Safe (and intended) to call on every boot: a project
 * already recorded `status: 'ok'` in `manifest_migrations` is skipped without
 * touching its manifest.json or re-inserting anything, so this never
 * overwrites live DB state with a stale JSON snapshot. Only new projects and
 * previously failed ones do any work.
 */
export async function migrateManifestsToSqlite(db: Database): Promise<void> {
  // Idempotent and cheap — always run, not just on a "first boot" branch, so
  // this doesn't rely on `getDb()` having already called it separately.
  ensureSchema(db);

  const projectIds = await listMigratableProjectIds();
  for (const projectId of projectIds) {
    const existing = getMigrationStatus(db, projectId);
    if (existing?.status === "ok") continue; // already migrated — never re-attempt.

    try {
      const legacy = (await readManifest(projectId)) as unknown as LegacyProjectRecord;
      insertLegacyProject(db, legacy);
      recordMigrationOutcome(db, projectId, { status: "ok" });
    } catch (err) {
      console.error(
        `[dbMigration] project '${projectId}' migration failed — quarantined, manifest.json left on disk, will retry next boot:`,
        err,
      );
      recordMigrationOutcome(db, projectId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
      // Deliberately continue the loop — one bad project must not abort boot.
    }
  }
}
