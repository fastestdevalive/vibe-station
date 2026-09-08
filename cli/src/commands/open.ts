import { Command } from "commander";
import { spawn } from "child_process";
import { resolve } from "path";
import { die, success } from "../lib/output.js";
import { getDaemonUrl, getDaemonToken } from "../lib/daemon-url.js";

interface OpenResult {
  projectId: string;
}

async function postOpen(path: string): Promise<OpenResult> {
  const url = getDaemonUrl();
  if (!url) throw new Error("no_daemon");
  const token = getDaemonToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${url}/open`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((data.error as string | undefined) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<OpenResult>;
}

function launchApp(): void {
  const platform = process.platform;
  if (platform === "darwin") {
    try {
      const child = spawn("open", ["-a", "vibe-station"], { stdio: "ignore", detached: true });
      child.unref();
    } catch {
      // ignore
    }
  } else if (platform === "linux") {
    const candidates = [
      "/usr/lib/vibe-station/vibe-station",
      "/opt/vibe-station/vibe-station",
    ];
    for (const bin of candidates) {
      try {
        const child = spawn(bin, [], { stdio: "ignore", detached: true });
        child.unref();
        return;
      } catch {
        continue;
      }
    }
    // Try via AppImage env var
    const appImage = process.env.APPIMAGE;
    if (appImage) {
      try {
        const child = spawn(appImage, [], { stdio: "ignore", detached: true });
        child.unref();
      } catch {
        // ignore
      }
    }
  }
}

async function pollForDaemon(timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = getDaemonUrl();
    if (url) {
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {
        // not ready yet
      }
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  return false;
}

export function registerOpen(program: Command): void {
  program
    .command("open [path]")
    .description("Open a project in vibe-station (upserts the project, navigates the app window)")
    .action(async (target?: string) => {
      const absPath = resolve(target ?? ".");

      // Try posting to the daemon
      try {
        const result = await postOpen(absPath);
        success(`Opened project: ${result.projectId}`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "no_daemon" && !msg.includes("ECONNREFUSED") && !msg.includes("connect")) {
          die(`Failed to open project: ${msg}`, 1);
        }
      }

      // Daemon not running — launch the app then retry
      success("Daemon not running — launching vibe-station...");
      launchApp();

      const ready = await pollForDaemon(10000);
      if (!ready) {
        die("vibe-station did not start within 10 seconds. Open the app manually.", 1);
      }

      try {
        const result = await postOpen(absPath);
        success(`Opened project: ${result.projectId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        die(`Failed to open project after app launch: ${msg}`, 1);
      }
    });
}
