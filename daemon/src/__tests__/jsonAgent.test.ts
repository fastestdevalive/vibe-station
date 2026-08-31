import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { parseClaudeStreamLine } from "../agent-plugins/claude.js";
import type { AgentPlugin, TurnContext } from "../services/spawn.js";
import type {
  ProjectRecord,
  SessionRecord,
  NormalizedEvent,
  NormalizedEventKind,
} from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  const base = () => tempDir || "/tmp/vst-json-test";
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
    sessionDataDir: (p: string, w: string, s: string) =>
      pathJoin(base(), "projects", p, "session-data", w, s),
    directSessionDataDir: (p: string, s: string) => pathJoin(base(), "projects", p, "sessions", s),
    systemPromptPath: (p: string, w: string, s: string) =>
      pathJoin(base(), "projects", p, "session-data", w, s, "system-prompt.md"),
    directSystemPromptPath: (p: string, s: string) =>
      pathJoin(base(), "projects", p, "sessions", s, "system-prompt.md"),
  };
});

const PROJECT_ID = "proj-json";

function makeDirectSession(): SessionRecord {
  return {
    id: `${PROJECT_ID}-d1`,
    slot: "d1",
    type: "agent",
    modeId: "m",
    tmuxName: "__direct__-x",
    useTmux: false,
    channel: "json",
    lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
  };
}

/** A mock JSON transport: reads fixture NDJSON through the real claude parser. */
function mockPlugin(fixture: string): AgentPlugin {
  return {
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
    // eslint-disable-next-line require-yield
    async *runTurn(_input, ctx) {
      for (const line of fixture.split("\n")) {
        for (const ev of parseClaudeStreamLine(line, ctx.session.id)) {
          yield ev;
        }
      }
    },
  } as unknown as AgentPlugin;
}

const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "chat-xyz-1",
  model: "claude-sonnet-4-5",
});
const TEXT = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "the answer is 7" }] },
});
const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.02,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  modelUsage: { "claude-sonnet-4-5": {} },
  result: "the answer is 7",
});

