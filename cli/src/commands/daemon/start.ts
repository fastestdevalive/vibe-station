import { Command } from "commander";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDaemonUrl } from "../../lib/daemon-url.js";
import { die, warn } from "../../lib/output.js";
import { daemonLogPath } from "../../lib/paths.js";
import ora from "ora";

const here = dirname(fileURLToPath(import.meta.url));
// dist/commands/daemon/start.js → ../../daemon/main.js
const DAEMON_MAIN = join(here, "..", "..", "daemon", "main.js");

/** Outcome of a start attempt. */
export type StartResult =
  | { kind: "started"; url: string; logPath: string }
  | { kind: "alreadyRunning"; url: string }
  | { kind: "timedOut"; logPath: string };

/**
 * Spawn a detached daemon process and poll /health until it responds.
 * Shared between `vst daemon start` and `vst daemon restart`.
 */
export async function startDaemon(): Promise<StartResult> {
  // If something is already healthy on the recorded port, don't double-spawn.
  const existingUrl = getDaemonUrl();
  if (existingUrl) {
    try {
      const response = await fetch(`${existingUrl}/health`);
      if (response.ok) return { kind: "alreadyRunning", url: existingUrl };
    } catch {
      // Not reachable — proceed with spawn.
    }
  }

  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");

  let spawnError: NodeJS.ErrnoException | null = null;
  const child = spawn(process.execPath, [DAEMON_MAIN], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  // Without this, a spawn failure (e.g. ENOENT when DAEMON_MAIN is missing
  // because the CLI bundle wasn't built) surfaces only as a 5 s health-check
  // timeout — useless for diagnosis.
  child.on("error", (err) => {
    spawnError = err as NodeJS.ErrnoException;
  });
  // The child has inherited logFd; we don't need our copy in the parent. Leaks
  // a real fd otherwise — minor but uncapped over many starts.
  closeSync(logFd);

  // Poll until /health responds (up to 5 s).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (spawnError) return { kind: "timedOut", logPath };
    await new Promise((r) => setTimeout(r, 200));
    const url = getDaemonUrl();
    if (!url) continue;
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return { kind: "started", url, logPath };
    } catch {
      // not ready yet
    }
  }
  return { kind: "timedOut", logPath };
}

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
        const result = await startDaemon();
        if (result.kind === "started") {
          spinner.succeed(`Daemon started at ${result.url}`);
          console.log(`  Logs: ${result.logPath}`);
        } else if (result.kind === "alreadyRunning") {
          spinner.info(`Daemon already running at ${result.url}`);
        } else {
          spinner.fail("Daemon did not become healthy within 5 s");
          die(`Daemon start timed out. Check ${result.logPath} for details.`, 1);
        }
      } catch (err) {
        spinner.fail();
        throw err;
      }
    });
}
