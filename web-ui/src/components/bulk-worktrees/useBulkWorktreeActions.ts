import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { worktreeLabel } from "@/lib/sessionLabel";
import { createBulkRunner, type BulkAction, type BulkJob } from "./bulkRunner";
import { useBulkWorktrees } from "./useBulkWorktrees";

/**
 * Module-scope references for the single runner. The runner must outlive any
 * component (the tray can unmount on navigation while a job keeps running), so
 * it can't capture hook values — the always-mounted consumer publishes the
 * current api/navigate here instead (plan Decision 2 + Decision 8).
 */
let apiRef: ApiInstance | null = null;
let navigateRef: ((to: string) => void) | null = null;

/**
 * The last worktree the user had open. `useWorkspaceUrlSync` clears
 * `activeWorktreeId` and rewrites the URL to a bare `/worktree` the moment the
 * server drops the worktree, which can land before this job's `onItemDone` —
 * so the "was the user viewing it?" question can't be answered from live state.
 */
let lastViewedWorktreeId: string | null = useWorkspaceStore.getState().activeWorktreeId;
useWorkspaceStore.subscribe((s) => {
  if (s.activeWorktreeId) lastViewedWorktreeId = s.activeWorktreeId;
});

/**
 * Deleting the worktree the user is currently viewing leaves a dead
 * `/worktree/:id` (or bare `/worktree`) pane: clear the selection and go to the
 * dashboard. Mirrors the single-row delete (`LeftSidebar.tsx`'s
 * `confirmDeleteWorktree`). Archive never navigates (matches single-row archive).
 */
function leaveDeletedWorktree(id: string): void {
  if (lastViewedWorktreeId !== id) return;
  const path = window.location.pathname;
  if (path !== "/worktree" && !path.startsWith("/worktree/")) return;
  useWorkspaceStore.getState().clearWorkspaceSelection();
  navigateRef?.("/");
}

function createRunner() {
  return createBulkRunner({
    run: async (action, id) => {
      const api = apiRef;
      if (!api) throw new Error("Bulk worktree action ran before an api was provided.");
      if (action === "archive") await api.hideWorktree(id);
      else await api.deleteWorktree(id);
    },
    // A 404 means it is already gone — treat as success.
    isGone: (err) => err instanceof ApiError && err.status === 404,
    onChange: (job) => useBulkWorktrees.getState().setJob(job),
    onItemDone: (id, action) => {
      if (action === "delete") leaveDeletedWorktree(id);
    },
  });
}

let runner = createRunner();

/** Demo hard-reset: drop the module-scope refs and any job left in the runner
 *  (mirrors the other `__resetForDemo` singletons — see `lib/demoRuntime.ts`). */
export function __resetForDemo(): void {
  apiRef = null;
  navigateRef = null;
  runner = createRunner();
}

export interface BulkWorktreeActions {
  /**
   * Starts a job over `ids` and leaves select mode. Ids no longer present in
   * `useServerStore` are dropped (Decision 3). Returns null when nothing was
   * started (empty set, or a job is still running).
   */
  start: (action: BulkAction, ids: readonly string[]) => BulkJob | null;
  cancelRemaining: () => void;
  retry: () => void;
  /** Drops the finished job from the tray. */
  dismiss: () => void;
}

/**
 * Wires the module-scope runner to the api + app side effects. Call this once
 * from an always-mounted consumer (the progress tray in Phase 2) so the
 * runner's api/navigate references never go stale.
 */
export function useBulkWorktreeActions(api: ApiInstance): BulkWorktreeActions {
  const navigate = useNavigate();

  useEffect(() => {
    apiRef = api;
    navigateRef = (to) => navigate(to);
  }, [api, navigate]);

  const start = useCallback((action: BulkAction, ids: readonly string[]): BulkJob | null => {
    const worktreesById = new Map(useServerStore.getState().worktrees.map((w) => [w.id, w]));
    const items: { id: string; label: string }[] = [];
    for (const id of ids) {
      const w = worktreesById.get(id);
      if (w) items.push({ id, label: worktreeLabel(w) });
    }
    const job = runner.start(action, items);
    // Confirm starts the job and exits select mode in the same tick (CUJ).
    if (job) useBulkWorktrees.getState().exit();
    return job;
  }, []);

  const cancelRemaining = useCallback(() => runner.cancelRemaining(), []);
  const retry = useCallback(() => runner.retry(), []);
  const dismiss = useCallback(() => useBulkWorktrees.getState().setJob(null), []);

  return { start, cancelRemaining, retry, dismiss };
}