describe("JsonAgentSession", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-json-test-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pj",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeDirectSession()],
      worktrees: [],
    };
    await addProject(project);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("2.T2 — synth user first, ordered text→result; persists jsonl + chatId; ends idle", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: mockPlugin([INIT, TEXT, RESULT].join("\n")),
      daemonPort: 0,
      cli: "claude",
    });

    agent.enqueue({ message: "what is 3+4?" });
    await agent.settled();

    const transcript = agent.readTranscript();
    const kinds = transcript.map((e) => e.kind);
    expect(kinds[0]).toBe("user");
    expect(transcript[0]?.text).toBe("what is 3+4?");
    // ordered: user, session_init, text, usage, result
    expect(kinds).toEqual(["user", "session_init", "text", "usage", "result"]);

    // agentChatId captured + persisted via mutateProject
    expect(getProject(PROJECT_ID)!.directSessions[0]!.agentChatId).toBe("chat-xyz-1");

    // meta ends idle with usage
    const meta = agent.getMeta();
    expect(meta.turnState).toBe("idle");
    expect(meta.queueDepth).toBe(0);
    expect(meta.usage?.totalTokens).toBe(15);

    // durable store actually persisted 5 events (SQLite backend)
    const { openSqliteTranscriptStore } = await import("../services/sqliteTranscriptStore.js");
    const dataDir = join(tempDir, "projects", PROJECT_ID, "sessions", session.id);
    const store = openSqliteTranscriptStore(dataDir, session.id);
    expect(store.count()).toBe(5);
    store.close();
  });

  it("2.T3 — a malformed NDJSON line is skipped; the turn still completes", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: mockPlugin([INIT, "this is not json {{{", TEXT, RESULT].join("\n")),
      daemonPort: 0,
      cli: "claude",
    });

    agent.enqueue({ message: "hi" });
    await agent.settled();

    const kinds = agent.readTranscript().map((e) => e.kind);
    expect(kinds).toEqual(["user", "session_init", "text", "usage", "result"]);
    expect(agent.getMeta().turnState).toBe("idle");
  });

  it("2.T6 — the daemon-synthesized user event is persisted (replay source), not UI-only", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const emitted: NormalizedEvent[] = [];
    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: mockPlugin([INIT, TEXT, RESULT].join("\n")),
      daemonPort: 0,
      cli: "claude",
    });
    agent.stream.on("message", (ev: NormalizedEvent) => emitted.push(ev));

    const { turnId } = agent.enqueue({ message: "remember 7" });
    await agent.settled();

    // Broadcast on the stream AND persisted to the transcript with the turnId.
    const userEmitted = emitted.find((e) => e.kind === "user");
    expect(userEmitted?.turnId).toBe(turnId);

    const replay = agent.readTranscript();
    const userPersisted = replay.find((e) => e.kind === "user");
    expect(userPersisted).toBeDefined();
    expect(userPersisted?.text).toBe("remember 7");
    // every event of the turn carries the turnId
    expect(replay.every((e) => e.turnId === turnId)).toBe(true);
  });

  it("surfaces a synthetic error event when the transport throws (Decision 7)", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const throwingPlugin = {
      ...mockPlugin(""),
      // eslint-disable-next-line require-yield
      async *runTurn() {
        throw new Error("claude exited 1");
      },
    } as unknown as AgentPlugin;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: throwingPlugin,
      daemonPort: 0,
      cli: "claude",
    });
    agent.enqueue({ message: "boom" });
    await agent.settled();

    const kinds = agent.readTranscript().map((e) => e.kind);
    expect(kinds).toContain("error");
    expect(agent.getMeta().turnState).toBe("error");
  });

  it("Fix #1 — persists lifecycle idle to the manifest when the queue drains", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;
    expect(session.lifecycle.state).toBe("not_started");

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: mockPlugin([INIT, TEXT, RESULT].join("\n")),
      daemonPort: 0,
      cli: "claude",
    });

    agent.enqueue({ message: "hi" });
    await agent.settled();

    // Lifecycle flips to waiting_for_human (not idle) in the persisted
    // manifest — R3 (plan 03, Decision 0/2): the poller skips JSON channel
    // sessions entirely, so `drain()` is JSON's own R3 entry point, and
    // reaching this finally block at all means a turn was actually
    // processed — real, observable agent activity, not a genuinely-blank
    // bootstrap state — so even the FIRST drain lands here, not on "idle".
    expect(getProject(PROJECT_ID)!.directSessions[0]!.lifecycle.state).toBe("waiting_for_human");
  });

  it("Fix #1 — persists lifecycle idle even when the turn errors", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const throwingPlugin = {
      ...mockPlugin(""),
      // eslint-disable-next-line require-yield
      async *runTurn() {
        throw new Error("boom");
      },
    } as unknown as AgentPlugin;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: throwingPlugin,
      daemonPort: 0,
      cli: "claude",
    });
    agent.enqueue({ message: "x" });
    await agent.settled();

    // turnState stays error (transcript) but the session is ready for the
    // next message — lifecycle lands on waiting_for_human (R3, same as any
    // other drain — a turn was attempted, that's real activity, error or not).
    expect(agent.getMeta().turnState).toBe("error");
    expect(getProject(PROJECT_ID)!.directSessions[0]!.lifecycle.state).toBe("waiting_for_human");
  });

  it("1.T3 — EVERY turn's drain lands on waiting_for_human, including the first (R3, JSON channel)", async () => {
    // Plan 03, Decision 0/2: R2 (immediate tool_use detection) is dropped;
    // R3 ("idle after ever having worked") is the sole waiting_for_human
    // entry path for EVERY channel, including JSON. The JSON channel has no
    // tmux/pty for the poller to watch (`lifecycle.ts` skips it outright),
    // so this session's own `drain()` is where that rule must apply instead.
    // Unlike the TTY poller (which can observe a genuinely-blank, nothing-
    // ever-happened session and correctly stay on plain "idle" the first
    // time, R3a), `drain()`'s finally block is ONLY ever reached after
    // `runOneTurn` actually processed a queued turn — that's real,
    // observable agent activity by construction, with no "blank bootstrap"
    // case to guard against. So there is no first-vs-later distinction on
    // this channel: every drain, including the very first, lands on
    // waiting_for_human.
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: mockPlugin([INIT, TEXT, RESULT].join("\n")),
      daemonPort: 0,
      cli: "claude",
    });

    agent.enqueue({ message: "first" });
    await agent.settled();
    expect(getProject(PROJECT_ID)!.directSessions[0]!.lifecycle.state).toBe("waiting_for_human");

    // A human response resumes work (R4) via the existing new-turn-start path;
    // that turn's own drain lands back on waiting_for_human too, not idle.
    agent.enqueue({ message: "second" });
    await agent.settled();
    expect(getProject(PROJECT_ID)!.directSessions[0]!.lifecycle.state).toBe("waiting_for_human");
  });

  it("dispose() closes the session's own SQLite handle (opus review finding — fd leak on teardown)", async () => {
    // Every JsonAgentSession teardown path (DELETE /sessions/:id, worktree
    // delete, tty→json toggle) MUST close the store it opened in the
    // constructor — the registry dropping its reference alone is not enough,
    // since better-sqlite3 has no finalizer the GC reliably runs promptly.
    // Without dispose(), a daemon that creates/deletes many JSON sessions (or
    // channel-toggles repeatedly) accumulates open db+wal+shm handles
    // indefinitely, trending toward fd exhaustion.
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: mockPlugin([INIT, TEXT, RESULT].join("\n")),
      daemonPort: 0,
      cli: "claude",
    });
    agent.enqueue({ message: "hi" });
    await agent.settled();

    // Sanity: the store is genuinely open and usable before dispose.
    expect(() => agent.readTranscript()).not.toThrow();

    agent.dispose();

    // better-sqlite3 throws "The database connection is not open" on any
    // API call after close() — this is the direct, observable proof the
    // underlying fd was actually released, not just that dispose() ran.
    expect(() => agent.readTranscript()).toThrow(/not open|closed/i);
  });

  it("dispose() is safe to call more than once (idempotent, no throw)", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: mockPlugin([INIT, TEXT, RESULT].join("\n")),
      daemonPort: 0,
      cli: "claude",
    });
    agent.enqueue({ message: "hi" });
    await agent.settled();

    agent.dispose();
    expect(() => agent.dispose()).not.toThrow();
  });
});

