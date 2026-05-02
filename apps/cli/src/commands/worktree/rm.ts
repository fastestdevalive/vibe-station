import { Command } from "commander";
import { daemonDelete } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { confirmByTypingName } from "../../lib/confirm.js";
import { die, success } from "../../lib/output.js";

export function registerWorktreeRm(worktree: Command): void {
  worktree
    .command("rm <id>")
    .description("Remove a worktree")
    .action(async (id: string) => {
      await preflight();
      await confirmByTypingName(
        id,
        `This will delete worktree "${id}" and terminate its session.`
      );

      const result = await daemonDelete<void>(`/worktrees/${id}`);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      success(`Worktree removed: ${id}`);
    });
}
