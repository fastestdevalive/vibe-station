import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { readFileSync } from "fs";
import { die } from "../../lib/output.js";
import ora from "ora";

interface WorktreeCreateResponse {
  id: string;
  name: string;
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
    .option("--prompt-file <path>", "Read prompt from file")
    .action(
      async (
        projectId: string,
        opts: {
          mode: string;
          name?: string;
          base?: string;
          branch?: string;
          prompt?: string;
          "prompt-file"?: string;
        }
      ) => {
        if (!opts.mode) {
          die("--mode is required", 1);
        }

        await preflight();

        let prompt = opts.prompt;
        if (opts["prompt-file"]) {
          prompt = readFileSync(opts["prompt-file"], "utf-8");
        }

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

          console.log(`Created worktree: ${result.data.name}`);
          console.log(result.data.id);
        } catch (err) {
          spinner.fail();
          throw err;
        }
      }
    );
}
