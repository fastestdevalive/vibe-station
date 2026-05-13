import { resolve } from "node:path";
import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die, success } from "../../lib/output.js";

interface ProjectAddResponse {
  id: string;
  name: string;
  path: string;
}

export function registerProjectAdd(project: Command): void {
  project
    .command("add <path>")
    .description("Add a new project")
    .option("--name <id>", "Override project ID")
    .option("--prefix <prefix>", "Override project prefix")
    .action(async (path: string, opts: { name?: string; prefix?: string }) => {
      await preflight();

      // Resolve against the CLI's cwd before sending — the daemon runs in a
      // different working directory, so relative paths would otherwise be
      // interpreted against the daemon's cwd and fail.
      const absPath = resolve(path);

      const result = await daemonPost<ProjectAddResponse>("/projects", {
        path: absPath,
        name: opts.name,
        prefix: opts.prefix,
      });

      if (!result.ok) {
        if (result.status === 409) {
          die(`${result.error}\nHint: ${result.conflictWith}`, 3);
        }
        die(result.error, result.status === 404 ? 2 : 1);
      }

      success(`Project added: ${result.data.id}`);
      console.log(result.data.id);
    });
}
