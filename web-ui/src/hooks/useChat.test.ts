import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { NormalizedEvent, SessionMeta, TranscriptAroundPage, TranscriptPage, WSEvent } from "@/api/types";
import { COLD_START_TIMEOUT_MESSAGE, COLD_START_TIMEOUT_MS, useChat } from "./useChat";
import * as chatSnapshotCache from "./chatSnapshotCache";
import { ev, makeApi } from "./useChat.testApi";

/** Build `count` live events with ascending ids/logSeqs; every `userEvery`-th
 *  is a `user` turn so trims have a stable turn boundary to cut at. */
function makeLiveEvents(count: number, startId = 1, userEvery = 3): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    const isUser = i % userEvery === 0;
    out.push(
      ev(`e${id}`, {
        kind: isUser ? "user" : "text",
        role: isUser ? "user" : "assistant",
        ...(isUser ? { turnId: `t${id}` } : {}),
        logSeq: id,
      }),
    );
  }
  return out;
}

// Prevent snapshot bleed between tests.
beforeEach(() => {
  chatSnapshotCache.clear();
});

describe("useChat (4.T1)", () => {
  it("merges chat:replay then live session:message into ordered events, and updates meta", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    expect(api.openChat).toHaveBeenCalledWith("s1", undefined);

    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e1", { kind: "user", role: "user", text: "hi", turnId: "t0" })],
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.events.map((e) => e.id)).toEqual(["e1"]);

    act(() => {
      api.emit({
        type: "session:message",
        sessionId: "s1",
        event: ev("e2", { kind: "text", role: "assistant", text: "hello" }),
      });
    });
    expect(result.current.events.map((e) => e.id)).toEqual(["e1", "e2"]);

    const meta: SessionMeta = {
      sessionId: "s1",
      channel: "json",
      cli: "claude",
      turnState: "responding",
      queueDepth: 0,
      queuedTurnIds: [],
      editingTurnIds: [],
    };
    act(() => {
      api.emit({ type: "session:meta", sessionId: "s1", meta });
    });
    expect(result.current.meta).toEqual(meta);
  });

  it("P1 — tracks the keyset cursor and prepends loadEarlier pages (delta-merge, union bookkeeping)", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    // Bounded tail replay: window top is logSeq 10, older rows exist.
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e10", { kind: "user", role: "user", text: "recent", turnId: "t10", logSeq: 10 })],
        oldestSeq: 10,
        hasMore: true,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);
    expect(result.current.events.map((e) => e.id)).toEqual(["e10"]);

    // loadEarlier fetches the page before the cursor and PREPENDS it (ordered by
    // logSeq), advancing the cursor. A user turn outside the tail is unioned in.
    api.getTranscriptPage.mockResolvedValueOnce({
      events: [ev("e5", { kind: "user", role: "user", text: "older", turnId: "t5", logSeq: 5 })],
      oldestSeq: 5,
      hasMore: false,
    });
    await act(async () => {
      await result.current.loadEarlier();
    });
    expect(api.getTranscriptPage).toHaveBeenCalledWith("s1", 10, undefined);
    expect(result.current.events.map((e) => e.id)).toEqual(["e5", "e10"]);
    expect(result.current.hasMore).toBe(false);

    // No-op once the top is reached (hasMore false).
    api.getTranscriptPage.mockClear();
    await act(async () => {
      await result.current.loadEarlier();
    });
    expect(api.getTranscriptPage).not.toHaveBeenCalled();
  });

  it("loadEarlier(limit) asks for a page of `limit` events; without it the client's default", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e300", { kind: "user", role: "user", text: "recent", turnId: "t300", logSeq: 300 })],
        oldestSeq: 300,
        hasMore: true,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    api.getTranscriptPage.mockResolvedValueOnce({
      events: [ev("e250", { kind: "user", role: "user", text: "older", turnId: "t250", logSeq: 250 })],
      oldestSeq: 250,
      hasMore: true,
    });
    await act(async () => {
      await result.current.loadEarlier(200);
    });
    expect(api.getTranscriptPage).toHaveBeenLastCalledWith("s1", 300, 200);
    expect(result.current.events.map((e) => e.id)).toEqual(["e250", "e300"]);

    api.getTranscriptPage.mockResolvedValueOnce({ events: [], oldestSeq: 250, hasMore: true });
    await act(async () => {
      await result.current.loadEarlier();
    });
    expect(api.getTranscriptPage).toHaveBeenLastCalledWith("s1", 250, undefined);
  });

  it("loadEarlierTo(seq) fetches one page down to `seq` and prepends its rows", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e500", { kind: "user", role: "user", text: "recent", turnId: "t500", logSeq: 500 })],
        oldestSeq: 500,
        hasMore: true,
        turnsBefore: 12,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.turnsBefore).toBe(12);

    // A find hit 100 rows above the window: one keyset page with limit = 500 - 400.
    api.getTranscriptPage.mockResolvedValueOnce({
      events: [ev("e400", { kind: "user", role: "user", text: "target", turnId: "t400", logSeq: 400 })],
      oldestSeq: 400,
      hasMore: true,
      turnsBefore: 10,
    });
    await act(async () => {
      await result.current.loadEarlierTo(400);
    });

    expect(api.getTranscriptPage).toHaveBeenCalledWith("s1", 500, 100);
    expect(result.current.events.map((e) => e.id)).toEqual(["e400", "e500"]);
    expect(result.current.turnsBefore).toBe(10);
    expect(result.current.hasMore).toBe(true);
  });

  it("a loadEarlier started while a viewAround fetch is pending does not merge into the new window", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e500", { kind: "user", role: "user", text: "r", turnId: "t500", logSeq: 500 })],
        oldestSeq: 500,
        hasMore: true,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let resolveAround!: (v: TranscriptAroundPage) => void;
    api.getTranscriptAround.mockReturnValueOnce(new Promise<TranscriptAroundPage>((r) => (resolveAround = r)));
    let around!: Promise<void>;
    act(() => {
      around = result.current.viewAround(50);
    });
    let resolvePage!: (v: TranscriptPage) => void;
    api.getTranscriptPage.mockReturnValueOnce(new Promise<TranscriptPage>((r) => (resolvePage = r)));
    let earlier!: Promise<void>;
    act(() => {
      earlier = result.current.loadEarlier();
    });
    await act(async () => {
      resolveAround({
        events: [ev("a50", { kind: "user", turnId: "t50", logSeq: 50 })],
        oldestSeq: 50,
        hasMore: false,
        turnsBefore: 0,
      });
      await around;
    });
    await act(async () => {
      resolvePage({ events: [ev("old", { kind: "user", turnId: "t1", logSeq: 1 })], oldestSeq: 1, hasMore: false });
      await earlier;
    });
    expect(result.current.events.map((e) => e.id)).toEqual(["a50"]);
  });

  it("a loadEarlier in flight from a detached window is dropped by a reconnect replay", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e500", { kind: "user", turnId: "t500", logSeq: 500 })],
        oldestSeq: 500,
        hasMore: true,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    api.getTranscriptAround.mockResolvedValueOnce({
      events: [ev("a50", { kind: "user", turnId: "t50", logSeq: 50 })],
      oldestSeq: 50,
      hasMore: true,
      turnsBefore: 3,
    });
    await act(async () => {
      await result.current.viewAround(50);
    });
    let resolvePage!: (v: TranscriptPage) => void;
    api.getTranscriptPage.mockReturnValueOnce(new Promise<TranscriptPage>((r) => (resolvePage = r)));
    let earlier!: Promise<void>;
    act(() => {
      earlier = result.current.loadEarlier();
    });
    await act(async () => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("fresh", { kind: "user", turnId: "tf", logSeq: 600 })],
        oldestSeq: 600,
        hasMore: true,
      });
    });
    await act(async () => {
      resolvePage({ events: [ev("old", { kind: "user", turnId: "t1", logSeq: 1 })], oldestSeq: 1, hasMore: false });
      await earlier;
    });
    expect(result.current.events.map((e) => e.id)).toEqual(["fresh"]);
  });

  it("a loadEarlier in flight from a detached window is dropped by a delta reconnect replay", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e500", { kind: "user", turnId: "t500", logSeq: 500 })],
        oldestSeq: 500,
        hasMore: true,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    api.getTranscriptAround.mockResolvedValueOnce({
      events: [ev("a50", { kind: "user", turnId: "t50", logSeq: 50 })],
      oldestSeq: 50,
      hasMore: true,
      turnsBefore: 3,
    });
    await act(async () => {
      await result.current.viewAround(50);
    });
    let resolvePage!: (v: TranscriptPage) => void;
    api.getTranscriptPage.mockReturnValueOnce(new Promise<TranscriptPage>((r) => (resolvePage = r)));
    let earlier!: Promise<void>;
    act(() => {
      earlier = result.current.loadEarlier();
    });
    await act(async () => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("fresh", { kind: "user", turnId: "tf", logSeq: 600 })],
      });
    });
    await act(async () => {
      resolvePage({ events: [ev("old", { kind: "user", turnId: "t1", logSeq: 1 })], oldestSeq: 1, hasMore: false });
      await earlier;
    });
    expect(result.current.events.map((e) => e.id)).toEqual(["e500", "fresh"]);
    // The stale page must not overwrite the restored tail's paging state either.
    expect(result.current.hasMore).toBe(true);
  });

  it("a loadEarlier superseded by loadEarlierTo leaves the spinner to loadEarlierTo", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e500", { kind: "user", turnId: "t500", logSeq: 500 })],
        oldestSeq: 500,
        hasMore: true,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let resolveFirst!: (v: TranscriptPage) => void;
    let resolveSecond!: (v: TranscriptPage) => void;
    api.getTranscriptPage
      .mockReturnValueOnce(new Promise<TranscriptPage>((r) => (resolveFirst = r)))
      .mockReturnValueOnce(new Promise<TranscriptPage>((r) => (resolveSecond = r)));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.loadEarlier();
      second = result.current.loadEarlierTo(400);
    });
    await act(async () => {
      resolveFirst({ events: [], oldestSeq: 500, hasMore: true });
      await first;
    });
    expect(result.current.loadingEarlier).toBe(true);
    await act(async () => {
      resolveSecond({ events: [ev("e400", { kind: "user", turnId: "t400", logSeq: 400 })], oldestSeq: 400, hasMore: true });
      await second;
    });
    expect(result.current.loadingEarlier).toBe(false);
  });

  it("P1 — a sinceSeq delta replay merges (appends) without resetting the window cursor", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e10", { kind: "text", role: "assistant", text: "a", logSeq: 10 })],
        oldestSeq: 10,
        hasMore: true,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Reconnect delta: no cursor fields → must NOT clear hasMore / oldestSeq.
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e11", { kind: "text", role: "assistant", text: "b", logSeq: 11 })],
      });
    });
    expect(result.current.events.map((e) => e.id)).toEqual(["e10", "e11"]);
    expect(result.current.hasMore).toBe(true);
  });

  it("ignores events for other sessions", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({ type: "session:message", sessionId: "other", event: ev("x", {}) });
    });
    expect(result.current.events).toHaveLength(0);
  });
});

