import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { Session, Worktree } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";

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
  const urlConsumed = useRef(false);

  // Read effect: apply path params to store
  useEffect(() => {
    if (!ready || urlConsumed.current) return;
    urlConsumed.current = true;

    // Backward-compat: if ?wt= query param exists (old URL), redirect to new path format
    const searchParams = new URLSearchParams(location.search);
    const wtParam = searchParams.get("wt");
    if (wtParam) {
      const sessParam = searchParams.get("session");
      const newPath = `/worktree/${wtParam}${sessParam ? `/${sessParam}` : ""}`;
      navigate(newPath, { replace: true });
      return; // Let the next render apply the read effect with the new path
    }

    // Apply path params to store
    const wtId = params.wtId;
    const sessionId = params.sessionId;

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
            wtSessions.find((s) => s.slot === "m")?.id ??
            wtSessions[0]?.id ??
            null;
        }

        useWorkspaceStore.setState({
          activeProjectId: w.projectId,
          activeWorktreeId: w.id,
          activeSessionId: pickedSessionId,
        });
      }
    }
  }, [ready, worktrees, sessions, params.wtId, params.sessionId, navigate, location.search]);

  // Write effect: mirror active ids to path
  useEffect(() => {
    if (!ready || !urlConsumed.current) return;
    // Only update URL if we're on a /worktree path
    if (!location.pathname.startsWith("/worktree")) return;

    // Compute target path
    let targetPath = "/worktree";
    if (activeWorktreeId) {
      targetPath = `/worktree/${activeWorktreeId}`;
      if (activeSessionId) {
        const activeSession = sessions.find((s) => s.id === activeSessionId);
        // Only append sessionId if it's not the main slot
        if (activeSession?.slot !== "m") {
          targetPath = `/worktree/${activeWorktreeId}/${activeSessionId}`;
        }
      }
    }

    // Guard: only navigate if path changed
    if (location.pathname !== targetPath) {
      navigate(targetPath, { replace: true });
    }
  }, [ready, activeWorktreeId, activeSessionId, sessions, navigate, location.pathname]);
}
