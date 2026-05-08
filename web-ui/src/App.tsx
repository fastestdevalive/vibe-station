import { Navigate, Route, Routes } from "react-router-dom";
import { Workspace } from "./routes/Workspace";
import { LoginScreen } from "./components/auth/LoginScreen";
import { TopBar } from "./components/layout/TopBar";
import { useAuth } from "./hooks/useAuth";

function AppShell() {
  const { authed, loading, onLoginSuccess } = useAuth();

  if (loading) {
    // Minimal loading state — TopBar with login mode, blank content area
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
        <TopBar
          layoutMode="login"
          projects={[]}
          worktrees={[]}
          sessions={[]}
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
          sessions={[]}
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
    <Routes>
      <Route path="/" element={<Workspace />} />
      <Route path="/settings" element={<Workspace />} />
      <Route path="/worktree" element={<Workspace />} />
      <Route path="/worktree/:wtId" element={<Workspace />} />
      <Route path="/worktree/:wtId/:sessionId" element={<Workspace />} />
      <Route path="/workspace" element={<Navigate to="/worktree" replace />} />
      <Route path="/dashboard" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return <AppShell />;
}
