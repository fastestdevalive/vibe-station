import { Command } from "commander";
import { daemonGet } from "../lib/daemon-client.js";
import { preflight } from "../lib/preflight.js";
import { getVSTProject } from "../lib/env.js";
import { printJson, die } from "../lib/output.js";
import chalk from "chalk";

interface Session {
  id: string;
  worktreeId: string;
  state: string;
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show daemon and session status")
    .option("--project <id>", "Filter by project")
    .option("--json", "Output JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
      await preflight();

      const projectId = opts.project || getVSTProject();
      const query = projectId ? `?project=${projectId}` : "";

      const result = await daemonGet<Session[]>(`/sessions${query}`);

      if (!result.ok) {
        die(result.error, 1);
      }

      if (opts.json) {
        printJson(result.data);
      }

      if (result.data.length === 0) {
        console.log("No active sessions");
        return;
      }

      for (const session of result.data) {
        const stateIcon =
          session.state === "idle"
            ? chalk.green("●")
            : session.state === "running"
              ? chalk.yellow("●")
              : session.state === "error"
                ? chalk.red("●")
                : chalk.dim("●");

        console.log(`${stateIcon} ${session.id} (${session.state})`);
      }
    });
}
