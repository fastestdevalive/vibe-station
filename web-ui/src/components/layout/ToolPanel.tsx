import { useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Rows2, X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import type { ToolTab } from "@/hooks/useStore";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";
import { useLayout } from "@/hooks/useLayout";
import { FilesPanel } from "@/components/tools/FilesPanel";
import { DevicesPanel } from "@/components/tools/DevicesPanel";
import { ArtifactsPanel } from "@/components/tools/ArtifactsPanel";
import { VcsPanel } from "@/components/tools/VcsPanel";
import { ToolFullscreenButton } from "@/components/tools/ToolFullscreenButton";
import { LspStatusRow } from "@/components/layout/LspStatusRow";
import { FilesLeftRail } from "@/components/layout/FilesLeftRail";
import { ToolsInsetProvider } from "@/context/ToolsInsetContext";

interface ToolPanelProps {
  api: ApiInstance;
  /** Context id: a worktree id (scope="worktree") or a project id (scope="project"). */
  worktreeId: string | null;
  /** Browsing scope. "project" is used by direct sessions (files in the base dir). */
  scope?: FileScope;
  /** Worktree's base branch (e.g. "main"), for the VCS tab's upstream-commits group label. */
  baseBranch?: string;
  /** Worktree's own branch name, rendered as a chip in the VCS tab header. */
  branch?: string;
  /**
   * True when this same ToolPanel instance is currently portaled into a
   * workspace-canvas tile (WorkspaceCanvas.tsx) rather than the classic
   * docked tool-panel region.
   */
  hidePanelControls?: boolean;
  /** Called when the user clicks the "+" tab or presses Ctrl+P to open the file quick-open dialog. */
  onOpenQuickOpen?: () => void;
  /**
   * Called when the user wants to remove this ToolPanel from the workspace
   * canvas tile it is currently inside.
   */
  onClose?: () => void;
}

export const RAIL_WIDTH = 36;
export const FILES_LEFT_PANE_DEFAULT_WIDTH = 240;
export const FILES_LEFT_PANE_MIN_WIDTH = 160;
export const FILES_LEFT_PANE_MAX_WIDTH = 600;
export const FILES_LEFT_PANE_DEFAULT_HEIGHT = 240;
export const FILES_LEFT_PANE_MIN_HEIGHT = 100;
export const FILES_LEFT_PANE_MAX_HEIGHT = 600;

/**
 * Right-side tool panel (R1–R7, R14, R16):
 * - Horizontal tab strip is removed (R1).
 * - Consolidated vertical left rail (FilesLeftRail) selects tool + Files sub-modes (R1–R3).
 * - Rail and FilesLeftPane are overlays (R4) with insets mechanism (R5).
 * - ToolFullscreenButton relocated to top-right overlay matching top-bar height (R6).
 * - Devices tool is disabled in the rail (R7).
 * - Isolation and stacking context scoped (R14).
 * - Preserves state across fullscreen and implements two-step Esc handling (R16).
 */
export function ToolPanel({
  api,
  worktreeId,
  scope = "worktree",
  baseBranch,
  branch,
  hidePanelControls = false,
  onOpenQuickOpen,
  onClose,
}: ToolPanelProps) {
  const { toolPanelTab, setToolPanelTab, activeWorktreeId, activeDirectContextId } = useLayout();

  const filesWt = worktreeId ?? "__none__";
  const fileTreeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  const masterDetailVertical = useWorkspaceStore(
    (s) => !!(s.layoutByWorktree[filesWt] ?? DEFAULT_WORKTREE_LAYOUT).masterDetailVertical,
  );
  const setMasterDetailVertical = useWorkspaceStore((s) => s.setMasterDetailVertical);
  const storedWidth = useWorkspaceStore(
    (s) => s.filesLeftPaneWidthByWorktree[filesWt] ?? FILES_LEFT_PANE_DEFAULT_WIDTH,
  );
  const storedHeight = useWorkspaceStore(
    (s) => s.filesLeftPaneHeightByWorktree[filesWt] ?? FILES_LEFT_PANE_DEFAULT_HEIGHT,
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const activePanelWidth = dragWidth ?? storedWidth;
  const activePanelHeight = dragHeight ?? storedHeight;

  // Decision 9 migration: persisted `toolPanelTab === "search"` seeds Files rail into search mode.
  // Persisted "devices"/"artifacts" (from before they were disabled, or via direct state
  // manipulation) are folded into "files" too — those tools have no active rail button, so
  // leaving the tab on one of them would render a tool with no rail highlight.
  const effectiveTab = (
    toolPanelTab === "search" || toolPanelTab === "devices" || toolPanelTab === "artifacts"
      ? "files"
      : toolPanelTab
  ) as ToolTab;

  useEffect(() => {
    const isActiveContext = worktreeId != null && worktreeId === (activeWorktreeId ?? activeDirectContextId);
    if (isActiveContext && (toolPanelTab === "search" || toolPanelTab === "devices" || toolPanelTab === "artifacts")) {
      const wasSearch = toolPanelTab === "search";
      setToolPanelTab("files");
      if (wasSearch) {
        useWorkspaceStore.getState().setFilesLeftPaneMode(worktreeId, "search");
      }
    }
  }, [toolPanelTab, worktreeId, activeWorktreeId, activeDirectContextId, setToolPanelTab]);

  const isPanelOpen = effectiveTab === "files" && fileTreeVisible;
  const panelWidth = isPanelOpen ? activePanelWidth : 0;
  const leftInset = RAIL_WIDTH + panelWidth;

  const insetContextValue = useMemo(
    () => ({
      isPanelOpen,
    }),
    [isPanelOpen],
  );

  // R16: Escape-key handling order when both expanded panel and fullscreen are
  // active: pressing Esc first closes the files panel (if open); a second Esc
  // then exits tools-pane fullscreen.
  //
  // Scoped to THIS tools pane: the listener is attached to the container in
  // the BUBBLE phase (not a window capture-phase listener), so it only fires
  // when focus is actually inside this tools pane. It must never swallow Esc
  // meant for the terminal (Claude Code Esc-to-interrupt, vim) or for Quick
  // Open — both of which live outside this pane and keep their own Esc
  // handling. When focus is in the terminal or a dialog, this listener isn't
  // on the event path at all, so Esc passes through untouched. Because it's a
  // container listener rather than a window one, multiple tools tiles can each
  // mount one without the two cancelling each other.
  const escPaneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = escPaneRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = useWorkspaceStore.getState();
      // Same resolution as useLayout(): the layout may have no persisted entry
      // yet (fresh view), in which case the DEFAULT layout's tab applies — the
      // default is "files", so a bare store lookup would wrongly report the
      // files panel as not-open here.
      const key = s.activeWorktreeId ?? s.activeDirectContextId;
      const layout = s.layoutByWorktree[key ?? ""] ?? DEFAULT_WORKTREE_LAYOUT;
      const effectiveTabForEsc = layout.toolPanelTab === "search" ? "files" : layout.toolPanelTab;
      const panelOpen = effectiveTabForEsc === "files" && s.fileTreeVisible;
      if (panelOpen) {
        e.stopPropagation();
        s.toggleFileTree();
      } else if (s.workspacePaneFullscreen === "tools") {
        e.stopPropagation();
        s.setWorkspacePaneFullscreen(null);
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <ToolsInsetProvider value={insetContextValue}>
      <div
        ref={escPaneRef}
        className="tool-panel pane-stack"
        style={
          {
            position: "relative",
            isolation: "isolate",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            "--tools-rail-w": `${RAIL_WIDTH}px`,
            "--tools-rail-panel-w": `${activePanelWidth}px`,
            "--tools-rail-panel-h": `${activePanelHeight}px`,
            "--tools-left-inset": `${leftInset}px`,
          } as React.CSSProperties
        }
      >
        {/* Rail as vertical overlay on the left edge (R1, R4). The wrapper is a
            flex container (not just position:absolute) so the rail stretches to
            the pane's full height instead of only its icon content — otherwise
            the rail background/border stops partway down and preview content
            shows through the column below the last icon. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: `${RAIL_WIDTH}px`,
            zIndex: 10,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <FilesLeftRail worktreeId={filesWt} />
        </div>

        {/* Relocated top-right action: orientation toggle + ToolFullscreenButton or canvas Close button */}
        <div
          className="tool-panel__top-actions"
          style={{
            position: "absolute",
            top: 0,
            right: "var(--space-2)",
            height: "32px",
            display: "flex",
            alignItems: "center",
            gap: "2px",
            zIndex: 30,
          }}
        >
          {effectiveTab === "files" ? (
            <button
              type="button"
              className="tab tab--icon tool-bar-btn"
              aria-label={masterDetailVertical ? "Switch to side-by-side layout" : "Switch to stacked layout"}
              title={masterDetailVertical ? "Side-by-side layout" : "Stacked layout"}
              onClick={() => setMasterDetailVertical(filesWt, !masterDetailVertical)}
            >
              {masterDetailVertical ? (
                <Rows2 size={13} strokeWidth={2} aria-hidden />
              ) : (
                <Columns2 size={13} strokeWidth={2} aria-hidden />
              )}
            </button>
          ) : null}
          {!hidePanelControls ? (
            <ToolFullscreenButton />
          ) : onClose ? (
            <button
              type="button"
              className="tab tab--icon tool-bar-btn"
              aria-label="Close tool tile"
              title="Close tool tile"
              onClick={onClose}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>

        {/* Content body: zero rail inset for files tool (preview draws underneath rail, §4b) */}
        <div
          className="tool-panel__body"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            paddingLeft: effectiveTab === "files" ? 0 : `${RAIL_WIDTH}px`,
            display: "flex",
            flexDirection: "column",
            position: "relative",
          }}
        >
          {worktreeId == null ? (
            <div className="empty-state">Select a worktree to use tools</div>
          ) : (
            <>
              {effectiveTab === "files" ? (
                <FilesPanel
                  api={api}
                  worktreeId={worktreeId}
                  scope={scope}
                  onOpenQuickOpen={onOpenQuickOpen}
                  currentWidth={activePanelWidth}
                  currentHeight={activePanelHeight}
                  onWidthDrag={setDragWidth}
                  onHeightDrag={setDragHeight}
                />
              ) : null}
              {effectiveTab === "devices" ? <DevicesPanel /> : null}
              {effectiveTab === "artifacts" ? <ArtifactsPanel worktreeId={worktreeId} /> : null}
              {effectiveTab === "vcs" ? (
                <VcsPanel
                  api={api}
                  worktreeId={worktreeId}
                  baseBranch={baseBranch}
                  branch={branch}
                  scope={scope}
                />
              ) : null}
            </>
          )}
        </div>

        {worktreeId != null ? (
          <div style={{ paddingLeft: `${RAIL_WIDTH}px` }}>
            <LspStatusRow api={api} worktreeId={worktreeId} scope={scope} />
          </div>
        ) : null}
      </div>
    </ToolsInsetProvider>
  );
}
