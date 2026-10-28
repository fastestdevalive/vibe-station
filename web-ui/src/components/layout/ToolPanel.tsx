import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Columns2, Rows2, X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { FileScope, PrStatus } from "@/api/types";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT, effectiveToolTab, isFilesLeftPaneOpen } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { worktreePrStatus } from "@/lib/statusColor";
import { useLayout } from "@/hooks/useLayout";
import { FilesPanel } from "@/components/tools/FilesPanel";
import { DevicesPanel } from "@/components/tools/DevicesPanel";
import { VcsPanel } from "@/components/tools/VcsPanel";
import { ToolFullscreenButton } from "@/components/tools/ToolFullscreenButton";
import { FilesLeftRail } from "@/components/layout/FilesLeftRail";
import { ToolsInsetProvider } from "@/context/ToolsInsetContext";
import { useActionsHost } from "@/context/TopActionsContext";
import { ToolActionsHost } from "@/components/layout/TopActionsSlot";
import { handleToolsEsc } from "@/lib/toolsEsc";
import { CommentsTray } from "@/components/comments/CommentsTray";
import { useIsMobile } from "@/hooks/useIsMobile";

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
   * docked tool-panel region. A tile has its own in-pane rail and never hosts
   * the global actions chip (so, despite the name, it is "in a canvas tile").
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

