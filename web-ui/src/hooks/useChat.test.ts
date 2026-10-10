import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { NormalizedEvent, SendChatResponse, SessionMeta, TranscriptPage, WSEvent } from "@/api/types";
import { useChat } from "./useChat";
import * as chatSnapshotCache from "./chatSnapshotCache";

/** Minimal fake api with controllable WS emission for deterministic ordering. */
function makeApi(sendChatResult: SendChatResponse = { turnId: "t1", queuePosition: 0 }) {
  const listeners = new Map<string, Set<(e: WSEvent) => void>>();
  const emit = (ev: WSEvent) => {
    for (const h of listeners.get("*") ?? []) h(ev);
    for (const h of listeners.get(ev.type) ?? []) h(ev);
  };
  const fake = {
    emit,
    on(type: string, h: (e: WSEvent) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(h);
      return () => listeners.get(type)!.delete(h);
    },
    openChat: vi.fn(async () => {}),
    closeChat: vi.fn(async () => {}),
    sendChat: vi.fn(async () => sendChatResult),
    stopChat: vi.fn(async () => ({ ok: true as const })),
    cancelQueuedTurn: vi.fn(async () => ({ ok: true as const })),
    beginEditQueuedTurn: vi.fn(async (_s: string, turnId: string) => ({
      turnId,
      message: "prefill",
      attachments: [],
      queueIndex: 0,
    })),
    resubmitQueuedTurn: vi.fn(async (_s: string, turnId: string) => ({ ok: true as const, turnId })),
    promoteQueuedTurn: vi.fn(async (_s: string, turnId: string) => ({ ok: true as const, turnId })),
    getTranscriptPage: vi.fn(async (): Promise<TranscriptPage> => ({ events: [], hasMore: false })),
    getTranscriptAll: vi.fn(async () => ({ events: [] as NormalizedEvent[] })),
  };
  return fake;
}

function ev(id: string, extra: Partial<NormalizedEvent>): NormalizedEvent {
  return { id, sessionId: "s1", ts: "", provider: "claude", kind: "text", ...extra };
}

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
    expect(api.getTranscriptPage).toHaveBeenCalledWith("s1", 10);
    expect(result.current.events.map((e) => e.id)).toEqual(["e5", "e10"]);
    expect(result.current.hasMore).toBe(false);

    // No-op once the top is reached (hasMore false).
    api.getTranscriptPage.mockClear();
    await act(async () => {
      await result.current.loadEarlier();
    });
    expect(api.getTranscriptPage).not.toHaveBeenCalled();
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

describe("useChat snapshot cache", () => {
  it("(a) restores from cache immediately — no spinner, events visible, openChat uses sinceSeq", async () => {
    // Pre-seed the cache with a fresh snapshot.
    const cachedEvent = ev("e10", { kind: "text", role: "assistant", text: "cached", logSeq: 10 });
    chatSnapshotCache.save("s1", {
      events: [cachedEvent],
      hasMore: false,
      userTurnIds: new Set(),
      latestSeq: 10,
      savedAt: Date.now(), // fresh — within 60 s
    });

    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    // Events and loading state are set synchronously from the snapshot.
    expect(result.current.loading).toBe(false);
    expect(result.current.events.map((e) => e.id)).toEqual(["e10"]);

    // openChat should have been called with sinceSeq=10 (the snapshot's latestSeq).
    expect(api.openChat).toHaveBeenCalledWith("s1", 10);
  });

  it("(b) gap-drop path — stale snapshot replaced by fresh tail when oldestSeq > restoredLatestSeq", async () => {
    // Snapshot has latestSeq=5 but the fresh tail starts at oldestSeq=10 → gap.
    const cachedEvent = ev("e5", { kind: "text", role: "assistant", text: "old", logSeq: 5 });
    chatSnapshotCache.save("s1", {
      events: [cachedEvent],
      hasMore: false,
      userTurnIds: new Set(),
      latestSeq: 5,
      savedAt: Date.now() - 90_000, // stale → sinceSeq omitted → plain tail
    });

    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    // Snapshot was restored (no spinner).
    expect(result.current.loading).toBe(false);
    expect(result.current.events.map((e) => e.id)).toEqual(["e5"]);

    // Plain tail replay arrives with a gap: oldestSeq=10 > restoredLatestSeq=5.
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e10", { kind: "text", role: "assistant", text: "fresh", logSeq: 10 })],
        oldestSeq: 10,
        hasMore: false,
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Stale cached event should be gone; only the fresh tail event remains.
    expect(result.current.events.map((e) => e.id)).toEqual(["e10"]);
  });

  it("(c) stale (>60 s) snapshot without a gap — fresh tail merges normally, no content hole", async () => {
    // Snapshot has latestSeq=5; tail reply has oldestSeq=3 ≤ 5 → no gap → merge.
    const cachedEvent = ev("e5", { kind: "text", role: "assistant", text: "old", logSeq: 5 });
    chatSnapshotCache.save("s1", {
      events: [cachedEvent],
      hasMore: false,
      userTurnIds: new Set(),
      latestSeq: 5,
      savedAt: Date.now() - 90_000, // stale
    });

    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    expect(result.current.loading).toBe(false);

    // Fresh tail: oldestSeq=3, so e5 is within the covered window → merge.
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [
          ev("e3", { kind: "user", role: "user", text: "q", logSeq: 3 }),
          ev("e6", { kind: "text", role: "assistant", text: "a", logSeq: 6 }),
        ],
        oldestSeq: 3,
        hasMore: false,
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Both the cached event and new events are present, ordered by logSeq.
    const ids = result.current.events.map((e) => e.id);
    expect(ids).toContain("e3");
    expect(ids).toContain("e5");
    expect(ids).toContain("e6");
    // Correct order: e3 < e5 < e6
    expect(ids.indexOf("e3")).toBeLessThan(ids.indexOf("e5"));
    expect(ids.indexOf("e5")).toBeLessThan(ids.indexOf("e6"));
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
