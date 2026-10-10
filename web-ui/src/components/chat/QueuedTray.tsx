import { useEffect, useRef, useState } from "react";
import { Clock, RotateCcw, TriangleAlert } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { Attachment, Command, ScheduledFailedMessage } from "@/api/types";
import type { EditingDraft } from "@/hooks/useChat";
import { renderSkillMessageText } from "@/lib/skillInvocation";
import { QueuedTurnEditor } from "./QueuedTurnEditor";

export type QueuedTrayStatus = "queued" | "editing" | "pending";

export interface QueuedTrayRow {
  turnId: string;
  text: string;
  attachments?: Attachment[];
  status: QueuedTrayStatus;
  /** This turn was originally a scheduled send that fired while the agent was
   *  busy, so it landed in the queue — shown with a subtle clock marker. */
  scheduled?: boolean;
  /** Present when THIS tab is editing the row (prefill for the inline editor). */
  draft?: EditingDraft;
}

/** Notice slot info (subagent-ux-v2) — displayed as a muted row above human queue rows. */
export interface NoticeSlotInfo {
  children: Record<string, string>;
  running: boolean;
}

export interface ScheduledRow {
  id: string;
  message: string;
  attachments?: Attachment[];
  fireAt: string; // ISO-8601
}

export interface QueuedTrayProps {
  api: ApiInstance;
  sessionId: string;
  /** Oldest first (top); the newest sits nearest the composer (bottom). */
  rows: QueuedTrayRow[];
  onEdit: (turnId: string) => void;
  onSendNow: (turnId: string) => void;
  onCancel: (turnId: string) => void;
  onSave: (turnId: string, message: string, attachmentIds: string[]) => Promise<void>;
  onDiscard: (turnId: string) => void;
  /** Salvage edited content into the composer when a Save fails (A9). */
  onSalvage: (message: string, attachments: Attachment[]) => void;
  /** Return focus to the composer (Escape from a row). */
  focusComposer?: () => void;
  /** Session's slash-command/skill catalog, threaded into `QueuedTurnEditor`. */
  commands?: Command[];
  /** Pending notice slot (subagent-ux-v2) — muted row rendered above human queue rows. */
  noticeSlot?: NoticeSlotInfo;
  /** Called when the user clicks Dismiss on the notice slot row. */
  onDismissNotice?: () => void;
  /** Called when the user clicks Send now on the notice slot row. */
  onSendNoticeNow?: () => void;
  /** Scheduled messages to show below the normal queue, sorted by fireAt ascending. */
  scheduledRows?: ScheduledRow[];
  onScheduledEdit?: (id: string, row: ScheduledRow, anchor: HTMLButtonElement) => void;
  onScheduledSendNow?: (id: string) => void;
  onScheduledCancel?: (id: string) => void;
  /** Scheduled sends the daemon failed to deliver, shown after the scheduled rows. */
  failedRows?: ScheduledFailedMessage[];
  onFailedRetry?: (id: string) => void;
  onFailedDismiss?: (id: string) => void;
}

function formatScheduleTime(fireAt: string): string {
  const d = new Date(fireAt);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs < 0) return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const diffHrs = diffMs / (1000 * 60 * 60);
  if (diffHrs < 24) {
    const hrs = Math.floor(diffHrs);
    const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    if (diffMs < 10 * 60 * 1000) {
      const secs = Math.floor((diffMs % (1000 * 60)) / 1000);
      if (mins === 0) return `in ${secs}s`;
      return `in ${mins}m ${secs}s`;
    }
    if (hrs === 0) return `in ${mins}m`;
    if (mins === 0) return `in ${hrs}h`;
    return `in ${hrs}h ${mins}m`;
  }
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Queued-turn tray, mounted directly above the composer. Messages sent while a
 * turn is running stack here (oldest on top) instead of appearing in the chat
 * log — each row can be edited, promoted ("send now"), or cancelled while it
 * waits. Up/Down arrow keys move focus between rows (roving tabindex); Escape
 * returns focus to the composer. When a turn starts running it leaves the queue
 * (meta drops its turnId) and its message re-appears in the conversation.
 */
