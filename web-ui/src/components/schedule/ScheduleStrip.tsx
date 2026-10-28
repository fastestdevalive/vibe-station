import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Clock, Copy, Loader2, Paperclip } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { ScheduledFailedMessage, ScheduledPendingMessage, ScheduledSentMessage } from "@/api/types";
import { Chip } from "@/components/ui/Chip";
import { renderDraftText } from "@/lib/mentions";
import { SCHEDULE_COPY, commentCountLabel } from "./scheduleCopy";
import { formatClock, formatScheduleTime, isCountdown } from "./formatScheduleTime";
import type { ScheduleRowData } from "./useScheduledSends";
import "./schedule.css";

export type ScheduleStripVariant = "chat" | "overlay" | "inline";

interface ScheduleStripProps {
  /** From `useScheduledSends` (one call per pane); this component holds no data of its own. */
  rows: ScheduleRowData[];
  api: ApiInstance;
  sessionId: string;
  /** False while the agent is exited or done (resolved by the pane as
   *  `sessionStates[id] ?? session.state`): Send now and Retry are disabled. */
  sessionLive: boolean;
  variant: ScheduleStripVariant;
  /** Agent name shown on a pasted row ("pasted at 3:00 PM · Agent 1"). */
  agentName?: string;
  onEdit: (id: string, row: ScheduledPendingMessage, anchor: HTMLButtonElement) => void;
  onHideSent: (id: string) => void;
  /** An action's rejection (daemon error or clipboard failure); the pane shows it. */
  onError: (e: unknown) => void;
}

const NOT_RUNNING = SCHEDULE_COPY.agentNotRunning;

function displayMessage(row: ScheduleRowData): string {
  // Terminal rows hold plain text; only Rich Chat rows carry `{/name args}` chip tokens.
  return row.channel === "tmux" ? row.message : renderDraftText(row.message);
}

function rowClass(row: ScheduleRowData): string {
  if (row.kind === "sent") return "sched-strip__row--sent";
  if (row.kind === "failed") return row.failureKind === "timed_out" ? "sched-strip__row--warn" : "sched-strip__row--fail";
  return `sched-strip__row--${row.phase ?? "scheduled"}`;
}

/**
 * The scheduled-sends strip: one row per pending, waiting, pasting, failed and
 * recently pasted message. Rich Chat renders it below the Subagents row
 * (`chat`), Terminal directly under the header overlay (`overlay`) or inside
 * the exited/done pane (`inline`). `rows` must come from `useScheduledSends`,
 * which leaves out `origin = "immediate"` sends (they belong to an immediate
 * send, not a schedule).
 */
