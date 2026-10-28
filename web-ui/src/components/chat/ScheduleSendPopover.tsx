import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CircleAlert } from "lucide-react";
import { Chip } from "@/components/ui/Chip";
import "@/components/schedule/schedule.css";

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
  /**
   * Compose variant (Terminal "Schedule message"): passing `messageValue` adds a
   * message textarea, a target chip and a warning note, and widens the popover to
   * `min(340px, 100vw - 16px)`. The caller owns the message text and the API call
   * (`ScheduleMessagePopover`). Left out, the popover renders exactly as the Rich
   * Chat reschedule/clock popover always did.
   */
  messageValue?: string;
  onMessageChange?: (value: string) => void;
  /** Header chip, e.g. "Agent 1 · Terminal". */
  targetLabel?: string;
  /** Warning shown above the actions. */
  note?: string;
  /** Slot for the "N comments attached" chip (both variants); in the compose variant an empty message is then allowed. */
  commentChip?: ReactNode;
}

const POPOVER_WIDTH = 288;
const COMPOSE_MAX_WIDTH = 340;
const POPOVER_HEIGHT = 140; // approximate; popover measures itself after mount
const SCREEN_MARGIN = 8;

/** The picker's starting value: the next whole minute, i.e. "now". The picker
 *  has minute precision and the daemon only accepts a future time, so the
 *  current (already partly elapsed) minute would be rejected as past. */
export function defaultFireAt(): string {
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
  messageValue,
  onMessageChange,
  targetLabel,
  note,
  commentChip,
}: ScheduleSendPopoverProps) {
  const compose = messageValue !== undefined;
  const [value, setValue] = useState(defaultFireAt);
  // Earliest pickable minute, refreshed each time the popover opens.
  const [minValue, setMinValue] = useState(() => toLocalInput(new Date()));
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    if (open) {
      setMinValue(toLocalInput(new Date()));
      setLocalError(null);
      setValue(initialFireAt ? toLocalInput(new Date(initialFireAt)) : defaultFireAt());
      // Compose variant: first focus is the message; otherwise the time picker.
      setTimeout(() => (compose ? textareaRef.current : inputRef.current)?.focus(), 0);
    }
  }, [open, initialFireAt, compose]);

  // Compose variant: closing (Cancel, Esc, outside click, success) hands focus
  // back to the control that opened it.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && compose) {
      const id = window.setTimeout(() => anchorRef.current?.focus(), 0);
      wasOpen.current = false;
      return () => window.clearTimeout(id);
    }
    wasOpen.current = open;
    return undefined;
  }, [open, compose, anchorRef]);

  // Compute fixed position after mount/re-open, with screen-edge protection.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    const width = compose ? Math.min(COMPOSE_MAX_WIDTH, window.innerWidth - 2 * SCREEN_MARGIN) : POPOVER_WIDTH;
    if (!anchor) {
      // No anchor: center horizontally near bottom of viewport.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setStyle({
        position: "fixed",
        left: Math.max(SCREEN_MARGIN, (vw - width) / 2),
        top: Math.max(SCREEN_MARGIN, vh - POPOVER_HEIGHT - 80),
        width,
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
    left = Math.max(SCREEN_MARGIN, Math.min(left, vw - width - SCREEN_MARGIN));

    setStyle({ position: "fixed", top, left, width, visibility: "visible" });
    // An inline error adds a row (the popover grows), so re-measure then too —
    // otherwise a popover opened above the anchor ends up overlapping it.
  }, [open, anchorRef, error, localError, compose]);

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
    if (compose && !commentChip && !(messageValue ?? "").trim()) {
      setLocalError("Write a message to schedule.");
      return;
    }
    const checked = checkFireAt(value);
    if ("error" in checked) {
      setLocalError(checked.error);
      return;
    }
    setLocalError(null);
    onSchedule(checked.iso);
  }

  const errorText = localError ?? error;
  const timeInput = (
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
  );
  const actions = (
    <div className="chat-schedule-popover__actions">
      <button type="button" className="btn btn--secondary" onClick={onClose}>
        Cancel
      </button>
      <button type="button" className="btn btn--primary" disabled={!value || busy} onClick={handleSchedule}>
        Schedule
      </button>
    </div>
  );

  if (compose) {
    return createPortal(
      <div
        ref={popoverRef}
        className="chat-schedule-popover chat-schedule-popover--compose"
        style={style}
        role="dialog"
        aria-label={title ?? "Schedule message"}
      >
        <div className="chat-schedule-popover__header">
          <b className="chat-schedule-popover__title">{title ?? "Schedule message"}</b>
          {targetLabel ? <Chip tone="neutral">{targetLabel}</Chip> : null}
        </div>
        <label className="chat-schedule-popover__field">
          <span className="chat-schedule-popover__label">Message</span>
          <textarea
            ref={textareaRef}
            aria-label="Message"
            className="chat-schedule-popover__textarea"
            value={messageValue}
            onChange={(e) => {
              onMessageChange?.(e.target.value);
              setLocalError(null);
            }}
            onKeyDown={(e) => {
              // Enter inserts a newline (multi-line is allowed); Cmd/Ctrl+Enter submits.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSchedule();
              }
            }}
          />
        </label>
        {commentChip ? <div className="chat-schedule-popover__chip-slot">{commentChip}</div> : null}
        <div className="chat-schedule-popover__field">
          <span className="chat-schedule-popover__label">When</span>
          {timeInput}
        </div>
        {errorText ? (
          <div className="chat-schedule-popover__inline-error" role="alert">
            <CircleAlert size={13} aria-hidden />
            <span>{errorText}</span>
          </div>
        ) : null}
        {note ? <div className="chat-schedule-popover__note">{note}</div> : null}
        {actions}
      </div>,
      document.body,
    );
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
      {timeInput}
      {commentChip ? <div className="chat-schedule-popover__chip-slot">{commentChip}</div> : null}
      {errorText ? (
        <div className="chat-schedule-popover__error" role="alert">
          {errorText}
        </div>
      ) : null}
      {actions}
    </div>,
    document.body,
  );
}

/** The one validation rule for a `datetime-local` value: a real, future instant (the daemon rejects the past). */
export function checkFireAt(value: string): { iso: string } | { error: string } {
  if (!value) return { error: "Pick a date and time." };
  const when = new Date(value);
  // Unparsable, or a year outside the 4-digit range the daemon/picker accept (5-6 digit years parse fine in JS).
  if (Number.isNaN(when.getTime()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || when.getFullYear() > 9999) {
    return { error: "Pick a valid date and time." };
  }
  if (when.getTime() > Date.now()) return { iso: when.toISOString() };
  // A wall time inside a repeated DST hour parses as its FIRST occurrence; if that is already past, the second
  // occurrence (30/60 min later, same wall string) may still be in the future and is what the user means.
  for (const delta of [3_600_000, 1_800_000]) {
    const later = new Date(when.getTime() + delta);
    if (later.getTime() > Date.now() && toLocalInput(later) === value) return { iso: later.toISOString() };
  }
  return { error: "Pick a time in the future." };
}

export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
