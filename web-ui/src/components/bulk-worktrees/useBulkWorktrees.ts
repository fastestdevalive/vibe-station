import { create } from "zustand";
import { useServerStore } from "@/hooks/useServerStore";
import type { BulkAction, BulkJob } from "./bulkRunner";

/**
 * Global select-mode + job state for bulk worktree actions.
 *
 * Global (not local to `LeftSidebar`) because the progress tray must survive
 * navigation and the runner outlives any one component (plan Decision 2).
 * Selection holds ids only — labels/records are resolved from
 * `useServerStore` at confirm time (Decision 3), so a worktree that vanished
 * mid-selection never leaves a stale copy behind.
 */
export interface BulkWorktreesState {
  /** The action being selected for, or null when not in select mode. */
  mode: BulkAction | null;
  /** Selected worktree ids. Survives project collapse and filter changes. */
  selected: Set<string>;
  /** The current (or last) bulk job, rendered by the progress tray. */
  job: BulkJob | null;

  enter: (action: BulkAction) => void;
  /** Leaves select mode and drops the selection; the job (if any) is kept. */
  exit: () => void;
  toggle: (id: string) => void;
  /** Selects (`on = true`) or deselects a group of ids, e.g. "Select all". */
  setMany: (ids: readonly string[], on: boolean) => void;
  setJob: (job: BulkJob | null) => void;
}

export const useBulkWorktrees = create<BulkWorktreesState>((set) => ({
  mode: null,
  selected: new Set(),
  job: null,

  enter: (action) => set({ mode: action, selected: new Set() }),
  exit: () => set({ mode: null, selected: new Set() }),

  toggle: (id) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next };
    }),

  setMany: (ids, on) =>
    set((s) => {
      const next = new Set(s.selected);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return { selected: next };
    }),

  setJob: (job) => set({ job }),
}));

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

let knownWorktreeIds: ReadonlySet<string> = new Set(
  useServerStore.getState().worktrees.map((w) => w.id),
);

/**
 * Prune selected ids that no longer exist in server truth (deleted here, by
 * another client, or gone on reconnect). One module-scope subscription is the
 * single place this happens — no component effect can forget it, and no
 * second writer touches `selected` (Decision 3).
 */
useServerStore.subscribe((state) => {
  const ids = new Set(state.worktrees.map((w) => w.id));
  if (sameIds(ids, knownWorktreeIds)) return;
  knownWorktreeIds = ids;
  useBulkWorktrees.setState((s) => {
    if (s.selected.size === 0) return s;
    const next = new Set([...s.selected].filter((id) => ids.has(id)));
    // Returning the same state object is a no-op in zustand (no re-render).
    return next.size === s.selected.size ? s : { selected: next };
  });
});
