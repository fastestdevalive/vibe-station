import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { printJson, printTable, die } from "../../lib/output.js";

interface Mode {
  id: string;
  name: string;
  cli?: string;
  preset?: string;
}

export function registerModeLs(mode: Command): void {
  mode
    .command("ls")
    .description("List all modes")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      await preflight();

      const result = await daemonGet<Mode[]>("/modes");

      if (!result.ok) {
        die(result.error, 1);
      }

      if (opts.json) {
        printJson(result.data);
      }

      const rows = result.data.map((m) => [m.id, m.name, m.cli || "", m.preset || ""]);

      printTable(["ID", "Name", "CLI", "Preset"], rows);
    });
}
