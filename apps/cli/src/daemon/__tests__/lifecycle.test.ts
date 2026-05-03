import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tmuxNs from "../services/tmux.js";
import * as broadcasterNs from "../broadcaster.js";
import {
  CAPTURE_LINES,
  IDLE_THRESHOLD_MS,
  POLL_INTERVAL_MS,
  _resetIdleTrackingForTest,
  runLifecyclePollOnce,
} from "../services/lifecycle.js";
import type { ProjectRecord, LifecycleState } from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vrunHome: () => tempDir,
    projectDir: (id: string) => pathJoin(tempDir, "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) =>
      pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    cleanupSessionDataDir: () => {},
  };
});

vi.mock("../services/tmux.js", () => ({
  hasSession: vi.fn(),
  capturePane: vi.fn(),
}));

vi.mock("../broadcaster.js", () => ({
  notifySession: vi.fn(),
  broadcastAll: vi.fn(),
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn(),
}));

describe("lifecycle idle detector configuration", () => {
  it("uses a 4s idle stability window", () => {
    expect(IDLE_THRESHOLD_MS).toBe(4000);
  });

  it("captures a multi-line pane window", () => {
    expect(CAPTURE_LINES).toBe(20);
  });

  it("polls near 1 Hz", () => {
    expect(POLL_INTERVAL_MS).toBe(1000);
  });
});

describe("lifecycle polling behavior", () => {
  const tmux = vi.mocked(tmuxNs);
  const broadcaster = vi.mocked(broadcasterNs);

  async function seedProject(initialState: LifecycleState = "working"): Promise<void> {
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    const record: ProjectRecord = {
      id: "proj-l",
      absolutePath: join(tempDir, "repo"),
      prefix: "pfx",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      worktrees: [
        {
          id: "wt-l",
          branch: "b",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          createdAt: new Date().toISOString(),
          sessions: [
            {
              id: "sess-l",
              slot: "m",
              type: "agent",
              modeId: "mode",
              tmuxName: "pane-l",
              lifecycle: {
                state: initialState,
                lastTransitionAt: new Date().toISOString(),
              },
            },
          ],
        },
      ],
    };
    await addProject(record);
  }

  async function getCurrentState(): Promise<LifecycleState> {
    const { getProject } = await import("../state/project-store.js");
    return getProject("proj-l")!.worktrees[0]!.sessions[0]!.lifecycle.state;
  }

  function emittedStateChanges(): LifecycleState[] {
    return broadcaster.notifySession.mock.calls
      .map(([, msg]) => msg)
      .filter((msg): msg is { type: "session:state"; sessionId: string; state: LifecycleState } =>
        (msg as { type?: string }).type === "session:state",
      )
      .map((msg) => msg.state);
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vrun-lifecycle-test-"));
    await mkdir(join(tempDir, "projects", "proj-l"), { recursive: true });
    await mkdir(join(tempDir, "repo"), { recursive: true });
    _resetIdleTrackingForTest();
    tmux.hasSession.mockReset();
    tmux.capturePane.mockReset();
    broadcaster.notifySession.mockClear();
    tmux.hasSession.mockResolvedValue(true);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("stays working while pane content changes each tick", async () => {
    await seedProject("working");
    let counter = 0;
    tmux.capturePane.mockImplementation(async () => `output line ${counter++}`);

    for (let i = 0; i < 6; i++) {
      await runLifecyclePollOnce();
    }

    expect(await getCurrentState()).toBe("working");
    expect(emittedStateChanges()).not.toContain("idle");
  });

  it("transitions to idle after IDLE_THRESHOLD_MS of unchanged content", async () => {
    await seedProject("working");
    tmux.capturePane.mockResolvedValue("frozen pane content");

    // First tick seeds the tracking entry (stableSince = now). Subsequent ticks
    // observe the same hash; stableAge crosses IDLE_THRESHOLD_MS once we wait
    // past it. Use fake timers so the test is deterministic.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0);
      await runLifecyclePollOnce(); // seed

      vi.setSystemTime(t0 + IDLE_THRESHOLD_MS + 100);
      await runLifecyclePollOnce(); // should flip to idle
    } finally {
      vi.useRealTimers();
    }

    expect(await getCurrentState()).toBe("idle");
    expect(emittedStateChanges()).toContain("idle");
  });

  it("resets to working when content changes after idle", async () => {
    await seedProject("working");
    tmux.capturePane.mockResolvedValue("static");

    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0);
      await runLifecyclePollOnce();
      vi.setSystemTime(t0 + IDLE_THRESHOLD_MS + 100);
      await runLifecyclePollOnce();
      expect(await getCurrentState()).toBe("idle");

      tmux.capturePane.mockResolvedValue("now changing");
      vi.setSystemTime(t0 + IDLE_THRESHOLD_MS + 200);
      await runLifecyclePollOnce();
    } finally {
      vi.useRealTimers();
    }

    expect(await getCurrentState()).toBe("working");
    const changes = emittedStateChanges();
    expect(changes).toContain("idle");
    expect(changes).toContain("working");
    expect(changes.lastIndexOf("working")).toBeGreaterThan(changes.indexOf("idle"));
  });

  it("deletes tracking entry when pane disappears (session exit)", async () => {
    await seedProject("working");
    tmux.capturePane.mockResolvedValue("first");

    // Seed an entry in the tracking map.
    await runLifecyclePollOnce();

    // Now the tmux pane disappears. The poller should broadcast session:exited
    // and clean up the tracking entry.
    tmux.hasSession.mockResolvedValue(false);
    await runLifecyclePollOnce();

    expect(await getCurrentState()).toBe("exited");
    const exitCalls = broadcaster.notifySession.mock.calls.filter(
      ([, msg]) => (msg as { type?: string }).type === "session:exited",
    );
    expect(exitCalls).toHaveLength(1);

    // Indirect check that the tracking map was cleaned: if we revive the pane
    // and call again, idle hash tracking restarts cleanly without throwing
    // and the session stays exited (poller skips non-working/idle states).
    tmux.hasSession.mockResolvedValue(true);
    tmux.capturePane.mockResolvedValue("second");
    await expect(runLifecyclePollOnce()).resolves.toBeUndefined();
  });
});
