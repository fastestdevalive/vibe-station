import { Command } from "commander";
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDaemonUrl } from "../../lib/daemon-url.js";
import { die, warn } from "../../lib/output.js";
import { daemonLogPath } from "../../lib/paths.js";
import ora from "ora";

const here = dirname(fileURLToPath(import.meta.url));
// dist/commands/daemon/start.js → ../../daemon/main.js
const DAEMON_MAIN = join(here, "..", "..", "daemon", "main.js");

export function registerDaemonStart(daemon: Command): void {
  daemon
    .command("start")
    .description("Start the daemon")
    .action(async () => {
      const existingUrl = getDaemonUrl();
      if (existingUrl) {
        try {
          const response = await fetch(`${existingUrl}/health`);
          if (response.ok) {
            warn("Daemon is already running");
            return;
          }
        } catch {
          // Daemon not reachable, proceed with start
        }
      }

      const spinner = ora("Starting daemon...").start();

      try {
        // Open the log file (append) and redirect daemon stdout + stderr there
        // so post-mortem and live debugging are possible (`tail -f`).
        const logPath = daemonLogPath();
        mkdirSync(dirname(logPath), { recursive: true });
        const logFd = openSync(logPath, "a");

        const child = spawn(process.execPath, [DAEMON_MAIN], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.unref();

        // Poll until /health responds (up to 5 s)
        const deadline = Date.now() + 5000;
        let started = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          const url = getDaemonUrl();
          if (!url) continue;
          try {
            const res = await fetch(`${url}/health`);
            if (res.ok) {
              started = true;
              break;
            }
          } catch {
            // not ready yet
          }
        }

        if (started) {
          const url = getDaemonUrl() ?? "";
          spinner.succeed(`Daemon started at ${url}`);
          console.log(`  Logs: ${logPath}`);
        } else {
          spinner.fail("Daemon did not become healthy within 5 s");
          die(`Daemon start timed out. Check ${logPath} for details.`, 1);
        }
      } catch (err) {
        spinner.fail();
        throw err;
      }
    });
}