describe("useChat optimistic dedupe (4.T6)", () => {
  it("dedupes the optimistic user bubble against the daemon's user event by turnId", async () => {
    const api = makeApi({ turnId: "turn-42", queuePosition: 0 });
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    await act(async () => {
      await result.current.send("do it", []);
    });
    // Optimistic bubble present, keyed by the returned turnId.
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.pending[0]!.turnId).toBe("turn-42");

    // Authoritative user event with the SAME turnId → pending is dropped, events
    // holds exactly one user bubble (no double).
    act(() => {
      api.emit({
        type: "session:message",
        sessionId: "s1",
        event: ev("u1", { kind: "user", role: "user", text: "do it", turnId: "turn-42" }),
      });
    });
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.events.filter((e) => e.kind === "user")).toHaveLength(1);
  });

  it("does not add an optimistic bubble when the user event already arrived", async () => {
    const api = makeApi({ turnId: "turn-99", queuePosition: 0 });
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    // Authoritative event arrives BEFORE send resolves (daemon echoes fast).
    api.sendChat.mockImplementationOnce(async () => {
      api.emit({
        type: "session:message",
        sessionId: "s1",
        event: ev("u9", { kind: "user", role: "user", text: "x", turnId: "turn-99" }),
      });
      return { turnId: "turn-99", queuePosition: 0 };
    });
    await act(async () => {
      await result.current.send("x", []);
    });
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.events.filter((e) => e.kind === "user")).toHaveLength(1);
  });

  it("returns delivery from send", async () => {
    const api = makeApi({ turnId: "turn-s", queuePosition: 0 });
    api.sendChat.mockResolvedValueOnce({ turnId: "turn-s", queuePosition: 0, delivery: "steered" as const });
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    let delivery: "queued" | "steered" | undefined;
    await act(async () => {
      delivery = await result.current.send("steer this", []);
    });
    expect(delivery).toBe("steered");
  });

  it("closes the chat on unmount", () => {
    const api = makeApi();
    const { unmount } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    unmount();
    expect(api.closeChat).toHaveBeenCalledWith("s1");
  });
});

