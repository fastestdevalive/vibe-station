import { Command } from "commander";
import { daemonDelete } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { confirmByTypingName } from "../../lib/confirm.js";
import { die, success } from "../../lib/output.js";

export function registerModeRm(mode: Command): void {
  mode
    .command("rm <id>")
    .description("Remove a mode")
    .action(async (id: string) => {
      await preflight();
      await confirmByTypingName(id, `This will delete mode "${id}".`);

      const result = await daemonDelete<void>(`/modes/${id}`);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      success(`Mode removed: ${id}`);
    });
}
