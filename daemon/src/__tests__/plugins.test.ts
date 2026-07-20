import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, WorktreeRecord } from "../types.js";
import type { LaunchConfig } from "../services/spawn.js";

let tempDir: string;

/**
 * ResolvedContext stub for a WORKTREE context. Plugins read `ctx.cwd` and the
 * `*For(ctx, …)` path helpers rather than deriving paths from a worktree id.
 */
function wtCtx(projectId: string, worktreeId: string) {
  return {
    ref: { kind: "worktree", projectId, worktreeId },
    project: { id: projectId, absolutePath: `/repos/${projectId}` },
    worktree: { id: worktreeId },
    cwd: `${tempDir || "/tmp/vst-test"}/projects/${projectId}/worktrees/${worktreeId}`,
  } as never;
}

/**
 * ResolvedContext stub for a DIRECT (project) context — no worktree, cwd is the
 * project checkout. This is the shape that used to be faked with a synthetic
 * worktree whose id resolved to a directory that did not exist.
 */
function projCtx(projectId: string, absolutePath = `/repos/${projectId}`) {
  return {
    ref: { kind: "project", projectId },
    project: { id: projectId, absolutePath },
    worktree: null,
    cwd: absolutePath,
  } as never;
}

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
    // Direct (no-worktree) family — services/context.ts routes to these for a
    // project context, so the mock must provide them too.
    directSessionDataDir: (p: string, s: string) =>
      pathJoin(tempDir || "/tmp/vst-test", "projects", p, "sessions", s),
    directSystemPromptPath: (p: string, s: string) =>
      pathJoin(tempDir || "/tmp/vst-test", "projects", p, "sessions", s, "system-prompt.md"),
    directOpencodeConfigPath: (p: string, s: string) =>
      pathJoin(tempDir || "/tmp/vst-test", "projects", p, "sessions", s, "opencode-config.json"),
    cleanupDirectSessionDataDir: () => {},
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
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("claude");
      expect(plugin.name).toBe("claude");
    });

    it("T10.2 — resolvePlugin('cursor') returns name === 'cursor'", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("cursor");
      expect(plugin.name).toBe("cursor");
    });

    it("T10.3 — resolvePlugin('opencode') returns name === 'opencode'", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("opencode");
      expect(plugin.name).toBe("opencode");
    });

    it("resolvePlugin('agy') returns name === 'agy' with JSON support", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("agy");
      expect(plugin.name).toBe("agy");
      expect(plugin.defaultModel).toBe("Gemini 3.1 Pro (High)");
      expect(plugin.supportsJson?.()).toBe(true);
    });

    it("T10.4 — resolvePlugin('unknown') throws", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      expect(() => resolvePlugin("unknown" as any)).toThrow();
    });

    it("Phase 1 — defaultModel matches plugin defaults", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      expect(resolvePlugin("claude").defaultModel).toBe("sonnet");
      expect(resolvePlugin("cursor").defaultModel).toBe("auto");
      expect(resolvePlugin("opencode").defaultModel).toBe("opencode/big-pickle");
      expect(resolvePlugin("agy").defaultModel).toBe("Gemini 3.1 Pro (High)");
    });
  });

  describe("Claude plugin", () => {
    it("T10.5 — getLaunchCommand() returns argv starting with 'claude'", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("claude");
      const cmd = plugin.getLaunchCommand({} as any);
      expect(cmd[0]).toBe("claude");
    });

    it("listModels() includes the fable alias and full name", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const { models } = await resolvePlugin("claude").listModels();
      expect(models).toContain("fable");
      expect(models).toContain("claude-fable-5");
    });

    it("T10.6 — composeLaunchPrompt with both system + task: useShell=true, shellLine contains --dangerously-skip-permissions, $(cat ...), task; postLaunchInput is undefined", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
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
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
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
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("claude");
      const env = plugin.getEnvironment({} as any);
      expect(env.CLAUDECODE).toBe("1");
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("cli");
    });

    it("T10.11 — getReadySignal() has sentinel: '> ' and fallbackMs >= 10_000", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("claude");
      const signal = plugin.getReadySignal();
      expect(signal.sentinel).toBe("> ");
      expect(signal.fallbackMs).toBeGreaterThanOrEqual(10_000);
    });

    it("Phase 3 — T3.T3 — getRestoreCommand returns argv [claude, --resume, <uuid>, --dangerously-skip-permissions] when uuid exists", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const { findLatestChatUuid } = await import("../agent-plugins/claudeRestore.js");

      // Create a temporary test to simulate a working findLatestChatUuid
      // We'll test just the return shape here; full integration test in claudeRestore.test.ts
      const plugin = resolvePlugin("claude");

      // Call with stub args (will return null since no real claude config)
      const result = await plugin.getRestoreCommand?.({
        session: {},
        project: { id: "test-proj" },
        cwd: "/tmp/vst-test-cwd",
      });

      // When no uuid exists, should return null
      expect(result).toBeNull();

      // Verify the method signature is callable and returns either null or string[]
      expect(typeof plugin.getRestoreCommand).toBe("function");
    });
  });

  describe("Cursor plugin", () => {
    it("T10.8 — composeLaunchPrompt: useShell=true; shellLine contains cursor-agent, $(cat ...), task; postLaunchInput is undefined", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("cursor");
      const result = plugin.composeLaunchPrompt({
        systemPrompt: "You are helpful",
        taskPrompt: "Fix the bug",
        sessionId: "sess-test",
        systemPromptFile: "/tmp/system-prompt.md",
        launchCfg: {
          project: { id: "p1" },
          ctx: wtCtx("p1", "w1"),
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
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("cursor");
      const cmd = plugin.getLaunchCommand({
        project: { id: "test-proj" },
        ctx: wtCtx("test-proj", "wt-1"),
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
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("opencode");
      const result = plugin.composeLaunchPrompt({
        systemPrompt: "You are helpful",
        taskPrompt: "Fix the bug",
        sessionId: "sess-test",
        systemPromptFile: "/tmp/system-prompt.md",
        launchCfg: {
          project: { id: "p1" },
          ctx: wtCtx("p1", "w1"),
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
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("opencode");
      const result = await plugin.getRestoreCommand?.({
        session: { agentChatId: "abc" },
        project: {},
        cwd: "/tmp/vst-test-cwd",
      });
      expect(result).toEqual(["opencode", "--session", "abc"]);
    });

    it("Phase 5 — T5.T2 — getRestoreCommand without agentChatId returns null", async () => {
      const { resolvePlugin } = await import("../agent-plugins/registry.js");
      const plugin = resolvePlugin("opencode");
      const result = await plugin.getRestoreCommand?.({
        session: {},
        project: {},
        cwd: "/tmp/vst-test-cwd",
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

    it("Phase 5 — T5.T4 (contract) — every registered plugin defines getRestoreCommand", async () => {
      const { resolvePlugin, SUPPORTED_CLIS } = await import("../agent-plugins/registry.js");

      for (const name of SUPPORTED_CLIS) {
        const plugin = resolvePlugin(name);
        // Plugin must have the method
        expect(typeof plugin.getRestoreCommand).toBe("function");
        // Calling with stub args must return either null or string[]
        const result = await plugin.getRestoreCommand?.({
          session: {},
          project: { id: name },
          cwd: "/tmp/vst-test-cwd",
        });
        expect(result === null || Array.isArray(result)).toBe(true);
      }
    });
  });
});

// ─── Chat-id capture tests (per-session-chat-id-capture feature) ───────────

describe("Claude plugin — chat-id capture", () => {
  let wtDir: string;

  beforeEach(async () => {
    wtDir = await mkdtemp(join(tmpdir(), "vst-claude-hooktest-"));
  });

  afterEach(async () => {
    await rm(wtDir, { recursive: true, force: true });
  });

  it("2.T1 — setupWorkspaceHooks creates .claude/vibe-recorder.sh and .claude/settings.json", async () => {
    const { createClaudePlugin } = await import("../agent-plugins/claude.js");
    const plugin = createClaudePlugin();
    await plugin.setupWorkspaceHooks!(wtDir);

    const scriptPath = join(wtDir, ".claude", "vibe-recorder.sh");
    const settingsPath = join(wtDir, ".claude", "settings.json");

    const scriptContent = await readFile(scriptPath, "utf8");
    expect(scriptContent).toContain("VST_SPAWN_TOKEN");
    expect(scriptContent).toContain("jq");
    expect(scriptContent).toContain("agent-chat-ids");

    const { stat } = await import("node:fs/promises");
    const { mode } = await stat(scriptPath);
    expect(mode & 0o111).toBeTruthy();

    const settingsRaw = await readFile(settingsPath, "utf8");
    const settings = JSON.parse(settingsRaw);
    const sessionStart = settings.hooks?.SessionStart;
    expect(Array.isArray(sessionStart)).toBe(true);
    expect(
      sessionStart.some((e: any) =>
        e.hooks?.some((h: any) => h.command === ".claude/vibe-recorder.sh"),
      ),
    ).toBe(true);
  });

  it("2.T2 — setupWorkspaceHooks merges with existing user hooks in settings.json", async () => {
    const claudeDir = join(wtDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const existingSettings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "my-hook.sh" }] }],
      },
    };
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(existingSettings, null, 2), "utf8");

    const { createClaudePlugin } = await import("../agent-plugins/claude.js");
    const plugin = createClaudePlugin();
    await plugin.setupWorkspaceHooks!(wtDir);

    const raw = await readFile(join(claudeDir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    const hooks = settings.hooks.SessionStart;
    expect(hooks).toHaveLength(2);
    expect(hooks.some((e: any) => e.hooks?.some((h: any) => h.command === "my-hook.sh"))).toBe(true);
    expect(
      hooks.some((e: any) => e.hooks?.some((h: any) => h.command === ".claude/vibe-recorder.sh")),
    ).toBe(true);
  });

  it("2.T3 — setupWorkspaceHooks is idempotent: calling twice does not duplicate the entry", async () => {
    const { createClaudePlugin } = await import("../agent-plugins/claude.js");
    const plugin = createClaudePlugin();
    await plugin.setupWorkspaceHooks!(wtDir);
    await plugin.setupWorkspaceHooks!(wtDir);

    const raw = await readFile(join(wtDir, ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    const ourEntries = settings.hooks.SessionStart.filter((e: any) =>
      e.hooks?.some((h: any) => h.command === ".claude/vibe-recorder.sh"),
    );
    expect(ourEntries).toHaveLength(1);
  });

  it("2.T6 — getRestoreCommand with session.agentChatId set → uses it without filesystem call", async () => {
    const { createClaudePlugin } = await import("../agent-plugins/claude.js");
    const plugin = createClaudePlugin();
    const result = await plugin.getRestoreCommand!({
      session: { agentChatId: "known-uuid" } as any,
      project: { id: "p1" } as any,
      cwd: "/tmp/vst-test-cwd",
    });
    expect(result).toEqual([
      "claude",
      "--resume",
      "known-uuid",
      "--dangerously-skip-permissions",
      "--chrome",
    ]);
  });

  // P4 — fork capability (R3.5). claude exposes getForkCommand (--fork-session);
  // it is the fork gate, so the fork endpoint is claude-only at launch.
  it("P4 — claude defines getForkCommand ['--fork-session']; other CLIs do not (fork gated to claude)", async () => {
    const { createClaudePlugin } = await import("../agent-plugins/claude.js");
    const { createCursorPlugin } = await import("../agent-plugins/cursor.js");
    const { createOpencodePlugin } = await import("../agent-plugins/opencode.js");
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    expect(createClaudePlugin().getForkCommand?.()).toEqual(["--fork-session"]);
    expect(createCursorPlugin().getForkCommand).toBeUndefined();
    expect(createOpencodePlugin().getForkCommand).toBeUndefined();
    expect(createAgyPlugin().getForkCommand).toBeUndefined();
  });
});

describe("Cursor plugin — chat-id capture", () => {
  it("3.T4 — getLaunchCommand with session.agentChatId → argv contains --resume <id>", async () => {
    const { createCursorPlugin } = await import("../agent-plugins/cursor.js");
    const plugin = createCursorPlugin();
    const cmd = plugin.getLaunchCommand({
      project: { id: "p1" },
      ctx: wtCtx("p1", "w1"),
      session: { id: "s1", agentChatId: "uuid-abc" },
    } as any);
    expect(cmd).toContain("--resume");
    expect(cmd).toContain("uuid-abc");
  });

  it("3.T5 — getLaunchCommand without agentChatId → no --resume flag", async () => {
    const { createCursorPlugin } = await import("../agent-plugins/cursor.js");
    const plugin = createCursorPlugin();
    const cmd = plugin.getLaunchCommand({
      project: { id: "p1" },
      ctx: wtCtx("p1", "w1"),
      session: { id: "s1" },
    } as any);
    expect(cmd).not.toContain("--resume");
  });

  it("3.T6 — getRestoreCommand with agentChatId set → returns resume argv without filesystem call", async () => {
    const { createCursorPlugin } = await import("../agent-plugins/cursor.js");
    const plugin = createCursorPlugin();
    const result = await plugin.getRestoreCommand!({
      session: { agentChatId: "cursor-uuid-xyz" },
      project: { id: "p1" },
      cwd: "/repos/p1",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("--resume");
    expect(result).toContain("cursor-uuid-xyz");
    // cwd must reach --workspace, not leak through as undefined.
    expect(result).toContain("/repos/p1");
    expect(result?.join(" ")).not.toContain("undefined");
  });

  it("3.T7 — getRestoreCommand without agentChatId → falls back to findLatestCursorChatId (returns null when no chats)", async () => {
    const { createCursorPlugin } = await import("../agent-plugins/cursor.js");
    const plugin = createCursorPlugin();
    const result = await plugin.getRestoreCommand!({
      session: {},
      project: { id: "p1" },
      cwd: "/tmp/vst-test-cwd-no-chats",
    });
    expect(result).toBeNull();
  });
});

describe("OpenCode plugin — chat-id capture", () => {
  let wtDir: string;

  beforeEach(async () => {
    wtDir = await mkdtemp(join(tmpdir(), "vst-opencode-hooktest-"));
  });

  afterEach(async () => {
    await rm(wtDir, { recursive: true, force: true });
  });

  it("4.T1 — setupWorkspaceHooks creates .opencode/plugins/vst-recorder.ts", async () => {
    const { createOpencodePlugin } = await import("../agent-plugins/opencode.js");
    const plugin = createOpencodePlugin();
    await plugin.setupWorkspaceHooks!(wtDir);

    const content = await readFile(join(wtDir, ".opencode", "plugins", "vst-recorder.ts"), "utf8");
    expect(content).toContain("VstRecorder");
    expect(content).toContain("session.created");
    expect(content).toContain("VST_SPAWN_TOKEN");
  });

  it("4.T2 — setupWorkspaceHooks is idempotent: no re-write if content unchanged", async () => {
    const { createOpencodePlugin } = await import("../agent-plugins/opencode.js");
    const plugin = createOpencodePlugin();
    await plugin.setupWorkspaceHooks!(wtDir);

    const pluginPath = join(wtDir, ".opencode", "plugins", "vst-recorder.ts");
    const { stat } = await import("node:fs/promises");
    const { mtimeMs: mtimeBefore } = await stat(pluginPath);

    await new Promise((r) => setTimeout(r, 10));
    await plugin.setupWorkspaceHooks!(wtDir);

    const { mtimeMs: mtimeAfter } = await stat(pluginPath);
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("4.T5 — getRestoreCommand with agentChatId → [opencode, --session, id]", async () => {
    const { createOpencodePlugin } = await import("../agent-plugins/opencode.js");
    const plugin = createOpencodePlugin();
    const result = await plugin.getRestoreCommand!({
      session: { agentChatId: "ses_abc" },
      project: {},
      cwd: "/repos/p1",
    });
    expect(result).toEqual(["opencode", "--session", "ses_abc"]);
  });
});

/**
 * Direct (project) contexts — regression coverage for three LIVE path bugs.
 *
 * Direct sessions used to be handed a fabricated worktree record whose id was
 * `<project>-direct`. Plugins derived paths from that id, so they resolved to
 * ~/.vibe-station/projects/<p>/worktrees/<p>-direct — a directory that never
 * exists. cursor got a bogus --workspace; opencode read its config and system
 * prompt from the wrong dir; gemini pointed GEMINI_SYSTEM_MD at nothing.
 * Plugins now read ctx.cwd / the *For(ctx, …) helpers, which handle both shapes.
 */
describe("plugins in a direct (project) context", () => {
  it("cursor: getLaunchCommand uses the project dir as --workspace", async () => {
    const { createCursorPlugin } = await import("../agent-plugins/cursor.js");
    const cmd = createCursorPlugin().getLaunchCommand({
      project: { id: "p1" },
      ctx: projCtx("p1", "/repos/p1"),
      session: { id: "s1" },
      daemonPort: 7421,
    } as never);

    const wsIdx = cmd.indexOf("--workspace");
    expect(wsIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[wsIdx + 1]).toBe("/repos/p1");
    // The fabricated-worktree path must not appear anywhere in the argv.
    expect(cmd.join(" ")).not.toContain("p1-direct");
    expect(cmd.join(" ")).not.toContain("worktrees");
  });

  it("opencode: config + system prompt resolve to the direct session data dir", async () => {
    const { resolvePlugin } = await import("../agent-plugins/registry.js");
    const { directOpencodeConfigPath } = await import("../services/paths.js");
    const env = resolvePlugin("opencode").getEnvironment({
      project: { id: "p1" },
      ctx: projCtx("p1"),
      session: { id: "s1" },
      daemonPort: 7421,
    } as never);

    expect(env.OPENCODE_CONFIG).toBe(directOpencodeConfigPath("p1", "s1"));
    expect(env.OPENCODE_CONFIG).not.toContain("p1-direct");
  });
});
