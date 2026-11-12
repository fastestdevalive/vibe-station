import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { worthShowingChain, type TurnNode } from "./buildTurnOutline";
import {
  EMPTY_TURN_FILTER,
  OLP_COMPACT_MAX_H,
  TurnOutlinePanel,
  filterTurnNodes,
  type TurnFilter,
} from "./TurnOutlinePanel";
import {
  currentTurnIndex,
  outlineBeatId,
  outlineKeyNav,
  outlineRowId,
  type PanelMode,
  type TreeFocus,
} from "./outlineTree";
import {
  CHAIN_CAP_H,
  chainMarks,
  chainRows,
  chainTrack,
  inViewBand,
  rowCenterY,
  turnRowStarts,
  yToRow,
} from "./chainGeometry";
import { ChainMarks } from "./ChainMarks";
import { useNewBeatKeys } from "./useNewBeatKeys";
import { useRailWheel } from "./useRailWheel";
import { useWheelAutoJump } from "./useWheelAutoJump";
import { useTopLoadDwell } from "./useTopLoadDwell";
import type { RenderItem } from "../MessageList";
import { itemAnchorKey, type MessageNav } from "../messageNav";

/** A press that moves farther than this is a drag (scrub + jump on release), else a tap. */
const SCRUB_DRAG_PX = 4;
/** Wheel mode keeps the list open this long after the pointer leaves the chain + panel. */
export const HOVER_GRACE_MS = 2000;
/**
 * After a scrub settles (a drag's release, or a wheel's rest + auto-jump) the list hides this long later. It is
 * the only timer on that path; any new press or wheel within it cancels the hide.
 */
export const SETTLE_HIDE_MS = 1000;
/** Fallback chain height before the first measurement (jsdom has no layout). */
const DEFAULT_CHAIN_H = 600;

/**
 * `nodes` as of the last change of `shape`, so the derived data below keys on a stable array. Without a
 * `shape` every new `nodes` counts as a change.
 */
function useShapeNodes(nodes: TurnNode[], shape: object | undefined): TurnNode[] {
  const held = useRef({ shape, nodes });
  if (shape === undefined || held.current.shape !== shape) held.current = { shape, nodes };
  return held.current.nodes;
}

export interface TurnChainProps {
  nodes: TurnNode[];
  /**
   * Changes whenever the geometry of `nodes` can (turn count, anchors, flags, beat kinds): while it is the same
   * object, the chain keeps its geometry across new `nodes` (a streaming delta in the live turn).
   */
  shape?: object;
  items: RenderItem[];
  hasMore?: boolean;
  /** A load of earlier turns is in flight. */
  loadingEarlier?: boolean;
  totalTurns?: number | null;
  /** Loads earlier turns; a returned promise settles when the load does. */
  onLoadEarlier?: () => void | Promise<void>;
  onJump: (anchor: string) => void;
  /** The list opened (true) or closed or the chain unmounted (false). */
  onOpenChange?: (open: boolean) => void;
  /** The row the open list marks changed, `null` when none. */
  onMarkedTurn?: (turnKey: string | null) => void;
  /** Key of the turn whose steps are loading. */
  pendingStepsKey?: string;
  scrollElement?: HTMLElement | null;
  nav?: MessageNav | null;
  hitTurns?: Set<string>;
  currentTurn?: string;
  peekTurn?: string;
  currentHitAnchor?: string;
}

