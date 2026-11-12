import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiInstance } from "@/api";
import type { NormalizedEvent, TranscriptSincePage } from "@/api/types";
import { mockGetTranscriptAround, mockGetTranscriptSince } from "@/api/mockTranscriptSearch";
import { useChat } from "./useChat";
import * as chatSnapshotCache from "./chatSnapshotCache";
import { ev, makeApi } from "./useChat.testApi";

/** One turn: a `user` row and its reply, at `logSeq` 2n-1 and 2n. */
function turn(n: number): NormalizedEvent[] {
  return [
    ev(`u${n}`, { kind: "user", role: "user", turnId: `t${n}`, logSeq: 2 * n - 1, text: `turn ${n}` }),
    ev(`a${n}`, { kind: "text", role: "assistant", turnId: `t${n}`, logSeq: 2 * n }),
  ];
}
const turns = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => turn(from + i)).flat();
const ids = (events: NormalizedEvent[]) => events.map((e) => e.id);
const sincePage = (events: NormalizedEvent[], hasMore: boolean): TranscriptSincePage => ({
  events,
  ...(events.length ? { nextSeq: events[events.length - 1]!.logSeq! } : {}),
  hasMore,
});

/** A chat whose live tail is turns `tail`..`tail + 9`, viewing a detached window of turns 40..42. */
async function detachedAt40(tail = 91) {
  const api = makeApi();
  const hook = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
  await act(async () => {
    api.emit({ type: "chat:replay", sessionId: "s1", events: turns(tail, tail + 9), oldestSeq: 2 * tail - 1, hasMore: true, turnsBefore: tail - 1 });
  });
  api.getTranscriptAround.mockResolvedValueOnce({ events: turns(40, 42), oldestSeq: 79, hasMore: true, turnsBefore: 39 });
  await act(async () => {
    await hook.result.current.viewAround(80);
  });
  expect(hook.result.current.detached).toBe(true);
  return { api, ...hook };
}

beforeEach(() => {
  chatSnapshotCache.clear();
});