// Build a bare NormalizedEvent for a mock plugin to yield.
function ev(sessionId: string, kind: NormalizedEventKind, extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId,
    ts: new Date().toISOString(),
    provider: "claude",
    kind,
    ...extra,
  };
}

describe("JsonAgentSession — requested-model stays constant across turns (Fix #2)", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-json-model-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pj",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeDirectSession()],
      worktrees: [],
    };
    await addProject(project);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("spawns every turn with the requested model, even after a subagent (haiku) usage is observed", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const spawnedModels: (string | undefined)[] = [];
    // Each turn: report the primary model in session_init, but ALSO emit a stray
    // usage event carrying a haiku subagent model. Pre-fix this drifted into the
    // field used for the next turn's --model.
    const driftPlugin = {
      ...mockPlugin(""),
      // eslint-disable-next-line require-yield
      async *runTurn(_input: unknown, ctx: TurnContext): AsyncIterable<NormalizedEvent> {
        spawnedModels.push(ctx.model);
        const sid = ctx.session.id;
        yield ev(sid, "session_init", { model: "claude-sonnet-4-5", agentChatId: "chat-1" });
        yield ev(sid, "text", { role: "assistant", text: "hi" });
        // Subagent usage — model differs from the answering/requested model.
        yield ev(sid, "usage", { model: "claude-haiku-4-5", usage: {
          inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0,
          totalTokens: 2, model: "claude-haiku-4-5",
        } });
        yield ev(sid, "result", {});
      },
    } as unknown as AgentPlugin;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: driftPlugin,
      daemonPort: 0,
      cli: "claude",
      model: "claude-sonnet-4-5", // requested (mode) model
    });

    agent.enqueue({ message: "turn 1" });
    await agent.settled();
    agent.enqueue({ message: "turn 2" });
    await agent.settled();
    agent.enqueue({ message: "turn 3" });
    await agent.settled();

    // Every turn spawned with the requested model — NEVER the haiku subagent.
    expect(spawnedModels).toEqual([
      "claude-sonnet-4-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5",
    ]);
  });
});

