import type { ApiInstance } from "@/api";

/**
 * Worktree-domain data access, wrapping the worktree-related subset of
 * `api/client.ts` (via the shared `ApiInstance`). Every method here is the
 * same closure `api` already exposes — this repository adds a domain
 * boundary, not new fetch/parse logic.
 *
 * `getOrderedList`/`setOrderedList` live here rather than on a dedicated
 * ordered-list repository — today's only caller (`useServerSync.ts`) uses
 * them for worktree pin ordering (`"pinned-all"`); see plan Decision 3.
 *
 * `on` is the same multiplexed subscribe-by-name function as `api.on` (not
 * reimplemented) — callers register against the worktree-domain event names
 * (`worktree:created`, `worktree:deleted`, `worktree:updated`,
 * `orderedList:updated`, ...).
 */
export function createWorktreeRepository(api: ApiInstance) {
  return {
    listWorktrees: api.listWorktrees,
    listProjectBranches: api.listProjectBranches,
    createWorktree: api.createWorktree,
    deleteWorktree: api.deleteWorktree,
    getDiskUsage: api.getDiskUsage,
    markWorktreeDone: api.markWorktreeDone,
    pinWorktree: api.pinWorktree,
    unpinWorktree: api.unpinWorktree,
    hideWorktree: api.hideWorktree,
    unhideWorktree: api.unhideWorktree,
    renameWorktree: api.renameWorktree,
    reorderWorktree: api.reorderWorktree,
    getOrderedList: api.getOrderedList,
    setOrderedList: api.setOrderedList,
    getDiff: api.getDiff,
    tree: api.tree,
    fileList: api.fileList,
    listChangedPaths: api.listChangedPaths,
    listCommits: api.listCommits,
    getPr: api.getPr,
    listSubmodules: api.listSubmodules,
    on: api.on,
  };
}

export type WorktreeRepository = ReturnType<typeof createWorktreeRepository>;
