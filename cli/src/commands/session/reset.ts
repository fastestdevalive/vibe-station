import { Command, Option } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { resolveFileOrInline } from "../../lib/text-source.js";
import { die, success } from "../../lib/output.js";

interface ResetResponse {
  ok: true;
  archivedSessionId: string;
  newSessionId: string;
}

export function registerSessionReset(session: Command): void {
  session
    .command("reset <id>")
    .description("Reset a session")
    .option("--handoff", "Generate a handoff summary before reset")
    .option("--prompt <text>", "Custom prompt for the new session")
    .option("--mode <name-or-id>", "Switch to a different mode/CLI on reset")
    .addOption(
      new Option("--handoff-file <path>", "Read a handoff summary from file").conflicts("handoff")
    )
    .action(
      async (
        id: string,
        // Keys must match commander's camelCased option names (--handoff-file → handoffFile).
        opts: { handoff?: boolean; prompt?: string; handoffFile?: string; mode?: string }
      ) => {
        // The CLI is the only party that knows it's running INSIDE the target session — the
        // daemon can't distinguish this caller from the UI. `--handoff` here can never work: the
        // agent is blocked on this very shell command, so it can never see anything pasted back
        // into its own pane. Reject locally instead of burning a guaranteed-useless 60s poll.
        if (opts.handoff && process.env.VST_SESSION && process.env.VST_SESSION === id) {
          die(
            `Cannot use --handoff on the session you are running inside (${id}). ` +
              `You are blocked on this command, so the daemon cannot ask you for a summary. ` +
              `Instead: write your handoff summary to any file, then run ` +
              `\`vst session reset ${id} --handoff-file <path>\` (not --handoff). ` +
              `The \`/vst reset --handoff\` in-chat command does exactly this.`
          );
        }

        const handoffText = resolveFileOrInline(undefined, opts.handoffFile, "--handoff-file");

        await preflight();

        const result = await daemonPost<ResetResponse>(
          `/sessions/${encodeURIComponent(id)}/reset`,
          {
            handoff: opts.handoff,
            prompt: opts.prompt,
            handoffText,
            // Sent as-is — the daemon resolves either a mode id or a mode
            // name (resolveModeId), same as `session create --mode` already does.
            modeId: opts.mode,
          }
        );

        if (!result.ok) {
          die(result.error, result.status === 404 ? 2 : 1);
        }

        success(`Archived: ${result.data.archivedSessionId}, New: ${result.data.newSessionId}`);
      }
    );
}
