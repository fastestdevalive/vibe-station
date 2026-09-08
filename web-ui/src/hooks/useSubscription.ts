import { useEffect, useMemo, useState } from "react";
import type { ApiInstance } from "@/api";
import type { DiffStat, FileScope, SessionState, WSEvent } from "@/api/types";
import { useWorkspaceStore } from "./useStore";

/** How often `useWorktreeDiffStats` re-polls — matches the PR poller's
 *  existing 30s cadence (`docs/STATUS-INDICATORS.md`), Decision 11. */
const DIFF_STAT_POLL_MS = 30_000;

export function useSubscription(sessionIds: string[], api: ApiInstance) {
  const key = useMemo(() => [...sessionIds].sort().join(","), [sessionIds]);
  useEffect(() => {
    if (!key) return undefined;
    return api.subscribe(key.split(",").filter(Boolean));
  }, [api, key]);
}

/**
 * Subscribes to session lifecycle events and returns the current state.
 * Does NOT forward output chunks — TerminalPane subscribes to
 * "session:output" directly and writes to xterm synchronously, because
 * routing chunks through React state drops them: identical consecutive
 * chunks (e.g. repeated backspace echoes "\b \b") cause React to bail out
 * of the re-render, and chunks arriving in the same tick get coalesced
 * to the last value.
 *
 * Does NOT call openSession — the caller (TerminalPane) must call
 * api.openSession(sessionId, cols, rows) after the terminal is properly
 * sized, so the backend resizes the pty and replays scrollback at the
 * right dimensions.
 */