describe("useChat queue controls (2.T2/2.T4)", () => {
  it("editQueued populates a local editing draft; saveEdit resubmits + clears it", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    await act(async () => {
      await result.current.editQueued("t1");
    });
    expect(api.beginEditQueuedTurn).toHaveBeenCalledWith("s1", "t1");
    expect(result.current.editingDrafts.t1).toEqual({ message: "prefill", attachments: [] });

    await act(async () => {
      await result.current.saveEdit("t1", "new text", ["a1"]);
    });
    expect(api.resubmitQueuedTurn).toHaveBeenCalledWith("s1", "t1", {
      edited: true,
      message: "new text",
      attachmentIds: ["a1"],
    });
    expect(result.current.editingDrafts.t1).toBeUndefined();
  });

  it("discardEdit resubmits {edited:false} and clears the draft", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    await act(async () => {
      await result.current.editQueued("t1");
    });
    await act(async () => {
      await result.current.discardEdit("t1");
    });
    expect(api.resubmitQueuedTurn).toHaveBeenCalledWith("s1", "t1", { edited: false });
    expect(result.current.editingDrafts.t1).toBeUndefined();
  });

  it("sendNow promotes; saveEdit clears the draft even when resubmit rejects (A9)", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    await act(async () => {
      await result.current.sendNow("t1");
    });
    expect(api.promoteQueuedTurn).toHaveBeenCalledWith("s1", "t1");

    api.resubmitQueuedTurn.mockRejectedValueOnce(new Error("not_editing"));
    await act(async () => {
      await result.current.editQueued("t2");
    });
    await act(async () => {
      await expect(result.current.saveEdit("t2", "x", [])).rejects.toThrow();
    });
    // Draft cleared regardless so the editor closes and the caller can salvage.
    expect(result.current.editingDrafts.t2).toBeUndefined();
  });

  it("derives queued/editing turnIds from meta", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    const meta: SessionMeta = {
      sessionId: "s1",
      channel: "json",
      cli: "claude",
      turnState: "queued",
      queueDepth: 2,
      queuedTurnIds: ["t1", "t2"],
      editingTurnIds: ["t3"],
    };
    act(() => {
      api.emit({ type: "session:meta", sessionId: "s1", meta });
    });
    expect(result.current.queuedTurnIds).toEqual(["t1", "t2"]);
    expect(result.current.editingTurnIds).toEqual(["t3"]);
  });
});

describe("useChat reconnect gap (4.T3/4.T4)", () => {
  it("(4.T3) reconnect gap — ws:open re-arms latest seq; overflow tail drops stale cache", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    // Events up to logSeq 10 are already loaded (plain tail replay).
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [
          ev("e9", { kind: "user", role: "user", text: "a", turnId: "t9", logSeq: 9 }),
          ev("e10", { kind: "text", role: "assistant", text: "b", logSeq: 10 }),
        ],
        oldestSeq: 9,
        hasMore: false,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Reconnect: ws:open re-arms restoredLatestSeqRef from the current max seq.
    act(() => {
      api.emit({ type: "ws:open" } as WSEvent);
    });

    // Overflow delta answered with a tail frame: oldestSeq=50 > latest=10 → gap.
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e50", { kind: "text", role: "assistant", text: "fresh", logSeq: 50 })],
        oldestSeq: 50,
        hasMore: true,
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Stale events dropped; only the fresh tail remains.
    expect(result.current.events.map((e) => e.id)).toEqual(["e50"]);
    expect(result.current.hasMore).toBe(true);
  });

  it("(4.T4) reconnect no gap — tail with oldestSeq <= latest merges without dropping", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e10", { kind: "text", role: "assistant", text: "old", logSeq: 10 })],
        oldestSeq: 10,
        hasMore: false,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Reconnect re-arms latest seq (10).
    act(() => {
      api.emit({ type: "ws:open" } as WSEvent);
    });

    // Tail frame with oldestSeq=5 (<= latest) → no gap → merge, nothing dropped.
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [
          ev("e5", { kind: "user", role: "user", text: "q", turnId: "t5", logSeq: 5 }),
          ev("e11", { kind: "text", role: "assistant", text: "a", logSeq: 11 }),
        ],
        oldestSeq: 5,
        hasMore: true,
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const ids = result.current.events.map((e) => e.id);
    expect(ids).toContain("e5");
    expect(ids).toContain("e10");
    expect(ids).toContain("e11");
    expect(ids).toHaveLength(3);
  });

  it("(4.T4) plain delta replay (hasMore undefined) after ws:open still merges", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e10", { kind: "text", role: "assistant", text: "old", logSeq: 10 })],
        oldestSeq: 10,
        hasMore: false,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      api.emit({ type: "ws:open" } as WSEvent);
    });

    // Fitting delta (no cursor fields) merges on top of existing events.
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e11", { kind: "text", role: "assistant", text: "b", logSeq: 11 })],
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.events.map((e) => e.id)).toEqual(["e10", "e11"]);
  });
});

