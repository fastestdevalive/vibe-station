import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useMessageNav, type MessageNav } from "./messageNav";
import type { RowUiStore } from "./rowUiState";
import {
  buildTurnOutline,
  buildUnloadedNodes,
  createOutlineCache,
  mergeTurnOutline,
  nodeShapeSig,
  worthShowingChain,
  type MergeResult,
  type OutlineCache,
  type TurnNode,
} from "./outline/buildTurnOutline";
import { TurnChain } from "./outline/TurnChain";
import type { OutlineSource } from "./outline/outlineSource";
import { useBeatWindows } from "./outline/useBeatWindows";
import type { RenderItem } from "./MessageList";

/** Events per page when the outline loads earlier turns: several turns per load. */
export const OUTLINE_LOAD_EARLIER_LIMIT = 200;
/** Live trimming stays held this long after the outline loads earlier turns. */
export const OUTLINE_TRIM_HOLD_MS = 10_000;

export interface UseChatOutlineArgs {
  items: RenderItem[];
  seqIndex: Map<number, string>;
  virtualizer: Virtualizer<HTMLElement, Element>;
  virtualized: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  rowUiStore: RowUiStore;
  /** Ref where MessageNav is exposed for outer components (find bar, Alt+arrow). */
  navRef?: MutableRefObject<MessageNav | null>;
  activeTurnId?: string;
  turnsBefore?: number | null;
  hasMore?: boolean;
  /** A load of earlier turns is in flight. */
  loadingEarlier?: boolean;
  detached?: boolean;
  /** Prepend the previous page of `limit` events, keeping the chat's scroll anchor. */
  onLoadEarlier?: (limit?: number) => void | Promise<void>;
  /** Element where the chain is portaled. */
  overlayHost?: HTMLElement | null;
  /**
   * True while the outline list is open and for OUTLINE_TRIM_HOLD_MS after it
   * loads earlier turns: the pages it loaded must survive live trimming.
   */
  onHoldTrim?: (hold: boolean) => void;
  hitTurns?: Set<string>;
  currentTurn?: string;
  peekTurn?: string;
  currentSeq?: number;
  /** The whole-chat summary and the window loaders; absent or not ready: the outline covers the loaded window only. */
  source?: OutlineSource;
}

/** The turn index of an unloaded row (`n:<index>`), or null when `key` is not one of `nodes`' unloaded rows. */
function unloadedIndexOf(key: string, nodes: readonly TurnNode[]): number | null {
  if (!key.startsWith("n:")) return null;
  const i = Number(key.slice(2));
  return Number.isInteger(i) && nodes[i]?.key === key && nodes[i].unloaded ? i : null;
}

/**
 * The unloaded turn a jump target belongs to: the turn row itself (`n:<index>`) or a step (beat) row
 * of an unloaded turn, whose anchor is not in the loaded list until the turn's window is shown.
 */
/** How long the "could not load" notice stays up. */
const JUMP_FAILED_MS = 4000;

/** Loads the turn at `idx` and moves the window around it; `null` when either step fails. */
export async function loadUnloadedTurn(
  src: OutlineSource,
  idx: number,
): Promise<{ seq: number } | null> {
  try {
    const turn = src.windows.turnAt(idx) ?? (await src.windows.fetchNow(idx));
    if (!turn) return null;
    await src.viewAround(turn.seq);
    return turn;
  } catch {
    return null;
  }
}

export function unloadedOwnerOf(anchor: string, nodes: readonly TurnNode[]): number | null {
  const own = unloadedIndexOf(anchor, nodes);
  if (own != null) return own;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.unloaded && n.beats.some((b) => b.anchor === anchor)) return n.index;
  }
  return null;
}

/**
 * The chat's outline wiring: the MessageNav the rest of the pane navigates
 * with, the per-pane turn-outline cache, and the turn chain portaled into
 * `overlayHost`. Returns the portal element (or null), so the list component
 * only renders it.
 */
