/**
 * Single source of truth for "what port is this daemon actually listening on".
 *
 * The port is threaded through dozens of call sites as a plain `daemonPort`
 * number, and it ends up inside every agent process's `VST_DAEMON_URL` (see
 * `buildVstEnv`). Any call site that could not reach a live Fastify instance
 * used to pass a placeholder `0` — and because `JsonAgentSession` caches the
 * port it was FIRST created with, that placeholder could be baked into the
 * spawn env of every later turn, giving agents `VST_DAEMON_URL=http://
 * 127.0.0.1:0` and a `vst` CLI that cannot reach the daemon at all.
 *
 * `setDaemonPort()` is called once at boot with the real port; everything else
 * asks for it here. `getDaemonPort()` additionally falls back to the port the
 * daemon persisted in `~/.vibe-station/config.json` (the same file the CLI
 * reads) so out-of-band callers — timers, WS handlers, boot-time recovery —
 * still get a usable port, and only then to the well-known default.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 7421;

let listeningPort = 0;

/** Record the port the HTTP server bound to. Called once from main(). */
export function setDaemonPort(port: number): void {
  listeningPort = port > 0 ? port : 0;
}

/** The daemon's port: registered → persisted config → default. Never 0. */
export function getDaemonPort(): number {
  if (listeningPort > 0) return listeningPort;
  try {
    const raw = readFileSync(join(homedir(), ".vibe-station", "config.json"), "utf8");
    const cfg = JSON.parse(raw) as { port?: number };
    if (typeof cfg.port === "number" && cfg.port > 0) return cfg.port;
  } catch {
    /* no config yet — fall through to the default */
  }
  return DEFAULT_PORT;
}

/**
 * Normalize a threaded `daemonPort`. `0`/`undefined`/`null` mean "the caller
 * had no live server handle" — resolve the real port instead of emitting a
 * URL nothing listens on. Note `?? DEFAULT` does NOT do this: `0 ?? 7421` is 0.
 */
export function resolveDaemonPort(port: number | undefined | null): number {
  return typeof port === "number" && port > 0 ? port : getDaemonPort();
}
