import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { Session, Worktree } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";

const WT = "wt";
const SESS = "session";

/**
 * One-shot: apply ?wt=&session= from URL when bundle is ready (skipped on dashboard).
 * Ongoing: mirror active ids into the query string.
 */
export function useWorkspaceUrlSync(ready: boolean, worktrees: Worktree[], sessions: Session[], isDashboard = false) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const urlConsumed = useRef(false);

  useEffect(() => {
    if (!ready || urlConsumed.current) return;
    urlConsumed.current = true;
    if (isDashboard) return;
    const wtParam = searchParams.get(WT);
    const sessParam = searchParams.get(SESS);
    if (wtParam) {
      const w = worktrees.find((x) => x.id === wtParam);
      if (w) {
        const wtSessions = sessions.filter((s) => s.worktreeId === w.id);
        const lastSessionId = useWorkspaceStore.getState().lastSessionByWorktree[w.id];

        // Prefer explicit ?session= param, then last-used, then main slot, then first.
        let pickedSessionId: string | null = null;
        if (sessParam) {
          const explicit = wtSessions.find((s) => s.id === sessParam);
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
  }, [ready, isDashboard, worktrees, sessions, searchParams]);

  useEffect(() => {
    if (!ready || !urlConsumed.current) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (activeWorktreeId) next.set(WT, activeWorktreeId);
        else next.delete(WT);
        if (activeSessionId) next.set(SESS, activeSessionId);
        else next.delete(SESS);
        return next;
      },
      { replace: true },
    );
  }, [ready, activeWorktreeId, activeSessionId, setSearchParams]);
}
