import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiInstance } from "@/api";
import type { NormalizedEvent } from "@/api/types";
import { groupEvents } from "@/components/chat/MessageList";
import { buildTurnOutline } from "@/components/chat/outline/buildTurnOutline";
import { useChat } from "./useChat";
import * as chatSnapshotCache from "./chatSnapshotCache";
import { ev, makeApi } from "./useChat.testApi";

// Prevent snapshot bleed between tests.
beforeEach(() => {
  chatSnapshotCache.clear();
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
      turnsBefore: 7,
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
        turnsBefore: 2,
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // The tail reaches further back than the snapshot, so its numbering wins.
    expect(result.current.turnsBefore).toBe(2);
    // Both the cached event and new events are present, ordered by logSeq.
    const ids = result.current.events.map((e) => e.id);
    expect(ids).toContain("e3");
    expect(ids).toContain("e5");
    expect(ids).toContain("e6");
    // Correct order: e3 < e5 < e6
    expect(ids.indexOf("e3")).toBeLessThan(ids.indexOf("e5"));
    expect(ids.indexOf("e5")).toBeLessThan(ids.indexOf("e6"));
  });

  it("a tail starting inside the snapshot window keeps the snapshot's turnsBefore", async () => {
    chatSnapshotCache.save("s1", {
      events: [
        ev("e3", { kind: "text", role: "assistant", text: "a", logSeq: 3 }),
        ev("e5", { kind: "text", role: "assistant", text: "b", logSeq: 5 }),
      ],
      hasMore: true,
      userTurnIds: new Set(),
      latestSeq: 5,
      turnsBefore: 7,
      savedAt: Date.now() - 90_000,
    });
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e6", { kind: "text", role: "assistant", text: "c", logSeq: 6 })],
        oldestSeq: 4,
        hasMore: true,
        turnsBefore: 1,
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.events.map((e) => e.id)).toEqual(["e3", "e5", "e6"]);
    expect(result.current.turnsBefore).toBe(7);
  });

  it("a tail replay with hasMore: false narrows the hasMore a restored snapshot forced on", async () => {
    chatSnapshotCache.save("s1", {
      events: [ev("e5", { kind: "user", role: "user", turnId: "t5", text: "q", logSeq: 5 })],
      hasMore: true,
      userTurnIds: new Set(["t5"]),
      latestSeq: 5,
      savedAt: Date.now() - 90_000,
    });
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    expect(result.current.hasMore).toBe(true);
    act(() => {
      api.emit({
        type: "chat:replay",
        sessionId: "s1",
        events: [ev("e1", { kind: "user", role: "user", turnId: "t1", text: "first", logSeq: 1 })],
        oldestSeq: 1,
        hasMore: false,
        turnsBefore: 0,
      });
    });
    await waitFor(() => expect(result.current.hasMore).toBe(false));
  });

  it("an in-app return within 60 s keeps the outline's last turn, its beats and turnsBefore (empty delta)", () => {
    // 439 events: turn 1 at 0, turn 2 at 154 followed by tool runs + replies (text beats).
    const events: NormalizedEvent[] = [];
    let seq = 0;
    const push = (kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent>) => {
      events.push(ev(`e${seq}`, { kind, logSeq: seq, ...extra }));
      seq++;
    };
    push("user", { role: "user", turnId: "t1", text: "first" });
    while (seq < 154) push("text", { role: "assistant", turnId: "t1", text: `filler ${seq}` });
    push("user", { role: "user", turnId: "t2", text: "second" });
    while (seq + 3 <= 439) {
      const tool = `tool${seq}`;
      push("tool_use", { turnId: "t2", toolId: tool, toolName: "Read" });
      push("tool_result", { turnId: "t2", toolId: tool, toolStatus: "completed" });
      push("text", { role: "assistant", turnId: "t2", text: `step ${seq}` });
    }
    while (seq < 439) push("text", { role: "assistant", turnId: "t2", text: "tail" });

    const outline = (r: { events: NormalizedEvent[]; turnsBefore: number | null }) =>
      buildTurnOutline(groupEvents(r.events), { turnsBefore: r.turnsBefore });

    const api = makeApi();
    const first = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    act(() => {
      api.emit({ type: "chat:replay", sessionId: "s1", events, oldestSeq: 0, hasMore: false, turnsBefore: 0 });
    });
    const before = outline(first.result.current);
    const lastBefore = before[before.length - 1]!;
    expect(lastBefore.number).toBe(2);
    expect(lastBefore.beats.length).toBeGreaterThan(0);
    const turnsBeforeBefore = first.result.current.turnsBefore;
    first.unmount();

    const second = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    expect(api.openChat).toHaveBeenLastCalledWith("s1", 438);
    act(() => {
      api.emit({ type: "chat:replay", sessionId: "s1", events: [] });
    });
    const after = outline(second.result.current);
    const lastAfter = after[after.length - 1]!;
    expect(second.result.current.events[0]!.kind).toBe("user");
    expect(lastAfter.key).toBe(lastBefore.key);
    expect(lastAfter.number).toBe(lastBefore.number);
    expect(lastAfter.beats.length).toBe(lastBefore.beats.length);
    // The window starts at turn 2 now, so one turn sits before it.
    expect(second.result.current.turnsBefore).toBe(1);
    expect(turnsBeforeBefore).toBe(0);
    expect(second.result.current.hasMore).toBe(true);
  });
});
