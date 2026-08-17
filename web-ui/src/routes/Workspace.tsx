import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { PaneOutletProvider, PaneOutlet } from "@/components/layout/paneOutlets";
import { PaneHostLayer, type PaneKey } from "@/components/layout/PaneHostLayer";
import { WorkspaceCanvas } from "@/components/layout/WorkspaceCanvas";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useLayout } from "@/hooks/useLayout";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useWorkspaceUrlSync } from "@/hooks/useWorkspaceUrlSync";
import { useWorkspaceKeyboardShortcuts } from "@/hooks/useWorkspaceKeyboardShortcuts";
import { sessionLabel } from "@/lib/sessionLabel";
import { worktreePrStatus } from "@/lib/statusColor";
import { QuickOpen } from "@/components/dialogs/QuickOpen";
import { NewSessionDialog } from "@/components/dialogs/NewSessionDialog";
import { NewTabDialog } from "@/components/dialogs/NewTabDialog";

export function Workspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{ directSessionId?: string; workspaceId?: string }>();
  const isDashboard = location.pathname === "/";
  const isSettings = location.pathname === "/settings";
  const isDirectSession = location.pathname.startsWith("/session/");
  // Detached-workspace view (agent-interaction-workspaces/04-workspaces Phase 3,
  // Decision 4) — a saved WorkspaceDoc's own route, independent of any worktree.
  const isWorkspaceView = location.pathname.startsWith("/workspaces/");
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

  // Layout.tsx reads its own `layoutMode` (aliased there as `paneLayoutMode`) to
  // decide whether to render `workspaceCanvas`; this route needs the same
  // flag too, to tell `ToolPanel` when it's currently live inside a
  // workspace-canvas tile (see `hidePanelControls`).
  const { layoutMode: paneLayoutMode, canvasToolbarVisible } = useLayout();

  const [quickOpen, setQuickOpen] = useState(false);
  // Keyboard-shortcut-triggered dialogs (Alt+N, Alt+Shift+N below) —
  // reuse the same dialogs the sidebar's "+" (new worktree) and the tab bar's
  // "+" (new agent) already open, just driven from here since this is where
  // "current project"/"current worktree" are already resolved.
  const [shortcutNewWorktreeOpen, setShortcutNewWorktreeOpen] = useState(false);
  const [shortcutNewAgentOpen, setShortcutNewAgentOpen] = useState(false);

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

  // Derive the detached workspace being viewed, if any (Phase 3a.4). `workspaceDocs`
  // is client-only persisted state (zustand `persist`, hydrated synchronously from
  // localStorage) — no `bundleLoaded` gate needed the way directSession's redirect
  // effect below needs one for server-fetched `sessions`.
  const workspaceDocs = useWorkspaceStore((s) => s.workspaceDocs);
  const viewedWorkspace = useMemo(() => {
    if (!isWorkspaceView || !params.workspaceId) return null;
    return workspaceDocs[params.workspaceId] ?? null;
  }, [isWorkspaceView, params.workspaceId, workspaceDocs]);

  // Current worktree + its owning project, for the new-worktree/new-agent
  // shortcuts below — same lookup pattern as `directSessionProject` above.
  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.id === activeWorktreeId) ?? null,
    [worktrees, activeWorktreeId],
  );
  const activeWorktreeProject = useMemo(
    () => (activeWorktree ? (projects.find((p) => p.id === activeWorktree.projectId) ?? null) : null),
    [activeWorktree, projects],
  );

  // The dialogs these open are scoped to `activeWorktree`/`activeWorktreeProject`
  // (below) — reset if either goes away (e.g. switching to a direct session)
  // so a dialog left open doesn't silently reappear scoped to whatever
  // worktree/project the user lands on next.
  useEffect(() => {
    setShortcutNewWorktreeOpen(false);
    setShortcutNewAgentOpen(false);
  }, [activeWorktreeId]);

  // Stable identities so `useWorkspaceKeyboardShortcuts`'s effect (keyed on
  // these) doesn't tear down and re-add its `keydown` listener on every
  // unrelated re-render of this route.
  const openNewWorktreeShortcut = useCallback(() => setShortcutNewWorktreeOpen(true), []);
  const openNewAgentShortcut = useCallback(() => setShortcutNewAgentOpen(true), []);

  useWorkspaceUrlSync(bundleLoaded, worktrees, sessions);
  // Quick Open + pane shortcuts work in both worktree and direct-session modes
  // (direct sessions browse the project base dir); only full-width panes (and
  // the detached workspace view, which has no single owning worktree/project
  // to scope a file search to) opt out.
  useWorkspaceKeyboardShortcuts(
    setQuickOpen,
    !isFullWidthPane && !isWorkspaceView,
    paneLayoutMode === "workspace",
    activeWorktreeProject ? openNewWorktreeShortcut : undefined,
    activeWorktree ? openNewAgentShortcut : undefined,
  );

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

  // Same mutual exclusion for the detached workspace view — it isn't "owned"
  // by any single worktree (that's the whole point of Phase 3), so clear any
  // leftover worktree/direct-session context on entry.
  useEffect(() => {
    if (!isWorkspaceView) return;
    const s = useWorkspaceStore.getState();
    if (s.activeWorktreeId || s.activeSessionId) {
      useWorkspaceStore.setState({
        activeWorktreeId: null,
        activeSessionId: null,
        activeFilePath: null,
      });
    }
  }, [isWorkspaceView]);

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

  // Redirect to dashboard if the workspace doc no longer exists (deleted, or a
  // stale/invalid id in the URL — Risk #8, Phase 3c.3). Mirrors the direct-
  // session pattern above; no `bundleLoaded` gate since `workspaceDocs` isn't
  // server-fetched.
  useEffect(() => {
    if (!isWorkspaceView) return;
    if (params.workspaceId && !viewedWorkspace) {
      navigate("/", { replace: true });
    }
  }, [isWorkspaceView, params.workspaceId, viewedWorkspace, navigate]);

  // Update browser tab title to reflect current context
  useEffect(() => {
    if (isSettings) {
      document.title = "Settings — Vibe Station";
    } else if (isDirectSession && directSession) {
      const projectName = directSessionProject?.name ?? "Direct";
      document.title = `${sessionLabel(directSession)} — ${projectName} — Vibe Station`;
    } else if (isWorkspaceView && viewedWorkspace) {
      document.title = `${viewedWorkspace.name} — Vibe Station`;
    } else if (isDashboard || !activeWorktreeId) {
      document.title = "Vibe Station";
    } else {
      const wt = worktrees.find((w) => w.id === activeWorktreeId);
      document.title = wt ? `${wt.branch} — Vibe Station` : "Vibe Station";
    }
  }, [
    activeWorktreeId,
    worktrees,
    isDashboard,
    isSettings,
    isDirectSession,
    directSession,
    directSessionProject,
    isWorkspaceView,
    viewedWorkspace,
  ]);

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
  const activeTerminalSession = activeTerminalSessionId
    ? sessions.find((s) => s.id === activeTerminalSessionId)
    : undefined;

  // Every live pane (agent/terminal/tools) for the active worktree — mounted
  // ONCE via a single, always-mounted <PaneHostLayer> below, regardless of
  // classic vs. workspace mode, so a mode toggle (or a tab switch) never
  // remounts a live TerminalPane/AgentPaneSlot (ghost-PTY-stream bug, see
  // AGENTS.md). Direct sessions are exempt — they keep their own direct
  // rendering untouched (workspace mode is worktree-only).
  const worktreeAgentSessions = useMemo(
    () => sessions.filter((s) => s.worktreeId === activeWorktreeId && s.type === "agent"),
    [sessions, activeWorktreeId],
  );
  const worktreeTerminalSessions = useMemo(
    () => sessions.filter((s) => s.worktreeId === activeWorktreeId && s.type === "terminal"),
    [sessions, activeWorktreeId],
  );
  // A worktree's classic per-worktree canvas placement is ALWAYS its own
  // transient scratch canvas now — it never binds to a saved WorkspaceDoc
  // (see WorkspaceCanvas.tsx's module doc), so its pane-key set is just its
  // own sessions + tools, no cross-worktree union needed. A saved doc's
  // cross-worktree panes are handled entirely by `detachedWorkspacePaneKeys`
  // below, for the doc's own `/workspaces/:id` route.
  const worktreePaneKeys = useMemo<PaneKey[]>(() => {
    if (!activeWorktreeId || isDirectSession) return [];
    const keys: PaneKey[] = [];
    for (const s of worktreeAgentSessions) keys.push(`agent:${s.id}`);
    for (const s of worktreeTerminalSessions) keys.push(`terminal:${s.id}`);
    keys.push(`tools:${activeWorktreeId}`);
    return keys;
  }, [activeWorktreeId, isDirectSession, worktreeAgentSessions, worktreeTerminalSessions]);
  // Whether ToolPanel instances rendered via this pane-key registry are
  // CURRENTLY live inside a workspace-canvas tile (either the classic
  // per-worktree canvas, or the detached /workspaces/:id view — both use
  // this same `renderWorktreePane`) rather than the classic docked tool
  // panel — see `ToolPanel`'s `hidePanelControls` prop.
  const inWorkspaceCanvas = isWorkspaceView || paneLayoutMode === "workspace";
  const renderWorktreePane = useCallback(
    (key: PaneKey): ReactNode => {
      if (key.startsWith("agent:")) {
        const id = key.slice("agent:".length);
        const paneSession = sessions.find((s) => s.id === id);
        // D20 — resolve the branch from the SESSION's own worktree, not the
        // route's `activeWorktreeId`: `renderWorktreePane` is also reused for
        // a detached workspace doc's cross-worktree pane set (see
        // `detachedWorkspacePaneKeys` below), so a pane's session can belong
        // to a different worktree than whatever is "active".
        const paneBranch = paneSession?.worktreeId
          ? worktrees.find((w) => w.id === paneSession.worktreeId)?.branch ?? null
          : null;
        // BLOCKING-2 — resolve the PR from the pane SESSION's own worktree
        // (its `isMain` session), not `paneSession.pr` directly: the daemon
        // only ever writes `pr` to a worktree's `isMain` session, so a
        // sibling agent's pane would otherwise never show the branch's PR.
        const panePr = paneSession?.worktreeId
          ? worktreePrStatus(
              sessions.filter((s) => s.worktreeId === paneSession.worktreeId),
              paneBranch ?? "",
            )
          : null;
        return (
          <AgentPaneSlot
            api={api}
            sessionId={id}
            session={paneSession}
            branch={paneBranch}
            pr={panePr}
          />
        );
      }
      if (key.startsWith("terminal:")) {
        const id = key.slice("terminal:".length);
        return <TerminalPane api={api} sessionId={id} session={sessions.find((s) => s.id === id)} />;
      }
      const wtId = key.slice("tools:".length);
      return (
        <ToolPanel
          api={api}
          worktreeId={wtId}
          baseBranch={worktrees.find((w) => w.id === wtId)?.baseBranch}
          hidePanelControls={inWorkspaceCanvas}
        />
      );
    },
    [sessions, worktrees, inWorkspaceCanvas],
  );
  const worktreePaneHostLayer = (
    <PaneHostLayer paneKeys={worktreePaneKeys} renderPane={renderWorktreePane} />
  );

  // Detached workspace view (Phase 3c): the viewed doc's own pane set, derived
  // straight from its tiles, WITHOUT requiring an `activeWorktreeId` (there
  // isn't one — this route has no owning worktree; a worktree's own classic
  // canvas placement is always its own scratch canvas, never a saved doc —
  // see WorkspaceCanvas.tsx's module doc). Reuses `renderWorktreePane`, which
  // is already generic over the `agent:`/`terminal:`/`tools:` key prefixes.
  const detachedWorkspacePaneKeys = useMemo<PaneKey[]>(() => {
    if (!viewedWorkspace) return [];
    const keys: PaneKey[] = [];
    for (const tile of viewedWorkspace.tiles) {
      if (tile.kind === "tools") {
        keys.push(`tools:${tile.worktreeId ?? viewedWorkspace.contextKey}`);
      } else if (tile.sessionId && sessions.some((s) => s.id === tile.sessionId)) {
        keys.push(`${tile.kind}:${tile.sessionId}`);
      }
    }
    return keys;
  }, [viewedWorkspace, sessions]);
  const detachedWorkspacePaneHostLayer = (
    <PaneHostLayer paneKeys={detachedWorkspacePaneKeys} renderPane={renderWorktreePane} />
  );
  const detachedWorkspaceCanvas = viewedWorkspace ? (
    <WorkspaceCanvas
      worktreeId={viewedWorkspace.contextKey}
      agentSessions={[]}
      terminalSessions={[]}
      hasTools
      toolPanelVisible
      terminalDockVisible
      allSessions={sessions}
      worktrees={worktrees}
      projects={projects}
      detachedWorkspaceId={viewedWorkspace.id}
      canvasToolbarVisible
    />
  ) : null;

  const agentPane = (
    <div className="pane-stack">
      <TabsStrip api={api} worktreeId={activeWorktreeId} kind="agent" />
      {/* The live AgentPaneSlot is portaled in via <PaneOutlet> from the
          shared PaneHostLayer above — never rendered directly here — so it
          stays mounted across a classic <-> workspace layoutMode toggle. */}
      {activeSessionId ? (
        <PaneOutlet paneKey={`agent:${activeSessionId}`} />
      ) : (
        <div className="empty-state">No agent session</div>
      )}
    </div>
  );

  const terminalDock = (
    <div className="pane-stack">
      <TabsStrip api={api} worktreeId={activeWorktreeId} kind="terminal" />
      {activeTerminalSessionId ? (
        <PaneOutlet paneKey={`terminal:${activeTerminalSessionId}`} />
      ) : (
        <div className="empty-state">No terminal session</div>
      )}
    </div>
  );

  const worktreeToolPanel = activeWorktreeId ? (
    <PaneOutlet paneKey={`tools:${activeWorktreeId}`} />
  ) : (
    <ToolPanel api={api} worktreeId={null} />
  );

  const workspaceCanvas =
    activeWorktreeId && !isDirectSession ? (
      <WorkspaceCanvas
        worktreeId={activeWorktreeId}
        agentSessions={worktreeAgentSessions}
        terminalSessions={worktreeTerminalSessions}
        hasTools
        // Canvas mode: every pane is its own tile, so the classic docked
        // panel's visibility flags no longer mean "hide this region" — they'd
        // just blank a tile's content with nothing left to un-hide it from
        // (the TopBar buttons that used to control these are now disabled/
        // repurposed for canvas mode, see TopBar.tsx). Force both true, same
        // as the detached workspace-view canvas above.
        toolPanelVisible
        terminalDockVisible
        allSessions={sessions}
        worktrees={worktrees}
        projects={projects}
        canvasToolbarVisible={canvasToolbarVisible}
      />
    ) : null;

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
      {/* A direct session has no worktree, so no branch to guard a PR
          against — `branch` defaults to null, which unconditionally
          suppresses `session.pr` (a direct session can never show a PR). */}
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
        : isWorkspaceView
          ? "workspace-view"
          : "workspace";

  return (
    <PaneOutletProvider>
    <div className="workspace-route">
      {!isFullWidthPane && !isWorkspaceView ? (
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
      {activeWorktreeProject ? (
        <NewSessionDialog
          open={shortcutNewWorktreeOpen}
          projectId={activeWorktreeProject.id}
          projectName={activeWorktreeProject.name}
          api={api}
          onClose={() => setShortcutNewWorktreeOpen(false)}
          onCreated={() => { /* store stays current via worktree:created WS event */ }}
        />
      ) : null}
      {activeWorktree ? (
        <NewTabDialog
          open={shortcutNewAgentOpen}
          api={api}
          worktreeId={activeWorktree.id}
          onClose={() => setShortcutNewAgentOpen(false)}
          onCreated={() => { /* store stays current via session:created WS event */ }}
        />
      ) : null}
      <Layout
        topBar={
          <TopBar
            layoutMode={layoutMode}
            projects={projects}
            worktrees={worktrees}
            directSession={directSession ?? undefined}
            directSessionProject={directSessionProject ?? undefined}
            viewedWorkspaceName={viewedWorkspace?.name}
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
              if (isDashboard || isSettings || isDirectSession || isWorkspaceView) navigate(`/worktree/${wtId}`);
            }}
          />
        }
        dashboardPane={
          isDashboard ? (
            <DashboardPanel api={api} />
          ) : isSettings ? (
            <SettingsPanel api={api} />
          ) : isWorkspaceView ? (
            // Rendered via the `dashboardPane` slot (full-bleed, no classic
            // agent/tools/terminal three-pane machinery) since this view has
            // no single owning worktree to key that machinery's persisted
            // sizes/visibility off of — see Layout.tsx's dashboard branch.
            (detachedWorkspaceCanvas ?? <div className="workspace-canvas workspace-canvas--loading" />)
          ) : undefined
        }
        leftColumnPx={leftColumnPx}
        leftSidebarCollapsed={leftSidebarCollapsed}
        onLeftSidebarResize={setLeftSidebarWidthPx}
        isMobile={isMobile}
        mobileSidebarOpen={mobileSidebarOpen}
        onMobileSidebarClose={() => setMobileSidebarOpen(false)}
        {...(isWorkspaceView
          ? // Detached workspace view: rendered via `dashboardPane` above, which
            // doesn't read agentPane/toolPanel/terminalDock/workspaceCanvas at
            // all (Layout.tsx returns early once `dashboardPane` is set) — the
            // only prop that branch still needs from here is `paneHostLayer`,
            // so the viewed doc's tiles have somewhere to portal their live
            // panes into.
            { paneHostLayer: detachedWorkspacePaneHostLayer }
          : isFullWidthPane
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
                  toolPanel: worktreeToolPanel,
                  terminalDock,
                  workspaceCanvas,
                  paneHostLayer: worktreePaneHostLayer,
                })}
      />
    </div>
    </PaneOutletProvider>
  );
}