describe("useChat: forward paging in a detached window", () => {
  it("appends the next newer page from the window's newest row and stays detached", async () => {
    const { api, result } = await detachedAt40();
    // The page stops inside turn 45: that turn is left for the next page.
    api.getTranscriptSince.mockResolvedValueOnce(sincePage([...turns(43, 44), turn(45)[0]!], true));
    let moved = false;
    await act(async () => {
      moved = await result.current.loadLater();
    });
    expect(moved).toBe(true);
    expect(api.getTranscriptSince).toHaveBeenCalledWith("s1", 84);
    expect(ids(result.current.events)).toEqual(ids(turns(40, 44)));
    expect(result.current.detached).toBe(true);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.turnsBefore).toBe(39);

    api.getTranscriptSince.mockResolvedValueOnce(sincePage(turns(45, 46), true));
    await act(async () => {
      await result.current.loadLater();
    });
    expect(api.getTranscriptSince).toHaveBeenLastCalledWith("s1", 88);
    // Turn 46 was the page's last turn with more to come, so it is not appended yet.
    expect(ids(result.current.events)).toEqual(ids(turns(40, 45)));
  });

  it("rejoins the live tail when no newer rows are left, with live events that arrived meanwhile", async () => {
    const { api, result } = await detachedAt40();
    await act(async () => {
      api.emit({ type: "session:message", sessionId: "s1", event: turn(101)[0]! });
    });
    expect(ids(result.current.events)).toEqual(ids(turns(40, 42)));

    // The last forward page reaches the tail and overlaps the stashed live window.
    api.getTranscriptSince.mockResolvedValueOnce(sincePage([...turns(43, 100), turn(101)[0]!], false));
    let moved = false;
    await act(async () => {
      moved = await result.current.loadLater();
    });
    expect(moved).toBe(true);
    expect(result.current.detached).toBe(false);
    expect(ids(result.current.events)).toEqual([...ids(turns(40, 100)), "u101"]);
    // The older side keeps the window's cursor: earlier turns still page in.
    expect(result.current.hasMore).toBe(true);
    expect(result.current.turnsBefore).toBe(39);

    // Live streaming resumes into the displayed window.
    await act(async () => {
      api.emit({ type: "session:message", sessionId: "s1", event: turn(101)[1]! });
    });
    expect(ids(result.current.events).slice(-2)).toEqual(["u101", "a101"]);

    api.getTranscriptPage.mockResolvedValueOnce({ events: turns(38, 39), oldestSeq: 75, hasMore: true, turnsBefore: 37 });
    await act(async () => {
      await result.current.loadEarlier();
    });
    expect(api.getTranscriptPage).toHaveBeenCalledWith("s1", 79, undefined);
    expect(ids(result.current.events).slice(0, 4)).toEqual(ids(turns(38, 39)));
  });

  it("rejoins as soon as the window reaches the stashed tail's first row, without duplicates or gaps", async () => {
    const { api, result } = await detachedAt40();
    // Newer rows exist past this page, but its last whole turn (91) is already in the stash.
    api.getTranscriptSince.mockResolvedValueOnce(sincePage(turns(43, 92), true));
    await act(async () => {
      await result.current.loadLater();
    });
    expect(result.current.detached).toBe(false);
    expect(ids(result.current.events)).toEqual(ids(turns(40, 100)));
    expect(new Set(ids(result.current.events)).size).toBe(result.current.events.length);

    // No longer detached: nothing more to load forward.
    await act(async () => {
      expect(await result.current.loadLater()).toBe(false);
    });
    expect(api.getTranscriptSince).toHaveBeenCalledTimes(1);
  });

  it("a failed page leaves the window untouched and the next call can retry", async () => {
    const { api, result } = await detachedAt40();
    api.getTranscriptSince.mockRejectedValueOnce(new Error("network"));
    await act(async () => {
      await expect(result.current.loadLater()).rejects.toThrow("network");
    });
    expect(result.current.detached).toBe(true);
    expect(ids(result.current.events)).toEqual(ids(turns(40, 42)));

    api.getTranscriptSince.mockResolvedValueOnce(sincePage(turns(43, 44), true));
    await act(async () => {
      expect(await result.current.loadLater()).toBe(true);
    });
    expect(api.getTranscriptSince).toHaveBeenLastCalledWith("s1", 84);
  });

  it("a page that does not move the cursor reports no progress and commits nothing", async () => {
    const { api, result } = await detachedAt40();
    const before = result.current.events;
    api.getTranscriptSince.mockResolvedValueOnce({ events: [], hasMore: true });
    await act(async () => {
      expect(await result.current.loadLater()).toBe(false);
    });
    expect(result.current.events).toBe(before);
    expect(result.current.detached).toBe(true);
  });

  it("an empty page at the tail rejoins the stashed live window", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    await act(async () => {
      api.emit({ type: "chat:replay", sessionId: "s1", events: turns(1, 3), hasMore: false, turnsBefore: 0 });
    });
    api.getTranscriptAround.mockResolvedValueOnce({ events: turns(1, 3), oldestSeq: 1, hasMore: false, turnsBefore: 0 });
    await act(async () => {
      await result.current.viewAround(2);
    });
    await act(async () => {
      expect(await result.current.loadLater()).toBe(true);
    });
    expect(api.getTranscriptSince).toHaveBeenCalledWith("s1", 6);
    expect(result.current.detached).toBe(false);
    expect(ids(result.current.events)).toEqual(ids(turns(1, 3)));
  });

  it("runs one forward load at a time", async () => {
    const { api, result } = await detachedAt40();
    let resolve!: (p: TranscriptSincePage) => void;
    api.getTranscriptSince.mockReturnValueOnce(new Promise<TranscriptSincePage>((res) => (resolve = res)));
    let first!: Promise<boolean>;
    await act(async () => {
      first = result.current.loadLater();
      expect(await result.current.loadLater()).toBe(false);
    });
    expect(api.getTranscriptSince).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(sincePage(turns(43, 44), true));
      expect(await first).toBe(true);
    });
    expect(ids(result.current.events)).toEqual(ids(turns(40, 43)));
  });

  it("a page landing after a new jump or a return to latest commits nothing", async () => {
    const { api, result } = await detachedAt40();
    let resolve!: (p: TranscriptSincePage) => void;
    api.getTranscriptSince.mockReturnValueOnce(new Promise<TranscriptSincePage>((res) => (resolve = res)));
    let slow!: Promise<boolean>;
    act(() => {
      slow = result.current.loadLater();
    });
    api.getTranscriptAround.mockResolvedValueOnce({ events: turns(10, 12), oldestSeq: 19, hasMore: true, turnsBefore: 9 });
    await act(async () => {
      await result.current.viewAround(20);
    });
    await act(async () => {
      resolve(sincePage(turns(43, 50), true));
      expect(await slow).toBe(false);
    });
    expect(ids(result.current.events)).toEqual(ids(turns(10, 12)));

    // The next forward load pages from the NEW window's newest row.
    api.getTranscriptSince.mockReturnValueOnce(new Promise<TranscriptSincePage>((res) => (resolve = res)));
    act(() => {
      slow = result.current.loadLater();
    });
    expect(api.getTranscriptSince).toHaveBeenLastCalledWith("s1", 24);
    act(() => {
      result.current.returnToLatest();
    });
    await act(async () => {
      resolve(sincePage(turns(13, 14), true));
      expect(await slow).toBe(false);
    });
    expect(result.current.detached).toBe(false);
    expect(ids(result.current.events)).toEqual(ids(turns(91, 100)));
  });

  it("is a no-op while the chat is on its live window", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    await act(async () => {
      api.emit({ type: "chat:replay", sessionId: "s1", events: turns(1, 2), hasMore: false, turnsBefore: 0 });
    });
    await act(async () => {
      expect(await result.current.loadLater()).toBe(false);
    });
    expect(api.getTranscriptSince).not.toHaveBeenCalled();
  });

  it("forward pages are never trimmed; the live cap applies again after the rejoin", async () => {
    const { api, result } = await detachedAt40(3500);
    // 3,000 turns = 6,000 rows, past the 5,000-row live cap.
    api.getTranscriptSince.mockResolvedValueOnce(sincePage(turns(43, 3042), true));
    await act(async () => {
      await result.current.loadLater();
    });
    expect(result.current.events).toHaveLength(2 * (3041 - 40 + 1));
    expect(result.current.events[0]!.id).toBe("u40");
    expect(result.current.detached).toBe(true);

    api.getTranscriptSince.mockResolvedValueOnce(sincePage(turns(3042, 3499), false));
    await act(async () => {
      await result.current.loadLater();
    });
    expect(result.current.detached).toBe(false);
    const joined = result.current.events.length;
    expect(joined).toBe(2 * (3509 - 40 + 1));

    // Scrolled up (no trimming allowed): a live row only appends.
    act(() => result.current.setCanTrim(false));
    await act(async () => {
      api.emit({ type: "session:message", sessionId: "s1", event: turn(4000)[0]! });
    });
    expect(result.current.events).toHaveLength(joined + 1);

    // Back at the bottom: the next live row trims the oldest rows at a turn boundary.
    act(() => result.current.setCanTrim(true));
    await act(async () => {
      api.emit({ type: "session:message", sessionId: "s1", event: turn(4000)[1]! });
    });
    expect(result.current.events.length).toBeLessThan(joined);
    expect(result.current.events[0]!.kind).toBe("user");
    expect(result.current.events[result.current.events.length - 1]!.id).toBe("a4000");
    expect(result.current.hasMore).toBe(true);
  });
});

