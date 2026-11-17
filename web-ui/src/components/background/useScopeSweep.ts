import { useEffect } from "react";
import { useServerStore } from "@/hooks/useServerStore";
import { getBackgroundStore, type ScopeKey } from "./backgroundStore";

/** A deleted worktree/project must lose its seed + override (mobile parity). */
export const SCOPE_SWEEP_DELAY_MS = 30_000;

/**
 * Sweeps `backgroundStore`'s per-scope entries once the server data has
 * settled: after a 30 s grace period (a just-created worktree is in the store
 * long before its first paint) every scope that no longer exists is dropped.
 * Re-armed only when the worktree/project id lists change, never while the
 * server store is unloaded — sessions stream constantly and must not reschedule
 * this.
 */
export function useScopeSweep(): void {
  const loaded = useServerStore((s) => s.loaded);
  const projectIds = useServerStore((s) => s.projects.map((p) => p.id).join("\n"));
  const worktreeIds = useServerStore((s) => s.worktrees.map((w) => w.id).join("\n"));

  useEffect(() => {
    if (!loaded) return undefined;
    const timer = setTimeout(() => {
      // Re-read rather than closing over the render's lists: the sweep is about
      // what exists now, not what existed 30 s ago.
      const state = useServerStore.getState();
      if (!state.loaded) return;
      const live = new Set<ScopeKey>();
      for (const worktree of state.worktrees) live.add(`worktree:${worktree.id}`);
      for (const project of state.projects) live.add(`project:${project.id}`);
      getBackgroundStore().pruneScopes(live);
    }, SCOPE_SWEEP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loaded, projectIds, worktreeIds]);
}
