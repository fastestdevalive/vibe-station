/**
 * Daemon entry point.
 * Usage: node dist/daemon/main.js
 *
 * Acquires ~/.vibe-station/.daemon.lock, starts Fastify on port 7421 (or next free),
 * writes pid + port to ~/.vibe-station/config.json.
 */
import { chmod, mkdir, open, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server.js";
import { readConfig } from "./services/config.js";
import * as cloudflared from "./services/cloudflared.js";
import { loadAll } from "./state/project-store.js";
import { recoverNotStartedSessions, sweepDirectPtySessionsOnBoot } from "./services/recover.js";
import { startLifecyclePoller, stopLifecyclePoller, setNotifyDaemonPort } from "./services/lifecycle.js";
import { startPrPoller, stopPrPoller } from "./services/prPoller.js";

const VST_HOME = join(homedir(), ".vibe-station");
const CONFIG_PATH = join(VST_HOME, "config.json");
const LOCK_PATH = join(VST_HOME, ".daemon.lock");
const DEFAULT_PORT = 7421;

/** Try to bind to a port. Returns the port on success, null if in use. */
function tryPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(null));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(port));
    });
  });
}

/** Find the next free port starting from `start`. */
async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 100; p++) {
    const result = await tryPort(p);
    if (result !== null) return result;
  }
  throw new Error(`No free port found in range ${start}–${start + 99}`);
}

async function acquireLock(): Promise<void> {
  await mkdir(VST_HOME, { recursive: true });
  const fh = await open(LOCK_PATH, "wx").catch(async () => {
    // File exists — check if the pid inside is still alive
    const fhExisting = await open(LOCK_PATH, "r+");
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fhExisting.read(buf, 0, 32, 0);
    const storedPid = parseInt(buf.slice(0, bytesRead).toString("utf8").trim(), 10);
    await fhExisting.close();

    if (storedPid && Number.isFinite(storedPid)) {
      try {
        process.kill(storedPid, 0);
        throw new Error(
          `Daemon is already running (pid ${storedPid}). Use \`vst daemon stop\` first.`,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          // Process is gone — take over the lock
          return open(LOCK_PATH, "w");
        }
        throw e;
      }
    }
    return open(LOCK_PATH, "w");
  });

  await fh.writeFile(String(process.pid), "utf8");
  await fh.close();
}

async function writeConfig(port: number, token: string): Promise<void> {
  await mkdir(VST_HOME, { recursive: true });
  const config = { port, pid: process.pid, startedAt: new Date().toISOString(), token };
  // mode 0o600 — owner read/write only; no other user on the machine can read the token
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  // Ensure correct permissions even if the file already existed with wrong mode
  await chmod(CONFIG_PATH, 0o600);
}

async function releaseLock(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(LOCK_PATH);
  } catch {
    // best-effort
  }
}

/**
 * Last-resort process guards.
 *
 * The daemon owns every browser terminal, every attached agent stream and
 * every file watcher, so dying takes all of them down at once — a real
 * production failure mode here was an unhandled `read ECONNRESET` on a child
 * process's stdio pipe killing the whole daemon, which the user experiences as
 * "the web terminal accepts no input at all" (no keys, no touch, no scroll —
 * every one of those is a WS round-trip).
 *
 * The individual pipes are guarded at the source (`services/childStreams.ts`,
 * `services/fileList.ts`). This is the backstop for one we missed, and it is
 * deliberately NOT a blanket "log and carry on": after an arbitrary uncaught
 * exception the process state is undefined and continuing is unsafe. Only the
 * broken-pipe family — which is always benign and always about a child that is
 * already gone — is swallowed. Anything else is logged with its stack and then
 * rethrown so the process still dies loudly rather than limping on corrupted
 * state.
 */
function installProcessGuards(): void {
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE" || err?.code === "ECONNRESET") {
      console.warn(
        `[daemon] survived an unhandled ${err.code} on a pipe — a child's stdio went away. ` +
          `Guard its stream at the source (services/childStreams.ts).\n${err.stack ?? ""}`,
      );
      return;
    }
    console.error("[daemon] uncaught exception — exiting:", err?.stack ?? err);
    throw err;
  });

  // The process had no rejection handler at all, so an unawaited rejection
  // vanished silently (or killed the daemon, depending on Node's mode).
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[daemon] unhandled promise rejection:",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
  });
}

async function main() {
  installProcessGuards();

  // `acquireLock()` (pid-checked, `.daemon.lock`) already guarantees only one
  // daemon process runs against `~/.vibe-station` at a time (Risk #4 /
  // Phase 1.7) — since `vibe-station.db` lives inside that same directory,
  // the existing single-daemon invariant covers the DB file too. No
  // additional locking needed here.
  await acquireLock();

  // One-time migration of every project's manifest.json into vibe-station.db
  // (idempotent — a no-op after the first successful boot). Reads then go
  // through project-store's in-memory cache in front of SQLite.
  await loadAll();

  await recoverNotStartedSessions();
  await sweepDirectPtySessionsOnBoot();

  const port = await findFreePort(DEFAULT_PORT);

  // Read existing token from config.json; generate fresh only on first boot.
  // The token never travels via argv — it lives only in memory + config.json.
  const existingConfig = await readConfig();
  const token = existingConfig.token ?? randomBytes(32).toString("hex");
  await writeConfig(port, token);

  // Dev escape hatch: VST_NO_AUTH=1 disables the auth guard so the web UI loads
  // with no login (e.g. behind Tailscale on a trusted tailnet). The token is
  // still written to config.json so the CLI keeps working either way.
  const noAuth = process.env.VST_NO_AUTH === "1" || process.env.VST_NO_AUTH === "true";
  if (noAuth) {
    console.warn("⚠  VST_NO_AUTH set — authentication is DISABLED. Do not expose this daemon to untrusted networks.");
  } else {
    console.log(`Browser token: ${token.slice(0, 8)}...  (full token in ${CONFIG_PATH})`);
  }

  const app = await buildServer({ port, logger: true, token, noAuth });

  // Subagent → parent notifications resolve the parent's agent lazily and need
  // the port to do it (subagent-ux-v2).
  setNotifyDaemonPort(port);
  // Detect tmux pane death + drive session:exited / state transitions
  startLifecyclePoller();
  // Poll for PR outcome (open/merged/closed) on the orthogonal `session.pr`
  // axis — pr-status-axis plan, Phase 2. Never touches lifecycle state.
  startPrPoller();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}; shutting down…`);
    stopLifecyclePoller();
    stopPrPoller();
    cloudflared.disable();
    await app.close();
    await releaseLock();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port, host: "127.0.0.1" });
    console.log(`vst daemon listening on http://127.0.0.1:${port}`);
  } catch (err) {
    console.error("Failed to start daemon:", err);
    await releaseLock();
    process.exit(1);
  }
}

void main();
