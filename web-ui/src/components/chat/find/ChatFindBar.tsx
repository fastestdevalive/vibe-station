import { useEffect, useRef, type ReactNode } from "react";
import { Search, ChevronUp, ChevronDown, List, MoreHorizontal, X } from "lucide-react";
import type { TranscriptSearchMatch, TranscriptSearchScope } from "@/api/types";
import { type FindStatus, TOTAL_CAPPED_LABEL } from "./useChatFind";

export interface ChatFindBarProps {
  sessionId: string;
  query: string;
  scope: TranscriptSearchScope;
  status: FindStatus;
  matches: TranscriptSearchMatch[];
  total: number;
  totalCapped: boolean;
  current: { seq: number; occurrence: number } | null;
  currentIsStreaming?: boolean;
  fallbackRowAnchor?: string | null;
  newCount: number;
  listOpen: boolean;
  backfilling: boolean;
  turnCount: number;
  loadedTurnsCount?: number;
  detached?: boolean;
  detachedTurns?: [number, number];
  currentStyleKey: string | null;
  announcement: string;
  moreOpen: boolean;
  closing?: boolean;
  results?: ReactNode;
  onSetQuery: (q: string) => void;
  onToggleScope: () => void;
  onToggleList: () => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  onToggleMore: () => void;
  onRetry: () => void;
  /** True when loading the window for the current match failed. */
  jumpFailed?: boolean;
  onRetryJump?: () => void;
  onJumpToLatest?: () => void;
}