export function TurnChain({
  nodes,
  shape,
  items,
  hasMore = false,
  loadingEarlier = false,
  totalTurns,
  onLoadEarlier,
  onJump,
  onOpenChange,
  onMarkedTurn,
  pendingStepsKey,
  scrollElement,
  nav,
  hitTurns,
  currentTurn,
  peekTurn,
  currentHitAnchor,
}: TurnChainProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** The button as state too: the chain renders nothing before it is worth showing. */
  const [buttonEl, setButtonEl] = useState<HTMLButtonElement | null>(null);
  const [height, setHeight] = useState<number>(DEFAULT_CHAIN_H);
  const [mode, setModeState] = useState<PanelMode | null>(null);
  /** The mode as last set, readable before its render commits (pointer leave right after a wheel). */
  const modeRef = useRef<PanelMode | null>(null);
  const setMode = useCallback((next: PanelMode | null) => {
    modeRef.current = next;
    setModeState(next);
  }, []);
  const [isTouch, setIsTouch] = useState(false);
  const [kfocus, setKfocus] = useState<TreeFocus | null>(null);
  const [scrub, setScrub] = useState<TreeFocus | null>(null);
  /** A drag's last move landed on the top row or in the cap above it. */
  const [dragAtTop, setDragAtTop] = useState(false);
  /** Bumped by every wheel row and drag move: input that starts a new rest at the top. */
  const [inputSeq, setInputSeq] = useState(0);
  const [filter, setFilter] = useState<TurnFilter>(EMPTY_TURN_FILTER);
  const [localVisibleRange, setLocalVisibleRange] = useState<[number, number]>([0, 0]);
  const reactId = useId();
  const outlineId = `turn-outline-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const open = mode != null;

  /**
   * The one pointer that owns the press; a second pointer never steals it.
   * `stale`: rows changed under a pointer that has not moved since, so the
   * marked row, not the row now under the pointer, is the target.
   */
  const pressRef = useRef<{
    id: number;
    startY: number;
    lastY: number;
    moved: boolean;
    stale: boolean;
  } | null>(null);
  const rafRef = useRef<number | null>(null);

  // Measure container height
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      if (h > 0) setHeight(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The nav is the one source of the visible item range; the scroll event only
  // re-reads it, throttled to one read per animation frame.
  useEffect(() => {
    if (!nav) return;
    const updateRange = () => {
      const next = nav.visibleItemRange();
      setLocalVisibleRange((prev) => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
    };
    updateRange();
    if (!scrollElement) return;
    let raf: number | null = null;
    const onScroll = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        updateRange();
      });
    };
    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      scrollElement.removeEventListener("scroll", onScroll);
    };
  }, [scrollElement, nav]);

  /**
   * Flat index of every user row. Only appended to while a turn streams: the
   * scan is skipped unless the list's tail moved (a prepend, a window swap or
   * a re-keyed row), which is detected by the id of the previously last row.
   */
  const userPositionsRef = useRef<{
    positions: number[];
    length: number;
    lastId: string | undefined;
  }>({
    positions: [],
    length: 0,
    lastId: undefined,
  });
  const userPositions = useMemo(() => {
    const st = userPositionsRef.current;
    const len = items.length;
    const aligned = len >= st.length && (st.length === 0 || items[st.length - 1]?.id === st.lastId);
    if (!aligned) {
      // A fresh array, so memos keyed on it see a same-length window swap.
      st.positions = [];
      for (let i = 0; i < len; i++) if (items[i]!.type === "user") st.positions.push(i);
    } else {
      for (let i = st.length; i < len; i++) if (items[i]!.type === "user") st.positions.push(i);
    }
    st.length = len;
    st.lastId = len > 0 ? items[len - 1]?.id : undefined;
    return st.positions;
  }, [items]);

  // Turns whose item span overlaps the visible item range
  /** Index into `nodes` by anchor: `nodes` holds the whole chat once its summary is ready. */
  const shapeNodes = useShapeNodes(nodes, shape);
  const indexByAnchor = useMemo(() => new Map(shapeNodes.map((n, i) => [n.anchor, i] as const)), [shapeNodes]);

  // The previous set is kept while its contents are unchanged, so the marks and band below do not rerun per delta.
  const visibleRef = useRef<Set<number>>(new Set());
  const visibleTurnIndices = useMemo(() => {
    const visibleSet = new Set<number>();
    const [visFirst, visLast] = localVisibleRange;
    for (let t = 0; t < userPositions.length; t++) {
      const start = userPositions[t]!;
      const end = (t + 1 < userPositions.length ? userPositions[t + 1]! : items.length) - 1;
      if (start <= visLast && end >= visFirst) {
        const key = itemAnchorKey(items[start]!);
        visibleSet.add((key != null ? indexByAnchor.get(key) : undefined) ?? t);
      }
    }
    const held = visibleRef.current;
    if (held.size === visibleSet.size && [...visibleSet].every((t) => held.has(t))) return held;
    visibleRef.current = visibleSet;
    return visibleSet;
  }, [userPositions, items, localVisibleRange, indexByAnchor]);

  const rows = useMemo(() => chainRows(shapeNodes), [shapeNodes]);
  const track = useMemo(() => chainTrack(height, rows.length, hasMore), [height, rows.length, hasMore]);
  const marks = useMemo(
    () =>
      chainMarks(shapeNodes, track, {
        visibleTurns: visibleTurnIndices,
        hitTurns,
        currentTurn,
        peekTurn,
      }),
    [shapeNodes, track, visibleTurnIndices, hitTurns, currentTurn, peekTurn],
  );
  const band = useMemo(
    () => inViewBand(shapeNodes, track, visibleTurnIndices),
    [shapeNodes, track, visibleTurnIndices],
  );

  /** Where keyboard focus starts in the tree: the current turn row, else the first row of `list`. */
  const initialFocus = useCallback(
    (list: TurnNode[]): TreeFocus => {
      const cur = nodes[currentTurnIndex(visibleTurnIndices, nodes.length)]?.key;
      const inList = cur != null && list.some((n) => n.key === cur);
      return { turnKey: inList ? cur : (list[0]?.key ?? ""), beat: null };
    },
    [nodes, visibleTurnIndices],
  );

  const filteredNodes = useMemo(() => filterTurnNodes(nodes, filter), [nodes, filter]);

  /**
   * The settled gesture's list: the rows it showed at the settle, held until the hide. The jump swaps the chat to
   * a detached window and the rebuilt outline no longer has the marked row (list reset to turn 1, skeleton rows).
   */
  const [frozen, setFrozen] = useState<{
    nodes: TurnNode[];
    filtered: TurnNode[];
    marked: TreeFocus | null;
  } | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Drops a pending hide and the frozen rows (also after the hide fired: its timer already cleared the ref). */
  const cancelHide = useCallback(() => {
    if (hideRef.current != null) clearTimeout(hideRef.current);
    hideRef.current = null;
    setFrozen(null);
  }, []);

  const close = useCallback(() => {
    cancelHide();
    setMode(null);
  }, [setMode, cancelHide]);

  /** Close and put focus back on the chain when it was inside the panel. */
  const handleClosePanel = useCallback(() => {
    close();
    const btn = buttonRef.current;
    if (btn && document.activeElement !== btn) btn.focus();
  }, [close]);

  /**
   * Wheel mode's grace: once the pointer leaves the chain and the panel the list
   * stays open for HOVER_GRACE_MS (no visual change at all) and only then closes,
   * so a pointer that slips off and back never flickers. Sticky and keyboard
   * lists are explicit pins and never get a timer.
   */
  const graceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRef = useRef({ rail: false, panel: false });

  const cancelGrace = useCallback(() => {
    if (graceRef.current != null) {
      clearTimeout(graceRef.current);
      graceRef.current = null;
    }
  }, []);

  const isWheel = useCallback(() => modeRef.current === "wheel", []);
  const latestRows = useRef({
    nodes,
    filtered: filteredNodes,
    marked: null as TreeFocus | null,
  });
  /** The scrub settled: keep its rows on screen and hide the list after SETTLE_HIDE_MS. */
  const settleHide = useCallback(
    (marked: TreeFocus | null = latestRows.current.marked) => {
      cancelGrace();
      if (hideRef.current != null) clearTimeout(hideRef.current);
      setFrozen({ ...latestRows.current, marked });
      hideRef.current = setTimeout(() => {
        hideRef.current = null;
        close();
      }, SETTLE_HIDE_MS);
    },
    [cancelGrace, close],
  );
  /** A wheel's auto-jump settles the scrub; an explicit jump (row click, Enter) closes the list itself. */
  const jumpAndHide = useCallback(
    (anchor: string) => {
      if (modeRef.current === "wheel") settleHide();
      onJump(anchor);
    },
    [settleHide, onJump],
  );
  const autoJump = useWheelAutoJump(jumpAndHide, isWheel);
  const loadingRef = useRef(loadingEarlier);
  loadingRef.current = loadingEarlier;

  const startGrace = useCallback(() => {
    cancelGrace();
    if (hideRef.current != null) return; // the settle's hide owns the close
    graceRef.current = setTimeout(() => {
      graceRef.current = null;
      // A list the user is reading from the keyboard is not abandoned.
      if (document.getElementById(outlineId)?.contains(document.activeElement)) return;
      close();
    }, HOVER_GRACE_MS);
  }, [cancelGrace, outlineId, close]);

  /** The hover region is `.ol` ∪ `.olp` (they abut, so entering either cancels the grace). */
  const enterRegion = useCallback(
    (which: "rail" | "panel") => {
      hoverRef.current[which] = true;
      autoJump.enter();
      if (modeRef.current === "wheel") cancelGrace();
    },
    [cancelGrace, autoJump],
  );

  const leaveRegion = useCallback(
    (which: "rail" | "panel", to?: EventTarget | null) => {
      hoverRef.current[which] = false;
      if (modeRef.current !== "wheel" || hoverRef.current.rail || hoverRef.current.panel) return;
      // A leave into the other half of the region (they abut) is a crossing, not a leave.
      const other = which === "rail" ? document.getElementById(outlineId) : containerRef.current;
      const crossing = to instanceof Node && other?.contains(to);
      if (!crossing) autoJump.leave();
      startGrace();
    },
    [startGrace, autoJump, outlineId],
  );

  useEffect(() => {
    if (!open) {
      // Closed mid-press (Esc): the release must not jump.
      pressRef.current = null;
      setKfocus(null);
      setScrub(null);
      setDragAtTop(false);
      setFilter(EMPTY_TURN_FILTER);
      hoverRef.current = { rail: false, panel: false };
    }
  }, [open]);

  // Only a wheel list has a grace timer or an auto-jump; any other mode (or closed) cancels them.
  useEffect(() => {
    if (mode !== "wheel") {
      cancelGrace();
      autoJump.reset();
    }
  }, [mode, cancelGrace, autoJump]);

  // A filter edit re-flows the rows: the pending row may no longer be the one shown.
  useEffect(() => {
    autoJump.cancel();
  }, [filter, autoJump]);

  useEffect(
    () => () => {
      cancelGrace();
      if (hideRef.current != null) clearTimeout(hideRef.current);
    },
    [cancelGrace],
  );

  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  useEffect(() => {
    if (!open) return;
    onOpenChangeRef.current?.(true);
    return () => onOpenChangeRef.current?.(false);
  }, [open]);

  const handleTreeKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (e.key === "Tab") {
        close();
        return false;
      }
      // Keys continue from the row the wheel or a tap marked, when the filter still shows it.
      const pinned = scrub && filteredNodes.some((n) => n.key === scrub.turnKey) ? scrub : null;
      const curFocus = kfocus ?? pinned ?? initialFocus(filteredNodes);
      if (e.key === "Enter") {
        const node = filteredNodes.find((n) => n.key === curFocus.turnKey);
        if (!node) return false;
        e.preventDefault();
        e.stopPropagation();
        const beat = curFocus.beat != null ? node.beats[curFocus.beat] : undefined;
        handleClosePanel();
        autoJump.jumpNow(beat ? beat.anchor : node.anchor);
        return true;
      }
      const next = outlineKeyNav(curFocus, e.key, filteredNodes);
      if (next == null) return false;
      e.preventDefault();
      e.stopPropagation();
      cancelHide();
      setMode("keyboard");
      setKfocus(next);
      return true;
    },
    [kfocus, scrub, initialFocus, filteredNodes, close, handleClosePanel, autoJump, setMode, cancelHide],
  );

  /** The turn or step under `clientY`. */
  const targetAt = useCallback(
    (clientY: number): TreeFocus | null => {
      const rect = containerRef.current?.getBoundingClientRect();
      const i = yToRow(track, clientY - (rect?.top ?? 0));
      const row = rows[i];
      const node = row ? nodes[row.turn] : undefined;
      if (!row || !node) return null;
      return { turnKey: node.key, beat: row.beat ?? null };
    },
    [track, rows, nodes],
  );

  const anchorOf = useCallback(
    (t: TreeFocus): string | undefined => {
      const node = nodes.find((n) => n.key === t.turnKey);
      if (!node) return undefined;
      return t.beat != null ? (node.beats[t.beat]?.anchor ?? node.anchor) : node.anchor;
    },
    [nodes],
  );

  const setScrubIfChanged = useCallback((next: TreeFocus | null) => {
    setScrub((prev) => (prev?.turnKey === next?.turnKey && prev?.beat === next?.beat ? prev : next));
  }, []);

  /**
   * Flat rows of the filtered list: a wheel scrub moves through exactly what the list shows. Unfiltered, they
   * are the chain's own rows (no per-delta rebuild at 50k turns).
   */
  const filterActive = filteredNodes !== nodes;
  const wheelRowList = useMemo(
    () => (filterActive ? chainRows(filteredNodes) : rows),
    [filterActive, filteredNodes, rows],
  );

  /** The chain marks the row a press points at (scrub, then the tapped row) or the keyboard focus. */
  const marked = mode === "keyboard" ? kfocus : mode != null ? scrub : null;
  latestRows.current = { nodes, filtered: filteredNodes, marked };

  const onMarkedTurnRef = useRef(onMarkedTurn);
  useEffect(() => {
    onMarkedTurnRef.current = onMarkedTurn;
  });
  const markedTurnKey = marked?.turnKey ?? null;
  useEffect(() => {
    onMarkedTurnRef.current?.(markedTurnKey);
  }, [markedTurnKey]);
  useEffect(() => () => onMarkedTurnRef.current?.(null), []);

  /**
   * Where a wheel scrub starts: the row an open list marks (a tap, the keyboard
   * or an earlier wheel), else the turn in view (the keyboard's initial focus).
   */
  const wheelStartRow = useCallback((): number => {
    const inList = marked != null && filteredNodes.some((n) => n.key === marked.turnKey);
    const focus = inList ? marked : initialFocus(filteredNodes);
    const idx = filteredNodes.findIndex((n) => n.key === focus.turnKey);
    if (idx === -1) return 0;
    const beats = filteredNodes[idx]!.beats.length;
    const beatRow = focus.beat != null && focus.beat < beats ? focus.beat + 1 : 0;
    return (turnRowStarts(filteredNodes)[idx] ?? 0) + beatRow;
  }, [marked, initialFocus, filteredNodes]);

  const handleWheelRow = useCallback(
    (i: number) => {
      const row = wheelRowList[i];
      const node = row ? filteredNodes[row.turn] : undefined;
      if (!row || !node) return;
      const anchor = row.beat != null ? (node.beats[row.beat]?.anchor ?? node.anchor) : node.anchor;
      // A frame or momentum landing after the pointer left moves the ring but neither
      // re-arms a jump nor holds the list open.
      // While earlier turns load the jump waits; the load's settle re-schedules it.
      // New input within the settle's second keeps the list (cancels the hide); a late momentum frame does not.
      if (loadingRef.current) {
        cancelHide();
        cancelGrace();
      } else if (autoJump.schedule(anchor, modeRef.current !== "wheel")) {
        cancelHide();
        cancelGrace();
      } else startGrace();
      setIsTouch(false);
      setKfocus(null);
      setMode("wheel");
      setScrubIfChanged({ turnKey: node.key, beat: row.beat ?? null });
      setInputSeq((n) => n + 1);
    },
    [wheelRowList, filteredNodes, setScrubIfChanged, cancelGrace, cancelHide, startGrace, setMode, autoJump],
  );

  /** A held press owns the rail: a wheel under it neither scrubs nor changes the mode. */
  const pressHeld = useCallback(() => pressRef.current != null, []);

  useRailWheel({
    el: buttonEl,
    scrollElement,
    rowCount: wheelRowList.length,
    active: mode === "wheel",
    blocked: pressHeld,
    getStartRow: wheelStartRow,
    onScrubRow: handleWheelRow,
  });

  const endPress = useCallback((el: Element, pointerId: number) => {
    pressRef.current = null;
    setDragAtTop(false);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
      // The capture was already lost; nothing to release.
    }
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  /** Stable ref callback: the button element is state, so the wheel listener can attach late. */
  const attachButton = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    setButtonEl(node);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (pressRef.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    cancelGrace();
    const settling = hideRef.current != null;
    cancelHide();
    // The press owns the commit now: a drag jumps on release, a tap pins with no jump.
    autoJump.cancel();
    // In wheel mode a press starts the normal press-scrub; otherwise pressing the
    // chain again closes the open list.
    if (open && mode !== "wheel" && !settling) {
      e.preventDefault();
      close();
      return;
    }
    pressRef.current = {
      id: e.pointerId,
      startY: e.clientY,
      lastY: e.clientY,
      moved: false,
      stale: false,
    };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is a nicety: without it moves outside the strip are simply not seen.
    }
    setIsTouch(e.pointerType === "touch");
    setKfocus(null);
    setMode("scrub");
    setDragAtTop(false);
    setScrubIfChanged(targetAt(e.clientY));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press || press.id !== e.pointerId) return;
    if (e.clientY !== press.lastY) press.stale = false;
    press.lastY = e.clientY;
    if (Math.abs(e.clientY - press.startY) > SCRUB_DRAG_PX) press.moved = true;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const p = pressRef.current;
      if (!p) return;
      if (!p.stale) setScrubIfChanged(targetAt(p.lastY));
      if (!p.moved) return;
      // The top row and the cap above it both clamp to row 0.
      const top = containerRef.current?.getBoundingClientRect().top ?? 0;
      setDragAtTop(yToRow(track, p.lastY - top) === 0);
      setInputSeq((n) => n + 1);
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press || press.id !== e.pointerId) return;
    const moved = press.moved || Math.abs(e.clientY - press.startY) > SCRUB_DRAG_PX;
    endPress(e.currentTarget, e.pointerId);
    if (!moved) {
      // A tap leaves the list open to read and click; the chain keeps marking the tapped row.
      setMode("sticky");
      return;
    }
    const target = press.stale && e.clientY === press.lastY ? scrub : targetAt(e.clientY);
    const anchor = target ? anchorOf(target) : undefined;
    if (anchor) {
      settleHide(target);
      onJump(anchor);
    } else {
      close();
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press || press.id !== e.pointerId) return;
    endPress(e.currentTarget, e.pointerId);
    close();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setIsTouch(false);
        setMode("keyboard");
        setKfocus(initialFocus(nodes));
      }
      return;
    }
    handleTreeKey(e);
  };

  // Space activates a button on keyup; the keydown above already opened the list.
  const handleKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " ") e.preventDefault();
  };

  // Clicks from a pointer are handled by the press above; a click with no
  // pointer behind it (assistive tech) toggles the list like the keyboard.
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.detail !== 0) return;
    if (open) {
      close();
    } else {
      setIsTouch(false);
      setMode("keyboard");
      setKfocus(initialFocus(nodes));
    }
  };

  // Esc closes from anywhere; a press outside the chain and the panel closes a sticky list.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const active = document.activeElement;
      const inside = containerRef.current?.contains(active) || document.getElementById(outlineId)?.contains(active);
      if (inside) handleClosePanel();
      else close();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (
        pressRef.current ||
        !t ||
        containerRef.current?.contains(t) ||
        document.getElementById(outlineId)?.contains(t)
      ) {
        return;
      }
      close();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    document.addEventListener("pointerdown", onPointer, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKey, { capture: true });
      document.removeEventListener("pointerdown", onPointer, { capture: true });
    };
  }, [open, handleClosePanel, close, outlineId]);

  // Wheel mode: leaving the window starts the grace; returning to it with the pointer
  // still over the chain or the panel, or focus moving into the panel, cancels it.
  useEffect(() => {
    if (mode !== "wheel") return;
    const onBlur = () => {
      autoJump.cancel();
      startGrace();
    };
    const onFocus = () => {
      if (hoverRef.current.rail || hoverRef.current.panel) cancelGrace();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Node | null;
      if (t && document.getElementById(outlineId)?.contains(t)) cancelGrace();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [mode, startGrace, cancelGrace, autoJump, outlineId]);

  // Top-of-rail auto-load: a wheel resting on the first listed row, or a drag at the top.
  const wheelAtTop =
    mode === "wheel" &&
    frozen == null &&
    scrub != null &&
    scrub.beat == null &&
    filteredNodes[0]?.key === scrub.turnKey;
  useTopLoadDwell({
    onTop: wheelAtTop || (mode === "scrub" && dragAtTop),
    hasMore,
    loading: loadingEarlier,
    gesture: mode,
    inputSeq,
    firstKey: nodes[0]?.key,
    onLoad: onLoadEarlier,
  });

  // A load of earlier turns holds the wheel's auto-jump; its settle re-schedules it on the current row.
  const wasLoadingRef = useRef(loadingEarlier);
  useEffect(() => {
    const was = wasLoadingRef.current;
    wasLoadingRef.current = loadingEarlier;
    if (modeRef.current !== "wheel" || hideRef.current != null) return;
    if (loadingEarlier) {
      autoJump.cancel();
      return;
    }
    const anchor = was && scrub ? anchorOf(scrub) : undefined;
    if (anchor && autoJump.schedule(anchor, false)) cancelGrace();
  }, [loadingEarlier, scrub, anchorOf, autoJump, cancelGrace]);

  // Rows that change under a held, unmoved pointer leave the marked row as the target.
  useEffect(() => {
    if (pressRef.current) pressRef.current.stale = true;
  }, [nodes]);

  const newBeatKeys = useNewBeatKeys(nodes);

  const scrubY = useMemo(() => {
    if (!marked) return null;
    const t = nodes.findIndex((n) => n.key === marked.turnKey);
    if (t === -1) return null;
    const start = turnRowStarts(nodes)[t]!;
    return Math.round(rowCenterY(track, start + (marked.beat != null ? marked.beat + 1 : 0)));
  }, [marked, nodes, track]);

  // A short chat with no long autonomous turn has nothing to map.
  if (!worthShowingChain(nodes)) {
    return null;
  }

  const activeDescendant =
    mode === "keyboard" && marked != null
      ? marked.beat != null
        ? outlineBeatId(outlineId, marked.turnKey, marked.beat)
        : outlineRowId(outlineId, marked.turnKey)
      : undefined;

  return (
    <>
      <div
        ref={containerRef}
        className={`ol${open ? " ol--open" : ""}`}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") enterRegion("rail");
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "touch") leaveRegion("rail", e.relatedTarget);
        }}
      >
        {band && <div className="ol__inview" style={{ top: `${band.top}px`, height: `${band.height}px` }} />}
        {hasMore && <div className="ol__cap" style={{ height: `${CHAIN_CAP_H}px` }} aria-hidden="true" />}
        <ChainMarks marks={marks} height={height} />
        {scrubY != null && <div className="ol__scrub" style={{ top: `${scrubY}px` }} aria-hidden="true" />}

        <button
          ref={attachButton}
          type="button"
          className="chainbtn"
          title={open ? undefined : "Scroll or drag to move through the chat"}
          aria-label={`Conversation outline, ${totalTurns ?? nodes.length} turns. Press Enter to open`}
          aria-expanded={open}
          aria-controls={outlineId}
          aria-activedescendant={activeDescendant}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
        />
      </div>

      {mode != null && (
        <TurnOutlinePanel
          outlineId={outlineId}
          nodes={frozen?.nodes ?? nodes}
          filteredNodes={frozen?.filtered ?? filteredNodes}
          filter={filter}
          onFilterChange={(f) => {
            cancelHide();
            setFilter(f);
          }}
          hasMore={hasMore}
          loadingEarlier={loadingEarlier}
          onLoadEarlier={onLoadEarlier}
          onJump={autoJump.jumpNow}
          pendingStepsKey={pendingStepsKey}
          onClose={handleClosePanel}
          visibleTurnIndices={visibleTurnIndices}
          isTouch={isTouch}
          compact={height < OLP_COMPACT_MAX_H}
          mode={mode}
          marked={frozen ? frozen.marked : marked}
          onHoverChange={(inside, to) => (inside ? enterRegion("panel") : leaveRegion("panel", to))}
          newBeatKeys={newBeatKeys}
          currentHitAnchor={currentHitAnchor}
          onTreeKeyDown={handleTreeKey}
        />
      )}
    </>
  );
}
