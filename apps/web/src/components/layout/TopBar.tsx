import { useNavigate } from "react-router-dom";
import {
  Columns2,
  PanelLeft,
  PanelRight,
  Search,
  SquareTerminal,
} from "lucide-react";
import { useLayout } from "@/hooks/useLayout";
import { useWorkspaceStore } from "@/hooks/useStore";
import type { Project, Session, Worktree } from "@/api/types";
import { ConnectionStatus } from "@/components/layout/ConnectionStatus";

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
  /** Dashboard keeps projects sidebar; omits quick open, terminal layout, and pane toggles. */
  layoutMode?: "workspace" | "dashboard";
  projects: Project[];
  worktrees: Worktree[];
  sessions: Session[];
  isMobile: boolean;
  onToggleLeftSidebar: () => void;
  leftSidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  onOpenQuickOpen: () => void;
}

export function TopBar({
  layoutMode = "workspace",
  projects,
  worktrees,
  sessions,
  isMobile,
  onToggleLeftSidebar,
  leftSidebarCollapsed,
  mobileSidebarOpen,
  onOpenQuickOpen,
}: TopBarProps) {
  const navigate = useNavigate();
  const {
    activeProjectId,
    activeWorktreeId,
    activeSessionId,
    toggleTerminalPosition,
    paneCollapsed,
    togglePaneCollapsed,
  } = useLayout();
  const clearWorkspaceSelection = useWorkspaceStore((s) => s.clearWorkspaceSelection);

  const project = projects.find((p) => p.id === activeProjectId);
  const wt = worktrees.find((w) => w.id === activeWorktreeId);
  const session = sessions.find((s) => s.id === activeSessionId);

  const hints = shortcutHints();

  function goHome() {
    clearWorkspaceSelection();
    navigate("/", { replace: true });
  }

  const treeOn = !paneCollapsed[0];
  const previewOn = !paneCollapsed[1];
  const terminalOn = !paneCollapsed[2];

  const sidebarExpanded = isMobile ? mobileSidebarOpen : !leftSidebarCollapsed;

  const crumbParts: { label: string; highlight?: boolean }[] = [];
  if (layoutMode === "dashboard") {
    crumbParts.push({ label: "Dashboard" });
  } else {
    if (project) crumbParts.push({ label: project.name });
    if (wt) crumbParts.push({ label: wt.branch, highlight: true });
    if (session) crumbParts.push({ label: session.label });
  }

  const crumbTitle = crumbParts.map((p) => p.label).join(" › ") || undefined;

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
      <button type="button" className="top-bar__brand" aria-label="Home" onClick={goHome}>
        viberun
      </button>
      <div className="top-bar__crumb" title={crumbTitle}>
        {crumbNode}
      </div>
      <div className="top-bar__end">
        <ConnectionStatus />
        <div className="top-bar__actions">
          {layoutMode === "workspace" ? (
            <button
              type="button"
              className="icon-btn"
              aria-label="Toggle terminal pane layout"
              onClick={toggleTerminalPosition}
              title="Terminal layout"
            >
              <Columns2 size={18} />
            </button>
          ) : null}
        </div>
        {layoutMode === "workspace" ? (
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
              <button
                type="button"
                className={`top-bar__pane-btn ${terminalOn ? "top-bar__pane-btn--on" : ""}`}
                aria-pressed={terminalOn}
                aria-label="Toggle terminal"
                title={`Toggle terminal (${hints.terminal})`}
                onClick={() => togglePaneCollapsed(2)}
              >
                <SquareTerminal size={17} />
              </button>
<button
                type="button"
                className={`top-bar__pane-btn ${treeOn ? "top-bar__pane-btn--on" : ""}`}
                aria-pressed={treeOn}
                aria-label="Toggle file tree"
                title={`Toggle file tree (${hints.fileTree})`}
                onClick={() => togglePaneCollapsed(0)}
              >
                <PanelRight size={17} />
              </button>
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}