export function ChatFindBar({
  sessionId,
  query,
  scope,
  status,
  matches,
  total,
  totalCapped,
  current,
  currentIsStreaming,
  fallbackRowAnchor,
  newCount,
  listOpen,
  backfilling,
  turnCount,
  loadedTurnsCount,
  detached,
  detachedTurns,
  currentStyleKey,
  announcement,
  moreOpen,
  closing = false,
  results,
  onSetQuery,
  onToggleScope,
  onToggleList,
  onNext,
  onPrev,
  onClose,
  onToggleMore,
  onRetry,
  jumpFailed = false,
  onRetryJump,
  onJumpToLatest,
}: ChatFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const prevListOpenRef = useRef(listOpen);

  // Auto-focus and select query on mount
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Return focus to the find bar when the results list closes with focus lost
  useEffect(() => {
    if (prevListOpenRef.current && !listOpen && !closing) {
      if (document.activeElement === document.body || document.activeElement === null) {
        barRef.current?.focus();
      }
    }
    prevListOpenRef.current = listOpen;
  }, [listOpen, closing]);

  // Compute current ordinal index
  const curIdx = current
    ? matches.findIndex((m) => m.seq === current.seq && m.occurrence === current.occurrence)
    : -1;
  const matchNum = curIdx !== -1 ? curIdx + 1 : matches.length > 0 ? 1 : 0;
  const totalDisplay = totalCapped ? TOTAL_CAPPED_LABEL : `${total}`;

  // Count text logic
  let countText: ReactNode = "";
  let countAria = "";
  let countDanger = false;
  let showCount = true;

  if (status === "idle") {
    showCount = false;
  } else if (backfilling && matches.length === 0 && (status === "empty" || status === "searching")) {
    // The index is still catching up: an empty page is not an answer yet.
    countText = "Indexing…";
    countAria = "Indexing the chat, results may be incomplete";
  } else if (status === "empty" || (total === 0 && [...query.trim()].length >= 3 && status === "ready")) {
    countText = "No results";
    countAria = "No results";
    countDanger = true;
  } else if (status === "short" || status === "offline" || status === "error") {
    countText = `${total} here`;
    countAria = `${total} here, show list`;
  } else if (status === "searching" && matches.length === 0) {
    countText = "Searching…";
    countAria = "Searching";
  } else if (matches.length > 0 || status === "searching" || status === "ready") {
    if (newCount > 0) {
      countText = (
        <>
          <b>{matchNum}</b> / {totalDisplay} · +{newCount} new
        </>
      );
    } else {
      countText = (
        <>
          <b>{matchNum}</b> / {totalDisplay}
        </>
      );
    }
    countAria = `${matchNum} of ${totalDisplay}, show list`;
  }

  if (matches.length === 0) {
    countAria = countAria.replace(", show list", "");
  }

  // Banner logic (one at a time, 11px)
  let bannerNode: ReactNode = null;
  if (status === "short") {
    bannerNode = (
      <div className="fbar__banner">
        <span>Type 3+ characters to search the whole chat</span>
      </div>
    );
  } else if (status === "empty" && scope === "messages" && !backfilling) {
    bannerNode = (
      <div className="fbar__banner">
        <span>Nothing in messages</span>
        <button type="button" className="fbar__banner-btn" onClick={onToggleScope}>
          Include tool calls
        </button>
      </div>
    );
  } else if (status === "error") {
    bannerNode = (
      <div className="fbar__banner fbar__banner--error">
        <span>Whole-chat search failed</span>
        <button type="button" className="fbar__banner-btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  } else if (jumpFailed) {
    bannerNode = (
      <div className="fbar__banner fbar__banner--error">
        <span>Could not load that match</span>
        {onRetryJump ? (
          <button type="button" className="fbar__banner-btn" onClick={onRetryJump}>
            Retry
          </button>
        ) : null}
      </div>
    );
  } else if (status === "offline") {
    const turnsInfo =
      turnCount > 0 && loadedTurnsCount != null
        ? ` (${loadedTurnsCount} of ${turnCount})`
        : "";
    bannerNode = (
      <div className="fbar__banner">
        <span>Offline · loaded turns only{turnsInfo}</span>
      </div>
    );
  } else if (backfilling) {
    bannerNode = (
      <div className="fbar__banner">
        <span className="chat-spinner" aria-hidden="true" />
        <span>Indexing this chat</span>
      </div>
    );
  } else if (detached) {
    const turnsSpan =
      detachedTurns != null
        ? `Viewing turns ${detachedTurns[0]}–${detachedTurns[1]} of ${turnCount}`
        : "Viewing detached turns";
    bannerNode = (
      <div className="fbar__banner">
        <span>{turnsSpan}</span>
        {onJumpToLatest ? (
          <button type="button" className="fbar__banner-btn" onClick={onJumpToLatest}>
            Jump to latest
          </button>
        ) : null}
      </div>
    );
  }

  const isError = status === "error";

  return (
    <div
      className={`fbar-host${closing ? " fbar-host--closing" : ""}`}
      aria-hidden={closing || undefined}
    >
      {/* Pane-scoped current match generated style */}
      {currentStyleKey ? (
        <style>
          {currentIsStreaming
            ? `.chat-pane[data-find-pane="${CSS.escape(sessionId)}"] mark[data-find-key="${CSS.escape(currentStyleKey)}"] {
  background: var(--find-current);
  box-shadow: 0 0 0 1px var(--find-ring);
  opacity: 0.6;
  outline: 1px dashed var(--find-ring);
}`
            : `.chat-pane[data-find-pane="${CSS.escape(sessionId)}"] mark[data-find-key="${CSS.escape(currentStyleKey)}"] {
  background: var(--find-current);
  box-shadow: 0 0 0 1px var(--find-ring);
}`}
        </style>
      ) : fallbackRowAnchor ? (
        <style>
          {`.chat-pane[data-find-pane="${CSS.escape(sessionId)}"] [data-find-anchor="${CSS.escape(fallbackRowAnchor)}"] {
  outline: 2px dashed var(--find-ring);
  outline-offset: 2px;
}`}
        </style>
      ) : null}

      <div
        ref={barRef}
        tabIndex={-1}
        className={`fbar${isError ? " fbar--error" : ""}`}
        role="search"
        aria-label="Find in chat"
      >
        <div className="fbar__field">
          <Search size={14} className="fbar__search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="fbar__input"
            aria-label="Find in chat"
            placeholder="Find in chat"
            value={query}
            onChange={(e) => onSetQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) onPrev();
                else onNext();
              }
              // Escape is NOT handled here so it bubbles up to pane handler
            }}
          />
          {status === "searching" ? (
            <span className="chat-spinner" aria-hidden="true" />
          ) : null}
        </div>

        <button
          type="button"
          className="fpill"
          aria-pressed={scope === "all"}
          onClick={onToggleScope}
        >
          Tool calls &amp; thinking
        </button>

        {showCount ? (
          <button
            type="button"
            className={`fbar__count${countDanger ? " fbar__count--danger" : ""}`}
            aria-label={countAria}
            disabled={matches.length === 0}
            onClick={onToggleList}
          >
            <span>{countText}</span>
          </button>
        ) : null}

        <button
          type="button"
          className="fbar__btn btn-icon"
          aria-label="Previous match (Shift+Enter)"
          disabled={matches.length === 0}
          onClick={onPrev}
        >
          <ChevronUp size={16} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="fbar__btn btn-icon"
          aria-label="Next match (Enter)"
          disabled={matches.length === 0}
          onClick={onNext}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>

        <span className="fbar__sep" />

        <button
          type="button"
          className="fbar__btn btn-icon fbar__list-btn"
          aria-label="List matches (Alt+Enter)"
          aria-pressed={listOpen}
          disabled={matches.length === 0}
          onClick={onToggleList}
        >
          <List size={16} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="fbar__btn btn-icon fbar__more-btn"
          aria-label="Chat controls: text size, Switch to terminal"
          aria-expanded={moreOpen}
          onClick={onToggleMore}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="fbar__btn btn-icon"
          aria-label="Close find (Esc)"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {results}

      {bannerNode}

      {/* Live region announcement */}
      <div className="fbar__sr" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
