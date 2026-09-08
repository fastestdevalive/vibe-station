import type { ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { FolderTree } from "lucide-react";
import { useWorkspaceStore } from "@/hooks/useStore";

interface MasterDetailShellProps {
  /** Uniquely identifies this shell's persisted split size (`autoSaveId`). */
  storageKey: string;
  /** Whether to render the file-tree-visibility toggle button. Default true. */
  treeToggle?: boolean;
  /** The master (left) pane — a file tree or a changed-file list. */
  leftPane: ReactNode;
  /** The detail (right) pane — a file/diff preview. */
  rightPane: ReactNode;
  /** Extra topbar content rendered after the tree toggle (open-file tabs +
   *  zoom controls for the Files tab; a "Commits › commit #x" breadcrumb for
   *  the VCS commit view). */
  topbarExtra?: ReactNode;
}

/**
 * Shared master-detail shell (Decision 5) — a full-width topbar (tree-toggle
 * + caller-supplied `topbarExtra`) above a `leftPane`/`rightPane` split that
 * collapses to `rightPane`-only when the tree is hidden. Extracted verbatim
 * from `FilesPanel.tsx` so the VCS tab's commit quick-diff view (item 9)
 * reuses the exact same shell instead of a second bespoke master-detail UI.
 *
 * The tree-visibility flag (`fileTreeVisible`) is intentionally the same
 * global store slice for every shell instance — it is a UI layout
 * preference, not per-content state, unlike the `controlled` overrides
 * `FilePreviewPane`/`ChangedFileList` need (Decision 6).
 */
export function MasterDetailShell({ storageKey, treeToggle = true, leftPane, rightPane, topbarExtra }: MasterDetailShellProps) {
  const treeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const toggleFileTree = useWorkspaceStore((s) => s.toggleFileTree);

  return (
    <div className="files-panel">
      <div className="files-topbar">
        {treeToggle ? (
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
        ) : null}
        {topbarExtra}
      </div>

      {treeVisible ? (
        <PanelGroup direction="horizontal" autoSaveId={`vs-files-${storageKey}`} style={{ width: "100%", flex: 1, minHeight: 0 }}>
          <Panel defaultSize={34} minSize={16} maxSize={60}>
            <div className="pane-fill-host">{leftPane}</div>
          </Panel>
          <PanelResizeHandle className="resize-handle resize-handle--col" />
          <Panel defaultSize={66} minSize={30}>
            {rightPane}
          </Panel>
        </PanelGroup>
      ) : (
        <div className="files-panel__preview-only">{rightPane}</div>
      )}
    </div>
  );
}
