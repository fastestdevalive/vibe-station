import { describe, it, expect, vi, beforeEach } from "vitest";
import * as tmuxNs from "../services/tmux.js";
import { spawnSession } from "../services/spawn.js";
import type { AgentPlugin } from "../services/spawn.js";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";

vi.mock("../services/paths.js", () => ({
  worktreePath: () => "/tmp/vst-spawn-test-wt",
  sessionDataDir: () => "/tmp/vst-spawn-test-data",
  systemPromptPath: () => "/tmp/vst-spawn-test-data/system-prompt.md",
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
        postLaunchInput: `system\n\n<!-- VSTPRMT:${sessionId} -->`,
        launchArgs: undefined,
        useShell: undefined,
        shellLine: undefined,
      }),
    };
  }

  const project = { id: "p1" } as unknown as ProjectRecord;
  const worktree = { id: "w1" } as unknown as WorktreeRecord;

  it("succeeds when first capture contains VSTPRMT marker", async () => {
    const session: SessionRecord = {
      id: "s-verify-1",
      slot: "m",
      type: "agent",
      modeId: "m1",
      tmuxName: "tmux-verify-1",
      useTmux: true,
      lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
    };
    tmux.capturePane.mockResolvedValue(`x VSTPRMT:${session.id} y`);

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
      useTmux: true,
      lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
    };
    tmux.capturePane
      .mockResolvedValueOnce("no marker yet")
      .mockResolvedValueOnce(`ok VSTPRMT:${session.id}`);

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
      useTmux: true,
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

describe("spawnSession chat-id hooks", () => {
  const tmux = vi.mocked(tmuxNs);

  beforeEach(() => {
    vi.clearAllMocks();
    tmux.hasSession.mockResolvedValue(true);
    tmux.capturePane.mockResolvedValue("");
    tmux.pasteBuffer.mockResolvedValue(undefined);
  });

  const project = { id: "p1" } as unknown as ProjectRecord;
  const worktree = { id: "w1" } as unknown as WorktreeRecord;

  function baseSession(id: string): SessionRecord {
    return {
      id,
      slot: "m",
      type: "agent",
      modeId: "m1",
      tmuxName: `tmux-${id}`,
      useTmux: true,
      lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
    };
  }

  function minimalPlugin(): AgentPlugin {
    return {
      name: "test",
      promptDelivery: "inline",
      getLaunchCommand: () => ["true"],
      getEnvironment: () => ({}),
      getReadySignal: () => ({ fallbackMs: 0 }),
      composeLaunchPrompt: () => ({ launchArgs: undefined, postLaunchInput: undefined }),
    };
  }

  it("1.T5 — VST_SPAWN_TOKEN appears in env passed to newSession", async () => {
    const session = baseSession("s-token-1");
    await spawnSession({
      project, worktree, session,
      plugin: minimalPlugin(),
      daemonPort: 7421,
      systemPrompt: "sys",
    });
    const callEnv = tmux.newSession.mock.calls[0]?.[0]?.env as Record<string, string>;
    expect(callEnv?.VST_SPAWN_TOKEN).toBe(session.id);
  });

  it("1.T2 — provideChatId result sets session.agentChatId before spawn", async () => {
    const session = baseSession("s-provide-1");
    const provideChatId = vi.fn().mockResolvedValue("pre-minted-uuid");
    const plugin: AgentPlugin = { ...minimalPlugin(), provideChatId };

    await spawnSession({ project, worktree, session, plugin, daemonPort: 7421, systemPrompt: "sys" });

    expect(provideChatId).toHaveBeenCalled();
    expect(session.agentChatId).toBe("pre-minted-uuid");
  });

  it("1.T3 — captureChatId result sets session.agentChatId after spawn", async () => {
    const session = baseSession("s-capture-1");
    const captureChatId = vi.fn().mockResolvedValue("captured-uuid");
    const plugin: AgentPlugin = { ...minimalPlugin(), captureChatId };

    await spawnSession({ project, worktree, session, plugin, daemonPort: 7421, systemPrompt: "sys" });

    expect(captureChatId).toHaveBeenCalled();
    expect(session.agentChatId).toBe("captured-uuid");
  });

  it("1.T4 — plugin with no hooks: agentChatId not set, spawn proceeds normally", async () => {
    const session = baseSession("s-nohooks-1");
    await spawnSession({ project, worktree, session, plugin: minimalPlugin(), daemonPort: 7421, systemPrompt: "sys" });
    expect(tmux.newSession).toHaveBeenCalled();
    expect(session.agentChatId).toBeUndefined();
  });

  it("1.T2b — provideChatId returning null does not set agentChatId", async () => {
    const session = baseSession("s-provide-null");
    const provideChatId = vi.fn().mockResolvedValue(null);
    const plugin: AgentPlugin = { ...minimalPlugin(), provideChatId };

    await spawnSession({ project, worktree, session, plugin, daemonPort: 7421, systemPrompt: "sys" });

    expect(session.agentChatId).toBeUndefined();
  });
});
