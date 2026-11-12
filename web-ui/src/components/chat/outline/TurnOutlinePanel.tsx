import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer, observeElementRect } from "@tanstack/react-virtual";
import { ArrowUp, CircleAlert, Loader2, Pencil, X } from "lucide-react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNowTick } from "@/hooks/useNowTick";
import { formatOutlineSpokenTime } from "@/lib/timeAgo";
import type { TurnNode } from "./buildTurnOutline";
import {
  currentTurnIndex,
  outlineRowCount,
  outlineRowId,
  rowOffsets,
  type PanelMode,
  type TreeFocus,
} from "./outlineTree";
import { BeatRows } from "./BeatRows";
import { OutlineTime } from "./OutlineTime";

export const TURN_ROW_H = 32;
export const BEAT_ROW_H = 26;
export const TOUCH_TURN_ROW_H = 44;
export const TOUCH_BEAT_ROW_H = 44;
/** Fallback dimensions for list virtualization and measurement. */
const DEFAULT_PANEL_H = 600;
const DEFAULT_PANEL_W = 320;
/** The scroll box's top padding, and the "Load earlier turns" row plus its gap. */
const LIST_PAD_PX = 4;
const LOAD_ROW_H = 28;
const LOAD_ROW_GAP = 4;
/** Must match the `@media (max-width: 640px)` block in outline.css that sizes rows to 44px. */
export const OUTLINE_NARROW_QUERY = "(max-width: 640px)";
/** Width of one tabular digit of the `--fs-micro` turn number; sizes the number column. */
const NUMBER_DIGIT_PX = 7;
/** The number column never gets narrower than the rail it sits on. */
const NUMBER_MIN_PX = 20;
/** The filter box appears past this many turns. */
const FILTER_MIN_TURNS = 100;
/** The list virtualises past this many rendered rows (turns + steps). */
const VIRTUAL_MIN_ROWS = 150;
/** Below this chain height the panel takes its compact layout (a short chat viewport). */
export const OLP_COMPACT_MAX_H = 240;

export interface TurnFilter {
  text: string;
  errorsOnly: boolean;
}

export const EMPTY_TURN_FILTER: TurnFilter = { text: "", errorsOnly: false };

/** The outline rows shown under `filter`; keyboard focus moves within this list. */
export function filterTurnNodes(nodes: TurnNode[], filter: TurnFilter): TurnNode[] {
  let list = nodes;
  if (filter.errorsOnly) {
    list = list.filter((n) => n.errors > 0);
  }
  if (filter.text.trim()) {
    const q = filter.text.toLowerCase();
    list = list.filter((n) => n.label.toLowerCase().includes(q));
  }
  return list;
}

export interface TurnOutlinePanelProps {
  /** Unique per pane: the panel's id, prefix of its row ids. */
  outlineId: string;
  nodes: TurnNode[];
  /** `nodes` under the current filter (owned by the chain, which also moves focus). */
  filteredNodes: TurnNode[];
  filter: TurnFilter;
  onFilterChange: (filter: TurnFilter) => void;
  hasMore?: boolean;
  /** A load of earlier turns is in flight: the load row shows a spinner. */
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  onJump: (anchor: string) => void;
  onClose: () => void;
  visibleTurnIndices: Set<number>;
  /** Opened by touch: 44px rows and a close button. */
  isTouch?: boolean;
  /** The chain is shorter than OLP_COMPACT_MAX_H: hug the viewport and drop the idle filter row. */
  compact?: boolean;
  mode: PanelMode;
  marked: TreeFocus | null;
  newBeatKeys: ReadonlySet<string>;
  currentHitAnchor?: string;
  onTreeKeyDown?: (e: React.KeyboardEvent) => boolean;
  /** The pointer (mouse/pen only) entered or left the panel (`to`: where a leave went); wheel mode's hover grace. */
  onHoverChange?: (inside: boolean, to?: EventTarget | null) => void;
  /** Key of the turn whose steps are loading. */
  pendingStepsKey?: string;
}

