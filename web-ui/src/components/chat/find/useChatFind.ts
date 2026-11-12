import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { NormalizedEvent, TranscriptSearchMatch, TranscriptSearchScope } from "@/api/types";
import { findTerms, countLocal } from "@/lib/findTerms";
import type { MessageNav } from "../messageNav";
import { useApiOnline } from "@/components/comments/useApiOnline";
import { anchorOccurrence } from "./anchorOccurrence";
import { groupAnchorMarks } from "./anchorMarks";

export type FindStatus = "idle" | "short" | "searching" | "ready" | "empty" | "error" | "offline";

export const TOTAL_CAPPED_LABEL = "1,000+";

/** While the server is still backfilling the index, the same query is re-run
 *  with exponential backoff from 1 s, capped at 10 s, for as long as it lasts. */
export const BACKFILL_BASE_MS = 1000;
export const BACKFILL_MAX_MS = 10000;

export interface UseChatFindParams {
  sessionId: string;
  api: ApiInstance | null;
  events: NormalizedEvent[];
  navRef: React.RefObject<MessageNav | null>;
  turnActive?: boolean;
  onViewAround?: (seq: number) => Promise<void>;
  onLoadEarlierTo?: (seq: number) => Promise<void>;
}

// Module-level memory for prefill/scope persistence per session, capped so a
// long-lived tab that visits many sessions does not grow it without bound.
const SESSION_MEMORY_CAP = 50;
const sessionMemory = new Map<string, { query: string; scope: TranscriptSearchScope }>();

function rememberFind(sessionId: string, entry: { query: string; scope: TranscriptSearchScope }): void {
  sessionMemory.delete(sessionId);
  sessionMemory.set(sessionId, entry);
  if (sessionMemory.size > SESSION_MEMORY_CAP) {
    const oldest = sessionMemory.keys().next().value;
    if (oldest !== undefined) sessionMemory.delete(oldest);
  }
}

/** `incoming` minus the matches `prev` already holds (same `seq:occurrence`). */
function appendNew(
  prev: TranscriptSearchMatch[],
  incoming: TranscriptSearchMatch[],
): TranscriptSearchMatch[] {
  const held = new Set(prev.map((m) => `${m.seq}:${m.occurrence}`));
  const added = incoming.filter((m) => !held.has(`${m.seq}:${m.occurrence}`));
  return added.length === 0 ? prev : [...prev, ...added];
}

function selectInitialMatch(
  matches: TranscriptSearchMatch[],
  queryChanged: boolean,
  prevCurrent: { seq: number; occurrence: number } | null,
  nav: MessageNav | null,
): TranscriptSearchMatch | null {
  if (!queryChanged && prevCurrent) {
    const existing = matches.find(
      (m) => m.seq === prevCurrent.seq && m.occurrence === prevCurrent.occurrence,
    );
    if (existing) return null;
  }
  if (nav) {
    const candidate = matches.find((m) => {
      const a = nav.seqAnchor(m.seq);
      return a ? nav.anchorWhere(a) !== "above" : false;
    });
    return candidate ?? matches[matches.length - 1]!;
  }
  return matches[0]!;
}

