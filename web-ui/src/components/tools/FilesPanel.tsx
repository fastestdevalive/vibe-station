import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { FileText, FolderTree, Minus, Plus, X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { FileTreeSidebar } from "@/components/layout/FileTreeSidebar";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";

interface FilesPanelProps {
  api: ApiInstance;
  /** Context id: worktree id (scope="worktree") or project id (scope="project"). */
  worktreeId: string | null;
  scope?: FileScope;
}

/** Last path segment — the file name shown on the tab. */
function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Files tool — master-detail: the file tree (navigation) on the left and the
 * preview on the right. A single full-width bar spans both: a file-tree toggle,
 * a strip of open-file tabs (only one for now — the backend opens one file at a
 * time), and the panel controls (zoom / fullscreen / close). The tree column is
 * collapsible via the toggle.
 */
export function FilesPanel({ api, worktreeId, scope = "worktree" }: FilesPanelProps) {
  const wt = worktreeId ?? "__none__";

  const treeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const toggleFileTree = useWorkspaceStore((s) => s.toggleFileTree);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const bumpPreviewFont = useWorkspaceStore((s) => s.bumpPreviewFont);

  const preview = <FilePreviewPane api={api} worktreeId={worktreeId} scope={scope} />;

  return (
    <div className="files-panel">
      <div className="files-topbar">
        <button
          type="button"
          className={`files-topbar__tree-toggle${treeVisible ? " files-topbar__tree-toggle--on" : ""}`}
          aria-label={treeVisible ? "Hide file tree" : "Show file tree"}
          aria-pressed={treeVisible}
          title={treeVisible ? "Hide file tree" : "Show file tree"}
          onClick={() => toggleFileTree()}
        >
          <FolderTree size={15} />
        </button>
        {/* Open-file tabs. Only one file is open at a time today, so this is a
            single chip; ARIA tab roles are deferred until real multi-tab lands. */}
        <div className="files-topbar__tabs">
          {activeFilePath ? (
            <span className="files-topbar__tab" data-active title={activeFilePath}>
              <FileText size={13} aria-hidden />
              <span className="files-topbar__tab-name">{baseName(activeFilePath)}</span>
              <button
                type="button"
                className="files-topbar__tab-close"
                aria-label={`Close ${baseName(activeFilePath)}`}
                title="Close file"
                onClick={() => setActiveFile(null)}
              >
                <X size={12} />
              </button>
            </span>
          ) : (
            <span className="files-topbar__empty">No file open</span>
          )}
          <button
            type="button"
            className="files-topbar__add"
            disabled
            aria-label="Open another file"
            title="Open more files at once (coming soon)"
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="files-topbar__controls">
          <span className="files-topbar__zoom-label" aria-hidden>Aa</span>
          <button type="button" className="tab tab--icon" aria-label="Decrease preview font" onClick={() => bumpPreviewFont(-0.05)}>
            <Minus size={11} />
          </button>
          <button type="button" className="tab tab--icon" aria-label="Increase preview font" onClick={() => bumpPreviewFont(0.05)}>
            <Plus size={11} />
          </button>
        </div>
      </div>

      {treeVisible ? (
        <PanelGroup direction="horizontal" autoSaveId={`vs-files-${wt}`} style={{ width: "100%", flex: 1, minHeight: 0 }}>
          <Panel defaultSize={34} minSize={16} maxSize={60}>
            <div className="pane-fill-host">
              <FileTreeSidebar api={api} contextId={worktreeId} scope={scope} />
            </div>
          </Panel>
          <PanelResizeHandle className="resize-handle resize-handle--col" />
          <Panel defaultSize={66} minSize={30}>
            {preview}
          </Panel>
        </PanelGroup>
      ) : (
        <div className="files-panel__preview-only">{preview}</div>
      )}
    </div>
  );
}
