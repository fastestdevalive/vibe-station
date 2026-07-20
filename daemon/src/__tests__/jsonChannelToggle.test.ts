import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, SessionRecord, WorktreeRecord, NormalizedEvent } from "../types.js";

let tempDir: string;

// Controllable turn output + a gate the mocked runTurn can await (for the idle-
// gate tests), plus the events the mocked native importer will backfill.
const hoisted = vi.hoisted(() => ({
  turnEvents: [] as NormalizedEvent[],
  gate: null as Promise<void> | null,
  releaseGate: null as (() => void) | null,
  importEvents: [] as NormalizedEvent[],
  importWatermark: "0",
  importCalls: 0,
}));

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  const { rmSync } = await import("node:fs");
  const base = () => tempDir;
  const directDataDir = (p: string, s: string) => pathJoin(base(), "projects", p, "sessions", s);
  const wtDataDir = (p: string, w: string, s: string) =>
    pathJoin(base(), "projects", p, "session-data", w, s);
  return {
    vstHome: () => base(),
    projectDir: (id: string) => pathJoin(base(), "projects", id),
    manifestPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(base(), "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) => pathJoin(base(), "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(base(), "config.json"),
    modesPath: () => pathJoin(base(), "modes.json"),
    daemonLogPath: () => pathJoin(base(), "logs", "daemon.log"),
    sessionDataDir: wtDataDir,
    directSessionDataDir: directDataDir,
    systemPromptPath: (p: string, w: string, s: string) => pathJoin(wtDataDir(p, w, s), "system-prompt.md"),
    directSystemPromptPath: (p: string, s: string) => pathJoin(directDataDir(p, s), "system-prompt.md"),
    cleanupSessionDataDir: (p: string, w: string, s: string) => rmSync(wtDataDir(p, w, s), { recursive: true, force: true }),
    cleanupDirectSessionDataDir: (p: string, s: string) => rmSync(directDataDir(p, s), { recursive: true, force: true }),
  };
});

// Mock tmux + spawn so a toggle never needs a real tmux server / child process.
vi.mock("../services/tmux.js", () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  killSession: vi.fn().mockResolvedValue(undefined),
  newSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(""),
  listSessions: vi.fn().mockResolvedValue([]),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/spawn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/spawn.js")>();
  return {
    ...original,
    spawnSession: vi.fn(async () => {}),
    spawnSessionFromArgv: vi.fn(async () => {}),
    spawnDirectSession: vi.fn(async () => {}),
  };
});

// A single claude-shaped JSON plugin with a restore path + configurable turn.
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
    async setupWorkspaceHooks() {},
    // Restore argv only when a chat id exists (empty session → fresh launch, J12).
    async getRestoreCommand(args: { session: { agentChatId?: string } }) {
      return args.session.agentChatId ? ["claude", "--resume", args.session.agentChatId] : null;
    },
    async captureChatId(args: { session: { agentChatId?: string } }) {
      return args.session.agentChatId ?? null;
    },
    async *runTurn(input: { message: string }, ctx: { session: { id: string } }, signal: AbortSignal) {
      if (hoisted.gate) await hoisted.gate;
      for (const e of hoisted.turnEvents) {
        if (signal.aborted) break;
        yield { ...e, sessionId: ctx.session.id };
      }
    },
  };
  return { ...actual, resolvePlugin: () => mockPlugin };
});

// Mock the native-history importer registry: claude + opencode present (import
// yields the configured events); cursor + agy absent (toggle blocked, R1.6).
vi.mock("../services/nativeHistoryImporter.js", () => {
  const supported = new Set(["claude", "opencode"]);
  return {
    hasNativeHistoryImporter: (cli: string) => supported.has(cli),
    getNativeHistoryImporter: (cli: string) =>
      supported.has(cli)
        ? {
            cli,
            async import() {
              hoisted.importCalls++;
              return { events: hoisted.importEvents, nextWatermark: hoisted.importWatermark };
            },
          }
        : undefined,
  };
});

const PROJECT_ID = "proj-tog";
const WT_ID = `${PROJECT_ID}-w1`;
const JSON_SID = `${WT_ID}-a1`; // claude json worktree agent
const CURSOR_SID = `${WT_ID}-a2`; // cursor json worktree agent (blocked)
const AGY_SID = `${WT_ID}-a3`; // agy json worktree agent (blocked)
const EMPTY_SID = `${WT_ID}-a4`; // claude json worktree agent, never run
const DIRECT_SID = `${PROJECT_ID}-d1`; // claude json DIRECT agent (blocked, R1.5)

