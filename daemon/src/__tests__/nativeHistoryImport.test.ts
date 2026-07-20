import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createClaudeHistoryImporter } from "../agent-plugins/claudeImport.js";
import { createOpencodeHistoryImporter } from "../agent-plugins/opencodeImport.js";
import { openSqliteTranscriptStore } from "../services/sqliteTranscriptStore.js";
import {
  getNativeHistoryImporter,
  hasNativeHistoryImporter,
} from "../services/nativeHistoryImporter.js";
import type { NormalizedEvent } from "../types.js";

let tmp: string;
const SESSION_ID = "sess-import-1";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vst-import-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P2.T1 — claude at-rest adapter golden (crafted .jsonl fixture)
// ---------------------------------------------------------------------------
describe("P2.T1 — claude native-history adapter", () => {
  const CWD = "/home/u/.wt/proj"; // slug = -home-u--wt-proj
  const CHAT_ID = "cccccccc-1111-2222-3333-444444444444";
  const BIG_BASE64 = "A".repeat(4096);

  async function seedClaudeStore(): Promise<void> {
    const slug = CWD.replaceAll("/", "-").replaceAll(".", "-");
    const dir = join(tmp, "projects", slug);
    await mkdir(dir, { recursive: true });
    const lines = [
      // Non-turn envelope lines — all skipped.
      { type: "system", subtype: "init", session_id: CHAT_ID, model: "claude-sonnet-4-6" },
      { type: "mode", mode: "acceptEdits" },
      { type: "ai-title", title: "chat" },
      // Turn 1 — user prompt (string content).
      { type: "user", uuid: "u1", timestamp: "2026-07-18T00:00:00Z", message: { role: "user", content: "Hello there" } },
      // Turn 1 — assistant thinking + text + usage.
      {
        type: "assistant",
        timestamp: "2026-07-18T00:00:01Z",
        message: {
          model: "claude-sonnet-4-6",
          content: [
            { type: "thinking", thinking: "pondering" },
            { type: "text", text: "Hi!" },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 3,
          },
        },
      },
      // Turn 1 — assistant tool_use.
      {
        type: "assistant",
        timestamp: "2026-07-18T00:00:02Z",
        message: { model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "x" } }] },
      },
      // Turn 1 — tool_result carrying an inline base64 image (must be stripped).
      {
        type: "user",
        timestamp: "2026-07-18T00:00:03Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: BIG_BASE64 } }],
            },
          ],
        },
      },
      // A synthetic caveat (isMeta) — skipped, does not open a turn.
      { type: "user", uuid: "meta1", isMeta: true, message: { role: "user", content: "caveat noise" } },
      // Turn 2 — user prompt (text blocks form).
      { type: "user", uuid: "u2", timestamp: "2026-07-18T00:00:04Z", message: { role: "user", content: [{ type: "text", text: "Second question" }] } },
      {
        type: "assistant",
        timestamp: "2026-07-18T00:00:05Z",
        message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "Answer 2" }], usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      },
    ];
    await writeFile(join(dir, `${CHAT_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }

  it("emits user prompts, derives usage from message.usage, strips inline base64", async () => {
    await seedClaudeStore();
    const importer = createClaudeHistoryImporter({ projectsDir: join(tmp, "projects") });
    const { events, nextWatermark } = await importer.import({
      sessionId: SESSION_ID,
      agentChatId: CHAT_ID,
      cwd: CWD,
    });

    // User prompts present (the at-rest store is the only source of these).
    const users = events.filter((e) => e.kind === "user");
    expect(users.map((e) => e.text)).toEqual(["Hello there", "Second question"]);
    // Every user prompt opened a distinct turn.
    expect(users.map((e) => e.turnId)).toEqual(["u1", "u2"]);
    // The whole of turn 1 is grouped under u1 (usage rides its own assistant line,
    // so it lands right after that line's text, before the later tool_use line).
    expect(events.filter((e) => e.turnId === "u1").map((e) => e.kind)).toEqual([
      "user",
      "thinking",
      "text",
      "usage",
      "tool_use",
      "tool_result",
    ]);

    // Usage derived from assistant.message.usage (no synthetic result line).
    const usage = events.find((e) => e.kind === "usage")!;
    expect(usage.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreateTokens: 3, totalTokens: 20, model: "claude-sonnet-4-6" });
    expect(usage.model).toBe("claude-sonnet-4-6");

    // Inline base64 stripped — the raw blob never enters the normalized event.
    const toolResult = events.find((e) => e.kind === "tool_result")!;
    expect(toolResult.toolResult?.content).not.toContain(BIG_BASE64);
    expect(toolResult.toolResult?.content).toContain("stripped");

    // Watermark is the native line count (line-index cursor).
    expect(Number(nextWatermark)).toBeGreaterThan(0);
    // provider stamped correctly.
    expect(events.every((e) => e.provider === "claude")).toBe(true);
  });

  it("resumes past the watermark — a second import yields only newer lines", async () => {
    await seedClaudeStore();
    const importer = createClaudeHistoryImporter({ projectsDir: join(tmp, "projects") });
    const first = await importer.import({ sessionId: SESSION_ID, agentChatId: CHAT_ID, cwd: CWD });
    // Re-import from the returned watermark → nothing new (no lines appended).
    const second = await importer.import({
      sessionId: SESSION_ID,
      agentChatId: CHAT_ID,
      cwd: CWD,
      watermark: first.nextWatermark,
    });
    expect(second.events).toHaveLength(0);
    expect(second.nextWatermark).toBe(first.nextWatermark);
  });

  it("returns empty for a missing native store", async () => {
    const importer = createClaudeHistoryImporter({ projectsDir: join(tmp, "projects") });
    const r = await importer.import({ sessionId: SESSION_ID, agentChatId: "nope", cwd: CWD });
    expect(r.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P2.T2 — opencode at-rest adapter golden (crafted sqlite fixture)
// ---------------------------------------------------------------------------
describe("P2.T2 — opencode native-history adapter", () => {
  const CHAT_ID = "ses_test000000000000000000000";

  function seedOpencodeDb(): string {
    const dbPath = join(tmp, "opencode.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    const insMsg = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)");
    const insPart = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)");
    // User message + its text part.
    insMsg.run("m1", CHAT_ID, 1000, JSON.stringify({ role: "user", time: { created: 1000 } }));
    insPart.run("p1", "m1", CHAT_ID, 1000, JSON.stringify({ type: "text", text: "Say the word PINEAPPLE" }));
    // Assistant message with tokens + reasoning/text/tool parts.
    insMsg.run(
      "m2",
      CHAT_ID,
      2000,
      JSON.stringify({ role: "assistant", modelID: "big-pickle", time: { created: 2000 }, tokens: { input: 9, output: 3, cache: { read: 1, write: 2 } } }),
    );
    insPart.run("p2", "m2", CHAT_ID, 2001, JSON.stringify({ type: "reasoning", text: "thinking..." }));
    insPart.run("p3", "m2", CHAT_ID, 2002, JSON.stringify({ type: "text", text: "PINEAPPLE" }));
    insPart.run(
      "p4",
      "m2",
      CHAT_ID,
      2003,
      JSON.stringify({ type: "tool", tool: "glob", callID: "c1", state: { status: "completed", input: { pattern: "*" }, output: "match" } }),
    );
    // A DIFFERENT session — must be filtered out.
    insMsg.run("m9", "ses_other", 1500, JSON.stringify({ role: "user", time: { created: 1500 } }));
    insPart.run("p9", "m9", "ses_other", 1500, JSON.stringify({ type: "text", text: "other session" }));
    db.close();
    return dbPath;
  }

  it("synthesizes user events from part rows, maps assistant parts + usage, filters by session", async () => {
    const dbPath = seedOpencodeDb();
    const importer = createOpencodeHistoryImporter({ dbPath });
    const { events, nextWatermark } = await importer.import({
      sessionId: SESSION_ID,
      agentChatId: CHAT_ID,
      cwd: "/whatever",
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["user", "thinking", "text", "tool_use", "tool_result", "usage"]);

    // User event synthesized from the user message's text part.
    const user = events.find((e) => e.kind === "user")!;
    expect(user.text).toBe("Say the word PINEAPPLE");
    expect(user.turnId).toBe("m1");
    // Assistant events inherit the user message's id as the turn id.
    expect(events.filter((e) => e.kind !== "user").every((e) => e.turnId === "m1")).toBe(true);

    // Usage from message.tokens.
    const usage = events.find((e) => e.kind === "usage")!;
    expect(usage.usage).toMatchObject({ inputTokens: 9, outputTokens: 3, cacheReadTokens: 1, cacheCreateTokens: 2, totalTokens: 15, model: "big-pickle" });

    // Nothing from ses_other leaked in.
    expect(events.some((e) => e.text === "other session")).toBe(false);
    // Watermark = max message.time_created imported.
    expect(nextWatermark).toBe("2000");
    expect(events.every((e) => e.provider === "opencode")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared helper for store-import tests
// ---------------------------------------------------------------------------
function ev(kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId: SESSION_ID,
    ts: new Date().toISOString(),
    provider: "claude",
    kind,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// P2.T3 — round-trip dedup (J5): importing already-mirrored turns adds nothing
// ---------------------------------------------------------------------------
describe("P2.T3 — importTransaction round-trip dedup", () => {
  it("skips a turn whose user content is already mirrored (different turn id)", () => {
    const store = openSqliteTranscriptStore(tmp, SESSION_ID);
    // A JSON-phase turn already in our store (daemon turn id).
    store.append(ev("user", { role: "user", text: "First prompt", turnId: "daemon-t1" }));
    store.append(ev("text", { role: "assistant", text: "answer 1", turnId: "daemon-t1" }));
    const before = store.count();

    // Native import re-surfaces that same prompt (native turn id) + a NEW turn.
    const imported: NormalizedEvent[] = [
      ev("user", { role: "user", text: "First prompt", turnId: "nativeA" }),
      ev("text", { role: "assistant", text: "answer 1", turnId: "nativeA" }),
      ev("user", { role: "user", text: "Terminal-only turn", turnId: "nativeB" }),
      ev("text", { role: "assistant", text: "answer 2", turnId: "nativeB" }),
    ];
    const outcome = store.importTransaction(imported, { cli: "claude", cursor: "42" });

    expect(outcome.turnsImported).toBe(1);
    expect(outcome.turnsSkipped).toBe(1);
    expect(outcome.imported).toBe(2); // only nativeB's two events
    expect(store.count()).toBe(before + 2);
    // The new terminal turn landed; the duplicate did not double-import.
    expect(store.readAll().filter((e) => e.text === "First prompt")).toHaveLength(1);
    expect(store.readAll().some((e) => e.turnId === "nativeB")).toBe(true);
    // Watermark persisted.
    expect(store.getNativeWatermark()).toEqual({ cli: "claude", cursor: "42" });
    store.close();
  });

  it("skips whole turns on a same-CLI re-import (turn-id dedup)", () => {
    const store = openSqliteTranscriptStore(tmp, SESSION_ID);
    const batch: NormalizedEvent[] = [
      ev("user", { role: "user", text: "A", turnId: "n1" }),
      ev("text", { role: "assistant", text: "a", turnId: "n1" }),
    ];
    const first = store.importTransaction(batch, { cli: "claude", cursor: "1" });
    expect(first.turnsImported).toBe(1);
    // Re-import the identical batch → all skipped, nothing appended.
    const second = store.importTransaction(batch, { cli: "claude", cursor: "2" });
    expect(second.turnsImported).toBe(0);
    expect(second.turnsSkipped).toBe(1);
    expect(second.imported).toBe(0);
    expect(store.getNativeWatermark()?.cursor).toBe("2");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// P2.T4 — crash/rollback (J14): a failing import leaves rows + watermark intact
// ---------------------------------------------------------------------------
describe("P2.T4 — importTransaction rollback on failure", () => {
  it("rolls back all rows and leaves the watermark unchanged when an event fails to serialize", () => {
    const store = openSqliteTranscriptStore(tmp, SESSION_ID);
    // Seed a prior successful import so there IS an existing watermark to preserve.
    store.importTransaction([ev("user", { role: "user", text: "seed", turnId: "seed" })], { cli: "claude", cursor: "10" });
    const countBefore = store.count();
    const watermarkBefore = store.getNativeWatermark();

    // A second turn contains an un-serializable (circular) toolInput → JSON.stringify throws.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const failing: NormalizedEvent[] = [
      ev("user", { role: "user", text: "good turn", turnId: "ok" }),
      ev("user", { role: "user", text: "bad turn", turnId: "bad" }),
      ev("tool_use", { role: "assistant", turnId: "bad", toolInput: circular }),
    ];

    expect(() => store.importTransaction(failing, { cli: "claude", cursor: "99" })).toThrow();

    // No partial rows, watermark unchanged (still at cursor 10).
    expect(store.count()).toBe(countBefore);
    expect(store.getNativeWatermark()).toEqual(watermarkBefore);
    expect(store.readAll().some((e) => e.text === "good turn")).toBe(false);

    // nextSeq was NOT advanced by the rolled-back attempt — a normal append stays gap-free.
    const seq = store.append(ev("user", { role: "user", text: "next", turnId: "next" }));
    expect(seq).toBe(countBefore); // continues from MAX+1, no gap
    store.close();
  });
});

// ---------------------------------------------------------------------------
// P2.T5 — observability (N5): import counts + dedup skips are logged
// ---------------------------------------------------------------------------
describe("P2.T5 — import observability", () => {
  it("logs import counts + dedup skips", () => {
    const store = openSqliteTranscriptStore(tmp, SESSION_ID);
    store.append(ev("user", { role: "user", text: "dup", turnId: "d1" }));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    store.importTransaction(
      [
        ev("user", { role: "user", text: "dup", turnId: "nA" }), // dedup by content
        ev("user", { role: "user", text: "fresh", turnId: "nB" }),
      ],
      { cli: "claude", cursor: "7" },
    );
    const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[native-import]"));
    spy.mockRestore();
    expect(line).toBeDefined();
    expect(line).toContain("turnsImported=1");
    expect(line).toContain("turnsSkipped=1");
    expect(line).toContain("cli=claude");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Registry — the P3 toggle gate (claude + opencode present; cursor + agy absent)
// ---------------------------------------------------------------------------
describe("native-history importer registry (P3 gate)", () => {
  it("exposes claude + opencode and withholds cursor + agy (deferred)", () => {
    expect(hasNativeHistoryImporter("claude")).toBe(true);
    expect(hasNativeHistoryImporter("opencode")).toBe(true);
    expect(hasNativeHistoryImporter("cursor")).toBe(false);
    expect(hasNativeHistoryImporter("agy")).toBe(false);
    expect(getNativeHistoryImporter("claude")?.cli).toBe("claude");
    expect(getNativeHistoryImporter("agy")).toBeUndefined();
  });
});
