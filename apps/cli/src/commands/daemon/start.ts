import { Command } from "commander";
import { getDaemonUrl } from "../../lib/daemon-url.js";
import { die, warn } from "../../lib/output.js";
import ora from "ora";

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
        // For now, we'll just note that the daemon should be started separately
        // In a real implementation, this would spawn the daemon server process
        spinner.fail("Daemon server not yet implemented");
        die("Daemon server binary not found", 1);
      } catch (err) {
        spinner.fail();
        throw err;
      }
    });
}
