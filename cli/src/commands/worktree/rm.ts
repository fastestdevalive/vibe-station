import { Command } from "commander";
import prompts from "prompts";
import { daemonDelete } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { confirmByTypingName } from "../../lib/confirm.js";
import { die, success } from "../../lib/output.js";

export function registerWorktreeRm(worktree: Command): void {
  worktree
    .command("rm <id>")
    .description("Remove a worktree (sessions terminated; files kept unless --purge)")
    .option("--purge", "Also delete the git worktree directory from disk")
    .action(async (id: string, opts: { purge?: boolean }) => {
      await preflight();
      const msg = opts.purge
        ? `This will PERMANENTLY delete worktree "${id}", terminate its sessions, and remove files from disk.`
        : `This will remove worktree "${id}" from vst and terminate its sessions. Files stay on disk.`;
      await confirmByTypingName(id, msg);

      let shouldPurge = Boolean(opts.purge);
      if (!opts.purge) {
        const ans = await prompts({
          type: "confirm",
          name: "doPurge",
          message: "Also delete files from disk?",
          initial: false,
        });
        if (ans.doPurge === undefined) die("Cancelled.", 1);
        shouldPurge = Boolean(ans.doPurge);
      }

      const url = shouldPurge ? `/worktrees/${id}?purge=true` : `/worktrees/${id}`;
      const result = await daemonDelete<void>(url);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      success(
        shouldPurge ? `Worktree purged: ${id}` : `Worktree removed (files kept on disk): ${id}`,
      );
    });
}
