/**
 * Bug 1/2 fix (sqlite-agent-naming reset-branching bugs): `POST /sessions/:id/reset`
 * on a JSON-channel session must enqueue a turn via the same turn-queue
 * mechanism session CREATION uses (`startJsonCreateTurn`) — never a raw
 * TTY/PTY spawn (`spawnSession`/`spawnDirectSession`). Modeled on
 * `jsonChatRoutes.test.ts`'s fixture style: a mocked plugin registry provides
 * a fake `runTurn` so the JSON turn machinery runs for real (no actual CLI
 * process), letting us assert the new session actually leaves `not_started`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, SessionRecord, NormalizedEvent } from "../types.js";

let tempDir: string;

const hoisted = vi.hoisted(() => ({
  turnEvents: [] as NormalizedEvent[],
}));

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  const { rmSync } = await import("node:fs");
  const base = () => tempDir;
  const directDataDir = (p: string, s: string) => pathJoin(base(), "projects", p, "sessions", s);
  const wtDataDir = (p: string, w: string, s: string) => pathJoin(base(), "projects", p, "session-data", w, s);
  return {
    vstHome: () => base(),
    projectDir: (id: string) => pathJoin(base(), "projects", id),
    manifestPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) => pathJoin(base(), "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(base(), "config.json"),
    modesPath: () => pathJoin(base(), "modes.json"),
    daemonLogPath: () => pathJoin(base(), "logs", "daemon.log"),
    dbPath: () => pathJoin(base(), "vibe-station.db"),
    sessionDataDir: wtDataDir,
    directSessionDataDir: directDataDir,
    systemPromptPath: (p: string, w: string, s: string) => pathJoin(wtDataDir(p, w, s), "system-prompt.md"),
    directSystemPromptPath: (p: string, s: string) => pathJoin(directDataDir(p, s), "system-prompt.md"),
    cleanupSessionDataDir: (p: string, w: string, s: string) =>
      rmSync(wtDataDir(p, w, s), { recursive: true, force: true }),
    cleanupDirectSessionDataDir: (p: string, s: string) =>
      rmSync(directDataDir(p, s), { recursive: true, force: true }),
  };
});

// A fake plugin whose `runTurn` just yields a minimal event stream — enough
// for the JSON turn machinery to run to completion without spawning any real
// CLI process. `supportsJson` must be true for a `channel: "json"` session to
// be a valid fixture at all.
vi.mock("../agent-plugins/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-plugins/registry.js")>();
  const mockPlugin = {
    name: "claude",
    defaultModel: "sonnet",
    promptDelivery: "inline",
    async listModels() {
      return { models: [] };
    },
    getLaunchCommand() {
      return ["claude"];
    },
    getEnvironment() {
      return {};
    },
    getReadySignal() {
      return { fallbackMs: 0 };
    },
    composeLaunchPrompt() {
      return {};
    },
    supportsJson() {
      return true;
    },
    async *runTurn(_input: unknown, ctx: { session: { id: string } }) {
      for (const e of hoisted.turnEvents) {
        yield { ...e, sessionId: ctx.session.id };
      }
    },
  };
  return { ...actual, resolvePlugin: () => mockPlugin };
});

// Reset must NEVER call these directly for a json-channel session (Bug 1) —
// asserted as "not called" below, distinct from `startJsonCreateTurn`'s path.
vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {}),
    spawnDirectSession: vi.fn(async () => {}),
  };
});

const PROJECT_ID = "proj-rj";
const SESSION_ID = `${PROJECT_ID}-d1`;

function makeJsonSession(): SessionRecord {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    isMain: false,
    sortOrder: 1,
    type: "agent",
    modeId: "m",
    tmuxName: "__direct__-x",
    useTmux: false,
    channel: "json",
    lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
  } as SessionRecord;
}

describe("POST /sessions/:id/reset — json channel", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-reset-json-"));
    await mkdir(join(tempDir, "projects", PROJECT_ID), { recursive: true });
    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([{ id: "m", name: "Test", cli: "claude", context: "ctx", createdAt: new Date().toISOString() }]),
    );
    const { buildServer } = await import("../server.js");
    app = await buildServer({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    hoisted.turnEvents = [];
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    const { _resetModesCacheForTest } = await import("../routes/modes.js");
    jsonAgentRegistry.clear();
    _resetModesCacheForTest();
    _clearStoreForTest();
    await rm(join(tempDir, "projects", PROJECT_ID, "sessions", SESSION_ID), { recursive: true, force: true });
    await addProject({
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pj",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeJsonSession()],
      worktrees: [],
    } as ProjectRecord);
    const spawnModule = await import("../services/spawn.js");
    vi.mocked(spawnModule.spawnSession).mockClear();
    vi.mocked(spawnModule.spawnDirectSession).mockClear();
  });

  afterEach(async () => {
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    jsonAgentRegistry.clear();
  });

  it("resetting a json-channel session enqueues a turn (startJsonCreateTurn), never a raw PTY spawn, and the new session leaves not_started", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/reset`,
      payload: { prompt: "keep investigating the flaky test" },
    });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    // The turn-1 enqueue (startJsonCreateTurn -> enqueueChatTurn -> agent.enqueue)
    // runs in the background (fire-and-forget from the route handler) and
    // involves a couple of dynamic imports before it flips the lifecycle to
    // "working" — poll the actual HTTP-visible state rather than racing on
    // internal registry timing (registering the agent happens a tick before
    // the turn is actually enqueued and the lifecycle write lands).
    let state = "not_started";
    for (let i = 0; i < 40 && state === "not_started"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const poll = await app.inject({ method: "GET", url: `/sessions/${newSessionId}` });
      state = poll.json<{ state: string }>().state;
    }

    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    await jsonAgentRegistry.get(newSessionId)?.settled();

    const spawnModule = await import("../services/spawn.js");
    expect(vi.mocked(spawnModule.spawnSession)).not.toHaveBeenCalled();
    expect(vi.mocked(spawnModule.spawnDirectSession)).not.toHaveBeenCalled();
    expect(state).not.toBe("not_started");
  });

  it("resetting a json-channel session with no prompt/handoff leaves the new session not_started (mirrors create-time behavior)", async () => {
    const res = await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/reset`, payload: {} });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json<{ newSessionId: string }>();

    await new Promise((r) => setTimeout(r, 100));

    const spawnModule = await import("../services/spawn.js");
    expect(vi.mocked(spawnModule.spawnSession)).not.toHaveBeenCalled();
    expect(vi.mocked(spawnModule.spawnDirectSession)).not.toHaveBeenCalled();

    const newRes = await app.inject({ method: "GET", url: `/sessions/${newSessionId}` });
    expect(newRes.json<{ state: string }>().state).toBe("not_started");
  });
});
