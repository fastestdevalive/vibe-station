import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { printJson, die } from "../../lib/output.js";

interface Project {
  id: string;
  name: string;
  path: string;
  worktreeCount?: number;
  createdAt?: string;
}

export function registerProjectInfo(project: Command): void {
  project
    .command("info <id>")
    .description("Get project info")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      await preflight();

      const result = await daemonGet<Project>(`/projects/${id}`);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      if (opts.json) {
        printJson(result.data);
      }

      console.log(`Project: ${result.data.name} (${result.data.id})`);
      console.log(`Path: ${result.data.path}`);
      console.log(`Worktrees: ${result.data.worktreeCount ?? 0}`);
      if (result.data.createdAt) {
        console.log(`Created: ${result.data.createdAt}`);
      }
    });
}
