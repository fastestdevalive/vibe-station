import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { cloudflaredLogPath } from "./paths.js";
import * as tunnelStore from "../state/tunnel-store.js";

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

/**
 * The in-flight spawn attempt, if any. `disable()`/`shutdownKill()` must cancel
 * this (not just kill the process) — otherwise the poll interval keeps scraping
 * the log for the rest of the 10s window, `pending` never clears (wedging the
 * next `enable()` until the timeout fires), and a URL that happens to appear in
 * that window resolves with a pid that's already dead.
 */
let activeSpawn: { child: ChildProcess; cancel: (reason: string) => void } | null = null;

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const SPAWN_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

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
    const logPath = cloudflaredLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    // Truncate on every spawn ("w", not "a") — the previous run's output is
    // irrelevant to this attempt, and a fresh file means the URL regex can
    // never match stale text left over from an earlier spawn (no offset
    // bookkeeping needed), plus the log never grows unbounded across restarts.
    const logFd = openSync(logPath, "w");

    const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
      // Piped stdio's read end is owned by the parent — once the daemon exits,
      // the child's next write raises EPIPE. Redirecting to a log file lets
      // the child (detached + unref'd) outlive the daemon without depending
      // on anyone draining its stdio.
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    closeSync(logFd); // parent doesn't need its own handle once the child has inherited it
    child.unref();
    state.process = child;

    let resolved = false;

    function finishResolve(url: string) {
      if (resolved) return;
      resolved = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (activeSpawn?.child === child) activeSpawn = null;
      state.enabled = true;
      state.tunnelUrl = url;
      tunnelStore.setState({
        enabled: true,
        currentUrl: url,
        currentPid: child.pid ?? null,
        startedAt: Date.now(),
        port,
      });
      resolve({ tunnelUrl: url });
    }

    function finishReject(err: Error) {
      if (resolved) return;
      resolved = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (activeSpawn?.child === child) activeSpawn = null;
      reject(err);
    }

    const poll = setInterval(() => {
      let text: string;
      try {
        text = readFileSync(logPath).toString("utf8");
      } catch {
        return; // best-effort — file may not exist yet on the very first tick
      }
      const match = TUNNEL_URL_RE.exec(text);
      if (match) finishResolve(match[0]);
    }, POLL_INTERVAL_MS);

    const timer = setTimeout(() => {
      child.kill();
      finishReject(new Error("cloudflared did not emit a URL within 10s"));
    }, SPAWN_TIMEOUT_MS);

    // Lets killTrackedProcess() (disable()/shutdownKill()) cancel THIS attempt
    // if it fires mid-spawn, instead of leaving it to wedge `pending` and poll
    // for the rest of SPAWN_TIMEOUT_MS after the process is already dead.
    activeSpawn = {
      child,
      cancel: (reason) => finishReject(new Error(reason)),
    };

    child.on("error", (err) => {
      // Guard by identity, not unconditionally — an error event for a process
      // that's already been superseded by a newer spawn must not clobber the
      // newer one's tracking (same hazard as the exit handler below).
      if (state.process === child) state.process = null;
      const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "cloudflared not found — install it and ensure it is on PATH (run: vst doctor)"
        : err.message;
      finishReject(new Error(msg));
    });

    child.on("exit", (code) => {
      // Guard by identity, not pid: a late exit event for a process that has
      // already been superseded by a newer spawn (disable() + enable() in
      // quick succession) must never clobber the newer one's state.
      if (state.process !== child) return;
      state.process = null;

      if (!resolved) {
        finishReject(new Error(`cloudflared exited with code ${code ?? "?"} before emitting URL`));
      } else {
        // Process died after URL was emitted — tunnel is gone.
        state.enabled = false;
        state.tunnelUrl = null;
        const cur = tunnelStore.getState();
        if (cur.currentPid === child.pid) tunnelStore.clearProcess();
        console.warn("[cloudflared] tunnel process exited unexpectedly");
      }
    });
  });
}

