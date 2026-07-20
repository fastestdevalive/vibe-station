import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment, NormalizedEvent, SessionMeta } from "@/api/types";

/** An optimistic user turn rendered immediately after send, before the daemon's
 *  authoritative `user` event arrives. Deduped by `turnId` (Decision 12). */
export interface PendingTurn {
  turnId: string;
  message: string;
  attachments: Attachment[];
  /** True when the daemon queued it behind a running turn (queuePosition > 0). */
  queued: boolean;
}

/** Local prefill for a queued turn this tab is actively editing. */
export interface EditingDraft {
  message: string;
  attachments: Attachment[];
}

export interface UseChatResult {
  /** Authoritative normalized events (replay + live). */
  events: NormalizedEvent[];
  /** Latest cross-harness meta (usage/model/turn-state). */
  meta: SessionMeta | null;
  /** Optimistic user turns not yet reflected in `events`. */
  pending: PendingTurn[];
  /** True while awaiting the initial `chat:replay`. */
  loading: boolean;
  /** True when older pages exist before the loaded window (drives "load earlier"). */
  hasMore: boolean;
  /** True while a `loadEarlier`/`loadAll` fetch is in flight. */
  loadingEarlier: boolean;
  /** Fetch + prepend the previous keyset page of history (R2.2). No-op at the top. */
  loadEarlier: () => Promise<void>;
  /** Guarded escape hatch: fetch the WHOLE transcript and merge it in (R2.5). */
  loadAll: () => Promise<void>;
  /** Runnable queued turnIds (from meta) — drives per-turn affordances. */
  queuedTurnIds: string[];
  /** turnIds withdrawn into the editing hold (from meta) — "editing" state. */
  editingTurnIds: string[];
  /** Prefill content for turns THIS tab is editing (keyed by turnId). */
  editingDrafts: Record<string, EditingDraft>;
  /** Enqueue a user turn. Returns the daemon turnId + queue position. */
  send: (message: string, attachmentIds?: string[]) => Promise<void>;
  /** Abort the active turn (keeps queued turns). */
  stop: () => Promise<void>;
  /** Cancel one queued (not-yet-started) turn. */
  cancelQueued: (turnId: string) => Promise<void>;
  /** Withdraw a queued turn for editing (opens the inline editor). */
  editQueued: (turnId: string) => Promise<void>;
  /** Save an edit → resubmit `{edited:true}`. Throws on failure (caller salvages, A9). */
  saveEdit: (turnId: string, message: string, attachmentIds: string[]) => Promise<void>;
  /** Discard an edit → resubmit `{edited:false}` (restore unchanged). */
  discardEdit: (turnId: string) => Promise<void>;
  /** "Send now" — preempt: jump a queued turn to the front AND interrupt the
   *  active turn so it runs next (the interrupted turn is dropped). */
  sendNow: (turnId: string) => Promise<void>;
  /** Edit an already-answered turn → fork: truncate after it and re-run the
   *  edited message from that point (claude only, R3.1). */
  forkTurn: (turnId: string, message: string, attachmentIds?: string[]) => Promise<void>;
}

/**
 * Subscribes to a JSON agent session's normalized event stream.
 *
 * On mount (and whenever `sessionId` changes) it opens the chat, merges the
 * `chat:replay` transcript, then appends live `session:message` events and
 * tracks `session:meta`. The optimistic user bubble is deduped against the
 * daemon's authoritative `user` event by `turnId` (Decision 12). Closes the
 * chat on unmount.
 *
 * Pass `enabled=false` (e.g. the pane is hidden / session is a TTY) to keep the
 * hook mounted without opening a chat — no WS traffic, empty state.
 */
