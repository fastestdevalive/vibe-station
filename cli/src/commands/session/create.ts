import { Command, Option } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { resolveFileOrInline } from "../../lib/prompt-source.js";
import { die } from "../../lib/output.js";
import ora from "ora";

interface SessionCreateResponse {
  id: string;
  worktreeId: string;
  type: string;
}

export function registerSessionCreate(session: Command): void {
  session
    .command("create <worktreeId>")
    .description("Create a new session")
    .option("--type <type>", "Session type (agent|terminal)", "agent")
    .option("--mode <id>", "Mode ID")
    .option("--prompt <text>", "Initial prompt")
    .addOption(
      new Option("--prompt-file <path>", "Read prompt from file").conflicts("prompt")
    )
    .action(
      async (
        worktreeId: string,
        // Keys must match commander's camelCased option names (--prompt-file → promptFile).
        // Spelling them with dashes here type-checks but reads a property that never exists.
        opts: {
          type: string;
          mode?: string;
          prompt?: string;
          promptFile?: string;
        }
      ) => {
        const prompt = resolveFileOrInline(opts.prompt, opts.promptFile, "--prompt-file");

        await preflight();

        const spinner = ora("Creating session...").start();

        try {
          const result = await daemonPost<SessionCreateResponse>("/sessions", {
            worktreeId,
            type: opts.type,
            modeId: opts.mode,
            prompt,
          });

          spinner.stop();

          if (!result.ok) {
            die(result.error, result.status === 404 ? 2 : 1);
          }

          console.log(`Created session: ${result.data.id}`);
          console.log(result.data.id);
        } catch (err) {
          spinner.fail();
          throw err;
        }
      }
    );
}
