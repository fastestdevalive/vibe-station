import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import { OUTLINE_UNAVAILABLE, OUTLINE_UNSUPPORTED } from "@/api/transcriptOutlineClient";
import type { TranscriptOutlineSummary } from "@/api/types";
import * as outlineCache from "./transcriptOutlineCache";

type OutlineStatus = "idle" | "loading" | "building" | "ready" | "unsupported" | "error";

/** Fixed-size bucketed counts of the whole chat (wire type: `TranscriptOutlineSummary` in `api/types.ts`). */
export interface OutlineSummaryState {
  status: OutlineStatus;
  totalTurns: number;
  bucketSize: number;
  tools: readonly number[];
  edits: readonly number[];
  errors: readonly number[];
  revision: string;
}

/** A bounded retry while the daemon builds the session's index (1.5 s apart, at most 40 times). */
const BUILD_RETRY_MS = 1500;
const BUILD_RETRY_LIMIT = 40;

const EMPTY_BUCKETS = { totalTurns: 0, bucketSize: 1, tools: [], edits: [], errors: [], revision: "" } as const;
const IDLE: OutlineSummaryState = { status: "idle", ...EMPTY_BUCKETS };
const LOADING: OutlineSummaryState = { status: "loading", ...EMPTY_BUCKETS };
const BUILDING: OutlineSummaryState = { status: "building", ...EMPTY_BUCKETS };
const ERROR: OutlineSummaryState = { status: "error", ...EMPTY_BUCKETS };
const UNSUPPORTED: OutlineSummaryState = { status: "unsupported", ...EMPTY_BUCKETS };

interface Slot {
  sessionId: string | null;
  state: OutlineSummaryState;
}

function fromSummary(s: TranscriptOutlineSummary): OutlineSummaryState {
  return { status: "ready", totalTurns: s.totalTurns, bucketSize: s.bucketSize, tools: s.tools, edits: s.edits, errors: s.errors, revision: s.revision };
}

