import { Command, Option } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { resolveFileOrInline } from "../../lib/text-source.js";
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
    .addOption(
      new Option("--context-file <path>", "Read context from file").conflicts("context")
    )
    .option("--preset <preset>", "Preset name")
    .action(
      // Keys must match commander's camelCased option names (--context-file → contextFile).
      // Spelling them with dashes here type-checks but reads a property that never exists.
      async (opts: {
        name: string;
        cli: string;
        context?: string;
        contextFile?: string;
        preset?: string;
      }) => {
        if (!opts.name) {
          die("--name is required", 1);
        }
        if (!opts.cli) {
          die("--cli is required", 1);
        }

        const context = resolveFileOrInline(opts.context, opts.contextFile, "--context-file");

        await preflight();

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
