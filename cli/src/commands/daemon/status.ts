import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { printJson, die, success } from "../../lib/output.js";

export function registerDaemonStatus(daemon: Command): void {
  daemon
    .command("status")
    .description("Check daemon status")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      await preflight();
      const result = await daemonGet<{ ok: boolean; version?: string; port?: number; uptime?: number }>(
        "/health"
      );

      if (!result.ok) {
        die("Daemon health check failed", 4);
      }

      if (opts.json) {
        printJson(result.data);
      }

      success("Daemon is running");
      console.log(`  Port: ${result.data.port}`);
      if (result.data.version) {
        console.log(`  Version: ${result.data.version}`);
      }
      if (result.data.uptime) {
        console.log(`  Uptime: ${formatSeconds(result.data.uptime)}`);
      }
    });
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
