import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die, success } from "../../lib/output.js";

interface HandoffResponse {
  ok: true;
  handoffSummary: string | null;
}

export function registerSessionHandoff(session: Command): void {
  session
    .command("handoff <id>")
    .description("Generate a handoff summary for a session")
    .action(async (id: string) => {
      await preflight();

      const result = await daemonPost<HandoffResponse>(
        `/sessions/${encodeURIComponent(id)}/handoff`
      );

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      if (result.data.handoffSummary) {
        success(result.data.handoffSummary);
      } else {
        success("No handoff summary was produced.");
      }
    });
}
