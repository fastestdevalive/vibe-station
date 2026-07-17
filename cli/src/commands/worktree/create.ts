import { Command, Option } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { resolveFileOrInline } from "../../lib/text-source.js";
import { die } from "../../lib/output.js";
import ora from "ora";

interface WorktreeCreateResponse {
  id: string;
  branch: string;
  projectId: string;
}

export function registerWorktreeCreate(worktree: Command): void {
  worktree
    .command("create <projectId>")
    .description("Create a new worktree")
    .option("--mode <id>", "Mode ID (required)", "")
    .option("--name <name>", "Worktree name")
    .option("--base <branch>", "Base branch")
    .option("--branch <name>", "New branch name")
    .option("--prompt <text>", "Initial prompt")
    .addOption(
      new Option("--prompt-file <path>", "Read prompt from file").conflicts("prompt")
    )
    .action(
      async (
        projectId: string,
        // Keys must match commander's camelCased option names (--prompt-file → promptFile).
        // Spelling them with dashes here type-checks but reads a property that never exists.
        opts: {
          mode: string;
          name?: string;
          base?: string;
          branch?: string;
          prompt?: string;
          promptFile?: string;
        }
      ) => {
        if (!opts.mode) {
          die("--mode is required", 1);
        }

        const prompt = resolveFileOrInline(opts.prompt, opts.promptFile, "--prompt-file");

        await preflight();

        const spinner = ora("Creating worktree...").start();

        try {
          const result = await daemonPost<WorktreeCreateResponse>(
            "/worktrees",
            {
              projectId,
              modeId: opts.mode,
              name: opts.name,
              baseBranch: opts.base,
              branch: opts.branch,
              prompt,
            }
          );

          spinner.stop();

          if (!result.ok) {
            die(result.error, result.status === 404 ? 2 : 1);
          }

          console.log(`Created worktree: ${result.data.branch}`);
          console.log(result.data.id);
        } catch (err) {
          spinner.fail();
          throw err;
        }
      }
    );
}
