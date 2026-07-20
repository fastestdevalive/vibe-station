import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteTranscriptStore, transcriptDbPath } from "../services/sqliteTranscriptStore.js";
import type { NormalizedEvent } from "../types.js";

let dataDir: string;
const SESSION_ID = "sess-store-1";

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

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "vst-store-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("P0.T1 — SqliteTranscriptStore logSeq durability", () => {
  it("assigns gap-free, monotonic logSeq across appends and returns it", () => {
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);
    const seqs = [
      store.append(ev("user", { text: "a", turnId: "t1" })),
      store.append(ev("session_init", { turnId: "t1" })),
      store.append(ev("text", { text: "hi", turnId: "t1" })),
    ];
    expect(seqs).toEqual([0, 1, 2]);
    // logSeq stamped onto the returned events too.
    expect(store.readAll().map((e) => e.logSeq)).toEqual([0, 1, 2]);
    expect(store.count()).toBe(3);
    store.close();
  });

  it("reseeds next = MAX(seq)+1 after reopen (restart durability, J8)", () => {
    const s1 = openSqliteTranscriptStore(dataDir, SESSION_ID);
    s1.append(ev("user", { text: "a", turnId: "t1" }));
    s1.append(ev("result", { turnId: "t1" }));
    s1.close();

    // Reopen: the next append must continue from MAX+1, not restart at 0.
    const s2 = openSqliteTranscriptStore(dataDir, SESSION_ID);
    const next = s2.append(ev("user", { text: "b", turnId: "t2" }));
    expect(next).toBe(2);
    expect(s2.readAll().map((e) => e.logSeq)).toEqual([0, 1, 2]);
    s2.close();
  });

  it("lastMeta returns the last model + last real usage", () => {
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);
    store.append(ev("session_init", { model: "claude-sonnet-4-5" }));
    store.append(ev("usage", { usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 10 } }));
    // A no-op turn reports 0 tokens — must NOT clobber the last real usage.
    store.append(ev("usage", { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 0 } }));
    const meta = store.lastMeta();
    expect(meta.model).toBe("claude-sonnet-4-5");
    expect(meta.usage?.totalTokens).toBe(10);
    store.close();
  });
});

