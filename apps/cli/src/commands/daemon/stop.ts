import { Command } from "commander";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { success, warn } from "../../lib/output.js";

export function registerDaemonStop(daemon: Command): void {
  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      try {
        const configPath = join(homedir(), ".viberun", "config.json");
        const content = readFileSync(configPath, "utf-8");
        const config = JSON.parse(content) as { port?: number; pid?: number };

        if (!config.pid) {
          warn("Daemon PID not found in config");
          return;
        }

        try {
          process.kill(config.pid, "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 1000));
          success("Daemon stopped");
        } catch {
          warn("Daemon process not found or already stopped");
        }
      } catch {
        warn("Daemon config not found");
      }
    });
}
