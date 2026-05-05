import { Command } from "commander";
import { daemonPost, daemonGet } from "../lib/daemon-client.js";
import { preflight } from "../lib/preflight.js";
import { readFileSync } from "fs";
import { die, warn } from "../lib/output.js";

interface Session {
  state: string;
}

export function registerSend(program: Command): void {
  program
    .command("send <sessionId> [message...]")
    .description("Send input to a session")
    .option("--file <path>", "Read message from file")
    .option("--wait", "Wait for idle state", true)
    .option("--timeout <ms>", "Max wait time in ms", "60000")
    .action(
      async (
        sessionId: string,
        message: string[],
        opts: { file?: string; wait?: boolean; timeout?: string }
      ) => {
        await preflight();

        let content = message.join(" ");
        if (opts.file) {
          content = readFileSync(opts.file, "utf-8");
        }

        const result = await daemonPost<{ ok: boolean }>(
          `/sessions/${sessionId}/input`,
          {
            data: content,
            sendEnter: true,
          }
        );

        if (!result.ok) {
          die(result.error, result.status === 404 ? 2 : 1);
        }

        if (opts.wait) {
          const timeout = parseInt(opts.timeout || "60000", 10);
          const startTime = Date.now();
          const pollInterval = 500;

          while (Date.now() - startTime < timeout) {
            const statusResult = await daemonGet<Session>(
              `/sessions/${sessionId}`
            );

            if (!statusResult.ok) {
              die(
                statusResult.error,
                statusResult.status === 404 ? 2 : 1
              );
            }

            if (statusResult.data.state === "idle") {
              return;
            }

            await new Promise((resolve) =>
              setTimeout(resolve, pollInterval)
            );
          }

          warn("Session did not return to idle state within timeout");
        }
      }
    );
}
