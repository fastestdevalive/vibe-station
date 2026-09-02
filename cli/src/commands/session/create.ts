import { Command, Option } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { resolveFileOrInline } from "../../lib/text-source.js";
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
    .option("--json", "Use the JSON agent-chat channel (channel: json)")
    .option(
      "--parent <sessionId>",
      "SessionId this session was spawned from (defaults to $VST_SESSION when this CLI is invoked from inside a running agent's own shell)",
    )
    .option(
      "--source-agent <sessionId>",
      "Alias of --parent (legacy name; still supported for external callers)",
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
          json?: boolean;
          parent?: string;
          sourceAgent?: string;
        }
      ) => {
        // The daemon only consumes `prompt` for agent sessions (routes/sessions.ts:420) — a
        // terminal session would accept it over the wire and drop it on the floor. Same silent
        // loss as the --prompt-file bug, so refuse it up front.
        if ((opts.prompt || opts.promptFile) && opts.type !== "agent") {
          die(`--prompt/--prompt-file only apply to --type=agent (got --type=${opts.type})`, 1);
        }

        const prompt = resolveFileOrInline(opts.prompt, opts.promptFile, "--prompt-file");

        await preflight();

        const spinner = ora("Creating session...").start();

        // Same defaulting rule as `vst worktree create` (agent-interaction-
        // workspaces/04-workspaces Phase 4b, S3) — see that command for the
        // full rationale. `--parent` and `--source-agent` are the same flag
        // (Decision 15); `--parent` wins if somehow both are passed.
        //
        // Test truthiness, not nullishness (Decision 3): an agent never
        // passes either flag and instead relies on $VST_SESSION — warning
        // here is reserved for a caller who passed the flag explicitly and
        // it resolved blank (e.g. `--source-agent ""`), not for an unset
        // $VST_SESSION in a plain human terminal.
        const explicitParent = opts.parent ?? opts.sourceAgent;
        const explicitlyPassed = opts.parent !== undefined || opts.sourceAgent !== undefined;
        let sourceAgentId: string | undefined;
        if (explicitlyPassed) {
          sourceAgentId = explicitParent || undefined;
          if (!sourceAgentId) {
            console.warn(
              "Warning: --parent/--source-agent was passed but resolved to an empty value — creating the session unlinked.",
            );
          }
        } else {
          sourceAgentId = process.env.VST_SESSION || undefined;
        }

        try {
          const result = await daemonPost<SessionCreateResponse>("/sessions", {
            worktreeId,
            type: opts.type,
            modeId: opts.mode,
            prompt,
            ...(opts.json ? { channel: "json" } : {}),
            ...(sourceAgentId ? { sourceAgentId } : {}),
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