describe("JsonAgentSession — aborted turn stops appending trailing events (Fix #4)", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-json-abort-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pj",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeDirectSession()],
      worktrees: [],
    };
    await addProject(project);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("a late session_init emitted after abort is NOT persisted (no mis-ordered replay)", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    let releaseTrailing!: () => void;
    const trailingGate = new Promise<void>((r) => (releaseTrailing = r));

    const gatedPlugin = {
      ...mockPlugin(""),
      // eslint-disable-next-line require-yield
      async *runTurn(_input: unknown, ctx: TurnContext): AsyncIterable<NormalizedEvent> {
        const sid = ctx.session.id;
        yield ev(sid, "session_init", { model: "claude-sonnet-4-5" });
        yield ev(sid, "text", { role: "assistant", text: "answer" });
        yield ev(sid, "result", {});
        // The harness was killed mid-flush — a late, out-of-order session_init
        // arrives after we already stopped the turn. It must be dropped.
        await trailingGate;
        yield ev(sid, "session_init", { model: "claude-sonnet-4-5" });
      },
    } as unknown as AgentPlugin;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: gatedPlugin,
      daemonPort: 0,
      cli: "claude",
    });

    // When the `result` lands, stop the active turn, then release the trailing event.
    agent.stream.on("message", (e: NormalizedEvent) => {
      if (e.kind === "result") {
        agent.stopActiveTurn();
        releaseTrailing();
      }
    });

    agent.enqueue({ message: "hello" });
    await agent.settled();

    const kinds = agent.readTranscript().map((e) => e.kind);
    // Exactly one session_init, and the transcript ends on `result` — the late
    // trailing session_init was dropped.
    expect(kinds.filter((k) => k === "session_init")).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe("result");
    expect(kinds).toEqual(["user", "session_init", "text", "result"]);
  });
});

describe("JsonAgentSession — 1.T2/1.T5 tool_result size cap (live-turn path)", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-json-cap-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pj",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeDirectSession()],
      worktrees: [],
    };
    await addProject(project);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1.T2 — an oversized live tool_result is capped before persist + broadcast", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const { TOOL_RESULT_MAX_BYTES } = await import("../services/toolResultCap.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const bigContent = "A".repeat(TOOL_RESULT_MAX_BYTES + 5000);
    const capPlugin = {
      ...mockPlugin(""),
      // eslint-disable-next-line require-yield
      async *runTurn(_input: unknown, ctx: TurnContext): AsyncIterable<NormalizedEvent> {
        const sid = ctx.session.id;
        yield ev(sid, "session_init", { model: "claude-sonnet-4-5" });
        yield ev(sid, "tool_use", { toolName: "Read", toolId: "t1" });
        yield ev(sid, "tool_result", { toolId: "t1", toolResult: { content: bigContent } });
        yield ev(sid, "result", {});
      },
    } as unknown as AgentPlugin;

    const emitted: NormalizedEvent[] = [];
    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: capPlugin,
      daemonPort: 0,
      cli: "claude",
    });
    agent.stream.on("message", (e: NormalizedEvent) => emitted.push(e));

    agent.enqueue({ message: "read the big file" });
    await agent.settled();

    // Broadcast over the WS is capped too (same event object, capped before emit).
    const emittedResult = emitted.find((e) => e.kind === "tool_result");
    expect(emittedResult?.toolResult?.content).not.toContain(bigContent);
    expect(emittedResult?.toolResult?.content).toContain("omitted");

    // Persisted transcript is capped, not raw.
    const persistedResult = agent.readTranscript().find((e) => e.kind === "tool_result");
    expect(persistedResult?.toolResult?.content).not.toContain(bigContent);
    expect(persistedResult?.toolResult?.content).toContain("omitted");
  });

  it("1.T5 — a normal-size tool_result persists unchanged through the live-turn path", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const normalContent = "diff --git a/x b/x\n+hello\n";
    const normalPlugin = {
      ...mockPlugin(""),
      // eslint-disable-next-line require-yield
      async *runTurn(_input: unknown, ctx: TurnContext): AsyncIterable<NormalizedEvent> {
        const sid = ctx.session.id;
        yield ev(sid, "session_init", { model: "claude-sonnet-4-5" });
        yield ev(sid, "tool_result", { toolId: "t1", toolResult: { content: normalContent } });
        yield ev(sid, "result", {});
      },
    } as unknown as AgentPlugin;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: normalPlugin,
      daemonPort: 0,
      cli: "claude",
    });

    agent.enqueue({ message: "small diff" });
    await agent.settled();

    const persistedResult = agent.readTranscript().find((e) => e.kind === "tool_result");
    expect(persistedResult?.toolResult?.content).toBe(normalContent);
  });
});

