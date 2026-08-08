import { Command } from "commander";
import { daemonPatch } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die, success } from "../../lib/output.js";

interface RenameResponse {
  ok: true;
  name: string | null;
}

export function registerSessionRename(session: Command): void {
  session
    .command("rename <id> <name>")
    .description("Rename a session")
    .action(async (id: string, name: string) => {
      await preflight();

      const result = await daemonPatch<RenameResponse>(
        `/sessions/${encodeURIComponent(id)}/rename`,
        { name }
      );

      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      if (result.data.name === null) {
        success("Name cleared");
      } else {
        success(`Renamed to: ${result.data.name}`);
      }
    });
}
