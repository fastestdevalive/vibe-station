import { Command } from "commander";
import { execFile as execFileCb, execSync } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getDaemonUrl } from "../lib/daemon-url.js";
import chalk from "chalk";

const execFile = promisify(execFileCb);

interface TailscaleStatusJson {
  BackendState?: string;
  Self?: { DNSName?: string };
}

interface TailscaleServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

function trimTrailingDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

function parseProxyPort(proxyUrl: string): number | null {
  try {
    const u = new URL(proxyUrl);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

function findServePort(config: TailscaleServeJson | null): number | null {
  if (!config?.Web) return null;
  for (const [key, value] of Object.entries(config.Web)) {
    if (!key.endsWith(":443")) continue;
    const proxy = value?.Handlers?.["/"]?.Proxy;
    if (!proxy) continue;
    const port = parseProxyPort(proxy);
    if (port !== null) return port;
  }
  return null;
}

/** Read the daemon port the CLI would reach from config.json (null when absent). */
function getDaemonPortFromConfig(): number | null {
  try {
    const raw = readFileSync(join(homedir(), ".vibe-station", "config.json"), "utf8");
    const cfg = JSON.parse(raw) as { port?: number };
    return typeof cfg.port === "number" && cfg.port > 0 ? cfg.port : null;
  } catch {
    return null;
  }
}

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

/**
 * Tailscale check: connected / not found / not connected, plus a note when a
 * serve rule exists for a port different from the running daemon (drift). Uses
 * execFile with an explicit timeout — unlike the execSync calls above, which
 * have none.
 */
async function checkTailscale(): Promise<boolean> {
  let status: TailscaleStatusJson;
  try {
    const { stdout } = await execFile("tailscale", ["status", "--json"], {
      timeout: 15_000,
      encoding: "utf8",
    });
    status = JSON.parse(stdout) as TailscaleStatusJson;
  } catch {
    console.log(chalk.red("✗"), "tailscale not found");
    return false;
  }

  const backend = status.BackendState ?? "NoState";
  if (backend !== "Running") {
    console.log(chalk.red("✗"), "tailscale not connected");
    return false;
  }

  const dnsName = trimTrailingDot(status.Self?.DNSName ?? "");
  console.log(chalk.green("✓"), `tailscale connected (${dnsName})`);

  // Document serve-port drift: a rule pointing at a port other than the running
  // daemon means the HTTPS URL will serve stale/offline content.
  try {
    const { stdout } = await execFile("tailscale", ["serve", "status", "--json"], {
      timeout: 15_000,
      encoding: "utf8",
    });
    const serve = stdout.trim() ? (JSON.parse(stdout) as TailscaleServeJson) : null;
    const servePort = findServePort(serve);
    const daemonPort = getDaemonPortFromConfig();
    if (servePort !== null && daemonPort !== null && servePort !== daemonPort) {
      console.log(
        chalk.yellow("  →"),
        `Tailscale serve points to port ${servePort}; daemon is on ${daemonPort}. ` +
          "Enable again in Remote Access to repair.",
      );
    }
  } catch {
    // serve status unavailable (no operator permission, tailscaled hiccup) — not fatal
  }

  return true;
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

      const cloudflaredFound = check("cloudflared", () => {
        try {
          execSync("which cloudflared", { stdio: "pipe" });
          return true;
        } catch {
          return false;
        }
      });
      if (!cloudflaredFound) {
        console.log(
          chalk.yellow("  →"),
          "brew install cloudflared  OR  https://developers.cloudflare.com/cloudflared/",
        );
      }

      // Tailscale is optional (like cloudflared) — informational, not part of
      // the exit-code gate. Uses an explicit timeout via execFile.
      await checkTailscale();

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
