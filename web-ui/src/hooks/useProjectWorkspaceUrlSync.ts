import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { Project, Session } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import {
  isTabVisibleAgent,
  pickFirstDirectAgent,
  pickNextDirectAgent,
  resolveSupersededChain,
} from "@/lib/sessionVisibility";

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
  // Decision 10 — snapshot of the tab-visible direct agent ids from the
  // PREVIOUS effect run, replaced (never accumulated) on every run so a row
  // that was already hidden at the previous run never fires the guard.
  const lastVisibleRef = useRef<Set<string> | null>(null);
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
    // Resolve the sessionId to apply. Decision 9: strict tab-visibility
    // validation on FIRST apply only (mount, re-entry, full reload); later
    // param changes (a sidebar click on a superseded row) accept any listed
    // direct agent of this project.
    const firstApply = lastAppliedRef.current === null;
    const store = useWorkspaceStore.getState();
    // Seed the open-tab set up front so the fallback picks below (and any
    // first visit via a direct sidebar link) operate on the full tab set.
    store.seedProjectAgentTabsIfEmpty(pid, sessions);
    let sid: string | null;
    if (params.sessionId) {
      const listed = sessions.find(
        (s) => s.id === params.sessionId && s.projectId === pid && s.worktreeId === null && s.type === "agent",
      );
      if (listed && (isTabVisibleAgent(listed) || !firstApply)) {
        sid = listed.id;
      } else {
        // Present but invalid/hidden. Keep the store's active id if it's still
        // a valid visible direct tab of this project (so a store-side pick —
        // e.g. the guard's neighbor re-selection — is never overwritten by the
        // URL's stale sid); else the first open tab; else null (Project tab).
        const openTabs = useWorkspaceStore.getState().openDirectAgentTabsByProject[pid] ?? [];
        const active = store.activeSessionId;
        const activeValid =
          active != null &&
          store.activeDirectContextId === pid &&
          openTabs.includes(active) &&
          sessions.some((s) => s.id === active && isTabVisibleAgent(s));
        sid = activeValid ? active : pickFirstDirectAgent(openTabs, sessions);
      }
    } else {
      // No sessionId in the URL → Project home tab (R1).
      sid = null;
    }
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
    store.setActiveSession(sid);
    if (sid) store.openProjectAgentTab(pid, sid);
  }, [enabled, bundleLoaded, params.projectId, params.sessionId, sessions, projects, navigate]);

  // Edge-triggered guard (Decisions 5, 10): if the active DIRECT agent was a
  // visible tab in the previous snapshot but is now hidden/missing (deleted,
  // superseded, any client/any source), re-select a live agent in real time —
  // the neighbor in tab order (or null → Project tab). Reads store state fresh
  // via getState (Decision 3). Order: read effect → guard → write effect, so
  // the guard's re-selection is reflected in the URL without a loop; the read
  // effect's keep-if-valid rule (above) never overwrites that store-side pick.
  useEffect(() => {
    if (!enabled) {
      lastVisibleRef.current = null;
      return;
    }
    if (!location.pathname.startsWith("/project")) {
      lastVisibleRef.current = null;
      return;
    }
    const { activeDirectContextId: pid, activeSessionId: sessId } = useWorkspaceStore.getState();
    if (!pid) {
      lastVisibleRef.current = null;
      return;
    }
    const directSessions = sessions.filter((s) => s.worktreeId === null && s.projectId === pid);
    const visible = new Set(directSessions.filter(isTabVisibleAgent).map((s) => s.id));

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
      const openTabs = store.openDirectAgentTabsByProject[pid] ?? [];
      const next = pickNextDirectAgent(
        openTabs,
        active ?? ({ id: sessId } as Session),
        directSessions,
      );
      store.setActiveSession(next);
    }
  }, [enabled, sessions, location.pathname, activeSessionId]);

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
