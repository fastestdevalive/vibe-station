// @ts-nocheck
/**
 * Cursor chat session restore helpers.
 * Discovers prior cursor-agent chat sessions by chatId.
 *
 * Cursor stores per-workspace transcripts at:
 *   ~/.cursor/projects/<flattened-workspace-path>/agent-transcripts/<chatId>/<chatId>.jsonl
 *
 * Flattening rule (observed empirically — cursor-agent ≥ 2025.05):
 *   - strip leading `/`
 *   - drop `.` characters (so `.vibe-station` becomes `vibestation`)
 *   - replace remaining `/` with `-`
 * Example: `/home/gb/.vibe-station/projects/console-home/worktrees/ch-6`
 *       → `home-gb-vibestation-projects-console-home-worktrees-ch-6`
 *
 * To resume, we find the newest chatId-named subdirectory under agent-transcripts.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function flattenWorkspacePath(worktreePath: string): string {
  return worktreePath
    .replace(/^\/+/, "")
    .replaceAll(".", "")
    .replaceAll("/", "-");
}

/**
 * Find the latest cursor chatId for a given worktree path.
 * Returns the chatId (uuid) or null if no chats exist for this workspace.
 */
export async function findLatestCursorChatId(worktreePath: string): Promise<string | null> {
  const slug = flattenWorkspacePath(worktreePath);
  const transcriptsDir = join(homedir(), ".cursor", "projects", slug, "agent-transcripts");

  try {
    const entries = await fs.readdir(transcriptsDir, { withFileTypes: true });
    const chatDirs = entries.filter((e) => e.isDirectory());
    if (chatDirs.length === 0) return null;

    const stats = await Promise.all(
      chatDirs.map(async (e) => ({
        name: e.name,
        stat: await fs.stat(join(transcriptsDir, e.name)),
      })),
    );

    stats.sort((a, b) => (b.stat.mtime?.getTime() ?? 0) - (a.stat.mtime?.getTime() ?? 0));
    return stats[0]?.name ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export const _flattenWorkspacePathForTest = flattenWorkspacePath;
