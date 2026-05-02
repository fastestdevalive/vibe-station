import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die } from "../../lib/output.js";

interface SessionOutput {
  id: string;
  output: string;
}

export function registerSessionOutput(session: Command): void {
  session
    .command("output <id>")
    .description("Get session output")
    .option("--lines <n>", "Last N lines", "100")
    .option("--follow", "Follow output")
    .action(async (id: string, opts: { lines?: string; follow?: boolean }) => {
      await preflight();

      const result = await daemonGet<SessionOutput>(
        `/sessions/${id}/output?lines=${opts.lines || 100}`
      );

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      console.log(result.data.output);

      if (opts.follow) {
        // TODO: implement WebSocket follow mode
        console.log("(--follow not yet implemented)");
      }
    });
}
