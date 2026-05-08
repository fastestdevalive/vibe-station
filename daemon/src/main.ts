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
import { loadAll, getAllProjects } from "./state/project-store.js";
import { recoverNotStartedSessions } from "./services/recover.js";
import { startLifecyclePoller, stopLifecyclePoller, persistLifecycleState } from "./services/lifecycle.js";

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
 * Mark any non-tmux sessions that are not already exited as exited.
 * Direct-pty PTYs are children of the daemon process — they die on daemon
 * restart, so there is nothing to recover.
 */
async function sweepDirectPtySessionsOnBoot(): Promise<void> {
  for (const project of getAllProjects()) {
    for (const worktree of project.worktrees) {
      for (const session of worktree.sessions) {
        if (!session.useTmux && session.lifecycle.state !== "exited") {
          console.log(`[sweep] ${session.id}: direct-pty died with daemon → mark exited`);
          await persistLifecycleState(project.id, worktree.id, session.id, "exited");
        }
      }
    }
  }
}

async function main() {
  await acquireLock();

  // Load all project manifests into memory before serving requests
  await loadAll();

  await recoverNotStartedSessions();
  await sweepDirectPtySessionsOnBoot();

  const port = await findFreePort(DEFAULT_PORT);

  // Generate a fresh random token each daemon start.
  // The token never travels via argv — it lives only in memory + config.json.
  const token = randomBytes(32).toString("hex");
  await writeConfig(port, token);

  console.log(`Browser token: ${token.slice(0, 8)}...  (full token in ${CONFIG_PATH})`);

  const app = await buildServer({ port, logger: true, token });

  // Detect tmux pane death + drive session:exited / state transitions
  startLifecyclePoller();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}; shutting down…`);
    stopLifecyclePoller();
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
