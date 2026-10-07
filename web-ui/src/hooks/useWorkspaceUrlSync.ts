import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { Session, Worktree } from "@/api/types";
import { reconcileActiveFileForContext, useWorkspaceStore } from "@/hooks/useStore";
import { isTabVisibleAgent, pickWorktreeAgent, resolveSupersededChain } from "@/lib/sessionVisibility";

/**
 * One-shot: apply :wtId/:sessionId from URL path when bundle is ready.
 * Ongoing: mirror active ids into the path.
 */
export function useWorkspaceUrlSync(ready: boolean, worktrees: Worktree[], sessions: Session[]) {
  const params = useParams<{ wtId?: string; sessionId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const lastParamsRef = useRef<{ wtId?: string; sessionId?: string } | null>(null);
  // Decision 10 — snapshot of the tab-visible agent ids from the PREVIOUS
  // effect run, replaced (never accumulated) on every run so a row that was
  // already hidden at the previous run never fires the guard.
  const lastVisibleRef = useRef<Set<string> | null>(null);

  // Read effect: apply path params to store only when path params actually change
  useEffect(() => {
    if (!ready) return;

    // Skip URL sync for direct session paths — Workspace handles them directly
    if (location.pathname.startsWith("/session/")) {
      lastParamsRef.current = null;
      return;
    }

    if (!location.pathname.startsWith("/worktree")) {
      lastParamsRef.current = null;
      return;
    }

    // Backward-compat: if ?wt= query param exists (old URL), redirect to new path format.
    const searchParams = new URLSearchParams(location.search);
    const wtParam = searchParams.get("wt");
    if (wtParam) {
      const sessParam = searchParams.get("session");
      const newPath = `/worktree/${wtParam}${sessParam ? `/${sessParam}` : ""}`;
      navigate(newPath, { replace: true });
      return;
    }

    // Apply path params to store
    const wtId = params.wtId;
    const sessionId = params.sessionId;

    // Skip if URL path parameters have not changed (e.g. sessions/worktrees array identity re-render)
    const paramsUnchanged =
      lastParamsRef.current !== null &&
      lastParamsRef.current.wtId === wtId &&
      lastParamsRef.current.sessionId === sessionId;
    if (paramsUnchanged) return;
    // Decision 9 — strict visibility validation applies on FIRST apply only
    // (mount, re-entry, full reload). Later param changes (a sidebar click on a
    // superseded row) accept any listed agent of the worktree instead.
    const firstApply = lastParamsRef.current === null;
    lastParamsRef.current = { wtId, sessionId };

    if (wtId) {
      const w = worktrees.find((x) => x.id === wtId);
      if (w) {
        const wtSessions = sessions.filter((s) => s.worktreeId === w.id);
        const lastSessionId = useWorkspaceStore.getState().lastSessionByWorktree[w.id];

        let pickedSessionId: string | null;
        if (!firstApply && sessionId && wtSessions.some((s) => s.type === "agent" && s.id === sessionId)) {
          // Later param change to a listed agent of this worktree — keep it
          // (Decision 9; sidebar lists superseded rows too).
          pickedSessionId = sessionId;
        } else {
          pickedSessionId = pickWorktreeAgent(wtSessions, { explicitId: sessionId, lastId: lastSessionId });
        }

        useWorkspaceStore.setState((st) => ({
          activeProjectId: w.projectId,
          activeWorktreeId: w.id,
          activeSessionId: pickedSessionId,
          // Don't carry another context's open file into this worktree (L7).
          ...reconcileActiveFileForContext(st, w.id),
        }));
      }
    }
  }, [ready, worktrees, sessions, params.wtId, params.sessionId, navigate, location.search, location.pathname]);

  // Edge-triggered guard (Decisions 5, 10): if the active agent WAS a visible
  // tab in the previous snapshot but is now hidden/missing (deleted,
  // superseded, any client/any source), re-select a live agent in real time.
  // Reads store state fresh via getState (Decision 3). Order: read effect →
  // guard → write effect, so the guard's re-selection is reflected in the URL
  // without a loop.
  useEffect(() => {
    if (!ready) return;
    if (!location.pathname.startsWith("/worktree")) {
      lastVisibleRef.current = null;
      return;
    }
    const { activeWorktreeId: wtId, activeSessionId: sessId } = useWorkspaceStore.getState();
    if (!wtId) {
      lastVisibleRef.current = null;
      return;
    }
    const wtSessions = sessions.filter((s) => s.worktreeId === wtId);
    const visible = new Set(wtSessions.filter(isTabVisibleAgent).map((s) => s.id));

    const prev = lastVisibleRef.current;
    // Decision 10: replace the snapshot on every run, even when we don't act.
    lastVisibleRef.current = visible;

    if (!prev || sessId == null) return; // nothing observed yet / nothing active
    if (!prev.has(sessId)) return; // Decision 5: never seen visible → leave alone
    if (visible.has(sessId)) return; // still visible → nothing to do

    const active = sessions.find((s) => s.id === sessId);
    const store = useWorkspaceStore.getState();
    if (active?.supersededBy) {
      // Follow the supersededBy chain to the live replacement (existing behavior).
      store.setActiveSession(resolveSupersededChain(sessId, sessions));
    } else {
      const lastId = store.lastSessionByWorktree[wtId];
      store.setActiveSession(pickWorktreeAgent(wtSessions, { lastId }));
    }
  }, [ready, sessions, location.pathname, activeSessionId]);

  // Write effect: mirror active ids to path
  useEffect(() => {
    if (!ready) return;
    // Only update URL if we're on a /worktree path
    if (!location.pathname.startsWith("/worktree")) return;

    // Read the current values directly from the store — the subscribed closure
    // values are stale in the same-flush render where the read effect populated
    // the store (setState hasn't propagated to subscriptions yet).
    const { activeWorktreeId: wtId, activeSessionId: sessId } = useWorkspaceStore.getState();

    // Compute target path
    let targetPath = "/worktree";
    let targetSessionParam: string | undefined = undefined;
    if (wtId) {
      targetPath = `/worktree/${wtId}`;
      if (sessId) {
        const activeSession = sessions.find((s) => s.id === sessId);
        // Only append sessionId if it's not the main slot
        if (!activeSession?.isMain) {
          targetPath = `/worktree/${wtId}/${sessId}`;
          targetSessionParam = sessId;
        }
      }
    }

    // Guard: only navigate if path changed
    if (location.pathname !== targetPath) {
      lastParamsRef.current = { wtId: wtId ?? undefined, sessionId: targetSessionParam };
      navigate(targetPath, { replace: true });
    }
  }, [ready, activeWorktreeId, activeSessionId, sessions, navigate, location.pathname]);
}
