import { useEffect } from "react";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useServerStore } from "./useServerStore";
import {
  useWorkspaceStore,
  findScratchCanvasesTilingSession,
  findWorkspacesTilingSession,
  resolveSupersededChains,
} from "./useStore";

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

/** Dedup guard for `syncPinnedOrder`, mirroring `inFlightRefresh` above. */
let inFlightPinnedOrderSync: Promise<void> | null = null;

/**
 * Set while a `pinned-all` `PUT /user/ordered-lists/pinned-all` (LeftSidebar's
 * drag handler) is in flight. Guards `syncPinnedOrder`'s hydrate branch below
 * from clobbering a just-made local drag with a stale server value fetched by
 * a reconnect-triggered refresh landing mid-write (pinned-order-sync CUJ 1
 * "Reconnect race"). `clearOrderedListWrite` is compare-and-clear so a second
 * drag's still-pending write can't be cleared early by the first drag's
 * `finally` settling after a newer write started (Risk 4).
 */
let orderedListWriteInFlight: Promise<unknown> | null = null;

export function markOrderedListWrite(p: Promise<unknown>): void {
  orderedListWriteInFlight = p;
}

export function clearOrderedListWrite(p: Promise<unknown>): void {
  if (orderedListWriteInFlight === p) orderedListWriteInFlight = null;
}

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
  const applyProjectUpdated = useServerStore((s) => s.applyProjectUpdated);
  const applyWorktreeCreated = useServerStore((s) => s.applyWorktreeCreated);
  const applyWorktreeDeleted = useServerStore((s) => s.applyWorktreeDeleted);
  const applyWorktreeUpdated = useServerStore((s) => s.applyWorktreeUpdated);
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
          // Resolve any supersededBy chain this client missed the broadcast
          // for (offline during a reset, or the reset came from the CLI with
          // no browser connected).
          for (const { oldId, finalId } of resolveSupersededChains(sessions)) {
            useWorkspaceStore.getState().relinkSessionTiles(oldId, finalId);
          }
        } finally {
          inFlightRefresh = null;
        }
      })();
      return inFlightRefresh;
    }

    // Pinned-order-sync (Decision 5): mirrors `refresh()`'s trigger points
    // (mount + every `ws:open`, including reconnects) but is a separate,
    // independently-dedup'd resource — a stale bundle refetch racing this
    // is unrelated. The hydrate branch is skipped while a local drag's
    // write is in flight (`orderedListWriteInFlight`) so a reconnect landing
    // mid-drag can't clobber the just-made local order with a stale server
    // value; the pending write's own response/WS-echo settles it right after.
    function syncPinnedOrder(): Promise<void> {
      if (inFlightPinnedOrderSync) return inFlightPinnedOrderSync;
      inFlightPinnedOrderSync = (async () => {
        try {
          const pinnedOrder = await api.getOrderedList("pinned-all");
          if (pinnedOrder.updatedAt === null) {
            const local = useWorkspaceStore.getState().sortOrders["pinned-all"];
            if (local && local.length > 0) {
              await api.setOrderedList("pinned-all", local);
            }
          } else if (!orderedListWriteInFlight) {
            useWorkspaceStore.getState().setSortOrder("pinned-all", pinnedOrder.itemIds);
          }
        } finally {
          inFlightPinnedOrderSync = null;
        }
      })();
      return inFlightPinnedOrderSync;
    }

    void refresh();
    void syncPinnedOrder();
    const off = api.on("ws:open", () => {
      void refresh();
      void syncPinnedOrder();
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
    const offProjUpdated = api.on("project:updated", (ev) => {
      if (ev.type === "project:updated") applyProjectUpdated(ev.project);
    });
    const offWtCreated = api.on("worktree:created", (ev) => {
      if (ev.type === "worktree:created") applyWorktreeCreated(ev.worktree);
    });
    const offWtDeleted = api.on("worktree:deleted", (ev) => {
      if (ev.type !== "worktree:deleted") return;
      applyWorktreeDeleted(ev.worktreeId);
      // The worktree's SESSION tiles are cleaned up by the per-session
      // `session:deleted` events the daemon now cascades ahead of this one.
      // Its `tools:<worktreeId>` tiles have no sessionId, so they need their
      // own sweep or they linger as empty ghost windows.
      useWorkspaceStore.getState().removeToolsTilesForWorktree(ev.worktreeId);
    });
    const offWtUpdated = api.on("worktree:updated", (ev) => {
      if (ev.type === "worktree:updated") applyWorktreeUpdated(ev.worktree);
    });
    const offSessCreated = api.on("session:created", (ev) => {
      if (ev.type !== "session:created") return;
      if (ev.snapshot) {
        applySessionCreated(ev.snapshot);
        patchSessionState(ev.snapshot.id, ev.snapshot.state);
      }
      // Record child→parent relationship so groupEvents can correlate task
      // tool_use entries with their spawned child sessions via FIFO matching.
      if (ev.spawnedFrom) {
        useServerStore.getState().addChildSession(ev.spawnedFrom, ev.sessionId);
      }
      // Phase 4c (agent-interaction-workspaces/04-workspaces): a session
      // spawned from a currently-tiled source auto-inserts as a new tile,
      // splitting the source's own tile (S4/S6/Decision 8). `spawnedFrom`
      // absent or null (CUJ 6 — no source, the common case today) skips this
      // entirely — no scan, no behavior change from before Phase 4.
      //
      // Fan-out is "insert everywhere the source is tiled" (Risk #9/#10
      // resolved): EVERY scratch canvas and EVERY saved workspace doc that
      // currently tiles the source gets the child. No skip-on-multi-match —
      // a session tiled in two places is tiled deliberately, and skipping
      // silently produced no tile at all, which read as the feature being
      // broken.
      if (ev.spawnedFrom) {
        const store = useWorkspaceStore.getState();
        // The everyday canvas mode is a scratch canvas; scanning only saved
        // docs meant this almost never fired in normal use.
        for (const wtId of findScratchCanvasesTilingSession(ev.spawnedFrom, store.layoutByWorktree)) {
          store.insertTileIntoScratchCanvas(
            wtId,
            ev.sessionType,
            ev.sessionId,
            ev.worktreeId ?? undefined,
          );
        }
        for (const doc of findWorkspacesTilingSession(ev.spawnedFrom, store.workspaceDocs)) {
          store.insertTileIntoWorkspaceDoc(
            doc.id,
            ev.sessionType,
            ev.sessionId,
            ev.worktreeId ?? undefined,
          );
        }
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
      if (ev.type === "session:deleted") {
        // Captured before `applySessionDeleted` removes it from the list —
        // needed below to scope the fallback-session lookup to the deleted
        // session's own worktree.
        const deletedWorktreeId = useServerStore
          .getState()
          .sessions.find((sess) => sess.id === ev.sessionId)?.worktreeId;
        applySessionDeleted(ev.sessionId);
        // Explicit deletion (not a natural exit — a session can resume from
        // that) is the "this is gone" signal: drop any canvas/workspace tile
        // still referencing it, live, without a reload (Requirement 5). Pass
        // along the worktree's remaining sessions (post-deletion) so a
        // cleared `activeSessionId` can fall back to that worktree's main
        // agent instead of going bare (Requirement 5d follow-up).
        const remainingSessions =
          deletedWorktreeId != null
            ? useServerStore.getState().sessions.filter((sess) => sess.worktreeId === deletedWorktreeId)
            : undefined;
        useWorkspaceStore.getState().removeTilesForSession(ev.sessionId, remainingSessions);
      }
    });
    const offSessUpdated = api.on("session:updated", (ev) => {
      if (ev.type === "session:updated") {
        // A live channel toggle (P3, R1.7) patches `channel` (+ the `useTmux`
        // invariant) so the ChatPane/TerminalPane flip; a pin toggle patches
        // `pinnedAt`. Only apply fields that are present.
        const patch: Partial<Session> = {};
        if (ev.channel !== undefined) {
          patch.channel = ev.channel;
          patch.useTmux = ev.channel === "tmux";
        }
        if (ev.pinnedAt !== undefined) patch.pinnedAt = ev.pinnedAt ?? null;
        if (ev.name !== undefined) patch.name = ev.name ?? null;
        if (ev.archivedAt !== undefined) patch.archivedAt = ev.archivedAt ?? null;
        if (ev.sortOrder !== undefined) patch.sortOrder = ev.sortOrder;
        if (ev.pr !== undefined) patch.pr = ev.pr ?? undefined;
        if (ev.supersededBy !== undefined) patch.supersededBy = ev.supersededBy ?? null;
        if (ev.isMain !== undefined) patch.isMain = ev.isMain;
        applySessionUpdated(ev.sessionId, patch);
        // A reset's replacement takes the archived session's place in every
        // canvas it was tiled in — same tile id/position, just repointed.
        // Fires for every connected client (the broadcast, not the
        // initiator's own response), so a reset triggered from the CLI/
        // another tab relinks here too.
        if (ev.supersededBy) {
          useWorkspaceStore.getState().relinkSessionTiles(ev.sessionId, ev.supersededBy);
        }
      }
    });
    const offOrderedListUpdated = api.on("orderedList:updated", (ev) => {
      if (ev.type === "orderedList:updated" && ev.scopeKey === "pinned-all") {
        useWorkspaceStore.getState().setSortOrder("pinned-all", ev.itemIds);
      }
    });
    return () => {
      offProjCreated();
      offProjDeleted();
      offProjUpdated();
      offWtCreated();
      offWtDeleted();
      offWtUpdated();
      offSessCreated();
      offSessState();
      offSessExited();
      offSessResumed();
      offSessDeleted();
      offSessUpdated();
      offOrderedListUpdated();
    };
  }, [
    api,
    applyProjectCreated,
    applyProjectDeleted,
    applyProjectUpdated,
    applyWorktreeCreated,
    applyWorktreeDeleted,
    applyWorktreeUpdated,
    applySessionCreated,
    applySessionUpdated,
    applySessionDeleted,
    patchSessionState,
  ]);
}