describe("useChat: jump into the middle of a 5,000-turn chat and scroll to its end", () => {
  it("keeps loading newer turns from turn 2344 until the live tail, with no gap or duplicate", async () => {
    const all = turns(1, 5000);
    const api = makeApi();
    api.getTranscriptAround.mockImplementation(async (...args: unknown[]) => mockGetTranscriptAround(all, args[1] as number));
    api.getTranscriptSince.mockImplementation(async (...args: unknown[]) => mockGetTranscriptSince(all, args[1] as number));
    const { result } = renderHook(() => useChat(api as unknown as ApiInstance, "s1", true));
    await act(async () => {
      api.emit({ type: "chat:replay", sessionId: "s1", events: turns(4981, 5000), oldestSeq: 9961, hasMore: true, turnsBefore: 4980 });
    });

    await act(async () => {
      await result.current.viewAround(2 * 2344 - 1);
    });
    expect(result.current.detached).toBe(true);
    const first = result.current.events[0]!.logSeq!;
    const windowEnd = result.current.events[result.current.events.length - 1]!;
    expect(first).toBeLessThanOrEqual(2 * 2344 - 1);
    expect(windowEnd.turnId).toBe("t2351");

    // Reaching the bottom of the window loads more, again and again, up to the tail.
    let loads = 0;
    let previousLast = windowEnd.logSeq!;
    while (result.current.detached) {
      let moved = false;
      await act(async () => {
        moved = await result.current.loadLater();
      });
      expect(moved).toBe(true);
      loads++;
      const last = result.current.events[result.current.events.length - 1]!.logSeq!;
      expect(last).toBeGreaterThan(previousLast);
      previousLast = last;
      expect(loads).toBeLessThan(100);
    }
    expect(loads).toBeGreaterThan(20);

    const seqs = result.current.events.map((e) => e.logSeq!);
    expect(seqs[0]).toBe(first);
    expect(seqs[seqs.length - 1]).toBe(10000);
    expect(seqs).toEqual(Array.from({ length: 10000 - first + 1 }, (_, i) => first + i));
    expect(result.current.turnsBefore).toBe((first - 1) / 2);
    expect(result.current.hasMore).toBe(true);
  });

  it("a long run while detached keeps the stash bounded and returnToLatest mounts only the capped tail", async () => {
    const { api, result } = await detachedAt40();
    await act(async () => {
      for (let n = 1; n <= 6000; n++) {
        const t = 1000 + Math.floor(n / 2);
        api.emit({
          type: "session:message",
          sessionId: "s1",
          event: ev(`live${n}`, { kind: n % 2 ? "user" : "text", role: n % 2 ? "user" : "assistant", turnId: `tl${t}`, logSeq: 10000 + n }),
        });
        // A replayed duplicate is dropped by the id set.
        if (n % 1000 === 0) {
          api.emit({ type: "session:message", sessionId: "s1", event: ev(`live${n}`, { kind: "text", turnId: `tl${t}`, logSeq: 10000 + n }) });
        }
      }
    });
    expect(result.current.events.length).toBeLessThan(10); // still the detached window
    act(() => {
      result.current.returnToLatest();
    });
    const out = result.current.events;
    expect(out.length).toBeLessThanOrEqual(5000);
    expect(out[out.length - 1]!.id).toBe("live6000");
    expect(new Set(out.map((e) => e.id)).size).toBe(out.length);
    expect(result.current.hasMore).toBe(true);
    expect(out[0]!.kind).toBe("user");
  });
});
