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
import { loadAuthState, getAuthState } from "./state/auth-state.js";
import { mintToken } from "./auth.js";
import * as cloudflared from "./services/cloudflared.js";
import { resolveTunnelPort } from "./services/tunnelPort.js";
import { loadAll } from "./state/project-store.js";
import { recoverNotStartedSessions, sweepDirectPtySessionsOnBoot } from "./services/recover.js";
import { startLifecyclePoller, stopLifecyclePoller } from "./services/lifecycle.js";
import { setDaemonPort } from "./services/daemonPort.js";
import { startPrPoller, stopPrPoller } from "./services/prPoller.js";
import { readSettings } from "./services/config.js";
import { setSkillPaths } from "./services/userSkillCatalog.js";
import { setupVstEnvironment, patchShellConfigs } from "./lib/resolveVstPaths.js";
import { installHarnessSkillDirs } from "./lib/harnessSkillDirs.js";

const VST_HOME = join(homedir(), ".vibe-station");
const CONFIG_PATH = join(VST_HOME, "config.json");
const LOCK_PATH = join(VST_HOME, ".daemon.lock");
const DEFAULT_PORT = 7421;

/** Try to bind to a port. Returns the port on success, null if in use. */
function tryPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(null));
    srv.listen(port, "0.0.0.0", () => {
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

async function writeConfig(port: number, cliToken: string, browserEpoch: number, tauriToken: string): Promise<void> {
  await mkdir(VST_HOME, { recursive: true });
  // H3: Read existing config so user settings (e.g. defaultProjectsDir) are preserved.
  const existing = await readConfig();
  // daemonToken is NEVER written to disk — only cliToken/tauriToken (pre-minted) and browserEpoch.
  const config = { ...existing, port, pid: process.pid, startedAt: new Date().toISOString(), cliToken, tauriToken, browserEpoch };
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

  // Write ~/.vibe-station/bin/vst shim and ~/.vibe-station/skill/vst/SKILL.md.
  // Best-effort: failures are logged, never fatal.
  try {
    await setupVstEnvironment();
    await installHarnessSkillDirs();
    await patchShellConfigs();
  } catch (err) {
    console.error("[vst] setupVstEnvironment failed (non-fatal):", err);
  }

  // One-time migration of every project's manifest.json into vibe-station.db
  // (idempotent — a no-op after the first successful boot). Reads then go
  // through project-store's in-memory cache in front of SQLite.
  await loadAll();

  await recoverNotStartedSessions();
  await sweepDirectPtySessionsOnBoot();

  const port = await findFreePort(DEFAULT_PORT);

  // Read persisted browserEpoch from config (daemonToken is never read/written).
  const existingConfig = await readConfig();

  // Generate a fresh daemonToken in memory on every startup — never persisted.
  // All existing sessions (browser, CLI, Tauri) become invalid on restart.
  const daemonToken = randomBytes(32).toString("hex");
  loadAuthState(daemonToken, existingConfig.browserEpoch ?? 0);

  // M4: Print the browser login password so the user knows what to type in the
  // web login form — this is the only way to authenticate via the web UI.
  console.log(`[vst] Browser login password: ${daemonToken}`);

  // Pre-mint the CLI token and write it to config.json so `vst` can read it.
  const cliToken = mintToken("cli", getAuthState());

  // H1: Pre-mint a tauri-scoped token so the desktop webview auto-authenticates
  // without showing the login screen. Written to config.json; Rust reads it.
  const tauriToken = mintToken("tauri", getAuthState());

  // persistEpoch is the only way routes mutate config.json after startup.
  const persistEpoch = async () => {
    await writeConfig(port, cliToken, getAuthState().browserEpoch, tauriToken);
  };

  await writeConfig(port, cliToken, existingConfig.browserEpoch ?? 0, tauriToken);

  // Dev escape hatch: VST_NO_AUTH=1 disables the auth guard so the web UI loads
  // with no login (e.g. behind Tailscale on a trusted tailnet). The CLI token is
  // still written to config.json so the CLI keeps working either way.
  const noAuth = process.env.VST_NO_AUTH === "1" || process.env.VST_NO_AUTH === "true";
  if (noAuth) {
    console.warn("⚠  VST_NO_AUTH set — authentication is DISABLED. Do not expose this daemon to untrusted networks.");
  } else {
    console.log(`CLI token written to ${CONFIG_PATH}`);
  }

  const app = await buildServer({ port, logger: true, authState: getAuthState(), noAuth, persistEpoch });

  // Initialize the user skill catalog from persisted settings (skillPaths
  // defaults to ~/.claude/skills, Decision 11) so the popover/GET /skills
  // catalog is populated on a fresh install without requiring the user to
  // first open Skills settings and trigger a PATCH /settings. Done here —
  // the real daemon entry point — rather than inside buildServer(), since
  // buildServer() is called directly by ~90 daemon test files and starting
  // a chokidar watcher there would leak watchers into every one of them.
  // Best-effort: a scan/watch failure must never prevent daemon boot.
  try {
    const settings = await readSettings();
    const vstSkillDir = join(homedir(), ".vibe-station", "skill");
    const allPaths = [...(settings.skillPaths ?? []), vstSkillDir];
    await setSkillPaths(allPaths);
  } catch (err) {
    console.error("Failed to initialize skill catalog (non-fatal):", err);
  }

  // Reap any orphaned cloudflared processes and clear persisted tunnel state.
  // The tunnel requires explicit user action to enable after each restart.
  await cloudflared.restoreOnBoot(resolveTunnelPort(port));

  // Publish the real port process-wide. Everything that spawns an agent puts
  // it in VST_DAEMON_URL, and callers without a live Fastify handle (WS chat
  // open, subagent notifications, timers) read it from here instead of passing
  // a placeholder 0.
  setDaemonPort(port);
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
    // shutdownKill(), not disable(): a graceful stop/restart must kill the
    // process but preserve `enabled` in tunnel_state, or restoreOnBoot()
    // would never re-spawn it on the next boot (tunnel-persistence, Decision 3).
    cloudflared.shutdownKill();
    await app.close();
    await releaseLock();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`vst daemon listening on http://0.0.0.0:${port}`);
  } catch (err) {
    console.error("Failed to start daemon:", err);
    await releaseLock();
    process.exit(1);
  }
}

void main();