export function QueuedTray({
  api,
  sessionId,
  rows,
  onEdit,
  onSendNow,
  onCancel,
  onSave,
  onDiscard,
  onSalvage,
  focusComposer,
  commands,
  noticeSlot,
  onDismissNotice,
  onSendNoticeNow,
  scheduledRows,
  onScheduledEdit,
  onScheduledSendNow,
  onScheduledCancel,
  failedRows,
  onFailedRetry,
  onFailedDismiss,
}: QueuedTrayProps) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Keep the focused index in range as rows come and go (turn started/cancelled).
  // Never steal focus on row changes — only explicit arrow presses move focus.
  useEffect(() => {
    if (focusedIndex > rows.length - 1) setFocusedIndex(Math.max(0, rows.length - 1));
  }, [rows.length, focusedIndex]);

  const sortedScheduled = scheduledRows
    ? [...scheduledRows].sort((a, b) => a.fireAt.localeCompare(b.fireAt))
    : [];

  const failed = failedRows ?? [];

  // Keep the "in 4m 12s" countdown live: re-render every second while the next
  // send is under 10 minutes away, otherwise every 30s (still catches the
  // switch to the per-second cadence). Nothing ticks without scheduled rows.
  const [, setNowTick] = useState(0);
  const soonestMs = sortedScheduled[0] ? Date.parse(sortedScheduled[0].fireAt) : null;
  const imminent = soonestMs != null && soonestMs - Date.now() < 10 * 60 * 1000;
  useEffect(() => {
    if (soonestMs == null) return undefined;
    const id = window.setInterval(() => setNowTick((n) => n + 1), imminent ? 1000 : 30_000);
    return () => window.clearInterval(id);
  }, [soonestMs, imminent]);

  if (rows.length === 0 && !noticeSlot && sortedScheduled.length === 0 && failed.length === 0) return null;

  function moveFocus(delta: number) {
    const next = Math.min(Math.max(focusedIndex + delta, 0), rows.length - 1);
    setFocusedIndex(next);
    rowRefs.current[next]?.focus();
  }

  return (
    <div
      className="chat-queued-tray"
      role="list"
      aria-label="Queued messages"
      onKeyDown={(e) => {
        // The inline editor's textarea owns its own arrows/Escape — never hijack.
        if ((e.target as HTMLElement).closest("textarea, input")) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveFocus(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(-1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          focusComposer?.();
        }
      }}
    >
      {noticeSlot && !noticeSlot.running ? (() => {
        const names = Object.values(noticeSlot.children);
        const subagentSuffix = names.length <= 1
          ? "subagent has update, will wake parent when idle"
          : "subagents have update, will wake parent when idle";
        const ariaLabel = names.length === 0
          ? "Subagent has update, will wake parent when idle"
          : `${names.join(", ")} ${subagentSuffix}`;
        return (
          <div
            key="__notice__"
            className="chat-queued-tray__row chat-queued-tray__row--notice"
            role="listitem"
            aria-label={ariaLabel}
          >
            <div className="chat-queued-tray__text chat-queued-tray__text--notice">
              {names.map((name, idx) => (
                <span key={`${name}-${idx}`} className="chat-queued-tray__chip" data-testid="notice-child-chip">
                  {name}
                </span>
              ))}
              <span className="chat-queued-tray__notice-label">{subagentSuffix}</span>
            </div>
            <div className="chat-queued-tray__actions">
              <button
                type="button"
                className="chat-queued-tray__action"
                aria-label="Send now"
                title="Send now (interrupts the current turn)"
                onClick={() => onSendNoticeNow?.()}
              >
                ⏭
              </button>
              <button
                type="button"
                className="chat-queued-tray__action"
                aria-label="Dismiss wake-up"
                title="Cancel / Dismiss"
                onClick={() => onDismissNotice?.()}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })() : null}
      {rows.map((row, i) => {
        const editing = row.status === "editing";
        const localEdit = editing && row.draft;
        // `row.text` is the RAW wire string (Decision 2) — a queued turn that
        // carries chips holds `{/name args}` tokens and `\{`-escaped braces.
        // Never render it directly (Phase 7 Risk 5, escape leakage): the tray
        // shows the same `/name args` form the transcript bubble does.
        const displayText = renderSkillMessageText(row.text);
        return (
          <div
            key={row.turnId}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            className={`chat-queued-tray__row chat-queued-tray__row--${row.status}`}
            role="listitem"
            tabIndex={i === focusedIndex ? 0 : -1}
            aria-label={`Queued message: ${displayText || "(attachments only)"}`}
          >
            {localEdit ? (
              <QueuedTurnEditor
                api={api}
                sessionId={sessionId}
                turnId={row.turnId}
                initialText={row.draft!.message}
                initialAttachments={row.draft!.attachments}
                commands={commands}
                onSave={async (message, attachments) => {
                  try {
                    await onSave(row.turnId, message, attachments.map((a) => a.id));
                  } catch {
                    // Save lost the race (turn started / another tab won) — salvage
                    // the edited content into the composer so no input is dropped (A9).
                    onSalvage(message, attachments);
                  }
                }}
                onDiscard={() => onDiscard(row.turnId)}
              />
            ) : (
              <>
                {row.scheduled ? (
                  <span
                    className="chat-queued-tray__schedule-icon chat-queued-tray__schedule-icon--fired"
                    title="Scheduled message — it was due while the agent was busy, so it's queued"
                    aria-label="Scheduled earlier"
                  >
                    <Clock size={12} />
                  </span>
                ) : null}
                <div className="chat-queued-tray__text" title={displayText}>
                  {displayText || "(attachments only)"}
                </div>
                {editing ? (
                  <div className="chat-queued-tray__badge">editing…</div>
                ) : (
                  <div className="chat-queued-tray__actions">
                    <button
                      type="button"
                      className="chat-queued-tray__action"
                      aria-label="Send now"
                      title="Send now (interrupts the current turn)"
                      onClick={() => onSendNow(row.turnId)}
                      disabled={row.status === "pending"}
                    >
                      ⏭
                    </button>
                    <button
                      type="button"
                      className="chat-queued-tray__action"
                      aria-label="Edit queued message"
                      title="Edit"
                      onClick={() => onEdit(row.turnId)}
                      disabled={row.status === "pending"}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="chat-queued-tray__action"
                      aria-label="Cancel queued turn"
                      title="Cancel"
                      onClick={() => onCancel(row.turnId)}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      {sortedScheduled.map((row) => {
        const displayText = renderSkillMessageText(row.message);
        return (
          <div
            key={row.id}
            className="chat-queued-tray__row chat-queued-tray__row--scheduled"
            role="listitem"
            aria-label={`Scheduled message: ${displayText || "(attachments only)"}`}
          >
            <span className="chat-queued-tray__schedule-icon" aria-hidden><Clock size={13} /></span>
            <div className="chat-queued-tray__text" title={displayText}>
              {displayText || "(attachments only)"}
            </div>
            <span className="chat-queued-tray__time-label">{formatScheduleTime(row.fireAt)}</span>
            <div className="chat-queued-tray__actions">
              <button
                type="button"
                className="chat-queued-tray__action"
                aria-label="Send now"
                title="Send now"
                onClick={() => onScheduledSendNow?.(row.id)}
              >
                ⏭
              </button>
              <button
                type="button"
                className="chat-queued-tray__action"
                aria-label="Reschedule message"
                title="Edit"
                onClick={(e) => onScheduledEdit?.(row.id, row, e.currentTarget)}
              >
                ✎
              </button>
              <button
                type="button"
                className="chat-queued-tray__action"
                aria-label="Cancel scheduled message"
                title="Cancel"
                onClick={() => onScheduledCancel?.(row.id)}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
      {failed.map((row) => {
        const displayText = renderSkillMessageText(row.message);
        return (
          <div
            key={row.id}
            className="chat-queued-tray__row chat-queued-tray__row--failed"
            role="listitem"
            aria-label={`Failed scheduled message: ${displayText || "(attachments only)"} — ${row.failureReason}`}
          >
            <span className="chat-queued-tray__failed-icon" aria-hidden><TriangleAlert size={13} /></span>
            <div className="chat-queued-tray__text" title={displayText}>
              {displayText || "(attachments only)"}
            </div>
            <span className="chat-queued-tray__failed-reason" title={row.failureReason}>
              {row.failureReason}
            </span>
            <div className="chat-queued-tray__actions">
              <button
                type="button"
                className="chat-queued-tray__action"
                aria-label="Retry scheduled send"
                title="Retry now"
                onClick={() => onFailedRetry?.(row.id)}
              >
                <RotateCcw size={11} aria-hidden />
              </button>
              <button
                type="button"
                className="chat-queued-tray__action"
                aria-label="Dismiss failed scheduled send"
                title="Dismiss"
                onClick={() => onFailedDismiss?.(row.id)}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
