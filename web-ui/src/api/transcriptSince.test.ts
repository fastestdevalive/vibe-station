import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClientApi } from "./client";
import { createMockApi } from "./mock";
import { MOCK_SINCE_PAGE_SIZE, mockGetTranscriptSince } from "./mockTranscriptSearch";
import { createChatRepository } from "./repositories/chatRepository";
import type { NormalizedEvent } from "./types";

function rows(count: number, start = 1): NormalizedEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${start + i}`,
    sessionId: "s1",
    ts: "",
    provider: "claude" as const,
    kind: "text" as const,
    logSeq: start + i,
  }));
}

describe("mockGetTranscriptSince", () => {
  it("returns the rows strictly newer than the cursor, one page at a time", () => {
    const all = rows(MOCK_SINCE_PAGE_SIZE + 50);
    const first = mockGetTranscriptSince(all, 10);
    expect(first.events).toHaveLength(MOCK_SINCE_PAGE_SIZE);
    expect(first.events[0]!.logSeq).toBe(11);
    expect(first.nextSeq).toBe(10 + MOCK_SINCE_PAGE_SIZE);
    expect(first.hasMore).toBe(true);

    const second = mockGetTranscriptSince(all, first.nextSeq!);
    expect(second.events.map((e) => e.logSeq)).toEqual(
      Array.from({ length: 40 }, (_, i) => 11 + MOCK_SINCE_PAGE_SIZE + i),
    );
    expect(second.nextSeq).toBe(MOCK_SINCE_PAGE_SIZE + 50);
    expect(second.hasMore).toBe(false);
  });

  it("answers an empty page with no cursor at the tail", () => {
    expect(mockGetTranscriptSince(rows(5), 5)).toEqual({ events: [], hasMore: false });
    expect(mockGetTranscriptSince([], 0)).toEqual({ events: [], hasMore: false });
  });

  it("skips superseded rows and returns copies", () => {
    const all = rows(3);
    all[1] = { ...all[1]!, superseded: true };
    const page = mockGetTranscriptSince(all, 0);
    expect(page.events.map((e) => e.logSeq)).toEqual([1, 3]);
    expect(page.events[0]).not.toBe(all[0]);
  });
});

describe("getTranscriptSince", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
  });

  it("the client requests the since page under /api", async () => {
    const body = { events: rows(2, 43), nextSeq: 44, hasMore: true };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);
    const page = await createClientApi().getTranscriptSince("s 1", 42);
    expect(page).toEqual(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/s%201/transcript?since=42");
  });

  it("the mock api serves an unknown session an empty page, and the repository exposes the same method", async () => {
    const api = createMockApi();
    expect(await api.getTranscriptSince("no-such-session", 0)).toEqual({ events: [], hasMore: false });
    expect(createChatRepository(api).getTranscriptSince).toBe(api.getTranscriptSince);
  });
});
