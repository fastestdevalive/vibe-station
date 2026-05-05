import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api";
import type { Project, Session, Worktree } from "@/api/types";
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

  const [bundle, setBundle] = useState<{
    projects: Project[];
    worktrees: Worktree[];
    sessions: Session[];
  }>({ projects: [], worktrees: [], sessions: [] });
  const [bundleLoaded, setBundleLoaded] = useState(false);

  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const leftSidebarCollapsed = useWorkspaceStore((s) => s.leftSidebarCollapsed);
  const toggleLeftSidebarCollapsed = useWorkspaceStore((s) => s.toggleLeftSidebarCollapsed);
  const mobileSidebarOpen = useWorkspaceStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useWorkspaceStore((s) => s.setMobileSidebarOpen);

  const [quickOpen, setQuickOpen] = useState(false);

  const isMobile = useMediaQuery("(max-width: 768px)");

  useWorkspaceUrlSync(bundleLoaded, bundle.worktrees, bundle.sessions);
  useWorkspaceKeyboardShortcuts(setQuickOpen, !isFullWidthPane);

  // Open the WS eagerly so the ConnectionStatus pill reflects daemon health
  // even before the first session subscription. The api client owns reconnects.
  useEffect(() => {
    api.startConnection();
  }, []);

  useEffect(() => {
    void (async () => {
      const projects = await api.listProjects();
      const worktrees = (
        await Promise.all(projects.map((p) => api.listWorktrees(p.id)))
      ).flat();
      const sessions = (
        await Promise.all(worktrees.map((w) => api.listSessions(w.id)))
      ).flat();
      setBundle({ projects, worktrees, sessions });
      setBundleLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!isMobile && mobileSidebarOpen) {
      setMobileSidebarOpen(false);
    }
  }, [isMobile, mobileSidebarOpen, setMobileSidebarOpen]);

  const leftColumnPx = isMobile ? 280 : leftSidebarCollapsed ? 52 : 220;

  const activeSession = activeSessionId
    ? bundle.sessions.find((s) => s.id === activeSessionId)
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
            layoutMode={isFullWidthPane ? "dashboard" : "workspace"}
            projects={bundle.projects}
            worktrees={bundle.worktrees}
            sessions={bundle.sessions}
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
            onWorktreeSelected={(wtId) => {
              if (isMobile) setMobileSidebarOpen(false);
              if (isDashboard || isSettings) navigate(`/worktree/${wtId}`);
            }}
          />
        }
        dashboardPane={
          isDashboard ? <DashboardPanel api={api} /> : isSettings ? <SettingsPanel api={api} /> : undefined
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
