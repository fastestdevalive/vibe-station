/**
 * One-time boot migration: `manifest.json` (per project) -> `vibe-station.db`
 * (Decision 3). Additive and non-destructive — `manifest.json` is never
 * deleted, and one corrupt project's migration failure never blocks boot for
 * the others (per-project try/catch).
 *
 * Gated by `PRAGMA user_version`: once a full pass has run, later boots skip
 * migration entirely (1.T3). A project that failed and was quarantined during
 * that pass is NOT automatically retried on a later boot — per the plan, the
 * untouched `manifest.json` lets it be fixed and re-migrated manually (e.g. by
 * resetting `user_version`), not silently retried forever.
 */
import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { readManifest } from "./manifest.js";
import { vstHome, manifestPath } from "./paths.js";
import { CURRENT_SCHEMA_VERSION, ensureSchema } from "./dbSchema.js";
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
  db.prepare(
    `INSERT INTO sessions (id, worktreeId, projectId, isMain, sortOrder, type, modeId, name, nameSource, tmuxName, useTmux, channel, state, reason, lastTransitionAt, transcriptKind, transcriptPath, agentChatId, modelOverride, pinnedAt, initialPrompt, archivedAt, handoffSummary)
     VALUES (@id, @worktreeId, @projectId, @isMain, @sortOrder, @type, @modeId, @name, @nameSource, @tmuxName, @useTmux, @channel, @state, @reason, @lastTransitionAt, @transcriptKind, @transcriptPath, @agentChatId, @modelOverride, @pinnedAt, @initialPrompt, @archivedAt, @handoffSummary)`,
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
         VALUES (@id, @projectId, @name, @branch, @baseBranch, @baseSha, @createdAt, @pinnedAt, @sortOrder, @terminalSeq, @agentSeq, @branchIsPlaceholder)`,
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

/**
 * Migrate every `manifest.json` project into `vibe-station.db`, once. Safe to
 * call on every boot — after the first successful pass it's a fast no-op
 * (single PRAGMA read).
 */
export async function migrateManifestsToSqlite(db: Database): Promise<void> {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version >= CURRENT_SCHEMA_VERSION) return;

  ensureSchema(db);

  const projectIds = await listMigratableProjectIds();
  for (const projectId of projectIds) {
    try {
      const legacy = (await readManifest(projectId)) as unknown as LegacyProjectRecord;
      insertLegacyProject(db, legacy);
    } catch (err) {
      console.error(
        `[dbMigration] project '${projectId}' migration failed — quarantined, manifest.json left on disk:`,
        err,
      );
      // Deliberately continue the loop — one bad project must not abort boot.
    }
  }

  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
}