const linuxIt = process.platform === "linux" ? it : it.skip;

describe("JsonAgentSession — abort kills the whole descendant tree (Fix #3)", () => {
  let project: ProjectRecord;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-json-kill-"));
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pj",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeDirectSession()],
      worktrees: [],
    };
    await addProject(project);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  linuxIt("abortAndDrain kills the turn root AND a tool child in its own process group", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const gcPidFile = join(tempDir, "grandchild.pid");
    const rootPids: number[] = [];

    // The turn root (bash, own process group via detached) enables job control
    // (`set -m`) so its background `sleep` runs in a SEPARATE process group —
    // exactly the claude Bash-tool escape scenario. A group-kill of the root
    // would miss it; only a descendant-tree walk catches it.
    const spawningPlugin = {
      ...mockPlugin(""),
      // eslint-disable-next-line require-yield
      async *runTurn(_input: unknown, ctx: TurnContext, signal: AbortSignal): AsyncIterable<NormalizedEvent> {
        const child = spawn(
          "bash",
          ["-c", `set -m; sleep 300 & echo $! > ${gcPidFile}; wait`],
          { detached: true, stdio: "ignore" },
        );
        if (child.pid) {
          rootPids.push(child.pid);
          ctx.onSpawn?.(child.pid);
        }
        // Block the turn until aborted (keeps it "running").
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    } as unknown as AgentPlugin;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: spawningPlugin,
      daemonPort: 0,
      cli: "claude",
    });

    agent.enqueue({ message: "run a long tool" });

    // Wait until both the root and the escaped grandchild are alive.
    let grandchildPid = 0;
    for (let i = 0; i < 100 && grandchildPid === 0; i++) {
      await sleep(20);
      if (existsSync(gcPidFile)) {
        grandchildPid = Number(readFileSync(gcPidFile, "utf8").trim());
      }
    }
    const rootPid = rootPids[0]!;
    expect(rootPid).toBeGreaterThan(1);
    expect(grandchildPid).toBeGreaterThan(1);
    expect(alive(rootPid)).toBe(true);
    expect(alive(grandchildPid)).toBe(true);

    // DELETE-mid-turn → abortAndDrain must leave NO surviving descendant.
    agent.abortAndDrain();
    await agent.settled();

    // Give the kernel a moment to reap.
    for (let i = 0; i < 50 && (alive(rootPid) || alive(grandchildPid)); i++) {
      await sleep(20);
    }

    expect(alive(rootPid)).toBe(false);
    expect(alive(grandchildPid)).toBe(false);
  });
});

