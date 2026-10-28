import { ArrowLeft, Keyboard, PanelLeft, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useLayout } from "@/hooks/useLayout";
import type { Project, Worktree } from "@/api/types";
import { ConnectionStatus } from "@/components/layout/ConnectionStatus";
import { WorkspaceActions } from "@/components/layout/WorkspaceActions";
import { Logo } from "@/components/shared/Logo";
import { ToolbarOutlet, WORKSPACE_CANVAS_TOOLBAR_KEY } from "@/components/layout/paneOutlets";

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
  /** Title shown for `layoutMode="dashboard"` (default "Dashboard"); drafts pass "New agent". */
  dashboardTitle?: string;
  /** Mobile settings drill-in: back to section list */
  onSettingsBack?: () => void;
  /** Opens the keyboard-shortcuts reference dialog (rendered once by the parent). */
  onOpenShortcuts?: () => void;
  /**
   * Presentation variant:
   * - "bar" (default): full-width top bar across the entire shell
   * - "sidebar-header": sidebar toggle + breadcrumb folded into LeftSidebar's header
   * - "floating": the top-right actions chip (classic desktop), rendered once by Layout's `TopActionsOwner`
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
  dashboardTitle = "Dashboard",
  onSettingsBack,
  onOpenShortcuts,
  variant = "bar",
}: TopBarProps) {
  const navigate = useNavigate();
  const { activeProjectId, activeWorktreeId } = useLayout();
  const project = projects.find((p) => p.id === activeProjectId);

  const sidebarExpanded = isMobile ? mobileSidebarOpen : !leftSidebarCollapsed;

  const crumbParts: { label: string; highlight?: boolean }[] = [];
  if (layoutMode === "dashboard") {
    crumbParts.push({ label: dashboardTitle });
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
      ? dashboardTitle
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
      <header className="top-bar" data-tauri-drag-region="deep">
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

  if (variant === "sidebar-header") {
    return (
      <div
        className={`sidebar-header${leftSidebarCollapsed ? " sidebar-header--collapsed" : ""}`}
        data-tauri-drag-region="deep"
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
      <div className="top-bar-floating-actions" data-tauri-drag-region="deep">
        <ConnectionStatus />
        {layoutMode === "workspace" || layoutMode === "project-workspace" ? (
          <WorkspaceActions
            isMobile={isMobile}
            onOpenQuickOpen={onOpenQuickOpen}
            canvasWorktreeId={canvasChipWorktreeId}
          />
        ) : null}
      </div>
    );
  }

  return (
    <header className={`top-bar${!isMobile ? " top-bar--desktop" : ""}`} data-tauri-drag-region="deep">
      <div className="top-bar__row">
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
            <span className="top-bar__crumb-seg top-bar__mobile-line">{dashboardTitle}</span>
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
          <WorkspaceActions
            isMobile={isMobile}
            onOpenQuickOpen={onOpenQuickOpen}
            canvasWorktreeId={canvasChipWorktreeId}
          />
        ) : null}
      </div>
      </div>
    </header>
  );
}