export function ScheduleStrip({
  rows,
  api,
  sessionId,
  sessionLive,
  variant,
  agentName,
  onEdit,
  onHideSent,
  onError,
}: ScheduleStripProps) {
  // `rows` is `useScheduledSends().rows`, which already excludes `origin = "immediate"` sends: the one gate.
  const visible = rows;

  // Keep the "in 4m 12s" countdown live: every second while the next send is
  // under 10 minutes away, otherwise every 30s (still catches the switch).
  const [, setTick] = useState(0);
  const nextFireAt = visible.find((r) => r.kind === "pending" && (r.phase ?? "scheduled") === "scheduled")?.fireAt ?? null;
  const imminent = nextFireAt != null && isCountdown(nextFireAt);
  useEffect(() => {
    if (nextFireAt == null) return undefined;
    const id = window.setInterval(() => setTick((n) => n + 1), imminent ? 1000 : 30_000);
    return () => window.clearInterval(id);
  }, [nextFireAt, imminent]);

  // Phase changes are announced from a status node that only changes text on a transition: the countdown above
  // re-renders every second and must never be inside a live region.
  const seen = useRef<Map<string, string> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const prev = seen.current;
    const next = new Map<string, string>();
    let say = "";
    for (const r of visible) {
      const key = r.kind === "pending" ? (r.phase ?? "scheduled") : r.kind;
      next.set(r.id, key);
      if (prev && prev.get(r.id) !== key) {
        if (key === "failed") say = "A scheduled message failed";
        else if (key === "sent") say = "A scheduled message was pasted";
        else if (key === "waiting") say = "A scheduled message is waiting for the agent";
      }
    }
    seen.current = next;
    if (say) setAnnouncement(say);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  if (visible.length === 0) return null;

  const run = (p: Promise<unknown>) => void p.catch(onError);

  async function copyText(message: string) {
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      onError(new Error("Couldn't copy the message."));
    }
  }

  return (
    <>
    <span className="sched-strip__live" role="status">
      {announcement}
    </span>
    <div className={`sched-strip sched-strip--${variant}`} role="list" aria-label="Scheduled messages">
      {visible.map((row) => {
        const text = displayMessage(row);
        const comments = row.kind === "sent" ? 0 : (row.commentCount ?? 0);
        const commentsOnly = !text && comments > 0;
        const emptyShown =
          row.kind === "sent" ? "(no message)" : comments > 0 ? `${comments} review comment${comments === 1 ? "" : "s"}` : "(attachments only)";
        const shown = text || emptyShown;
        const attachmentCount = row.kind === "sent" ? 0 : (row.attachments?.length ?? 0);
        const textEl = (
          <>
            <div className="sched-strip__text" title={text}>
              {commentsOnly ? "" : shown}
            </div>
            {attachmentCount > 0 ? (
              <span
                className="sched-strip__attachments"
                title={`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`}
                aria-label={`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`}
              >
                <Paperclip size={11} aria-hidden />
              </span>
            ) : null}
          </>
        );

        if (row.kind === "failed") {
          return (
            <FailedRow
              key={row.id}
              row={row}
              textEl={textEl}
              shown={shown}
              sessionLive={sessionLive}
              onRetry={() => run(api.retryScheduledMessage(sessionId, row.id))}
              onCopy={() => void copyText(row.message)}
              onDismiss={() => run(api.dismissScheduledMessage(sessionId, row.id))}
            />
          );
        }

        if (row.kind === "sent") {
          return (
            <SentRow
              key={row.id}
              row={row}
              textEl={textEl}
              shown={shown}
              agentName={agentName}
              onHide={() => onHideSent(row.id)}
            />
          );
        }

        const phase = row.phase ?? "scheduled";
        const commentChip = row.commentCount ? (
          <Chip tone="neutral" size="sm">
            {commentCountLabel(row.commentCount ?? 0)}
          </Chip>
        ) : null;
        return (
          <div
            key={row.id}
            className={`sched-strip__row ${rowClass(row)}`}
            role="listitem"
            aria-label={`Scheduled message: ${shown}`}
          >
            {phase === "scheduled" ? (
              <Clock className="sched-strip__icon sched-strip__icon--muted" size={13} aria-hidden />
            ) : (
              <Loader2 className="sched-strip__icon sched-strip__icon--accent sched-strip__spin" size={13} aria-hidden />
            )}
            {commentsOnly ? commentChip : null}
            {textEl}
            {commentsOnly ? null : commentChip}
            <span className="sched-strip__time">
              {phase === "scheduled"
                ? `${formatScheduleTime(row.fireAt)} · pending`
                : phase === "waiting"
                  ? `Waiting for agent · due ${formatClock(row.fireAt)}`
                  : "Pasting…"}
            </span>
            {phase === "pasting" ? null : (
              <div className="sched-strip__actions">
                {phase === "scheduled" ? (
                  <>
                    <button
                      type="button"
                      className="sched-strip__action"
                      aria-label="Send now"
                      title={sessionLive ? "Send now" : NOT_RUNNING}
                      disabled={!sessionLive}
                      onClick={() => run(api.sendScheduledNow(sessionId, row.id))}
                    >
                      ⏭
                    </button>
                    <button
                      type="button"
                      className="sched-strip__action"
                      aria-label="Reschedule message"
                      title="Edit"
                      onClick={(e) => onEdit(row.id, row, e.currentTarget)}
                    >
                      ✎
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="sched-strip__action"
                  aria-label="Cancel scheduled message"
                  title="Cancel"
                  onClick={() => run(api.cancelScheduledMessage(sessionId, row.id))}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
    </>
  );
}

function FailedRow({
  row,
  textEl,
  shown,
  sessionLive,
  onRetry,
  onCopy,
  onDismiss,
}: {
  row: { kind: "failed" } & ScheduledFailedMessage;
  textEl: React.ReactNode;
  shown: string;
  sessionLive: boolean;
  onRetry: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  const warn = row.failureKind === "timed_out";
  const hasComments = (row.commentCount ?? 0) > 0;
  const reason = hasComments ? `${row.failureReason} · comments restored` : row.failureReason;
  return (
    <div
      className={`sched-strip__row sched-strip__row--failed ${rowClass(row)}`}
      role="listitem"
      aria-label={`Failed scheduled message: ${shown} — ${reason}`}
    >
      {warn ? (
        <Clock className="sched-strip__icon sched-strip__icon--warn" size={13} aria-hidden />
      ) : (
        <CircleAlert className="sched-strip__icon sched-strip__icon--fail" size={13} aria-hidden />
      )}
      {textEl}
      {hasComments ? (
        <Chip tone="neutral" size="sm">
          {commentCountLabel(row.commentCount ?? 0)}
        </Chip>
      ) : null}
      <div className="sched-strip__actions sched-strip__actions--solid">
        <button
          type="button"
          className="sched-strip__retry"
          aria-label="Retry scheduled send"
          title={sessionLive ? "Retry now" : NOT_RUNNING}
          disabled={!sessionLive}
          onClick={onRetry}
        >
          Retry
        </button>
        <button type="button" className="sched-strip__action" aria-label="Copy as text" title="Copy as text" onClick={onCopy}>
          <Copy size={12} aria-hidden />
        </button>
        <button
          type="button"
          className="sched-strip__action"
          aria-label="Dismiss failed scheduled send"
          title="Dismiss"
          onClick={onDismiss}
        >
          ✕
        </button>
      </div>
      <span className={`sched-strip__reason ${warn ? "sched-strip__reason--warn" : "sched-strip__reason--fail"}`}>
        {reason}
      </span>
    </div>
  );
}

function SentRow({
  row,
  textEl,
  shown,
  agentName,
  onHide,
}: {
  row: { kind: "sent" } & ScheduledSentMessage;
  textEl: React.ReactNode;
  shown: string;
  agentName: string | undefined;
  onHide: () => void;
}) {
  return (
    <div
      className={`sched-strip__row ${rowClass(row)}`}
      role="listitem"
      aria-label={`Pasted scheduled message: ${shown}`}
    >
      <Check className="sched-strip__icon sched-strip__icon--success" size={13} aria-hidden />
      {textEl}
      <span className="sched-strip__time">
        {`pasted at ${formatClock(row.sentAt)}`}
        {agentName ? ` · ${agentName}` : ""}
      </span>
      <div className="sched-strip__actions">
        <button type="button" className="sched-strip__action" aria-label="Hide sent message" title="Hide" onClick={onHide}>
          ✕
        </button>
      </div>
    </div>
  );
}