describe("P1.T1 — tail / pageBefore keyset (turn-aligned, never split)", () => {
  const USAGE = { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 10 };
  /** Append one turn of [user, text, result] under `turnId`. Returns first seq. */
  function appendTurn(store: ReturnType<typeof openSqliteTranscriptStore>, turnId: string): number {
    const first = store.append(ev("user", { role: "user", text: `q ${turnId}`, turnId }));
    store.append(ev("text", { role: "assistant", text: `a ${turnId}`, turnId }));
    store.append(ev("result", { turnId }));
    return first;
  }

  it("tail(N) returns exactly the last N whole turns + a correct cursor", () => {
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);
    const firstSeqs: Record<string, number> = {};
    for (let i = 1; i <= 25; i++) firstSeqs[`t${i}`] = appendTurn(store, `t${i}`);

    const page = store.tail(20);
    // 20 turns × 3 events = 60 events.
    expect(page.events).toHaveLength(60);
    // Window starts at the FIRST event of the 20th-newest turn (t6) — never mid-turn.
    expect(page.oldestSeq).toBe(firstSeqs.t6);
    expect(page.events[0]!.turnId).toBe("t6");
    expect(page.events[0]!.kind).toBe("user");
    expect(page.hasMore).toBe(true);
    // Newest turn present, oldest excluded.
    expect(page.events.some((e) => e.turnId === "t25")).toBe(true);
    expect(page.events.some((e) => e.turnId === "t5")).toBe(false);
    store.close();
  });

  it("tail(N) with fewer than N turns returns everything, hasMore false", () => {
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);
    appendTurn(store, "t1");
    appendTurn(store, "t2");
    const page = store.tail(20);
    expect(page.events).toHaveLength(6);
    expect(page.oldestSeq).toBe(0);
    expect(page.hasMore).toBe(false);
    store.close();
  });

  it("pageBefore returns the correct older page, turn-aligned, with hasMore", () => {
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);
    const firstSeqs: Record<string, number> = {};
    for (let i = 1; i <= 5; i++) firstSeqs[`t${i}`] = appendTurn(store, `t${i}`);

    // Load the last 2 turns first (tail-2), then page before its cursor.
    const tail = store.tail(2);
    expect(tail.oldestSeq).toBe(firstSeqs.t4);

    // Ask for 2 rows before t4's first seq — the boundary lands mid-turn (t3),
    // so the page must extend back to t3's first seq (never split a turn).
    const page = store.pageBefore(tail.oldestSeq!, 2);
    expect(page.events[0]!.turnId).toBe("t3");
    expect(page.events[0]!.kind).toBe("user");
    expect(page.oldestSeq).toBe(firstSeqs.t3);
    // Every event is strictly before the tail cursor.
    expect(page.events.every((e) => (e.logSeq ?? 0) < tail.oldestSeq!)).toBe(true);
    // Older rows (t1, t2) remain.
    expect(page.hasMore).toBe(true);
    store.close();
  });

  it("since(seq) returns only events strictly newer than the cursor", () => {
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);
    for (let i = 1; i <= 3; i++) appendTurn(store, `t${i}`);
    // seq 0..8; since(5) → seq 6,7,8.
    const delta = store.since(5);
    expect(delta.map((e) => e.logSeq)).toEqual([6, 7, 8]);
    store.close();
  });

  it("P1.T5 — lastMeta finds a model-bearing event OLDER than the tail window (J11)", () => {
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);
    // Turn 1 carries the model + real usage.
    store.append(ev("session_init", { model: "claude-opus-4", turnId: "t1" }));
    store.append(ev("usage", { usage: USAGE, turnId: "t1" }));
    store.append(ev("result", { turnId: "t1" }));
    // 30 later turns with NO model/usage — well past a tail-20 window.
    for (let i = 2; i <= 31; i++) {
      store.append(ev("user", { role: "user", text: "x", turnId: `t${i}` }));
      store.append(ev("text", { role: "assistant", text: "y", turnId: `t${i}` }));
      store.append(ev("result", { turnId: `t${i}` }));
    }
    // The model event is OUTSIDE the tail window …
    const tail = store.tail(20);
    expect(tail.events.some((e) => e.model === "claude-opus-4")).toBe(false);
    // … but lastMeta still resolves it via the bounded reverse scan.
    const meta = store.lastMeta();
    expect(meta.model).toBe("claude-opus-4");
    expect(meta.usage?.totalTokens).toBe(10);
    store.close();
  });
});

describe("P4.T1 — markSupersededFrom (fork truncation, R3.4)", () => {
  /** Append one turn of [user, text, result] under `turnId`. Returns first seq. */
  function appendTurn(store: ReturnType<typeof openSqliteTranscriptStore>, turnId: string): number {
    const first = store.append(ev("user", { role: "user", text: `q ${turnId}`, turnId }));
    store.append(ev("text", { role: "assistant", text: `a ${turnId}`, turnId }));
    store.append(ev("result", { turnId }));
    return first;
  }

  it("flags rows ≥ the fork seq, leaves earlier rows, and hides them from every read", () => {
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);
    const s1 = appendTurn(store, "t1"); // 0..2
    const s2 = appendTurn(store, "t2"); // 3..5
    appendTurn(store, "t3"); // 6..8
    expect(store.firstSeqOfTurn("t2")).toBe(s2);

    // Fork at t2 → t2 + t3 superseded; the returned turnIds drive the broadcast.
    const superseded = store.markSupersededFrom(s2);
    expect(new Set(superseded)).toEqual(new Set(["t2", "t3"]));

    // Earlier rows untouched; superseded rows excluded from all live reads.
    expect(store.count()).toBe(3);
    expect(store.readAll().map((e) => e.turnId)).toEqual(["t1", "t1", "t1"]);
    expect(store.firstSeqOfTurn("t1")).toBe(s1);
    expect(store.firstSeqOfTurn("t2")).toBeUndefined(); // no live rows left

    const tail = store.tail(20);
    expect(tail.events.every((e) => e.turnId === "t1")).toBe(true);
    expect(tail.hasMore).toBe(false);
    // `since` also excludes superseded — a reconnect never replays a forked branch.
    expect(store.since(s1).some((e) => e.turnId === "t2" || e.turnId === "t3")).toBe(false);
    store.close();
  });

  it("markSupersededFrom(0) supersedes everything → empty live transcript", () => {
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);
    appendTurn(store, "t1");
    appendTurn(store, "t2");
    store.markSupersededFrom(0);
    expect(store.count()).toBe(0);
    expect(store.readAll()).toEqual([]);
    expect(store.tail(20).events).toEqual([]);
    // A later live append continues gap-free from MAX(seq)+1 (superseded rows kept).
    const seq = store.append(ev("user", { text: "new", turnId: "t3" }));
    expect(seq).toBe(6);
    store.close();
  });
});