/**
 * Right-side tool panel (R1–R7, R14, R16):
 * - Horizontal tab strip is removed (R1).
 * - Rail: on desktop the window-level ToolsRailColumn; a canvas tile (`hidePanelControls`) and
 *   a phone (<=768px, no window rail) render their own right-edge rail (FilesLeftRail).
 * - The Files list panel is an overlay docked on the right of the preview.
 * - Pane controls (layout toggle, fullscreen / tile Close) are portaled into this panel's
 *   registered actions host (top row of the active surface), not an absolute overlay.
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
  const isMobile = useIsMobile();
  const inPaneRail = hidePanelControls || isMobile;

  const filesWt = worktreeId ?? "__none__";
  const fileTreeVisible = useWorkspaceStore((s) => s.fileTreeVisible);
  // References mode reveals the files left pane without flipping the persisted
  // `fileTreeVisible` preference (see `revealReferences`).
  const filesLeftPaneMode = useWorkspaceStore((s) => s.filesLeftPaneMode[filesWt] ?? "tree");
  const masterDetailVertical = useWorkspaceStore(
    (s) => !!(s.layoutByWorktree[filesWt] ?? DEFAULT_WORKTREE_LAYOUT).masterDetailVertical,
  );
  const setMasterDetailVertical = useWorkspaceStore((s) => s.setMasterDetailVertical);
  // Decision 9 migration: persisted `toolPanelTab === "search"` seeds Files rail into search mode.
  // Persisted "devices"/"artifacts" (from before they were disabled, or via direct state
  // manipulation) are folded into "files" too — Artifacts is now a Files list MODE (not a tab)
  // and Devices has no active rail button, so leaving the tab on one of them would render a
  // tool with no rail highlight.
  const effectiveTab = effectiveToolTab(toolPanelTab);

  useEffect(() => {
    const isActiveContext = worktreeId != null && worktreeId === (activeWorktreeId ?? activeDirectContextId);
    if (isActiveContext && effectiveToolTab(toolPanelTab) !== toolPanelTab) {
      const wasSearch = toolPanelTab === "search";
      setToolPanelTab("files");
      if (wasSearch) {
        useWorkspaceStore.getState().setFilesLeftPaneMode(worktreeId, "search");
      }
    }
  }, [toolPanelTab, worktreeId, activeWorktreeId, activeDirectContextId, setToolPanelTab]);

  // The VCS commit view docks its changed-file list exactly like the Files list (right side, same size/handle);
  // the VCS rail icon owns its visibility (`vcsSidebarVisibleByWorktree`).
  const vcsCommitOpen = useWorkspaceStore(
    (s) =>
      effectiveTab === "vcs" &&
      !!s.vcsSelectedCommitByWorktree[filesWt] &&
      (s.vcsSidebarVisibleByWorktree[filesWt] ?? true),
  );
  const isPanelOpen =
    vcsCommitOpen || (effectiveTab === "files" && isFilesLeftPaneOpen(fileTreeVisible, filesLeftPaneMode));
  const stackedList = isPanelOpen && masterDetailVertical;

  // One host per panel: `hostScope` selects this panel's host for the pane controls, and
  // (when `hostsGlobal`) the same host may reserve the actions chip's width.
  // Sticky offscreen panels and canvas tiles never take the global node.
  const hostScope = useId();
  const hostsGlobal =
    !hidePanelControls && (worktreeId ?? null) === (activeWorktreeId ?? activeDirectContextId ?? null);
  // Desktop side-by-side list open: its mode header reserves the chip's width (rightmost row).
  const listHostsGlobal = hostsGlobal && isPanelOpen && !masterDetailVertical && !isMobile;
  // An open list's mode header carries the pane controls: stacked on any size, side-by-side on phones.
  const phoneSideList = isPanelOpen && !masterDetailVertical && isMobile;
  const listHostsPane = stackedList || phoneSideList;

  const insetContextValue = useMemo(
    () => ({
      isPanelOpen,
      listHostsPane,
      hostScope,
      hostsGlobal,
      listHostsGlobal,
      filesMode: vcsCommitOpen ? ("commit" as const) : filesLeftPaneMode,
    }),
    [isPanelOpen, listHostsPane, hostScope, hostsGlobal, listHostsGlobal, filesLeftPaneMode, vcsCommitOpen],
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
  const filesWtRef = useRef(filesWt);
  useEffect(() => {
    filesWtRef.current = filesWt;
  }, [filesWt]);
  useEffect(() => {
    const el = escPaneRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => handleToolsEsc(e, filesWtRef.current, escPaneRef.current);
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, []);

  // PR status for the VCS panel — resolved from the session store (branch-guarded).
  const sessions = useServerStore((s) => s.sessions);
  const prStatus: PrStatus | null = useMemo(() => {
    if (!worktreeId || scope === "project") return null;
    const wtSessions = sessions.filter((s) => s.worktreeId === worktreeId);
    return worktreePrStatus(wtSessions, branch ?? "");
  }, [worktreeId, scope, sessions, branch]);

  // Pane controls ride the actions registry: portaled into this panel's picked host.
  const paneHost = useActionsHost({ scope: hostScope });
  const toolsFullscreen = useWorkspaceStore((s) => s.workspacePaneFullscreen === "tools");
  // Fullscreen row (board Layouts D) shows only Exit fullscreen; Ctrl+/ still toggles layout.
  const showLayoutToggle = (effectiveTab === "files" || vcsCommitOpen) && !(hostsGlobal && toolsFullscreen);
  // The layout toggle moves the pane controls to another host (the Files bar <-> the list header), which remounts
  // the very button that was clicked. Remember that the toggle had focus and hand it to the new host's toggle.
  // One-shot: armed by the toggle's click, consumed by the next host change (found a button or not). It only moves
  // focus when it fell to <body> (the clicked button was unmounted), so a stale arm can never steal focus.
  const refocusToggleRef = useRef(false);
  useLayoutEffect(() => {
    if (!paneHost || !refocusToggleRef.current) return;
    refocusToggleRef.current = false;
    const btn = paneHost.paneEl.querySelector<HTMLElement>("[data-pane-control='layout-toggle']");
    const active = document.activeElement;
    if (btn && (!active || active === document.body)) btn.focus({ preventScroll: true });
  }, [paneHost]);
  const paneControls = (
    <>
      {showLayoutToggle ? (
        <button
          type="button"
          className="tab tab--icon tool-bar-btn"
          aria-label={masterDetailVertical ? "Switch to side-by-side layout" : "Switch to stacked layout"}
          title={masterDetailVertical ? "Side-by-side layout" : "Stacked layout"}
          data-pane-control="layout-toggle"
          onClick={(e) => {
            // Only a keyboard/focused activation needs focus carried over (a pointer click leaves it on the button too).
            refocusToggleRef.current = e.currentTarget === document.activeElement;
            setMasterDetailVertical(filesWt, !masterDetailVertical);
          }}
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
    </>
  );
  const hasBar = worktreeId == null || (effectiveTab !== "files" && effectiveTab !== "vcs");

  return (
    <ToolsInsetProvider value={insetContextValue}>
      <div
        ref={escPaneRef}
        tabIndex={-1}
        id={hostsGlobal ? "tools-pane" : undefined}
        className="tool-panel pane-stack"
        style={
          {
            position: "relative",
            isolation: "isolate",
            height: "100%",
            display: "flex",
            flexDirection: "row",
          } as React.CSSProperties
        }
      >
        <div
          className="tool-panel__content"
          style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
        {paneHost ? createPortal(paneControls, paneHost.paneEl) : null}

        {/* Host bar: only where the active surface has no top row of its own (empty state,
            tabs other than Files/VCS). Files and VCS host in their own bars. */}
        {hasBar ? (
          <div className="tool-panel__bar actions-row" data-tauri-drag-region="deep">
            <ToolActionsHost />
          </div>
        ) : null}

        {/* Content body */}
        <div
          className="tool-panel__body"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
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
                />
              ) : null}
              {effectiveTab === "devices" ? <DevicesPanel /> : null}
              {effectiveTab === "vcs" ? (
                <VcsPanel
                  api={api}
                  worktreeId={worktreeId}
                  baseBranch={baseBranch}
                  branch={branch}
                  scope={scope}
                  prStatus={prStatus}
                />
              ) : null}
            </>
          )}
        </div>

        {/* Comments tray (R56): a sibling AFTER the body, so it never changes the agent panel's tree path. */}
        {worktreeId != null ? (
          <CommentsTray api={api} scopeId={worktreeId} scopeKind={scope === "project" ? "project" : "worktree"} />
        ) : null}
        </div>

        {/* In-pane rail on the right edge: canvas tiles (board C) and phones (no window rail at
            <=768px). A trailing sibling of the content column; ToolPanel holds no PTY. */}
        {inPaneRail ? (
          <aside className={`tool-panel__tile-rail${isMobile ? " tool-panel__tile-rail--touch" : ""}`}>
            <FilesLeftRail worktreeId={filesWt} />
          </aside>
        ) : null}
      </div>
    </ToolsInsetProvider>
  );
}