describe("useChat live-event cap (4.T1)", () => {
  const MAX = 5000;
  const TRIM_TO = 4000;

  /** Mount a fresh hook and seed an empty bounded tail (hasMore false, cursor 0)
   *  so live messages accumulate from a clean baseline. */
  function mountHook() {
    const api = makeApi();
    const hook = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({ type: "chat:replay", sessionId: "s1", events: [], oldestSeq: 0, hasMore: false });
    });
    return { api, hook };
  }

  it("trims live events once the window exceeds MAX_LIVE_EVENTS, and enables hasMore", async () => {
    const { api, hook } = mountHook();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    act(() => {
      for (const e of makeLiveEvents(5100)) {
        api.emit({ type: "session:message", sessionId: "s1", event: e });
      }
    });

    const events = hook.result.current.events;
    // Trimmed back toward TRIM_TO, never above MAX.
    expect(events.length).toBeLessThanOrEqual(MAX);
    expect(events.length).toBeGreaterThan(TRIM_TO);
    // Trimmed-out history is recoverable via loadEarlier.
    expect(hook.result.current.hasMore).toBe(true);
  });

  it("never splits a turn — the first surviving event after a trim is a `user` event", async () => {
    const { api, hook } = mountHook();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    act(() => {
      for (const e of makeLiveEvents(5100)) {
        api.emit({ type: "session:message", sessionId: "s1", event: e });
      }
    });

    const events = hook.result.current.events;
    expect(events.length).toBeLessThan(5100);
    expect(events[0]!.kind).toBe("user");
  });

  it("skips trimming after loadAll (full history held in memory)", async () => {
    const { api, hook } = mountHook();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    api.getTranscriptAll.mockResolvedValueOnce({ events: makeLiveEvents(6000) });
    await act(async () => {
      await hook.result.current.loadAll();
    });
    expect(hook.result.current.events.length).toBe(6000);

    // Even more live messages on top → still no trim.
    act(() => {
      for (const e of makeLiveEvents(200, 10_000)) {
        api.emit({ type: "session:message", sessionId: "s1", event: e });
      }
    });
    expect(hook.result.current.events.length).toBe(6200);
  });

  it("skips trimming when scrolled up (setCanTrim(false))", async () => {
    const { api, hook } = mountHook();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    act(() => {
      hook.result.current.setCanTrim(false);
    });
    act(() => {
      for (const e of makeLiveEvents(5100)) {
        api.emit({ type: "session:message", sessionId: "s1", event: e });
      }
    });

    // No trim happened — all events retained.
    expect(hook.result.current.events.length).toBe(5100);
  });
});

describe("useChat stop turn scoping", () => {
  it("stop() calls stopChat with activeTurnId from meta and sets stopPending", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    act(() => {
      api.emit({
        type: "session:meta",
        sessionId: "s1",
        meta: {
          sessionId: "s1",
          channel: "json",
          cli: "claude",
          turnState: "thinking",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
          activeTurnId: "turn-xyz",
        },
      });
    });

    expect(result.current.stopPending).toBe(false);

    await act(async () => {
      await result.current.stop();
    });

    expect(api.stopChat).toHaveBeenCalledWith("s1", "turn-xyz");
    expect(result.current.stopPending).toBe(true);

    // Stop stays disabled until activeTurnId changes or clears
    act(() => {
      api.emit({
        type: "session:meta",
        sessionId: "s1",
        meta: {
          sessionId: "s1",
          channel: "json",
          cli: "claude",
          turnState: "thinking",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
          activeTurnId: "turn-xyz",
        },
      });
    });
    expect(result.current.stopPending).toBe(true);

    // Active turn changes to next turn
    act(() => {
      api.emit({
        type: "session:meta",
        sessionId: "s1",
        meta: {
          sessionId: "s1",
          channel: "json",
          cli: "claude",
          turnState: "thinking",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
          activeTurnId: "turn-next",
        },
      });
    });
    expect(result.current.stopPending).toBe(false);
  });

  it("stopPending clears when activeTurnId becomes undefined or empty", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    act(() => {
      api.emit({
        type: "session:meta",
        sessionId: "s1",
        meta: {
          sessionId: "s1",
          channel: "json",
          cli: "claude",
          turnState: "thinking",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
          activeTurnId: "turn-abc",
        },
      });
    });

    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.stopPending).toBe(true);

    // Session goes idle (activeTurnId undefined)
    act(() => {
      api.emit({
        type: "session:meta",
        sessionId: "s1",
        meta: {
          sessionId: "s1",
          channel: "json",
          cli: "claude",
          turnState: "idle",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
        },
      });
    });
    expect(result.current.stopPending).toBe(false);
  });

  it("stopPending clears when stopChat request rejects", async () => {
    const api = makeApi();
    api.stopChat = vi.fn(async () => {
      throw new Error("Network error");
    });
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    act(() => {
      api.emit({
        type: "session:meta",
        sessionId: "s1",
        meta: {
          sessionId: "s1",
          channel: "json",
          cli: "claude",
          turnState: "thinking",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
          activeTurnId: "turn-fail",
        },
      });
    });

    await expect(
      act(async () => {
        await result.current.stop();
      }),
    ).rejects.toThrow("Network error");

    expect(result.current.stopPending).toBe(false);
  });

  it("stopPending stays active during unscoped stop until turnState is no longer busy", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    act(() => {
      api.emit({
        type: "session:meta",
        sessionId: "s1",
        meta: {
          sessionId: "s1",
          channel: "json",
          cli: "claude",
          turnState: "thinking",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
          // no activeTurnId
        },
      });
    });

    await act(async () => {
      await result.current.stop();
    });

    expect(api.stopChat).toHaveBeenCalledWith("s1", undefined);
    expect(result.current.stopPending).toBe(true);

    // Still busy -> stays pending
    act(() => {
      api.emit({
        type: "session:meta",
        sessionId: "s1",
        meta: {
          sessionId: "s1",
          channel: "json",
          cli: "claude",
          turnState: "responding",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
        },
      });
    });
    expect(result.current.stopPending).toBe(true);

    // Turn finishes -> idle -> clears pending
    act(() => {
      api.emit({
        type: "session:meta",
        sessionId: "s1",
        meta: {
          sessionId: "s1",
          channel: "json",
          cli: "claude",
          turnState: "idle",
          queueDepth: 0,
          queuedTurnIds: [],
          editingTurnIds: [],
        },
      });
    });
    expect(result.current.stopPending).toBe(false);
  });
});