function ev(kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2)}`,
    sessionId: JSON_SID,
    ts: new Date().toISOString(),
    provider: "claude",
    kind,
    ...extra,
  };
}

const TURN = [
  ev("session_init", { model: "claude-sonnet-4-5", agentChatId: "chat-1" }),
  ev("text", { role: "assistant", text: "hello there" }),
  ev("usage", {
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      totalTokens: 15,
      costUsd: 0.02,
      model: "claude-sonnet-4-5",
    },
    model: "claude-sonnet-4-5",
  }),
  ev("result", { model: "claude-sonnet-4-5" }),
];

function jsonSession(id: string, slot: string, modeId: string): SessionRecord {
  return {
    id,
    slot,
    type: "agent",
    modeId,
    tmuxName: `vst-${id}`,
    useTmux: false,
    channel: "json",
    lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
  };
}

function worktree(): WorktreeRecord {
  return {
    id: WT_ID,
    branch: "feat",
    baseBranch: "main",
    createdAt: new Date().toISOString(),
    sessions: [
      jsonSession(JSON_SID, "a1", "m"),
      jsonSession(CURSOR_SID, "a2", "mc"),
      jsonSession(AGY_SID, "a3", "ma"),
      jsonSession(EMPTY_SID, "a4", "m"),
    ],
  } as WorktreeRecord;
}

async function seedProject(): Promise<void> {
  const { addProject } = await import("../state/project-store.js");
  await addProject({
    id: PROJECT_ID,
    absolutePath: join(tempDir, "repo"),
    prefix: "pt",
    isGit: true,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    directSessions: [jsonSession(DIRECT_SID, "d1", "m")],
    worktrees: [worktree()],
  } as ProjectRecord);
}

/** Run a JSON turn to completion (registers the agent, captures agentChatId). */
async function runTurn(app: FastifyInstance, sid: string, message: string): Promise<void> {
  await app.inject({ method: "POST", url: `/sessions/${sid}/chat`, payload: { message } });
  const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
  await jsonAgentRegistry.get(sid)?.settled();
}

async function getChannel(sid: string): Promise<string | undefined> {
  const { getProject } = await import("../state/project-store.js");
  return getProject(PROJECT_ID)
    ?.worktrees.flatMap((w) => w.sessions)
    .concat(getProject(PROJECT_ID)?.directSessions ?? [])
    .find((s) => s.id === sid)?.channel;
}

async function getAgentChatId(sid: string): Promise<string | undefined> {
  const { getProject } = await import("../state/project-store.js");
  return getProject(PROJECT_ID)
    ?.worktrees.flatMap((w) => w.sessions)
    .find((s) => s.id === sid)?.agentChatId;
}

describe("P3 — JSON↔terminal channel toggle", () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-toggle-"));
    await mkdir(join(tempDir, "projects", PROJECT_ID), { recursive: true });
    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([
        { id: "m", name: "Claude", cli: "claude", context: "ctx", createdAt: new Date().toISOString() },
        { id: "mc", name: "Cursor", cli: "cursor", context: "ctx", createdAt: new Date().toISOString() },
        { id: "ma", name: "Agy", cli: "agy", context: "ctx", createdAt: new Date().toISOString() },
      ]),
    );
    const { buildServer } = await import("../server.js");
    app = await buildServer({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    hoisted.turnEvents = TURN;
    hoisted.gate = null;
    hoisted.releaseGate = null;
    hoisted.importEvents = [];
    hoisted.importWatermark = "0";
    hoisted.importCalls = 0;
    const { _clearStoreForTest } = await import("../state/project-store.js");
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    const { _resetModesCacheForTest } = await import("../routes/modes.js");
    jsonAgentRegistry.clear();
    _resetModesCacheForTest();
    _clearStoreForTest();
    await rm(join(tempDir, "projects", PROJECT_ID, "session-data"), { recursive: true, force: true });
    await seedProject();
  });

  afterEach(async () => {
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    jsonAgentRegistry.clear();
  });

  function openGate(): void {
    hoisted.gate = new Promise<void>((resolve) => {
      hoisted.releaseGate = resolve;
    });
  }

  async function waitForTurnState(sid: string, notState: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const meta = await app.inject({ method: "GET", url: `/sessions/${sid}/meta` });
      if (meta.json<{ turnState: string }>().turnState !== notState) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("turn never left idle");
  }

  // ── P3.T1 — idle gate + 400 gates ─────────────────────────────────────────

  it("P3.T1 — 409 while a turn is active OR queued (J7)", async () => {
    openGate();
    // Turn 1 starts and hangs on the gate; turn 2 is queued behind it.
    await app.inject({ method: "POST", url: `/sessions/${JSON_SID}/chat`, payload: { message: "one" } });
    await waitForTurnState(JSON_SID, "idle");
    await app.inject({ method: "POST", url: `/sessions/${JSON_SID}/chat`, payload: { message: "two" } });

    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    expect(jsonAgentRegistry.get(JSON_SID)!.getMeta().queueDepth).toBeGreaterThan(0);

    const res = await app.inject({ method: "PATCH", url: `/sessions/${JSON_SID}/channel`, payload: { channel: "tmux" } });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("not_idle");

    // Release + drain so teardown is clean.
    hoisted.releaseGate?.();
    await jsonAgentRegistry.get(JSON_SID)?.settled();
    // The channel never flipped.
    expect(await getChannel(JSON_SID)).toBe("json");
  });

  it("P3.T1 — 409 when a turn is withdrawn for edit (editingTurnIds non-empty)", async () => {
    openGate();
    await app.inject({ method: "POST", url: `/sessions/${JSON_SID}/chat`, payload: { message: "one" } });
    await waitForTurnState(JSON_SID, "idle");
    // Queue a second turn, then withdraw it into the editing hold.
    const q = await app.inject({ method: "POST", url: `/sessions/${JSON_SID}/chat`, payload: { message: "two" } });
    const heldTurnId = q.json<{ turnId: string }>().turnId;
    await app.inject({ method: "POST", url: `/sessions/${JSON_SID}/chat/queue/${heldTurnId}/edit` });

    // Release turn 1 → the queue drains to empty, turnState → idle, but the held
    // turn keeps the toggle gated.
    hoisted.releaseGate?.();
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    await jsonAgentRegistry.get(JSON_SID)?.settled();
    const meta = jsonAgentRegistry.get(JSON_SID)!.getMeta();
    expect(meta.turnState).toBe("idle");
    expect(meta.editingTurnIds).toContain(heldTurnId);

    const res = await app.inject({ method: "PATCH", url: `/sessions/${JSON_SID}/channel`, payload: { channel: "tmux" } });
    expect(res.statusCode).toBe(409);
  });

  it("P3.T1 — 400 for a direct (non-worktree) session (R1.5)", async () => {
    const res = await app.inject({ method: "PATCH", url: `/sessions/${DIRECT_SID}/channel`, payload: { channel: "tmux" } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("worktree");
  });

  it("P3.T1 — 400 for cursor + agy (no native-history importer, R1.6)", async () => {
    const cursor = await app.inject({ method: "PATCH", url: `/sessions/${CURSOR_SID}/channel`, payload: { channel: "tmux" } });
    expect(cursor.statusCode).toBe(400);
    expect(cursor.json<{ error: string }>().error).toContain("cursor");

    const agy = await app.inject({ method: "PATCH", url: `/sessions/${AGY_SID}/channel`, payload: { channel: "tmux" } });
    expect(agy.statusCode).toBe(400);
    expect(agy.json<{ error: string }>().error).toContain("agy");
  });

  it("P3.T1 — invalid channel value → 400; unknown session → 404", async () => {
    const bad = await app.inject({ method: "PATCH", url: `/sessions/${JSON_SID}/channel`, payload: { channel: "nope" } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: "PATCH", url: `/sessions/nope/channel`, payload: { channel: "tmux" } });
    expect(missing.statusCode).toBe(404);
  });

  // ── P3.T2 — round-trip continuity + backfill ──────────────────────────────

  it("P3.T2 — json→tty→json keeps the same agentChatId and imports terminal-phase turns (deduped)", async () => {
    // Run a JSON turn: captures agentChatId "chat-1" + persists a "hi" user turn.
    await runTurn(app, JSON_SID, "hi");
    expect(await getAgentChatId(JSON_SID)).toBe("chat-1");

    // json → tty: flips channel, resumes the SAME agentChatId (restore argv path).
    const spawn = await import("../services/spawn.js");
    const toTty = await app.inject({ method: "PATCH", url: `/sessions/${JSON_SID}/channel`, payload: { channel: "tmux" } });
    expect(toTty.statusCode).toBe(200);
    expect(toTty.json<{ channel: string }>().channel).toBe("tmux");
    expect(await getChannel(JSON_SID)).toBe("tmux");
    expect(await getAgentChatId(JSON_SID)).toBe("chat-1"); // continuity (J4)
    // Restore argv carried the resumed chat id.
    const argvCall = (spawn.spawnSessionFromArgv as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(argvCall?.argv).toContain("chat-1");
    // The live JSON session was detached.
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    expect(jsonAgentRegistry.get(JSON_SID)).toBeUndefined();

    // Configure the native importer: one duplicate of the JSON turn (deduped) +
    // one brand-new terminal-phase turn (imported).
    hoisted.importEvents = [
      ev("user", { role: "user", text: "hi", turnId: "nativeDup" }),
      ev("text", { role: "assistant", text: "dup echo", turnId: "nativeDup" }),
      ev("user", { role: "user", text: "terminal only turn", turnId: "nativeNew" }),
      ev("text", { role: "assistant", text: "terminal answer", turnId: "nativeNew" }),
    ];
    hoisted.importWatermark = "12";

    // tty → json: tears down the TTY, backfills terminal-phase turns from native.
    const toJson = await app.inject({ method: "PATCH", url: `/sessions/${JSON_SID}/channel`, payload: { channel: "json" } });
    expect(toJson.statusCode).toBe(200);
    expect(toJson.json<{ channel: string }>().channel).toBe("json");
    expect(await getChannel(JSON_SID)).toBe("json");
    expect(await getAgentChatId(JSON_SID)).toBe("chat-1"); // still continuous (J5)
    expect(hoisted.importCalls).toBe(1);

    // Transcript now has the original JSON turn + the NEW terminal turn, but the
    // duplicate "hi" turn was NOT double-imported (round-trip dedup, J5).
    const tr = await app.inject({ method: "GET", url: `/sessions/${JSON_SID}/transcript?all=1` });
    const events = tr.json<{ events: NormalizedEvent[] }>().events;
    expect(events.filter((e) => e.kind === "user" && e.text === "hi")).toHaveLength(1);
    expect(events.some((e) => e.text === "terminal only turn")).toBe(true);
    expect(events.some((e) => e.turnId === "nativeDup")).toBe(false);
  });

  // ── P3.T3 — two-tab mirror ─────────────────────────────────────────────────

  it("P3.T3 — a toggle broadcasts session:meta + session:updated(channel) to other tabs (N4)", async () => {
    await runTurn(app, JSON_SID, "hi");

    // A second "tab": a bare WS client (no chat:open) that just observes broadcasts.
    const observed = await new Promise<any[]>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const msgs: any[] = [];
      const t = setTimeout(() => {
        ws.close();
        reject(new Error(`timeout; got ${JSON.stringify(msgs.map((m) => m.type))}`));
      }, 6000);
      ws.on("open", () => {
        setTimeout(() => {
          void app.inject({ method: "PATCH", url: `/sessions/${JSON_SID}/channel`, payload: { channel: "tmux" } });
        }, 100);
      });
      ws.on("message", (data: Buffer) => {
        msgs.push(JSON.parse(data.toString("utf8")));
        const hasUpdated = msgs.some(
          (m) => m.type === "session:updated" && m.sessionId === JSON_SID && m.channel === "tmux",
        );
        const hasMeta = msgs.some(
          (m) => m.type === "session:meta" && m.sessionId === JSON_SID && m.meta?.channel === "tmux",
        );
        if (hasUpdated && hasMeta) {
          clearTimeout(t);
          ws.close();
          resolve(msgs);
        }
      });
      ws.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });

    expect(observed.some((m) => m.type === "session:updated" && m.channel === "tmux")).toBe(true);
    expect(observed.some((m) => m.type === "session:meta" && m.meta?.channel === "tmux")).toBe(true);
  });

  // ── P3.T4 — empty-session toggle (J12/J13) ────────────────────────────────

  it("P3.T4 — empty session: json→tty spawns fresh, tty→json import is a no-op", async () => {
    // EMPTY_SID never ran a turn → no agentChatId, no live JSON session.
    expect(await getAgentChatId(EMPTY_SID)).toBeUndefined();

    const spawn = await import("../services/spawn.js");
    const toTty = await app.inject({ method: "PATCH", url: `/sessions/${EMPTY_SID}/channel`, payload: { channel: "tmux" } });
    expect(toTty.statusCode).toBe(200);
    expect(await getChannel(EMPTY_SID)).toBe("tmux");
    // No restore argv → fresh launch via spawnSession (J12).
    expect((spawn.spawnSession as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);

    // tty → json: importer runs but with no agentChatId it is a no-op (J13).
    hoisted.importEvents = [ev("user", { role: "user", text: "should not appear", turnId: "x" })];
    const toJson = await app.inject({ method: "PATCH", url: `/sessions/${EMPTY_SID}/channel`, payload: { channel: "json" } });
    expect(toJson.statusCode).toBe(200);
    expect(await getChannel(EMPTY_SID)).toBe("json");
    // importNativeHistory short-circuits (no agentChatId) → importer never called.
    expect(hoisted.importCalls).toBe(0);

    const tr = await app.inject({ method: "GET", url: `/sessions/${EMPTY_SID}/transcript?all=1` });
    expect(tr.json<{ events: NormalizedEvent[] }>().events).toHaveLength(0);
  });

  it("P3.T4 — same-channel toggle is an idempotent no-op", async () => {
    const res = await app.inject({ method: "PATCH", url: `/sessions/${EMPTY_SID}/channel`, payload: { channel: "json" } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ channel: string }>().channel).toBe("json");
  });
});
