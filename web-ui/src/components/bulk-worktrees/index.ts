/**
 * Public surface of the bulk-worktree-actions feature: the pure job engine +
 * stores (Phase 1) and the sidebar UI (Phase 2). The CSS import lives here so
 * importing any part of the barrel ships the feature's styles.
 */
import "./bulk-worktrees.css";

export {
  createBulkRunner,
  type BulkAction,
  type BulkItem,
  type BulkItemStatus,
  type BulkJob,
  type BulkRunner,
  type BulkRunnerDeps,
} from "./bulkRunner";
export { useBulkWorktrees, type BulkWorktreesState } from "./useBulkWorktrees";
export { useBulkWorktreeActions, type BulkWorktreeActions } from "./useBulkWorktreeActions";
export {
  filterVisibleWorktrees,
  useVisibleWorktrees,
  type UseVisibleWorktreesArgs,
  type VisibleWorktreeFilterOptions,
} from "./useVisibleWorktrees";
export { BulkMenu } from "./BulkMenu";
export { BulkRowTrail, type BulkRowTrailProps } from "./BulkRowTrail";
export { BulkActionBar, type BulkActionBarProps } from "./BulkActionBar";
export { BulkConfirmDialog, type BulkConfirmItem, type BulkConfirmDialogProps } from "./BulkConfirmDialog";
export { BulkProgressTray } from "./BulkProgressTray";
