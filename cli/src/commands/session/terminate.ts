import { Command } from "commander";
import { daemonDelete } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { getVSTSession } from "../../lib/env.js";
import { die, success } from "../../lib/output.js";

export function registerSessionTerminate(session: Command): void {
  session
    .command("terminate [id]")
    .description("Terminate a session (defaults to your own session, $VST_SESSION, if no id is given)")
    .action(async (id: string | undefined) => {
      const targetId = id ?? getVSTSession();
      if (!targetId) {
        die("No session id given and $VST_SESSION is not set — pass an id explicitly.");
      }

      await preflight();

      const result = await daemonDelete<void>(`/sessions/${targetId}`);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      success(`Session terminated: ${targetId}`);
    });
}
