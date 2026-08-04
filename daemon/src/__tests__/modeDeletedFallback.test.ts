/**
 * Deleting an in-use mode must not break an already-running JSON-channel
 * agent, and a session whose mode later vanishes (e.g. after a registry
 * reset / daemon restart) must fall back gracefully instead of erroring.
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
  lastModeContext: undefined as string | undefined,
}));

vi.mock("../services/promptBuilder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/promptBuilder.js")>();
  return {
    ...actual,
    async buildDirectPrompt(opts: { modeContext?: string }) {
      hoisted.lastModeContext = opts.modeContext;
      return { systemPrompt: opts.modeContext ?? "", taskPrompt: undefined };
    },
  };
});

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  const { rmSync } = await import("node:fs");
  const base = () => tempDir;
  const directDataDir = (p: string, s: string) => pathJoin(base(), "projects", p, "sessions", s);
  return {
    vstHome: () => base(),
    projectDir: (id: string) => pathJoin(base(), "projects", id),
    manifestPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) => pathJoin(base(), "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(base(), "config.json"),
    modesPath: () => pathJoin(base(), "modes.json"),
    daemonLogPath: () => pathJoin(base(), "logs", "daemon.log"),
    sessionDataDir: (p: string, w: string, s: string) => pathJoin(base(), "projects", p, "session-data", w, s),
    directSessionDataDir: directDataDir,
    systemPromptPath: (p: string, w: string, s: string) =>
      pathJoin(base(), "projects", p, "session-data", w, s, "system-prompt.md"),
    directSystemPromptPath: (p: string, s: string) => pathJoin(directDataDir(p, s), "system-prompt.md"),
    cleanupSessionDataDir: (p: string, w: string, s: string) =>
      rmSync(pathJoin(base(), "projects", p, "session-data", w, s), { recursive: true, force: true }),
    cleanupDirectSessionDataDir: (p: string, s: string) => rmSync(directDataDir(p, s), { recursive: true, force: true }),
  };
});

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
    async *runTurn(input: { message: string }, ctx: { session: { id: string } }) {
      for (const e of hoisted.turnEvents) {
        yield { ...e, sessionId: ctx.session.id };
      }
    },
  };
  // Every cli id resolves to the same mock plugin — good enough for asserting
  // the fallback path doesn't throw, without needing per-CLI fidelity here.
  return { ...actual, resolvePlugin: () => mockPlugin };
});

const PROJECT_ID = "proj-mode-fallback";
const SESSION_ID = `${PROJECT_ID}-d1`;

function ev(kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2)}`,
    sessionId: SESSION_ID,
    ts: new Date().toISOString(),
    provider: "claude",
    kind,
    ...extra,
  };
}

const TURN = [
  ev("session_init", { model: "claude-sonnet-4-5", agentChatId: "chat-1" }),
  ev("text", { role: "assistant", text: "hello" }),
  ev("result", { model: "claude-sonnet-4-5" }),
];

function makeSession(): SessionRecord {
  return {
    id: SESSION_ID,
    slot: "d1",
    type: "agent",
    modeId: "m",
    tmuxName: "__direct__-x",
    useTmux: false,
    channel: "json",
    lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
  };
}

describe("Deleting an in-use mode", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-mode-fallback-"));
    await mkdir(join(tempDir, "projects", PROJECT_ID), { recursive: true });
    const { buildServer } = await import("../server.js");
    app = await buildServer({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    hoisted.turnEvents = TURN;
    // Recreated fresh each test since some tests delete it.
    // cli is deliberately NOT "claude" (the fallback default) so a test can
    // tell "kept the real mode config" apart from "fell back to defaults".
    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([{ id: "m", name: "Test", cli: "cursor", context: "ctx", createdAt: new Date().toISOString() }]),
    );
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
      prefix: "pmf",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeSession()],
      worktrees: [],
    } as ProjectRecord);
  });

  afterEach(async () => {
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    jsonAgentRegistry.clear();
  });

  it("DELETE /modes/:id succeeds while a session is using it and reports affectedSessions", async () => {
    const res = await app.inject({ method: "DELETE", url: "/modes/m" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: true; affectedSessions: number }>().affectedSessions).toBe(1);

    const list = await app.inject({ method: "GET", url: "/modes" });
    expect(list.json()).toEqual([]);
  });

  it("an already-live JSON agent keeps working AND keeps reporting its real cli/modeName after its mode is deleted", async () => {
    // First turn — creates + registers the JsonAgentSession, caching cli/modeId/modeName.
    const first = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat`,
      payload: { message: "hi" },
    });
    expect(first.statusCode).toBe(202);

    // Mode is now gone.
    const del = await app.inject({ method: "DELETE", url: "/modes/m" });
    expect(del.statusCode).toBe(200);

    // The same (still-registered) agent takes another turn without erroring.
    const second = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat`,
      payload: { message: "still there?" },
    });
    expect(second.statusCode).toBe(202);

    // Real assertion: meta still reports the ORIGINAL cli/modeName ("cursor"/
    // "Test"), not the bare "claude" fallback — proving the live agent's own
    // cached fields (not a fresh, now-failing modes.json lookup) are the
    // source of truth for an already-running agent.
    const meta = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/meta` });
    expect(meta.statusCode).toBe(200);
    const metaBody = meta.json<{ cli: string; modeName?: string }>();
    expect(metaBody.cli).toBe("cursor");
    expect(metaBody.modeName).toBe("Test");
  });

  it("resolveMode's fallback itself prefers a live agent's real cli over the bare claude default", async () => {
    // Direct unit-level check on resolveMode's own return value (not GET
    // /meta, which short-circuits to live.getMeta() and can't tell "resolveMode
    // fell back correctly" apart from "resolveMode fell back to the wrong
    // default" — see the review gap this closes).
    const { resolveJsonAgent } = await import("../services/jsonAgentChat.js");
    const daemonPort = (app.server.address() as { port?: number } | null)?.port ?? 0;

    // Register the live agent (cli "cursor") before the mode is deleted.
    const beforeDelete = await resolveJsonAgent(SESSION_ID, daemonPort);
    expect(beforeDelete.ok && beforeDelete.mode.cli).toBe("cursor");

    await app.inject({ method: "DELETE", url: "/modes/m" });

    // Live agent still registered — resolveMode must report ITS real cli.
    const withLiveAgent = await resolveJsonAgent(SESSION_ID, daemonPort);
    expect(withLiveAgent.ok && withLiveAgent.mode.cli).toBe("cursor");

    // Now drop the live agent too (daemon-restart simulation) — no source of
    // truth left, must fall back to the bare default instead of crashing.
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    jsonAgentRegistry.clear();
    const withNoLiveAgent = await resolveJsonAgent(SESSION_ID, daemonPort);
    expect(withNoLiveAgent.ok && withNoLiveAgent.mode.cli).toBe("claude");
  });

  it("turn 1's system prompt still gets the mode's context even when the agent was pre-registered earlier (e.g. by chat:open)", async () => {
    // Mirrors chat:open (ws/handlers/chatOpen.ts) — lazily registers the
    // JsonAgentSession via resolveJsonAgent WITHOUT enqueueing a turn.
    const { resolveJsonAgent } = await import("../services/jsonAgentChat.js");
    const daemonPort = (app.server.address() as { port?: number } | null)?.port ?? 0;
    const preRegistered = await resolveJsonAgent(SESSION_ID, daemonPort);
    expect(preRegistered.ok).toBe(true);

    // The user's actual first message arrives afterward — this must NOT lose
    // the mode's context just because the agent object already existed.
    hoisted.lastModeContext = undefined;
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat`,
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(202);
    expect(hoisted.lastModeContext).toBe("ctx");
  });

  it("a fresh agent (registry reset — e.g. after a daemon restart) falls back gracefully when its mode is gone", async () => {
    await app.inject({ method: "DELETE", url: "/modes/m" });

    // Simulate a daemon restart: no live JsonAgentSession for this id.
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    jsonAgentRegistry.clear();

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat`,
      payload: { message: "resuming after mode deletion" },
    });
    // Falls back instead of 500ing.
    expect(res.statusCode).toBe(202);

    // No live agent survived to remember the real cli — falls all the way
    // back to the bare "claude" default (documented, accepted degradation).
    const meta = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/meta` });
    expect(meta.json<{ cli: string; modeName?: string }>().cli).toBe("claude");
  });
});
