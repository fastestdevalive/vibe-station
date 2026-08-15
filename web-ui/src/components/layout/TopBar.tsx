import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  LayoutGrid,
  PanelLeft,
  PanelRight,
  PanelTop,
  Rows2,
  Search,
  SquareTerminal,
} from "lucide-react";
import { useLayout } from "@/hooks/useLayout";
import { useWorkspaceStore } from "@/hooks/useStore";
import type { Project, Session, Worktree } from "@/api/types";
import { sessionLabel } from "@/lib/sessionLabel";
import { ConnectionStatus } from "@/components/layout/ConnectionStatus";
import { Logo } from "@/components/shared/Logo";
import { ToolbarOutlet, WORKSPACE_CANVAS_TOOLBAR_KEY } from "@/components/layout/paneOutlets";

function shortcutHints() {
  if (typeof navigator === "undefined") {
    return { fileTree: "⌘⇧F", preview: "⌘⇧P", terminal: "⌘⇧Z", quickOpen: "⌘P" };
  }
  const mac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform ?? navigator.userAgent);
  if (mac) {
    return { fileTree: "⌘⇧F", preview: "⌘⇧P", terminal: "⌘⇧Z", quickOpen: "⌘P" };
  }
  return {
    fileTree: "Ctrl+Shift+F",
    preview: "Ctrl+Shift+P",
    terminal: "Ctrl+Shift+Z",
    quickOpen: "Ctrl+P",
  };
}

interface TopBarProps {
  /** Dashboard keeps projects sidebar; omits quick open, terminal layout, and pane toggles.
   *  login = unauthenticated state — only shows brand + "not signed in" chip, no sidebar.
   *  direct-session = terminal-only view for direct sessions (no worktree).
   *  workspace-view = detached saved-workspace view (agent-interaction-workspaces/
   *  04-workspaces Phase 3c) — no owning worktree, so (like dashboard) it omits
   *  quick open and the per-worktree pane toggles; the canvas is fully
   *  self-contained instead. */
  layoutMode?: "workspace" | "dashboard" | "settings" | "login" | "direct-session" | "workspace-view";
  projects: Project[];
  worktrees: Worktree[];
  /** Direct session for breadcrumb (when layoutMode === "direct-session") */
  directSession?: Session;
  /** Project for direct session breadcrumb */
  directSessionProject?: Project;
  /** Viewed WorkspaceDoc's name for breadcrumb (when layoutMode === "workspace-view") */
  viewedWorkspaceName?: string;
  isMobile: boolean;
  onToggleLeftSidebar: () => void;
  leftSidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  onOpenQuickOpen: () => void;
  leftColumnPx?: number;
}

