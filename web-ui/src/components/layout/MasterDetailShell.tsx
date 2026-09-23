import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Columns2, FolderTree, Rows2 } from "lucide-react";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";
import type { FilesLeftPaneHandle } from "@/components/layout/FilesLeftPane";

interface MasterDetailShellProps {
  /** Uniquely identifies this shell's persisted split size (`autoSaveId`). */
  storageKey: string;
  /** Worktree id used to persist the split orientation in the store. When
   *  omitted the toggle still works but orientation resets on remount. */
  worktreeId?: string | null;
  /** Whether to render the file-tree-visibility toggle button. Default true. */
  treeToggle?: boolean;
  /** Whether to render the layout-toggle (stacked/side-by-side) button. Default
   *  true — mirrors the existing `treeToggle` prop shape (B6/Decision 8). Gated
   *  on the same `treeVisible && worktreeId` condition as today, plus this new
   *  prop (which only ever suppresses it further). `FilesPanel` passes `false`
   *  since its own toggle now lives on the top-level "Files" tab button
   *  instead (ToolPanel.tsx); `VcsCommitView` keeps the default `true`, so its
   *  topbar button is unchanged. */
  layoutToggle?: boolean;
  /** Optional imperative handle to the left pane's ACTIVE-mode tabbable row
   *  (FilesLeftPane's `focusActivePane`). When present, the shell's refocus
   *  effects use it instead of a generic `[tabindex='0']` querySelector scoped
   *  to the whole left-pane slot — which, with always-mounted tree+search
   *  bodies, could match a `display:none` inactive pane's row and silently
   *  no-op (B4a). Absent (VcsCommitView), falls back to the querySelector. */
  leftPaneFocusHandle?: React.RefObject<FilesLeftPaneHandle | null>;
  /** The master (left) pane — a file tree or a changed-file list. */
  leftPane: ReactNode;
  /** The detail (right) pane — a file/diff preview. */
  rightPane: ReactNode;
  /** Extra topbar content rendered after the tree toggle, in the FULL-WIDTH
   *  topbar above both panes (a "Commits › commit #x" breadcrumb for the VCS
   *  commit view). Mutually exclusive with `rightPaneTopbar` in practice —
   *  `FilesPanel` uses `rightPaneTopbar` instead so its tab strip sits over
   *  the right pane only; `VcsCommitView` keeps using this one, full-width. */
  topbarExtra?: ReactNode;
  /** Content rendered as its OWN topbar row scoped to just the RIGHT pane
   *  (not the full shell width) — `FilesPanel`'s open-file tab strip and its
   *  own "+" add-file button, per live-review feedback: the tab strip
   *  shouldn't push the left pane (tree/search) down, so it moved to sit
   *  only above the preview it actually belongs to. When set, the shared
   *  full-width `.files-topbar` row is skipped entirely if
   *  `treeToggle`/`layoutToggle` are also both off (true for `FilesPanel`)
   *  — no empty bar, no dead space above the left pane, matching the
   *  mockup's original "tabs sit over the preview" framing more literally
   *  than the initial implementation did. */
  rightPaneTopbar?: ReactNode;
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
export function MasterDetailShell({ storageKey, worktreeId, treeToggle = true, layoutToggle = true, leftPaneFocusHandle, leftPane, rightPane, topbarExtra, rightPaneTopbar, autoFocusTree = false }: MasterDetailShellProps) {
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  const treeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const toggleFileTree = useWorkspaceStore((s) => s.toggleFileTree);
  const layoutByWorktree = useWorkspaceStore((s) => s.layoutByWorktree);
  const setMasterDetailVertical = useWorkspaceStore((s) => s.setMasterDetailVertical);
  const vertical = worktreeId
    ? !!(layoutByWorktree[worktreeId] ?? DEFAULT_WORKTREE_LAYOUT).masterDetailVertical
    : false;

  // Refocus the left pane's ACTIVE-mode tabbable row. When a
  // `leftPaneFocusHandle` (FilesLeftPane) is provided, use it — it is scoped
  // to whichever of the always-mounted tree/search bodies is the visible one,
  // so a `display:none` inactive pane's row can never be matched and silently
  // no-op a `.focus()` (B4a). Otherwise fall back to the generic querySelector
  // (VcsCommitView's single-body left pane has no mode-switching).
  const refocusLeftPane = useCallback(() => {
    if (leftPaneFocusHandle?.current) {
      leftPaneFocusHandle.current.focusActivePane();
      return;
    }
    const focusable =
      leftPaneRef.current?.querySelector<HTMLElement>("[tabindex='0']") ??
      leftPaneRef.current?.querySelector<HTMLElement>("[tabindex]");
    focusable?.focus({ preventScroll: true });
  }, [leftPaneFocusHandle]);

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
    requestAnimationFrame(() => refocusLeftPane());
  }, [refocusLeftPane]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!treeVisible) return;
    requestAnimationFrame(() => refocusLeftPane());
  }, [treeVisible, refocusLeftPane]);

  useEffect(() => {
    if (!autoFocusTree || !treeVisible) return;
    requestAnimationFrame(() => refocusLeftPane());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render the right pane's content, optionally preceded by its OWN scoped
  // topbar (`rightPaneTopbar`) — a vertical stack so `rightPane`'s own
  // `.pane-stack` (flex:1 + height:100%) fills whatever's left beneath it.
  const rightPaneContent = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      {rightPaneTopbar ? <div className="files-topbar">{rightPaneTopbar}</div> : null}
      <div style={{ flex: 1, minHeight: 0 }}>{rightPane}</div>
    </div>
  );

  return (
    <div className="files-panel">
      {treeToggle || layoutToggle || topbarExtra ? (
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
          {layoutToggle && treeVisible && worktreeId ? (
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
      ) : null}

      {/* B3 caveat (future pass): the `!treeVisible` branch conditionally mounts
          ONLY rightPane, so `leftPane` (FilesLeftPane → FileTreeSidebar/SearchPanel)
          unmounts/remounts on every tree-visibility toggle, wiping each mode's
          async state. Fixing that properly means always rendering leftPane and
          CSS-hiding it (mirroring FilesLeftPane's own display:none mode-switch),
          which would require collapsing the resizable panel — deliberately out of
          scope for the bug-fix pass. The rail/search-shortcut now force the tree
          pane visible when switching into search mode (B3), so this only bites a
          user who collapses the tree and later re-shows it. */}
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
              {rightPaneContent}
            </div>
          </Panel>
        </PanelGroup>
      ) : (
        <div className="files-panel__preview-only" onPointerDownCapture={handleRightPanePointerDown}>{rightPaneContent}</div>
      )}
    </div>
  );
}
