import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TranscriptSearchMatch, TranscriptSearchScope } from "@/api/types";
import type { MessageNav } from "../messageNav";
import { MOBILE_QUERY } from "@/hooks/useIsMobile";
import { TOTAL_CAPPED_LABEL } from "./useChatFind";

export interface ChatFindResultsProps {
  matches: TranscriptSearchMatch[];
  totalCapped: boolean;
  current: { seq: number; occurrence: number } | null;
  peekMatch: TranscriptSearchMatch | null;
  navRef: React.RefObject<MessageNav | null>;
  scope: TranscriptSearchScope;
  onToggleScope: () => void;
  onJump: (match: TranscriptSearchMatch) => void;
  onPeek: (match: TranscriptSearchMatch | null) => void;
  onClose: () => void;
}

function formatMatchTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(isNaN(Number(ts)) ? ts : Number(ts));
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isSameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString([], { weekday: "short" });
}

export function ChatFindResults({
  matches,
  totalCapped,
  current,
  peekMatch,
  navRef,
  scope,
  onToggleScope,
  onJump,
  onPeek,
  onClose,
}: ChatFindResultsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(() => {
    if (!current) return 0;
    const idx = matches.findIndex((m) => m.seq === current.seq && m.occurrence === current.occurrence);
    return idx !== -1 ? idx : 0;
  });

  const arrowRestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus container on mount
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Synchronize focusedIndex with current match
  useEffect(() => {
    if (!current) return;
    const idx = matches.findIndex((m) => m.seq === current.seq && m.occurrence === current.occurrence);
    if (idx !== -1) setFocusedIndex(idx);
  }, [current, matches]);

  // Clean up arrow rest timer on unmount
  useEffect(() => {
    return () => {
      if (arrowRestTimerRef.current) clearTimeout(arrowRestTimerRef.current);
    };
  }, []);

  const uniqueTurns = useMemo(() => {
    const s = new Set<number>();
    for (const m of matches) s.add(m.turnIndex);
    return s.size;
  }, [matches]);

  const totalStr = totalCapped ? TOTAL_CAPPED_LABEL : `${matches.length}`;

  const shouldVirtualize = matches.length > 100;
  const virtualizer = useVirtualizer({
    count: matches.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 56,
    overscan: 10,
    enabled: shouldVirtualize,
  });

  // "Where" labels measure the DOM, so they are computed only for the rows
  // actually rendered and cached per match list and current match (a jump
  // scrolls the transcript, which moves every label).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh cache per match list / current match
  const whereCache = useMemo(() => new Map<number, string>(), [matches, current]);
  const whereLabel = (seq: number): string => {
    const cached = whereCache.get(seq);
    if (cached !== undefined) return cached;
    const nav = navRef.current;
    const anchor = nav?.seqAnchor(seq);
    let label = "not loaded";
    if (nav && anchor) {
      const w = nav.anchorWhere(anchor);
      if (w === "in-view") label = "in view";
      else if (w === "above") label = "↑ above";
      else if (w === "below") label = "↓ below";
    }
    whereCache.set(seq, label);
    return label;
  };

  const handleSelect = useCallback(
    (match: TranscriptSearchMatch) => {
      onJump(match);
      if (typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches) {
        onClose();
      }
    },
    [onJump, onClose],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const match = matches[focusedIndex];
      if (match) handleSelect(match);
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const nextIdx = Math.max(0, Math.min(matches.length - 1, focusedIndex + delta));
      setFocusedIndex(nextIdx);

      const targetMatch = matches[nextIdx];
      if (targetMatch) {
        // Hard requirement: hover/focus never scrolls immediately.
        // Arrow navigation jumps ONLY after 150ms of rest.
        if (arrowRestTimerRef.current) clearTimeout(arrowRestTimerRef.current);
        arrowRestTimerRef.current = setTimeout(() => {
          onJump(targetMatch);
        }, 150);
      }

      if (shouldVirtualize) {
        virtualizer.scrollToIndex(nextIdx);
      }
    }
  };

  const renderRow = (match: TranscriptSearchMatch, idx: number) => {
    const isCurrent =
      current?.seq === match.seq && current?.occurrence === match.occurrence;
    const isPeek =
      peekMatch?.seq === match.seq && peekMatch?.occurrence === match.occurrence;
    const isFocused = idx === focusedIndex;

    const where = whereLabel(match.seq);
    const who = match.kind === "user" ? "You" : "Agent";
    const timeStr = formatMatchTime(match.ts);
    const metaStr = `Turn ${match.turnIndex} · ${who}${timeStr ? ` · ${timeStr}` : ""}`;
    const rowId = `find-opt-${match.seq}-${match.occurrence}`;

    return (
      <div
        id={rowId}
        key={`${match.seq}:${match.occurrence}`}
        role="option"
        aria-selected={isFocused}
        className={`fpop__row${isCurrent ? " fpop__row--current" : ""}${isPeek ? " fpop__row--peek" : ""}${isFocused ? " fpop__row--focused" : ""}`}
        onClick={() => handleSelect(match)}
        onPointerEnter={() => onPeek(match)}
        onPointerLeave={() => onPeek(null)}
        onFocus={() => {
          setFocusedIndex(idx);
          onPeek(match);
        }}
        tabIndex={-1}
      >
        <div className="fpop__meta-row">
          <span className="fpop__meta">{metaStr}</span>
          <span className="fpop__where">{where}</span>
        </div>
        <div className="fpop__text">
          {match.snippet && match.snippet.length > 0 ? (
            match.snippet.map((seg, sIdx) =>
              seg.hit ? (
                <mark key={sIdx} className="fpop__mark">
                  {seg.text}
                </mark>
              ) : (
                <span key={sIdx}>{seg.text}</span>
              ),
            )
          ) : (
            <span>Match in turn {match.turnIndex}</span>
          )}
        </div>
      </div>
    );
  };

  const activeDescendantId = matches[focusedIndex]
    ? `find-opt-${matches[focusedIndex]!.seq}-${matches[focusedIndex]!.occurrence}`
    : undefined;

  return (
    <div
      ref={containerRef}
      className="fpop"
      role="listbox"
      aria-label="Matches by turn"
      aria-activedescendant={activeDescendantId}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div className="fpop__head">
        <span className="fpop__caps">
          {totalStr} matches · {uniqueTurns} turns
        </span>
        <span className="fpop__hint">↑↓ move · Enter jump · Esc close list</span>
        <button
          type="button"
          className="fpill"
          aria-pressed={scope === "all"}
          onClick={onToggleScope}
        >
          Tool calls &amp; thinking
        </button>
      </div>

      <div ref={listRef} className="fpop__body">
        {shouldVirtualize ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const match = matches[vItem.index]!;
              return (
                <div
                  key={vItem.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  {renderRow(match, vItem.index)}
                </div>
              );
            })}
          </div>
        ) : (
          matches.map((m, idx) => renderRow(m, idx))
        )}
      </div>
    </div>
  );
}
