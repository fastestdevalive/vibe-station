import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

interface ScheduleSendPopoverProps {
  open: boolean;
  /** Anchor element the popover positions itself relative to. */
  anchorRef: RefObject<HTMLElement | null> | { current: HTMLButtonElement | null };
  onSchedule: (fireAt: string) => void;
  onClose: () => void;
  /** Pre-fill the time picker with this ISO-8601 value (edit mode). */
  initialFireAt?: string;
  title?: string;
  /** Error from the last attempt (e.g. the daemon rejected the time) — shown inline. */
  error?: string | null;
  /** Disables the confirm button while a request is in flight. */
  busy?: boolean;
}

const POPOVER_WIDTH = 288;
const POPOVER_HEIGHT = 140; // approximate; popover measures itself after mount
const SCREEN_MARGIN = 8;

/** The picker's starting value: the next whole minute, i.e. "now". The picker
 *  has minute precision and the daemon only accepts a future time, so the
 *  current (already partly elapsed) minute would be rejected as past. */
function defaultFireAt(): string {
  return toLocalInput(new Date((Math.floor(Date.now() / 60_000) + 1) * 60_000));
}

export function ScheduleSendPopover({
  open,
  anchorRef,
  onSchedule,
  onClose,
  initialFireAt,
  title,
  error,
  busy,
}: ScheduleSendPopoverProps) {
  const [value, setValue] = useState(defaultFireAt);
  // Earliest pickable minute, refreshed each time the popover opens.
  const [minValue, setMinValue] = useState(() => toLocalInput(new Date()));
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    if (open) {
      setMinValue(toLocalInput(new Date()));
      setLocalError(null);
      setValue(initialFireAt ? toLocalInput(new Date(initialFireAt)) : defaultFireAt());
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, initialFireAt]);

  // Compute fixed position after mount/re-open, with screen-edge protection.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor) {
      // No anchor: center horizontally near bottom of viewport.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setStyle({
        position: "fixed",
        left: Math.max(SCREEN_MARGIN, (vw - POPOVER_WIDTH) / 2),
        top: Math.max(SCREEN_MARGIN, vh - POPOVER_HEIGHT - 80),
        width: POPOVER_WIDTH,
      });
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const measuredH = popover?.offsetHeight ?? POPOVER_HEIGHT;

    // Prefer opening above the anchor; fall back to below if insufficient space.
    const spaceAbove = rect.top - SCREEN_MARGIN;
    const spaceBelow = vh - rect.bottom - SCREEN_MARGIN;
    const openAbove = spaceAbove >= measuredH || spaceAbove >= spaceBelow;

    let top: number;
    if (openAbove) {
      top = rect.top - measuredH - 6;
    } else {
      top = rect.bottom + 6;
    }
    // Clamp vertically.
    top = Math.max(SCREEN_MARGIN, Math.min(top, vh - measuredH - SCREEN_MARGIN));

    // Align left edge with anchor; clamp to keep within viewport.
    let left = rect.left;
    left = Math.max(SCREEN_MARGIN, Math.min(left, vw - POPOVER_WIDTH - SCREEN_MARGIN));

    setStyle({ position: "fixed", top, left, width: POPOVER_WIDTH, visibility: "visible" });
    // An inline error adds a row (the popover grows), so re-measure then too —
    // otherwise a popover opened above the anchor ends up overlapping it.
  }, [open, anchorRef, error, localError]);

  // Escape key and outside-click close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // A press on the anchor (the clock button) is the button's own toggle —
      // closing here too would make its click immediately re-open us.
      if (anchorRef.current?.contains(target)) return;
      if (popoverRef.current && !popoverRef.current.contains(target)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  function handleSchedule() {
    if (!value || busy) return;
    const when = new Date(value);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      setLocalError("Pick a time in the future.");
      return;
    }
    setLocalError(null);
    onSchedule(when.toISOString());
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="chat-schedule-popover"
      style={style}
      role="dialog"
      aria-label={title ?? "Schedule send"}
    >
      <div className="chat-schedule-popover__label">{title ?? "Send at"}</div>
      <input
        ref={inputRef}
        type="datetime-local"
        aria-label="Send at"
        className="input"
        value={value}
        min={minValue}
        onChange={(e) => {
          setValue(e.target.value);
          setLocalError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSchedule();
          }
        }}
      />
      {localError || error ? (
        <div className="chat-schedule-popover__error" role="alert">
          {localError ?? error}
        </div>
      ) : null}
      <div className="chat-schedule-popover__actions">
        <button type="button" className="btn btn--secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!value || busy}
          onClick={handleSchedule}
        >
          Schedule
        </button>
      </div>
    </div>,
    document.body,
  );
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
