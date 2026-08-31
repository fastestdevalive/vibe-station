import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tmuxNs from "../services/tmux.js";
import { recoverNotStartedSessions, sweepDirectPtySessionsOnBoot } from "../services/recover.js";
import type { ProjectRecord } from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir,
    projectDir: (id: string) => pathJoin(tempDir, "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) =>
      pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(tempDir, "projects", p, "session-data", w, s),
    directSessionDataDir: (p: string, s: string) =>
      pathJoin(tempDir, "projects", p, "sessions", s),
  };
});

vi.mock("../services/tmux.js", () => ({
  hasSession: vi.fn(),
}));

describe("recoverNotStartedSessions", () => {
  const tmux = vi.mocked(tmuxNs);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-recover-test-"));
    await mkdir(join(tempDir, "projects", "proj-r"), { recursive: true });
    await mkdir(join(tempDir, "repo"), { recursive: true });
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();

    const record: ProjectRecord = {
      id: "proj-r",
      absolutePath: join(tempDir, "repo"),
      prefix: "pfx",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [],
      worktrees: [
        {
          id: "wt-r",
          branch: "b",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          createdAt: new Date().toISOString(),
          sessions: [
            {
              id: "sess-alive",
              slot: "m",
              type: "agent",
              modeId: "mode",
              tmuxName: "alive-pane",
              useTmux: true,
              lifecycle: {
                state: "not_started",
                lastTransitionAt: new Date().toISOString(),
              },
            },
            {
              id: "sess-dead",
              slot: "a1",
              type: "agent",
              modeId: "mode",
              tmuxName: "dead-pane",
              useTmux: true,
              lifecycle: {
                state: "not_started",
                lastTransitionAt: new Date().toISOString(),
              },
            },
            {
              id: "sess-working",
              slot: "a2",
              type: "agent",
              modeId: "mode",
              tmuxName: "ignore-pane",
              useTmux: true,
              lifecycle: {
                state: "working",
                lastTransitionAt: new Date().toISOString(),
              },
            },
            {
              id: "sess-json-fresh",
              slot: "a3",
              type: "agent",
              modeId: "mode",
              tmuxName: "__direct__-json-fresh",
              useTmux: false,
              channel: "json",
              lifecycle: {
                state: "not_started",
                lastTransitionAt: new Date().toISOString(),
              },
            },
            {
              id: "sess-json-working",
              slot: "a4",
              type: "agent",
              modeId: "mode",
              tmuxName: "__direct__-json-working",
              useTmux: false,
              channel: "json",
              lifecycle: {
                state: "working",
                lastTransitionAt: new Date().toISOString(),
              },
            },
          ],
        },
      ],
    };

    await addProject(record);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("promotes not_started with live tmux to working", async () => {
    const { getProject } = await import("../state/project-store.js");
    tmux.hasSession.mockImplementation(async (name: string) => name === "alive-pane");

    await recoverNotStartedSessions();

    const proj = getProject("proj-r")!;
    const alive = proj.worktrees[0]!.sessions.find((s) => s.id === "sess-alive")!;
    expect(alive.lifecycle.state).toBe("working");
    expect(alive.lifecycle.reason).toBe("recovered-from-not-started");

    const dead = proj.worktrees[0]!.sessions.find((s) => s.id === "sess-dead")!;
    expect(dead.lifecycle.state).toBe("exited");
    expect(dead.lifecycle.reason).toBe("daemon-restart-during-spawn");

    const working = proj.worktrees[0]!.sessions.find((s) => s.id === "sess-working")!;
    expect(working.lifecycle.state).toBe("working");
  });

  it("2.T5 — JSON not_started stays not_started; JSON working reconciles → idle", async () => {
    const { getProject } = await import("../state/project-store.js");
    // No tmux pane exists for any JSON session — must NOT influence them.
    tmux.hasSession.mockResolvedValue(false);

    await recoverNotStartedSessions();

    const sessions = getProject("proj-r")!.worktrees[0]!.sessions;
    const fresh = sessions.find((s) => s.id === "sess-json-fresh")!;
    const jsonWorking = sessions.find((s) => s.id === "sess-json-working")!;

    // A fresh JSON session has no live process — that's normal, don't mark exited.
    expect(fresh.lifecycle.state).toBe("not_started");
    // A JSON session left working had its turn killed by the restart → idle.
    expect(jsonWorking.lifecycle.state).toBe("idle");
    expect(jsonWorking.lifecycle.reason).toBe("json-restart-reconcile");
  });

  it("boot sweep marks direct-pty exited but leaves JSON sessions untouched (Fix #1)", async () => {
    const { getProject } = await import("../state/project-store.js");
    tmux.hasSession.mockResolvedValue(false);

    // Full boot ordering: recover reconciles JSON working → idle, then the sweep
    // runs. The sweep MUST NOT clobber the reconciled JSON sessions to exited.
    await recoverNotStartedSessions();
    await sweepDirectPtySessionsOnBoot();

    const sessions = getProject("proj-r")!.worktrees[0]!.sessions;
    const jsonFresh = sessions.find((s) => s.id === "sess-json-fresh")!;
    const jsonWorking = sessions.find((s) => s.id === "sess-json-working")!;

    // JSON sessions survive the sweep with their recovered state.
    expect(jsonFresh.lifecycle.state).toBe("not_started");
    expect(jsonWorking.lifecycle.state).toBe("idle");
  });
});

