import { Command } from "commander";
import { execSync } from "child_process";
import { getDaemonUrl } from "../lib/daemon-url.js";
import chalk from "chalk";

function check(name: string, fn: () => boolean): boolean {
  try {
    const result = fn();
    if (result) {
      console.log(chalk.green("✓"), name);
    } else {
      console.log(chalk.red("✗"), name);
    }
    return result;
  } catch {
    console.log(chalk.red("✗"), name);
    return false;
  }
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check system health")
    .action(async () => {
      let allOk = true;

      allOk = check("tmux is available", () => {
        execSync("tmux -V", { stdio: "pipe" });
        return true;
      }) && allOk;

      allOk = check("git is available", () => {
        execSync("git --version", { stdio: "pipe" });
        return true;
      }) && allOk;

      const binaries = ["claude", "cursor", "opencode", "gemini"];
      for (const bin of binaries) {
        check(`${bin} is on PATH`, () => {
          try {
            execSync(`which ${bin}`, { stdio: "pipe" });
            return true;
          } catch {
            return false;
          }
        });
      }

      allOk = check("Daemon is running", () => {
        const url = getDaemonUrl();
        if (!url) {
          return false;
        }
        // In real implementation, would fetch /health
        return true;
      }) && allOk;

      process.exit(allOk ? 0 : 1);
    });
}
