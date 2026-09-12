import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Columns2, FolderTree, Rows2 } from "lucide-react";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";

interface MasterDetailShellProps {
  /** Uniquely identifies this shell's persisted split size (`autoSaveId`). */
  storageKey: string;
  /** Worktree id used to persist the split orientation in the store. When
   *  omitted the toggle still works but orientation resets on remount. */
  worktreeId?: string | null;
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
  /** When true, focus the tree on mount (used by VcsCommitView so arrow keys
   *  work immediately when a commit opens). Deliberately distinct from the
   *  `treeVisible` effect, which skips the first render to avoid stealing
   *  focus from the agent when the tool pane first opens. */
  autoFocusTree?: boolean;
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
export function MasterDetailShell({ storageKey, worktreeId, treeToggle = true, leftPane, rightPane, topbarExtra, autoFocusTree = false }: MasterDetailShellProps) {
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  const treeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const toggleFileTree = useWorkspaceStore((s) => s.toggleFileTree);
  const layoutByWorktree = useWorkspaceStore((s) => s.layoutByWorktree);
  const setMasterDetailVertical = useWorkspaceStore((s) => s.setMasterDetailVertical);
  const vertical = worktreeId
    ? !!(layoutByWorktree[worktreeId] ?? DEFAULT_WORKTREE_LAYOUT).masterDetailVertical
    : false;

  const handleRightPanePointerDown = useCallback((e: React.PointerEvent) => {
    // Walk the composed path — if any ancestor is interactive, let it be.
    const interactiveTags = new Set(["BUTTON", "INPUT", "A", "TEXTAREA", "SELECT"]);
    const path = e.nativeEvent.composedPath() as Element[];
    if (path.some((el) => interactiveTags.has(el?.tagName) || (el as HTMLElement)?.isContentEditable)) return;
    // Exempt preview bodies — clicking to select text in a rendered preview
    // (code block, scroller, preview body) must not redirect arrow-key focus
    // to the file tree, or ArrowDown would open a different file mid-select.
    if ((e.target as Element).closest("pre, .cm-scroller, .preview-body, .workspace-markdown-preview, [data-no-tree-focus]")) return;
    // Re-focus the file tree container after the browser settles focus.
    requestAnimationFrame(() => {
      // Prefer the roving-tabindex winner; fall back to any [tabindex] for the
      // async case where no row is tabbable yet (the container div catches it).
      const focusable =
        leftPaneRef.current?.querySelector<HTMLElement>("[tabindex='0']") ??
        leftPaneRef.current?.querySelector<HTMLElement>("[tabindex]");
      focusable?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!treeVisible) return;
    requestAnimationFrame(() => {
      // Prefer the roving-tabindex winner; fall back to any [tabindex] for the
      // async case where no row is tabbable yet (the container div catches it).
      const focusable =
        leftPaneRef.current?.querySelector<HTMLElement>("[tabindex='0']") ??
        leftPaneRef.current?.querySelector<HTMLElement>("[tabindex]");
      focusable?.focus({ preventScroll: true });
    });
  }, [treeVisible]);

  useEffect(() => {
    if (!autoFocusTree || !treeVisible) return;
    requestAnimationFrame(() => {
      // Prefer the roving-tabindex winner; fall back to any [tabindex] for the
      // async case where no row is tabbable yet (the container div catches it).
      const focusable =
        leftPaneRef.current?.querySelector<HTMLElement>("[tabindex='0']") ??
        leftPaneRef.current?.querySelector<HTMLElement>("[tabindex]");
      focusable?.focus({ preventScroll: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        {treeVisible && worktreeId ? (
          <button
            type="button"
            className={`files-topbar__tree-toggle${vertical ? " files-topbar__tree-toggle--on" : ""}`}
            aria-label={vertical ? "Switch to side-by-side layout" : "Switch to stacked layout"}
            aria-pressed={vertical}
            title={vertical ? "Side-by-side layout" : "Stacked layout"}
            onClick={() => setMasterDetailVertical(worktreeId, !vertical)}
          >
            {vertical ? <Columns2 size={15} /> : <Rows2 size={15} />}
          </button>
        ) : null}
        {topbarExtra}
      </div>

      {treeVisible ? (
        <PanelGroup
          direction={vertical ? "vertical" : "horizontal"}
          autoSaveId={`vs-files-${storageKey}-${vertical ? "v" : "h"}`}
          style={{ width: "100%", flex: 1, minHeight: 0 }}
        >
          <Panel defaultSize={vertical ? 40 : 34} minSize={16} maxSize={60}>
            <div className="pane-fill-host" ref={leftPaneRef}>{leftPane}</div>
          </Panel>
          <PanelResizeHandle className={vertical ? "resize-handle resize-handle--row" : "resize-handle resize-handle--col"} />
          <Panel defaultSize={vertical ? 60 : 66} minSize={30}>
            <div style={{ width: "100%", height: "100%" }} onPointerDownCapture={handleRightPanePointerDown}>
              {rightPane}
            </div>
          </Panel>
        </PanelGroup>
      ) : (
        <div className="files-panel__preview-only" onPointerDownCapture={handleRightPanePointerDown}>{rightPane}</div>
      )}
    </div>
  );
}
