import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "./types";
import { ApiError } from "./errors";
import { mockTranscriptOutline, mockTranscriptOutlineWindow } from "./mockTranscriptOutline";

function userAt(logSeq: number, turnId: string): NormalizedEvent {
  return { id: `e${logSeq}`, sessionId: "s1", ts: "", provider: "claude", kind: "user", role: "user", text: `q${logSeq}`, turnId, logSeq };
}

function toolAt(logSeq: number, toolId: string, toolName: string): NormalizedEvent {
  return { id: `e${logSeq}`, sessionId: "s1", ts: "", provider: "claude", kind: "tool_use", toolName, toolId, logSeq };
}

/** `count` turns, each with one Bash call and, every third turn, one edit. */
function chat(count: number): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * 3;
    events.push(userAt(base + 1, `t${i}`));
    events.push(toolAt(base + 2, `b${i}`, i % 3 === 0 ? "write_file" : "Bash"));
  }
  return events;
}

describe("mockTranscriptOutline", () => {
  it("reports exact per-turn counts when the chat has at most 1000 turns", () => {
    const summary = mockTranscriptOutline(chat(5));
    expect(summary).toEqual({
      ready: true,
      totalTurns: 5,
      revision: "0",
      bucketSize: 1,
      tools: [1, 1, 1, 1, 1],
      edits: [1, 0, 0, 1, 0],
      errors: [0, 0, 0, 0, 0],
    });
  });

  it("buckets by ceil(total / 1000) once the chat has more than 1000 turns", () => {
    const summary = mockTranscriptOutline(chat(1001));
    expect(summary.bucketSize).toBe(2);
    expect(summary.tools).toHaveLength(501);
    expect(summary.tools.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(summary.tools[500]).toBe(1);
  });

  it("an empty chat has no buckets", () => {
    expect(mockTranscriptOutline([])).toEqual({ ready: true, totalTurns: 0, revision: "0", bucketSize: 1, tools: [], edits: [], errors: [] });
  });
});

describe("mockTranscriptOutlineWindow", () => {
  it("returns turns from..from+limit, with the summary's totals and the same counts", () => {
    const events = chat(5);
    const summary = mockTranscriptOutline(events);
    const window = mockTranscriptOutlineWindow(events, { from: 1, limit: 3 });
    expect(window.from).toBe(1);
    expect(window.totalTurns).toBe(summary.totalTurns);
    expect(window.turns.map((t) => t.seq)).toEqual([4, 7, 10]);
    expect(window.turns.map((t) => t.counts.edits)).toEqual(summary.edits.slice(1, 4));
  });

  it("defaults to 40 turns and returns an empty list past the end", () => {
    const events = chat(5);
    expect(mockTranscriptOutlineWindow(events, { from: 0 }).turns).toHaveLength(5);
    expect(mockTranscriptOutlineWindow(events, { from: 5 }).turns).toEqual([]);
  });

  it("rejects a negative from and a limit outside 1..100 as INVALID_QUERY", () => {
    const events = chat(2);
    for (const params of [{ from: -1 }, { from: 0, limit: 0 }, { from: 0, limit: 101 }, { from: 1.5 }]) {
      expect(() => mockTranscriptOutlineWindow(events, params)).toThrow(ApiError);
    }
  });
});