describe("1.T4 — oversized tool_result backfill migration (incl. superseded rows)", () => {
  it("caps both a live and a superseded oversized row on reopen, idempotently", async () => {
    const { TOOL_RESULT_MAX_BYTES } = await import("../services/toolResultCap.js");
    const bigA = "A".repeat(TOOL_RESULT_MAX_BYTES + 100);
    const bigB = "B".repeat(TOOL_RESULT_MAX_BYTES + 200);

    // s1.append() does NOT cap — capping only happens at the jsonAgent
    // handleEvent / importTransaction call sites — so this seeds genuinely
    // oversized rows, as if written before the cap existed.
    const s1 = openSqliteTranscriptStore(dataDir, SESSION_ID);
    s1.append(ev("user", { text: "q1", turnId: "t1" }));
    s1.append(ev("tool_result", { turnId: "t1", toolId: "t1", toolResult: { content: bigA } }));
    const forkSeq = s1.append(ev("user", { text: "q2", turnId: "t2" }));
    s1.append(ev("tool_result", { turnId: "t2", toolId: "t2", toolResult: { content: bigB } }));
    // Fork/edit truncates t2 — it's superseded but still reachable via since().
    s1.markSupersededFrom(forkSeq);
    s1.close();

    // Reopen: the constructor-time backfill migration must cap BOTH rows,
    // including the superseded one.
    const s2 = openSqliteTranscriptStore(dataDir, SESSION_ID);
    const liveResult = s2.readAll().find((e) => e.kind === "tool_result");
    expect(liveResult?.toolResult?.content).not.toContain(bigA);
    expect(liveResult?.toolResult?.content).toContain("omitted");

    // Superseded row excluded from readAll — check it via a raw since() gap-fill
    // from before the fork point (since() does not filter by superseded... but
    // readAll/tail do). Use since(-1) is not valid; instead reopen and inspect
    // via the underlying DB file directly is overkill — use markSupersededFrom's
    // sibling read path: `since` DOES exclude superseded too, so assert via the
    // raw sqlite file instead.
    s2.close();

    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(transcriptDbPath(dataDir));
    const rows = raw
      .prepare("SELECT payload FROM message WHERE session_id = ? AND kind = 'tool_result' ORDER BY seq ASC")
      .all(SESSION_ID) as { payload: string }[];
    raw.close();
    expect(rows).toHaveLength(2);
    const parsed = rows.map((r) => JSON.parse(r.payload));
    expect(parsed[0].toolResult.content).not.toContain(bigA);
    expect(parsed[0].toolResult.content).toContain("omitted");
    expect(parsed[1].toolResult.content).not.toContain(bigB);
    expect(parsed[1].toolResult.content).toContain("omitted");

    // Third open: idempotent — no further mutation, rows already capped/short.
    const s3 = openSqliteTranscriptStore(dataDir, SESSION_ID);
    const raw2 = new Database(transcriptDbPath(dataDir));
    const rows2 = raw2
      .prepare("SELECT payload FROM message WHERE session_id = ? AND kind = 'tool_result' ORDER BY seq ASC")
      .all(SESSION_ID) as { payload: string }[];
    raw2.close();
    expect(rows2.map((r) => r.payload)).toEqual(rows.map((r) => r.payload));
    s3.close();
  });

  it("leaves a normal-size tool_result row unchanged across reopen", () => {
    const normalContent = "short read result";
    const s1 = openSqliteTranscriptStore(dataDir, SESSION_ID);
    s1.append(ev("user", { text: "q1", turnId: "t1" }));
    s1.append(ev("tool_result", { turnId: "t1", toolId: "t1", toolResult: { content: normalContent } }));
    s1.close();

    const s2 = openSqliteTranscriptStore(dataDir, SESSION_ID);
    const result = s2.readAll().find((e) => e.kind === "tool_result");
    expect(result?.toolResult?.content).toBe(normalContent);
    s2.close();
  });
});

