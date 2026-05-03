import { describe, it, expect, vi, beforeEach } from "vitest";
import * as tmuxNs from "../services/tmux.js";
import { spawnSession } from "../services/spawn.js";
import type { AgentPlugin } from "../services/spawn.js";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";

vi.mock("../services/paths.js", () => ({
  worktreePath: () => "/tmp/vrun-spawn-test-wt",
  sessionDataDir: () => "/tmp/vrun-spawn-test-data",
  systemPromptPath: () => "/tmp/vrun-spawn-test-data/system-prompt.md",
  cleanupSessionDataDir: () => {},
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock("../services/tmux.js", () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  hasSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn(),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
}));

describe("spawnSession prompt verification", () => {
  const tmux = vi.mocked(tmuxNs);

  beforeEach(() => {
    vi.clearAllMocks();
    tmux.hasSession.mockResolvedValue(true);
    tmux.capturePane.mockReset();
    tmux.pasteBuffer.mockResolvedValue(undefined);
  });

  function pluginWithMarker(): AgentPlugin {
    return {
      name: "cursor",
      promptDelivery: "post-launch",
      postSentinelDelayMs: 0,
      getLaunchCommand: () => ["true"],
      getEnvironment: () => ({}),
      getReadySignal: () => ({ fallbackMs: 0 }),
      composeLaunchPrompt: ({ sessionId }) => ({
        postLaunchInput: `system\n\n<!-- VRPRMT:${sessionId} -->`,
        launchArgs: undefined,
        useShell: undefined,
        shellLine: undefined,
      }),
    };
  }

  const project = { id: "p1" } as unknown as ProjectRecord;
  const worktree = { id: "w1" } as unknown as WorktreeRecord;

  it("succeeds when first capture contains VRPRMT marker", async () => {
    const session: SessionRecord = {
      id: "s-verify-1",
      slot: "m",
      type: "agent",
      modeId: "m1",
      tmuxName: "tmux-verify-1",
      lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
    };
    tmux.capturePane.mockResolvedValue(`x VRPRMT:${session.id} y`);

    await spawnSession({
      project,
      worktree,
      session,
      plugin: pluginWithMarker(),
      daemonPort: 7421,
      systemPrompt: "sys",
    });

    expect(tmux.pasteBuffer).toHaveBeenCalled();
    expect(tmux.capturePane).toHaveBeenCalled();
  });

  it("retries once when first capture lacks marker", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session: SessionRecord = {
      id: "s-verify-2",
      slot: "m",
      type: "agent",
      modeId: "m1",
      tmuxName: "tmux-verify-2",
      lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
    };
    tmux.capturePane
      .mockResolvedValueOnce("no marker yet")
      .mockResolvedValueOnce(`ok VRPRMT:${session.id}`);

    await spawnSession({
      project,
      worktree,
      session,
      plugin: pluginWithMarker(),
      daemonPort: 7421,
      systemPrompt: "sys",
    });

    expect(tmux.capturePane.mock.calls.length).toBeGreaterThanOrEqual(2);
    warn.mockRestore();
  });

  it("warns when both captures lack marker but does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session: SessionRecord = {
      id: "s-verify-3",
      slot: "m",
      type: "agent",
      modeId: "m1",
      tmuxName: "tmux-verify-3",
      lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
    };
    tmux.capturePane.mockResolvedValue("still nothing");

    await expect(
      spawnSession({
        project,
        worktree,
        session,
        plugin: pluginWithMarker(),
        daemonPort: 7421,
        systemPrompt: "sys",
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
