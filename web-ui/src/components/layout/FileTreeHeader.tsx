import { GitCompare } from "lucide-react";
import type { DiffScope } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { DiffScopeSelector } from "@/components/layout/DiffScopeSelector";

interface FileTreeHeaderProps {
  /** Browsing context id (worktree id, or project id for direct sessions) —
   *  used to read/write the per-context scope slices. */
  contextId: string | null;
  /** Project scope (direct sessions) has no branch concept — hides the
   *  local/branch scope chips (always local), but the diff-view toggle
   *  itself still shows: a direct session's git status is always "local",
   *  so there's nothing to pick, just something to view. */
  isProject?: boolean;
}

/**
 * The Files tool's left-pane header (extracted from `FileTreeSidebar`, Phase 3.3):
 * the "Files"/"Changes" title, the single local/branch scope selector, and the
 * diff-view toggle. Self-contained — it reads the scope slices it needs from the
 * store itself (keyed by `contextId`) and owns the diff-mode carry-over logic, so
 * `FileTreeSidebar` renders it internally by default AND `FilesLeftPane`/any other
 * caller can render it standalone without duplicating the markup or the logic.
 */
export function FileTreeHeader({ contextId, isProject = false }: FileTreeHeaderProps) {
  const setDiffScopeForWorktree = useWorkspaceStore((s) => s.setDiffScopeForWorktree);
  const setTreeScopeForWorktree = useWorkspaceStore((s) => s.setTreeScopeForWorktree);

  const scopeRaw = useWorkspaceStore((s) =>
    contextId ? s.diffScopeByWorktree[contextId] : undefined,
  );
  // Project scope has no git/diff — force plain file view.
  const scope: DiffScope = scopeRaw ?? "none";

  // Separate local/branch scope for the PLAIN tree (diff mode off) — kept in
  // its own store slice so picking "branch" here never flips `scope` (which
  // FilePreviewPane also reads) and switches the Files header into the flat
  // "Changes" list / full-diff-preview mode. That mode toggle stays the sole
  // job of the "Diff view" (GitCompare) button, per Task A.2.
  const treeScopeRaw = useWorkspaceStore((s) =>
    contextId ? s.treeScopeByWorktree[contextId] : undefined,
  );
  const treeScope: "local" | "branch" = treeScopeRaw ?? "local";

  const diffMode = scope !== "none";
  // Which local/branch scope currently drives the PLAIN tree's per-file
  // status/LOC: the shared `scope` while the flat Changes list is showing, or
  // the tree's own independent `treeScope` while browsing the plain tree.
  const effectiveTreeScope: "local" | "branch" = diffMode
    ? scope === "branch"
      ? "branch"
      : "local"
    : treeScope;

  function setScope(next: DiffScope) {
    if (contextId) setDiffScopeForWorktree(contextId, next);
  }

  function toggleDiffMode() {
    if (scope === "none") {
      // Entering diff mode: seed the Changes list's scope FROM the plain
      // tree's current scope, so it opens showing the same local/branch
      // selection the user just had.
      setScope(treeScope);
    } else {
      // Leaving diff mode: mirror the live diff-mode scope back into the
      // plain tree's own slice, so returning to the tree preserves whatever
      // scope was active in the Changes list.
      if (contextId) setTreeScopeForWorktree(contextId, scope === "branch" ? "branch" : "local");
      setScope("none");
    }
  }

  // Header selector's onChange: routes to whichever store slice is currently
  // "live" — the shared diff `scope` while the flat Changes list is showing, or
  // the tree-only `treeScope` while browsing the plain tree, so picking a scope
  // there never flips diff mode on (Task A.2).
  function handleTreeScopeChipChange(next: DiffScope) {
    if (next !== "local" && next !== "branch") return;
    if (diffMode) {
      setScope(next);
    } else if (contextId) {
      setTreeScopeForWorktree(contextId, next);
    }
  }

  return (
    <div className="pane-header pane-header--compact file-tree-sidebar-header">
      <span className="file-tree-sidebar-header__title">{diffMode ? "Changes" : "Files"}</span>
      <div className="file-tree-sidebar-header__tail">
        {/* One scope selector, always visible in the Files header — not
            gated on diff mode — working in both plain-tree and Changes-list
            mode (Task A.2). Git-only; hidden for project (direct-session)
            scope, same as the diff-view toggle below. */}
        {!isProject ? (
          <div className="file-tree-scope-slot">
            <DiffScopeSelector scope={effectiveTreeScope} onChange={handleTreeScopeChipChange} />
          </div>
        ) : null}
        {/* Diff view works for project scope too — it's always local scope
            there (no branch concept), so only the chip selector above is
            gated on isProject, not this toggle. */}
        <button
          type="button"
          className={`file-tree-diff-toggle ${diffMode ? "file-tree-diff-toggle--on" : ""}`}
          aria-pressed={diffMode}
          aria-label={diffMode ? "Diff view on" : "Diff view off"}
          title="Toggle diff view"
          onClick={toggleDiffMode}
        >
          <GitCompare size={15} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
