import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { printJson, printTable, die } from "../../lib/output.js";

interface Session {
  id: string;
  worktreeId: string;
  type: string;
  state: string;
  createdAt?: string;
}

export function registerSessionLs(session: Command): void {
  session
    .command("ls")
    .description("List all sessions")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      await preflight();

      const result = await daemonGet<Session[]>("/sessions");

      if (!result.ok) {
        die(result.error, 1);
      }

      if (opts.json) {
        printJson(result.data);
      }

      const rows = result.data.map((s) => [s.id, s.worktreeId, s.type, s.state]);

      printTable(["ID", "Worktree", "Type", "State"], rows);
    });
}
