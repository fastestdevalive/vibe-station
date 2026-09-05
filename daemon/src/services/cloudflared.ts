import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

interface TunnelState {
  enabled: boolean;
  tunnelUrl: string | null;
  process: ChildProcess | null;
}

const state: TunnelState = { enabled: false, tunnelUrl: null, process: null };

/**
 * Spawn in progress. `state.enabled` stays false for up to 10 s while cloudflared
 * boots, so without this latch a second enable() in that window spawns a second
 * cloudflared, overwrites `state.process`, and orphans the first — leaving a live
 * public tunnel that `disable()` can never kill.
 */
let pending: Promise<{ tunnelUrl: string }> | null = null;

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const SPAWN_TIMEOUT_MS = 10_000;

/** Spawn cloudflared and return the public tunnel URL. */
export function enable(port: number): Promise<{ tunnelUrl: string }> {
  if (state.enabled && state.tunnelUrl) {
    return Promise.resolve({ tunnelUrl: state.tunnelUrl });
  }
  if (pending) return pending;

  pending = spawnTunnel(port);
  // Clear the latch either way so a failed attempt can be retried.
  pending.then(
    () => { pending = null; },
    () => { pending = null; },
  );
  return pending;
}

function spawnTunnel(port: number): Promise<{ tunnelUrl: string }> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    state.process = child;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(new Error("cloudflared did not emit a URL within 10s"));
      }
    }, SPAWN_TIMEOUT_MS);

    function onData(chunk: Buffer) {
      const text = chunk.toString();
      const match = TUNNEL_URL_RE.exec(text);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        state.enabled = true;
        state.tunnelUrl = match[0];
        resolve({ tunnelUrl: match[0] });
      }
    }

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        state.process = null;
        const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "cloudflared not found — install it and ensure it is on PATH (run: vst doctor)"
          : err.message;
        reject(new Error(msg));
      }
    });

    child.on("exit", (code) => {
      state.process = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited with code ${code ?? "?"} before emitting URL`));
      } else {
        // Process died after URL was emitted — tunnel is gone
        state.enabled = false;
        state.tunnelUrl = null;
        console.warn("[cloudflared] tunnel process exited unexpectedly");
      }
    });
  });
}

/** Kill the cloudflared process and reset state. */
export function disable(): void {
  if (state.process) {
    try {
      state.process.kill();
    } catch {
      // best-effort
    }
    state.process = null;
  }
  state.enabled = false;
  state.tunnelUrl = null;
}

/** Return the current tunnel state (no side effects). */
export function getState(): { enabled: boolean; tunnelUrl: string | null } {
  return { enabled: state.enabled, tunnelUrl: state.tunnelUrl };
}
