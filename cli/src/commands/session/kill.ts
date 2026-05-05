import { Command } from "commander";
import { daemonDelete } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die, success } from "../../lib/output.js";

export function registerSessionKill(session: Command): void {
  session
    .command("kill <id>")
    .description("Kill a session")
    .action(async (id: string) => {
      await preflight();

      const result = await daemonDelete<void>(`/sessions/${id}`);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      success(`Session killed: ${id}`);
    });
}