describe("useChat scheduledFailed meta preservation", () => {
  const base: SessionMeta = {
    sessionId: "s1",
    channel: "json",
    cli: "claude",
    turnState: "idle",
    queueDepth: 0,
    queuedTurnIds: [],
    editingTurnIds: [],
  };
  const failed = [{ id: "f1", message: "hi", fireAt: "2026-01-01T00:00:00Z", failureReason: "Session was archived" }];

  it("keeps the previous scheduledFailed when a live meta event omits it", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({ type: "session:meta", sessionId: "s1", meta: { ...base, scheduledFailed: failed } });
    });
    expect(result.current.meta?.scheduledFailed).toEqual(failed);
    act(() => {
      api.emit({ type: "session:meta", sessionId: "s1", meta: { ...base, turnState: "thinking" } });
    });
    expect(result.current.meta?.turnState).toBe("thinking");
    expect(result.current.meta?.scheduledFailed).toEqual(failed);
  });

  it("clears scheduledFailed on an explicit empty array", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({ type: "session:meta", sessionId: "s1", meta: { ...base, scheduledFailed: failed } });
    });
    act(() => {
      api.emit({ type: "session:meta", sessionId: "s1", meta: { ...base, scheduledFailed: [] } });
    });
    expect(result.current.meta?.scheduledFailed).toEqual([]);
  });
});

describe("useChat session:scheduled (slim scheduled-state event)", () => {
  const base: SessionMeta = {
    sessionId: "s1",
    channel: "json",
    cli: "claude",
    turnState: "idle",
    queueDepth: 0,
    queuedTurnIds: [],
    editingTurnIds: [],
  };
  const pending = [{ id: "p1", message: "later", fireAt: "2030-01-01T00:00:00Z" }];

  it("patches ONLY the scheduled fields — live turn state is never overwritten", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({ type: "session:meta", sessionId: "s1", meta: { ...base, turnState: "thinking", queueDepth: 2 } });
    });
    act(() => {
      api.emit({
        type: "session:scheduled",
        sessionId: "s1",
        scheduledSends: pending,
        scheduledFailed: [],
        scheduledTurnIds: ["t9"],
      });
    });
    expect(result.current.meta?.scheduledSends).toEqual(pending);
    expect(result.current.meta?.scheduledTurnIds).toEqual(["t9"]);
    expect(result.current.meta?.turnState).toBe("thinking");
    expect(result.current.meta?.queueDepth).toBe(2);
  });

  it("an empty list clears the tray, and other sessions' events are ignored", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({ type: "session:meta", sessionId: "s1", meta: { ...base, scheduledSends: pending } });
    });
    act(() => {
      api.emit({ type: "session:scheduled", sessionId: "other", scheduledSends: [], scheduledFailed: [], scheduledTurnIds: [] });
    });
    expect(result.current.meta?.scheduledSends).toEqual(pending);
    act(() => {
      api.emit({ type: "session:scheduled", sessionId: "s1", scheduledSends: [], scheduledFailed: [], scheduledTurnIds: [] });
    });
    expect(result.current.meta?.scheduledSends).toEqual([]);
  });
});

describe("useChat mentions (1.T8)", () => {
  it('send("see {@file [\\"a.ts\\",\\"a.ts\\"]}") calls sendChat with text see @a.ts and a 1-item mentions 5th arg', async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    await act(async () => {
      await result.current.send('see {@file ["a.ts","a.ts"]}');
    });

    expect(api.sendChat).toHaveBeenCalledWith(
      "s1",
      "see @a.ts",
      undefined,
      undefined,
      [{ kind: "file", id: "a.ts", label: "a.ts" }],
    );
  });

  it("send without mentions calls sendChat with exactly 4 args (regression)", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    await act(async () => {
      await result.current.send("hello world");
    });

    expect(api.sendChat).toHaveBeenCalledWith("s1", "hello world", undefined, undefined);
    expect(api.sendChat.mock.calls[0]?.length).toBe(4);
  });

  it("saveEdit puts mentions in the resubmit body", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    await act(async () => {
      await result.current.saveEdit("t1", 'fix {@agent ["s2","Fix login"]}', ["a1"]);
    });

    expect(api.resubmitQueuedTurn).toHaveBeenCalledWith("s1", "t1", {
      edited: true,
      message: 'fix @agent:"Fix login" (id=s2)',
      attachmentIds: ["a1"],
      mentions: [{ kind: "agent", id: "s2", label: "Fix login" }],
    });
  });

  it("begin-edit hydrates editingDrafts using fromWire", async () => {
    const api = makeApi();
    api.beginEditQueuedTurn.mockResolvedValueOnce({
      turnId: "t1",
      message: 'check @agent:"Fix login" (id=s2)',
      attachments: [],
      mentions: [{ kind: "agent", id: "s2", label: "Fix login" }],
      queueIndex: 0,
    });
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    await act(async () => {
      await result.current.editQueued("t1");
    });

    expect(result.current.editingDrafts.t1).toEqual({
      message: 'check {@agent ["s2","Fix login"]}',
      attachments: [],
    });
  });
});

