import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { readFileSync } from "fs";
import { die, success } from "../../lib/output.js";

interface ModeCreateResponse {
  id: string;
  name: string;
}

export function registerModeAdd(mode: Command): void {
  mode
    .command("add")
    .description("Add a new mode")
    .option("--name <name>", "Mode name (required)", "")
    .option("--cli <cmd>", "CLI command (required)", "")
    .option("--context <text>", "Context text")
    .option("--context-file <path>", "Read context from file")
    .option("--preset <preset>", "Preset name")
    .action(
      async (opts: {
        name: string;
        cli: string;
        context?: string;
        "context-file"?: string;
        preset?: string;
      }) => {
        if (!opts.name) {
          die("--name is required", 1);
        }
        if (!opts.cli) {
          die("--cli is required", 1);
        }

        await preflight();

        let context = opts.context;
        if (opts["context-file"]) {
          context = readFileSync(opts["context-file"], "utf-8");
        }

        const result = await daemonPost<ModeCreateResponse>("/modes", {
          name: opts.name,
          cli: opts.cli,
          context,
          preset: opts.preset,
        });

        if (!result.ok) {
          die(result.error, result.status === 409 ? 3 : 1);
        }

        success(`Mode added: ${result.data.id}`);
        console.log(result.data.id);
      }
    );
}
