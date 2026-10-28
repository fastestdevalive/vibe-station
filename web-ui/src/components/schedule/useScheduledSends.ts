import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type {
  ScheduleSnapshot,
  ScheduledFailedMessage,
  ScheduledPendingMessage,
  ScheduledSentMessage,
  WSEvent,
} from "@/api/types";
import { useScheduleDevOverride } from "./scheduleDevOverride";

/** A "pasted at 3:00 PM" row leaves the strip this long after `sentAt`. */
export const SENT_VISIBLE_MS = 10 * 60 * 1000;

export type ScheduleRowData =
  | ({ kind: "pending" } & ScheduledPendingMessage)
  | ({ kind: "failed" } & ScheduledFailedMessage)
  | ({ kind: "sent" } & ScheduledSentMessage);

export interface ScheduledSends {
  /** Strip/badge rows: pending (by fire time), then failed, then recently pasted.
   *  Never includes `origin = "immediate"` rows. */
  rows: ScheduleRowData[];
  /** The `origin = "immediate"` rows (an immediate send's tray state), same shape. */
  immediateRows: ScheduleRowData[];
  /** Client-side hide for a pasted row (the ✕ on a sent row). */
  hideSent: (id: string) => void;
}

const EMPTY: ScheduleSnapshot = { scheduledSends: [], scheduledFailed: [], scheduledSent: [] };

function isImmediate(row: { origin?: string }): boolean {
  return row.origin === "immediate";
}

/**
 * The only client copy of a session's scheduled sends. `ScheduleStrip` and
 * `ScheduleButton` receive `rows` as props, so a pane calls this ONCE
 * (AgentPaneSlot for Terminal, ChatPane for Rich Chat): one GET per mount and
 * one refcounted `api.subscribe`, independent of TerminalPane/ChatPane's own
 * subscriptions (which can be gone, e.g. after the agent exits).
 *
 * Fetches `GET /sessions/:id/schedule` on mount and on every `ws:open`, then
 * follows `session:scheduled` pushes. A response that resolves after a newer
 * push (or after a session switch) is dropped, so a stale GET never overwrites
 * fresher live state. An absent `scheduledSent` keeps the previous list.
 */
export function useScheduledSends(api: ApiInstance, sessionId: string | null | undefined): ScheduledSends {
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot>(EMPTY);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const pushSeq = useRef(0);
  const override = useScheduleDevOverride((s) => (sessionId ? s.bySession[sessionId] : undefined));

  useEffect(() => {
    setSnapshot(EMPTY);
    setHidden(new Set());
    pushSeq.current = 0;
    if (!sessionId) return undefined;
    let live = true;
    const unsubscribe = api.subscribe([sessionId]);

    const fetchSnapshot = () => {
      const startedAt = pushSeq.current;
      api
        .getScheduledMessages(sessionId)
        .then((snap) => {
          if (!live || pushSeq.current !== startedAt) return;
          setSnapshot({
            scheduledSends: snap.scheduledSends ?? [],
            scheduledFailed: snap.scheduledFailed ?? [],
            scheduledSent: snap.scheduledSent ?? [],
          });
        })
        .catch(() => {
          // Offline / daemon error: keep the last known value; `ws:open` refetches.
        });
    };

    const offScheduled = api.on("session:scheduled", (e: WSEvent) => {
      if (e.type !== "session:scheduled" || e.sessionId !== sessionId) return;
      pushSeq.current += 1;
      setSnapshot((prev) => ({
        scheduledSends: e.scheduledSends,
        scheduledFailed: e.scheduledFailed,
        scheduledSent: e.scheduledSent ?? prev.scheduledSent,
      }));
    });
    const offOpen = api.on("ws:open", fetchSnapshot);
    fetchSnapshot();

    return () => {
      live = false;
      offScheduled();
      offOpen();
      unsubscribe();
    };
  }, [api, sessionId]);

  const effective = override ?? snapshot;

  // Auto-hide a pasted row 10 minutes after `sentAt`: wake once at the next expiry.
  useEffect(() => {
    const expiries = effective.scheduledSent
      .map((r) => Date.parse(r.sentAt) + SENT_VISIBLE_MS)
      .filter((t) => Number.isFinite(t) && t > now);
    if (expiries.length === 0) return undefined;
    const id = window.setTimeout(() => setNow(Date.now()), Math.min(...expiries) - now + 50);
    return () => window.clearTimeout(id);
  }, [effective.scheduledSent, now]);

  const hideSent = useCallback((id: string) => {
    setHidden((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  return useMemo(() => {
    const pending: ScheduleRowData[] = [...effective.scheduledSends]
      .sort((a, b) => a.fireAt.localeCompare(b.fireAt) || a.id.localeCompare(b.id))
      .map((r) => ({ kind: "pending", ...r }));
    const failed: ScheduleRowData[] = effective.scheduledFailed.map((r) => ({ kind: "failed", ...r }));
    const sent: ScheduleRowData[] = effective.scheduledSent
      .filter((r) => !hidden.has(r.id) && Date.parse(r.sentAt) + SENT_VISIBLE_MS > now)
      .map((r) => ({ kind: "sent", ...r }));
    // Failed rows first: the Terminal strip shows 3 rows then scrolls, and a failed row is the
    // one needing action.
    const all = [...failed, ...pending, ...sent];
    return {
      rows: all.filter((r) => !isImmediate(r)),
      immediateRows: all.filter(isImmediate),
      hideSent,
    };
  }, [effective, hidden, now, hideSent]);
}
