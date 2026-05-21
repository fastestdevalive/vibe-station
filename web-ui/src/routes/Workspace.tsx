import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api";
import { Layout } from "@/components/layout/Layout";
import { TopBar } from "@/components/layout/TopBar";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { TabsStrip } from "@/components/layout/TabsStrip";
import { TerminalPane } from "@/components/layout/TerminalPane";
import { FilePreviewPane } from "@/components/layout/FilePreviewPane";
import { FileTreeSidebar } from "@/components/layout/FileTreeSidebar";
import { DashboardPanel } from "@/components/layout/DashboardPanel";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useWorkspaceUrlSync } from "@/hooks/useWorkspaceUrlSync";
import { useWorkspaceKeyboardShortcuts } from "@/hooks/useWorkspaceKeyboardShortcuts";
import { QuickOpen } from "@/components/dialogs/QuickOpen";

export function Workspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const isDashboard = location.pathname === "/";
  const isSettings = location.pathname === "/settings";
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
  const mobileSidebarOpen = useWorkspaceStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useWorkspaceStore((s) => s.setMobileSidebarOpen);

  const [quickOpen, setQuickOpen] = useState(false);

  const isMobile = useMediaQuery("(max-width: 768px)");

  useWorkspaceUrlSync(bundleLoaded, worktrees, sessions);
  useWorkspaceKeyboardShortcuts(setQuickOpen, !isFullWidthPane);

  // Update browser tab title to reflect current context
  useEffect(() => {
    if (isSettings) {
      document.title = "Settings — Vibe Station";
    } else if (isDashboard || !activeWorktreeId) {
      document.title = "Vibe Station";
    } else {
      const wt = worktrees.find((w) => w.id === activeWorktreeId);
      document.title = wt ? `${wt.branch} — Vibe Station` : "Vibe Station";
    }
  }, [activeWorktreeId, worktrees, isDashboard, isSettings]);

  // Open the WS eagerly so the ConnectionStatus pill reflects daemon health
  // even before the first session subscription. The api client owns reconnects.
  useEffect(() => {
    api.startConnection();
  }, []);

  // Drop persisted selections that no longer exist on the daemon (e.g. the
  // worktree was deleted between sessions). Runs once the server bundle has
  // landed so it has fresh data to validate against; without this the
  // FilePreviewPane fires a doomed getFile() with a stale path on remount.
  useEffect(() => {
    if (!bundleLoaded) return;
    const s = useWorkspaceStore.getState();
    const wtStillExists = s.activeWorktreeId && worktrees.some((w) => w.id === s.activeWorktreeId);
    const sessStillExists =
      s.activeSessionId && sessions.some((ss) => ss.id === s.activeSessionId);
    if (!wtStillExists) {
      useWorkspaceStore.setState({
        activeProjectId: null,
        activeWorktreeId: null,
        activeSessionId: null,
        activeFilePath: null,
      });
    } else if (!sessStillExists) {
      useWorkspaceStore.setState({ activeSessionId: null });
    }
  }, [bundleLoaded, worktrees, sessions]);

  useEffect(() => {
    if (!isMobile && mobileSidebarOpen) {
      setMobileSidebarOpen(false);
    }
  }, [isMobile, mobileSidebarOpen, setMobileSidebarOpen]);

  const leftColumnPx = isMobile ? 280 : leftSidebarCollapsed ? 52 : 220;

  const activeSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : undefined;

  const terminalColumn = (
    <div className="pane-stack">
      <TabsStrip api={api} worktreeId={activeWorktreeId} />
      <TerminalPane api={api} activeSession={activeSession} />
    </div>
  );

  return (
    <div className="workspace-route">
      {!isFullWidthPane ? (
        <QuickOpen api={api} worktreeId={activeWorktreeId} open={quickOpen} onClose={() => setQuickOpen(false)} />
      ) : null}
      <Layout
        topBar={
          <TopBar
            layoutMode={isSettings ? "settings" : isDashboard ? "dashboard" : "workspace"}
            projects={projects}
            worktrees={worktrees}
            sessions={sessions}
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
              if (isDashboard || isSettings) navigate(`/worktree/${wtId}`);
            }}
          />
        }
        dashboardPane={
          isDashboard ? (
            <DashboardPanel api={api} />
          ) : isSettings ? <SettingsPanel api={api} /> : undefined
        }
        leftColumnPx={leftColumnPx}
        isMobile={isMobile}
        mobileSidebarOpen={mobileSidebarOpen}
        onMobileSidebarClose={() => setMobileSidebarOpen(false)}
        {...(isFullWidthPane
          ? {}
          : {
              terminalPane: terminalColumn,
              previewPane: (
                <FilePreviewPane api={api} sessionId={activeSessionId} worktreeId={activeWorktreeId} />
              ),
              fileTree: <FileTreeSidebar api={api} />,
            })}
      />
    </div>
  );
}
