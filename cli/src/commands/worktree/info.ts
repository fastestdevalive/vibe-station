import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { printJson, die } from "../../lib/output.js";

interface Worktree {
  id: string;
  name: string;
  projectId: string;
  sessionCount?: number;
  createdAt?: string;
  branch?: string;
}

export function registerWorktreeInfo(worktree: Command): void {
  worktree
    .command("info <id>")
    .description("Get worktree info")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      await preflight();

      const result = await daemonGet<Worktree>(`/worktrees/${id}`);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      if (opts.json) {
        printJson(result.data);
      }

      console.log(`Worktree: ${result.data.name} (${result.data.id})`);
      console.log(`Project: ${result.data.projectId}`);
      console.log(`Sessions: ${result.data.sessionCount ?? 0}`);
      if (result.data.branch) {
        console.log(`Branch: ${result.data.branch}`);
      }
      if (result.data.createdAt) {
        console.log(`Created: ${result.data.createdAt}`);
      }
    });
}
