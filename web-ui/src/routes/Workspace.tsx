import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "@/api";
import { Layout } from "@/components/layout/Layout";
import { TopBar } from "@/components/layout/TopBar";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { TabsStrip } from "@/components/layout/TabsStrip";
import { TerminalPane } from "@/components/layout/TerminalPane";
import { AgentPaneSlot } from "@/components/layout/AgentPaneSlot";
import { PaneTools } from "@/components/layout/PaneTools";
import { ToolPanel } from "@/components/layout/ToolPanel";
import { DashboardPanel } from "@/components/layout/DashboardPanel";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useWorkspaceUrlSync } from "@/hooks/useWorkspaceUrlSync";
import { useWorkspaceKeyboardShortcuts } from "@/hooks/useWorkspaceKeyboardShortcuts";
import { sessionLabel } from "@/lib/sessionLabel";
import { QuickOpen } from "@/components/dialogs/QuickOpen";

export function Workspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{ directSessionId?: string }>();
  const isDashboard = location.pathname === "/";
  const isSettings = location.pathname === "/settings";
  const isDirectSession = location.pathname.startsWith("/session/");
  const isFullWidthPane = isDashboard || isSettings;

  // Server data lives in `useServerStore`, populated and refreshed by
  // `useServerSync` (initial fetch + ws:open + WS patch reducers). Reading
  // the snapshot here keeps the existing prop API for TopBar etc. intact
  // and gives us the `bundleLoaded` boundary used by URL sync.
  useServerSync(api);
  const projects = useServerStore((s) => s.projects);
  const worktrees = useServerStore((s) => s.worktrees);
  const sessions = useServerStore((s) => s.sessions);
  const bundleLoaded = useServerStore((s) => s.loaded);

  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const leftSidebarCollapsed = useWorkspaceStore((s) => s.leftSidebarCollapsed);
  const toggleLeftSidebarCollapsed = useWorkspaceStore((s) => s.toggleLeftSidebarCollapsed);
  const leftSidebarWidthPx = useWorkspaceStore((s) => s.leftSidebarWidthPx);
  const setLeftSidebarWidthPx = useWorkspaceStore((s) => s.setLeftSidebarWidthPx);
  const mobileSidebarOpen = useWorkspaceStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useWorkspaceStore((s) => s.setMobileSidebarOpen);

  const [quickOpen, setQuickOpen] = useState(false);

  const isMobile = useMediaQuery("(max-width: 768px)");

  // Derive direct session context from URL
  const directSession = useMemo(() => {
    if (!isDirectSession || !params.directSessionId) return null;
    return sessions.find((s) => s.id === params.directSessionId) ?? null;
  }, [isDirectSession, params.directSessionId, sessions]);

  const directSessionProject = useMemo(() => {
    if (!directSession) return null;
    return projects.find((p) => p.id === directSession.projectId) ?? null;
  }, [directSession, projects]);

  useWorkspaceUrlSync(bundleLoaded, worktrees, sessions);
  // Quick Open + pane shortcuts work in both worktree and direct-session modes
  // (direct sessions browse the project base dir); only full-width panes opt out.
  useWorkspaceKeyboardShortcuts(setQuickOpen, !isFullWidthPane);

  // Clear worktree context when entering direct session mode (mutual exclusion)
  useEffect(() => {
    if (!isDirectSession || !bundleLoaded) return;
    const s = useWorkspaceStore.getState();
    if (s.activeWorktreeId || s.activeSessionId) {
      useWorkspaceStore.setState({
        activeWorktreeId: null,
        activeSessionId: null,
        activeFilePath: null,
      });
    }
  }, [isDirectSession, bundleLoaded]);

  // Bind the direct-session layout context (project id) so the tool panel /
  // terminal dock toggles persist per project, and the Files tree + terminals
  // resolve to the project base dir. Cleared when leaving direct-session mode.
  useEffect(() => {
    const pid = isDirectSession ? (directSessionProject?.id ?? null) : null;
    if (useWorkspaceStore.getState().activeDirectContextId !== pid) {
      useWorkspaceStore.getState().setActiveDirectContext(pid);
    }
  }, [isDirectSession, directSessionProject]);

  // Redirect to dashboard if direct session not found
  useEffect(() => {
    if (!isDirectSession || !bundleLoaded) return;
    if (params.directSessionId && !directSession) {
      navigate("/", { replace: true });
    }
  }, [isDirectSession, bundleLoaded, params.directSessionId, directSession, navigate]);

  // Update browser tab title to reflect current context
  useEffect(() => {
    if (isSettings) {
      document.title = "Settings — Vibe Station";
    } else if (isDirectSession && directSession) {
      const projectName = directSessionProject?.name ?? "Direct";
      document.title = `${sessionLabel(directSession)} — ${projectName} — Vibe Station`;
    } else if (isDashboard || !activeWorktreeId) {
      document.title = "Vibe Station";
    } else {
      const wt = worktrees.find((w) => w.id === activeWorktreeId);
      document.title = wt ? `${wt.branch} — Vibe Station` : "Vibe Station";
    }
  }, [activeWorktreeId, worktrees, isDashboard, isSettings, isDirectSession, directSession, directSessionProject]);

  // Open the WS eagerly so the ConnectionStatus pill reflects daemon health
  // even before the first session subscription. The api client owns reconnects.
  useEffect(() => {
    api.startConnection();
  }, []);

  // Drop persisted selections that no longer exist on the daemon (e.g. the
  // worktree was deleted between sessions). Runs once the server bundle has
  // landed so it has fresh data to validate against; without this the
  // FilePreviewPane fires a doomed getFile() with a stale path on remount.
  //
  // Direct sessions are exempt: they have NO worktree by design (the mutual
  // exclusion effect above nulls activeWorktreeId), so every check below reads
  // "no worktree" as "worktree deleted" and wipes activeFilePath — clearing the
  // user's open file. This effect re-runs whenever the `sessions` array identity
  // changes, and applySessionUpdated rebuilds that array on EVERY session:state
  // for ANY session, so an unrelated agent going idle elsewhere was enough to
  // clear the file seconds after opening it. Direct-session staleness is already
  // owned by the redirect effect above ("Redirect to dashboard if direct session
  // not found"), so there is nothing for this effect to validate here.
  useEffect(() => {
    if (!bundleLoaded || isDirectSession) return;
    const s = useWorkspaceStore.getState();
    const activeWt = s.activeWorktreeId
      ? worktrees.find((w) => w.id === s.activeWorktreeId)
      : undefined;
    const wtStillExists = !!activeWt;
    // The active worktree's project may have been hidden (this tab, another tab,
    // or via a deep-link to a hidden project's worktree — url-sync sets it active
    // from the unfiltered list and has no hidden check, so the gate lives here).
    const activeProjectHidden =
      !!activeWt && projects.some((p) => p.id === activeWt.projectId && p.hidden);
    const sessStillExists =
      s.activeSessionId && sessions.some((ss) => ss.id === s.activeSessionId);
    if (!wtStillExists || activeProjectHidden) {
      useWorkspaceStore.setState({
        activeProjectId: null,
        activeWorktreeId: null,
        activeSessionId: null,
        activeFilePath: null,
      });
      // A hidden-project worktree is no longer browseable — leave the now-empty
      // /worktree/:id route for the dashboard.
      if (activeProjectHidden && location.pathname.startsWith("/worktree")) {
        navigate("/", { replace: true });
      }
    } else if (!sessStillExists) {
      useWorkspaceStore.setState({ activeSessionId: null });
    }
  }, [bundleLoaded, isDirectSession, worktrees, sessions, projects, location.pathname, navigate]);

  useEffect(() => {
    if (!isMobile && mobileSidebarOpen) {
      setMobileSidebarOpen(false);
    }
  }, [isMobile, mobileSidebarOpen, setMobileSidebarOpen]);

  const leftColumnPx = isMobile ? 280 : leftSidebarCollapsed ? 52 : leftSidebarWidthPx;

  const activeTerminalSessionId = useWorkspaceStore((s) => s.activeTerminalSessionId);
  const activeSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : undefined;
  const activeTerminalSession = activeTerminalSessionId
    ? sessions.find((s) => s.id === activeTerminalSessionId)
    : undefined;

  const agentPane = (
    <div className="pane-stack">
      <TabsStrip api={api} worktreeId={activeWorktreeId} kind="agent" />
      {/* TerminalPane stays permanently mounted; ChatPane is toggled beside it
          by CSS visibility for JSON-channel agents (Decision 14). */}
      <AgentPaneSlot api={api} sessionId={activeSessionId} session={activeSession} />
    </div>
  );

  const terminalDock = (
    <div className="pane-stack">
      <TabsStrip api={api} worktreeId={activeWorktreeId} kind="terminal" />
      <TerminalPane api={api} sessionId={activeTerminalSessionId} session={activeTerminalSession} />
    </div>
  );

  // Direct session: identical to the worktree layout, minus the agent TabsStrip
  // (a direct session is a single agent — no agent tabs). The tool panel and
  // terminal dock are wired to the PROJECT base dir via scope="project".
  const directAgentPane = directSession ? (
    <div className="pane-stack">
      {/* No agent TabsStrip — single agent, no tabs. Still needs the zoom/
          fullscreen controls that TabsStrip normally bundles alongside the
          tab list, so mount PaneTools directly instead of losing them.
          TerminalPane stays mounted; ChatPane toggles beside it for a JSON
          direct agent (Decision 14). */}
      <div className="tabs-strip tabs-strip--tools-only" role="toolbar" aria-label="Terminal controls">
        <PaneTools fsTarget="agent" />
      </div>
      <AgentPaneSlot api={api} sessionId={directSession.id} session={directSession} />
    </div>
  ) : null;

  const directToolPanel = directSessionProject ? (
    <ToolPanel api={api} worktreeId={directSessionProject.id} scope="project" />
  ) : null;

  const directTerminalDock = directSessionProject ? (
    <div className="pane-stack">
      <TabsStrip api={api} worktreeId={directSessionProject.id} kind="terminal" scope="project" />
      <TerminalPane api={api} sessionId={activeTerminalSessionId} session={activeTerminalSession} />
    </div>
  ) : null;

  // Compute layout mode for TopBar
  const layoutMode = isSettings
    ? "settings"
    : isDashboard
      ? "dashboard"
      : isDirectSession
        ? "direct-session"
        : "workspace";

  return (
    <div className="workspace-route">
      {!isFullWidthPane ? (
        isDirectSession ? (
          <QuickOpen
            api={api}
            worktreeId={directSessionProject?.id ?? null}
            scope="project"
            open={quickOpen}
            onClose={() => setQuickOpen(false)}
          />
        ) : (
          <QuickOpen api={api} worktreeId={activeWorktreeId} open={quickOpen} onClose={() => setQuickOpen(false)} />
        )
      ) : null}
      <Layout
        topBar={
          <TopBar
            layoutMode={layoutMode}
            projects={projects}
            worktrees={worktrees}
            sessions={sessions}
            directSession={directSession ?? undefined}
            directSessionProject={directSessionProject ?? undefined}
            isMobile={isMobile}
            onToggleLeftSidebar={() => {
              if (isMobile) setMobileSidebarOpen(!mobileSidebarOpen);
              else toggleLeftSidebarCollapsed();
            }}
            leftSidebarCollapsed={leftSidebarCollapsed}
            mobileSidebarOpen={mobileSidebarOpen}
            onOpenQuickOpen={() => setQuickOpen(true)}
            leftColumnPx={leftColumnPx}
          />
        }
        leftSidebar={
          <LeftSidebar
            api={api}
            collapsed={!isMobile && leftSidebarCollapsed}
            isMobile={isMobile}
            onWorktreeSelected={(wtId) => {
              if (isMobile) setMobileSidebarOpen(false);
              if (isDashboard || isSettings || isDirectSession) navigate(`/worktree/${wtId}`);
            }}
          />
        }
        dashboardPane={
          isDashboard ? (
            <DashboardPanel api={api} />
          ) : isSettings ? <SettingsPanel api={api} /> : undefined
        }
        leftColumnPx={leftColumnPx}
        leftSidebarCollapsed={leftSidebarCollapsed}
        onLeftSidebarResize={setLeftSidebarWidthPx}
        isMobile={isMobile}
        mobileSidebarOpen={mobileSidebarOpen}
        onMobileSidebarClose={() => setMobileSidebarOpen(false)}
        {...(isFullWidthPane
          ? {}
          : isDirectSession
            ? {
                // Direct session: full worktree layout minus the agent tabs.
                // Tool panel (Files) + terminal dock resolve to the project
                // base dir (scope="project").
                agentPane: directAgentPane,
                toolPanel: directToolPanel,
                terminalDock: directTerminalDock,
              }
            : {
                agentPane,
                toolPanel: (
                  <ToolPanel
                    api={api}
                    worktreeId={activeWorktreeId}
                    baseBranch={worktrees.find((w) => w.id === activeWorktreeId)?.baseBranch}
                  />
                ),
                terminalDock,
              })}
      />
    </div>
  );
}
