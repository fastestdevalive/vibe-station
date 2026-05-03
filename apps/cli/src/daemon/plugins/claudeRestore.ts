/**
 * Claude chat session restore helpers.
 * Discovers and restores prior Claude Code chat sessions by UUID.
 *
 * Claude Code stores chat transcripts at:
 *   ~/.claude/projects/<project-slug>/<uuid>.jsonl
 *
 * Project slug is derived from the absolute worktree path with `/` → `-`
 * AND any `.` stripped (so `/home/gb/.vibe-station/...` → `-home-gb--vibe-station-...`).
 * Example: `/home/gb/.vibe-station/projects/console-home/worktrees/ch-2`
 *       → `-home-gb--vibe-station-projects-console-home-worktrees-ch-2`
 *
 * To resume, we find the newest *.jsonl file for that slug and extract its UUID.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Find the latest Claude chat UUID for a given worktree path.
 * Returns the UUID (filename without .jsonl) or null if no chats exist for this worktree.
 */
export async function findLatestChatUuid(worktreePath: string): Promise<string | null> {
  // Build slug: /home/gb/.vibe-station/projects/.../ch-2
  //          → -home-gb--vibe-station-projects-...-ch-2
  // Claude Code's convention: replace BOTH `/` and `.` with `-` (so `.foo`
  // between two slashes becomes `--foo`).
  const slug = worktreePath.replaceAll("/", "-").replaceAll(".", "-");

  const projectsDir = join(homedir(), ".claude", "projects", slug);

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const jsonlFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name);

    if (jsonlFiles.length === 0) {
      return null;
    }

    // Stat all files to find the newest by mtime
    const fileStats = await Promise.all(
      jsonlFiles.map(async (name) => ({
        name,
        stat: await fs.stat(join(projectsDir, name)),
      })),
    );

    // Sort by mtime descending
    fileStats.sort((a, b) => (b.stat.mtime?.getTime() ?? 0) - (a.stat.mtime?.getTime() ?? 0));

    const newestFile = fileStats[0]?.name;
    if (!newestFile) {
      return null;
    }

    // Extract UUID from filename (remove .jsonl extension)
    const uuid = newestFile.replace(/\.jsonl$/, "");
    return uuid;
  } catch (err) {
    // ENOENT or permission denied — no chats for this slug
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // Re-throw other errors (permission, I/O, etc.)
    throw err;
  }
}
