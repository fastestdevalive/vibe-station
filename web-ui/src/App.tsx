import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { Workspace } from "./routes/Workspace";
import { LoginScreen } from "./components/auth/LoginScreen";
import { TopBar } from "./components/layout/TopBar";
import { useAuth } from "./hooks/useAuth";
import { DevStatePanel } from "./components/dev/DevStatePanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { api } from "./api";

function AppShell() {
  const { authed, loading, onLoginSuccess } = useAuth();
  const navigate = useNavigate();

  // Handle `navigate` WS events emitted by POST /open (vst open <path>).
  useEffect(() => {
    return api.on("navigate", (ev) => {
      if (ev.type === "navigate") {
        // TODO: add a /project/:id route and page so this can navigate directly
        // to the project instead of the dashboard home. ev.projectId is available.
        navigate(`/`);
      }
    });
  }, [navigate]);

  if (loading) {
    // Minimal loading state — TopBar with login mode, blank content area
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
        <TopBar
          layoutMode="login"
          projects={[]}
          worktrees={[]}
          isMobile={false}
          onToggleLeftSidebar={() => {}}
          leftSidebarCollapsed={false}
          mobileSidebarOpen={false}
          onOpenQuickOpen={() => {}}
        />
      </div>
    );
  }

  if (!authed) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
        <TopBar
          layoutMode="login"
          projects={[]}
          worktrees={[]}
          isMobile={false}
          onToggleLeftSidebar={() => {}}
          leftSidebarCollapsed={false}
          mobileSidebarOpen={false}
          onOpenQuickOpen={() => {}}
        />
        <LoginScreen onSuccess={onLoginSuccess} />
      </div>
    );
  }

  return (
    <>
      {/* Boundary wraps just the routed content, not DevStatePanel — so the
          dev state-simulator popup stays usable for debugging even if the
          workspace tree itself crashes (see ErrorBoundary.tsx). */}
      <ErrorBoundary label="Workspace">
        <Routes>
          <Route path="/" element={<Workspace />} />
          <Route path="/settings" element={<Workspace />} />
          <Route path="/settings/:sectionId" element={<Workspace />} />
          <Route path="/worktree" element={<Workspace />} />
          <Route path="/worktree/:wtId" element={<Workspace />} />
          <Route path="/worktree/:wtId/:sessionId" element={<Workspace />} />
          <Route path="/session/:directSessionId" element={<Workspace />} />
          {/* Detached-workspace view (agent-interaction-workspaces/04-workspaces
              Phase 3a, Decision 4) — a saved WorkspaceDoc's own route,
              independent of any worktree. "/workspace" (singular, no param,
              just above) is a pre-existing stale redirect and unrelated. */}
          <Route path="/workspaces/:workspaceId" element={<Workspace />} />
          <Route path="/workspace" element={<Navigate to="/worktree" replace />} />
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
      <DevStatePanel />
    </>
  );
}

export function App() {
  return <AppShell />;
}
