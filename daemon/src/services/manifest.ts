/**
 * Manifest read/write.
 * Writes are atomic: write to manifest.json.tmp in the same dir,
 * fsync, then rename → manifest.json (POSIX atomic).
 */
import { readFile, writeFile, rename, open, mkdir } from "node:fs/promises";
import type { ProjectRecord } from "../types.js";
import { manifestPath, manifestTmpPath, projectDir } from "./paths.js";
import { resolveUseTmux } from "./resolveUseTmux.js";
import { normalizeChannel } from "./channel.js";

export async function readManifest(projectId: string): Promise<ProjectRecord> {
  const content = await readFile(manifestPath(projectId), "utf8");
  const record = JSON.parse(content) as ProjectRecord;

  // Backfill for existing manifests created before non-git support:
  // - isGit defaults to true (all existing projects were git repos)
  // - directSessions defaults to empty array
  if (record.isGit === undefined) {
    record.isGit = true;
  }
  if (!record.directSessions) {
    record.directSessions = [];
  }
  // Bug fix: a manifest missing/null `worktrees` (legacy or corrupt write)
  // would otherwise make `dbMigration.ts`'s `for (const worktree of
  // record.worktrees)` throw on `undefined`, quarantining that project's
  // migration. Backfill to an empty array, same as `directSessions` above.
  if (!record.worktrees) {
    record.worktrees = [];
  }

  // Normalize useTmux for worktree sessions, then backfill `channel`
  // (Decision 1): legacy sessions get `tmux`/`pty` from useTmux; JSON pins
  // useTmux=false.
  for (const worktree of record.worktrees) {
    for (const session of worktree.sessions) {
      session.useTmux = resolveUseTmux(session.useTmux);
      normalizeChannel(session);
    }
  }
  // Normalize useTmux for direct sessions
  for (const session of record.directSessions) {
    session.useTmux = resolveUseTmux(session.useTmux);
    normalizeChannel(session);
  }
  return record;
}

export async function writeManifest(record: ProjectRecord): Promise<void> {
  const dir = projectDir(record.id);
  await mkdir(dir, { recursive: true });

  const tmpPath = manifestTmpPath(record.id);
  const finalPath = manifestPath(record.id);

  const json = JSON.stringify(record, null, 2);

  // Write to tmp file in same directory
  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(json, "utf8");
    await fh.sync(); // fsync
  } finally {
    await fh.close();
  }

  // Atomic rename
  await rename(tmpPath, finalPath);
}
