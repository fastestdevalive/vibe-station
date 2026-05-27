import { Command } from "commander";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { success, warn } from "../../lib/output.js";

/** Outcome of a stop attempt. `notRunning` lets `restart` skip the warn-log
 *  noise when there's nothing to stop, since restart-on-fresh-host is fine. */
export type StopResult = "stopped" | "notRunning" | "noConfig";

/**
 * Send SIGTERM to the recorded daemon pid and wait until the process is
 * actually gone before returning. Used by both `vst daemon stop` and `vst
 * daemon restart` — restart depends on the wait so the new daemon doesn't
 * race the old one for the port.
 */
export async function stopDaemon(): Promise<StopResult> {
  let config: { port?: number; pid?: number };
  try {
    const configPath = join(homedir(), ".vibe-station", "config.json");
    const content = readFileSync(configPath, "utf-8");
    config = JSON.parse(content) as { port?: number; pid?: number };
  } catch {
    return "noConfig";
  }

  if (!config.pid) return "notRunning";

  try {
    process.kill(config.pid, "SIGTERM");
  } catch (err) {
    // Only ESRCH means the process is gone. EPERM means it exists but we
    // can't signal it (wrong-user scenario) — surface that as a different
    // failure so `restart` doesn't proceed thinking it has a clean port.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "notRunning";
    throw err;
  }

  // Poll with `kill(pid, 0)` (no signal — just checks liveness) until the
  // process is gone or a 5 s budget elapses. A fixed 1 s sleep wasn't enough
  // for `restart` — the daemon could still be holding the port when `start`
  // ran.
  const deadline = Date.now() + 5000;
  const pid = config.pid;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return "stopped";
      // EPERM here means it's still alive but unsignaable — keep polling so we
      // don't falsely report success.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Didn't exit cleanly within the budget — force-kill so restart can proceed.
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* nothing to do */
  }
  return "stopped";
}

export function registerDaemonStop(daemon: Command): void {
  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      const result = await stopDaemon();
      if (result === "stopped") success("Daemon stopped");
      else if (result === "notRunning") warn("Daemon process not found or already stopped");
      else warn("Daemon config not found");
    });
}
