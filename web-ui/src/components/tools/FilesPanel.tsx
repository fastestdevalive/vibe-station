import { FileText, Minus, Plus, X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { FileTreeSidebar } from "@/components/layout/FileTreeSidebar";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";
import { MasterDetailShell } from "@/components/layout/MasterDetailShell";

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
 * Files tool — a thin wrapper over `MasterDetailShell` (Decision 5): the file
 * tree (navigation) on the left and the preview on the right, via the shared
 * shell's tree-toggle + resizable split. The open-file tab strip (only one
 * for now — the backend opens one file at a time) and the zoom controls are
 * passed as `topbarExtra`, rendered after the shell's own tree-toggle button.
 */
export function FilesPanel({ api, worktreeId, scope = "worktree" }: FilesPanelProps) {
  const wt = worktreeId ?? "__none__";

  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const bumpPreviewFont = useWorkspaceStore((s) => s.bumpPreviewFont);

  const topbarExtra = (
    <>
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
    </>
  );

  return (
    <MasterDetailShell
      storageKey={wt}
      topbarExtra={topbarExtra}
      leftPane={<FileTreeSidebar api={api} contextId={worktreeId} scope={scope} />}
      rightPane={<FilePreviewPane api={api} worktreeId={worktreeId} scope={scope} />}
    />
  );
}
