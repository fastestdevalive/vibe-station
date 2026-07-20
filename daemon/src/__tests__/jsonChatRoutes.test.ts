import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord, SessionRecord, NormalizedEvent } from "../types.js";

let tempDir: string;

// Controllable turn output + captured input, shared with the mocked plugin.
const hoisted = vi.hoisted(() => ({
  turnEvents: [] as NormalizedEvent[],
  lastMessage: "",
  lastForkFrom: undefined as string | undefined,
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
    getForkCommand() {
      return ["--fork-session"];
    },
    async *runTurn(input: { message: string }, ctx: { session: { id: string }; forkFromChatId?: string }) {
      hoisted.lastMessage = input.message;
      hoisted.lastForkFrom = ctx.forkFromChatId;
      for (const e of hoisted.turnEvents) {
        yield { ...e, sessionId: ctx.session.id };
      }
    },
  };
  return { ...actual, resolvePlugin: () => mockPlugin };
});

const PROJECT_ID = "proj-c";
const SESSION_ID = `${PROJECT_ID}-d1`;
const TTY_SESSION_ID = `${PROJECT_ID}-d2`;

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

/** A non-JSON (pty) direct AGENT session — terminal-channel upload target (item 3). */
function makeTtySession(): SessionRecord {
  return {
    id: TTY_SESSION_ID,
    slot: "d2",
    type: "agent",
    modeId: "m",
    tmuxName: "__direct__-y",
    useTmux: false,
    channel: "pty",
    lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
  };
}

const PLAIN_TERMINAL_SESSION_ID = `${PROJECT_ID}-d3`;

/** A plain (non-agent) terminal session — no CLI to read an upload, still rejected. */
function makePlainTerminalSession(): SessionRecord {
  return {
    id: PLAIN_TERMINAL_SESSION_ID,
    slot: "t1",
    type: "terminal",
    tmuxName: "__direct__-z",
    useTmux: false,
    channel: "pty",
    lifecycle: { state: "not_started", lastTransitionAt: new Date().toISOString() },
  };
}

