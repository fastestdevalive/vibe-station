import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Columns2,
  Keyboard,
  LayoutGrid,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PanelTop,
  Rows2,
  Search,
  Settings,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLayout } from "@/hooks/useLayout";
import type { Project, Worktree } from "@/api/types";
import { ConnectionStatus } from "@/components/layout/ConnectionStatus";
import { Logo } from "@/components/shared/Logo";
import { KeyboardShortcutsDialog } from "@/components/layout/KeyboardShortcutsDialog";
import { ToolbarOutlet, WORKSPACE_CANVAS_TOOLBAR_KEY } from "@/components/layout/paneOutlets";
import { useEventTargets } from "@/context/DemoEnv";

function shortcutHints() {
  if (typeof navigator === "undefined") {
    return {
      terminal: "⌘⇧Z",
      quickOpen: "⌘P",
      toolPane: "⌘\\",
      fileTreeToggle: "⌘E",
      splitToggle: "⌘/",
    };
  }
  const mac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform ?? navigator.userAgent);
  if (mac) {
    return {
      terminal: "⌘⇧Z",
      quickOpen: "⌘P",
      toolPane: "⌘\\",
      fileTreeToggle: "⌘E",
      splitToggle: "⌘/",
    };
  }
  return {
    terminal: "Ctrl+Shift+Z",
    quickOpen: "Ctrl+P",
    toolPane: "Ctrl+\\",
    fileTreeToggle: "Ctrl+E",
    splitToggle: "Ctrl+/",
  };
}

interface TopBarProps {
  /** Dashboard keeps projects sidebar; omits quick open, terminal layout, and pane toggles.
   *  login = unauthenticated state — only shows brand + "not signed in" chip, no sidebar.
   *  workspace-view = detached saved-workspace view (agent-interaction-workspaces/
   *  04-workspaces Phase 3c) — no owning worktree, so (like dashboard) it omits
   *  quick open and the per-worktree pane toggles; the canvas is fully
   *  self-contained instead.
   *  project-workspace = the tabbed /project/:id workspace (project-home-workspace):
   *  a pinned Project tab + one tab per open direct agent, one shared tools pane. */
  layoutMode?: "workspace" | "dashboard" | "settings" | "login" | "workspace-view" | "project-workspace";
  projects: Project[];
  worktrees: Worktree[];
  /** Viewed WorkspaceDoc's name for breadcrumb (when layoutMode === "workspace-view") */
  viewedWorkspaceName?: string;
  isMobile: boolean;
  onToggleLeftSidebar: () => void;
  leftSidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  onOpenQuickOpen: () => void;
  /** Mobile settings drill-in: label of the active section (e.g. "Remote Access") */
  settingsSectionLabel?: string;
  /** Mobile settings drill-in: back to section list */
  onSettingsBack?: () => void;
  /** Keyboard-shortcuts reference dialog — controlled by the parent. */
  shortcutsOpen?: boolean;
  onOpenShortcuts?: () => void;
  onCloseShortcuts?: () => void;
  /**
   * Presentation variant:
   * - "bar" (default): full-width top bar across the entire shell
   * - "sidebar-header": sidebar toggle + breadcrumb folded into LeftSidebar's header
   * - "floating": floating top-right widget overlapping the underlying pane
   */
  variant?: "bar" | "floating" | "sidebar-header";
  /** Chip text shown in `layoutMode="login"` (default "● not signed in"). */
  loginStatus?: string;
}