describe("JsonAgentSession — 1.T4 stopActiveTurn cancels an ACP connection, never kills it", () => {
  let project: ProjectRecord;
  const FAKE_AGENT = join(__dirname, "fixtures", "fakeAcpAgent.mjs");

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-json-acp-stop-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempDir, "repo"), { recursive: true });
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    project = {
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pj",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeDirectSession()],
      worktrees: [],
    };
    await addProject(project);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** A real ACP-driving plugin (via ctx.getAcpConnection) against the fake agent fixture. */
  function acpPlugin(
    mode: "normal" | "cancel" | "bg_terminal",
    onConn?: (conn: { hasLiveTerminals(): boolean }) => void,
  ): AgentPlugin {
    return {
      ...mockPlugin(""),
      supportsAcp() {
        return true;
      },
      async *runTurn(_input, ctx, signal) {
        const conn = await ctx.getAcpConnection!(
          {
            command: process.execPath,
            args: [FAKE_AGENT],
            cwd: ctx.cwd,
            env: { FAKE_ACP_MODE: mode },
            // Mirror the real plugins (claude.ts:396) — the connection PID is
            // recorded in livePids, so a regression that hard-kills on
            // stop/force-send would actually take this fake agent down.
            ...(ctx.onSpawn ? { onSpawn: ctx.onSpawn } : {}),
          },
        );
        onConn?.(conn);
        const sessionId = conn.currentSessionId ?? (await conn.newSession(ctx.cwd));
        const { updates, result } = conn.sendPrompt(sessionId, [{ type: "text", text: "hi" }], signal);
        for await (const ev of updates) yield ev;
        const { stopReason } = await result;
        yield { id: "r1", sessionId: ctx.session.id, ts: new Date().toISOString(), provider: "claude", kind: "result", text: stopReason } as NormalizedEvent;
      },
    } as unknown as AgentPlugin;
  }

  it("stopActiveTurn() sends session/cancel (not killProcessTree) and the connection stays usable for the next turn", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: acpPlugin("cancel"),
      daemonPort: 0,
      cli: "claude",
    });

    agent.enqueue({ message: "start something long" });
    // Give the fake agent time to spawn + reach session/prompt before stopping.
    await new Promise((r) => setTimeout(r, 200));
    const stopped = agent.stopActiveTurn();
    expect(stopped).toBe(true);
    await agent.settled();

    // A SECOND turn on the SAME session must succeed without hanging or
    // spawning a brand-new connection — proof the connection survived Stop.
    agent.enqueue({ message: "are you still there?" });
    await agent.settled();

    const kinds = agent.readTranscript().map((e) => e.kind);
    expect(kinds.filter((k) => k === "result").length).toBeGreaterThanOrEqual(1);
  });

  // 1.T6 — "Send now" (force-send) is the SAME preemption as Stop: it routes
  // through promoteQueuedTurn → stopActiveTurn, so it must cancel the in-flight
  // prompt (session/cancel) and leave the connection AND every live
  // AcpTerminalManager-tracked background terminal running. A regression to the
  // legacy killProcessTree path here would SIGKILL the adapter's process group,
  // taking the background terminal (and everything the CLI is running inside
  // that one process) with it.
  it("1.T6 — force-send (promoteQueuedTurn) preserves a live background terminal and the connection", async () => {
    const { JsonAgentSession } = await import("../services/jsonAgent.js");
    const { getProject } = await import("../state/project-store.js");
    const session = getProject(PROJECT_ID)!.directSessions[0]!;

    let conn: { hasLiveTerminals(): boolean } | undefined;
    const agent = new JsonAgentSession({
      project,
      worktree: null,
      session,
      plugin: acpPlugin("bg_terminal", (c) => {
        conn = c;
      }),
      daemonPort: 0,
      cli: "claude",
    });

    try {
      // Turn 1 starts a host-managed background terminal, then hangs.
      agent.enqueue({ message: "start the dev server in the background" });
      const deadline = Date.now() + 5000;
      while (!conn?.hasLiveTerminals() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(conn?.hasLiveTerminals()).toBe(true);

      // Queue a second turn and FORCE-SEND it while turn 1 is still running.
      const { turnId } = agent.enqueue({ message: "actually, do this instead" });
      expect(agent.promoteQueuedTurn(turnId)).toBe("ok");
      await agent.settled();

      // The background terminal must still be alive — force-send cancelled the
      // turn, it did not kill the process tree.
      expect(conn?.hasLiveTerminals()).toBe(true);

      // …and the promoted turn ran to completion on the SAME connection.
      const results = agent.readTranscript().filter((e) => e.kind === "result");
      expect(results.some((e) => e.text === "end_turn")).toBe(true);
    } finally {
      // release() is the only path that may hard-kill the terminal (Requirement 2).
      await agent.release();
    }
  });
});
