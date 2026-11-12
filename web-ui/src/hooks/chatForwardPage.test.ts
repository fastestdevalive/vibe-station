import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@/api/types";
import { alignForwardPage, firstLogSeq } from "./chatForwardPage";

function row(logSeq: number, turnId?: string): NormalizedEvent {
  return { id: `e${logSeq}`, sessionId: "s1", ts: "", provider: "claude", kind: "text", logSeq, ...(turnId ? { turnId } : {}) };
}

describe("alignForwardPage", () => {
  it("keeps the whole page when nothing newer exists", () => {
    const events = [row(11, "a"), row(12, "b")];
    expect(alignForwardPage({ events, nextSeq: 12, hasMore: false }, 10)).toEqual({ events, cursor: 12, hasMore: false });
  });

  it("drops the trailing rows of the last turn while newer rows exist, and pages on from the cut", () => {
    const events = [row(11, "a"), row(12, "a"), row(13, "b"), row(14, "b")];
    const page = alignForwardPage({ events, nextSeq: 14, hasMore: true }, 10);
    expect(page.events.map((e) => e.logSeq)).toEqual([11, 12]);
    expect(page.cursor).toBe(12);
    expect(page.hasMore).toBe(true);
  });

  it("rows without a turn id inside the last turn are dropped with it", () => {
    const events = [row(11, "a"), row(12, "b"), row(13), row(14, "b")];
    const page = alignForwardPage({ events, nextSeq: 14, hasMore: true }, 10);
    expect(page.events.map((e) => e.logSeq)).toEqual([11]);
    expect(page.cursor).toBe(11);
  });

  it("keeps a page that is a single turn longer than the page", () => {
    const events = [row(11, "a"), row(12, "a"), row(13, "a")];
    expect(alignForwardPage({ events, nextSeq: 13, hasMore: true }, 10)).toEqual({ events, cursor: 13, hasMore: true });
  });

  it("keeps a page ending on a legacy row without a turn id", () => {
    const events = [row(11, "a"), row(12), row(13)];
    expect(alignForwardPage({ events, nextSeq: 13, hasMore: true }, 10)).toEqual({ events, cursor: 13, hasMore: true });
  });

  it("an empty page keeps the cursor it was asked from unless the daemon moved it", () => {
    expect(alignForwardPage({ events: [], hasMore: false }, 10)).toEqual({ events: [], cursor: 10, hasMore: false });
    expect(alignForwardPage({ events: [], nextSeq: 15, hasMore: true }, 10)).toEqual({ events: [], cursor: 15, hasMore: true });
  });
});

describe("firstLogSeq", () => {
  it("is the first event's cursor, skipping events without one", () => {
    const noSeq: NormalizedEvent = { id: "x", sessionId: "s1", ts: "", provider: "claude", kind: "text" };
    expect(firstLogSeq([noSeq, row(7), row(8)])).toBe(7);
    expect(firstLogSeq([noSeq])).toBeNull();
    expect(firstLogSeq([])).toBeNull();
  });
});