export function TopBar({
  layoutMode = "workspace",
  projects,
  worktrees,
  directSession,
  directSessionProject,
  viewedWorkspaceName,
  isMobile,
  onToggleLeftSidebar,
  leftSidebarCollapsed,
  mobileSidebarOpen,
  onOpenQuickOpen,
  leftColumnPx,
}: TopBarProps) {
  const {
    activeProjectId,
    activeWorktreeId,
    toolPanelVisible,
    toggleToolPanel,
    terminalDockVisible,
    toggleTerminalDock,
    toolSplitOrientation,
    toggleToolSplitOrientation,
    canvasToolbarVisible,
    toggleCanvasToolbar,
    hasWorktreeToolsTile,
    toggleWorktreeToolsTile,
    // ⚠️ NAMING TRAP: this is the per-worktree pane-arrangement mode
    // ("classic" | "workspace") from useLayout()'s WorktreeLayout slice —
    // unrelated to this component's own `layoutMode` prop (page-routing:
    // "workspace" | "dashboard" | "settings" | ...). Alias it.
    layoutMode: paneLayoutMode,
    setLayoutMode,
  } = useLayout();
  const clearWorkspaceSelection = useWorkspaceStore((s) => s.clearWorkspaceSelection);

  const project = projects.find((p) => p.id === activeProjectId);
  const wt = worktrees.find((w) => w.id === activeWorktreeId);

  const hints = shortcutHints();

  const sidebarExpanded = isMobile ? mobileSidebarOpen : !leftSidebarCollapsed;

  // Measure the brand button so we can align the crumb to the sidebar's right edge.
  const brandRef = useRef<HTMLAnchorElement>(null);
  const [brandWidth, setBrandWidth] = useState(0);
  useEffect(() => {
    if (brandRef.current) setBrandWidth(brandRef.current.offsetWidth);
  }, []);

  // Target x = leftColumnPx + 12 (the sidebar's right edge, PLUS the same
  // --space-3 left padding every content panel below uses — WorkspaceCanvas's
  // own toolbar row and every other pane's chrome all start there, not flush
  // against the bare sidebar edge — see workspace-canvas.css's
  // `.workspace-canvas__toolbar` padding). This top bar's own left
  // padding-left(12) + toggle(36) + gap(8) + brand + gap(8) is the offset
  // already consumed before the crumb, so the two +12/-12 cancel out.
  const crumbMarginLeft =
    !isMobile && !leftSidebarCollapsed && leftColumnPx != null && brandWidth > 0
      ? Math.max(8, leftColumnPx - 36 - 8 - brandWidth - 8)
      : undefined;

  const crumbParts: { label: string; highlight?: boolean }[] = [];
  if (layoutMode === "dashboard") {
    crumbParts.push({ label: "Dashboard" });
  } else if (layoutMode === "settings") {
    crumbParts.push({ label: "Settings" });
  } else if (layoutMode === "direct-session") {
    if (directSessionProject) crumbParts.push({ label: directSessionProject.name });
    if (directSession) crumbParts.push({ label: sessionLabel(directSession), highlight: true });
  } else if (layoutMode === "workspace-view") {
    crumbParts.push({ label: viewedWorkspaceName ?? "Workspace", highlight: true });
  } else {
    // Project > Worktree is enough — the active agent tab is already visible
    // in the agent pane's own TabsStrip; naming it again in the breadcrumb
    // was redundant, and crowded the crumb once the workspace-canvas toolbar
    // moved into this same bar.
    if (project) crumbParts.push({ label: project.name });
    if (wt) crumbParts.push({ label: wt.branch, highlight: true });
  }

  const crumbTitle = crumbParts.map((p) => p.label).join(" › ") || undefined;

  const mobileTitle =
    layoutMode === "dashboard"
      ? "Dashboard"
      : layoutMode === "settings"
        ? "Settings"
        : layoutMode === "direct-session"
          ? [directSessionProject?.name, directSession ? sessionLabel(directSession) : null].filter(Boolean).join(" · ") || "Direct Session"
          : layoutMode === "workspace-view"
            ? (viewedWorkspaceName ?? "Workspace")
            : [project?.name, wt ? `${wt.id} ${wt.branch}` : null].filter(Boolean).join(" · ") || undefined;

  const crumbNode = crumbParts.length === 0 ? (
    <span className="top-bar__crumb-seg">—</span>
  ) : (
    crumbParts.map((part, i) => (
      <span key={i} style={{ display: "contents" }}>
        {i > 0 && <span className="top-bar__crumb-sep">›</span>}
        <span className={`top-bar__crumb-seg${part.highlight ? " top-bar__crumb-seg--highlight" : ""}`}>
          {part.label}
        </span>
      </span>
    ))
  );

  // Login mode — minimal header, no sidebar or workspace controls
  if (layoutMode === "login") {
    return (
      <header className="top-bar">
        <div className="top-bar__row">
          <span
            className="top-bar__brand"
            style={{
              marginLeft: "var(--space-3)",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
            }}
          >
            <Logo />
            Vibe Station
          </span>
          <div className="top-bar__end">
            <span className="top-bar__login-status">● not signed in</span>
          </div>
        </div>
      </header>
    );
  }

  // The workspace-canvas toolbar (mode toggle / doc name / save / add tile)
  // is portaled up into THIS bar in exactly ONE case: the detached
  // /workspaces/:id page, where there's plenty of room top-right (no
  // per-worktree pane-toggle icons compete for space there).
  //
  // The classic per-worktree canvas mode deliberately does NOT portal: that
  // toolbar renders as WorkspaceCanvas's own dedicated full-height row
  // directly above the canvas body, disclosed/hidden by the chevron in the
  // canvas chip below (`toggleCanvasToolbar` → `canvasToolbarVisible`, which
  // WorkspaceCanvas reads as a prop). Squeezing it into this bar's
  // single-line height budget made it read as "just more top bar" instead of
  // a canvas toolbar.
  const isWorkspaceViewToolbar = layoutMode === "workspace-view";
  // The canvas chip (mode toggle + disclosure chevron) exists only for a
  // worktree in the classic per-worktree flow; the chevron inside it is
  // disabled — not unmounted — when that worktree isn't currently in canvas
  // mode, so the pair never appears/disappears independently of each other.
  const canvasChipWorktreeId = layoutMode === "workspace" ? activeWorktreeId : null;
  const inCanvasMode = paneLayoutMode === "workspace";

  return (
    <header className="top-bar">
      <div className="top-bar__row">
      <button
        type="button"
        className="icon-btn"
        aria-label={sidebarExpanded ? "Hide projects sidebar" : "Show projects sidebar"}
        aria-expanded={isMobile ? mobileSidebarOpen : undefined}
        title="Toggle projects sidebar"
        onClick={onToggleLeftSidebar}
      >
        <PanelLeft size={18} />
      </button>
      {!isMobile ? (
        <>
          <Link
            ref={brandRef}
            to="/"
            replace
            className="top-bar__brand"
            aria-label="Home"
            onClick={() => clearWorkspaceSelection()}
            style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
          >
            <Logo />
            Vibe Station
          </Link>
          <div
            className="top-bar__crumb"
            title={crumbTitle}
            style={crumbMarginLeft != null ? { marginLeft: crumbMarginLeft, transition: "margin-left 150ms ease" } : undefined}
          >
            {crumbNode}
          </div>
        </>
      ) : (
        <div className="top-bar__crumb top-bar__crumb--mobile-stack" title={mobileTitle}>
          {layoutMode === "dashboard" ? (
            <span className="top-bar__crumb-seg top-bar__mobile-line">Dashboard</span>
          ) : layoutMode === "settings" ? (
            <span className="top-bar__crumb-seg top-bar__mobile-line">Settings</span>
          ) : layoutMode === "workspace-view" ? (
            <span className="top-bar__crumb-seg top-bar__crumb-seg--highlight top-bar__mobile-line">
              {viewedWorkspaceName ?? "Workspace"}
            </span>
          ) : (
            <>
              <span className="top-bar__crumb-seg top-bar__mobile-line">{project?.name ?? "—"}</span>
              <div className="top-bar__mobile-wt-row">
                {wt ? (
                  <>
                    <span className="top-bar__crumb-seg top-bar__crumb-seg--highlight top-bar__mobile-line">
                      {wt.id}
                    </span>
                    <span className="top-bar__crumb-seg top-bar__crumb-seg--highlight top-bar__mobile-line">
                      {wt.branch}
                    </span>
                  </>
                ) : (
                  <span className="top-bar__crumb-seg top-bar__mobile-line">—</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
      <div className="top-bar__end">
        {isWorkspaceViewToolbar ? (
          // Detached workspace view: plenty of room top-right, same row as
          // the crumb — no per-worktree pane-toggle icons compete for space
          // here, so this doesn't need the compacted under-crumb treatment
          // the classic per-worktree canvas mode gets.
          <ToolbarOutlet paneKey={WORKSPACE_CANVAS_TOOLBAR_KEY} />
        ) : null}
        <ConnectionStatus />
        {layoutMode === "workspace" || layoutMode === "direct-session" ? (
          <>
            <button
              type="button"
              className="icon-btn"
              aria-label="Search files"
              title={`Search files (${hints.quickOpen})`}
              onClick={onOpenQuickOpen}
            >
              <Search size={18} />
            </button>
            <div className="top-bar__pane-toggles" role="toolbar" aria-label="Workspace panes">
              {canvasChipWorktreeId ? (
                // One visually-merged pill holding TWO independent buttons:
                // enter/leave canvas mode, and (thin, narrower) disclose the
                // canvas's own toolbar. They read as a unit because they act
                // on the same thing, but each stays a real, separately
                // focusable/labelled <button> — the chevron is never a
                // decoration hanging off the grid button.
                <div className="top-bar__canvas-chip">
                  <button
                    type="button"
                    className={`top-bar__pane-btn ${inCanvasMode ? "top-bar__pane-btn--on" : ""}`}
                    aria-pressed={inCanvasMode}
                    aria-label="Toggle workspace canvas layout"
                    title={
                      inCanvasMode
                        ? "Switch to classic layout"
                        : "Switch to workspace canvas (tiled/free-form panes)"
                    }
                    onClick={() =>
                      setLayoutMode(canvasChipWorktreeId, inCanvasMode ? "classic" : "workspace")
                    }
                  >
                    <LayoutGrid size={17} />
                  </button>
                  <button
                    type="button"
                    className="top-bar__pane-btn top-bar__canvas-chip-chevron"
                    aria-expanded={inCanvasMode ? canvasToolbarVisible : undefined}
                    // Same visible-but-disabled treatment as the split-
                    // orientation / terminal-dock buttons below: outside
                    // canvas mode there's no dedicated bar to disclose, but
                    // unmounting it would make the chip's second half blink
                    // in and out as the mode toggles.
                    disabled={!inCanvasMode}
                    aria-label={
                      !inCanvasMode
                        ? "Show canvas toolbar"
                        : canvasToolbarVisible
                          ? "Hide canvas toolbar"
                          : "Show canvas toolbar"
                    }
                    title={
                      !inCanvasMode
                        ? "Only available in canvas mode — switch to the workspace canvas first"
                        : canvasToolbarVisible
                          ? "Hide canvas toolbar (mode, save, add tile)"
                          : "Show canvas toolbar (mode, save, add tile)"
                    }
                    onClick={toggleCanvasToolbar}
                  >
                    {inCanvasMode && canvasToolbarVisible ? (
                      <ChevronUp size={15} />
                    ) : (
                      <ChevronDown size={15} />
                    )}
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className="top-bar__pane-btn"
                aria-label="Toggle agent/tools split orientation"
                disabled={paneLayoutMode === "workspace"}
                title={
                  paneLayoutMode === "workspace"
                    ? "Not applicable in canvas mode — each pane is its own tile"
                    : toolSplitOrientation === "horizontal"
                      ? "Stack agent and tools vertically"
                      : "Place agent and tools side by side"
                }
                onClick={toggleToolSplitOrientation}
              >
                {toolSplitOrientation === "horizontal" ? <Columns2 size={17} /> : <Rows2 size={17} />}
              </button>
              <button
                type="button"
                className={`top-bar__pane-btn ${terminalDockVisible ? "top-bar__pane-btn--on" : ""}`}
                aria-pressed={terminalDockVisible}
                aria-label="Toggle terminal dock"
                disabled={paneLayoutMode === "workspace"}
                title={
                  paneLayoutMode === "workspace"
                    ? "Not applicable in canvas mode — every terminal is its own tile (use Add tile)"
                    : `Toggle terminal dock (${hints.terminal})`
                }
                onClick={toggleTerminalDock}
              >
                <SquareTerminal size={17} />
              </button>
              <button
                type="button"
                className={`top-bar__pane-btn ${
                  (paneLayoutMode === "workspace" ? hasWorktreeToolsTile : toolPanelVisible)
                    ? "top-bar__pane-btn--on"
                    : ""
                }`}
                aria-pressed={paneLayoutMode === "workspace" ? hasWorktreeToolsTile : toolPanelVisible}
                aria-label={
                  paneLayoutMode === "workspace"
                    ? hasWorktreeToolsTile
                      ? "Remove Tools tile from canvas"
                      : "Add Tools tile to canvas"
                    : "Toggle tool panel"
                }
                title={
                  paneLayoutMode === "workspace"
                    ? hasWorktreeToolsTile
                      ? "Remove Tools tile from canvas"
                      : "Add Tools tile to canvas"
                    : "Toggle tool panel"
                }
                onClick={paneLayoutMode === "workspace" ? toggleWorktreeToolsTile : toggleToolPanel}
              >
                {/* Vertical split docks the tool panel to the top, so mirror
                    that with a top-panel icon instead of the right-panel one. */}
                {toolSplitOrientation === "vertical" ? <PanelTop size={17} /> : <PanelRight size={17} />}
              </button>
            </div>
          </>
        ) : null}
      </div>
      </div>
    </header>
  );
}
