import { FolderTree, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useWorkspaceStore } from "@/hooks/useStore";

interface FilesLeftRailProps {
  /** Resolved context id: worktree id or direct-session project id. */
  worktreeId: string;
}

/**
 * Persistent 3-icon rail for the Files tool (confirmed rail mockup, report
 * Addendum, plus a post-review addition): panel-visibility toggle, ⊟ tree,
 * 🔍 search. Full-height sibling of the whole MasterDetailShell column
 * inside FilesPanel, NOT nested inside the shell (Architecture Diagram
 * structural note, B8). No owned state — reads/writes the store. The
 * panel-visibility toggle is the SAME control MasterDetailShell's topbar
 * used to render (relocated here, not duplicated — Decision 8/B6). The
 * layout-orientation toggle that used to live here as well has since moved
 * on (through two more homes) to attach directly to the top-level "Files"
 * tab button itself — see ToolPanel.tsx's `.tab__layout-toggle`.
 */
export function FilesLeftRail({ worktreeId }: FilesLeftRailProps) {
  const mode = useWorkspaceStore((s) => s.filesLeftPaneMode[worktreeId] ?? "tree");
  const setFilesLeftPaneMode = useWorkspaceStore((s) => s.setFilesLeftPaneMode);
  const fileTreeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const toggleFileTree = useWorkspaceStore((s) => s.toggleFileTree);

  // B3: the rail is a sibling OUTSIDE MasterDetailShell, whose left pane (which
  // hosts BOTH the tree and search bodies — FilesLeftPane always mounts them)
  // is unmounted whenever `fileTreeVisible` is false. A rail click that switches
  // modes would otherwise write state but show nothing. Ensure the tree pane is
  // visible before switching, so the target mode actually renders.
  const switchMode = (next: "tree" | "search") => {
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
    </div>
  );
}
