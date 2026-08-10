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
  clearIdleTracking,
  runLifecyclePollOnce,
} from "../services/lifecycle.js";
import type { ProjectRecord, LifecycleState } from "../types.js";

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
    cleanupSessionDataDir: () => {},
  };
});

vi.mock("../services/tmux.js", () => ({
  hasSession: vi.fn(),
  // The poller takes ONE `list-sessions` snapshot per tick instead of a
  // `tmux has-session` subprocess per session — see `listSessionNames`.
  listSessionNames: vi.fn(),
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
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [],
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
    return broadcaster.broadcastAll.mock.calls
      .map(([msg]) => msg)
      .filter((msg): msg is { type: "session:state"; sessionId: string; state: LifecycleState } =>
        (msg as { type?: string }).type === "session:state",
      )
      .map((msg) => msg.state);
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-lifecycle-test-"));
    await mkdir(join(tempDir, "projects", "proj-l"), { recursive: true });
    await mkdir(join(tempDir, "repo"), { recursive: true });
    _resetIdleTrackingForTest();
    tmux.hasSession.mockReset();
    tmux.listSessionNames.mockReset();
    tmux.capturePane.mockReset();
    broadcaster.notifySession.mockClear();
    broadcaster.broadcastAll.mockClear();
    // "pane-l" is the seeded session's tmuxName — present == alive.
    tmux.listSessionNames.mockResolvedValue(new Set(["pane-l"]));
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
    tmux.listSessionNames.mockResolvedValue(new Set());
    await runLifecyclePollOnce();

    expect(await getCurrentState()).toBe("exited");
    const exitCalls = broadcaster.broadcastAll.mock.calls.filter(
      ([msg]) => (msg as { type?: string }).type === "session:exited",
    );
    expect(exitCalls).toHaveLength(1);

    // Indirect check that the tracking map was cleaned: if we revive the pane
    // and call again, idle hash tracking restarts cleanly without throwing
    // and the session stays exited (poller skips non-working/idle states).
    tmux.listSessionNames.mockResolvedValue(new Set(["pane-l"]));
    tmux.capturePane.mockResolvedValue("second");
    await expect(runLifecyclePollOnce()).resolves.toBeUndefined();
  });

  it("clearIdleTracking prevents a stale hash from an earlier tmux window flipping a freshly-respawned session straight to idle (json-mode-followups toggle bug)", async () => {
    // A tty→json toggle kills the tmux window directly (not via the poller's
    // own exit-detection), so nothing clears this session's tracking entry
    // on its own — this simulates that teardown NOT calling clearIdleTracking.
    await seedProject("working");
    tmux.capturePane.mockResolvedValue("same splash text");
    await runLifecyclePollOnce(); // seeds the tracking entry

    // A later json→tty toggle respawns a NEW tmux window whose first captured
    // lines happen to hash identical to the old one (plausible — same CLI
    // splash/prompt). Without clearing, the STALE stableSince survives.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0 + IDLE_THRESHOLD_MS + 100);
      await runLifecyclePollOnce();
      // Bug reproduced: a fresh window immediately reads as "idle" because
      // the leaked entry's `stableSince` is already older than the threshold.
      expect(await getCurrentState()).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("markSessionExited leaves a `done` session alone (mark-as-done kills the pane on purpose)", async () => {
    await seedProject("done");
    const { markSessionExited } = await import("../services/lifecycle.js");

    // This is exactly what DirectPtyStream.onExit fires after `releaseSessionRuntime`
    // kills the child of a session the user just marked done.
    await markSessionExited("proj-l", "wt-l", "sess-l");

    expect(await getCurrentState()).toBe("done");
    expect(emittedStateChanges()).not.toContain("exited");
    expect(
      broadcaster.broadcastAll.mock.calls.some(
        ([msg]) => (msg as { type?: string }).type === "session:exited",
      ),
    ).toBe(false);
  });

  it("markSessionExited still marks a working session exited", async () => {
    await seedProject("working");
    const { markSessionExited } = await import("../services/lifecycle.js");

    await markSessionExited("proj-l", "wt-l", "sess-l");

    expect(await getCurrentState()).toBe("exited");
  });

  it("clearIdleTracking called at teardown avoids the stale-idle flip on the next respawn", async () => {
    await seedProject("working");
    tmux.capturePane.mockResolvedValue("same splash text");
    await runLifecyclePollOnce(); // seeds the tracking entry

    // The fix: the tty→json teardown path calls this explicitly.
    clearIdleTracking("sess-l");

    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0 + IDLE_THRESHOLD_MS + 100);
      await runLifecyclePollOnce();
      // No leaked entry → this poll is treated as the FIRST sighting of the
      // new window (idleTracking.ts: `if (!entry) { ...; return; }`), so it
      // does not immediately flip to idle.
      expect(await getCurrentState()).toBe("working");
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Regressions: the poller's tmux subprocess storm (PR #39 fallout) ---

  it("takes ONE tmux liveness snapshot per tick, not one subprocess per session", async () => {
    // This is the regression that made the whole daemon unusable: `pollSession`
    // ran `tmux has-session` per session per second (230 subprocesses/second on
    // the reporting user's install). fork() cost scales with the daemon's RSS,
    // so that consumed >50% of the event loop and every keystroke, tab switch
    // and tab-bar fetch queued behind it.
    await seedProject("working");
    tmux.capturePane.mockResolvedValue("output");

    await runLifecyclePollOnce();

    expect(tmux.listSessionNames).toHaveBeenCalledTimes(1);
    expect(tmux.hasSession).not.toHaveBeenCalled();
  });

  it("never probes liveness for done/exited sessions", async () => {
    // 175 of the user's 237 sessions were done/exited. The old code spawned
    // `has-session` for each of them every tick and then did nothing with the
    // answer — every branch below the check excludes those two states.
    for (const state of ["done", "exited"] as const) {
      await seedProject(state);
      tmux.capturePane.mockReset();
      await runLifecyclePollOnce();
      expect(await getCurrentState()).toBe(state);
      // No pane capture either — a terminal-state session is fully skipped.
      expect(tmux.capturePane).not.toHaveBeenCalled();
    }
  });

  it("skips the tick when tmux fails unexpectedly, instead of mass-marking every session exited", async () => {
    // `listSessionNames` returns null for a failure it cannot interpret. If a
    // transient tmux error collapsed to "no sessions", one hiccup would mark
    // every session exited — hundreds of broadcasts and DB writes — and blank
    // the user's whole workspace.
    await seedProject("working");
    tmux.capturePane.mockResolvedValue("output");
    tmux.listSessionNames.mockResolvedValue(null);

    await runLifecyclePollOnce();

    expect(await getCurrentState()).toBe("working");
    const exitCalls = broadcaster.broadcastAll.mock.calls.filter(
      ([msg]) => (msg as { type?: string }).type === "session:exited",
    );
    expect(exitCalls).toHaveLength(0);
  });

  it("still marks sessions exited when tmux reports no server running (empty set)", async () => {
    // The counterpart to the above: an EMPTY set is authoritative ("no server
    // running" really does mean everything is gone) and must still be acted on.
    await seedProject("working");
    tmux.capturePane.mockResolvedValue("output");
    tmux.listSessionNames.mockResolvedValue(new Set());

    await runLifecyclePollOnce();

    expect(await getCurrentState()).toBe("exited");
  });
});