describe("JSON chat REST + WS", () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-jsonchat-"));
    await mkdir(join(tempDir, "projects", PROJECT_ID), { recursive: true });
    await writeFile(
      join(tempDir, "modes.json"),
      JSON.stringify([{ id: "m", name: "Test", cli: "claude", context: "ctx", createdAt: new Date().toISOString() }]),
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
    hoisted.lastMessage = "";
    hoisted.lastForkFrom = undefined;
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    const { _resetModesCacheForTest } = await import("../routes/modes.js");
    const { _clearAttachmentsForTest } = await import("../state/attachmentRegistry.js");
    jsonAgentRegistry.clear();
    _clearAttachmentsForTest();
    _resetModesCacheForTest();
    _clearStoreForTest();
    // Fresh transcript each test (messages.jsonl is append-only on disk).
    await rm(join(tempDir, "projects", PROJECT_ID, "sessions", SESSION_ID), { recursive: true, force: true });
    await addProject({
      id: PROJECT_ID,
      absolutePath: join(tempDir, "repo"),
      prefix: "pc",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [makeSession(), makeTtySession(), makePlainTerminalSession()],
      worktrees: [],
    } as ProjectRecord);
  });

  afterEach(async () => {
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    jsonAgentRegistry.clear();
  });

  function collectWs(open: () => void, done: (msgs: any[]) => boolean): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const msgs: any[] = [];
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`timeout; got ${JSON.stringify(msgs.map((m) => m.type))}`));
      }, 6000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "chat:open", sessionId: SESSION_ID }));
        setTimeout(open, 150);
      });
      ws.on("message", (data: Buffer) => {
        msgs.push(JSON.parse(data.toString("utf8")));
        if (done(msgs)) {
          clearTimeout(timeout);
          ws.close();
          resolve(msgs);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  it("3.T2 — POST /chat delivers session:message + session:meta to a subscribed WS client; transcript persisted", async () => {
    const msgs = await collectWs(
      () => {
        void app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat`, payload: { message: "hi agent" } });
      },
      (m) => m.some((x) => x.type === "session:message" && x.event?.kind === "result"),
    );

    const replay = msgs.find((m) => m.type === "chat:replay");
    expect(replay).toBeDefined();

    const liveEvents = msgs.filter((m) => m.type === "session:message").map((m) => m.event.kind);
    expect(liveEvents).toContain("user");
    expect(liveEvents).toContain("text");
    expect(liveEvents).toContain("result");
    expect(msgs.some((m) => m.type === "session:meta")).toBe(true);

    // Transcript persisted + retrievable via REST.
    const tr = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/transcript` });
    expect(tr.statusCode).toBe(200);
    const kinds = tr.json<{ events: NormalizedEvent[] }>().events.map((e) => e.kind);
    expect(kinds).toEqual(["user", "session_init", "text", "usage", "result"]);
  });

  it("3.T2b — POST /chat returns 202 { turnId, queuePosition }", async () => {
    const res = await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat`, payload: { message: "yo" } });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ turnId: string; queuePosition: number }>();
    expect(typeof body.turnId).toBe("string");
    expect(body.queuePosition).toBe(0);
    // wait for the turn to drain so the temp dir isn't rm'd mid-write
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    await jsonAgentRegistry.get(SESSION_ID)?.settled();
  });

  it("P4.T2/T3 — POST /chat/fork truncates the answered turn, re-runs with the fork id, broadcasts session:fork", async () => {
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    // Turn 1: run + drain so agentChatId ('chat-1') is captured + persisted.
    const r1 = await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat`, payload: { message: "q1" } });
    const turnId = r1.json<{ turnId: string }>().turnId;
    await jsonAgentRegistry.get(SESSION_ID)?.settled();

    // Fork the answered turn from a SUBSCRIBED WS client and observe the broadcast.
    const msgs = await collectWs(
      () => {
        void app.inject({
          method: "POST",
          url: `/sessions/${SESSION_ID}/chat/fork`,
          payload: { turnId, message: "q1-edited" },
        });
      },
      (m) => m.some((x) => x.type === "session:fork"),
    );
    const fork = msgs.find((m) => m.type === "session:fork");
    expect(fork).toBeDefined();
    expect(fork.supersededTurnIds).toContain(turnId); // R3.6 — other tab re-syncs

    await jsonAgentRegistry.get(SESSION_ID)?.settled();
    // The fork turn re-ran with --fork-session off the original session id.
    expect(hoisted.lastForkFrom).toBe("chat-1");
    expect(hoisted.lastMessage).toBe("q1-edited");

    // The original (superseded) turn is hidden; the new fork head is present.
    const tr = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/transcript` });
    const events = tr.json<{ events: NormalizedEvent[] }>().events;
    expect(events.some((e) => e.turnId === turnId)).toBe(false);
    expect(events.filter((e) => e.kind === "user").map((e) => e.text)).toEqual(["q1-edited"]);
  });

  it("3.T4 — upload → 201 Attachment under sessionDataDir; POST /chat injects the absolute path", async () => {
    const boundary = "----vsttest";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="notes.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `file-contents\r\n` +
      `--${boundary}--\r\n`;
    const up = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/attachments`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(201);
    const { attachments } = up.json<{ attachments: Array<{ id: string; name: string; path: string }> }>();
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.name).toBe("notes.txt");
    expect(attachments[0]!.path).toContain(join("sessions", SESSION_ID, "uploads"));

    const chat = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat`,
      payload: { message: "look at this", attachmentIds: [attachments[0]!.id] },
    });
    expect(chat.statusCode).toBe(202);
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    await jsonAgentRegistry.get(SESSION_ID)?.settled();

    // The turn saw the injected absolute path.
    expect(hoisted.lastMessage).toContain("[Attached files:]");
    expect(hoisted.lastMessage).toContain(attachments[0]!.path);
  });

  it("3.T4b — unknown attachmentId → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat`,
      payload: { message: "x", attachmentIds: ["nope"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("Fix #2 — a files-only turn (empty message + attachments) is accepted; the paths become the prompt", async () => {
    const boundary = "----vsttestfilesonly";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="only.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `contents\r\n` +
      `--${boundary}--\r\n`;
    const up = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/attachments`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(201);
    const { attachments } = up.json<{ attachments: Array<{ id: string; path: string }> }>();

    const chat = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat`,
      payload: { message: "", attachmentIds: [attachments[0]!.id] },
    });
    expect(chat.statusCode).toBe(202);
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    await jsonAgentRegistry.get(SESSION_ID)?.settled();

    // The turn ran once with a non-empty prompt built from the attachment paths.
    expect(hoisted.lastMessage.startsWith("[Attached files:]")).toBe(true);
    expect(hoisted.lastMessage).toContain(attachments[0]!.path);
  });

  it("Fix #2 — an empty message with NO attachments is rejected → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat`,
      payload: { message: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("item 3 — attachment upload to a terminal-channel (pty) AGENT session now succeeds (was Fix #4's 400)", async () => {
    const boundary = "----vsttestnonjson";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="x.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `data\r\n` +
      `--${boundary}--\r\n`;
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${TTY_SESSION_ID}/attachments`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const { attachments } = res.json<{ attachments: Array<{ id: string; name: string; path: string }> }>();
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.path).toContain(join("sessions", TTY_SESSION_ID, "uploads"));
  });

  it("item 3 — attachment upload to a plain (non-agent) terminal session → 400", async () => {
    const boundary = "----vsttestplainterm";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="x.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `data\r\n` +
      `--${boundary}--\r\n`;
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${PLAIN_TERMINAL_SESSION_ID}/attachments`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("3.T6 — chat:open replays full history; GET /meta rebuilds usage from the transcript tail after a restart", async () => {
    // Run a turn to completion.
    const res = await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat`, payload: { message: "hi" } });
    expect(res.statusCode).toBe(202);
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    await jsonAgentRegistry.get(SESSION_ID)?.settled();

    // Replay via chat:open.
    const replay = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const t = setTimeout(() => reject(new Error("no replay")), 5000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "chat:open", sessionId: SESSION_ID })));
      ws.on("message", (data: Buffer) => {
        const m = JSON.parse(data.toString("utf8"));
        if (m.type === "chat:replay") {
          clearTimeout(t);
          ws.close();
          resolve(m);
        }
      });
      ws.on("error", reject);
    });
    expect(replay.events.map((e: NormalizedEvent) => e.kind)).toEqual([
      "user",
      "session_init",
      "text",
      "usage",
      "result",
    ]);

    // Simulate a daemon restart: drop the live session, then GET /meta rebuilds
    // usage from the transcript tail.
    jsonAgentRegistry.clear();
    const meta = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/meta` });
    expect(meta.statusCode).toBe(200);
    const body = meta.json<{ usage?: { totalTokens: number }; model?: string; turnState: string }>();
    expect(body.usage?.totalTokens).toBe(15);
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.turnState).toBe("idle");
  });

  // 1.T5 — queue-controls REST error mapping (happy-path mechanics unit-tested
  // in jsonChatQueue.test.ts; here we assert the route wiring + status codes).
  it("queue-controls — edit / promote / resubmit on a non-queued turn → 404", async () => {
    // Run a turn to completion so a live agent is registered but nothing is queued.
    const res = await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat`, payload: { message: "hi" } });
    const { turnId } = res.json<{ turnId: string }>();
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    await jsonAgentRegistry.get(SESSION_ID)?.settled();

    const edit = await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat/queue/${turnId}/edit` });
    expect(edit.statusCode).toBe(404);
    expect(edit.json<{ error: string }>().error).toBe("not_queued");

    const promote = await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat/queue/${turnId}/promote` });
    expect(promote.statusCode).toBe(404);
    expect(promote.json<{ error: string }>().error).toBe("not_queued");

    const resubmit = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat/queue/${turnId}/resubmit`,
      payload: { edited: false },
    });
    expect(resubmit.statusCode).toBe(404);
    expect(resubmit.json<{ error: string }>().error).toBe("not_editing");
  });

  it("PATCH …/chat/model — live-switches, persists a restart-durable override, and clears", async () => {
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    const { getProject } = await import("../state/project-store.js");
    const override = () => getProject(PROJECT_ID)?.directSessions.find((s) => s.id === SESSION_ID)?.modelOverride;

    // Run a turn so a live agent is registered (display model = the harness model).
    await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat`, payload: { message: "hi" } });
    await jsonAgentRegistry.get(SESSION_ID)?.settled();

    // Switch → 200, meta reflects it, override persisted to the SessionRecord.
    const patch = await app.inject({
      method: "PATCH",
      url: `/sessions/${SESSION_ID}/chat/model`,
      payload: { model: "opus" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ model: string }>().model).toBe("opus");
    expect(override()).toBe("opus");
    const meta1 = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/meta` });
    expect(meta1.json<{ model?: string }>().model).toBe("opus");

    // Restart-durable: drop the live agent, GET /meta still shows the override.
    jsonAgentRegistry.clear();
    const meta2 = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/meta` });
    expect(meta2.json<{ model?: string }>().model).toBe("opus");

    // Clear → override field dropped from the SessionRecord.
    const clear = await app.inject({
      method: "PATCH",
      url: `/sessions/${SESSION_ID}/chat/model`,
      payload: { model: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(override()).toBeUndefined();
  });

  it("PATCH …/chat/model — validation: empty → 400; unknown session → 404", async () => {
    const empty = await app.inject({
      method: "PATCH",
      url: `/sessions/${SESSION_ID}/chat/model`,
      payload: { model: "" },
    });
    expect(empty.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PATCH",
      url: `/sessions/${SESSION_ID}/chat/model`,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "PATCH",
      url: `/sessions/proj-c-nope/chat/model`,
      payload: { model: "opus" },
    });
    expect(unknown.statusCode).toBe(404);

    // Non-JSON (pty) session → 400.
    const tty = await app.inject({
      method: "PATCH",
      url: `/sessions/${TTY_SESSION_ID}/chat/model`,
      payload: { model: "opus" },
    });
    expect(tty.statusCode).toBe(400);
  });

  it("queue-controls — resubmit validation: empty edit → 400; unknown attachment → 400", async () => {
    // Register an agent (so the route reaches attachment resolution).
    const res = await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat`, payload: { message: "hi" } });
    const { turnId } = res.json<{ turnId: string }>();
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    await jsonAgentRegistry.get(SESSION_ID)?.settled();

    // edited:true with blank text + no attachments → Zod refine → 400.
    const empty = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat/queue/${turnId}/resubmit`,
      payload: { edited: true, message: "   " },
    });
    expect(empty.statusCode).toBe(400);

    // edited:true with an unknown attachment id → resolution fails → 400.
    const unknown = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/chat/queue/${turnId}/resubmit`,
      payload: { edited: true, message: "x", attachmentIds: ["nope"] },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("queue-controls — edit on an unknown session → 404", async () => {
    const edit = await app.inject({ method: "POST", url: `/sessions/nope/chat/queue/t1/edit` });
    expect(edit.statusCode).toBe(404);
  });

  // ── P1 pagination (R2.1–R2.7) ──────────────────────────────────────────────

  /** Run one full turn (5 events: user + session_init + text + usage + result). */
  async function runTurn(message: string): Promise<void> {
    await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat`, payload: { message } });
    const { jsonAgentRegistry } = await import("../state/jsonAgentRegistry.js");
    await jsonAgentRegistry.get(SESSION_ID)?.settled();
  }

  it("P1.T2 — GET /transcript: default tail is bounded; ?beforeSeq keyset + ?since delta", async () => {
    await runTurn("one");
    await runTurn("two");
    await runTurn("three");
    // Three turns → seqs 0..14 (5 events each): t1 0-4, t2 5-9, t3 10-14.

    // Bounded tail (limit=1 turn) → last turn only + a keyset cursor.
    const tail = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/transcript?limit=1` });
    expect(tail.statusCode).toBe(200);
    const tailBody = tail.json<{ events: NormalizedEvent[]; oldestSeq: number; hasMore: boolean }>();
    expect(tailBody.events).toHaveLength(5);
    expect(tailBody.oldestSeq).toBe(10);
    expect(tailBody.hasMore).toBe(true);
    expect(tailBody.events[0]!.kind).toBe("user"); // turn-aligned, never mid-turn

    // Keyset "load earlier" before the tail cursor → the previous whole turn.
    const page = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION_ID}/transcript?beforeSeq=${tailBody.oldestSeq}&limit=1`,
    });
    const pageBody = page.json<{ events: NormalizedEvent[]; oldestSeq: number; hasMore: boolean }>();
    expect(pageBody.events.map((e) => e.logSeq)).toEqual([5, 6, 7, 8, 9]);
    expect(pageBody.oldestSeq).toBe(5);
    expect(pageBody.hasMore).toBe(true);

    // `since` delta → only events strictly newer than the cursor.
    const since = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/transcript?since=9` });
    const sinceBody = since.json<{ events: NormalizedEvent[] }>();
    expect(sinceBody.events.map((e) => e.logSeq)).toEqual([10, 11, 12, 13, 14]);
  });

  it("P1.T3 — chat:open replay→live loses no event and does not duplicate the tail", async () => {
    // Persist turn 1 first, so the replay window is non-empty.
    await runTurn("first");

    // Open a chat (replays the bounded tail), then run turn 2 and collect until
    // its result arrives live.
    const msgs = await collectWs(
      () => {
        void app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/chat`, payload: { message: "second" } });
      },
      (m) =>
        m.filter((x) => x.type === "session:message" && x.event?.kind === "result").length >= 1 &&
        m.some((x) => x.type === "chat:replay"),
    );

    const replay = msgs.find((m) => m.type === "chat:replay");
    // Bounded replay carries turn 1 + a cursor.
    expect(replay.hasMore).toBe(false);
    expect(replay.events[0]!.kind).toBe("user"); // turn-aligned

    // No-loss invariant (R2.7): every persisted event is covered by the replay
    // snapshot ∪ the live stream. Attach-before-snapshot may overlap at the
    // boundary — duplicates are expected and deduped by id on the client — but
    // NOTHING is dropped in the replay→live gap.
    const covered = new Set<string>([
      ...replay.events.map((e: NormalizedEvent) => e.id),
      ...msgs.filter((m) => m.type === "session:message").map((m) => m.event.id as string),
    ]);
    const full = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/transcript?all=1` });
    const allEvents = full.json<{ events: NormalizedEvent[] }>().events;
    expect(allEvents.length).toBe(10); // 2 turns × 5 events
    for (const ev of allEvents) expect(covered.has(ev.id)).toBe(true);
    // Turn 2's result arrived live (proves the live attach is working, not just replay).
    const liveKinds = msgs
      .filter((m) => m.type === "session:message")
      .map((m) => m.event.kind);
    expect(liveKinds).toContain("result");
  });

  it("P1.T4 — reconnect chat:open { sinceSeq } replays only the delta, not the full transcript", async () => {
    await runTurn("hello"); // seqs 0..4

    const replay = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const t = setTimeout(() => reject(new Error("no replay")), 5000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "chat:open", sessionId: SESSION_ID, sinceSeq: 1 })));
      ws.on("message", (data: Buffer) => {
        const m = JSON.parse(data.toString("utf8"));
        if (m.type === "chat:replay") {
          clearTimeout(t);
          ws.close();
          resolve(m);
        }
      });
      ws.on("error", reject);
    });

    // Only events strictly newer than seq 1 — not the whole turn.
    expect(replay.events.map((e: NormalizedEvent) => e.logSeq)).toEqual([2, 3, 4]);
    // A `since` delta carries no keyset cursor (it's not a window top).
    expect(replay.oldestSeq).toBeUndefined();
    expect(replay.hasMore).toBeUndefined();
  });
});
