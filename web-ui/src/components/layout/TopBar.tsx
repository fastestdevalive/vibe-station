import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Columns2,
  LayoutGrid,
  PanelBottom,
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
   *  direct-session = terminal-only view for direct sessions (no worktree). */
  layoutMode?: "workspace" | "dashboard" | "settings" | "login" | "direct-session";
  projects: Project[];
  worktrees: Worktree[];
  sessions: Session[];
  /** Direct session for breadcrumb (when layoutMode === "direct-session") */
  directSession?: Session;
  /** Project for direct session breadcrumb */
  directSessionProject?: Project;
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
  sessions,
  directSession,
  directSessionProject,
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
    activeSessionId,
    toolPanelVisible,
    toggleToolPanel,
    terminalDockVisible,
    toggleTerminalDock,
    toolSplitOrientation,
    toggleToolSplitOrientation,
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
  const session = sessions.find((s) => s.id === activeSessionId);

  const hints = shortcutHints();

  const sidebarExpanded = isMobile ? mobileSidebarOpen : !leftSidebarCollapsed;

  // Measure the brand button so we can align the crumb to the sidebar's right edge.
  const brandRef = useRef<HTMLAnchorElement>(null);
  const [brandWidth, setBrandWidth] = useState(0);
  useEffect(() => {
    if (brandRef.current) setBrandWidth(brandRef.current.offsetWidth);
  }, []);

  // padding-left(12) + toggle(36) + gap(8) + brand + gap(8) = offset already consumed before crumb.
  const crumbMarginLeft =
    !isMobile && !leftSidebarCollapsed && leftColumnPx != null && brandWidth > 0
      ? Math.max(8, leftColumnPx - 12 - 36 - 8 - brandWidth - 8)
      : undefined;

  const crumbParts: { label: string; highlight?: boolean }[] = [];
  if (layoutMode === "dashboard") {
    crumbParts.push({ label: "Dashboard" });
  } else if (layoutMode === "settings") {
    crumbParts.push({ label: "Settings" });
  } else if (layoutMode === "direct-session") {
    if (directSessionProject) crumbParts.push({ label: directSessionProject.name });
    if (directSession) crumbParts.push({ label: sessionLabel(directSession), highlight: true });
  } else {
    if (project) crumbParts.push({ label: project.name });
    if (wt) crumbParts.push({ label: wt.branch, highlight: true });
    if (session) crumbParts.push({ label: sessionLabel(session) });
  }

  const crumbTitle = crumbParts.map((p) => p.label).join(" › ") || undefined;

  const mobileTitle =
    layoutMode === "dashboard"
      ? "Dashboard"
      : layoutMode === "settings"
        ? "Settings"
        : layoutMode === "direct-session"
          ? [directSessionProject?.name, directSession ? sessionLabel(directSession) : null].filter(Boolean).join(" · ") || "Direct Session"
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
      </header>
    );
  }

  return (
    <header className="top-bar">
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
              {layoutMode === "workspace" && activeWorktreeId ? (
                <button
                  type="button"
                  className={`top-bar__pane-btn ${paneLayoutMode === "workspace" ? "top-bar__pane-btn--on" : ""}`}
                  aria-pressed={paneLayoutMode === "workspace"}
                  aria-label="Toggle workspace canvas layout"
                  title={
                    paneLayoutMode === "workspace"
                      ? "Switch to classic layout"
                      : "Switch to workspace canvas (tiled/free-form panes)"
                  }
                  onClick={() =>
                    setLayoutMode(activeWorktreeId, paneLayoutMode === "workspace" ? "classic" : "workspace")
                  }
                >
                  <LayoutGrid size={17} />
                </button>
              ) : null}
              {paneLayoutMode !== "workspace" ? (
                <button
                  type="button"
                  className="top-bar__pane-btn"
                  aria-label="Toggle agent/tools split orientation"
                  title={
                    toolSplitOrientation === "horizontal"
                      ? "Stack agent and tools vertically"
                      : "Place agent and tools side by side"
                  }
                  onClick={toggleToolSplitOrientation}
                >
                  {toolSplitOrientation === "horizontal" ? <Columns2 size={17} /> : <Rows2 size={17} />}
                </button>
              ) : null}
              <button
                type="button"
                className={`top-bar__pane-btn ${terminalDockVisible ? "top-bar__pane-btn--on" : ""}`}
                aria-pressed={terminalDockVisible}
                aria-label="Toggle terminal dock"
                title={`Toggle terminal dock (${hints.terminal})`}
                onClick={toggleTerminalDock}
              >
                <SquareTerminal size={17} />
              </button>
              <button
                type="button"
                className={`top-bar__pane-btn ${toolPanelVisible ? "top-bar__pane-btn--on" : ""}`}
                aria-pressed={toolPanelVisible}
                aria-label="Toggle tool panel"
                title="Toggle tool panel"
                onClick={toggleToolPanel}
              >
                {/* Vertical split docks the tool panel to the top, so mirror
                    that with a top-panel icon instead of the right-panel one. */}
                {toolSplitOrientation === "vertical" ? <PanelTop size={17} /> : <PanelRight size={17} />}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}
