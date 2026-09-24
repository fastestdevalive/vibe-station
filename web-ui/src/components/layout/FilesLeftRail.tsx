import { FolderTree, List, ListTree, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useWorkspaceStore, type FilesLeftPaneMode } from "@/hooks/useStore";

interface FilesLeftRailProps {
  /** Resolved context id: worktree id or direct-session project id. */
  worktreeId: string;
}

/**
 * Persistent rail for the Files tool: panel-visibility toggle,
 * tree, search, outline, references. Full-height sibling of the whole MasterDetailShell column
 * inside FilesPanel.
 */
export function FilesLeftRail({ worktreeId }: FilesLeftRailProps) {
  const mode = useWorkspaceStore((s) => s.filesLeftPaneMode[worktreeId] ?? "tree");
  const setFilesLeftPaneMode = useWorkspaceStore((s) => s.setFilesLeftPaneMode);
  const fileTreeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const toggleFileTree = useWorkspaceStore((s) => s.toggleFileTree);

  const switchMode = (next: FilesLeftPaneMode) => {
    if (!fileTreeVisible) toggleFileTree();
    setFilesLeftPaneMode(worktreeId, next);
  };

  return (
    <div className="files-left-rail" role="toolbar" aria-label="Files modes">
      <button
        type="button"
        className="files-left-rail__btn"
        aria-label={fileTreeVisible ? "Hide file tree" : "Show file tree"}
        aria-pressed={fileTreeVisible}
        title={fileTreeVisible ? "Hide file tree" : "Show file tree"}
        onClick={() => toggleFileTree()}
      >
        {fileTreeVisible ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>
      <button
        type="button"
        className={`files-left-rail__btn${mode === "tree" ? " files-left-rail__btn--active" : ""}`}
        aria-label="Switch to file tree"
        aria-pressed={mode === "tree"}
        title="File tree"
        onClick={() => switchMode("tree")}
      >
        <FolderTree size={16} />
      </button>
      <button
        type="button"
        className={`files-left-rail__btn${mode === "search" ? " files-left-rail__btn--active" : ""}`}
        aria-label="Search files"
        aria-pressed={mode === "search"}
        title="Search files"
        onClick={() => switchMode("search")}
      >
        <Search size={16} />
      </button>
      <button
        type="button"
        className={`files-left-rail__btn${mode === "outline" ? " files-left-rail__btn--active" : ""}`}
        aria-label="Outline"
        aria-pressed={mode === "outline"}
        title="Outline"
        onClick={() => switchMode("outline")}
      >
        <ListTree size={16} />
      </button>
      <button
        type="button"
        className={`files-left-rail__btn${mode === "references" ? " files-left-rail__btn--active" : ""}`}
        aria-label="References"
        aria-pressed={mode === "references"}
        title="References"
        onClick={() => switchMode("references")}
      >
        <List size={16} />
      </button>
    </div>
  );
}
