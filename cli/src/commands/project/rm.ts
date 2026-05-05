import { Command } from "commander";
import { daemonDelete } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { confirmByTypingName } from "../../lib/confirm.js";
import { die, success } from "../../lib/output.js";

export function registerProjectRm(project: Command): void {
  project
    .command("rm <id>")
    .description("Remove a project")
    .action(async (id: string) => {
      await preflight();
      await confirmByTypingName(
        id,
        `This will delete project "${id}" and all its worktrees/sessions.`
      );

      const result = await daemonDelete<void>(`/projects/${id}`);

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      success(`Project removed: ${id}`);
    });
}
