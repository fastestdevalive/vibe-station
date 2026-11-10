import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { FileScope, SessionState, WSEvent } from "@/api/types";
import { useWorkspaceStore } from "./useStore";

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

/** Minimum spacing between two `lastChanged` bumps of one watch hook. */
export const WATCH_COALESCE_MS = 300;

/**
 * `lastChanged` plus a coalesced `bump`: the first event bumps immediately (a
 * single save still refreshes at once), further events inside
 * `WATCH_COALESCE_MS` collapse into ONE trailing bump.
 *
 * The daemon sends one `tree:changed` per changed PATH, each a separate WS
 * frame, and every bump re-runs each consumer's fetch effects (file body, diff,
 * gutter, tree, changed paths). Unthrottled, a checkout/rewrite/build in the
 * worktree turned into hundreds of requests per second — see `api/latestOnly.ts`.
 */
function useCoalescedBump() {
  const [lastChanged, setLastChanged] = useState(0);
  const state = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | null }>({ last: 0, timer: null });
  const cancel = useCallback(() => {
    if (state.current.timer) clearTimeout(state.current.timer);
    state.current.timer = null;
  }, []);
  const bump = useCallback(() => {
    const s = state.current;
    if (s.timer) return; // a trailing bump is already scheduled and will cover this event
    const fire = () => {
      s.timer = null;
      s.last = Date.now();
      setLastChanged(s.last);
    };
    const wait = s.last + WATCH_COALESCE_MS - Date.now();
    if (wait <= 0) fire();
    else s.timer = setTimeout(fire, wait);
  }, []);
  return { lastChanged, bump, cancel };
}

export function useFileWatch(
  api: ApiInstance,
  worktreeId: string | null,
  path: string | null,
  scope: FileScope = "worktree",
) {
  const { lastChanged, bump: bumpChanged, cancel } = useCoalescedBump();
  useEffect(() => {
    if (!worktreeId || !path) return undefined;
    void api.send({
      type: "file:watch",
      worktreeId,
      path,
      ...(scope === "project" ? { scope: "project" as const } : {}),
    });
    const bump = (ev: WSEvent) => {
      if ((ev.type === "file:changed" || ev.type === "file:deleted") && ev.worktreeId === worktreeId && ev.path === path) {
        bumpChanged();
      }
    };
    const offChanged = api.on("file:changed", bump);
    const offDeleted = api.on("file:deleted", bump);
    return () => {
      cancel();
      offChanged();
      offDeleted();
      void api.send({
        type: "file:unwatch",
        worktreeId,
        path,
        ...(scope === "project" ? { scope: "project" as const } : {}),
      });
    };
  }, [api, path, worktreeId, scope, bumpChanged, cancel]);
  return { lastChanged };
}

export function useTreeWatch(
  api: ApiInstance,
  worktreeId: string | null,
  scope: FileScope = "worktree",
) {
  const { lastChanged, bump, cancel } = useCoalescedBump();
  useEffect(() => {
    if (!worktreeId) return undefined;
    void api.send({
      type: "tree:watch",
      worktreeId,
      ...(scope === "project" ? { scope: "project" as const } : {}),
    });
    const off = api.on("tree:changed", (ev) => {
      if (ev.type === "tree:changed" && ev.worktreeId === worktreeId) bump();
    });
    return () => {
      cancel();
      off();
      void api.send({
        type: "tree:unwatch",
        worktreeId,
        ...(scope === "project" ? { scope: "project" as const } : {}),
      });
    };
  }, [api, worktreeId, scope, bump, cancel]);
  return { lastChanged };
}
