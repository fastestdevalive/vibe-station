import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTurnOutline, type TurnNode } from "./buildTurnOutline";
import type { BeatWindowItems, OutlineSource } from "./outlineSource";

/** A marked unloaded turn must rest this long before its window is fetched for steps. */
export const BEAT_DWELL_MS = 300;
/** Fetched windows kept for steps; the oldest is dropped first. */
export const BEAT_WINDOW_LRU = 8;

/** The outline nodes of one fetched window, by the first seq of each turn. */
export function buildBeatWindow(w: BeatWindowItems): Map<number, TurnNode> {
  const nodes = buildTurnOutline(w.items, { turnsBefore: w.turnsBefore });
  const byAnchor = new Map(nodes.map((n) => [n.anchor, n]));
  const bySeq = new Map<number, TurnNode>();
  for (const [seq, anchor] of w.seqIndex) {
    const node = byAnchor.get(anchor);
    if (node) bySeq.set(seq, node);
  }
  return bySeq;
}

export interface BeatWindows {
  /** The node (with steps) of the unloaded turn starting at `seq`, when a fetched window holds it. */
  nodeAt: (seq: number) => TurnNode | undefined;
  /** Every fetched turn with steps, as `[seq, node]`. */
  entries: () => [number, TurnNode][];
  /** The marked unloaded turn changed (`null`: none); restarts the dwell and aborts a request in flight. `dwellMs` defaults to BEAT_DWELL_MS. */
  request: (seq: number | null, dwellMs?: number) => void;
  /** The seq whose window is being fetched right now. */
  pendingSeq: number | null;
  /** Bumped when a window lands. */
  version: number;
}

/**
 * Steps of unloaded turns, fetched on demand: a marked unloaded turn that rests
 * BEAT_DWELL_MS gets its around-window fetched for beats only. Never touches
 * the chat's event window (that is `useChat`'s).
 */
export function useBeatWindows(
  fetchWindow: OutlineSource["fetchWindow"] | undefined,
  revision?: string,
): BeatWindows {
  const windowsRef = useRef(new Map<number, Map<number, TurnNode>>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fetchRef = useRef(fetchWindow);
  const [version, setVersion] = useState(0);
  const [pendingSeq, setPendingSeq] = useState<number | null>(null);

  useEffect(() => {
    fetchRef.current = fetchWindow;
  });

  const nodeAt = useCallback((seq: number): TurnNode | undefined => {
    for (const w of windowsRef.current.values()) {
      const node = w.get(seq);
      if (node) return node;
    }
    return undefined;
  }, []);

  const entries = useCallback((): [number, TurnNode][] => {
    const out: [number, TurnNode][] = [];
    for (const w of windowsRef.current.values()) for (const e of w) out.push(e);
    return out;
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setPendingSeq(null);
  }, []);

  const request = useCallback(
    (seq: number | null, dwellMs = BEAT_DWELL_MS) => {
      cancel();
      if (seq == null || !fetchRef.current || nodeAt(seq)) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const fetcher = fetchRef.current;
        if (!fetcher) return;
        const ac = new AbortController();
        abortRef.current = ac;
        setPendingSeq(seq);
        const onOk = (w: BeatWindowItems) => {
          if (ac.signal.aborted) return;
          const windows = windowsRef.current;
          windows.set(seq, buildBeatWindow(w));
          while (windows.size > BEAT_WINDOW_LRU) {
            const oldest = windows.keys().next().value;
            if (oldest === undefined) break;
            windows.delete(oldest);
          }
          abortRef.current = null;
          setPendingSeq(null);
          setVersion((v) => v + 1);
        };
        const onErr = () => {
          if (ac.signal.aborted) return;
          abortRef.current = null;
          setPendingSeq(null);
        };
        fetcher(seq, ac.signal).then(onOk, onErr);
      }, dwellMs);
    },
    [cancel, nodeAt],
  );

  // A new fetcher means another session, a new summary revision a rewritten chat (fork): drop every window and any request in flight.
  useEffect(() => {
    const windows = windowsRef.current;
    return () => {
      cancel();
      windows.clear();
      setVersion((v) => v + 1);
    };
  }, [fetchWindow, revision, cancel]);

  return useMemo(
    () => ({ nodeAt, entries, request, pendingSeq, version }),
    [nodeAt, entries, request, pendingSeq, version],
  );
}
