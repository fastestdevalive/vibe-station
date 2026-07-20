import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { NormalizedEvent, SessionMeta, TranscriptPage, WSEvent } from "@/api/types";
import { useChat } from "./useChat";

/** Minimal fake api with controllable WS emission for deterministic ordering. */
function makeApi(sendChatResult = { turnId: "t1", queuePosition: 0 }) {
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

describe("useChat (4.T1)", () => {
  it("merges chat:replay then live session:message into ordered events, and updates meta", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));

    expect(api.openChat).toHaveBeenCalledWith("s1");

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
