import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
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
 * this (not just kill the process) — otherwise the stdio listeners keep
 * scanning output for the rest of the 10s window, `pending` never clears
 * (wedging the next `enable()` until the timeout fires), and a URL that happens
 * to appear in that window resolves with a pid that's already dead.
 */
let activeSpawn: { child: ChildProcess; cancel: (reason: string) => void } | null = null;

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const SPAWN_TIMEOUT_MS = 10_000;

// Deliberately distinct from the 500ms advanceTimersByTimeAsync idiom already
// used throughout cloudflared.test.ts — sharing that value would make the
// escalation timer fire mid-advance in any test whose mocked pgrep returns
// real pids, entangling unrelated test assertions with sweep internals.
const SWEEP_GRACE_MS = 2000;

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
  // Sweep first, before anything else — only reached when enable() has
  // decided to actually spawn (never on its "already enabled" early return,
  // which must not kill the live tunnel it's about to report as healthy).
  sweepOrphans(port);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.VST_CLOUDFLARED_BIN ?? "cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.process = child;

    let resolved = false;

    function finishResolve(url: string) {
      if (resolved) return;
      resolved = true;
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
      clearTimeout(timer);
      if (activeSpawn?.child === child) activeSpawn = null;
      reject(err);
    }

    // Accumulate across chunks rather than testing each one in isolation:
    // stdout/stderr are byte streams with no message framing, so the URL can
    // (and on a slow pipe does) arrive split across two `data` events —
    // "https://abc-" then "def.trycloudflare.com" — which no per-chunk regex
    // would ever match, wedging the spawn until the 10s timeout. Capped so a
    // chatty cloudflared can't grow this unboundedly during the spawn window;
    // the tail is retained (not cleared) so a URL straddling the cap boundary
    // still matches.
    const MAX_BUFFER = 64 * 1024;
    let buffer = "";

    function onData(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
      const match = TUNNEL_URL_RE.exec(buffer);
      if (match) finishResolve(match[0]);
    }

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

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
 * Enumerate every real OS process matching the exact cloudflared invocation
 * this daemon uses for `port`, including the port itself — orphan-reconciliation
 * sweep (see cloudflared-orphan-sweep plan, Decision 3). Matches the full argv,
 * not just the binary name, so an unrelated user-run cloudflared tunnel on a
 * different port/purpose is never touched. Dots are regex-escaped and the
 * pattern is `$`-anchored on the port so e.g. `:655` can't substring-match a
 * real tunnel on `:65535`. Fail-open on any `pgrep` error (missing binary,
 * sandboxed, etc.) — a sweep that finds nothing is safe, never crashing the
 * caller is the priority, same convention as `isLikelyCloudflaredProcess` below.
 */
function findMatchingPids(port: number): number[] {
  const pattern = `cloudflared tunnel --url http://127\\.0\\.0\\.1:${port}$`;
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8", timeout: 2000 }).trim();
    if (!out) return [];
    return out
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch (err) {
    // pgrep's documented contract: exit 1 == "no processes matched" — not an error.
    if ((err as NodeJS.ErrnoException & { status?: number }).status === 1) return [];
    console.warn("[cloudflared] sweep: pgrep enumeration failed:", err);
    return [];
  }
}

/** ESRCH-based liveness probe — `process.kill(pid, 0)` signals nothing, just checks existence. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * OS-truth reconciliation sweep — treats the OS as the source of truth for
 * "what's running," not the DB (cloudflared-orphan-sweep plan, report
 * "Proposed" diagram). Runs at every entry point that changes tunnel state,
 * BEFORE anything else: enumerates every real cloudflared process bound to
 * `port`, SIGTERMs all of them unconditionally (no "is this mine" branch —
 * a fresh boot/enable() always mints a brand-new URL, so nothing found here
 * is ever worth keeping), then escalates any still-alive pid to SIGKILL after
 * a grace period. Additive to (does not replace) the existing single-pid
 * `tunnel_state`-derived cleanup below.
 *
 * The SIGKILL escalation is deliberately fire-and-forget: cloudflared dials
 * out to the local port rather than binding it, so a lingering old process
 * can't conflict with a freshly-spawned one, and blocking the new spawn on
 * old-process death buys nothing but latency. The escalation timer is
 * `.unref()`'d so it can never keep the daemon process alive on its own.
 */
function sweepOrphans(port: number): void {
  const pids = findMatchingPids(port);
  if (pids.length === 0) return;
  for (const pid of pids) {
    console.log(`[cloudflared] sweep: SIGTERM pid ${pid} (port ${port})`);
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        console.warn(`[cloudflared] sweep: failed to SIGTERM pid ${pid}:`, err);
      }
    }
  }
  setTimeout(() => {
    for (const pid of pids) {
      if (!isProcessAlive(pid)) continue;
      // Re-check identity before SIGKILL too — same pid-reuse hazard
      // isLikelyCloudflaredProcess() already guards against for persisted
      // pids below; the grace period is long enough for a pid to have been
      // recycled by an unrelated process.
      if (!isLikelyCloudflaredProcess(pid)) continue;
      console.warn(`[cloudflared] sweep: pid ${pid} still alive after grace period — SIGKILL`);
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          console.warn(`[cloudflared] sweep: failed to SIGKILL pid ${pid}:`, err);
        }
      }
    }
  }, SWEEP_GRACE_MS).unref();
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
 * Explicit user-facing disable (POST /auth/tunnel/disable). Runs the OS-truth
 * reconciliation sweep first (`port`-scoped — see `sweepOrphans`), then kills
 * the process AND clears `enabled` in the DB — the next boot must NOT re-spawn.
 */
export function disable(port: number): void {
  sweepOrphans(port);
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
 * Runs the OS-truth reconciliation sweep FIRST, before even the no-auth/token
 * guard — orphans from a prior run in a *different* auth mode (e.g. this
 * machine had auth enabled last boot but is booting with --no-auth now) must
 * still be reaped; "sweep first, before anything else" applies to the guard
 * too, not just to the existing single-pid logic below. No-ops the REST of
 * restore in no-auth / no-token mode — exposing an auth-disabled daemon over a
 * public tunnel URL is exactly what /auth/tunnel/enable's own guard prevents,
 * and a boot-time call bypasses that route entirely. Otherwise: best-effort
 * kill (identity-checked) whatever pid was last recorded (covers both an
 * already-dead graceful shutdown and a live orphan from a crash), then
 * re-spawn fresh if the persisted state says the tunnel should be enabled.
 * Never throws.
 */
export async function restoreOnBoot(port: number, opts: { token?: string; noAuth: boolean }): Promise<void> {
  sweepOrphans(port);
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
