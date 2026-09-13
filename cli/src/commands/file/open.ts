import { Command } from "commander";
import { resolve } from "node:path";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die } from "../../lib/output.js";

export function registerFileOpen(file: Command): void {
  file
    .command("open <worktreeId> <path>")
    .description("Open a file in the vibe-station UI for the given worktree")
    .action(async (worktreeId: string, filePath: string) => {
      await preflight();
      const absPath = resolve(filePath);
      const result = await daemonPost<{ ok: boolean }>(
        `/worktrees/${worktreeId}/open-file`,
        { path: absPath },
      );
      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }
      console.log(JSON.stringify(result.data));
    });
}