export function useChatFind({
  sessionId,
  api,
  events,
  navRef,
  turnActive = false,
  onViewAround,
  onLoadEarlierTo,
}: UseChatFindParams) {
  const online = useApiOnline(api ?? {});

  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [scope, setScope] = useState<TranscriptSearchScope>("messages");
  const [listOpen, setListOpen] = useState(false);
  const [status, setStatus] = useState<FindStatus>("idle");
  const [matches, setMatches] = useState<TranscriptSearchMatch[]>([]);
  const [total, setTotal] = useState(0);
  const [totalCapped, setTotalCapped] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [indexedThroughSeq, setIndexedThroughSeq] = useState<number | undefined>(undefined);
  const [turnCount, setTurnCount] = useState(0);
  const [backfilling, setBackfilling] = useState(false);
  const [current, setCurrent] = useState<{ seq: number; occurrence: number } | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [peekMatch, setPeekMatch] = useState<TranscriptSearchMatch | null>(null);
  const [currentStyleKey, setCurrentStyleKey] = useState<string | null>(null);
  const [fallbackRowAnchor, setFallbackRowAnchor] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /** The match whose window load failed; the bar offers a retry. */
  const [failedJump, setFailedJump] = useState<TranscriptSearchMatch | null>(null);

  // Debounced terms that reach FindMarksContext
  const [activeTerms, setActiveTerms] = useState<string[]>([]);

  // Refs for state accessible in callbacks without triggering effect re-runs
  const stateRef = useRef({
    open,
    query,
    scope,
    listOpen,
    matches,
    totalCapped,
    current,
  });
  stateRef.current = {
    open,
    query,
    scope,
    listOpen,
    matches,
    totalCapped,
    current,
  };

  const onlineRef = useRef(online);
  onlineRef.current = online;

  const eventsRef = useRef(events);
  eventsRef.current = events;

  /** Generation of the latest fresh search; bumped by every fresh search and by
   *  `close`, so responses and jumps that belong to an older one are dropped. */
  const reqIdRef = useRef(0);
  /** Bumped by every jump: only the latest jump may commit after its awaits. */
  const jumpSeqRef = useRef(0);
  /** True while a fresh search is in flight (settle and pagination wait for it). */
  const freshPendingRef = useRef(false);
  /** Token of the cursor (pagination/settle) request in flight: a second one
   *  would carry the same cursor and append the same page again. */
  const cursorPendingRef = useRef<object | null>(null);
  /** A settle that arrived while a cursor request was in flight; it runs once
   *  that request finishes. */
  const settleQueuedRef = useRef(false);
  const settleRef = useRef<() => void>(() => {});
  const abortCtrlRef = useRef<AbortController | null>(null);
  const backfillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backfillAttemptsRef = useRef(0);
  const peekMarksRef = useRef<HTMLElement[]>([]);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevTurnActiveRef = useRef(turnActive);
  /** The `q\0scope` of the last fresh (non-pagination/non-settle) search — lets
   *  a re-fetch of the SAME query (backfill retry, results-list toggle) keep the
   *  current match without re-scrolling. */
  const lastSearchKeyRef = useRef<string | null>(null);

  // 120ms debounce for active terms (reaches FindMarksContext)
  useEffect(() => {
    if (!open) {
      setActiveTerms([]);
      return;
    }
    const timer = setTimeout(() => {
      setActiveTerms(findTerms(query));
    }, 120);
    return () => clearTimeout(timer);
  }, [query, open]);

  // Jump to match implementation. `list` lets a caller that just received a
  // fresh page pass THAT page's matches instead of the `matches` state still
  // being committed this tick, so the first jump of a new query computes its
  // fallback ordinal from the new list, not the previous query's.
  const jumpTo = useCallback(
    async (
      match: TranscriptSearchMatch,
      list?: TranscriptSearchMatch[],
      opts?: { wrap?: string; totals?: { total: number; totalCapped: boolean } },
    ) => {
      if (!stateRef.current.open) return;
      const searchGen = reqIdRef.current;
      const jumpId = ++jumpSeqRef.current;
      // A closed find, a newer search or a newer jump owns the view now.
      const superseded = () =>
        !stateRef.current.open || reqIdRef.current !== searchGen || jumpSeqRef.current !== jumpId;
      const source = list ?? matches;
      const prevCurrent = stateRef.current.current;

      setCurrent({ seq: match.seq, occurrence: match.occurrence });
      setFallbackRowAnchor(null);
      setFailedJump(null);

      const matchIdx = source.findIndex(
        (m) => m.seq === match.seq && m.occurrence === match.occurrence,
      );
      const matchNumber = matchIdx !== -1 ? matchIdx + 1 : 1;
      // A fresh page passes its own totals: the state is still the previous query's this tick.
      const shownTotal = opts?.totals?.total ?? total;
      const totalStr = (opts?.totals?.totalCapped ?? totalCapped) ? "1,000+" : `${shownTotal}`;
      const who = match.kind === "user" ? "You" : "Agent";
      const snip = match.snippet?.map((s) => s.text).join("") || query;
      const prefix = opts?.wrap ? `${opts.wrap}. ` : "";
      setAnnouncement(`${prefix}Match ${matchNumber} of ${totalStr}, turn ${match.turnIndex}, ${who}: ${snip}`);

      const nav = navRef.current;
      let anchor = nav?.seqAnchor(match.seq);

      if (!anchor) {
        // Not in the loaded window: a row within 250 rows above it is prepended
        // by `loadEarlierTo`; anything farther (or newer than a detached window)
        // swaps the window via `viewAround`.
        const loaded = eventsRef.current;
        const oldestSeq = loaded.length > 0 ? (loaded[0]!.logSeq ?? match.seq) : match.seq;
        const rowDistance = oldestSeq - match.seq;

        try {
          if (rowDistance <= 250 && rowDistance > 0) {
            if (onLoadEarlierTo) await onLoadEarlierTo(match.seq);
          } else if (onViewAround) {
            await onViewAround(match.seq);
          }
        } catch {
          if (superseded()) return;
          // Keep the counter where it was and let the bar offer a retry.
          setCurrent(prevCurrent);
          setFailedJump(match);
          setAnnouncement("Could not load that match");
          return;
        }

        // The window owner commits the new rows before its promise resolves
        // (`flushSync` in `useChat`), so `MessageList` has already re-derived
        // `nav` and assigned `navRef`.
        if (superseded()) return;
        anchor = navRef.current?.seqAnchor(match.seq);
      }

      const activeNav = navRef.current;
      if (anchor && activeNav) {
        const located = anchorOccurrence(
          eventsRef.current,
          findTerms(stateRef.current.query),
          stateRef.current.scope,
          (seq) => activeNav.seqAnchor(seq),
          anchor,
          match,
        );
        let ordinal: number;
        let expectedMarks: number | undefined;
        if (located) {
          ordinal = located.ordinal;
          expectedMarks = located.expected;
        } else {
          // The match's document is not in the loaded events: fall back to its
          // position among the listed matches of the same anchor.
          const anchorMatches = source.filter((m) => activeNav.seqAnchor(m.seq) === anchor);
          ordinal = Math.max(
            0,
            anchorMatches.findIndex((m) => m.seq === match.seq && m.occurrence === match.occurrence),
          );
        }

        const key = await activeNav.scrollToAnchor(anchor, { ordinal, expectedMarks });
        if (superseded()) return;
        if (key) {
          setCurrentStyleKey(key);
          setFallbackRowAnchor(null);
        } else {
          setCurrentStyleKey(null);
          setFallbackRowAnchor(anchor);
        }
      }
    },
    [matches, total, totalCapped, query, navRef, onLoadEarlierTo, onViewAround],
  );

  const clearResults = useCallback((nextStatus: FindStatus, totalCount = 0) => {
    setStatus(nextStatus);
    setTotal(totalCount);
    setTotalCapped(false);
    setMatches([]);
    setCurrent(null);
    setCurrentStyleKey(null);
    setFallbackRowAnchor(null);
  }, []);

  // Execute server query
  const performSearch = useCallback(
    async (
      q: string,
      currentScope: TranscriptSearchScope,
      opts?: {
        cursor?: string;
        isSettle?: boolean;
        /** Settle: how many held matches end at `cursor` (the total's base). */
        heldCount?: number;
        isPagination?: boolean;
        withSnippets?: boolean;
        /** A re-run scheduled while the index backfills: keeps the backoff. */
        backfillRetry?: boolean;
      },
    ) => {
      const trimmed = q.trim();
      const terms = findTerms(q);
      const fresh = !opts?.isPagination && !opts?.isSettle;

      if (fresh) {
        // Every fresh search, including the local-only branches below,
        // supersedes the one in flight so its response cannot land afterwards.
        abortCtrlRef.current?.abort();
        abortCtrlRef.current = null;
        reqIdRef.current++;
        freshPendingRef.current = false;
        cursorPendingRef.current = null;
        settleQueuedRef.current = false;
        if (backfillTimerRef.current) clearTimeout(backfillTimerRef.current);
        backfillTimerRef.current = null;
        if (!opts?.backfillRetry) backfillAttemptsRef.current = 0;
      } else if (freshPendingRef.current) {
        // A settle or page cursor belongs to the previous result set; the fresh
        // search in flight replaces it anyway.
        return;
      } else if (cursorPendingRef.current) {
        if (opts?.isSettle) settleQueuedRef.current = true;
        return;
      }
      const curReqId = reqIdRef.current;

      if (!trimmed) {
        clearResults("idle", 0);
        setNextCursor(undefined);
        return;
      }

      if (!onlineRef.current || !api) {
        clearResults("offline", countLocal(eventsRef.current, terms, currentScope));
        return;
      }

      if ([...trimmed].length < 3) {
        clearResults("short", countLocal(eventsRef.current, terms, currentScope));
        return;
      }

      let queryChanged = false;
      if (fresh) {
        abortCtrlRef.current = new AbortController();
        freshPendingRef.current = true;
        // Remember which query this fresh search belongs to, so a later
        // re-fetch of the same query (backfill retry / results-list toggle) can
        // keep the current match instead of re-jumping to it.
        const searchKey = `${trimmed}\u0000${currentScope}`;
        queryChanged = lastSearchKeyRef.current !== searchKey;
        lastSearchKeyRef.current = searchKey;
        // A new query must not inherit the previous query's "indexing" label.
        if (queryChanged) setBackfilling(false);
        setStatus("searching");
      }
      const cursorToken = fresh ? null : {};
      if (cursorToken) cursorPendingRef.current = cursorToken;

      try {
        const fetchSnippets = opts?.withSnippets ?? stateRef.current.listOpen;
        const page = await api.searchTranscript(
          sessionId,
          {
            q: trimmed,
            scope: currentScope,
            after: opts?.cursor,
            limit: 1000,
            snippets: fetchSnippets,
          },
          abortCtrlRef.current?.signal,
        );

        if (curReqId !== reqIdRef.current) return;
        if (fresh) freshPendingRef.current = false;

        if (opts?.isPagination) {
          // Counting rule: pagination never changes N or totalCapped
          setMatches((prev) => appendNew(prev, page.matches));
          setNextCursor(page.nextCursor);
          return page;
        }

        if (opts?.isSettle) {
          // Settle rule: N = held + response.total, append matches, update nextCursor, reset newCount
          const heldCount = opts.heldCount ?? stateRef.current.matches.length;
          setMatches((prev) => appendNew(prev, page.matches));
          setTotal(heldCount + page.total);
          setNextCursor(page.nextCursor);
          setNewCount(0);
          return page;
        }

        // Fresh query
        setMatches(page.matches);
        setTotal(page.total);
        setTotalCapped(page.totalCapped);
        setNextCursor(page.nextCursor);
        setIndexedThroughSeq(page.indexedThroughSeq);
        setTurnCount(page.turnCount);
        setBackfilling(page.backfilling);
        setNewCount(0);

        if (page.matches.length === 0) {
          clearResults("empty", page.total);
        } else {
          setStatus("ready");
          const chosen = selectInitialMatch(
            page.matches,
            queryChanged,
            stateRef.current.current,
            navRef.current,
          );
          if (chosen) {
            void jumpTo(chosen, page.matches, { totals: { total: page.total, totalCapped: page.totalCapped } });
          }
        }

        // Announce count 500ms after typing stops
        if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
        announceTimerRef.current = setTimeout(() => {
          if (page.matches.length === 0) {
            // An empty page from a still-building index is not an answer.
            setAnnouncement(page.backfilling ? "Indexing, results may be incomplete" : "No results");
          } else {
            const countStr = page.totalCapped ? TOTAL_CAPPED_LABEL : `${page.total}`;
            setAnnouncement(`${countStr} results`);
          }
        }, 500);

        if (page.backfilling) {
          const attempt = backfillAttemptsRef.current++;
          const delay = Math.min(BACKFILL_BASE_MS * 2 ** attempt, BACKFILL_MAX_MS);
          backfillTimerRef.current = setTimeout(() => {
            backfillTimerRef.current = null;
            const st = stateRef.current;
            if (st.open && st.query === q && st.scope === currentScope) {
              void performSearchRef.current(q, currentScope, { backfillRetry: true });
            }
          }, delay);
        }

        return page;
      } catch (err: unknown) {
        if (curReqId !== reqIdRef.current) return;
        if (fresh) freshPendingRef.current = false;
        if ((err as Error)?.name === "AbortError") return;

        clearResults("error", countLocal(eventsRef.current, terms, currentScope));
      } finally {
        if (cursorToken && cursorPendingRef.current === cursorToken) {
          cursorPendingRef.current = null;
          if (settleQueuedRef.current) {
            settleQueuedRef.current = false;
            settleRef.current();
          }
        }
      }
    },
    [api, sessionId, jumpTo, navRef, clearResults],
  );

  // 250ms debounce for server requests when query or scope changes. `performSearch`
  // changes identity with every response (its `jumpTo` closure captures
  // `matches`/`total`), so it must be read through a ref — otherwise the effect
  // re-runs on each result and fires another request.
  const performSearchRef = useRef(performSearch);
  performSearchRef.current = performSearch;

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void performSearchRef.current(query, scope);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, scope, open, online]);

  // Estimate new streaming matches
  useEffect(() => {
    if (!open || indexedThroughSeq == null || activeTerms.length === 0) {
      setNewCount(0);
      return;
    }
    const newEvents = events.filter((e) => (e.logSeq ?? 0) > indexedThroughSeq);
    if (newEvents.length === 0) {
      setNewCount(0);
      return;
    }
    const est = countLocal(newEvents, activeTerms, scope);
    setNewCount(est);
  }, [events, indexedThroughSeq, activeTerms, scope, open]);

  // Settle rule: when turnActive flips from true to false
  const settle = useCallback(() => {
    const { open: isOpen, totalCapped: isCapped, matches: heldMatches, query: q, scope: curScope } =
      stateRef.current;
    if (!isOpen || isCapped) return;
    if (heldMatches.length > 0 && !freshPendingRef.current) {
      const last = heldMatches[heldMatches.length - 1]!;
      void performSearchRef.current(q, curScope, {
        cursor: `${last.seq}:${last.occurrence}`,
        isSettle: true,
        heldCount: heldMatches.length,
      });
    } else {
      void performSearchRef.current(q, curScope);
    }
  }, []);
  settleRef.current = settle;

  useEffect(() => {
    const wasActive = prevTurnActiveRef.current;
    prevTurnActiveRef.current = turnActive;
    if (wasActive && !turnActive && open) settle();
  }, [turnActive, open, settle]);

  const openFind = useCallback(
    (seed?: string) => {
      setOpen(true);

      let initialQuery = "";
      let initialScope: TranscriptSearchScope = "messages";

      if (seed != null) {
        initialQuery = seed;
      } else {
        const remembered = sessionMemory.get(sessionId);
        if (remembered) {
          initialQuery = remembered.query;
          initialScope = remembered.scope;
        }
      }

      setQueryState(initialQuery);
      setScope(initialScope);
      rememberFind(sessionId, { query: initialQuery, scope: initialScope });
    },
    [sessionId],
  );

  const close = useCallback(() => {
    reqIdRef.current++;
    jumpSeqRef.current++;
    freshPendingRef.current = false;
    cursorPendingRef.current = null;
    settleQueuedRef.current = false;
    abortCtrlRef.current?.abort();
    if (backfillTimerRef.current) clearTimeout(backfillTimerRef.current);
    if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    setOpen(false);
    setListOpen(false);
    setPeekMatch(null);
    setCurrent(null);
    setCurrentStyleKey(null);
    setFallbackRowAnchor(null);
    setFailedJump(null);
    setMatches([]);
    setTotal(0);
    setTotalCapped(false);
    setNextCursor(undefined);
    setNewCount(0);
    setStatus("idle");
    lastSearchKeyRef.current = null;
  }, []);

  // Session-change & unmount cleanup. `ChatPane` is not re-keyed per
  // session, so the hook must reset itself when `sessionId` changes and tear
  // down timers/requests on unmount.
  useEffect(() => {
    close();
    setQueryState("");
    setIndexedThroughSeq(undefined);
    setTurnCount(0);
    setBackfilling(false);
    setActiveTerms([]);
    // One teardown path: `close()` bumps the request id (so a response that
    // lands after unmount/session change is dropped), aborts the request and
    // clears both timers.
    return () => {
      close();
    };
  }, [sessionId, close]);

  // Peek ring on an on-screen match
  useEffect(() => {
    const clearPeek = () => {
      if (peekMarksRef.current.length > 0) {
        peekMarksRef.current.forEach((el) => el.removeAttribute("data-find-peek"));
        peekMarksRef.current = [];
      }
    };

    if (!peekMatch) {
      clearPeek();
      return;
    }
    const nav = navRef.current;
    const anchor = nav?.seqAnchor(peekMatch.seq);
    if (!nav || !anchor) return;
    const located = anchorOccurrence(
      eventsRef.current,
      findTerms(stateRef.current.query),
      stateRef.current.scope,
      (seq) => nav.seqAnchor(seq),
      anchor,
      peekMatch,
    );
    const anchorMatches = matches.filter((m) => nav.seqAnchor(m.seq) === anchor);
    const ordinal =
      located?.ordinal ??
      anchorMatches.findIndex((m) => m.seq === peekMatch.seq && m.occurrence === peekMatch.occurrence);
    const row = nav.rowFor(anchor);
    const { distinctKeys, keyMarks } = row
      ? groupAnchorMarks(row, anchor)
      : { distinctKeys: [], keyMarks: new Map<string, HTMLElement[]>() };
    // Same rule as the jump: a row whose marks do not line up with the indexed
    // occurrences gets no ring rather than one on the wrong mark.
    const countsAgree = !located || located.expected === distinctKeys.length;
    const targetKey = countsAgree ? distinctKeys[ordinal !== -1 ? ordinal : 0] : undefined;
    if (targetKey) {
      clearPeek();
      const matched = keyMarks.get(targetKey) ?? [];
      matched.forEach((m) => m.setAttribute("data-find-peek", "true"));
      peekMarksRef.current = matched;
    }
    return () => {
      clearPeek();
    };
  }, [peekMatch, matches, navRef]);

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      rememberFind(sessionId, { query: q, scope });
    },
    [sessionId, scope],
  );

  const toggleScope = useCallback(() => {
    setScope((prev) => {
      const next: TranscriptSearchScope = prev === "messages" ? "all" : "messages";
      rememberFind(sessionId, { query, scope: next });
      return next;
    });
  }, [sessionId, query]);

  // The search runs outside the setState updater (updaters must stay pure).
  const toggleList = useCallback(() => {
    setListOpen((prev) => !prev);
    if (!listOpen && [...query.trim()].length >= 3) {
      performSearch(query, scope, { withSnippets: true });
    }
  }, [listOpen, query, scope, performSearch]);

  const next = useCallback(async () => {
    if (matches.length === 0) return;

    const curIdx = current
      ? matches.findIndex((m) => m.seq === current.seq && m.occurrence === current.occurrence)
      : -1;

    const nextIdx = curIdx + 1;

    if (nextIdx >= matches.length) {
      // The page that would follow is already being fetched.
      if (cursorPendingRef.current) return;
      if (nextCursor) {
        // Keyset pagination: load more matches first
        const page = await performSearch(query, scope, { cursor: nextCursor, isPagination: true });
        if (page && page.matches.length > 0) {
          // The appended page isn't in `matches` state yet — hand `jumpTo` the
          // combined list so the ordinal is right.
          jumpTo(page.matches[0]!, [...matches, ...page.matches]);
          return;
        }
      }
      // Wrap to first
      jumpTo(matches[0]!, matches, { wrap: "Wrapped to first" });
    } else {
      jumpTo(matches[nextIdx]!);
    }
  }, [matches, current, nextCursor, query, scope, performSearch, jumpTo]);

  const prev = useCallback(async () => {
    if (matches.length === 0) return;

    const curIdx = current
      ? matches.findIndex((m) => m.seq === current.seq && m.occurrence === current.occurrence)
      : -1;

    if (curIdx <= 0) {
      // Wrap to last
      jumpTo(matches[matches.length - 1]!, matches, { wrap: "Wrapped to last" });
    } else {
      jumpTo(matches[curIdx - 1]!);
    }
  }, [matches, current, jumpTo]);

  const retry = useCallback(() => {
    performSearch(query, scope);
  }, [performSearch, query, scope]);

  const retryJump = useCallback(() => {
    if (failedJump) void jumpTo(failedJump);
  }, [failedJump, jumpTo]);

  const currentIsStreaming =
    current != null && indexedThroughSeq != null && current.seq > indexedThroughSeq;

  return {
    open,
    query,
    scope,
    listOpen,
    status,
    matches,
    total,
    totalCapped,
    turnCount,
    backfilling,
    current,
    currentIsStreaming,
    newCount,
    peekMatch,
    currentStyleKey,
    fallbackRowAnchor,
    announcement,
    jumpFailed: failedJump != null,
    terms: activeTerms,
    openFind,
    close,
    setQuery,
    toggleScope,
    toggleList,
    next,
    prev,
    jumpTo,
    retry,
    retryJump,
    setPeekMatch,
  };
}
