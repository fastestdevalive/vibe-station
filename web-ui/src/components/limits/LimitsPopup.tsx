import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LimitsResult, LimitSlotRef, LimitWindow } from "@/api/types";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { LimitChip } from "./LimitChip";
import {
  harnessLabel,
  resetCountdown,
  sameRef,
  statusReason,
  type SlotIndex,
} from "./limitsModel";

interface LimitsPopupProps {
  slotIndex: SlotIndex;
  slots: [LimitSlotRef, LimitSlotRef];
  harnesses: LimitsResult[];
  host: string;
  nowMs: number;
  refreshing: boolean;
  cooldownUntil: number | null;
  error: string | null;
  onPick: (ref: LimitSlotRef) => void;
  onRefresh: () => void;
  onClose: () => void;
}

function refFromPath(path: string): LimitSlotRef {
  const idx = path.indexOf("/");
  return idx === -1
    ? { harness: path, windowId: "" }
    : { harness: path.slice(0, idx), windowId: path.slice(idx + 1) };
}

function isNodata(win: LimitWindow | undefined): boolean {
  return !win || win.usedPct === null;
}

/** Human wait label for the refresh cooldown. */
function cooldownLabel(remainingMs: number): string {
  return `Wait ${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

export function LimitsPopup({
  slotIndex,
  slots,
  harnesses,
  host,
  nowMs,
  refreshing,
  cooldownUntil,
  error,
  onPick,
  onRefresh,
  onClose,
}: LimitsPopupProps) {
  const other = slotIndex === 0 ? 1 : 0;
  const n = slotIndex + 1;

  const rows = harnesses.flatMap((h) =>
    h.windows.map((w) => ({ path: `${h.harness}/${w.windowId}` })),
  );

  const nav = useRovingListNav(rows, {
    onOpen: (path) => onPick(refFromPath(path)),
    initialCursor: `${slots[slotIndex].harness}/${slots[slotIndex].windowId}`,
  });

  const rowRefs = useRef(new Map<string, HTMLElement>());
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A pinned limit may have vanished (no cursor) — fall back to the first row so the popup stays keyboard-reachable.
    const target = nav.cursorPath ?? rows[0]?.path;
    if (!target) {
      dialogRef.current?.focus();
      return;
    }
    rowRefs.current.get(target)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.cursorPath]);

  const inCooldown = cooldownUntil != null && nowMs < cooldownUntil;
  const refreshDisabled = refreshing || inCooldown;
  const refreshLabel = refreshing ? "Refreshing…" : inCooldown ? cooldownLabel(cooldownUntil! - nowMs) : "Refresh ↻";

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    nav.handleKeyDown(e);
  };

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="limits-popup"
      role="dialog"
      aria-label={`Replace slot ${n}`}
      onKeyDown={onKeyDown}
    >
      <div className="limits-popup__group-title">
        Replace slot {n} · {host}
      </div>
      {harnesses.map((h) => {
        const hasWindows = h.windows.length > 0;
        return (
          <div key={h.harness}>
            <div className="limits-popup__group-title">{harnessLabel(h.harness)}</div>
            {h.windows.map((w) => {
              const ref: LimitSlotRef = { harness: h.harness, windowId: w.windowId };
              const path = `${h.harness}/${w.windowId}`;
              const isCurrent = sameRef(slots[slotIndex], ref);
              const inOther = sameRef(slots[other], ref);
              const nodata = isNodata(w);
              return (
                <div
                  key={path}
                  ref={(el) => {
                    if (el) rowRefs.current.set(path, el);
                    else rowRefs.current.delete(path);
                  }}
                  className="limits-popup__row"
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  tabIndex={nav.isTabbable(path) ? 0 : -1}
                  onClick={() => onPick(ref)}
                  onFocus={() => nav.setCursorPath(path)}
                >
                  <LimitChip harness={h.harness} window={w} nowMs={nowMs} variant="row" />
                  {nodata ? (
                    <span>{statusReason(w.status, h.message) ?? "—"}</span>
                  ) : (
                    <span>{resetCountdown(w.resetsAt, nowMs)}</span>
                  )}
                  {inOther ? <span>slot {other + 1}</span> : <span />}
                </div>
              );
            })}
            {!hasWindows && h.status !== "ok" ? (
              <div className="limits-popup__reason">{statusReason(h.status, h.message)}</div>
            ) : null}
          </div>
        );
      })}
      {error ? <div className="limits-popup__reason">{error}</div> : null}
      <div className="limits-popup__footer">
        <button
          type="button"
          className="limit-chip"
          disabled={refreshDisabled}
          onClick={onRefresh}
        >
          {refreshLabel}
        </button>
      </div>
    </div>
  );
}
