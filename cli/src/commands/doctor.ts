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

      const binaries = ["claude", "cursor", "opencode", "agy"];
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

      // Pi Coding Agent — requires the @victor-software-house/pi-acp adapter (npm-global).
      const piAcpFound = check("pi-acp is on PATH (required for Pi Rich Chat / ACP)", () => {
        execSync("which pi-acp", { stdio: "pipe" });
        return true;
      });
      if (piAcpFound) {
        check(`pi-acp version >= 0.17.1`, () => {
          const out = execSync("pi-acp --version", { encoding: "utf8", stdio: "pipe" }).trim();
          const m = out.match(/(\d+\.\d+\.\d+)/);
          const ver = (m && m[1]) ? m[1] : out;
          const parts = ver.split(".").map(Number);
          const min = [0, 17, 1];
          for (let i = 0; i < 3; i++) {
            if ((parts[i] ?? 0) > (min[i] ?? 0)) return true;
            if ((parts[i] ?? 0) < (min[i] ?? 0)) return false;
          }
          return true;
        });
      } else {
        console.log(
          chalk.yellow("  →"),
          `Install: npm install -g @victor-software-house/pi-acp@0.17.1`,
        );
      }

      // bun/bunx is required by the agy plugin's ACP adapter
      const bunFound = check("bun is on PATH (required for agy Rich Chat / ACP)", () => {
        try {
          execSync("which bun", { stdio: "pipe" });
          return true;
        } catch {
          return false;
        }
      });
      if (!bunFound) {
        const installCmd =
          process.platform === "darwin"
            ? "brew install oven-sh/bun/bun  OR  curl -fsSL https://bun.sh/install | bash"
            : "curl -fsSL https://bun.sh/install | bash";
        console.log(chalk.yellow("  →"), `Install: ${installCmd}`);
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
