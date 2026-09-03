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
    .description(
      "Print recent output — pane text (tmux/pty) or assistant prose (Rich Chat); " +
        "not an event log (see `session transcript` for that)",
    )
    .option("--lines <n>", "Last N lines", "100")
    .action(async (id: string, opts: { lines?: string }) => {
      await preflight();

      const result = await daemonGet<SessionOutput>(
        `/sessions/${id}/output?lines=${opts.lines || 100}`
      );

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      console.log(result.data.output);
    });
}