export function useChatOutline({
  items,
  seqIndex,
  virtualizer,
  virtualized,
  listRef,
  rowUiStore,
  navRef,
  activeTurnId,
  turnsBefore = null,
  hasMore = false,
  loadingEarlier = false,
  detached = false,
  onLoadEarlier,
  overlayHost,
  onHoldTrim,
  hitTurns,
  currentTurn,
  peekTurn,
  currentSeq,
  source,
}: UseChatOutlineArgs): ReactNode {
  const nav = useMessageNav({ items, seqIndex, virtualizer, virtualized, listRef, rowUiStore });

  // Assigned during render (the same "latest value" pattern as `itemsRef` in
  // MessageList) so a caller that awaits a window swap and then reads
  // `navRef.current` sees the nav derived from the just-committed rows.
  if (navRef) navRef.current = nav;

  const cacheRef = useRef<OutlineCache | null>(null);
  if (!cacheRef.current) cacheRef.current = createOutlineCache();
  const loadedNodes = useMemo(
    () => buildTurnOutline(items, { activeTurnId, turnsBefore }, cacheRef.current!),
    [items, activeTurnId, turnsBefore],
  );

  // Whole-chat mode only once the summary is ready and the window's position is known.
  const summary = source?.summary;
  const windows = source?.windows;
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const windowVersion = windows?.version ?? 0;
  const whole = summary?.status === "ready" && turnsBefore != null;

  // Unloaded rows of the whole chat; a window landing rebuilds only the rows it changes.
  // The previous rows are always offered: a row is reused only while its window turn and counts are unchanged.
  const baseRef = useRef<TurnNode[] | undefined>(undefined);
  const base = useMemo(() => {
    if (!whole || !summary) return null;
    // `peek`: rebuilding visits every index and must not reorder the window cache's recency.
    const nodes = buildUnloadedNodes(summary, (i) => windowsRef.current?.peek(i), activeTurnId, baseRef.current);
    baseRef.current = nodes;
    return nodes;
  }, [whole, summary, windowVersion, activeTurnId]);

  // Steps of unloaded turns, fetched on demand, by the index of their turn.
  const beatWindows = useBeatWindows(whole ? source?.fetchWindow : undefined, summary?.revision);
  const stepsByIndex = useMemo(() => {
    const byIndex = new Map<number, TurnNode>();
    if (!base) return byIndex;
    const indexBySeq = new Map<number, number>();
    for (const n of base) if (n.seq != null) indexBySeq.set(n.seq, n.index);
    for (const [seq, node] of beatWindows.entries()) {
      const idx = indexBySeq.get(seq);
      if (idx != null) byIndex.set(idx, node);
    }
    return byIndex;
  }, [base, beatWindows.version, beatWindows.entries]);

  const mergeRef = useRef<MergeResult | undefined>(undefined);
  const merged = useMemo(() => {
    if (!base || turnsBefore == null) return null;
    const result = mergeTurnOutline(
      base,
      loadedNodes,
      { turnsBefore, seqAnchor: (seq) => nav.seqAnchor(seq), steps: stepsByIndex },
      mergeRef.current,
    );
    mergeRef.current = result;
    return result;
    // `nav` is rebuilt whenever `items` or `seqIndex` change, so it stands for the mutated seq index too.
  }, [base, loadedNodes, turnsBefore, nav, stepsByIndex]);
  const nodes = merged?.nodes ?? loadedNodes;

  // A loaded turn that does not sit where its cached window turn says: the summary is stale; refetch it once per revision.
  const mismatch = merged?.mismatch === true;
  const summaryRevision = summary?.revision;
  const onMismatch = source?.onMismatch;
  const reportedRevisionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!mismatch || summaryRevision == null || reportedRevisionRef.current === summaryRevision) return;
    reportedRevisionRef.current = summaryRevision;
    onMismatch?.();
  }, [mismatch, summaryRevision, onMismatch]);

  // What the chain's geometry reads of `nodes`: it recomputes only when this token changes, so a streaming delta
  // that leaves the turn count, beat shape and flags alone (the common case) costs it nothing.
  const loadedShape = useMemo(() => loadedNodes.map(nodeShapeSig).join("\n"), [loadedNodes]);
  const shape = useMemo(
    () => ({}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the inputs ARE the token: a new object per change of any
    [base, stepsByIndex, turnsBefore, loadedShape],
  );

  // Read by the marked-turn handler and the jump, which the chain calls from its own effects.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // The unloaded turn the open list marks: its window is fetched, then its steps.
  const [markedIndex, setMarkedIndex] = useState<number | null>(null);
  const markedSeq = markedIndex != null ? windows?.peek(markedIndex)?.seq : undefined;
  // Also re-run when the window store changes (a revision refetch drops the cache): a still-marked turn asks again.
  useEffect(() => {
    const w = windowsRef.current;
    if (!w) return;
    w.request(markedIndex != null && !w.turnAt(markedIndex) ? markedIndex : null);
  }, [markedIndex, windowVersion]);
  useEffect(() => () => windowsRef.current?.request(null), []);
  const requestSteps = beatWindows.request;
  useEffect(() => {
    requestSteps(markedSeq ?? null, 0);
  }, [markedIndex, markedSeq, requestSteps]);

  const handleMarkedTurn = useCallback((key: string | null) => {
    setMarkedIndex(key != null ? unloadedIndexOf(key, nodesRef.current) : null);
  }, []);
  const pendingStepsKey =
    markedIndex != null && markedSeq != null && beatWindows.pendingSeq === markedSeq ? `n:${markedIndex}` : undefined;

  // A release on an unloaded row loads its window first. The nav is read through a ref
  // because a window swap commits a new one: the render that committed it holds the new nav.
  const latestNavRef = useRef(nav);
  latestNavRef.current = nav;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const jumpSeqRef = useRef(0);
  // A jump to an unloaded turn that could not load (daemon restart, 5xx): said out loud, never a silent no-op.
  const [jumpFailed, setJumpFailed] = useState(false);
  useEffect(() => {
    if (!jumpFailed) return;
    const timer = setTimeout(() => setJumpFailed(false), JUMP_FAILED_MS);
    return () => clearTimeout(timer);
  }, [jumpFailed]);
  const handleJump = useCallback((anchor: string) => {
    const jumpId = ++jumpSeqRef.current;
    const scroll = (target: string, fallback?: () => string | undefined) => {
      const n = latestNavRef.current;
      // A step anchor missing from the loaded window falls back to the turn's row.
      const dest = n.hasAnchor?.(target) === false && fallback ? (fallback() ?? target) : target;
      void n.scrollToAnchor(dest, { align: "center" }).then(() => n.flashAnchor(dest));
    };
    const src = sourceRef.current;
    const idx = src ? unloadedOwnerOf(anchor, nodesRef.current) : null;
    if (idx == null || !src) {
      scroll(anchor);
      return;
    }
    setJumpFailed(false);
    void (async () => {
      const turn = await loadUnloadedTurn(src, idx);
      if (jumpId !== jumpSeqRef.current) return;
      if (!turn) {
        setJumpFailed(true);
        return;
      }
      // A step row scrolls to its own anchor; a turn row to the turn's first row.
      const target = anchor.startsWith("n:") ? latestNavRef.current.seqAnchor(turn.seq) : anchor;
      if (target) scroll(target, () => latestNavRef.current.seqAnchor(turn.seq));
    })();
  }, []);

  // The scroller is the list's parent element: read it after mount, never
  // during render (a ref read in render is not a value React can react to).
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = listRef.current?.parentElement ?? null;
    setScrollElement((prev) => (prev === el ? prev : el));
  }, [items, virtualized, listRef]);

  const [listOpen, setListOpen] = useState(false);
  const [loadSeq, setLoadSeq] = useState(0);
  const [expiredSeq, setExpiredSeq] = useState(0);
  useEffect(() => {
    if (loadSeq === 0) return;
    const timer = setTimeout(() => setExpiredSeq(loadSeq), OUTLINE_TRIM_HOLD_MS);
    return () => clearTimeout(timer);
  }, [loadSeq]);
  const holdTrim = listOpen || loadSeq > expiredSeq;
  const onHoldTrimRef = useRef(onHoldTrim);
  useEffect(() => {
    onHoldTrimRef.current = onHoldTrim;
  });
  useEffect(() => {
    onHoldTrimRef.current?.(holdTrim);
  }, [holdTrim]);
  useEffect(() => () => onHoldTrimRef.current?.(false), []);

  if (!overlayHost || !worthShowingChain(nodes)) return null;
  return createPortal(
    <>
    <TurnChain
      nodes={nodes}
      shape={shape}
      items={items}
      hasMore={whole ? false : hasMore}
      loadingEarlier={loadingEarlier}
      totalTurns={whole ? nodes.length : detached ? null : turnsBefore != null ? turnsBefore + nodes.length : null}
      onLoadEarlier={
        onLoadEarlier
          ? () => {
              setLoadSeq((n) => n + 1);
              return onLoadEarlier(OUTLINE_LOAD_EARLIER_LIMIT);
            }
          : undefined
      }
      onOpenChange={setListOpen}
      onJump={handleJump}
      onMarkedTurn={handleMarkedTurn}
      pendingStepsKey={pendingStepsKey}
      nav={nav}
      scrollElement={scrollElement}
      hitTurns={hitTurns}
      currentTurn={currentTurn}
      peekTurn={peekTurn}
      currentHitAnchor={currentSeq != null ? nav.seqAnchor(currentSeq) : undefined}
    />
    {jumpFailed && (
      <div className="olp__jump-failed" role="status">
        Could not load that turn
      </div>
    )}
    </>,
    overlayHost,
  );
}
