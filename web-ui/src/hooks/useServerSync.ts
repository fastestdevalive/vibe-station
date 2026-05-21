import { useEffect } from "react";
import type { ApiInstance } from "@/api";
import { useServerStore } from "./useServerStore";
import { useWorkspaceStore } from "./useStore";

/**
 * Module-level in-flight guard. Collapses three refresh triggers that all
 * happen within milliseconds of each other on initial load into a single
 * HTTP round-trip:
 *   1. The mount-time fetch (Workspace mounts the hook).
 *   2. React StrictMode's deliberate unmount → remount in dev (the cleanup
 *      can't abort the in-flight request).
 *   3. The first `ws:open` event, which fires right after the WS handshake
 *      completes — typically still during the mount fetch's request.
 * After the in-flight promise settles, the next ws:open (a real reconnect)
 * fires a fresh fetch as intended.
 */
let inFlightRefresh: Promise<void> | null = null;

/**
 * Mount once at the top of the authenticated app (in `Workspace`). Owns:
 *
 *   1. The initial bundle fetch (projects/worktrees/sessions in parallel).
 *   2. A refetch on every `ws:open` — initial connect AND every reconnect —
 *      so persisted client caches can't strand a stale view when another
 *      client mutated state while we were offline.
 *   3. The patch reducers for incremental WS events. We update the central
 *      `useServerStore` plus the persisted live `sessionStates` in one place
 *      instead of letting LeftSidebar and DashboardPanel each wire their own.
 *
 * Calling `syncSessionsFromApi` on every refetch is the load-bearing line for
 * the cross-client "done" bug: persisted `sessionStates` survives reload and
 * was beating fresh REST truth in the worktree rollup.
 */
export function useServerSync(api: ApiInstance): void {
  const replaceAll = useServerStore((s) => s.replaceAll);
  const applyProjectCreated = useServerStore((s) => s.applyProjectCreated);
  const applyProjectDeleted = useServerStore((s) => s.applyProjectDeleted);
  const applyWorktreeCreated = useServerStore((s) => s.applyWorktreeCreated);
  const applyWorktreeDeleted = useServerStore((s) => s.applyWorktreeDeleted);
  const applySessionCreated = useServerStore((s) => s.applySessionCreated);
  const applySessionUpdated = useServerStore((s) => s.applySessionUpdated);
  const applySessionDeleted = useServerStore((s) => s.applySessionDeleted);
  const syncSessionsFromApi = useWorkspaceStore((s) => s.syncSessionsFromApi);
  const patchSessionState = useWorkspaceStore((s) => s.patchSessionState);

  // Refetch on initial mount AND on every WS handshake — dedup via the
  // module-level in-flight guard so the three near-simultaneous triggers on
  // initial load (mount + StrictMode remount + first ws:open) collapse into
  // one HTTP round-trip.
  useEffect(() => {
    function refresh(): Promise<void> {
      if (inFlightRefresh) return inFlightRefresh;
      inFlightRefresh = (async () => {
        try {
          const [projects, worktrees, sessions] = await Promise.all([
            api.listProjects(),
            api.listWorktrees(),
            api.listSessions(),
          ]);
          replaceAll({ projects, worktrees, sessions });
          // Overlay fresh REST state onto the persisted live map. Without
          // this, a "done"/"exited" terminal state set by another client
          // while we were offline never overrides our cached "working"/
          // "idle" entry, and the rollup keeps showing the worktree active.
          syncSessionsFromApi(sessions);
        } finally {
          inFlightRefresh = null;
        }
      })();
      return inFlightRefresh;
    }

    void refresh();
    const off = api.on("ws:open", () => {
      void refresh();
    });
    return off;
  }, [api, replaceAll, syncSessionsFromApi]);

  // Incremental WS event reducers — keep the store current between full
  // refreshes so we don't have to refetch for every transition.
  useEffect(() => {
    const offProjCreated = api.on("project:created", (ev) => {
      if (ev.type === "project:created") applyProjectCreated(ev.project);
    });
    const offProjDeleted = api.on("project:deleted", (ev) => {
      if (ev.type === "project:deleted") applyProjectDeleted(ev.projectId);
    });
    const offWtCreated = api.on("worktree:created", (ev) => {
      if (ev.type === "worktree:created") applyWorktreeCreated(ev.worktree);
    });
    const offWtDeleted = api.on("worktree:deleted", (ev) => {
      if (ev.type === "worktree:deleted") applyWorktreeDeleted(ev.worktreeId);
    });
    const offSessCreated = api.on("session:created", (ev) => {
      if (ev.type === "session:created" && ev.snapshot) {
        applySessionCreated(ev.snapshot);
        patchSessionState(ev.snapshot.id, ev.snapshot.state);
      }
    });
    const offSessState = api.on("session:state", (ev) => {
      if (ev.type === "session:state") {
        applySessionUpdated(ev.sessionId, { state: ev.state });
        patchSessionState(ev.sessionId, ev.state);
      }
    });
    const offSessExited = api.on("session:exited", (ev) => {
      if (ev.type === "session:exited") {
        applySessionUpdated(ev.sessionId, { state: "exited" });
        patchSessionState(ev.sessionId, "exited");
      }
    });
    const offSessResumed = api.on("session:resumed", (ev) => {
      if (ev.type === "session:resumed") {
        applySessionUpdated(ev.sessionId, { state: "working" });
        patchSessionState(ev.sessionId, "working");
      }
    });
    const offSessDeleted = api.on("session:deleted", (ev) => {
      if (ev.type === "session:deleted") applySessionDeleted(ev.sessionId);
    });
    return () => {
      offProjCreated();
      offProjDeleted();
      offWtCreated();
      offWtDeleted();
      offSessCreated();
      offSessState();
      offSessExited();
      offSessResumed();
      offSessDeleted();
    };
  }, [
    api,
    applyProjectCreated,
    applyProjectDeleted,
    applyWorktreeCreated,
    applyWorktreeDeleted,
    applySessionCreated,
    applySessionUpdated,
    applySessionDeleted,
    patchSessionState,
  ]);
}
