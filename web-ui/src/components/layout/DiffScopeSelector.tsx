import type { DiffScope } from "@/api/types";

interface DiffScopeSelectorProps {
  scope: DiffScope;
  /** Local/branch mode only — omit (or ignore) in commit mode. */
  onChange?: (scope: DiffScope) => void;
  /** Worktree's base branch, shown as a title/tooltip on the "branch" chip. */
  baseBranch?: string;
  /** Commit mode only — e.g. "commit #a1b2c3d". */
  commitLabel?: string;
  /** Commit mode only — returns to the commit graph. */
  onBack?: () => void;
}

/**
 * Shared local/branch scope chip UI (Decision 3) — extracted verbatim from
 * `FileTreeSidebar`'s inline chip block so the Files tree, the plain-file
 * preview pane, and the VCS commit view all present one selector instead of
 * three divergent toggle implementations.
 *
 * In commit mode (`scope === "commit"`) this renders a read-only breadcrumb
 * ("Commits › commit #x") instead of clickable local/branch chips — there is
 * nothing to toggle once viewing a single commit's diff.
 */
export function DiffScopeSelector({ scope, onChange, baseBranch, commitLabel, onBack }: DiffScopeSelectorProps) {
  if (scope === "commit") {
    return (
      <div className="diff-scope-selector__breadcrumb">
        <button type="button" className="diff-scope-selector__back" onClick={onBack}>
          Commits
        </button>
        <span aria-hidden>›</span>
        <span>{commitLabel}</span>
      </div>
    );
  }

  return (
    <div className="file-tree-scope-chips" role="group" aria-label="Diff scope">
      <button
        type="button"
        className={`file-tree-scope-chip ${scope === "local" ? "file-tree-scope-chip--active" : ""}`}
        aria-pressed={scope === "local"}
        onClick={() => onChange?.("local")}
      >
        local
      </button>
      <button
        type="button"
        className={`file-tree-scope-chip ${scope === "branch" ? "file-tree-scope-chip--active" : ""}`}
        aria-pressed={scope === "branch"}
        title={baseBranch}
        onClick={() => onChange?.("branch")}
      >
        branch
      </button>
    </div>
  );
}
