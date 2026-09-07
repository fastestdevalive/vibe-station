import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment, Command } from "@/api/types";
import type { EditingDraft } from "@/hooks/useChat";
import { renderSkillMessageText } from "@/lib/skillInvocation";
import { QueuedTurnEditor } from "./QueuedTurnEditor";

export type QueuedTrayStatus = "queued" | "editing" | "pending";

export interface QueuedTrayRow {
  turnId: string;
  text: string;
  attachments?: Attachment[];
  status: QueuedTrayStatus;
  /** Present when THIS tab is editing the row (prefill for the inline editor). */
  draft?: EditingDraft;
}

/** Notice slot info (subagent-ux-v2) — displayed as a muted row above human queue rows. */
export interface NoticeSlotInfo {
  children: Record<string, string>;
  running: boolean;
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
}: QueuedTrayProps) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Keep the focused index in range as rows come and go (turn started/cancelled).
  // Never steal focus on row changes — only explicit arrow presses move focus.
  useEffect(() => {
    if (focusedIndex > rows.length - 1) setFocusedIndex(Math.max(0, rows.length - 1));
  }, [rows.length, focusedIndex]);

  if (rows.length === 0 && !noticeSlot) return null;

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
      {noticeSlot ? (() => {
        const names = Object.values(noticeSlot.children);
        const label = names.length === 0
          ? "Checking on subagent…"
          : names.length === 1
          ? `Waking parent — ${names[0]} waiting for agent`
          : `Waking parent — ${names.join(", ")} waiting for agent`;
        return (
          <div
            key="__notice__"
            className="chat-queued-tray__row chat-queued-tray__row--notice"
            role="listitem"
            aria-label={label}
          >
            <div className="chat-queued-tray__text">{label}</div>
            <div className="chat-queued-tray__actions">
              <button
                type="button"
                className="chat-queued-tray__action"
                aria-label="Dismiss wake-up"
                title="Dismiss"
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
    </div>
  );
}
