import { FileText, Plus, X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { FileTreeSidebar } from "@/components/layout/FileTreeSidebar";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";
import { MasterDetailShell } from "@/components/layout/MasterDetailShell";
import { usePendingFileOpens } from "@/hooks/usePendingFileOpens";

interface FilesPanelProps {
  api: ApiInstance;
  /** Context id: worktree id (scope="worktree") or project id (scope="project"). */
  worktreeId: string | null;
  scope?: FileScope;
  onOpenQuickOpen?: () => void;
}

const NO_TABS: string[] = [];

/** Last path segment — the file name shown on the tab. */
function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Files tool — a thin wrapper over `MasterDetailShell` (Decision 5): the file
 * tree (navigation) on the left and the preview on the right, via the shared
 * shell's tree-toggle + resizable split. The open-file tab strip and the zoom
 * controls are passed as `topbarExtra`, rendered after the shell's own
 * tree-toggle button.
 */
export function FilesPanel({ api, worktreeId, scope = "worktree", onOpenQuickOpen }: FilesPanelProps) {
  const wt = worktreeId ?? "__none__";

  const openTabs = useWorkspaceStore((s) => s.openFileTabsByWorktree[wt] ?? NO_TABS);
  const activeIdx = useWorkspaceStore((s) => s.activeFileTabIdxByWorktree[wt] ?? -1);
  const closeFileTab = useWorkspaceStore((s) => s.closeFileTab);
  const setActiveFileTabIdx = useWorkspaceStore((s) => s.setActiveFileTabIdx);

  usePendingFileOpens(api, worktreeId);

  const topbarExtra = (
    <>
      {/* Open-file tab strip (multi-tab). */}
      <div className="files-topbar__tabs" role="tablist" aria-label="Open files">
        {openTabs.length === 0 && (
          <span className="files-topbar__empty">No file open</span>
        )}
        {openTabs.map((path, idx) => {
          const isActive = idx === activeIdx;
          return (
            <span
              key={path}
              className="files-topbar__tab"
              data-active={isActive || undefined}
              title={path}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveFileTabIdx(wt, idx)}
            >
              <FileText size={13} aria-hidden />
              <span className="files-topbar__tab-name">{baseName(path)}</span>
              <button
                type="button"
                className="files-topbar__tab-close"
                aria-label={`Close ${baseName(path)}`}
                title="Close file"
                onClick={(e) => { e.stopPropagation(); closeFileTab(wt, idx); }}
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="files-topbar__add"
          aria-label="Open another file"
          title="Open file (Ctrl+P)"
          onClick={onOpenQuickOpen}
        >
          <Plus size={13} />
        </button>
      </div>
    </>
  );

  return (
    <MasterDetailShell
      storageKey={wt}
      worktreeId={worktreeId}
      topbarExtra={topbarExtra}
      leftPane={<FileTreeSidebar api={api} contextId={worktreeId} scope={scope} />}
      rightPane={<FilePreviewPane api={api} worktreeId={worktreeId} scope={scope} />}
    />
  );
}
