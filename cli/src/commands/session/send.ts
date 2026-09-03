import { Command } from "commander";
import { preflight } from "../../lib/preflight.js";
import { runSend, type SendOptions } from "../../lib/sendMessage.js";

/**
 * D1/D5/D6/D8 — the single channel-agnostic verb for messaging a session.
 */
export function registerSessionSend(session: Command): void {
  session
    .command("send <id> [message...]")
    .description(
      "Send a message to a session (channel-agnostic). Steers a running Rich Chat turn by " +
        "default; --queue opts out and enqueues instead.",
    )
    .option("--file <path>", "Read message from file")
    .option(
      "--attach <path>",
      "Attach a file to a Rich Chat turn (repeatable; json sessions only)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option("--queue", "Enqueue instead of steering a running Rich Chat turn (also skips --wait reply printing)")
    // Order matters: commander only accepts an explicit `--wait` alongside
    // `--no-wait` when `--no-wait` is registered FIRST — declaring `--no-wait`
    // alone makes commander reject `--wait` as an unknown option, and every
    // doc this command ships with (README, skill/SKILL.md,
    // agent-system-prompt.md) teaches `--wait` explicitly, including to
    // spawned agents that follow it verbatim.
    .option("--no-wait", "Do not wait for the session to settle (skips reply printing)")
    .option("--wait", "Wait for the session to settle and print the reply (default)")
    .option("--timeout <ms>", "Max wait time in ms", "60000")
    .action(async (id: string, message: string[], opts: SendOptions) => {
      await preflight();
      await runSend(id, message, opts);
    });
}
