/**
 * cursor — NATIVE chat-id resolution (`native-chat-id/` — see the block comment
 * above `AgentPlugin.captureNativeChatId` in `daemon/src/services/spawn.ts`
 * for the two-identity model, and `docs/AGENT-CHAT-ID-CAPTURE.md` for the
 * per-CLI strategy matrix).
 *
 * cursor's strategy is **unavailable**: no bridge exists from an ACP session id
 * to a native chat id (`cursor-agent acp` persists its sessions in a separate
 * SQLite store the raw CLI's `--resume` cannot read), which is why `cursor.ts`
 * returns `supportsJsonToTerminalResume() === false`. This file is the CWD-KEYED
 * best-effort fallback both paths still use — the terminal restore path
 * (`getRestoreCommand`) and, on a best-effort basis only, `captureNativeChatId`.
 * It finds "the newest chat in this workspace", which is the right answer for a
 * terminal-started session and merely a plausible guess for an ACP one.
 *
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
