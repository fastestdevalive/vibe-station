import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die, success } from "../../lib/output.js";

interface ResetResponse {
  ok: true;
  archivedSessionId: string;
  newSessionId: string;
}

export function registerSessionReset(session: Command): void {
  session
    .command("reset <id>")
    .description("Reset a session")
    .option("--handoff", "Generate a handoff summary before reset")
    .option("--prompt <text>", "Custom prompt for the new session")
    .action(
      async (
        id: string,
        opts: { handoff?: boolean; prompt?: string }
      ) => {
        await preflight();

        const result = await daemonPost<ResetResponse>(
          `/sessions/${encodeURIComponent(id)}/reset`,
          {
            handoff: opts.handoff,
            prompt: opts.prompt,
          }
        );

        if (!result.ok) {
          die(result.error, result.status === 404 ? 2 : 1);
        }

        success(`Archived: ${result.data.archivedSessionId}, New: ${result.data.newSessionId}`);
      }
    );
}