describe("sweepOrphanTurnPids — PID-reuse safety (opus review finding)", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-recover-pidsweep-"));
    await mkdir(join(tempDir, "projects", "proj-pidsweep"), { recursive: true });
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    const record: ProjectRecord = {
      id: "proj-pidsweep",
      absolutePath: join(tempDir, "repo"),
      prefix: "pfx",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [],
      worktrees: [
        {
          id: "wt-pidsweep",
          branch: "b",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          createdAt: new Date().toISOString(),
          sessions: [
            {
              id: "sess-pidsweep",
              slot: "m",
              type: "agent",
              modeId: "mode",
              tmuxName: "pane-pidsweep",
              channel: "json",
              lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
            },
          ],
        },
      ],
    } as ProjectRecord;
    await addProject(record);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("verifyPidIsTurnProcess: true for a real process whose comm matches a known CLI binary", async () => {
    const { verifyPidIsTurnProcess } = await import("../services/recover.js");
    const { spawn } = await import("node:child_process");
    const { writeFile, chmod } = await import("node:fs/promises");
    // /proc/<pid>/stat's comm field is derived by the kernel from the
    // EXECUTABLE FILE's own basename at exec time — not argv[0] (so `exec -a
    // claude sleep` does NOT work; comm would still read "sleep"). Create a
    // real, tiny, executable script file literally named "claude" and spawn
    // it directly, so comm is genuinely "claude" end-to-end through a real
    // /proc entry, not a mocked string.
    const scriptPath = join(tempDir, "claude");
    await writeFile(scriptPath, "#!/bin/sh\nsleep 5\n", "utf8");
    await chmod(scriptPath, 0o755);
    const child = spawn(scriptPath, [], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 100)); // let /proc/<pid>/stat settle
      expect(child.pid).toBeDefined();
      expect(verifyPidIsTurnProcess(child.pid!)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("verifyPidIsTurnProcess: false for a real, live process whose comm is NOT one of our CLI binaries (the PID-reuse case)", async () => {
    const { verifyPidIsTurnProcess } = await import("../services/recover.js");
    const { spawn } = await import("node:child_process");
    // An ordinary unrelated process — comm will be "sleep", not in the
    // allowlist. This is exactly the shape of a reused PID after reboot: a
    // live, legitimate process that just isn't OUR turn child.
    const child = spawn("sleep", ["5"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(child.pid).toBeDefined();
      expect(verifyPidIsTurnProcess(child.pid!)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("verifyPidIsTurnProcess: true (inconclusive → proceed) for a PID with no /proc entry", async () => {
    const { verifyPidIsTurnProcess } = await import("../services/recover.js");
    // An implausibly large PID almost certainly has no /proc/<pid> entry —
    // exercises the catch path (ENOENT), which must fail open (best-effort
    // preserved) rather than silently blocking the sweep forever.
    expect(verifyPidIsTurnProcess(999_999_999)).toBe(true);
  });

  it("sweepOrphanTurnPids: does NOT kill a live, unrelated process recorded under a stale pidfile (PID reuse)", async () => {
    const { sweepOrphanTurnPids } = await import("../services/recover.js");
    const { spawn } = await import("node:child_process");
    const { writeFile, mkdir: mkdirp } = await import("node:fs/promises");

    // A real, live "sleep" process standing in for a PID that was reused by
    // an unrelated process after a reboot — verifyPidIsTurnProcess must
    // refuse to kill it even though it's recorded in turn.pids.
    const child = spawn("sleep", ["5"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    expect(child.pid).toBeDefined();

    const dataDir = join(tempDir, "projects", "proj-pidsweep", "session-data", "wt-pidsweep", "sess-pidsweep");
    await mkdirp(dataDir, { recursive: true });
    await writeFile(join(dataDir, "turn.pids"), String(child.pid), "utf8");

    try {
      sweepOrphanTurnPids();
      // The process must still be alive — sending signal 0 throws if it's dead.
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("5.T2 — verifyPidIsTurnProcess recognizes the ACP adapter's observed comm name (Decision 7)", async () => {
    const { verifyPidIsTurnProcess } = await import("../services/recover.js");
    const { spawn } = await import("node:child_process");
    const { writeFile, chmod } = await import("node:fs/promises");
    // claude-agent-acp / cursor-agent acp are Bun-bundled binaries empirically
    // observed (Phase 1.6/5.3) to report comm "MainThread", not their own
    // binary name — the allowlist must include it for the sweep to work.
    const scriptPath = join(tempDir, "MainThread");
    await writeFile(scriptPath, "#!/bin/sh\nsleep 5\n", "utf8");
    await chmod(scriptPath, 0o755);
    const child = spawn(scriptPath, [], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(verifyPidIsTurnProcess(child.pid!)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("5.T2 — sweepOrphanTurnPids kills an orphaned ACP connection process (own group) and unlinks turn.pids", async () => {
    const { sweepOrphanTurnPids } = await import("../services/recover.js");
    const { spawn } = await import("node:child_process");
    const { writeFile, mkdir: mkdirp } = await import("node:fs/promises");

    const scriptPath = join(tempDir, "MainThread");
    await writeFile(scriptPath, "#!/bin/sh\nsleep 30\n", "utf8");
    await import("node:fs/promises").then((m) => m.chmod(scriptPath, 0o755));
    const child = spawn(scriptPath, [], { detached: true, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    expect(child.pid).toBeDefined();

    const dataDir = join(tempDir, "projects", "proj-pidsweep", "session-data", "wt-pidsweep", "sess-pidsweep");
    await mkdirp(dataDir, { recursive: true });
    const pidFile = join(dataDir, "turn.pids");
    await writeFile(pidFile, String(child.pid), "utf8");

    sweepOrphanTurnPids();

    // Give the SIGKILL a moment to land, then assert the orphan is gone AND
    // the pidfile was unlinked (both halves of Decision 7's sweep contract).
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(child.pid!, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });
});
