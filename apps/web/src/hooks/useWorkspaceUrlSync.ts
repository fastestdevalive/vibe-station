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
    if (isDashboard) return; // never restore worktree on the dashboard route
    const wtParam = searchParams.get(WT);
    const sessParam = searchParams.get(SESS);
    if (wtParam) {
      const w = worktrees.find((x) => x.id === wtParam);
      if (w) {
        if (sessParam) {
          const sess = sessions.find((s) => s.id === sessParam);
          if (sess && sess.worktreeId === w.id) {
            useWorkspaceStore.setState({
              activeProjectId: w.projectId,
              activeWorktreeId: w.id,
              activeSessionId: sess.id,
            });
          } else {
            useWorkspaceStore.setState({
              activeProjectId: w.projectId,
              activeWorktreeId: w.id,
              activeSessionId: null,
            });
          }
        } else {
          useWorkspaceStore.setState({
            activeProjectId: w.projectId,
            activeWorktreeId: w.id,
            activeSessionId: null,
          });
        }
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