/** A daemon without the endpoint, or one whose outline is disabled, falls back at once; anything else is an error. */
function failureState(err: unknown): OutlineSummaryState {
  if (err instanceof ApiError) {
    if (err.code === OUTLINE_UNSUPPORTED || err.code === OUTLINE_UNAVAILABLE) return UNSUPPORTED;
    if (err.code === undefined && (err.status === 404 || err.status === 405 || err.status === 501)) return UNSUPPORTED;
  }
  return ERROR;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Fetches the summary, retrying while the index builds; `emit` sees every state change in order. */
async function loadSummary(
  api: ApiInstance,
  sessionId: string,
  signal: AbortSignal,
  emit: (state: OutlineSummaryState) => void,
): Promise<void> {
  let retries = 0;
  for (;;) {
    let summary: TranscriptOutlineSummary;
    try {
      summary = await api.getTranscriptOutline(sessionId, signal);
    } catch (err) {
      if (!signal.aborted) emit(failureState(err));
      return;
    }
    if (signal.aborted) return;
    if (summary.ready) {
      const state = fromSummary(summary);
      outlineCache.save(sessionId, state);
      emit(state);
      return;
    }
    emit(BUILDING);
    if (retries >= BUILD_RETRY_LIMIT) {
      emit(ERROR);
      return;
    }
    retries += 1;
    await sleep(BUILD_RETRY_MS, signal);
    if (signal.aborted) return;
  }
}

const sameCounts = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/** Two ready states with identical data: a refetch of an unchanged chat must not replace the state object. */
function sameSummary(a: OutlineSummaryState, b: OutlineSummaryState): boolean {
  return (
    a.status === "ready" &&
    b.status === "ready" &&
    a.revision === b.revision &&
    a.totalTurns === b.totalTurns &&
    a.bucketSize === b.bucketSize &&
    sameCounts(a.tools, b.tools) &&
    sameCounts(a.edits, b.edits) &&
    sameCounts(a.errors, b.errors)
  );
}

/** A burst of live user turns refetches the summary once. */
const LIVE_TURN_REFETCH_MS = 150;

/**
 * Whole-chat outline summary for one session. Fetched on mount, `ws:open`, and `session:fork` (which drops
 * the summary at once); `refreshToken` changes force a refetch (the owner bumps it on a window revision mismatch).
 * A live non-silent user event refetches the summary (debounced) instead of counting a turn
 * locally: the summary may already hold the event's turn, which a local +1 would count twice. A refetch
 * that returns identical data keeps the previous state object.
 */
export function useTranscriptOutline(
  api: ApiInstance,
  sessionId: string | null,
  enabled = true,
  refreshToken = 0,
): OutlineSummaryState {
  const active = enabled && sessionId != null ? sessionId : null;
  const [tick, setTick] = useState(0);
  const [slot, setSlot] = useState<Slot>({ sessionId: null, state: IDLE });
  // Mirrors `slot` synchronously, for the live-event handler (which must read the state it patches).
  const slotRef = useRef(slot);
  // Highest live user logSeq seen for the active session: a replayed event at or below it refetches nothing.
  const lastSeqRef = useRef<{ sessionId: string; seq: number } | null>(null);
  const refreshSeenRef = useRef(refreshToken);

  const commit = useCallback((sid: string, state: OutlineSummaryState) => {
    const held = slotRef.current;
    if (held.sessionId === sid && sameSummary(held.state, state)) return;
    const next: Slot = { sessionId: sid, state };
    slotRef.current = next;
    setSlot(next);
  }, []);

  useEffect(() => {
    if (active == null) return;
    const ac = new AbortController();
    // A session switch shows the cached summary of the new session (or loading), never the previous one.
    // A refresh token change (a window revision mismatch) drops the summary, cache included, before refetching.
    const refreshed = refreshSeenRef.current !== refreshToken;
    refreshSeenRef.current = refreshToken;
    if (refreshed) outlineCache.evict(active);
    if (refreshed || slotRef.current.sessionId !== active) commit(active, outlineCache.restore(active) ?? LOADING);
    void loadSummary(api, active, ac.signal, (state) => {
      if (ac.signal.aborted) return;
      // A failed refetch keeps the held ready value (last-known on transient error).
      if (state.status === "error") {
        const held = slotRef.current;
        if (held.sessionId === active && held.state.status === "ready") return;
      }
      commit(active, state);
    });
    return () => ac.abort();
  }, [api, active, tick, refreshToken, commit]);

  useEffect(() => {
    if (active == null) return;
    const sid = active;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const offMessage = api.on("session:message", (e) => {
      if (e.type !== "session:message" || e.sessionId !== sid) return;
      const ev = e.event;
      if (ev.kind !== "user" || ev.silent || ev.superseded || ev.logSeq == null) return;
      const last = lastSeqRef.current?.sessionId === sid ? lastSeqRef.current.seq : -1;
      if (ev.logSeq <= last) return;
      lastSeqRef.current = { sessionId: sid, seq: ev.logSeq };
      const current = slotRef.current;
      // A summary that errored retries once per new live user turn (the dedup above bounds it).
      if (current.sessionId !== sid || (current.state.status !== "ready" && current.state.status !== "error")) return;
      if (refetchTimer != null) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        setTick((n) => n + 1);
      }, LIVE_TURN_REFETCH_MS);
    });
    const offOpen = api.on("ws:open", () => setTick((n) => n + 1));
    const offFork = api.on("session:fork", (e) => {
      if (e.type !== "session:fork" || e.sessionId !== sid) return;
      outlineCache.evict(sid);
      commit(sid, LOADING);
      setTick((n) => n + 1);
    });
    const offAuth = api.on("auth:expired", () => outlineCache.clear());
    return () => {
      if (refetchTimer != null) clearTimeout(refetchTimer);
      offMessage();
      offOpen();
      offFork();
      offAuth();
    };
  }, [api, active, commit]);

  if (active == null) return IDLE;
  return slot.sessionId === active ? slot.state : (outlineCache.restore(active) ?? LOADING);
}
