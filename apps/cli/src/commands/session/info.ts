import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { printJson, die } from "../../lib/output.js";

interface Session {
  id: string;
  worktreeId: string;
  type: string;
  state: string;
  createdAt?: string;
  tmuxName?: string;
}

export function registerSessionInfo(session: Command): void {
  session
    .command("info <id>")
    .description("Get session info")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      await preflight();

      const result = await daemonGet<Session>(`/sessions/${id}`);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      if (opts.json) {
        printJson(result.data);
      }

      console.log(`Session: ${result.data.id}`);
      console.log(`Worktree: ${result.data.worktreeId}`);
      console.log(`Type: ${result.data.type}`);
      console.log(`State: ${result.data.state}`);
      if (result.data.tmuxName) {
        console.log(`Tmux: ${result.data.tmuxName}`);
      }
      if (result.data.createdAt) {
        console.log(`Created: ${result.data.createdAt}`);
      }
    });
}
