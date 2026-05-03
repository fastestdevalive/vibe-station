import { useEffect, useMemo, useState } from "react";
import type { ApiInstance } from "@/api";
import type { SessionState, WSEvent } from "@/api/types";

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
    // session:error fires for several reasons. Only mark exited when the
    // message indicates the session is actually gone — not for transient
    // duplicate-open errors that React StrictMode triggers in dev.
    const offError = api.on("session:error", (ev) => {
      if (
        ev.type === "session:error" &&
        ev.sessionId === sessionId &&
        /not found|exited|can't find pane/i.test(ev.message)
      ) {
        setSessionState("exited");
      }
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

export function useFileWatch(api: ApiInstance, worktreeId: string | null, path: string | null) {
  const [lastChanged, setLastChanged] = useState(0);
  useEffect(() => {
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
  }, [api, path, worktreeId]);
  return { lastChanged };
}

export function useTreeWatch(api: ApiInstance, worktreeId: string | null) {
  const [lastChanged, setLastChanged] = useState(0);
  useEffect(() => {
    if (!worktreeId) return undefined;
    void api.send({ type: "tree:watch", worktreeId });
    const off = api.on("tree:changed", (ev) => {
      if (ev.type === "tree:changed" && ev.worktreeId === worktreeId) setLastChanged(Date.now());
    });
    return () => {
      off();
      void api.send({ type: "tree:unwatch", worktreeId });
    };
  }, [api, worktreeId]);
  return { lastChanged };
}
