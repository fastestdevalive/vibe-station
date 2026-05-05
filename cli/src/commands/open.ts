import { Command } from "commander";
import { execSync } from "child_process";
import { die } from "../lib/output.js";

export function registerOpen(program: Command): void {
  program
    .command("open [target]")
    .description("Open the vibe-station IDE in browser")
    .action(async (target?: string) => {
      const url = target ? `http://localhost:3000/${target}` : "http://localhost:3000";

      try {
        const platform = process.platform;
        if (platform === "darwin") {
          execSync(`open "${url}"`);
        } else if (platform === "linux") {
          execSync(`xdg-open "${url}"`);
        } else if (platform === "win32") {
          execSync(`start ${url}`);
        } else {
          die("Unsupported platform", 1);
        }
      } catch (err) {
        die(`Failed to open browser: ${err}`, 1);
      }
    });
}
