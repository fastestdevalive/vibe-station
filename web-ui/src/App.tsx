import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { Workspace } from "./routes/Workspace";
import { LoginScreen } from "./components/auth/LoginScreen";
import { TopBar } from "./components/layout/TopBar";
import { useAuth } from "./hooks/useAuth";
import { DevStatePanel } from "./components/dev/DevStatePanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { api } from "./api";
import { useOpenFilesChanged } from "./hooks/usePendingFileOpens";

/**
 * Pure decision for the `navigate` WS handler — extracted so the cold-start
 * branch is unit-testable without rendering the whole app.
 *
 * Returns what the window should do on a Navigate event:
 *  - `"navigate"`: same-window navigate to the project. Plain browser tabs
 *    (no Tauri) always do this; inside the Tauri shell it's the MAIN window
 *    receiving a `newWindow:false` event — which is the cold-start case (the
 *    main window's first WS connection lands inside the daemon's 3s replay
 *    window where newWindow is hardcoded false).
 *  - `"spawn"`: the main window got a fresh `newWindow:true` event → open a
 *    new OS window (loop-prevention guard 1).
 *  - `"none"`: a NON-"main" (secondary project-*) window — must neither
 *    navigate itself nor spawn (loop-prevention guard 2).
 */
export type NavigateAction = "spawn" | "navigate" | "none";

export function resolveNavigateAction(opts: {
  projectId: string;
  newWindow: boolean;
  isTauri: boolean;
  label: string | undefined;
}): NavigateAction {
  if (!opts.isTauri) return "navigate";
  if (opts.label === "main") return opts.newWindow ? "spawn" : "navigate";
  return "none";
}

function AppShell() {
  const { authed, loading, onLoginSuccess } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Always-mounted durable open-files sync (Phase 7, Fix E): the
  // `openFiles:changed` WS subscription must run unconditionally (not only
  // while the Files tool panel is mounted), or a CLI-driven open/close made
  // while a different tool panel is open would never reach the store.
  useOpenFilesChanged(api);

  // Start the WS connection immediately on app mount, before auth resolves.
  // Without this, the WS only starts inside Workspace (which only renders when
  // authed=true), creating a deadlock: auth retry needs ws:open, ws:open needs
  // Workspace, Workspace needs authed. Calling it here breaks the cycle.
  useEffect(() => {
    api.startConnection();
  }, []);

  // `?openProject=<id>` entry point (Decision 6): a newly-spawned window
  // (Phase 5) loads index.html?openProject=<id>; on mount this routes it to
  // that project's own view without coupling window creation to the router's
  // history API directly.
  useEffect(() => {
    const openProject = new URLSearchParams(location.search).get("openProject");
    if (openProject) {
      navigate(`/project/${openProject}`, { replace: true });
    }
  }, []);

  // Handle `navigate` WS events emitted by POST /open (vst open <path>).
  // Phase 1 (item 1.13): a plain browser tab (no __TAURI_INTERNALS__) lands on
  // the target project's own view instead of the dashboard home. Phase 5
  // (item 5.6) extends this for the Tauri shell per Decision 4: only the
  // "main" window acts on ev.newWindow (loop-prevention guard 1) by spawning a
  // new OS window; a secondary project-* window — including its own first WS
  // connection, which lands inside the daemon's 3s replay window where
  // newWindow is always false (item 1.7) — ignores the event entirely.
  //
  // Cold-start fix: the MAIN window's own very first WS connection also lands
  // inside that replay window (which hardcodes newWindow:false), so on a fresh
  // `vst <path>` launch nothing ever navigated this window and the user landed
  // on the dashboard instead of the project. When label==="main" and newWindow
  // is false we same-window navigate to the project. The only other time
  // newWindow:false reaches an already-alive main window is a rare within-3s
  // reconnect coincidence, and navigating it to the project it was just asked
  // to open is still reasonable — not a regression. Only a NON-"main" window
  // (secondary project-*) must do nothing, which is what stops its own
  // reconnect from spawning yet another window (loop-prevention guard 2).
  useEffect(() => {
    return api.on("navigate", (ev) => {
      if (ev.type !== "navigate") return;
      const tauri = (
        window as unknown as {
          __TAURI_INTERNALS__?: {
            invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!tauri) {
        navigate(`/project/${ev.projectId}`); // plain browser tab
        return;
      }
      const label = (window as unknown as Record<string, unknown>).__VST_WINDOW_LABEL__;
      const action = resolveNavigateAction({
        projectId: ev.projectId,
        newWindow: ev.newWindow,
        isTauri: !!tauri,
        label: label as string | undefined,
      });
      if (action === "navigate") {
        navigate(`/project/${ev.projectId}`);
      } else if (action === "spawn") {
        tauri!.invoke("open_project_window", { projectId: ev.projectId }).catch(() => {
          navigate(`/project/${ev.projectId}`); // spawn failed — fall back to same-window
        });
      }
      // "none" (non-"main" Tauri window): do nothing — it must not navigate
      // itself or spawn. This is loop-prevention guard 2: a secondary
      // project-* window's own first connection (inside the replay window)
      // ignores the event, so it never spawns yet another window.
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
          <Route path="/project/:projectId" element={<Workspace />} />
          <Route path="/project/:projectId/:sessionId" element={<Workspace />} />
          <Route path="/settings" element={<Workspace />} />
          <Route path="/settings/:sectionId" element={<Workspace />} />
          <Route path="/worktree" element={<Workspace />} />
          <Route path="/worktree/:wtId" element={<Workspace />} />
          <Route path="/worktree/:wtId/:sessionId" element={<Workspace />} />
          <Route path="/session/:directSessionId" element={<Workspace />} />
          <Route path="/draft/new" element={<Workspace />} />
          <Route path="/draft/:draftSessionId" element={<Workspace />} />
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