export function useSessionOutput(
  api: ApiInstance,
  sessionId: string | null,
) {
  const [sessionState, setSessionState] = useState<SessionState | null>(null);

  useSubscription(sessionId ? [sessionId] : [], api);

  // Reset local state when switching sessions so a previous "exited" doesn't
  // leak into the newly-selected session's banner.
  useEffect(() => {
    setSessionState(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return undefined;
    const offState = api.on("session:state", (ev) => {
      if (ev.type === "session:state" && ev.sessionId === sessionId) setSessionState(ev.state);
    });
    const offExited = api.on("session:exited", (ev) => {
      if (ev.type === "session:exited" && ev.sessionId === sessionId) setSessionState("exited");
    });
    // session:error → exited, EXCEPT during the spawn phase. The store's
    // sessionStates is the source of truth: it reflects both syncSessionsFromApi
    // (so a session that was "idle" before a daemon restart is correctly seen
    // as idle here) and prior session:state events (so a session that was just
    // observed working is seen as working). We only suppress the flip when the
    // session is genuinely still spawning (state === "not_started") — in that
    // window, "not running" errors are a race with spawnSession, not a real
    // exit, and the eventual session:state event will update us.
    const offError = api.on("session:error", (ev) => {
      if (ev.type !== "session:error" || ev.sessionId !== sessionId) return;
      // Only the daemon's explicit "gone" classification implies an exit.
      // We used to regex-match ev.message for /not found|exited|.../, which
      // latched the Resume banner onto healthy sessions: a "Session not found"
      // (direct sessions were invisible to the WS lookup) or a non-zero
      // `tmux attach-session` exit both matched while the agent was alive.
      // "transient" errors are stream hiccups and must never flip state — the
      // daemon's lifecycle poller owns exit detection and broadcasts
      // session:exited.
      if (ev.reason !== "gone") return;
      const known = useWorkspaceStore.getState().sessionStates[sessionId];
      if (known === "not_started") return; // race during fresh spawn
      setSessionState("exited");
    });
    // Resume re-spawns a fresh tmux pane on the daemon. Clear local exited
    // state so the Resume banner goes away and the live UI reflects working.
    const offResumed = api.on("session:resumed", (ev) => {
      if (ev.type === "session:resumed" && ev.sessionId === sessionId) {
        setSessionState("working");
      }
    });
    return () => {
      offState();
      offExited();
      offError();
      offResumed();
      void api.closeSession(sessionId);
    };
  }, [api, sessionId]);

  return { sessionState };
}

export function useFileWatch(
  api: ApiInstance,
  worktreeId: string | null,
  path: string | null,
  scope: FileScope = "worktree",
) {
  const [lastChanged, setLastChanged] = useState(0);
  useEffect(() => {
    // The daemon only watches worktree paths; project-scoped (direct-session)
    // files have no watcher, so skip the subscription entirely.
    if (scope === "project") return undefined;
    if (!worktreeId || !path) return undefined;
    void api.send({ type: "file:watch", worktreeId, path });
    const bump = (ev: WSEvent) => {
      if ((ev.type === "file:changed" || ev.type === "file:deleted") && ev.worktreeId === worktreeId && ev.path === path) {
        setLastChanged(Date.now());
      }
    };
    const offChanged = api.on("file:changed", bump);
    const offDeleted = api.on("file:deleted", bump);
    return () => {
      offChanged();
      offDeleted();
      void api.send({ type: "file:unwatch", worktreeId, path });
    };
  }, [api, path, worktreeId, scope]);
  return { lastChanged };
}

/**
 * Batched, single-interval diffstat poll for the worktree sidebar's `+N −N`
 * indicator (Decision 11, item 10) — one `setInterval` fetching every visible
 * worktree id's diffstat via `Promise.all`, not one interval per row (which
 * would mean N concurrent daemon calls every tick for no benefit).
 *
 * An id absent from `worktreeIds` on a later render is NOT pruned from the
 * returned record — the reducer below only ever spreads `prev` and writes
 * entries for the current `ids`, it never deletes a key that has dropped out
 * of `worktreeIds`. In practice this is harmless (the sidebar only reads
 * `stats[w.id]` for worktrees it's currently rendering), but a stale id's
 * stat does linger in the record indefinitely rather than being dropped.
 *
 * `poll()` fires immediately whenever `key` (the sorted, joined id list)
 * changes — including on mount and every time `worktreeIds` gains/loses an
 * id — in addition to the steady `DIFF_STAT_POLL_MS` interval; it does not
 * wait out the rest of the current interval first, so a caller that churns
 * `worktreeIds` rapidly can trigger fetches more often than the nominal poll
 * interval.
 *
 * Returns `null` for any id whose fetch is still in flight (first render
 * after it appears) or whose last fetch failed — never `undefined`, so
 * callers can render a stable "no data yet" state without an `in` check.
 */
export function useWorktreeDiffStats(
  api: ApiInstance,
  worktreeIds: string[],
): Record<string, DiffStat | null> {
  const key = useMemo(() => [...worktreeIds].sort().join(","), [worktreeIds]);
  const [stats, setStats] = useState<Record<string, DiffStat | null>>({});

  useEffect(() => {
    const ids = key ? key.split(",").filter(Boolean) : [];
    if (ids.length === 0) {
      setStats({});
      return undefined;
    }
    // Seed any newly-visible id with `null` immediately so it renders as
    // "no data yet" rather than being silently absent while the first fetch
    // for it is in flight.
    setStats((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        if (!(id in next)) {
          next[id] = null;
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    let cancelled = false;
    const poll = () => {
      void Promise.all(
        ids.map(async (id) => {
          try {
            return [id, await api.getDiffStat(id)] as const;
          } catch {
            return [id, null] as const;
          }
        }),
      ).then((entries) => {
        if (cancelled) return;
        setStats((prev) => {
          const next = { ...prev };
          for (const [id, stat] of entries) next[id] = stat;
          return next;
        });
      });
    };
    poll();
    const interval = setInterval(poll, DIFF_STAT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api, key]);

  return stats;
}

export function useTreeWatch(
  api: ApiInstance,
  worktreeId: string | null,
  scope: FileScope = "worktree",
) {
  const [lastChanged, setLastChanged] = useState(0);
  useEffect(() => {
    // No daemon-side tree watcher for project scope (direct sessions).
    if (scope === "project") return undefined;
    if (!worktreeId) return undefined;
    void api.send({ type: "tree:watch", worktreeId });
    const off = api.on("tree:changed", (ev) => {
      if (ev.type === "tree:changed" && ev.worktreeId === worktreeId) setLastChanged(Date.now());
    });
    return () => {
      off();
      void api.send({ type: "tree:unwatch", worktreeId });
    };
  }, [api, worktreeId, scope]);
  return { lastChanged };
}
