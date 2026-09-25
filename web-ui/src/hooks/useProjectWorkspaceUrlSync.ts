import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { Project, Session } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * Re-entrant, ping-pong-safe URL↔store sync for the project workspace
 * (`/project/:projectId[/:sessionId]`). Single owner of the project-view store
 * fields (selectProject / setActiveDirectContext / setActiveSession / open-tab
 * seeding). Called UNCONDITIONALLY; every effect body starts with
 * `if (!enabled) return;` (never a conditional hook call).
 *
 * Design (Decision 3):
 * - A `lastAppliedRef` holds the `{pid, sid}` pair this hook itself last drove
 *   the URL/store to, and is CLEARED to null whenever `enabled` is false, so a
 *   later re-entry to the SAME pair is never mistaken for "already applied"
 *   (CUJ 1b).
 * - The read effect only skips applying when BOTH the params-derived pair
 *   matches `lastAppliedRef` AND the live store already agrees
 *   (`activeDirectContextId === pid && activeWorktreeId == null`).
 * - `sessions` stays in the read effect's deps solely to revalidate a
 *   `sessionId`'s existence/ownership, never as an independent re-apply
 *   trigger (CUJ 2).
 * - The write effect reads `useWorkspaceStore.getState()` directly (never the
 *   hook's own subscribed values, which can be one render stale relative to a
 *   same-commit write) and updates `lastAppliedRef` before navigating.
 */
export function useProjectWorkspaceUrlSync(
  enabled: boolean,
  bundleLoaded: boolean,
  sessions: Session[],
  projects: Project[],
) {
  const params = useParams<{ projectId?: string; sessionId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const activeDirectContextId = useWorkspaceStore((s) => s.activeDirectContextId);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const lastAppliedRef = useRef<{ pid: string | null; sid: string | null } | null>(null);
  // Set when the read effect redirects away (unknown/hidden project) so the
  // write effect bails for that same tick instead of reading the still-stale
  // store and navigating back to the previous project (ping-pong).
  const skipWriteRef = useRef(false);

  // Read effect: apply URL params to store
  useEffect(() => {
    if (!enabled) {
      lastAppliedRef.current = null;
      return;
    }
    if (!bundleLoaded) return;
    const pid = params.projectId ?? null;
    if (!pid) return;
    const project = projects.find((p) => p.id === pid);
    if (!project || project.hidden) {
      // Unknown/hidden project — leave the project workspace entirely. Suppress
      // the write effect this tick so it doesn't read the still-stale store
      // (still pointing at the previous project) and navigate straight back.
      skipWriteRef.current = true;
      navigate("/", { replace: true });
      return;
    }
    // Only accept a sessionId that is actually a direct agent OF this project.
    const sid =
      params.sessionId &&
      sessions.some((s) => s.id === params.sessionId && s.projectId === pid && s.worktreeId === null && s.type === "agent")
        ? params.sessionId
        : null;
    const store = useWorkspaceStore.getState();
    // Skip only when BOTH the ref and the live store already agree the
    // project/no-worktree context is right — deliberately NOT checking
    // activeSessionId here: a same-tick programmatic write (e.g. "New direct
    // agent" calling setActiveSession directly) can legitimately diverge
    // activeSessionId from `sid` while params haven't caught up yet, and that
    // divergence must NOT be re-derived away (CUJ 2).
    const refMatches = lastAppliedRef.current?.pid === pid && lastAppliedRef.current?.sid === sid;
    const storeMatches = store.activeDirectContextId === pid && store.activeWorktreeId == null;
    if (refMatches && storeMatches) return;
    lastAppliedRef.current = { pid, sid };
    // Clear a stale activeWorktreeId even when activeProjectId already
    // matches — entering from one of this project's OWN worktrees is the
    // main path in via the sidebar.
    if (store.activeProjectId !== pid || store.activeWorktreeId != null) store.selectProject(pid);
    store.setActiveDirectContext(pid);
    // Seed the open-tab set BEFORE opening the URL-provided session, so a
    // first visit via a direct sidebar link (/project/p/s1) still seeds
    // every OTHER pre-existing direct agent as a tab, not just s1.
    store.seedProjectAgentTabsIfEmpty(pid, sessions);
    store.setActiveSession(sid);
    if (sid) store.openProjectAgentTab(pid, sid);
  }, [enabled, bundleLoaded, params.projectId, params.sessionId, sessions, projects, navigate]);

  // Write effect: mirror active ids to path
  useEffect(() => {
    if (!enabled) return;
    // Bail out of a tick where the read effect just redirected away (unknown/
    // hidden project) — the store is still stale for one more render and would
    // otherwise navigate back to the previous project.
    if (skipWriteRef.current) {
      skipWriteRef.current = false;
      return;
    }
    // Read getState() directly — the subscribed values above can be one
    // render stale relative to a same-commit write (useWorkspaceUrlSync.ts is
    // the existing precedent for this exact fix).
    const { activeDirectContextId: pid, activeSessionId: sid } = useWorkspaceStore.getState();
    if (!pid) return;
    const target = sid ? `/project/${pid}/${sid}` : `/project/${pid}`;
    lastAppliedRef.current = { pid, sid };
    if (location.pathname !== target) navigate(target, { replace: true });
  }, [enabled, activeDirectContextId, activeSessionId, location.pathname, navigate]);
}
