import { Command } from "commander";
import { spawnSync } from "child_process";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die } from "../../lib/output.js";

interface Session {
  id: string;
  tmuxName?: string;
}

export function registerSessionAttach(session: Command): void {
  session
    .command("attach <id>")
    .description("Attach to a session")
    .action(async (id: string) => {
      await preflight();

      const result = await daemonGet<Session>(`/sessions/${id}`);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      if (!result.data.tmuxName) {
        die("Session does not have a tmux target", 1);
      }

      const proc = spawnSync("tmux", ["attach", "-t", result.data.tmuxName], {
        stdio: "inherit",
      });

      process.exit(proc.status ?? 0);
    });
}