describe("useChat review comments (6.4 / 6.5)", () => {
  it("send with review ids always queues, passes them last, and records the summary on the optimistic turn", async () => {
    const api = makeApi({ turnId: "t9", queuePosition: 1 });
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    await act(async () => {
      await result.current.send("see these", [], undefined, { ids: ["c1", "c2"], summary: { count: 2, files: 1 } });
    });
    expect(api.sendChat).toHaveBeenCalledWith("s1", "see these", [], true, undefined, ["c1", "c2"]);
    expect(result.current.pending[0]).toMatchObject({ turnId: "t9", queued: true, review: { count: 2, files: 1 } });
  });

  it("an empty message with review ids is sent as such", async () => {
    const api = makeApi({ turnId: "t9", queuePosition: 1 });
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    await act(async () => {
      await result.current.send("", [], undefined, { ids: ["c1"], summary: { count: 1, files: 1 } });
    });
    expect(api.sendChat).toHaveBeenCalledWith("s1", "", [], true, undefined, ["c1"]);
  });

  it("a plain send keeps its old call shape (no review argument)", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    await act(async () => {
      await result.current.send("hi", []);
    });
    expect(api.sendChat).toHaveBeenCalledWith("s1", "hi", [], undefined);
  });

  it("editQueued keeps the held turn's review summary and saveEdit(.., false) tells the daemon to restore it", async () => {
    const api = makeApi();
    api.beginEditQueuedTurn.mockResolvedValueOnce({ turnId: "t1", message: "m", attachments: [], queueIndex: 0, review: { count: 3, files: 2 } });
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    await act(async () => {
      await result.current.editQueued("t1");
    });
    expect(result.current.editingDrafts.t1).toEqual({ message: "m", attachments: [], review: { count: 3, files: 2 } });
    await act(async () => {
      await result.current.saveEdit("t1", "m2", [], false);
    });
    expect(api.resubmitQueuedTurn).toHaveBeenCalledWith("s1", "t1", { edited: true, message: "m2", attachmentIds: [], keepReview: false });
  });

  it("saveEdit without the flag omits keepReview (the daemon keeps the comments)", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    await act(async () => {
      await result.current.saveEdit("t1", "m2", []);
    });
    expect((api.resubmitQueuedTurn.mock.calls.at(-1) as unknown as unknown[])[2]).not.toHaveProperty("keepReview");
  });

  describe("turnsBefore, countUserTurns, and detached mode", () => {
    it("turnsBefore reflects replay, updates on loadEarlier/loadAll, and live trim increments it", async () => {
      const api = makeApi();
      const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

      // 1. Initial replay with turnsBefore = 5
      await act(async () => {
        api.emit({
          type: "chat:replay",
          sessionId: "s1",
          events: [
            ev("u1", { kind: "user", turnId: "t1", logSeq: 10 }),
            ev("a1", { kind: "text", turnId: "t1", logSeq: 11 }),
          ],
          hasMore: true,
          oldestSeq: 10,
          turnsBefore: 5,
        });
      });
      expect(result.current.turnsBefore).toBe(5);

      // 2. loadEarlier updates turnsBefore
      api.getTranscriptPage.mockResolvedValueOnce({
        events: [
          ev("u0", { kind: "user", turnId: "t0" }),
          ev("a0", { kind: "text", turnId: "t0" }),
        ],
        hasMore: true,
        turnsBefore: 4,
      });

      await act(async () => {
        await result.current.loadEarlier();
      });
      expect(result.current.turnsBefore).toBe(4);

      // 3. loadAll resets turnsBefore to 0
      api.getTranscriptAll.mockResolvedValueOnce({
        events: [
          ev("uOld", { kind: "user", turnId: "tOld" }),
          ev("u0", { kind: "user", turnId: "t0" }),
          ev("u1", { kind: "user", turnId: "t1" }),
        ],
      });

      await act(async () => {
        await result.current.loadAll();
      });
      expect(result.current.turnsBefore).toBe(0);
    });

    it("viewAround detaches window, stashes incoming messages, returnToLatest restores live tail", async () => {
      const api = makeApi();
      const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

      // Initial live events
      await act(async () => {
        api.emit({
          type: "chat:replay",
          sessionId: "s1",
          events: [
            ev("u1", { kind: "user", turnId: "t1" }),
            ev("a1", { kind: "text", turnId: "t1" }),
          ],
          hasMore: false,
          turnsBefore: 0,
        });
      });
      expect(result.current.detached).toBe(false);
      expect(result.current.events).toHaveLength(2);

      // viewAround
      api.getTranscriptAround.mockResolvedValueOnce({
        events: [
          ev("uOld", { kind: "user", turnId: "tOld", logSeq: 42 }),
          ev("aOld", { kind: "text", turnId: "tOld", logSeq: 43 }),
        ],
        hasMore: true,
        turnsBefore: 20,
      });

      await act(async () => {
        await result.current.viewAround(42);
      });

      expect(result.current.detached).toBe(true);
      expect(result.current.events).toHaveLength(2);
      expect(result.current.events[0]!.id).toBe("uOld");

      // While detached, incoming live message does NOT appear in displayed events
      await act(async () => {
        api.emit({
          type: "session:message",
          sessionId: "s1",
          event: ev("uLive", { kind: "user", turnId: "tLive" }),
        });
      });
      expect(result.current.events).toHaveLength(2); // still detached window!

      // returnToLatest restores the live tail with the newly arrived message
      act(() => {
        result.current.returnToLatest();
      });

      expect(result.current.detached).toBe(false);
      expect(result.current.events.map((e) => e.id)).toEqual(["u1", "a1", "uLive"]);
    });

    it("chat:replay clears detached mode, failed viewAround leaves state untouched", async () => {
      const api = makeApi();
      const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

      // Failed viewAround rejects
      api.getTranscriptAround.mockRejectedValueOnce(new Error("Network fail"));
      await act(async () => {
        await expect(result.current.viewAround(100)).rejects.toThrow("Network fail");
      });
      expect(result.current.detached).toBe(false);

      // Now attach viewAround
      api.getTranscriptAround.mockResolvedValueOnce({
        events: [ev("uPast", { kind: "user" })],
        hasMore: false,
        turnsBefore: 0,
      });
      await act(async () => {
        await result.current.viewAround(50);
      });
      expect(result.current.detached).toBe(true);

      // chat:replay clears detached
      await act(async () => {
        api.emit({
          type: "chat:replay",
          sessionId: "s1",
          events: [ev("uFresh", { kind: "user" })],
          hasMore: false,
        });
      });
      expect(result.current.detached).toBe(false);
      expect(result.current.events[0]!.id).toBe("uFresh");
    });

    it("a since-delta replay while detached merges onto the stashed live tail, not the around window", async () => {
      const api = makeApi();
      const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

      // Live tail (older rows exist, 3 turns before it).
      await act(async () => {
        api.emit({
          type: "chat:replay",
          sessionId: "s1",
          events: [
            ev("u1", { kind: "user", turnId: "t1", logSeq: 10 }),
            ev("a1", { kind: "text", turnId: "t1", logSeq: 11 }),
          ],
          oldestSeq: 10,
          hasMore: true,
          turnsBefore: 3,
        });
      });
      expect(result.current.hasMore).toBe(true);
      expect(result.current.turnsBefore).toBe(3);

      // Detach into an around window.
      api.getTranscriptAround.mockResolvedValueOnce({
        events: [
          ev("uOld", { kind: "user", turnId: "tOld", logSeq: 42 }),
          ev("aOld", { kind: "text", turnId: "tOld", logSeq: 43 }),
        ],
        oldestSeq: 42,
        hasMore: true,
        turnsBefore: 20,
      });
      await act(async () => {
        await result.current.viewAround(42);
      });
      expect(result.current.detached).toBe(true);
      expect(result.current.events.map((e) => e.id)).toEqual(["uOld", "aOld"]);

      // Reconnect delta (no cursor fields) while detached: must return to the
      // live tail + delta, never merge the delta onto the around window (hole).
      await act(async () => {
        api.emit({
          type: "chat:replay",
          sessionId: "s1",
          events: [ev("uNew", { kind: "user", turnId: "tNew", logSeq: 12 })],
        });
      });
      expect(result.current.detached).toBe(false);
      expect(result.current.events.map((e) => e.id)).toEqual(["u1", "a1", "uNew"]);
      expect(result.current.hasMore).toBe(true);
      expect(result.current.turnsBefore).toBe(3);
    });
  });
});

