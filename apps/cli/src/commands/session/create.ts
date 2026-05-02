import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { readFileSync } from "fs";
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
    .option("--prompt-file <path>", "Read prompt from file")
    .action(
      async (
        worktreeId: string,
        opts: {
          type: string;
          mode?: string;
          prompt?: string;
          "prompt-file"?: string;
        }
      ) => {
        await preflight();

        let prompt = opts.prompt;
        if (opts["prompt-file"]) {
          prompt = readFileSync(opts["prompt-file"], "utf-8");
        }

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
