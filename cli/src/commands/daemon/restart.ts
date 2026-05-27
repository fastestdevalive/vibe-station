import { Command } from "commander";
import ora from "ora";
import { die } from "../../lib/output.js";
import { startDaemon } from "./start.js";
import { stopDaemon } from "./stop.js";

export function registerDaemonRestart(daemon: Command): void {
  daemon
    .command("restart")
    .description("Restart the daemon")
    .action(async () => {
      const stopSpinner = ora("Stopping daemon...").start();
      const stopResult = await stopDaemon();
      if (stopResult === "stopped") stopSpinner.succeed("Daemon stopped");
      else if (stopResult === "notRunning") stopSpinner.info("No running daemon to stop");
      else stopSpinner.info("No daemon config — starting fresh");

      const startSpinner = ora("Starting daemon...").start();
      const startResult = await startDaemon();
      if (startResult.kind === "started") {
        startSpinner.succeed(`Daemon started at ${startResult.url}`);
        console.log(`  Logs: ${startResult.logPath}`);
      } else if (startResult.kind === "alreadyRunning") {
        // After a successful stop we should always start fresh. If we land
        // here something else is alive on the port (stop didn't take effect,
        // or another daemon raced in). Fail loudly — better than silently
        // leaving the user pointed at a stale process.
        startSpinner.fail(`Daemon already running at ${startResult.url} after stop — stop did not take effect`);
        die("Restart aborted; investigate the lingering process.", 1);
      } else {
        startSpinner.fail("Daemon did not become healthy within 5 s");
        die(`Daemon start timed out. Check ${startResult.logPath} for details.`, 1);
      }
    });
}
