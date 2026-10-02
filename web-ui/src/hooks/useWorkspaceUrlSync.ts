import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { Session, Worktree } from "@/api/types";
import { reconcileActiveFileForContext, useWorkspaceStore } from "@/hooks/useStore";

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
    lastParamsRef.current = { wtId, sessionId };

    if (wtId) {
      const w = worktrees.find((x) => x.id === wtId);
      if (w) {
        const wtSessions = sessions.filter((s) => s.worktreeId === w.id);
        const lastSessionId = useWorkspaceStore.getState().lastSessionByWorktree[w.id];

        // Prefer explicit path sessionId, then last-used, then main slot, then first.
        let pickedSessionId: string | null = null;
        if (sessionId) {
          const explicit = wtSessions.find((s) => s.id === sessionId);
          pickedSessionId = explicit?.id ?? null;
        }
        if (!pickedSessionId) {
          pickedSessionId =
            (lastSessionId && wtSessions.some((s) => s.id === lastSessionId) ? lastSessionId : null) ??
            wtSessions.find((s) => s.isMain)?.id ??
            wtSessions[0]?.id ??
            null;
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
