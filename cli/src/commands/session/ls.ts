import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { printJson, printTable, die } from "../../lib/output.js";

interface Session {
  id: string;
  worktreeId: string;
  type: string;
  state: string;
  name?: string | null;
  createdAt?: string;
}

export function registerSessionLs(session: Command): void {
  session
    .command("ls")
    .description("List all sessions")
    .option("--worktree <id>", "Filter by worktree")
    .option("--name <name>", "Filter by exact session name")
    .option("--json", "Output JSON")
    .action(async (opts: { worktree?: string; name?: string; json?: boolean }) => {
      await preflight();

      const query = opts.worktree ? `?worktree=${encodeURIComponent(opts.worktree)}` : "";
      const result = await daemonGet<Session[]>(`/sessions${query}`);

      if (!result.ok) {
        die(result.error, 1);
      }

      const filtered = opts.name ? result.data.filter((s) => s.name === opts.name) : result.data;

      if (opts.json) {
        printJson(filtered); // never returns — process.exit(0) inside (output.ts:3-6)
        return; // unreachable at runtime; kept for readable control flow / lint-friendliness
      }

      const rows = filtered.map((s) => [s.id, s.worktreeId, s.type, s.state]);
      printTable(["ID", "Worktree", "Type", "State"], rows);
    });
}
