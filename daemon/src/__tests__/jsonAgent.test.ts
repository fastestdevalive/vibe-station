import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // Lifecycle flipped to idle in the persisted manifest (poller skips JSON).
    expect(getProject(PROJECT_ID)!.directSessions[0]!.lifecycle.state).toBe("idle");
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

    // turnState stays error (transcript) but the session is idle/ready.
    expect(agent.getMeta().turnState).toBe("error");
    expect(getProject(PROJECT_ID)!.directSessions[0]!.lifecycle.state).toBe("idle");
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
