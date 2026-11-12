import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ApiInstance } from "@/api";
import type { TranscriptOutlineTurn, TranscriptOutlineWindow } from "@/api/types";

/** Turns per outline window request. */
export const OUTLINE_WINDOW_TURNS = 40;

/** Per-turn outline rows by index, fetched on demand; the single owner of window fetching. */
export interface OutlineWindows {
  /** The cached turn at `index`, if its window has landed. A deliberate lookup: it refreshes the window's recency. */
  turnAt: (index: number) => TranscriptOutlineTurn | undefined;
  /** Like `turnAt` but never reorders the cache: for bulk reads (the base build visits every index on each rebuild). */
  peek: (index: number) => TranscriptOutlineTurn | undefined;
  /** The marked unloaded index (`null`: none): 300 ms dwell, then fetch its window; aborts a stale request. */
  request: (index: number | null) => void;
  /** Fetch the window now (no dwell) and resolve the turn at `index`; null on failure/abort. */
  fetchNow: (index: number) => Promise<TranscriptOutlineTurn | null>;
  /** Bumped when a window lands or the cache is dropped. */
  version: number;
}

/** Windows kept per (session, revision): 64 x 40 turns. */
const WINDOW_LRU = 64;
const DWELL_MS = 300;

type WindowFetch = (from: number, signal: AbortSignal) => Promise<TranscriptOutlineWindow>;

interface WindowSnapshot {
  version: number;
}

interface Inflight {
  start: number;
  kind: "dwell" | "now";
  controller: AbortController;
  promise: Promise<readonly TranscriptOutlineTurn[] | null>;
}

// Versions are unique across stores, so a memo keyed on `version` never mistakes a new cache for an old one.
let versionCounter = 0;

interface OutlineWindowStoreOptions {
  /** Null when there is no session: nothing is fetched. */
  fetchWindow: WindowFetch | null;
  /** The summary revision the windows must match; null while the summary is not ready (nothing is fetched). */
  revision: string | null;
  /** A ready window reported another revision: the owner refetches the summary. */
  onRevisionMismatch: () => void;
}

/**
 * One (session, revision) cache of outline windows. A window starts at `floor(index / 40) * 40`; a window
 * shorter than 40 turns is partial (an index at or past its end is a miss). A not-ready window or one from
 * another revision is never stored.
 */
