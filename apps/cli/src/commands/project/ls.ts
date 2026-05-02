import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { printJson, printTable, die } from "../../lib/output.js";

interface Project {
  id: string;
  name: string;
  path: string;
  worktreeCount?: number;
}

export function registerProjectLs(project: Command): void {
  project
    .command("ls")
    .description("List all projects")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      await preflight();

      const result = await daemonGet<Project[]>("/projects");

      if (!result.ok) {
        die(result.error, 1);
      }

      if (opts.json) {
        printJson(result.data);
      }

      const rows = result.data.map((p) => [
        p.id,
        p.name,
        p.path,
        String(p.worktreeCount ?? 0),
      ]);

      printTable(["ID", "Name", "Path", "Worktrees"], rows);
    });
}
