import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { BACKFILL_BASE_MS, BACKFILL_MAX_MS, useChatFind } from "./useChatFind";
import type { ApiInstance } from "@/api";
import type { NormalizedEvent, TranscriptSearchMatch, TranscriptSearchPage } from "@/api/types";
import type { MessageNav } from "../messageNav";

describe("useChatFind", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const mockNav: MessageNav = {
    seqAnchor: vi.fn(),
    anchorWhere: vi.fn().mockReturnValue("in-view"),
    scrollToAnchor: vi.fn().mockResolvedValue("test-key"),
    visibleItemRange: vi.fn().mockReturnValue([0, 10]),
    rowFor: vi.fn(() => null),
    jumpTurn: vi.fn(),
    flashAnchor: vi.fn(),
  };

  const navRef = { current: mockNav };

  const sampleMatch = (seq: number, occ: number, turnIndex = 1): TranscriptSearchMatch => ({
    seq,
    occurrence: occ,
    turnIndex,
    kind: "user",
    snippet: [{ text: "hello world", hit: true }],
  });

  it("counts a query in Unicode scalars: an astral char plus one letter is short, not searched", async () => {
    const searchMock = vi.fn();
    const mockApi = {
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: searchMock,
    } as unknown as ApiInstance;
    const { result } = renderHook(() =>
      useChatFind({ sessionId: "s1", api: mockApi, events: [], navRef }),
    );
    act(() => {
      result.current.openFind();
      result.current.setQuery("\u{1F680}a"); // 3 UTF-16 units, 2 scalars
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.status).toBe("short");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("does not announce No results while the index is still backfilling", async () => {
    const searchMock = vi.fn().mockResolvedValue({
      query: "test",
      total: 0,
      totalCapped: false,
      matches: [],
      turnCount: 5,
      backfilling: true,
    } as TranscriptSearchPage);
    const mockApi = {
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: searchMock,
    } as unknown as ApiInstance;
    const { result } = renderHook(() =>
      useChatFind({ sessionId: "s1", api: mockApi, events: [], navRef }),
    );
    act(() => {
      result.current.openFind();
      result.current.setQuery("test");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.announcement).toBe("Indexing, results may be incomplete");
  });

  it("debounces requests, handles short queries, offline, aborts, errors and retry", async () => {
    const searchMock = vi.fn().mockImplementation(async () => {
      return {
        query: "test",
        total: 1,
        totalCapped: false,
        matches: [sampleMatch(10, 0)],
        turnCount: 5,
        backfilling: false,
      } as TranscriptSearchPage;
    });

    const mockApi = {
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: searchMock,
    } as unknown as ApiInstance;

    const { result } = renderHook(() =>
      useChatFind({
        sessionId: "s1",
        api: mockApi,
        events: [],
        navRef,
      }),
    );

    act(() => {
      result.current.openFind();
      result.current.setQuery("ab");
    });

    // 2 chars -> "short" with no request
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.status).toBe("short");
    expect(searchMock).not.toHaveBeenCalled();

    // Type 3 chars -> request after 250ms
    act(() => {
      result.current.setQuery("tes");
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(searchMock).not.toHaveBeenCalled();

    // Second keystroke aborts the first request
    act(() => {
      result.current.setQuery("test");
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(searchMock).toHaveBeenCalledTimes(1);

    // Offline -> status "offline" with no server request
    const offlineApi = {
      getConnectionState: vi.fn().mockReturnValue("offline"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: vi.fn(),
    } as unknown as ApiInstance;

    const { result: offlineResult } = renderHook(() =>
      useChatFind({
        sessionId: "s_offline",
        api: offlineApi,
        events: [],
        navRef,
      }),
    );
    act(() => {
      offlineResult.current.openFind();
      offlineResult.current.setQuery("hello");
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(offlineResult.current.status).toBe("offline");
    expect(offlineApi.searchTranscript).not.toHaveBeenCalled();

    // Rejected request -> "error" and retry() re-requests
    const errorSearchMock = vi.fn().mockRejectedValue(new Error("Network failed"));
    const errorApi = {
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: errorSearchMock,
    } as unknown as ApiInstance;

    const { result: errorResult } = renderHook(() =>
      useChatFind({
        sessionId: "s1",
        api: errorApi,
        events: [],
        navRef,
      }),
    );
    act(() => {
      errorResult.current.openFind();
      errorResult.current.setQuery("error-search");
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(errorResult.current.status).toBe("error");

    // Retry re-requests
    await act(async () => {
      errorResult.current.retry();
    });
    expect(errorSearchMock).toHaveBeenCalledTimes(2);
  });

  it("handles backfill, settle rule, and totalCapped", async () => {
    let callIndex = 0;
    const searchMock = vi.fn().mockImplementation(async (_sid, req) => {
      callIndex++;
      if (callIndex === 1) {
        // First call reports backfilling: true
        return {
          query: req.q,
          total: 450,
          totalCapped: false,
          matches: Array.from({ length: 200 }, (_, i) => sampleMatch(i + 1, 0)),
          nextCursor: "200:0",
          turnCount: 10,
          backfilling: true,
        } as TranscriptSearchPage;
      }
      if (callIndex === 2) {
        // Backfill poll completes
        return {
          query: req.q,
          total: 450,
          totalCapped: false,
          matches: Array.from({ length: 200 }, (_, i) => sampleMatch(i + 1, 0)),
          nextCursor: "200:0",
          turnCount: 10,
          backfilling: false,
        } as TranscriptSearchPage;
      }
      if (req.after) {
        // Settle response with cursor
        return {
          query: req.q,
          total: 251, // remaining matches after cursor
          totalCapped: false,
          matches: Array.from({ length: 200 }, (_, i) => sampleMatch(i + 201, 0)),
          nextCursor: "400:0",
          turnCount: 11,
          backfilling: false,
        } as TranscriptSearchPage;
      }
      return {
        query: req.q,
        total: 10,
        totalCapped: false,
        matches: [],
        turnCount: 10,
        backfilling: false,
      };
    });

    const mockApi = {
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: searchMock,
    } as unknown as ApiInstance;

    const { result, rerender } = renderHook(
      ({ active }) =>
        useChatFind({
          sessionId: "s_settle",
          api: mockApi,
          events: [],
          navRef,
          turnActive: active,
        }),
      { initialProps: { active: true } },
    );

    act(() => {
      result.current.openFind();
      result.current.setQuery("test");
    });

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current.backfilling).toBe(true);
    expect(searchMock).toHaveBeenCalledTimes(1);

    // backfilling: true triggers one re-request after 1,000 ms
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(result.current.backfilling).toBe(false);

    // turnActive true -> false with 200 matches held requests after="<seq>:<occurrence>"
    // sets N = held (200) + response.total (251) = 451, held = 400
    await act(async () => {
      rerender({ active: false });
    });

    expect(searchMock).toHaveBeenCalledTimes(3);
    const lastCall = searchMock.mock.calls[2]!;
    expect(lastCall[1].after).toBe("200:0");
    expect(result.current.total).toBe(451);
    expect(result.current.matches.length).toBe(400);

    // with totalCapped it sends nothing on settle
    searchMock.mockClear();
    act(() => {
      // Simulate totalCapped = true
      result.current.openFind();
      result.current.setQuery("overflow");
    });
    searchMock.mockResolvedValueOnce({
      query: "overflow",
      total: 1000,
      totalCapped: true,
      matches: [sampleMatch(1, 0)],
      turnCount: 50,
      backfilling: false,
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.totalCapped).toBe(true);
    searchMock.mockClear();

    // Turn settles while totalCapped is true -> sends nothing
    rerender({ active: true });
    rerender({ active: false });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("next() pagination, wrapping announcements, and jumpTo distance thresholds", async () => {
    const page1Matches = [sampleMatch(10, 0), sampleMatch(20, 0)];
    const page2Matches = [sampleMatch(30, 0)];

    const searchMock = vi.fn().mockImplementation(async (_sid, req) => {
      if (req.after === "20:0") {
        return {
          query: req.q,
          total: 1, // matches after cursor
          totalCapped: false,
          matches: page2Matches,
          nextCursor: undefined,
          turnCount: 2,
          backfilling: false,
        } as TranscriptSearchPage;
      }
      return {
        query: req.q,
        total: 3,
        totalCapped: false,
        matches: page1Matches,
        nextCursor: "20:0",
        turnCount: 2,
        backfilling: false,
      } as TranscriptSearchPage;
    });

    const mockApi = {
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: searchMock,
    } as unknown as ApiInstance;

    const mockLoadEarlierTo = vi.fn().mockImplementation(async (seq: number) => {
      // The real `useChat.loadEarlierTo` commits the prepended rows before its
      // promise resolves (`flushSync`). Simulate that: only publish the new
      // nav AFTER an await — a synchronous mock would hide the bug this test covers.
      await Promise.resolve();
      navRef.current = {
        ...mockNav,
        seqAnchor: vi.fn((s: number) => {
          if (s >= 10 && s <= 30) return `u:${s}`;
          if (s === seq) return `u:${seq}`;
          return undefined;
        }),
      };
    });
    const mockViewAround = vi.fn().mockResolvedValue(undefined);

    (mockNav.seqAnchor as ReturnType<typeof vi.fn>).mockImplementation((seq: number) => {
      if (seq >= 10 && seq <= 30) return `u:${seq}`;
      return undefined;
    });

    const events: NormalizedEvent[] = [{ id: "ev-1", sessionId: "s1", provider: "claude", logSeq: 1000, kind: "user", ts: "2026-01-01T00:00:00Z" }];

    const { result } = renderHook(() =>
      useChatFind({
        sessionId: "s1",
        api: mockApi,
        events,
        navRef,
        onLoadEarlierTo: mockLoadEarlierTo,
        onViewAround: mockViewAround,
      }),
    );

    act(() => {
      result.current.openFind();
      result.current.setQuery("find-all");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current.matches).toHaveLength(2);
    expect(result.current.total).toBe(3);

    // Step to second match
    await act(async () => {
      result.current.next();
    });
    expect(result.current.current?.seq).toBe(20);

    // next() on the last loaded match with nextCursor fetches more
    await act(async () => {
      result.current.next();
    });
    expect(searchMock).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ after: "20:0" }),
      expect.anything(),
    );
    expect(result.current.matches).toHaveLength(3);
    // Counting rule: that page never changes N or totalCapped
    expect(result.current.total).toBe(3);
    expect(result.current.current?.seq).toBe(30);

    // next() on final match wraps to first and announces
    await act(async () => {
      result.current.next();
    });
    expect(result.current.announcement).toContain("Wrapped to first");
    expect(result.current.current?.seq).toBe(10);

    // prev() on first match wraps to last and announces
    await act(async () => {
      result.current.prev();
    });
    expect(result.current.announcement).toContain("Wrapped to last");
    expect(result.current.current?.seq).toBe(30);

    // jumpTo a not-loaded match 100 rows away calls onLoadEarlierTo once and scrolls to anchor
    // oldestLoadedSeq = 1000. 1000 - 900 = 100 (<= 250)
    await act(async () => {
      await result.current.jumpTo(sampleMatch(900, 0));
    });
    expect(mockLoadEarlierTo).toHaveBeenCalledWith(900);
    expect(mockViewAround).not.toHaveBeenCalled();
    expect(mockNav.scrollToAnchor).toHaveBeenCalledWith("u:900", expect.anything());

    // jumpTo a not-loaded match 5,000 rows away calls viewAround
    // oldestLoadedSeq = 1000. 1000 - (-4000) = 5000 (> 250)
    mockLoadEarlierTo.mockClear();
    (mockNav.scrollToAnchor as ReturnType<typeof vi.fn>).mockClear();
    await act(async () => {
      await result.current.jumpTo(sampleMatch(-4000, 0));
    });
    expect(mockViewAround).toHaveBeenCalledWith(-4000);
    expect(mockLoadEarlierTo).not.toHaveBeenCalled();
  });

  it("the first jump of a fresh query computes its ordinal from that response, not the previous matches", async () => {
    // Three occurrences of one term inside the SAME anchor. The initial-match rule picks
    // the last one (all "above" the viewport); its ordinal must be 2, not the
    // stale list's -1 → 0.
    const matches = [sampleMatch(10, 0), sampleMatch(10, 1), sampleMatch(10, 2)];
    const searchMock = vi.fn().mockResolvedValue({
      query: "legacy",
      total: 3,
      totalCapped: false,
      matches,
      turnCount: 1,
      backfilling: false,
    } as TranscriptSearchPage);

    const mockApi = {
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: searchMock,
    } as unknown as ApiInstance;

    const freshNav: MessageNav = {
      seqAnchor: vi.fn((s: number) => (s === 10 ? "u:t1" : undefined)),
      anchorWhere: vi.fn().mockReturnValue("above"),
      scrollToAnchor: vi.fn().mockResolvedValue("u:t1/0:2"),
      visibleItemRange: vi.fn().mockReturnValue([0, 0]),
      rowFor: vi.fn(() => null),
      jumpTurn: vi.fn(),
      flashAnchor: vi.fn(),
    };
    const localNavRef = { current: freshNav };

    const { result } = renderHook(() =>
      useChatFind({
        sessionId: "s_r2",
        api: mockApi,
        events: [{ id: "e", sessionId: "s_r2", provider: "claude", logSeq: 10, kind: "user", ts: "" }],
        navRef: localNavRef,
      }),
    );

    act(() => {
      result.current.openFind();
      result.current.setQuery("legacy");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current.matches).toHaveLength(3);
    expect(result.current.current).toEqual({ seq: 10, occurrence: 2 });
    expect(freshNav.scrollToAnchor).toHaveBeenCalledWith(
      "u:t1",
      expect.objectContaining({ ordinal: 2 }),
    );
  });

  it("a backfill retry / list toggle of the SAME query keeps the current match without re-jumping", async () => {
    let call = 0;
    const searchMock = vi.fn().mockImplementation(async () => {
      call++;
      return {
        query: "legacy",
        total: 1,
        totalCapped: false,
        matches: [sampleMatch(10, 0)],
        turnCount: 1,
        // First response is still backfilling → the hook schedules a 1s retry.
        backfilling: call === 1,
      } as TranscriptSearchPage;
    });

    const mockApi = {
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: searchMock,
    } as unknown as ApiInstance;

    const stableNav: MessageNav = {
      seqAnchor: vi.fn((s: number) => (s === 10 ? "u:t1" : undefined)),
      anchorWhere: vi.fn().mockReturnValue("in-view"),
      scrollToAnchor: vi.fn().mockResolvedValue("u:t1/0:0"),
      visibleItemRange: vi.fn().mockReturnValue([0, 0]),
      rowFor: vi.fn(() => null),
      jumpTurn: vi.fn(),
      flashAnchor: vi.fn(),
    };
    const localNavRef = { current: stableNav };

    const { result } = renderHook(() =>
      useChatFind({
        sessionId: "s_s1",
        api: mockApi,
        events: [{ id: "e", sessionId: "s_s1", provider: "claude", logSeq: 10, kind: "user", ts: "" }],
        navRef: localNavRef,
      }),
    );

    act(() => {
      result.current.openFind();
      result.current.setQuery("legacy");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(stableNav.scrollToAnchor).toHaveBeenCalledTimes(1);
    expect(result.current.current).toEqual({ seq: 10, occurrence: 0 });

    // 1s backfill retry re-runs the same query: current kept, no second scroll.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(stableNav.scrollToAnchor).toHaveBeenCalledTimes(1);

    // Toggling the results list (snippets refetch) must not pull the view back either.
    await act(async () => {
      result.current.toggleList();
    });
    expect(searchMock).toHaveBeenCalledTimes(3);
    expect(stableNav.scrollToAnchor).toHaveBeenCalledTimes(1);
    expect(result.current.current).toEqual({ seq: 10, occurrence: 0 });
  });

  it("closing find clears matches, total, and status to idle; reopening re-runs remembered query", async () => {
    const searchMock = vi.fn().mockImplementation(async () => {
      return {
        query: "hello",
        total: 2,
        totalCapped: false,
        matches: [sampleMatch(10, 0), sampleMatch(20, 0)],
        turnCount: 5,
        backfilling: false,
      } as TranscriptSearchPage;
    });

    const mockApi = {
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript: searchMock,
    } as unknown as ApiInstance;

    const { result } = renderHook(() =>
      useChatFind({
        sessionId: "s_close_test",
        api: mockApi,
        events: [],
        navRef,
      }),
    );

    act(() => {
      result.current.openFind();
      result.current.setQuery("hello");
    });

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(result.current.matches).toHaveLength(2);
    expect(result.current.total).toBe(2);
    expect(result.current.status).toBe("ready");

    // Close find
    act(() => {
      result.current.close();
    });

    expect(result.current.matches).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.status).toBe("idle");

    // Reopen with the remembered query
    act(() => {
      result.current.openFind();
    });

    expect(result.current.query).toBe("hello");

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(result.current.matches).toHaveLength(2);
    expect(result.current.total).toBe(2);
  });
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const onlineApi = (searchTranscript: ReturnType<typeof vi.fn>) =>
    ({
      getConnectionState: vi.fn().mockReturnValue("online"),
      subscribeConnection: vi.fn().mockReturnValue(() => {}),
      searchTranscript,
    }) as unknown as ApiInstance;

  const page = (q: string, matches: TranscriptSearchMatch[]): TranscriptSearchPage => ({
    query: q,
    total: matches.length,
    totalCapped: false,
    matches,
    turnCount: 1,
    backfilling: false,
  });

  it("a response for 'foo' that lands after shortening the query to 'fo' is ignored", async () => {
    const fooReq = deferred<TranscriptSearchPage>();
    let signal: AbortSignal | undefined;
    const searchMock = vi.fn().mockImplementation((_s, _r, sig?: AbortSignal) => {
      signal = sig;
      return fooReq.promise;
    });
    const { result } = renderHook(() =>
      useChatFind({ sessionId: "s_stale", api: onlineApi(searchMock), events: [], navRef }),
    );

    act(() => {
      result.current.openFind();
      result.current.setQuery("foo");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("searching");

    act(() => {
      result.current.setQuery("fo");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.status).toBe("short");
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      fooReq.resolve(page("foo", [sampleMatch(10, 0)]));
    });
    expect(result.current.status).toBe("short");
    expect(result.current.matches).toEqual([]);
    expect(result.current.current).toBeNull();
  });

  it("a turn settling while a fresh search is in flight re-runs it instead of dropping it", async () => {
    const first = deferred<TranscriptSearchPage>();
    const searchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => page("legacy", [sampleMatch(10, 0)]));
    const { result, rerender } = renderHook(
      ({ active }) =>
        useChatFind({ sessionId: "s_settle_fresh", api: onlineApi(searchMock), events: [], navRef, turnActive: active }),
      { initialProps: { active: true } },
    );

    act(() => {
      result.current.openFind();
      result.current.setQuery("legacy");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.status).toBe("searching");

    await act(async () => {
      rerender({ active: false });
    });
    // The settle became a fresh search (no `after` cursor) that supersedes the first.
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls[1]![1].after).toBeUndefined();
    expect(result.current.status).toBe("ready");
    expect(result.current.matches).toHaveLength(1);

    await act(async () => {
      first.resolve(page("legacy", []));
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.matches).toHaveLength(1);
  });

  it("next() twice at the last loaded match fetches and appends the next page once", async () => {
    (mockNav.seqAnchor as ReturnType<typeof vi.fn>).mockImplementation((seq: number) => `u:${seq}`);
    const more = deferred<TranscriptSearchPage>();
    const searchMock = vi.fn().mockImplementation((_s, req) => {
      if (req.after === "20:0") return more.promise;
      return Promise.resolve({ ...page(req.q, [sampleMatch(10, 0), sampleMatch(20, 0)]), total: 3, nextCursor: "20:0" });
    });
    const { result } = renderHook(() =>
      useChatFind({ sessionId: "s_double_next", api: onlineApi(searchMock), events: [], navRef }),
    );
    act(() => {
      result.current.openFind();
      result.current.setQuery("paged");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await act(async () => {
      await result.current.jumpTo(sampleMatch(20, 0));
    });

    await act(async () => {
      void result.current.next();
      void result.current.next();
    });
    expect(searchMock.mock.calls.filter((c) => c[1].after === "20:0")).toHaveLength(1);

    await act(async () => {
      more.resolve(page("paged", [sampleMatch(30, 0)]));
    });
    expect(result.current.matches.map((m) => m.seq)).toEqual([10, 20, 30]);
    expect(result.current.current?.seq).toBe(30);
  });

  it("a turn settling while a page is loading appends that page once, then settles", async () => {
    (mockNav.seqAnchor as ReturnType<typeof vi.fn>).mockImplementation((seq: number) => `u:${seq}`);
    const more = deferred<TranscriptSearchPage>();
    const searchMock = vi.fn().mockImplementation((_s, req) => {
      if (req.after === "20:0" && searchMock.mock.calls.filter((c) => c[1].after === "20:0").length === 1) {
        return more.promise;
      }
      if (req.after === "20:0") {
        return Promise.resolve(page(req.q, [sampleMatch(30, 0), sampleMatch(40, 0)]));
      }
      return Promise.resolve({ ...page(req.q, [sampleMatch(10, 0), sampleMatch(20, 0)]), total: 3, nextCursor: "20:0" });
    });
    const { result, rerender } = renderHook(
      ({ active }) =>
        useChatFind({ sessionId: "s_settle_page", api: onlineApi(searchMock), events: [], navRef, turnActive: active }),
      { initialProps: { active: true } },
    );
    act(() => {
      result.current.openFind();
      result.current.setQuery("paged");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await act(async () => {
      await result.current.jumpTo(sampleMatch(20, 0));
    });

    await act(async () => {
      void result.current.next();
    });
    await act(async () => {
      rerender({ active: false });
    });
    // The settle waits for the page in flight instead of sending the same cursor beside it.
    expect(searchMock.mock.calls.filter((c) => c[1].after === "20:0")).toHaveLength(1);

    await act(async () => {
      more.resolve(page("paged", [sampleMatch(30, 0)]));
    });
    expect(searchMock.mock.calls.filter((c) => c[1].after === "20:0")).toHaveLength(2);
    expect(result.current.matches.map((m) => m.seq)).toEqual([10, 20, 30, 40]);
    expect(result.current.total).toBe(4);
  });

  it("without an api the bar reports offline instead of staying on 'searching'", async () => {
    const { result } = renderHook(() =>
      useChatFind({ sessionId: "s_noapi", api: null, events: [], navRef }),
    );
    act(() => {
      result.current.openFind();
      result.current.setQuery("hello");
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.status).toBe("offline");
  });

  describe("backfill polling", () => {
    const backfillingPage = (q: string, matches: TranscriptSearchMatch[], backfilling: boolean) => ({
      ...page(q, matches),
      backfilling,
    });

    async function openWith(searchMock: ReturnType<typeof vi.fn>, sessionId: string, q: string) {
      const hook = renderHook(() =>
        useChatFind({ sessionId, api: onlineApi(searchMock), events: [], navRef }),
      );
      act(() => {
        hook.result.current.openFind();
        hook.result.current.setQuery(q);
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      return hook;
    }

    async function advance(ms: number) {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    }

    it("keeps polling at the capped delay for as long as the index backfills, then stops", async () => {
      let backfilling = true;
      const searchMock = vi.fn().mockImplementation(async (_s, req) =>
        backfillingPage(req.q, [sampleMatch(10, 0)], backfilling),
      );
      const { result } = await openWith(searchMock, "s_bf_long", "legacy");
      expect(searchMock).toHaveBeenCalledTimes(1);

      // Backoff 1s, 2s, 4s, 8s, then the 10s cap — well past five attempts.
      const delays = [1, 2, 4, 8].map((n) => n * BACKFILL_BASE_MS);
      for (let i = 0; i < 4; i++) delays.push(BACKFILL_MAX_MS);
      for (const [i, delay] of delays.entries()) {
        await advance(delay - 1);
        expect(searchMock).toHaveBeenCalledTimes(i + 1);
        await advance(1);
        expect(searchMock).toHaveBeenCalledTimes(i + 2);
      }
      expect(result.current.backfilling).toBe(true);

      backfilling = false;
      await advance(BACKFILL_MAX_MS);
      expect(searchMock).toHaveBeenCalledTimes(delays.length + 2);
      expect(result.current.backfilling).toBe(false);
      await advance(BACKFILL_MAX_MS * 3);
      expect(searchMock).toHaveBeenCalledTimes(delays.length + 2);
    });

    it("an empty result while backfilling backs off instead of polling every second", async () => {
      const searchMock = vi.fn().mockImplementation(async (_s, req) => backfillingPage(req.q, [], true));
      const { result } = await openWith(searchMock, "s_bf_empty", "legacy");
      expect(result.current.status).toBe("empty");

      await advance(BACKFILL_BASE_MS);
      expect(searchMock).toHaveBeenCalledTimes(2);
      await advance(BACKFILL_BASE_MS);
      expect(searchMock).toHaveBeenCalledTimes(2);
      await advance(BACKFILL_BASE_MS);
      expect(searchMock).toHaveBeenCalledTimes(3);
    });

    it("a new query restarts the backoff from the base delay", async () => {
      const searchMock = vi.fn().mockImplementation(async (_s, req) =>
        backfillingPage(req.q, [sampleMatch(10, 0)], true),
      );
      const { result } = await openWith(searchMock, "s_bf_reset", "legacy");
      await advance(BACKFILL_BASE_MS);
      await advance(2 * BACKFILL_BASE_MS);
      await advance(4 * BACKFILL_BASE_MS);
      expect(searchMock).toHaveBeenCalledTimes(4);

      act(() => {
        result.current.setQuery("modern");
      });
      await advance(250);
      expect(searchMock).toHaveBeenCalledTimes(5);
      await advance(BACKFILL_BASE_MS);
      expect(searchMock).toHaveBeenCalledTimes(6);
      expect(searchMock.mock.calls[5]![1].q).toBe("modern");
    });
  });

  describe("jumps into unloaded history", () => {
    const farNav = (): MessageNav => ({
      seqAnchor: vi.fn((s: number) => (s >= 100 ? `u:${s}` : undefined)),
      anchorWhere: vi.fn().mockReturnValue("in-view"),
      scrollToAnchor: vi.fn().mockResolvedValue("key"),
      visibleItemRange: vi.fn().mockReturnValue([0, 0]),
      rowFor: vi.fn(() => null),
      jumpTurn: vi.fn(),
      flashAnchor: vi.fn(),
    });
    const loaded: NormalizedEvent[] = [{ id: "e", sessionId: "s", provider: "claude", logSeq: 5000, kind: "user", ts: "" }];

    async function openWithMatch(onViewAround: (seq: number) => Promise<void>, nav: MessageNav) {
      const localNavRef = { current: nav };
      const searchMock = vi.fn().mockResolvedValue(page("legacy", [sampleMatch(200, 0)]));
      const hook = renderHook(() =>
        useChatFind({
          sessionId: "s_jump",
          api: onlineApi(searchMock),
          events: loaded,
          navRef: localNavRef,
          onViewAround,
        }),
      );
      act(() => {
        hook.result.current.openFind();
        hook.result.current.setQuery("legacy");
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(hook.result.current.current).toEqual({ seq: 200, occurrence: 0 });
      return { hook, localNavRef };
    }

    it("a quick second jump wins: the first, slower window load scrolls nothing", async () => {
      const loads = new Map<number, ReturnType<typeof deferred<void>>>();
      const onViewAround = vi.fn((seq: number) => {
        const d = deferred<void>();
        loads.set(seq, d);
        return d.promise;
      });
      const nav = farNav();
      const { hook } = await openWithMatch(onViewAround, nav);
      (nav.seqAnchor as ReturnType<typeof vi.fn>).mockImplementation((s: number) => (s >= 100 ? `u:${s}` : undefined));
      (nav.scrollToAnchor as ReturnType<typeof vi.fn>).mockClear();

      let j1!: Promise<void>;
      let j2!: Promise<void>;
      act(() => {
        j1 = hook.result.current.jumpTo(sampleMatch(10, 0));
        j2 = hook.result.current.jumpTo(sampleMatch(20, 0));
      });
      // Both windows "load": afterwards both seqs resolve to anchors.
      (nav.seqAnchor as ReturnType<typeof vi.fn>).mockImplementation((s: number) => `u:${s}`);
      await act(async () => {
        loads.get(20)!.resolve();
        await j2;
      });
      await act(async () => {
        loads.get(10)!.resolve();
        await j1;
      });

      expect(nav.scrollToAnchor).toHaveBeenCalledTimes(1);
      expect(nav.scrollToAnchor).toHaveBeenCalledWith("u:20", expect.anything());
      expect(hook.result.current.current).toEqual({ seq: 20, occurrence: 0 });
    });

    it("a failed window load keeps the previous match, reports it, and can be retried", async () => {
      const nav = farNav();
      // The second load succeeds and brings seq 10 into the window.
      const onViewAround = vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementation(async () => {
          (nav.seqAnchor as ReturnType<typeof vi.fn>).mockImplementation((s: number) => `u:${s}`);
        });
      const { hook } = await openWithMatch(onViewAround, nav);

      await act(async () => {
        await hook.result.current.jumpTo(sampleMatch(10, 0));
      });
      expect(hook.result.current.current).toEqual({ seq: 200, occurrence: 0 });
      expect(hook.result.current.jumpFailed).toBe(true);
      expect(hook.result.current.announcement).toBe("Could not load that match");

      await act(async () => {
        hook.result.current.retryJump();
      });
      expect(onViewAround).toHaveBeenCalledTimes(2);
      expect(hook.result.current.jumpFailed).toBe(false);
      expect(hook.result.current.current).toEqual({ seq: 10, occurrence: 0 });
    });

    it("a jump whose session switches mid-load commits nothing", async () => {
      const load = deferred<void>();
      const onViewAround = vi.fn(() => load.promise);
      const nav = farNav();
      const localNavRef = { current: nav };
      const searchMock = vi.fn().mockResolvedValue(page("legacy", [sampleMatch(200, 0)]));
      const hook = renderHook(
        ({ sid }) =>
          useChatFind({ sessionId: sid, api: onlineApi(searchMock), events: loaded, navRef: localNavRef, onViewAround }),
        { initialProps: { sid: "s_a" } },
      );
      act(() => {
        hook.result.current.openFind();
        hook.result.current.setQuery("legacy");
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      (nav.scrollToAnchor as ReturnType<typeof vi.fn>).mockClear();

      let j!: Promise<void>;
      act(() => {
        j = hook.result.current.jumpTo(sampleMatch(10, 0));
      });
      hook.rerender({ sid: "s_b" });
      (nav.seqAnchor as ReturnType<typeof vi.fn>).mockImplementation((s: number) => `u:${s}`);
      await act(async () => {
        load.resolve();
        await j;
      });
      expect(nav.scrollToAnchor).not.toHaveBeenCalled();
      expect(hook.result.current.current).toBeNull();
    });
  });
});
