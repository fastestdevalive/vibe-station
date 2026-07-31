import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die, success } from "../../lib/output.js";

export function registerWorktreeDone(worktree: Command): void {
  worktree
    .command("done <id>")
    .description("Mark all agent sessions done and release the worktree's tmux/agent processes")
    .action(async (id: string) => {
      await preflight();
      const result = await daemonPost<{ ok: true; updated: number; terminalsReleased: number }>(
        `/worktrees/${encodeURIComponent(id)}/done`,
      );
      if (!result.ok) die(result.error, result.status === 404 ? 2 : 1);
      const { updated, terminalsReleased } = result.data;
      success(
        `Worktree marked as done: ${id} ` +
          `(${updated} agent session(s) done, ${terminalsReleased} terminal(s) released)`,
      );
    });
}