interface OutlineRowProps {
  outlineId: string;
  node: TurnNode;
  rowId: string;
  isCurrent: boolean;
  mode: PanelMode;
  marked: TreeFocus | null;
  newBeatKeys: ReadonlySet<string>;
  currentHitAnchor?: string;
  /** For the spoken age in the aria-labels. */
  now: number;
  /** The row's 1-based position in `filteredNodes`, for the virtualised tree. */
  posInSet: number;
  /** `filteredNodes.length`: how many turn rows the tree holds. */
  setSize: number;
  style?: React.CSSProperties;
  /** This turn's steps are being fetched. */
  stepsPending: boolean;
  onJump: (anchor: string) => void;
  onClose: () => void;
}

function OutlineRow({
  outlineId,
  node,
  rowId,
  isCurrent,
  mode,
  marked,
  newBeatKeys,
  currentHitAnchor,
  now,
  posInSet,
  setSize,
  style,
  stepsPending,
  onJump,
  onClose,
}: OutlineRowProps) {
  const isFocused = mode === "keyboard" && marked?.turnKey === node.key && marked.beat === null;
  const isScrub = mode !== "keyboard" && marked?.turnKey === node.key && marked.beat === null;
  let rowClass = "olp__row";
  if (isCurrent) rowClass += " cur";
  if (isFocused) rowClass += " kfocus";
  if (isScrub) rowClass += " scrub";
  if (node.cancelled) rowClass += " cancelled";
  if (node.unloaded) rowClass += " unloaded";
  if (node.skeleton) rowClass += " skeleton";

  const labelText = node.review
    ? `Review comments (${node.review.count}) · ${node.review.name}`
    : node.skeleton
      ? "…"
      : node.label;
  const turnPrefix = node.number != null ? `Turn ${node.number}: ` : "";
  const editsText = node.edits > 0 ? `, ${node.edits} edits` : "";
  const errorsText = node.errors > 0 ? `, ${node.errors} errors` : "";
  const beatsCount = node.beats.length;
  const beatsText = beatsCount > 0 ? `, ${beatsCount} ${beatsCount === 1 ? "beat" : "beats"}` : "";
  const notLoadedText = node.unloaded ? ", not loaded" : "";
  const spokenTime = formatOutlineSpokenTime(node.ts, now);
  const timeText = spokenTime ? `, ${spokenTime}` : "";
  const turnAriaLabel = `${turnPrefix}${labelText}${editsText}${errorsText}${beatsText}${notLoadedText}${timeText}`;

  return (
    <div className="olp__item" role="none" style={style}>
      <button
        id={rowId}
        type="button"
        role="treeitem"
        aria-level={1}
        aria-setsize={setSize}
        aria-posinset={posInSet}
        aria-label={turnAriaLabel}
        className={rowClass}
        title={labelText}
        onClick={() => {
          onJump(node.anchor);
          onClose();
        }}
      >
        <span className="olp__n">{node.number ?? "—"}</span>
        <span className="olp__label">{labelText}</span>
        {node.live && (
          <span className="olp__chip olp__chip--live">
            <i aria-hidden="true" />
            Live
          </span>
        )}
        {node.cancelled && <span className="olp__chip">Cancelled</span>}
        {node.unloaded && !node.skeleton && node.beats.length === 0 && (node.tools ?? 0) > 0 && (
          <span className="olp__chip" title="Tool calls">
            {node.tools} {node.tools === 1 ? "tool" : "tools"}
          </span>
        )}
        {node.edits > 0 && (
          <span className="olp__chip" title="Files edited">
            <Pencil size={12} strokeWidth={1.7} aria-hidden="true" />
            {node.edits}
          </span>
        )}
        {node.errors > 0 && (
          <span className="olp__chip olp__chip--err" title="Errors">
            <CircleAlert size={12} strokeWidth={1.7} aria-hidden="true" />
            {node.errors}
          </span>
        )}
        {stepsPending && (
          <span className="olp__chip olp__chip--loading">
            <Loader2 className="olp__load-spin" size={12} strokeWidth={1.7} aria-hidden="true" />
            Loading steps…
          </span>
        )}
        <OutlineTime ts={node.ts} />
      </button>

      {beatsCount > 0 && (
        <BeatRows
          outlineId={outlineId}
          nodeKey={node.key}
          beats={node.beats}
          turnTs={node.ts}
          now={now}
          isLive={!!node.live}
          mode={mode}
          marked={marked}
          newBeatKeys={newBeatKeys}
          currentHitAnchor={currentHitAnchor}
          onJump={onJump}
          onClose={onClose}
        />
      )}
    </div>
  );
}