describe("P0.T2 / P0.T4 — legacy messages.jsonl migration", () => {
  const legacyLines = [
    // Legacy lines carry NO logSeq (backward-compat, N3).
    { id: "e0", sessionId: SESSION_ID, ts: "2026-01-01T00:00:00Z", provider: "claude", kind: "user", role: "user", text: "hello", turnId: "t1" },
    { id: "e1", sessionId: SESSION_ID, ts: "2026-01-01T00:00:01Z", provider: "claude", kind: "session_init", turnId: "t1", agentChatId: "chat-1" },
    // An attachment path-ref user event must survive intact (J10).
    {
      id: "e2",
      sessionId: SESSION_ID,
      ts: "2026-01-01T00:00:02Z",
      provider: "claude",
      kind: "user",
      role: "user",
      text: "see this",
      turnId: "t2",
      attachments: [{ id: "up1", name: "img.png", path: "/data/up1/img.png", size: 12, mime: "image/png" }],
    },
    { id: "e3", sessionId: SESSION_ID, ts: "2026-01-01T00:00:03Z", provider: "claude", kind: "result", turnId: "t2", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 15 } },
  ];

  async function seedLegacy(): Promise<void> {
    // Includes a trailing newline + a blank line (skipped, no seq consumed).
    const body = legacyLines.map((l) => JSON.stringify(l)).join("\n") + "\n\n";
    await writeFile(join(dataDir, "messages.jsonl"), body, "utf8");
  }

  it("imports jsonl → SQLite, reconciles count, retains .jsonl, attachment survives", async () => {
    await seedLegacy();
    const store = openSqliteTranscriptStore(dataDir, SESSION_ID);

    const all = store.readAll();
    expect(all).toHaveLength(4);
    expect(store.count()).toBe(4);
    // Gap-free logSeq synthesized from the line index (0..3).
    expect(all.map((e) => e.logSeq)).toEqual([0, 1, 2, 3]);

    // Attachment path-ref user event survived intact (J10).
    const withAttachment = all.find((e) => e.id === "e2")!;
    expect(withAttachment.attachments).toEqual([
      { id: "up1", name: "img.png", path: "/data/up1/img.png", size: 12, mime: "image/png" },
    ]);
    // All original fields preserved (P0.T4 — lossless legacy read).
    expect(withAttachment.text).toBe("see this");
    expect(withAttachment.turnId).toBe("t2");

    // The .jsonl is KEPT as a read-only backup (never deleted).
    expect(existsSync(join(dataDir, "messages.jsonl"))).toBe(true);
    // The DB file exists.
    expect(existsSync(transcriptDbPath(dataDir))).toBe(true);
    store.close();
  });

  it("is idempotent — re-open does not double-import", async () => {
    await seedLegacy();
    const s1 = openSqliteTranscriptStore(dataDir, SESSION_ID);
    expect(s1.count()).toBe(4);
    s1.close();

    // Second open: migration is a no-op (DB already has rows).
    const s2 = openSqliteTranscriptStore(dataDir, SESSION_ID);
    expect(s2.count()).toBe(4);
    // A subsequent live append continues from MAX+1, not colliding with imports.
    const seq = s2.append(ev("user", { text: "new", turnId: "t3" }));
    expect(seq).toBe(4);
    s2.close();
  });
});