describe("useChat window loads are latest-wins", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function aroundPage(id: string, seq: number): TranscriptAroundPage {
    return {
      events: [ev(id, { kind: "user", role: "user", text: id, turnId: `t-${id}`, logSeq: seq })],
      hasMore: true,
      turnsBefore: seq,
    };
  }

  async function mountWithTail(api: ReturnType<typeof makeApi>, sessionId = "s1") {
    const hook = renderHook(({ sid }) => useChat(api as unknown as ApiInstance, sid, true), {
      initialProps: { sid: sessionId },
    });
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId,
        events: [ev("tail", { kind: "user", role: "user", text: "tail", turnId: "t-tail", logSeq: 1000 })],
        oldestSeq: 1000,
        hasMore: true,
        turnsBefore: 50,
      });
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
  }

  it("a quick second viewAround wins over a slower first one", async () => {
    const api = makeApi();
    const hook = await mountWithTail(api);
    const first = deferred<TranscriptAroundPage>();
    const second = deferred<TranscriptAroundPage>();
    api.getTranscriptAround.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = hook.result.current.viewAround(100);
      p2 = hook.result.current.viewAround(200);
    });
    await act(async () => {
      second.resolve(aroundPage("b", 200));
      await p2;
    });
    expect(hook.result.current.events.map((e) => e.id)).toEqual(["b"]);

    await act(async () => {
      first.resolve(aroundPage("a", 100));
      await p1;
    });
    expect(hook.result.current.events.map((e) => e.id)).toEqual(["b"]);
    expect(hook.result.current.turnsBefore).toBe(200);

    // Returning to the latest restores the live tail stashed by the first swap.
    act(() => hook.result.current.returnToLatest());
    expect(hook.result.current.events.map((e) => e.id)).toEqual(["tail"]);
  });

  it("a viewAround that resolves after a session switch commits nothing", async () => {
    const api = makeApi();
    const hook = await mountWithTail(api);
    const pending = deferred<TranscriptAroundPage>();
    api.getTranscriptAround.mockReturnValueOnce(pending.promise);

    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.viewAround(100);
    });
    hook.rerender({ sid: "s2" });
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s2",
        events: [ev("s2-tail", { kind: "user", role: "user", text: "other", turnId: "t-s2", logSeq: 7 })],
        oldestSeq: 7,
        hasMore: false,
      });
    });
    await act(async () => {
      pending.resolve(aroundPage("stale", 100));
      await p;
    });

    expect(hook.result.current.events.map((e) => e.id)).toEqual(["s2-tail"]);
    expect(hook.result.current.detached).toBe(false);
  });

  it("a loadEarlierTo superseded by a viewAround does not prepend into the new window", async () => {
    const api = makeApi();
    const hook = await mountWithTail(api);
    const page = deferred<TranscriptPage>();
    api.getTranscriptPage.mockReturnValueOnce(page.promise);
    api.getTranscriptAround.mockResolvedValueOnce(aroundPage("far", 5));

    let early!: Promise<void>;
    act(() => {
      early = hook.result.current.loadEarlierTo(900);
    });
    expect(hook.result.current.loadingEarlier).toBe(true);
    await act(async () => {
      await hook.result.current.viewAround(5);
    });
    await act(async () => {
      page.resolve({ events: [ev("e900", { kind: "user", role: "user", text: "x", turnId: "t900", logSeq: 900 })], oldestSeq: 900, hasMore: true });
      await early;
    });

    expect(hook.result.current.events.map((e) => e.id)).toEqual(["far"]);
    expect(hook.result.current.loadingEarlier).toBe(false);
  });
});