/**
 * Best-effort identity check before signaling a pid we only know from a
 * persisted record (not our own live `ChildProcess` handle) — after a reboot
 * or a long gap, that pid can easily have been reused by an unrelated
 * process, and blindly SIGTERM-ing it would kill someone else's process.
 * `ps` (not `/proc`) is used since it works on both Linux and macOS.
 * Inconclusive (ps missing, sandboxed, pid already gone) → fail open and
 * attempt the kill anyway; `process.kill`'s own ESRCH handling is still the
 * backstop for "it's already gone".
 */
function isLikelyCloudflaredProcess(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (!out) return true; // ps found nothing conclusive — don't block the kill attempt
    return out.toLowerCase().includes("cloudflared");
  } catch {
    return true;
  }
}

/** SIGTERM a pid we only know from a persisted record, verifying identity first. ESRCH-safe. */
function killPersistedPid(pid: number, context: string): void {
  if (!isLikelyCloudflaredProcess(pid)) {
    console.warn(`[cloudflared] pid ${pid} (${context}) no longer looks like cloudflared — not killing it`);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // ESRCH means it's already gone — fine. Anything else is also best-effort here.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      console.warn(`[cloudflared] failed to kill ${context} pid ${pid}:`, err);
    }
  }
}

/**
 * Kill whatever this process considers "the tunnel" right now: an in-flight
 * spawn attempt (cancelled, not just left to time out — see `activeSpawn`
 * doc comment), then the tracked live process (in-memory handle, else the
 * persisted pid as a fallback, identity-checked).
 */
function killTrackedProcess(): void {
  if (activeSpawn) {
    activeSpawn.cancel("tunnel disabled while cloudflared was still starting");
  }
  if (state.process) {
    try {
      state.process.kill();
    } catch {
      // best-effort
    }
    state.process = null;
    return;
  }
  const { currentPid } = tunnelStore.getState();
  if (currentPid === null) return;
  killPersistedPid(currentPid, "tracked");
}

/**
 * Explicit user-facing disable (POST /auth/tunnel/disable). Kills the process
 * AND clears `enabled` in the DB — the next boot must NOT re-spawn.
 */
export function disable(): void {
  killTrackedProcess();
  state.enabled = false;
  state.tunnelUrl = null;
  tunnelStore.clear();
}

/**
 * Graceful daemon shutdown (main.ts). Kills the process but preserves
 * `enabled` in the DB — the next boot's restoreOnBoot() still re-spawns if
 * the tunnel was on. See tunnel-persistence plan, Decision 3.
 */
export function shutdownKill(): void {
  killTrackedProcess();
  state.enabled = false;
  state.tunnelUrl = null;
  tunnelStore.clearProcess();
}

/**
 * Called once at daemon boot (main.ts, after port/token/noAuth are resolved).
 * No-ops in no-auth / no-token mode — exposing an auth-disabled daemon over a
 * public tunnel URL is exactly what /auth/tunnel/enable's own guard prevents,
 * and a boot-time call bypasses that route entirely. Otherwise: best-effort
 * kill (identity-checked) whatever pid was last recorded (covers both an
 * already-dead graceful shutdown and a live orphan from a crash), then
 * re-spawn fresh if the persisted state says the tunnel should be enabled.
 * Never throws.
 */
export async function restoreOnBoot(port: number, opts: { token?: string; noAuth: boolean }): Promise<void> {
  if (opts.noAuth || !opts.token) {
    console.warn("[cloudflared] skipping tunnel restore — daemon is in no-auth mode or has no token");
    return;
  }
  const persisted = tunnelStore.getState();
  if (persisted.currentPid !== null) {
    killPersistedPid(persisted.currentPid, "orphaned");
  }
  if (!persisted.enabled) return;
  try {
    await enable(port);
  } catch (err) {
    console.warn("[cloudflared] failed to restore tunnel on boot:", err);
    // Don't leave a dead pid/url behind for the NEXT boot to re-discover and
    // re-attempt killing (it'll be stale, possibly reused by an unrelated
    // process by then) — `enabled` stays true so the retry itself still happens.
    tunnelStore.clearProcess();
  }
}

/** Return the current tunnel state (no side effects). */
export function getState(): { enabled: boolean; tunnelUrl: string | null; startedAt: number | null } {
  return { enabled: state.enabled, tunnelUrl: state.tunnelUrl, startedAt: tunnelStore.getState().startedAt };
}
