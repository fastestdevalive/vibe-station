import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { getVSTProject } from "../../lib/env.js";
import { printJson, printTable, die } from "../../lib/output.js";

interface Worktree {
  id: string;
  name: string;
  projectId: string;
  sessionCount?: number;
  createdAt?: string;
}

export function registerWorktreeLs(worktree: Command): void {
  worktree
    .command("ls")
    .description("List worktrees")
    .option("--project <id>", "Filter by project")
    .option("--json", "Output JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
      await preflight();

      const projectId = opts.project || getVSTProject();
      const query = projectId ? `?project=${projectId}` : "";

      const result = await daemonGet<Worktree[]>(`/worktrees${query}`);

      if (!result.ok) {
        die(result.error, 1);
      }

      if (opts.json) {
        printJson(result.data);
      }

      const rows = result.data.map((w) => [
        w.id,
        w.name,
        w.projectId,
        String(w.sessionCount ?? 0),
      ]);

      printTable(["ID", "Name", "Project", "Sessions"], rows);
    });
}