export function TurnOutlinePanel({
  outlineId,
  nodes,
  filteredNodes,
  filter,
  onFilterChange,
  hasMore = false,
  loadingEarlier = false,
  onLoadEarlier,
  onJump,
  onClose,
  visibleTurnIndices,
  isTouch = false,
  compact = false,
  mode,
  marked = null,
  newBeatKeys,
  currentHitAnchor,
  onTreeKeyDown,
  onHoverChange,
  pendingStepsKey,
}: TurnOutlinePanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const isScrubMode = mode === "scrub" || mode === "wheel";
  const keyboard = mode === "keyboard";

  /** Spoken scrub row: the live region waits 300 ms so a fast scrub announces its resting row. */
  const [spokenRow, setSpokenRow] = useState("");
  useEffect(() => {
    if (!isScrubMode || !marked) return;
    const node = filteredNodes.find((n) => n.key === marked.turnKey);
    if (!node) return;
    const label =
      marked.beat != null
        ? node.beats[marked.beat]?.label
        : node.review
          ? `Review comments (${node.review.count}) · ${node.review.name}`
          : node.label;
    if (!label) return;
    const timer = setTimeout(() => setSpokenRow(label), 300);
    return () => clearTimeout(timer);
  }, [isScrubMode, marked, filteredNodes]);

  // The CSS gives rows 44px when opened by touch and under OUTLINE_NARROW_QUERY; mirror both.
  const isNarrow = useMediaQuery(OUTLINE_NARROW_QUERY);
  const tallRows = isTouch || isNarrow;
  const turnH = tallRows ? TOUCH_TURN_ROW_H : TURN_ROW_H;
  const beatH = tallRows ? TOUCH_BEAT_ROW_H : BEAT_ROW_H;
  /** Where the tree starts inside the scroll box. */
  const listTop = LIST_PAD_PX + (hasMore ? LOAD_ROW_H + LOAD_ROW_GAP : 0);

  const now = useNowTick();
  const showFilter = nodes.length > FILTER_MIN_TURNS;
  const offsets = useMemo(() => rowOffsets(filteredNodes, turnH, beatH), [filteredNodes, turnH, beatH]);
  const isVirtual = useMemo(() => outlineRowCount(filteredNodes) > VIRTUAL_MIN_ROWS, [filteredNodes]);

  const curTurnIndex = useMemo(
    () => currentTurnIndex(visibleTurnIndices, nodes.length),
    [visibleTurnIndices, nodes.length],
  );
  const curKey = visibleTurnIndices.size > 0 ? nodes[curTurnIndex]?.key : undefined;

  /** Top and height of a row in the scroll box, from the deterministic row heights. */
  const rowBox = useCallback(
    (focus: TreeFocus): { top: number; height: number } | null => {
      const idx = filteredNodes.findIndex((n) => n.key === focus.turnKey);
      if (idx === -1) return null;
      const beatOffset = focus.beat != null ? turnH + focus.beat * beatH : 0;
      return { top: listTop + (offsets[idx] ?? 0) + beatOffset, height: focus.beat != null ? beatH : turnH };
    },
    [filteredNodes, offsets, listTop, turnH, beatH],
  );

  /** scrollTop that puts `focus` on the list's centre line. */
  const centredTop = useCallback(
    (focus: TreeFocus | null, listH: number) => {
      const box = focus ? rowBox(focus) : null;
      return box ? Math.max(0, box.top - (listH - box.height) / 2) : 0;
    },
    [rowBox],
  );

  // Virtualizer for long lists; row heights are deterministic, so sizes come from `offsets`.
  const rowVirtualizer = useVirtualizer({
    count: filteredNodes.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (offsets[index + 1] ?? 0) - (offsets[index] ?? 0) || turnH,
    enabled: isVirtual,
    overscan: 5,
    scrollMargin: listTop,
    initialOffset: () => centredTop(marked, listRef.current?.clientHeight || DEFAULT_PANEL_H),
    initialRect: { width: DEFAULT_PANEL_W, height: DEFAULT_PANEL_H },
    observeElementRect: (instance, cb) => {
      return observeElementRect(instance, (rect) => {
        cb({
          width: rect.width || DEFAULT_PANEL_W,
          height: rect.height || DEFAULT_PANEL_H,
        });
      });
    },
  });

  // Re-measure the virtualizer when row heights change
  useEffect(() => {
    if (isVirtual) {
      rowVirtualizer.measure();
    }
  }, [offsets, isVirtual, rowVirtualizer]);

  // On mount, bring the marked row to the middle of the list
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = centredTop(marked, list.clientHeight || DEFAULT_PANEL_H);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only
  }, []);

  // The scrub target follows the pointer instantly: it stays on the centre line.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !isScrubMode || !marked) return;
    list.scrollTop = centredTop(marked, list.clientHeight || DEFAULT_PANEL_H);
  }, [isScrubMode, marked, centredTop]);

  // Streaming live beat append auto-scroll
  const liveNode = useMemo(() => nodes.find((n) => n.live), [nodes]);
  const liveBeatsCount = liveNode?.beats.length ?? 0;
  const prevLiveBeatsCountRef = useRef(liveBeatsCount);

  useLayoutEffect(() => {
    const prevCount = prevLiveBeatsCountRef.current;
    prevLiveBeatsCountRef.current = liveBeatsCount;
    if (liveBeatsCount > prevCount) {
      const list = listRef.current;
      if (list) {
        const distBeforeAppend =
          list.scrollHeight - beatH - (list.scrollTop + list.clientHeight);
        if (distBeforeAppend <= beatH + 4) {
          list.scrollTop = list.scrollHeight;
        }
      }
    }
  }, [liveBeatsCount, beatH]);

  // Keep the keyboard-focused row or beat visible
  useEffect(() => {
    const list = listRef.current;
    const box = keyboard && marked ? rowBox(marked) : null;
    if (!list || !box) return;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (box.top < viewTop) {
      list.scrollTop = box.top;
    } else if (box.top + box.height > viewBottom) {
      list.scrollTop = box.top + box.height - list.clientHeight;
    }
  }, [keyboard, marked, rowBox]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // The filter box forwards its own tree keys; the rest (Home/End, Left/Right) edit the text.
      const fromFilter = e.target === filterInputRef.current;
      if (!fromFilter && onTreeKeyDown?.(e)) {
        return;
      }
      if (e.key === "Tab") {
        onClose();
      }
    },
    [onTreeKeyDown, onClose],
  );

  /** The number column is as wide as the widest number in the panel (at least the rail's 20px). */
  const numberW = useMemo(
    () => Math.max(NUMBER_MIN_PX, nodes.reduce((d, n) => Math.max(d, String(n.number ?? "").length), 0) * NUMBER_DIGIT_PX + 6),
    [nodes],
  );

  const renderRow = (node: TurnNode, index: number, style?: React.CSSProperties) => {
    const rowId = outlineRowId(outlineId, node.key);
    return (
      <OutlineRow
        key={node.key}
        outlineId={outlineId}
        node={node}
        rowId={rowId}
        isCurrent={node.key === curKey}
        mode={mode}
        marked={marked}
        newBeatKeys={newBeatKeys}
        currentHitAnchor={currentHitAnchor}
        now={now}
        posInSet={index + 1}
        setSize={filteredNodes.length}
        style={style}
        stepsPending={node.key === pendingStepsKey}
        onJump={onJump}
        onClose={onClose}
      />
    );
  };

  const filteredCount = filteredNodes.length;
  const countText =
    filteredCount !== nodes.length
      ? `${filteredCount} of ${nodes.length}${hasMore ? " loaded" : ""}`
      : `${nodes.length}${hasMore ? " loaded" : ""}`;
  /** An active filter never becomes invisible in the compact layout. */
  const showFilterRow = showFilter && (!compact || filter.text !== "" || filter.errorsOnly);

  return (
    <div
      id={outlineId}
      role="dialog"
      aria-label="Conversation outline"
      className={`olp${isTouch ? " olp--touch" : ""}${compact ? " olp--compact" : ""}`}
      data-testid={isVirtual ? "olp-virtual" : undefined}
      style={{ "--olp-n-w": `${numberW}px` } as React.CSSProperties}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") onHoverChange?.(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") onHoverChange?.(false, e.relatedTarget);
      }}
    >
      <span className="olp__sr" aria-live="polite">
        {spokenRow}
      </span>

      <div className="olp__head">
        <span className="olp__title">Turns</span>
        <span className="olp__count">{countText}</span>
        <span className="olp__spacer" />
        {isTouch && (
          <button type="button" className="olp__ib" aria-label="Close outline" onClick={onClose}>
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
      </div>

      {showFilterRow && (
        <div className="olp__filter">
          <input
            ref={filterInputRef}
            type="text"
            className="olp__filter-input"
            placeholder="Filter turns"
            aria-label="Filter turns"
            value={filter.text}
            onChange={(e) => onFilterChange({ ...filter, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
                onTreeKeyDown?.(e);
              }
            }}
          />
          <button
            type="button"
            className={`olp__filter-chip${filter.errorsOnly ? " active" : ""}`}
            aria-pressed={filter.errorsOnly}
            onClick={() => onFilterChange({ ...filter, errorsOnly: !filter.errorsOnly })}
          >
            errors
          </button>
        </div>
      )}

      <div className="olp__scroll" ref={listRef}>
        {hasMore && (
          <button
            type="button"
            className="olp__load"
            onClick={() => onLoadEarlier?.()}
            disabled={loadingEarlier}
            aria-busy={loadingEarlier || undefined}
          >
            {loadingEarlier ? (
              <Loader2 className="olp__load-spin" size={12} strokeWidth={1.7} aria-hidden="true" />
            ) : (
              <ArrowUp size={12} strokeWidth={1.7} aria-hidden="true" />
            )}
            <span>{loadingEarlier ? "Loading earlier…" : "Load earlier turns"}</span>
          </button>
        )}

        <div className="olp__list" role="tree">
          {filteredNodes.length === 0 && nodes.length > 0 ? (
            <div className="olp__empty" role="none">No turns match</div>
          ) : isVirtual ? (
            <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) =>
                renderRow(filteredNodes[virtualRow.index]!, virtualRow.index, {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start - listTop}px)`,
                }),
              )}
            </div>
          ) : (
            filteredNodes.map((node, index) => renderRow(node, index))
          )}
        </div>
      </div>

      {keyboard && (
        <div className="olp__foot" aria-hidden="true">
          <span><kbd className="olp__kbd">↑</kbd><kbd className="olp__kbd">↓</kbd>Move</span>
          <span><kbd className="olp__kbd">↵</kbd>Jump</span>
          <span className="olp__foot-end"><kbd className="olp__kbd">Esc</kbd>Close</span>
        </div>
      )}
    </div>
  );
}
