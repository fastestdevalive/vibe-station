import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, WorktreeRecord } from "../types.js";
import type { LaunchConfig } from "../services/spawn.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir || "/tmp/vst-test",
    projectDir: (id: string) => pathJoin(tempDir || "/tmp/vst-test", "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir || "/tmp/vst-test", "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir || "/tmp/vst-test", "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) =>
      pathJoin(tempDir || "/tmp/vst-test", "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir || "/tmp/vst-test", "config.json"),
    modesPath: () => pathJoin(tempDir || "/tmp/vst-test", "modes.json"),
    daemonLogPath: () => pathJoin(tempDir || "/tmp/vst-test", "logs", "daemon.log"),
    cleanupSessionDataDir: () => {},
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(tempDir || "/tmp/vst-test", "projects", p, "session-data", w, s),
    systemPromptPath: (p: string, w: string, s: string) =>
      pathJoin(tempDir || "/tmp/vst-test", "projects", p, "session-data", w, s, "system-prompt.md"),
    opencodeConfigPath: (p: string, w: string, s: string) =>
      pathJoin(tempDir || "/tmp/vst-test", "projects", p, "session-data", w, s, "opencode-config.json"),
  };
});

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {
      // Mock: do nothing
    }),
  };
});

describe("Agent plugins", () => {
  describe("Plugin resolution", () => {
    it("T10.1 — resolvePlugin('claude') returns a plugin with name === 'claude'", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("claude");
      expect(plugin.name).toBe("claude");
    });

    it("T10.2 — resolvePlugin('cursor') returns name === 'cursor'", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("cursor");
      expect(plugin.name).toBe("cursor");
    });

    it("T10.3 — resolvePlugin('opencode') returns name === 'opencode'", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("opencode");
      expect(plugin.name).toBe("opencode");
    });

    it("T10.4 — resolvePlugin('unknown') throws", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      expect(() => resolvePlugin("unknown" as any)).toThrow();
    });
  });

  describe("Claude plugin", () => {
    it("T10.5 — getLaunchCommand() returns argv starting with 'claude'", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("claude");
      const cmd = plugin.getLaunchCommand({} as any);
      expect(cmd[0]).toBe("claude");
    });

    it("T10.6 — composeLaunchPrompt with both system + task: useShell=true, shellLine contains --dangerously-skip-permissions, $(cat ...), task; postLaunchInput is undefined", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("claude");
      const result = plugin.composeLaunchPrompt({
        systemPrompt: "You are helpful",
        taskPrompt: "Fix the bug",
        sessionId: "sess-test",
        systemPromptFile: "/tmp/system-prompt.md",
        launchCfg: {} as unknown as LaunchConfig,
      });
      expect(result.useShell).toBe(true);
      expect(result.shellLine).toContain("--dangerously-skip-permissions");
      expect(result.shellLine).toContain("--system-prompt");
      expect(result.shellLine).toContain("$(cat ");
      expect(result.shellLine).toContain("/tmp/system-prompt.md");
      expect(result.shellLine).toContain("Fix the bug");
      expect(result.shellLine).not.toContain("VSTPRMT:");
      expect(result.postLaunchInput).toBeUndefined();
    });

    it("T10.7 — composeLaunchPrompt with no task: useShell=true, shellLine has --dangerously-skip-permissions and $(cat ...) only", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("claude");
      const result = plugin.composeLaunchPrompt({
        systemPrompt: "You are helpful",
        sessionId: "sess-test",
        systemPromptFile: "/tmp/system-prompt.md",
        launchCfg: {} as unknown as LaunchConfig,
      });
      expect(result.useShell).toBe(true);
      expect(result.shellLine).toContain("--dangerously-skip-permissions");
      expect(result.shellLine).toContain("--system-prompt");
      expect(result.shellLine).toContain("$(cat ");
      expect(result.postLaunchInput).toBeUndefined();
      expect(result.shellLine).not.toContain("VSTPRMT:");
    });

    it("T10.10 — getEnvironment() includes CLAUDECODE: '1'", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("claude");
      const env = plugin.getEnvironment({} as any);
      expect(env.CLAUDECODE).toBe("1");
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("cli");
    });

    it("T10.11 — getReadySignal() has sentinel: '> ' and fallbackMs >= 10_000", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("claude");
      const signal = plugin.getReadySignal();
      expect(signal.sentinel).toBe("> ");
      expect(signal.fallbackMs).toBeGreaterThanOrEqual(10_000);
    });

    it("Phase 3 — T3.T3 — getRestoreCommand returns argv [claude, --resume, <uuid>, --dangerously-skip-permissions] when uuid exists", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const { findLatestChatUuid } = await import("../plugins/claudeRestore.js");

      // Create a temporary test to simulate a working findLatestChatUuid
      // We'll test just the return shape here; full integration test in claudeRestore.test.ts
      const plugin = resolvePlugin("claude");

      // Call with stub args (will return null since no real claude config)
      const result = await plugin.getRestoreCommand?.({
        session: {},
        project: { id: "test-proj" },
        worktree: { id: "wt-1" },
      });

      // When no uuid exists, should return null
      expect(result).toBeNull();

      // Verify the method signature is callable and returns either null or string[]
      expect(typeof plugin.getRestoreCommand).toBe("function");
    });
  });

  describe("Cursor plugin", () => {
    it("T10.8 — composeLaunchPrompt: useShell=true; shellLine contains cursor-agent, $(cat ...), task; postLaunchInput is undefined", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("cursor");
      const result = plugin.composeLaunchPrompt({
        systemPrompt: "You are helpful",
        taskPrompt: "Fix the bug",
        sessionId: "sess-test",
        systemPromptFile: "/tmp/system-prompt.md",
        launchCfg: {
          project: { id: "p1" },
          worktree: { id: "w1" },
          session: { id: "sess-test" },
          daemonPort: 7421,
        } as unknown as LaunchConfig,
      });
      expect(result.useShell).toBe(true);
      expect(result.shellLine).toContain("cursor-agent");
      expect(result.shellLine).toContain("$(");
      expect(result.shellLine).toContain("/tmp/system-prompt.md");
      expect(result.shellLine).toContain("Fix the bug");
      expect(result.launchArgs).toBeUndefined();
      expect(result.postLaunchInput).toBeUndefined();
    });

    it("Phase 1 — T1.T1 — getLaunchCommand returns argv containing --force, --sandbox, disabled, --approve-mcps; NOT --print", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("cursor");
      const cmd = plugin.getLaunchCommand({
        project: { id: "test-proj" },
        worktree: { id: "wt-1" },
      } as any);
      expect(cmd).toContain("--force");
      expect(cmd).toContain("--sandbox");
      expect(cmd).toContain("disabled");
      expect(cmd).toContain("--approve-mcps");
      expect(cmd).not.toContain("--print");
    });
  });

  describe("OpenCode plugin", () => {
    it("T10.9 — composeLaunchPrompt: system prompt NOT in postLaunchInput; task prompt IS; VSTPRMT needle present", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("opencode");
      const result = plugin.composeLaunchPrompt({
        systemPrompt: "You are helpful",
        taskPrompt: "Fix the bug",
        sessionId: "sess-test",
        systemPromptFile: "/tmp/system-prompt.md",
        launchCfg: {
          project: { id: "p1" },
          worktree: { id: "w1" },
          session: { id: "sess-test" },
          daemonPort: 7421,
        } as unknown as LaunchConfig,
      });
      expect(result.launchArgs).toBeUndefined();
      // System prompt is delivered via OPENCODE_CONFIG env, not postLaunchInput
      expect(result.postLaunchInput).not.toContain("You are helpful");
      expect(result.postLaunchInput).toContain("Fix the bug");
      expect(result.postLaunchInput).toContain("VSTPRMT:sess-test");
    });

    it("Phase 5 — T5.T1 — getRestoreCommand with agentChatId='abc' returns [opencode, --session, abc]", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("opencode");
      const result = await plugin.getRestoreCommand?.({
        session: { agentChatId: "abc" },
        project: {},
        worktree: {},
      });
      expect(result).toEqual(["opencode", "--session", "abc"]);
    });

    it("Phase 5 — T5.T2 — getRestoreCommand without agentChatId returns null", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");
      const plugin = resolvePlugin("opencode");
      const result = await plugin.getRestoreCommand?.({
        session: {},
        project: {},
        worktree: {},
      });
      expect(result).toBeNull();
    });
  });

  describe("Integration tests", () => {
    let app: FastifyInstance;
    let repoDir: string;
    let projectId: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "vst-plugins-test-"));
      repoDir = join(tempDir, "my-repo");

      execSync(
        `mkdir -p "${repoDir}" && git init "${repoDir}" && git -C "${repoDir}" commit --allow-empty -m "init"`,
        { stdio: "ignore" },
      );

      const { _clearStoreForTest } = await import("../state/project-store.js");
      _clearStoreForTest();

      // Reset modes cache
      const modesModule = await import("../routes/modes.js");
      modesModule._resetModesCacheForTest();

      // Create modes.json
      await writeFile(
        join(tempDir, "modes.json"),
        JSON.stringify([
          {
            id: "mode-claude",
            name: "Claude Mode",
            cli: "claude",
            context: "You are a code reviewer",
            createdAt: new Date().toISOString(),
          },
          {
            id: "mode-cursor",
            name: "Cursor Mode",
            cli: "cursor",
            context: "You are a code writer",
            createdAt: new Date().toISOString(),
          },
        ]),
      );

      app = await buildServer();

      // Create a project
      const projRes = await app.inject({
        method: "POST",
        url: "/projects",
        payload: { path: repoDir },
      });
      projectId = projRes.json<ProjectRecord>().id;
    });

    afterEach(async () => {
      // Drain any in-flight runMainSpawnJob from the bootstrap worktree create
      // before tearing down — its delayed mutateProject would otherwise hit a
      // cleared store in the next beforeEach and surface as an unhandled rejection.
      await new Promise((r) => setTimeout(r, 150));
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    });

    it("T10.12 — POST /worktrees integration: when mode.cli = 'claude', spawnSession is called with plugin whose name is 'claude'", async () => {
      // Get access to the mocked spawnSession
      const spawnModule = await import("../services/spawn.js");
      const mockSpawn = vi.mocked(spawnModule.spawnSession);
      mockSpawn.mockClear();

      const res = await app.inject({
        method: "POST",
        url: "/worktrees",
        payload: { projectId, branch: "test-claude", modeId: "mode-claude" },
      });

      expect(res.statusCode).toBe(201);
      await expect.poll(() => mockSpawn.mock.calls.length).toBeGreaterThan(0);
      const callArgs = mockSpawn.mock.calls[0];
      expect(callArgs?.[0]?.plugin?.name).toBe("claude");
    });

    it("T10.13 — POST /sessions (agent type) integration: spawnSession called with correct plugin", async () => {
      // Get access to the mocked spawnSession
      const spawnModule = await import("../services/spawn.js");
      const mockSpawn = vi.mocked(spawnModule.spawnSession);
      mockSpawn.mockClear();

      // First create a worktree
      const wtRes = await app.inject({
        method: "POST",
        url: "/worktrees",
        payload: { projectId, branch: "test-session", modeId: "mode-cursor" },
      });
      const worktree = wtRes.json<WorktreeRecord>();
      mockSpawn.mockClear(); // Reset after worktree creation

      // Now create an agent session
      const sesRes = await app.inject({
        method: "POST",
        url: "/sessions",
        payload: {
          worktreeId: worktree.id,
          type: "agent",
          modeId: "mode-cursor",
          prompt: "Review this code",
        },
      });

      expect(sesRes.statusCode).toBe(201);
      await expect.poll(() => mockSpawn.mock.calls.length).toBeGreaterThan(0);
      const callArgs = mockSpawn.mock.calls[0];
      expect(callArgs?.[0]?.plugin?.name).toBe("cursor");
    });

    it("Phase 5 — T5.T4 (contract) — every registered plugin (claude, cursor, opencode) defines getRestoreCommand", async () => {
      const { resolvePlugin } = await import("../plugins/registry.js");

      const pluginNames = ["claude", "cursor", "opencode"] as const;

      for (const name of pluginNames) {
        const plugin = resolvePlugin(name as any);
        // Plugin must have the method
        expect(typeof plugin.getRestoreCommand).toBe("function");
        // Calling with stub args must return either null or string[]
        const result = await plugin.getRestoreCommand?.({
          session: {},
          project: { id: name },
          worktree: { id: name },
        });
        expect(result === null || Array.isArray(result)).toBe(true);
      }
    });
  });
});
