import { Command } from "commander";

export function registerDaemonRestart(daemon: Command): void {
  daemon
    .command("restart")
    .description("Restart the daemon")
    .action(async () => {
      console.log("Stopping daemon...");
      // This would call stop internally
      console.log("Starting daemon...");
      // This would call start internally
    });
}