function createOutlineWindowStore(opts: OutlineWindowStoreOptions) {
  const { fetchWindow, revision, onRevisionMismatch } = opts;
  const canFetch = fetchWindow != null && revision != null;
  const windows = new Map<number, readonly TranscriptOutlineTurn[]>();
  const listeners = new Set<() => void>();
  let snapshot: WindowSnapshot = { version: ++versionCounter };
  let inflight: Inflight | null = null;
  // A dwell is "waiting" once its timer fired behind an in-flight jump fetch, which it must never abort.
  let dwell: { start: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

  function publish(next: WindowSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function startOf(index: number): number {
    return Math.floor(index / OUTLINE_WINDOW_TURNS) * OUTLINE_WINDOW_TURNS;
  }

  function peek(index: number): TranscriptOutlineTurn | undefined {
    const start = startOf(index);
    return windows.get(start)?.[index - start];
  }

  function turnAt(index: number): TranscriptOutlineTurn | undefined {
    const turn = peek(index);
    if (turn === undefined) return undefined;
    const start = startOf(index);
    const turns = windows.get(start)!;
    windows.delete(start);
    windows.set(start, turns);
    return turn;
  }

  function store(start: number, turns: readonly TranscriptOutlineTurn[]): void {
    windows.delete(start);
    windows.set(start, turns);
    if (windows.size > WINDOW_LRU) {
      const oldest = windows.keys().next();
      if (!oldest.done) windows.delete(oldest.value);
    }
    publish({ version: ++versionCounter });
  }

  async function load(start: number, controller: AbortController): Promise<readonly TranscriptOutlineTurn[] | null> {
    if (!fetchWindow || revision == null) return null;
    let res: TranscriptOutlineWindow;
    try {
      res = await fetchWindow(start, controller.signal);
    } catch {
      return null;
    }
    if (controller.signal.aborted || !res.ready) return null;
    if (res.revision !== revision) {
      onRevisionMismatch();
      return null;
    }
    store(start, res.turns);
    return res.turns;
  }

  function startFetch(start: number, kind: Inflight["kind"]): Promise<readonly TranscriptOutlineTurn[] | null> {
    if (inflight?.start === start) {
      // A jump that joins a dwelling fetch makes it a jump fetch: a later dwell must not abort it.
      if (kind === "now") inflight.kind = "now";
      return inflight.promise;
    }
    abortInflight();
    const controller = new AbortController();
    const entry: Inflight = { start, kind, controller, promise: Promise.resolve(null) };
    inflight = entry;
    entry.promise = load(start, controller).then((turns) => {
      if (inflight === entry) inflight = null;
      return turns;
    });
    return entry.promise;
  }

  function cancelDwell(): void {
    if (dwell?.timer != null) clearTimeout(dwell.timer);
    dwell = null;
  }

  /** The dwell's timer fired: fetch now, or (behind a jump fetch, which is never aborted) once that settles. */
  function fireDwell(entry: NonNullable<typeof dwell>, index: number): void {
    entry.timer = null;
    const fetchIfWanted = () => {
      if (dwell !== entry) return;
      dwell = null;
      if (peek(index) === undefined) void startFetch(entry.start, "dwell");
    };
    if (inflight?.kind === "now") void inflight.promise.then(fetchIfWanted);
    else fetchIfWanted();
  }

  /** Aborts the in-flight fetch (if any) and forgets it, so a later request for the same window starts afresh. */
  function abortInflight(): void {
    if (!inflight) return;
    inflight.controller.abort();
    inflight = null;
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot(): WindowSnapshot {
      return snapshot;
    },

    turnAt,
    peek,

    request(index: number | null): void {
      if (!canFetch) return;
      if (index === null) {
        cancelDwell();
        return;
      }
      if (turnAt(index) !== undefined) {
        cancelDwell();
        if (inflight?.kind === "dwell") abortInflight();
        return;
      }
      const start = startOf(index);
      if (dwell?.start === start || inflight?.start === start) return;
      cancelDwell();
      const entry: NonNullable<typeof dwell> = { start, timer: null };
      entry.timer = setTimeout(() => fireDwell(entry, index), DWELL_MS);
      dwell = entry;
    },

    async fetchNow(index: number): Promise<TranscriptOutlineTurn | null> {
      cancelDwell();
      const cached = turnAt(index);
      if (cached || !canFetch) return cached ?? null;
      const start = startOf(index);
      const turns = await startFetch(start, "now");
      return turns?.[index - start] ?? null;
    },

    /** Aborts an in-flight fetch and any pending dwell; the store stays usable (a StrictMode remount reuses it). */
    dispose(): void {
      cancelDwell();
      abortInflight();
    },
  };
}

/**
 * The window cache for one (session, revision): dropped when either changes. `revision` is the summary's
 * revision once it is ready, else null.
 */
export function useOutlineWindows(
  api: ApiInstance,
  sessionId: string | null,
  revision: string | null,
  onRevisionMismatch: () => void,
): OutlineWindows {
  const mismatchRef = useRef(onRevisionMismatch);
  useEffect(() => {
    mismatchRef.current = onRevisionMismatch;
  }, [onRevisionMismatch]);

  const store = useMemo(
    () =>
      createOutlineWindowStore({
        fetchWindow:
          sessionId == null
            ? null
            : (from, signal) => api.getTranscriptOutlineWindow(sessionId, { from, limit: OUTLINE_WINDOW_TURNS }, signal),
        revision,
        onRevisionMismatch: () => mismatchRef.current(),
      }),
    [api, sessionId, revision],
  );
  useEffect(() => () => store.dispose(), [store]);

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return useMemo(
    () => ({
      turnAt: store.turnAt,
      peek: store.peek,
      request: store.request,
      fetchNow: store.fetchNow,
      version: snap.version,
    }),
    [store, snap],
  );
}