export function useChat(
  api: ApiInstance,
  sessionId: string | null,
  enabled = true,
): UseChatResult {
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [pending, setPending] = useState<PendingTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [editingDrafts, setEditingDrafts] = useState<Record<string, EditingDraft>>({});

  /** turnIds that have an authoritative `user` event — used to dedupe optimistic
   *  bubbles when the daemon echo lands (possibly before `send` resolves). */
  const userTurnIdsRef = useRef<Set<string>>(new Set());
  /** Keyset cursor: `logSeq` of the oldest loaded event + whether older rows
   *  exist. Refs (not just state) so `loadEarlier` reads current values without
   *  re-subscribing. */
  const oldestSeqRef = useRef<number | null>(null);
  const hasMoreRef = useRef(false);

  const active = enabled && !!sessionId;

  useEffect(() => {
    if (!active || !sessionId) {
      setEvents([]);
      setMeta(null);
      setPending([]);
      setLoading(false);
      setHasMore(false);
      setLoadingEarlier(false);
      setEditingDrafts({});
      userTurnIdsRef.current = new Set();
      oldestSeqRef.current = null;
      hasMoreRef.current = false;
      return;
    }

    setLoading(true);
    setEvents([]);
    setMeta(null);
    setHasMore(false);
    setLoadingEarlier(false);
    setEditingDrafts({});
    userTurnIdsRef.current = new Set();
    oldestSeqRef.current = null;
    hasMoreRef.current = false;

    const noteUserTurn = (ev: NormalizedEvent) => {
      if (ev.kind === "user" && ev.turnId) {
        userTurnIdsRef.current.add(ev.turnId);
        setPending((prev) => prev.filter((p) => p.turnId !== ev.turnId));
      }
    };

    const offReplay = api.on("chat:replay", (e) => {
      if (e.type !== "chat:replay" || e.sessionId !== sessionId) return;
      // Delta-MERGE, never replace (R2.7): the replay may arrive after a live
      // gap event, or be a `sinceSeq` delta on reconnect. Union the user-turn
      // bookkeeping so queued-tray dedup survives for turns outside the window.
      for (const ev of e.events) {
        if (ev.kind === "user" && ev.turnId) userTurnIdsRef.current.add(ev.turnId);
      }
      setEvents((prev) => mergeEvents([...e.events, ...prev]));
      // Cursor fields are present only on a bounded tail replay (omitted on a
      // `sinceSeq` delta) — don't let a delta reset the window's top cursor.
      if (e.hasMore !== undefined) {
        hasMoreRef.current = e.hasMore;
        setHasMore(e.hasMore);
        oldestSeqRef.current = e.oldestSeq ?? null;
      }
      setPending((prev) => prev.filter((p) => !userTurnIdsRef.current.has(p.turnId)));
      setLoading(false);
    });

    const offMsg = api.on("session:message", (e) => {
      if (e.type !== "session:message" || e.sessionId !== sessionId) return;
      const ev = e.event;
      noteUserTurn(ev);
      setEvents((prev) => (ev.id && prev.some((x) => x.id === ev.id) ? prev : [...prev, ev]));
      // A live event proves the stream is up — clear any replay-loading state.
      setLoading(false);
    });

    const offMeta = api.on("session:meta", (e) => {
      if (e.type !== "session:meta" || e.sessionId !== sessionId) return;
      setMeta(e.meta);
    });

    // A fork truncated some turns (R3.6): drop the superseded bubbles + any local
    // pending/editing bookkeeping for them so this tab re-syncs to the new head.
    // The new fork user event arrives separately via `session:message`.
    const offFork = api.on("session:fork", (e) => {
      if (e.type !== "session:fork" || e.sessionId !== sessionId) return;
      const dropped = new Set(e.supersededTurnIds);
      if (dropped.size === 0) return;
      for (const t of dropped) userTurnIdsRef.current.delete(t);
      setEvents((prev) => prev.filter((ev) => !ev.turnId || !dropped.has(ev.turnId)));
      setPending((prev) => prev.filter((p) => !dropped.has(p.turnId)));
      setEditingDrafts((prev) => {
        let next = prev;
        for (const t of dropped) next = dropKey(next, t);
        return next;
      });
    });

    void api.openChat(sessionId);

    return () => {
      offReplay();
      offMsg();
      offMeta();
      offFork();
      void api.closeChat(sessionId);
    };
  }, [api, sessionId, active]);

  const send = useCallback(
    async (message: string, attachmentIds?: string[]) => {
      if (!sessionId) return;
      const res = await api.sendChat(sessionId, message, attachmentIds);
      // Dedupe: only add the optimistic bubble if the authoritative `user` event
      // for this turnId hasn't already landed (Decision 12).
      setPending((prev) => {
        if (userTurnIdsRef.current.has(res.turnId)) return prev;
        if (prev.some((p) => p.turnId === res.turnId)) return prev;
        return [...prev, { turnId: res.turnId, message, attachments: [], queued: res.queuePosition > 0 }];
      });
    },
    [api, sessionId],
  );

  const stop = useCallback(async () => {
    if (!sessionId) return;
    await api.stopChat(sessionId);
  }, [api, sessionId]);

  const cancelQueued = useCallback(
    async (turnId: string) => {
      if (!sessionId) return;
      await api.cancelQueuedTurn(sessionId, turnId);
      setPending((prev) => prev.filter((p) => p.turnId !== turnId));
      setEditingDrafts((prev) => dropKey(prev, turnId));
    },
    [api, sessionId],
  );

  const editQueued = useCallback(
    async (turnId: string) => {
      if (!sessionId) return;
      const res = await api.beginEditQueuedTurn(sessionId, turnId);
      setEditingDrafts((prev) => ({
        ...prev,
        [turnId]: { message: res.message, attachments: res.attachments },
      }));
    },
    [api, sessionId],
  );

  const saveEdit = useCallback(
    async (turnId: string, message: string, attachmentIds: string[]) => {
      if (!sessionId) return;
      try {
        await api.resubmitQueuedTurn(sessionId, turnId, { edited: true, message, attachmentIds });
      } finally {
        // Close the editor whether it succeeded or not — on failure the caller
        // salvages the text into the composer (A9).
        setEditingDrafts((prev) => dropKey(prev, turnId));
      }
    },
    [api, sessionId],
  );

  const discardEdit = useCallback(
    async (turnId: string) => {
      if (!sessionId) return;
      setEditingDrafts((prev) => dropKey(prev, turnId));
      await api.resubmitQueuedTurn(sessionId, turnId, { edited: false });
    },
    [api, sessionId],
  );

  const sendNow = useCallback(
    async (turnId: string) => {
      if (!sessionId) return;
      await api.promoteQueuedTurn(sessionId, turnId);
    },
    [api, sessionId],
  );

  const forkTurn = useCallback(
    async (turnId: string, message: string, attachmentIds?: string[]) => {
      if (!sessionId) return;
      await api.forkChat(sessionId, turnId, message, attachmentIds);
    },
    [api, sessionId],
  );

  /** Prepend the previous keyset page (R2.2). Guarded against concurrent runs
   *  and the top-of-history (`hasMore` false / no cursor). */
  const loadEarlier = useCallback(async () => {
    if (!sessionId) return;
    if (!hasMoreRef.current || oldestSeqRef.current == null) return;
    setLoadingEarlier(true);
    try {
      const page = await api.getTranscriptPage(sessionId, oldestSeqRef.current);
      for (const ev of page.events) {
        if (ev.kind === "user" && ev.turnId) userTurnIdsRef.current.add(ev.turnId);
      }
      setEvents((prev) => mergeEvents([...page.events, ...prev]));
      oldestSeqRef.current = page.oldestSeq ?? oldestSeqRef.current;
      hasMoreRef.current = page.hasMore;
      setHasMore(page.hasMore);
    } finally {
      setLoadingEarlier(false);
    }
  }, [api, sessionId]);

  /** Load the WHOLE transcript (guarded "load all" escape hatch, R2.5). */
  const loadAll = useCallback(async () => {
    if (!sessionId) return;
    setLoadingEarlier(true);
    try {
      const { events: all } = await api.getTranscriptAll(sessionId);
      for (const ev of all) {
        if (ev.kind === "user" && ev.turnId) userTurnIdsRef.current.add(ev.turnId);
      }
      setEvents((prev) => mergeEvents([...all, ...prev]));
      oldestSeqRef.current = all.length ? (all[0]!.logSeq ?? null) : oldestSeqRef.current;
      hasMoreRef.current = false;
      setHasMore(false);
    } finally {
      setLoadingEarlier(false);
    }
  }, [api, sessionId]);

  return {
    events,
    meta,
    pending,
    loading,
    hasMore,
    loadingEarlier,
    loadEarlier,
    loadAll,
    queuedTurnIds: meta?.queuedTurnIds ?? [],
    editingTurnIds: meta?.editingTurnIds ?? [],
    editingDrafts,
    send,
    stop,
    cancelQueued,
    editQueued,
    saveEdit,
    discardEdit,
    sendNow,
    forkTurn,
  };
}

/**
 * Union a set of events, deduped by `id` (last wins) and ordered by the durable
 * `logSeq` cursor — so prepended older pages, appended live events, gap-overlap,
 * and reconnect deltas all resolve to one correctly-ordered window (R2.7).
 */
function mergeEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  const byId = new Map<string, NormalizedEvent>();
  for (const ev of events) byId.set(ev.id, ev);
  return [...byId.values()].sort((a, b) => (a.logSeq ?? 0) - (b.logSeq ?? 0));
}

/** Return a copy of `obj` without `key` (immutable delete). */
function dropKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}
