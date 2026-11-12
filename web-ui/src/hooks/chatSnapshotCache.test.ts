import { beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@/api/types";
import * as chatSnapshotCache from "./chatSnapshotCache";

function ev(i: number, kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return { id: `e${i}`, sessionId: "s1", ts: "", provider: "claude", kind, logSeq: i, ...extra };
}

/** `count` events with logSeq = index; `user` turns at `userAt`, assistant text elsewhere. */
function transcript(count: number, userAt: number[], extra: (i: number) => Partial<NormalizedEvent> = () => ({})): NormalizedEvent[] {
  return Array.from({ length: count }, (_, i) =>
    userAt.includes(i) ? ev(i, "user", { role: "user", turnId: `t${i}`, ...extra(i) }) : ev(i, "text", { role: "assistant" }),
  );
}

function saveEvents(events: NormalizedEvent[], opts: { hasMore?: boolean; turnsBefore?: number | null } = {}) {
  chatSnapshotCache.save("s1", {
    events,
    hasMore: opts.hasMore ?? false,
    userTurnIds: new Set(),
    turnsBefore: opts.turnsBefore,
    latestSeq: events[events.length - 1]?.logSeq ?? null,
    savedAt: 0,
  });
}

describe("chatSnapshotCache.save", () => {
  beforeEach(() => {
    chatSnapshotCache.clear();
  });

  it("cuts an over-long window at the user turn at or before the newest 200 events", () => {
    saveEvents(transcript(439, [0, 154]), { turnsBefore: 3 });
    const snap = chatSnapshotCache.restore("s1")!;
    expect(snap.events[0]!.kind).toBe("user");
    expect(snap.events[0]!.id).toBe("e154");
    expect(snap.events).toHaveLength(439 - 154);
    expect(snap.oldestSeq).toBe(154);
    expect(snap.hasMore).toBe(true);
    // The dropped turn (at 0) is added to the turns already before the window.
    expect(snap.turnsBefore).toBe(4);
  });

  it("keeps everything when no user turn starts at or before the cut point", () => {
    saveEvents(transcript(439, [300]), { turnsBefore: 2 });
    const snap = chatSnapshotCache.restore("s1")!;
    expect(snap.events).toHaveLength(439);
    expect(snap.oldestSeq).toBe(0);
    expect(snap.hasMore).toBe(false);
    expect(snap.turnsBefore).toBe(2);
  });

  it("a window at or under the cap is kept whole and hasMore is left as saved", () => {
    saveEvents(transcript(200, [0, 50]), { turnsBefore: 0 });
    let snap = chatSnapshotCache.restore("s1")!;
    expect(snap.events).toHaveLength(200);
    expect(snap.hasMore).toBe(false);
    expect(snap.turnsBefore).toBe(0);

    saveEvents(transcript(10, [0]), { hasMore: true, turnsBefore: 7 });
    snap = chatSnapshotCache.restore("s1")!;
    expect(snap.hasMore).toBe(true);
    expect(snap.turnsBefore).toBe(7);
  });

  it("an unknown turnsBefore stays unknown after a cut", () => {
    saveEvents(transcript(439, [0, 154]));
    expect(chatSnapshotCache.restore("s1")!.turnsBefore).toBeNull();
  });

  it("silent notice turns are not boundaries and do not count as dropped turns", () => {
    saveEvents(transcript(439, [0, 100, 200], (i) => (i === 200 ? { silent: true } : {})), { turnsBefore: 0 });
    const snap = chatSnapshotCache.restore("s1")!;
    expect(snap.oldestSeq).toBe(100);
    expect(snap.turnsBefore).toBe(1);
  });
});