export function TopBar({
  layoutMode = "workspace",
  loginStatus = "● not signed in",
  projects,
  worktrees,
  viewedWorkspaceName,
  isMobile,
  onToggleLeftSidebar,
  leftSidebarCollapsed,
  mobileSidebarOpen,
  onOpenQuickOpen,
  settingsSectionLabel,
  onSettingsBack,
  shortcutsOpen = false,
  onOpenShortcuts,
  onCloseShortcuts,
  variant = "bar",
}: TopBarProps) {
  const navigate = useNavigate();
  const {
    activeProjectId,
    activeWorktreeId,
    toolPanelVisible,
    toggleToolPanel,
    terminalDockVisible,
    toggleTerminalDock,
    toolSplitOrientation,
    toolSplitOrientationUserSet,
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
  // On mobile the layout defaults to vertical stacking regardless of the stored value;
  // mirror the same logic as Layout.tsx so the overflow button reflects actual state.
  const effectiveSplitOrientation =
    !toolSplitOrientationUserSet && isMobile ? "vertical" : toolSplitOrientation;
  const project = projects.find((p) => p.id === activeProjectId);

  const { doc } = useEventTargets();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!overflowOpen) return;
    let raf: number;
    const onDown = (e: MouseEvent) => {
      raf = requestAnimationFrame(() => {
        if (!overflowMenuRef.current?.contains(e.target as Node)) {
          setOverflowOpen(false);
        }
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverflowOpen(false);
    };
    doc.addEventListener("mousedown", onDown as EventListener);
    doc.addEventListener("keydown", onKey as EventListener);
    return () => {
      doc.removeEventListener("mousedown", onDown as EventListener);
      doc.removeEventListener("keydown", onKey as EventListener);
      cancelAnimationFrame(raf);
    };
  }, [overflowOpen, doc]);

  const hints = shortcutHints();

  const sidebarExpanded = isMobile ? mobileSidebarOpen : !leftSidebarCollapsed;

  const crumbParts: { label: string; highlight?: boolean }[] = [];
  if (layoutMode === "dashboard") {
    crumbParts.push({ label: "Dashboard" });
  } else if (layoutMode === "settings") {
    crumbParts.push({ label: "Settings" });
    if (settingsSectionLabel) crumbParts.push({ label: settingsSectionLabel, highlight: true });
  } else if (layoutMode === "workspace-view") {
    crumbParts.push({ label: viewedWorkspaceName ?? "Workspace", highlight: true });
  } else {
    // Project name only — the branch/worktree name is already shown in the
    // global bottom bar, so repeating it here would be redundant.
    if (project) crumbParts.push({ label: project.name });
  }

  const crumbTitle = crumbParts.map((p) => p.label).join(" › ") || undefined;

  const mobileTitle =
    layoutMode === "dashboard"
      ? "Dashboard"
      : layoutMode === "settings"
        ? (settingsSectionLabel ?? "Settings")
        : layoutMode === "workspace-view"
          ? (viewedWorkspaceName ?? "Workspace")
          : project?.name;

  const crumbNode =
    crumbParts.length === 0 ? null : (
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
      <header className="top-bar" data-tauri-drag-region>
        <div className="top-bar__row" data-tauri-drag-region>
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
            <span className="top-bar__login-status">{loginStatus}</span>
          </div>
        </div>
      </header>
    );
  }

  // The workspace-canvas toolbar (mode toggle / doc name / save / add tile)
  // is portaled up into THIS bar in exactly ONE case: the detached
  // /workspaces/:id page, where there's plenty of room top-right (no
  // per-worktree pane-toggle icons compete for space there).
  const isWorkspaceViewToolbar = layoutMode === "workspace-view";
  const canvasChipWorktreeId = layoutMode === "workspace" ? activeWorktreeId : null;
  const inCanvasMode = paneLayoutMode === "workspace";

  if (variant === "sidebar-header") {
    return (
      <div
        className={`sidebar-header${leftSidebarCollapsed ? " sidebar-header--collapsed" : ""}`}
        data-tauri-drag-region
      >
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
        {!leftSidebarCollapsed && crumbParts.length > 0 ? (
          <div className="top-bar__crumb" title={crumbTitle}>
            {crumbNode}
          </div>
        ) : null}
      </div>
    );
  }

  if (variant === "floating") {
    return (
      <div className="top-bar-floating-actions" data-tauri-drag-region>
        <ConnectionStatus />
        {layoutMode === "workspace" || layoutMode === "project-workspace" ? (
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
            <div className="top-bar__overflow-wrapper">
              <button
                type="button"
                className="icon-btn"
                aria-label="More options"
                title="More options"
                aria-expanded={overflowOpen}
                aria-haspopup="true"
                onClick={() => setOverflowOpen((o) => !o)}
              >
                <MoreHorizontal size={18} />
              </button>
              {overflowOpen ? (
                <div className="top-bar__overflow-menu" role="menu" ref={overflowMenuRef}>
                  {canvasChipWorktreeId ? (
                    <>
                      <button
                        type="button"
                        className={`top-bar__overflow-item${inCanvasMode ? " top-bar__overflow-item--active" : ""}`}
                        role="menuitemcheckbox"
                        aria-checked={inCanvasMode}
                        onClick={() => {
                          setLayoutMode(canvasChipWorktreeId, inCanvasMode ? "classic" : "workspace");
                          setOverflowOpen(false);
                        }}
                      >
                        <LayoutGrid size={14} />
                        <span>{inCanvasMode ? "Canvas layout (on)" : "Canvas layout"}</span>
                      </button>
                      <button
                        type="button"
                        className="top-bar__overflow-item"
                        role="menuitem"
                        disabled={!inCanvasMode}
                        title={
                          !inCanvasMode
                            ? "Switch to canvas mode first"
                            : canvasToolbarVisible
                              ? "Hide canvas toolbar"
                              : "Show canvas toolbar"
                        }
                        onClick={() => {
                          toggleCanvasToolbar();
                          setOverflowOpen(false);
                        }}
                      >
                        {canvasToolbarVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        <span>{canvasToolbarVisible ? "Hide toolbar" : "Show toolbar"}</span>
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="top-bar__overflow-item"
                    role="menuitemcheckbox"
                    aria-checked={effectiveSplitOrientation === "vertical"}
                    disabled={paneLayoutMode === "workspace"}
                    onClick={() => {
                      toggleToolSplitOrientation(effectiveSplitOrientation);
                      setOverflowOpen(false);
                    }}
                  >
                    {effectiveSplitOrientation === "horizontal" ? <Columns2 size={14} /> : <Rows2 size={14} />}
                    <span>
                      {effectiveSplitOrientation === "horizontal"
                        ? "Split: horizontal"
                        : "Split: vertical"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`top-bar__overflow-item${terminalDockVisible ? " top-bar__overflow-item--active" : ""}`}
                    role="menuitemcheckbox"
                    aria-checked={terminalDockVisible}
                    disabled={paneLayoutMode === "workspace"}
                    onClick={() => {
                      toggleTerminalDock();
                      setOverflowOpen(false);
                    }}
                  >
                    <SquareTerminal size={14} />
                    <span>Terminal</span>
                    {paneLayoutMode !== "workspace" ? <span className="top-bar__overflow-kbd">{hints.terminal}</span> : null}
                  </button>
                </div>
              ) : null}
            </div>
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
                  : `Toggle tool panel (${hints.toolPane})`
              }
              onClick={paneLayoutMode === "workspace" ? toggleWorktreeToolsTile : toggleToolPanel}
            >
              {effectiveSplitOrientation === "vertical" ? <PanelTop size={17} /> : <PanelRight size={17} />}
            </button>
          </>
        ) : null}
        <KeyboardShortcutsDialog
          open={shortcutsOpen}
          onClose={() => onCloseShortcuts?.()}
        />
      </div>
    );
  }

  return (
    <header className={`top-bar${!isMobile ? " top-bar--desktop" : ""}`} data-tauri-drag-region>
      <div className="top-bar__row" data-tauri-drag-region>
      {isMobile && layoutMode === "settings" && onSettingsBack ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Back to Settings"
          onClick={onSettingsBack}
        >
          <ArrowLeft size={22} strokeWidth={2} />
        </button>
      ) : (
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
      )}
      {!isMobile ? (
        crumbParts.length > 0 ? (
          <div className="top-bar__crumb" title={crumbTitle}>
            {crumbNode}
          </div>
        ) : null
      ) : (
        <div className="top-bar__crumb top-bar__crumb--mobile-stack" title={mobileTitle}>
          {layoutMode === "dashboard" ? (
            <span className="top-bar__crumb-seg top-bar__mobile-line">Dashboard</span>
          ) : layoutMode === "settings" ? (
            <span
              className="top-bar__crumb-seg top-bar__mobile-line"
              style={{ display: "flex", alignItems: "center", gap: 4, flexDirection: "row" }}
            >
              {settingsSectionLabel ? (
                <>
                  <span style={{ color: "var(--fg-muted)" }}>Settings</span>
                  <span style={{ color: "var(--fg-faint)" }}>›</span>
                  <span style={{ color: "var(--fg-primary)", fontWeight: "var(--font-weight-medium)" }}>
                    {settingsSectionLabel}
                  </span>
                </>
              ) : (
                "Settings"
              )}
            </span>
          ) : layoutMode === "workspace-view" ? (
            <span className="top-bar__crumb-seg top-bar__crumb-seg--highlight top-bar__mobile-line">
              {viewedWorkspaceName ?? "Workspace"}
            </span>
          ) : (
            <span className="top-bar__crumb-seg top-bar__mobile-line">{project?.name ?? "—"}</span>
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
        {!isMobile && layoutMode === "dashboard" ? (
          <>
            <button
              type="button"
              className="icon-btn"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts"
              onClick={onOpenShortcuts}
            >
              <Keyboard size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Settings"
              title="Settings"
              onClick={() => navigate("/settings")}
            >
              <Settings size={18} />
            </button>
          </>
        ) : null}
        {layoutMode === "workspace" || layoutMode === "project-workspace" ? (
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
            <div className="top-bar__overflow-wrapper">
              <button
                type="button"
                className="icon-btn"
                aria-label="More options"
                title="More options"
                aria-expanded={overflowOpen}
                aria-haspopup="true"
                onClick={() => setOverflowOpen((o) => !o)}
              >
                <MoreHorizontal size={18} />
              </button>
              {overflowOpen ? (
                <div className="top-bar__overflow-menu" role="menu" ref={overflowMenuRef}>
                  {canvasChipWorktreeId ? (
                    <>
                      <button
                        type="button"
                        className={`top-bar__overflow-item${inCanvasMode ? " top-bar__overflow-item--active" : ""}`}
                        role="menuitemcheckbox"
                        aria-checked={inCanvasMode}
                        onClick={() => {
                          setLayoutMode(canvasChipWorktreeId, inCanvasMode ? "classic" : "workspace");
                          setOverflowOpen(false);
                        }}
                      >
                        <LayoutGrid size={14} />
                        <span>{inCanvasMode ? "Canvas layout (on)" : "Canvas layout"}</span>
                      </button>
                      <button
                        type="button"
                        className="top-bar__overflow-item"
                        role="menuitem"
                        disabled={!inCanvasMode}
                        title={
                          !inCanvasMode
                            ? "Switch to canvas mode first"
                            : canvasToolbarVisible
                              ? "Hide canvas toolbar"
                              : "Show canvas toolbar"
                        }
                        onClick={() => {
                          toggleCanvasToolbar();
                          setOverflowOpen(false);
                        }}
                      >
                        {canvasToolbarVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        <span>{canvasToolbarVisible ? "Hide toolbar" : "Show toolbar"}</span>
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="top-bar__overflow-item"
                    role="menuitemcheckbox"
                    aria-checked={effectiveSplitOrientation === "vertical"}
                    disabled={paneLayoutMode === "workspace"}
                    onClick={() => {
                      toggleToolSplitOrientation(effectiveSplitOrientation);
                      setOverflowOpen(false);
                    }}
                  >
                    {effectiveSplitOrientation === "horizontal" ? <Columns2 size={14} /> : <Rows2 size={14} />}
                    <span>
                      {effectiveSplitOrientation === "horizontal"
                        ? "Split: horizontal"
                        : "Split: vertical"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`top-bar__overflow-item${terminalDockVisible ? " top-bar__overflow-item--active" : ""}`}
                    role="menuitemcheckbox"
                    aria-checked={terminalDockVisible}
                    disabled={paneLayoutMode === "workspace"}
                    onClick={() => {
                      toggleTerminalDock();
                      setOverflowOpen(false);
                    }}
                  >
                    <SquareTerminal size={14} />
                    <span>Terminal</span>
                    {paneLayoutMode !== "workspace" ? <span className="top-bar__overflow-kbd">{hints.terminal}</span> : null}
                  </button>
                </div>
              ) : null}
            </div>
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
                  : `Toggle tool panel (${hints.toolPane})`
              }
              onClick={paneLayoutMode === "workspace" ? toggleWorktreeToolsTile : toggleToolPanel}
            >
              {effectiveSplitOrientation === "vertical" ? <PanelTop size={17} /> : <PanelRight size={17} />}
            </button>
          </>
        ) : null}
      </div>
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onClose={() => onCloseShortcuts?.()}
      />
      </div>
    </header>
  );
}