describe("useChat live trim under StrictMode", () => {
  it("counts the trimmed turns once even though StrictMode runs the events updater twice", async () => {
    const api = makeApi();
    const hook = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true), { wrapper: StrictMode });
    act(() => {
      api.emit({ type: "chat:replay", sessionId: "s1", events: [], oldestSeq: 0, hasMore: false, turnsBefore: 5 });
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    // The 5,001st event trims 1,002 rows (cut at the first user row at or after
    // index 1,001), which hold 334 user turns; the remaining 99 never re-trim.
    act(() => {
      for (const e of makeLiveEvents(5100)) {
        api.emit({ type: "session:message", sessionId: "s1", event: e });
      }
    });

    expect(hook.result.current.events.length).toBe(5100 - 1002);
    expect(hook.result.current.turnsBefore).toBe(5 + 334);
  });
});

describe("useChat cold-start bound (registry-poison fix)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const replay = (events: NormalizedEvent[] = []): WSEvent => ({
    type: "chat:replay",
    sessionId: "s1",
    events,
    hasMore: false,
  });

  it("3.T1 — no reply within the bound: spinner becomes an error", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    expect(result.current.loading).toBe(true);
    act(() => {
      vi.advanceTimersByTime(COLD_START_TIMEOUT_MS - 1);
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.loadError).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBe(COLD_START_TIMEOUT_MESSAGE);
  });

  it("3.T2 — retry() forces a fresh chat:open and restarts the bound", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      vi.advanceTimersByTime(COLD_START_TIMEOUT_MS);
    });
    expect(result.current.loadError).not.toBeNull();
    act(() => {
      result.current.retry();
    });
    // Forced re-send (refcount-proof), not a close + open pair.
    expect(api.reopenChat).toHaveBeenCalledWith("s1");
    expect(api.closeChat).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
    expect(result.current.loadError).toBeNull();
    act(() => {
      api.emit(replay([ev("e1", { kind: "user", role: "user", turnId: "t1", logSeq: 1 })]));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBeNull();
    expect(result.current.events.map((e) => e.id)).toEqual(["e1"]);
    // The old timer was cleared: nothing flips back to an error later.
    act(() => {
      vi.advanceTimersByTime(COLD_START_TIMEOUT_MS * 2);
    });
    expect(result.current.loadError).toBeNull();
  });

  it("3.T3 — session:error before the first replay is surfaced; after a load it is not", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({ type: "session:error", sessionId: "s1", message: "Couldn't open this chat's history: disk I/O error", reason: "transient" });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBe("Couldn't open this chat's history: disk I/O error");

    // A second mount that loads fine ignores a later (transient) session:error.
    const api2 = makeApi();
    const { result: r2 } = renderHook(() => useChat(api2 as unknown as ApiInstance, "s1", true, { cache: false }));
    act(() => {
      api2.emit(replay());
    });
    act(() => {
      api2.emit({ type: "session:error", sessionId: "s1", message: "tty hiccup", reason: "transient" });
    });
    expect(r2.current.loadError).toBeNull();
  });

  it("3.T4 — a late replay after the timeout clears the error", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      vi.advanceTimersByTime(COLD_START_TIMEOUT_MS);
    });
    expect(result.current.loadError).not.toBeNull();
    act(() => {
      api.emit(replay([ev("e1", { kind: "text", logSeq: 1 })]));
    });
    expect(result.current.loadError).toBeNull();
    expect(result.current.events).toHaveLength(1);
  });

  it("3.T5 — a WS reconnect restarts the bound (offline time is not 'no reply')", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      vi.advanceTimersByTime(COLD_START_TIMEOUT_MS - 1000);
    });
    act(() => {
      api.emit({ type: "ws:open" } as unknown as WSEvent);
    });
    act(() => {
      vi.advanceTimersByTime(COLD_START_TIMEOUT_MS - 1);
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.loadError).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.loadError).toBe(COLD_START_TIMEOUT_MESSAGE);
  });

  it("error -> Retry -> error again surfaces the second error; error -> reconnect shows the spinner again", () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    const err = (message: string): WSEvent => ({ type: "session:error", sessionId: "s1", message, reason: "transient" });
    act(() => {
      api.emit(err("first"));
    });
    expect(result.current.loadError).toBe("first");
    act(() => {
      result.current.retry();
    });
    expect(result.current.loading).toBe(true);
    act(() => {
      api.emit(err("second"));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBe("second");
    act(() => {
      api.emit({ type: "ws:open" } as WSEvent);
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.loadError).toBeNull();
  });

  it("a successful Retry makes the snapshot cacheable again", () => {
    const api = makeApi();
    const { result, unmount } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({ type: "session:error", sessionId: "s1", message: "boom", reason: "transient" });
    });
    act(() => {
      result.current.retry();
    });
    act(() => {
      api.emit(replay([ev("e1", { kind: "text", logSeq: 1 })]));
    });
    unmount();
    expect(chatSnapshotCache.restore("s1")?.events.map((e) => e.id)).toEqual(["e1"]);
  });

  it("does not arm the bound on the cached-snapshot path", () => {
    chatSnapshotCache.save("s1", {
      events: [ev("e1", { kind: "text", logSeq: 1 })],
      hasMore: false,
      userTurnIds: new Set(),
      latestSeq: 1,
      savedAt: Date.now(),
    });
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      vi.advanceTimersByTime(COLD_START_TIMEOUT_MS * 2);
    });
    expect(result.current.loadError).toBeNull();
    expect(result.current.events).toHaveLength(1);
  });
});
