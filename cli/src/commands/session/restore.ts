import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die, success } from "../../lib/output.js";
import ora from "ora";

export function registerSessionRestore(session: Command): void {
  session
    .command("restore <id>")
    .description("Restore a stopped session")
    .action(async (id: string) => {
      await preflight();

      const spinner = ora("Restoring session...").start();

      try {
        const result = await daemonPost<{ id: string }>(
          `/sessions/${id}/resume`
        );

        spinner.stop();

        if (!result.ok) {
          die(result.error, result.status === 404 ? 2 : 1);
        }

        success(`Session restored: ${id}`);
      } catch (err) {
        spinner.fail();
        throw err;
      }
    });
}
