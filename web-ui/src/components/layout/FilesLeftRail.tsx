import {
  FolderTree,
  GitBranch,
  List,
  ListTree,
  MonitorSmartphone,
  Package,
  Search,
} from "lucide-react";
import { useWorkspaceStore, type FilesLeftPaneMode } from "@/hooks/useStore";
import { useLayout } from "@/hooks/useLayout";

interface FilesLeftRailProps {
  /** Resolved context id: worktree id or direct-session project id. */
  worktreeId: string;
}

interface FileModeItem {
  mode: FilesLeftPaneMode;
  label: string;
  icon: typeof FolderTree;
}

const FILE_MODES: FileModeItem[] = [
  { mode: "tree", label: "Switch to file tree", icon: FolderTree },
  { mode: "search", label: "Search files", icon: Search },
  { mode: "outline", label: "Outline", icon: ListTree },
  { mode: "references", label: "References", icon: List },
];

/**
 * Consolidated vertical left rail (Revision 2):
 * - Top group: Tree, Search, Outline, References (file tools and sub-modes)
 *   Clicking switches to Files tool and toggles/opens that sub-mode.
 * - Divider
 * - Bottom group: Devices (disabled), Artifacts (disabled), VCS (enabled).
 */
export function FilesLeftRail({ worktreeId }: FilesLeftRailProps) {
  const { toolPanelTab, setToolPanelTab } = useLayout();
  const effectiveTab = toolPanelTab === "search" ? "files" : toolPanelTab;

  const mode = useWorkspaceStore((s) => s.filesLeftPaneMode[worktreeId] ?? "tree");
  const setFilesLeftPaneMode = useWorkspaceStore((s) => s.setFilesLeftPaneMode);
  const fileTreeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const toggleFileTree = useWorkspaceStore((s) => s.toggleFileTree);
  // VCS rail-icon toggle state (Revision 4): scoped to "a commit is open + its
  // changed-file sidebar is visible", independent of the Files rail-mode state.
  const vcsSelectedCommitSha = useWorkspaceStore((s) => s.vcsSelectedCommitByWorktree[worktreeId] ?? null);
  const vcsSidebarVisible = useWorkspaceStore((s) => s.vcsSidebarVisibleByWorktree[worktreeId] ?? true);
  const setVcsSidebarVisible = useWorkspaceStore((s) => s.setVcsSidebarVisible);

  const handleModeClick = (clickedMode: FilesLeftPaneMode) => {
    if (effectiveTab !== "files") {
      setToolPanelTab("files");
      if (!fileTreeVisible) {
        toggleFileTree();
      }
      setFilesLeftPaneMode(worktreeId, clickedMode);
      return;
    }

    if (fileTreeVisible && mode === clickedMode) {
      // Press active icon again to close
      toggleFileTree();
    } else {
      // Open if closed or switch mode
      if (!fileTreeVisible) {
        toggleFileTree();
      }
      setFilesLeftPaneMode(worktreeId, clickedMode);
    }
  };

  const isVcsActive = effectiveTab === "vcs";
  const isVcsCommitOpen = !!vcsSelectedCommitSha;
  // The VCS icon is a plain active-tool selector in State A (no commit open,
  // `aria-pressed` = VCS tab active), but becomes an open/closed toggle once a
  // commit is open (State B/C, `aria-pressed` = changed-file sidebar visible).
  const vcsPressed = isVcsActive && (!isVcsCommitOpen || vcsSidebarVisible);

  const handleVcsClick = () => {
    if (effectiveTab !== "vcs") {
      setToolPanelTab("vcs");
      return;
    }
    // Already on VCS: with a commit open the rail icon toggles its changed-file
    // sidebar (State B ↔ C); with no commit open (State A) it's a no-op.
    if (isVcsCommitOpen) {
      setVcsSidebarVisible(worktreeId, !vcsSidebarVisible);
    }
  };

  return (
    <div className="files-left-rail" role="toolbar" aria-label="Tools rail">
      {/* Top group: Tree, Search, Outline, References */}
      <div
        className="files-left-rail__group"
        role="group"
        aria-label="Files modes"
      >
        {FILE_MODES.map((fm) => {
          const Icon = fm.icon;
          // Active whenever the Files tool is selected AND this is the current
          // sub-mode — independent of the panel's open/closed visibility, so a
          // collapsed panel still shows which mode is selected (clicking the
          // icon again re-opens it in that mode).
          const isActive = effectiveTab === "files" && mode === fm.mode;
          return (
            <button
              key={fm.mode}
              type="button"
              aria-label={fm.label}
              aria-pressed={isActive}
              title={fm.label}
              className={`files-left-rail__btn${isActive ? " files-left-rail__btn--active" : ""}`}
              onClick={() => handleModeClick(fm.mode)}
            >
              <Icon size={16} />
            </button>
          );
        })}
      </div>

      <div className="files-left-rail__divider" role="separator" />

      {/* Bottom group: Devices (disabled), Artifacts (disabled), VCS (enabled) */}
      <div
        className="files-left-rail__group"
        role="group"
        aria-label="Tool selection"
      >
        <button
          type="button"
          aria-label="Devices (coming soon)"
          title="Devices (coming soon)"
          disabled
          className="files-left-rail__btn files-left-rail__btn--disabled"
        >
          <MonitorSmartphone size={16} />
        </button>

        <button
          type="button"
          aria-label="Artifacts (coming soon)"
          title="Artifacts (coming soon)"
          disabled
          className="files-left-rail__btn files-left-rail__btn--disabled"
        >
          <Package size={16} />
        </button>

        <button
          type="button"
          aria-label={isVcsActive && isVcsCommitOpen ? "Toggle changed files" : "Version Control"}
          aria-pressed={vcsPressed}
          title={isVcsActive && isVcsCommitOpen ? "Toggle changed files" : "Version Control"}
          className={`files-left-rail__btn${vcsPressed ? " files-left-rail__btn--active" : ""}`}
          onClick={handleVcsClick}
        >
          <GitBranch size={16} />
        </button>
      </div>
    </div>
  );
}
