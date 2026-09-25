import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "@/api";
import { Layout } from "@/components/layout/Layout";
import { TopBar } from "@/components/layout/TopBar";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { TabsStrip } from "@/components/layout/TabsStrip";
import { TerminalPane } from "@/components/layout/TerminalPane";
import { AgentPaneSlot } from "@/components/layout/AgentPaneSlot";
import { ToolPanel } from "@/components/layout/ToolPanel";
import { DashboardPanel } from "@/components/layout/DashboardPanel";
import { ProjectHomeTab } from "@/components/layout/ProjectHomeTab";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { PaneOutletProvider, PaneOutlet } from "@/components/layout/paneOutlets";
import { PaneHostLayer, type PaneKey } from "@/components/layout/PaneHostLayer";
import { WorkspaceCanvas } from "@/components/layout/WorkspaceCanvas";
import { useWorkspaceStore, removeTileFromCanvas } from "@/hooks/useStore";
import { useLayout } from "@/hooks/useLayout";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useWorkspaceUrlSync } from "@/hooks/useWorkspaceUrlSync";
import { useProjectWorkspaceUrlSync } from "@/hooks/useProjectWorkspaceUrlSync";
import { useWorkspaceKeyboardShortcuts } from "@/hooks/useWorkspaceKeyboardShortcuts";
import { worktreePrStatus } from "@/lib/statusColor";
import { sessionLabel } from "@/lib/sessionLabel";
import { QuickOpen } from "@/components/dialogs/QuickOpen";
import { DraftComposer } from "@/components/draft/DraftComposer";

export function Workspace() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{ projectId?: string; sessionId?: string; directSessionId?: string; workspaceId?: string; draftSessionId?: string }>();
  const isDashboard = location.pathname === "/";
  const isProjectView = location.pathname.startsWith("/project/");
  const projectId = isProjectView ? (params.projectId ?? null) : null;
  const isSettings = location.pathname === "/settings" || location.pathname.startsWith("/settings/");
  // Draft route — /draft/new (Tier 2, no server record yet) or /draft/:id
  // (Tier 1, a server-persisted drafting session).
  const isDraft = location.pathname.startsWith("/draft/");
  const draftSessionId = isDraft ? (params.draftSessionId ?? null) : null;
  const settingsSectionId = isSettings ? (location.pathname.split("/")[2] ?? null) : null;
  const SETTINGS_LABELS: Record<string, string> = {
    "modes": "Modes",
    "appearance": "Appearance",
    "projects": "Projects",
    "hidden-projects": "Hidden projects",
    "storage": "Storage",
    "remote-access": "Remote Access",
  };
  const settingsSectionLabel = settingsSectionId ? (SETTINGS_LABELS[settingsSectionId] ?? settingsSectionId) : undefined;
  const isDirectSession = location.pathname.startsWith("/session/");
  // Detached-workspace view (agent-interaction-workspaces/04-workspaces Phase 3,
  // Decision 4) — a saved WorkspaceDoc's own route, independent of any worktree.
  const isWorkspaceView = location.pathname.startsWith("/workspaces/");
  // `/session/:id` is now a pure redirect (R4 / 4.9) to the project workspace, so
  // it is treated as a full-width pane — a benign transient render before the
  // redirect effect fires — never the old standalone direct-session layout.
  const isFullWidthPane = isDashboard || isSettings || isDraft || isDirectSession;

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
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  // `session.state` (not `.lifecycleState`) — see AgentPaneSlot.tsx:74-80 for why:
  // the live WS handlers only patch `.state`, so `.lifecycleState` goes stale.
  const activeSessionIsDrafting = activeSession?.state === "drafting";
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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

  // Stable identities so `useWorkspaceKeyboardShortcuts`'s effect (keyed on
  // these) doesn't tear down and re-add its `keydown` listener on every
  // unrelated re-render of this route. Both shortcuts now open the instant
  // draft flow (create a drafting session and navigate to its composer) —
  // the old modal dialogs are gone.
  const openNewWorktreeShortcut = useCallback(() => {
    if (!activeWorktreeProject) return;
    void api
      .createDraftSession({
        target: "direct",
        projectId: activeWorktreeProject.id,
        type: "agent",
        draftConfig: { entryPoint: "worktree", worktreeChoice: "new" },
      })
      .then((s) => {
        useServerStore.getState().applySessionCreated(s);
        navigate(`/draft/${s.id}`);
      })
      .catch(() => {
        /* surface later */
      });
  }, [activeWorktreeProject, navigate]);
  const openNewAgentShortcut = useCallback(() => {
    if (!activeWorktree) return;
    void api
      .createDraftSession({
        target: "worktree",
        worktreeId: activeWorktree.id,
        type: "agent",
        draftConfig: { entryPoint: "tab" },
      })
      .then((s) => {
        useServerStore.getState().applySessionCreated(s);
        navigate(`/draft/${s.id}`);
      })
      .catch(() => {
        /* surface later */
      });
  }, [activeWorktree, navigate]);

  // Navigate to a just-created agent. The draft→worktree/direct-session jump
  // is a SPA navigation, so `useWorkspaceUrlSync`'s read effect (which only
  // consumes URL params on first load) will NOT pick up the new id — we have to
  // select it in the store ourselves. For a worktree, `setActiveWorktree`
  // sets activeWorktreeId; for a direct session, `createDirectSession` has
  // already registered the session, so we navigate straight to the project
  // workspace tab (`/project/:projectId/:id`).
  const handleAgentCreated = useCallback(
    (result: { worktreeId?: string; sessionId?: string }) => {
      if (result.worktreeId) {
        const serverStore = useServerStore.getState();
        const wt = serverStore.worktrees.find((w) => w.id === result.worktreeId);
        if (wt) {
          const wtSessions = serverStore.sessions.filter((s) => s.worktreeId === wt.id);
          useWorkspaceStore.getState().setActiveWorktree(wt.projectId, wt.id, wtSessions);
          // `setActiveWorktree` picks its own default session (last-used → main
          // → first agent), which is NOT necessarily the one the user just
          // started/promoted — e.g. Tier 1 `startDraft` promotes a specific
          // draft session, and `setActiveWorktree`'s idempotency guard no-ops
          // if we're already on that worktree with a stale activeSessionId.
          // Force the freshly-started session to be the active one when we
          // already know it (the draft session for Tier 1; the main session for
          // Tier 2 once its `session:created` WS event has landed — otherwise
          // TabsStrip picks it up).
          if (result.sessionId && serverStore.sessions.some((s) => s.id === result.sessionId)) {
            useWorkspaceStore.getState().setActiveSession(result.sessionId);
          }
        } else {
          // Not in the store yet (e.g. Tier 1 `startDraft` relies on the
          // daemon's `worktree:created` WS broadcast, which can lose the race
          // to this HTTP reply). URL sync can't select a worktree it can't
          // see, so this would otherwise regress to the original bare
          // `/worktree` bug; the WS event / TabsStrip fetch recovers once it
          // lands. Log so it's visible if this becomes common.
          console.warn(`[workspace] created worktree ${result.worktreeId} not yet in store`);
        }
        navigate(`/worktree/${result.worktreeId}`);
      } else if (result.sessionId) {
        // A direct (worktree-less) session — land it in the project workspace.
        // `createDirectSession` has already registered it in the server store,
        // so look up its projectId and navigate to the project workspace tab.
        // If it isn't in the store yet, fall back to `/session/:id` — whose
        // R4 redirect effect (:283) resolves to `/project/:pid/:id` once the
        // session IS a direct agent, or bounces to `/` otherwise (it does NOT
        // wait for the session to land).
        const created = useServerStore.getState().sessions.find(
          (s) => s.id === result.sessionId,
        );
        if (created && created.projectId) {
          navigate(`/project/${created.projectId}/${created.id}`);
        } else {
          navigate(`/session/${result.sessionId}`);
        }
      }
    },
    [navigate],
  );

  useWorkspaceUrlSync(bundleLoaded, worktrees, sessions);
  useProjectWorkspaceUrlSync(isProjectView, bundleLoaded, sessions, projects);
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
  // Project view is owned by useProjectWorkspaceUrlSync (Decision 9) — guard
  // off here, but keep `isProjectView` in deps so leaving project view (to `/`
  // or `/settings`) still re-triggers the effect and clears the stale context.
  useEffect(() => {
    if (isProjectView) return;
    const pid = isDirectSession ? (directSessionProject?.id ?? null) : null;
    if (useWorkspaceStore.getState().activeDirectContextId !== pid) {
      useWorkspaceStore.getState().setActiveDirectContext(pid);
    }
  }, [isDirectSession, directSessionProject, isProjectView]);

  // R4 / 4.9 — `/session/:id` is now a pure redirect into the project workspace.
  // When `bundleLoaded` and `params.directSessionId` resolves to a direct agent
  // (worktreeId === null && type === "agent"), go to `/project/:projectId/:id`;
  // a worktree-attached session (or a missing id) falls back to `/`.
  useEffect(() => {
    if (!isDirectSession || !bundleLoaded) return;
    const id = params.directSessionId;
    if (!id) return;
    const s = sessions.find((x) => x.id === id);
    if (s && s.worktreeId === null && s.type === "agent" && s.projectId) {
      navigate(`/project/${s.projectId}/${s.id}`, { replace: true });
    } else {
      navigate("/", { replace: true });
    }
  }, [isDirectSession, bundleLoaded, params.directSessionId, sessions, navigate]);

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

  // CUJ 7 — stale draft route: navigating (e.g. back button) to /draft/:id
  // where the session exists but is no longer in the "drafting" state should
  // redirect to the now-live session (or dashboard if it's gone entirely).
  const notFoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isDraft || !draftSessionId || !bundleLoaded) {
      if (notFoundTimerRef.current) { clearTimeout(notFoundTimerRef.current); notFoundTimerRef.current = null; }
      return;
    }
    const s = sessions.find((x) => x.id === draftSessionId);
    if (!s) {
      // Give the WS session:created event 600ms to arrive before declaring the session dead.
      if (!notFoundTimerRef.current) {
        notFoundTimerRef.current = setTimeout(() => {
          notFoundTimerRef.current = null;
          navigate("/", { replace: true });
        }, 600);
      }
      return;
    }
    if (notFoundTimerRef.current) { clearTimeout(notFoundTimerRef.current); notFoundTimerRef.current = null; }
    // `s.state` (not `.lifecycleState`) — see AgentPaneSlot.tsx:74-80 for why:
    // `.lifecycleState` is only set on the initial fetch, never patched live.
    if (s.state === "drafting") return;
    if (s.worktreeId) navigate(`/worktree/${s.worktreeId}`, { replace: true });
    else if (s.projectId) navigate(`/project/${s.projectId}/${s.id}`, { replace: true });
    else navigate("/", { replace: true });
  }, [isDraft, draftSessionId, bundleLoaded, sessions, navigate]);

  useEffect(() => {
    return () => { if (notFoundTimerRef.current) clearTimeout(notFoundTimerRef.current); };
  }, []);

  // Update browser tab title to reflect current context
  useEffect(() => {
    if (isSettings) {
      document.title = "Settings — Vibe Station";
    } else if (isWorkspaceView && viewedWorkspace) {
      document.title = `${viewedWorkspace.name} — Vibe Station`;
    } else if (isProjectView) {
      // Project workspace — title shows the project's name regardless of which
      // tab (Project or a direct agent) is active (R3).
      const proj = projects.find((p) => p.id === projectId);
      document.title = proj ? `${proj.name} — Vibe Station` : "Vibe Station";
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
    isWorkspaceView,
    viewedWorkspace,
    isProjectView,
    projectId,
    projects,
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
    if (!bundleLoaded || isDirectSession || isProjectView) return;
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
  }, [bundleLoaded, isDirectSession, isProjectView, worktrees, sessions, projects, location.pathname, navigate]);

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
  const contextKeyAgentSessions = useMemo(
    () => sessions.filter((s) => s.worktreeId === viewedWorkspace?.contextKey && s.type === "agent"),
    [sessions, viewedWorkspace],
  );
  const contextKeyTerminalSessions = useMemo(
    () => sessions.filter((s) => s.worktreeId === viewedWorkspace?.contextKey && s.type === "terminal"),
    [sessions, viewedWorkspace],
  );
  // A worktree's classic per-worktree canvas placement is ALWAYS its own
  // transient scratch canvas (it never binds to a saved WorkspaceDoc — see
  // WorkspaceCanvas.tsx's module doc), so the base of its pane-key set is its
  // own sessions + tools.
  //
  // Plus any FOREIGN tile its scratch canvas happens to carry: a child agent
  // auto-inserted next to its spawning parent (`parentSessionId`, useServerSync)
  // can belong to a different worktree entirely (`vst worktree create`). Those
  // tiles render live content only if their pane is mounted here — otherwise
  // they're empty ghost windows. Mirrors `detachedWorkspacePaneKeys` below.
  // Select only `tiles`, not the whole canvas: `freeRects`/`tree` change on
  // every drag/resize frame but never affect which panes should be mounted,
  // and `updateScratchCanvas` preserves the `tiles` array reference when a
  // patch doesn't touch it — subscribing to the whole object would re-render
  // this route (and everything under it) on every mousemove of a drag.
  const activeScratchCanvasTiles = useWorkspaceStore(
    (s) => (activeWorktreeId ? (s.layoutByWorktree[activeWorktreeId]?.scratchCanvas?.tiles ?? null) : null),
  );
  const worktreePaneKeys = useMemo<PaneKey[]>(() => {
    if (!activeWorktreeId || isDirectSession) return [];
    const keys: PaneKey[] = [];
    const seen = new Set<string>();
    const push = (k: PaneKey) => {
      if (seen.has(k)) return;
      seen.add(k);
      keys.push(k);
    };
    for (const s of worktreeAgentSessions) push(`agent:${s.id}`);
    for (const s of worktreeTerminalSessions) push(`terminal:${s.id}`);
    push(`tools:${activeWorktreeId}`);
    for (const tile of activeScratchCanvasTiles ?? []) {
      if (tile.kind === "tools") {
        const twt = tile.worktreeId ?? activeWorktreeId;
        if (worktrees.some((w) => w.id === twt)) push(`tools:${twt}`);
      } else if (tile.sessionId && sessions.some((s) => s.id === tile.sessionId)) {
        push(`${tile.kind}:${tile.sessionId}`);
      }
    }
    return keys;
  }, [
    activeWorktreeId,
    isDirectSession,
    worktreeAgentSessions,
    worktreeTerminalSessions,
    activeScratchCanvasTiles,
    sessions,
    worktrees,
  ]);
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
            canvasMode={inWorkspaceCanvas}
          />
        );
      }
      if (key.startsWith("terminal:")) {
        const id = key.slice("terminal:".length);
        // A plain terminal tile must never steal focus in canvas mode either
        // — same reasoning as AgentPaneSlot's `focusOnMount={!canvasMode}`
        // just above (59d44a7 added that for agent panes but missed this
        // sibling path, since a plain terminal session renders TerminalPane
        // directly rather than through AgentPaneSlot).
        return (
          <TerminalPane
            api={api}
            sessionId={id}
            session={sessions.find((s) => s.id === id)}
            focusOnMount={!inWorkspaceCanvas}
            themed={false}
          />
        );
      }
      const wtId = key.slice("tools:".length);
      const onCloseToolsTile = inWorkspaceCanvas
        ? () => {
            const store = useWorkspaceStore.getState();
            let canvas;
            if (isWorkspaceView && viewedWorkspace) {
              canvas = store.workspaceDocs[viewedWorkspace.id] ?? null;
            } else if (wtId) {
              canvas = store.layoutByWorktree[wtId]?.scratchCanvas ?? null;
            }
            if (!canvas) return;
            const existing = canvas.tiles.find(
              (t: { kind: string; worktreeId?: string }) =>
                t.kind === "tools" && (t.worktreeId ?? wtId) === wtId,
            );
            if (!existing) return;
            const next = removeTileFromCanvas(canvas, existing.id);
            if (isWorkspaceView && viewedWorkspace) {
              store.updateWorkspaceDoc(viewedWorkspace.id, next);
            } else if (wtId) {
              store.updateScratchCanvas(wtId, next);
            }
          }
        : undefined;
      return (
        <ToolPanel
          api={api}
          worktreeId={wtId}
          baseBranch={worktrees.find((w) => w.id === wtId)?.baseBranch}
          branch={worktrees.find((w) => w.id === wtId)?.branch}
          hidePanelControls={inWorkspaceCanvas}
          onOpenQuickOpen={() => setQuickOpen(true)}
          onClose={onCloseToolsTile}
        />
      );
    },
    [sessions, worktrees, inWorkspaceCanvas, isWorkspaceView, viewedWorkspace],
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
    const seen = new Set<string>();
    const push = (k: PaneKey) => {
      if (seen.has(k)) return;
      seen.add(k);
      keys.push(k);
    };
    for (const tile of viewedWorkspace.tiles) {
      if (tile.kind === "tools") {
        const twt = tile.worktreeId ?? viewedWorkspace.contextKey;
        if (worktrees.some((w) => w.id === twt)) push(`tools:${twt}`);
      } else if (tile.sessionId && sessions.some((s) => s.id === tile.sessionId)) {
        push(`${tile.kind}:${tile.sessionId}`);
      }
    }
    return keys;
  }, [viewedWorkspace, sessions, worktrees]);
  const detachedWorkspacePaneHostLayer = (
    <PaneHostLayer paneKeys={detachedWorkspacePaneKeys} renderPane={renderWorktreePane} />
  );
  const detachedWorkspaceCanvas = viewedWorkspace ? (
    <WorkspaceCanvas
      worktreeId={viewedWorkspace.contextKey}
      agentSessions={contextKeyAgentSessions}
      terminalSessions={contextKeyTerminalSessions}
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
        activeSessionIsDrafting ? (
          <DraftComposer
            key={activeSessionId}
            api={api}
            draftSessionId={activeSessionId}
            onStarted={(result) => {
              useWorkspaceStore.setState({ activeSessionId: null });
              handleAgentCreated(result);
            }}
            onDiscard={async () => {
              try {
                await api.terminateSession(activeSessionId);
              } catch {
                /* ignore */
              }
              useWorkspaceStore.setState({ activeSessionId: null });
            }}
          />
        ) : (
          <PaneOutlet paneKey={`agent:${activeSessionId}`} />
        )
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

  // Project workspace (Decision 2): the project's own pane set — one
  // `agent:<id>` per OPEN direct-agent tab (that still exists — a session
  // terminated elsewhere must not leave a stale pane key), plus one shared
  // `tools:<projectId>`. Terminal session keys are deliberately excluded:
  // the terminal dock's TerminalPane renders directly in `terminalDock`
  // below, keyed only by `activeTerminalSessionId`, so it never remounts on a
  // Project↔agent switch (AGENTS.md TerminalPane invariant).
  const projectOpenAgentIds = useWorkspaceStore((s) =>
    isProjectView && projectId ? (s.openDirectAgentTabsByProject[projectId] ?? null) : null,
  );
  const projectPaneKeys = useMemo<PaneKey[]>(() => {
    if (!isProjectView || !projectId) return [];
    const keys: PaneKey[] = [];
    const seen = new Set<string>();
    const push = (k: PaneKey) => {
      if (seen.has(k)) return;
      seen.add(k);
      keys.push(k);
    };
    for (const id of projectOpenAgentIds ?? []) {
      // Item 3 Fix D — a drafting session renders via the `DraftComposer`
      // branch below, not the offscreen pane-host mechanism; leaving it out
      // of `projectPaneKeys` stops an `AgentPaneSlot` from mounting for it.
      const s = sessions.find((sess) => sess.id === id);
      if (s && s.state !== "drafting") push(`agent:${id}`);
    }
    push(`tools:${projectId}`);
    return keys;
  }, [isProjectView, projectId, projectOpenAgentIds, sessions]);
  const renderProjectPane = useCallback(
    (key: PaneKey): ReactNode => {
      if (key.startsWith("agent:")) {
        const id = key.slice("agent:".length);
        // A direct agent has no worktree, so branch/pr are always null (a
        // direct session can never show a PR).
        return (
          <AgentPaneSlot
            api={api}
            sessionId={id}
            session={sessions.find((s) => s.id === id)}
            branch={null}
            pr={null}
          />
        );
      }
      const pid = key.slice("tools:".length);
      return (
        <ToolPanel
          api={api}
          worktreeId={pid}
          scope="project"
          onOpenQuickOpen={() => setQuickOpen(true)}
        />
      );
    },
    [sessions],
  );
  const projectPaneHostLayer = (
    <PaneHostLayer paneKeys={projectPaneKeys} renderPane={renderProjectPane} />
  );

  // Project workspace pane: the project-scoped agent TabsStrip (which itself
  // renders a real, pinned, non-closeable "Overview" tab first — PRD R1 /
  // Resolved design question #3) plus this pane's content, which mirrors
  // whichever tab is active: the ProjectHomeTab when the pinned Overview tab is
  // active (activeSessionId === null) or the matching `agent:<id>` pane
  // otherwise (Decision 7 — routed through agentPane/toolPanel/terminalDock/
  // paneHostLayer, never dashboardPane, so the shared tools pane and the
  // terminal dock stay at stable tree positions across every switch).
  const projectAgentPane = isProjectView && projectId ? (
    <div className="pane-stack">
      <TabsStrip api={api} worktreeId={projectId} kind="agent" scope="project" />
      {activeSessionId ? (
        activeSessionIsDrafting ? (
          // Item 3 Fix C — mirrors the worktree pane's drafting branch above
          // (`:653-670`), so a draft opened via the project-scope "+" (or
          // ProjectHomeTab's "New direct agent") renders its composer instead
          // of a broken `PaneOutlet` pointed at a session with no live pane.
          <DraftComposer
            key={activeSessionId}
            api={api}
            draftSessionId={activeSessionId}
            onStarted={(result) => {
              // Unlike the worktree branch, do NOT null `activeSessionId`
              // first — a "tab" draft start promotes the SAME session id in
              // place, so `handleAgentCreated` navigates to
              // `/project/:pid/:id` (a no-op on the current URL); nulling it
              // first would bounce the URL through `/project/:pid` first.
              handleAgentCreated(result);
            }}
            onDiscard={async () => {
              try {
                await api.terminateSession(activeSessionId);
              } catch {
                /* ignore */
              }
              // Also nulls `activeSessionId` if it was the discarded draft.
              useWorkspaceStore.getState().closeProjectAgentTab(projectId, activeSessionId);
            }}
          />
        ) : (
          <PaneOutlet paneKey={`agent:${activeSessionId}`} />
        )
      ) : (
        (() => {
          const project = projects.find((p) => p.id === projectId);
          if (!project) return <div className="empty-state">Project not found</div>;
          return (
            <ProjectHomeTab
              key={project.id}
              api={api}
              project={project}
              sessions={sessions}
              worktrees={worktrees.filter((w) => w.projectId === projectId)}
              onOpenAgent={handleAgentCreated}
            />
          );
        })()
      )}
    </div>
  ) : null;
  const projectToolPanel = isProjectView && projectId ? (
    <PaneOutlet paneKey={`tools:${projectId}`} />
  ) : null;
  const projectTerminalDock = isProjectView && projectId ? (
    <div className="pane-stack">
      <TabsStrip api={api} worktreeId={projectId} kind="terminal" scope="project" />
      <TerminalPane api={api} sessionId={activeTerminalSessionId} session={activeTerminalSession} themed={false} />
    </div>
  ) : null;

  // Compute layout mode for TopBar
  const layoutMode = isSettings
    ? "settings"
    : isDashboard || isDraft || isDirectSession
      ? "dashboard"
      : isProjectView
        ? "project-workspace"
        : isWorkspaceView
          ? "workspace-view"
          : "workspace";

  return (
    <PaneOutletProvider>
    <div className="workspace-route">
      {!isFullWidthPane && !isWorkspaceView ? (
        isProjectView && projectId ? (
          // Project workspace: file search scopes to the project base dir.
          <QuickOpen
            api={api}
            worktreeId={projectId}
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
            viewedWorkspaceName={viewedWorkspace?.name}
            projectActiveSessionName={
              isProjectView && activeSessionId && activeSession
                ? sessionLabel(activeSession)
                : undefined
            }
            isMobile={isMobile}
            onToggleLeftSidebar={() => {
              if (isMobile) setMobileSidebarOpen(!mobileSidebarOpen);
              else toggleLeftSidebarCollapsed();
            }}
            leftSidebarCollapsed={leftSidebarCollapsed}
            mobileSidebarOpen={mobileSidebarOpen}
            onOpenQuickOpen={() => setQuickOpen(true)}
            shortcutsOpen={shortcutsOpen}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onCloseShortcuts={() => setShortcutsOpen(false)}
            settingsSectionLabel={isMobile ? settingsSectionLabel : undefined}
            // replace, not push: a plain push would leave the section entry in
            // history, so the phone's Back gesture right after tapping Back
            // would drop straight back into the section you just left.
            onSettingsBack={isMobile && settingsSectionId ? () => navigate("/settings", { replace: true }) : undefined}
          />
        }
        leftSidebar={
          <LeftSidebar
            api={api}
            collapsed={!isMobile && leftSidebarCollapsed}
            isMobile={isMobile}
            onWorktreeSelected={(wtId) => {
              if (isMobile) setMobileSidebarOpen(false);
              if (isDashboard || isSettings || isDirectSession || isWorkspaceView || isDraft || isProjectView) navigate(`/worktree/${wtId}`);
            }}
            onOpenShortcuts={() => setShortcutsOpen(true)}
          />
        }
        dashboardPane={
          isDashboard ? (
            <DashboardPanel api={api} />
          ) : isSettings ? (
            <SettingsPanel api={api} />
          ) : isDraft ? (
            // Full-pane DraftComposer for /draft/* routes — rendered directly
            // (not via the pane portal system): a draft is a config form with
            // no live agent stream, so portaling it adds complexity with zero
            // benefit (Decision 4).
            <DraftComposer
              key={draftSessionId ?? `new:${location.key}`}
              api={api}
              draftSessionId={draftSessionId}
              onStarted={(result) => {
                handleAgentCreated(result);
              }}
              onDiscard={async () => {
                if (draftSessionId) {
                  try {
                    await api.terminateSession(draftSessionId);
                  } catch {
                    /* ignore */
                  }
                }
                navigate("/", { replace: true });
              }}
            />
          ) : isWorkspaceView ? (
            // Rendered via the `dashboardPane` slot (full-bleed, no classic
            // agent/tools/terminal three-pane machinery) since this view has
            // no single owning worktree to key that machinery's persisted
            // sizes/visibility off of — see Layout.tsx's dashboard branch.
            (detachedWorkspaceCanvas ?? <div className="workspace-canvas workspace-canvas--loading" />)
          ) : isDirectSession ? (
            // Transient only: `/session/:id` is a pure redirect to the project
            // workspace (R4 / 4.9), so this placeholder renders for at most a
            // tick before the redirect effect navigates away.
            <div className="empty-state">Redirecting…</div>
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
            : isProjectView
              ? {
                  // Project workspace (Decision 7): routed through the classic
                  // agentPane/toolPanel/terminalDock/paneHostLayer machinery —
                  // never dashboardPane — so the shared `tools:<projectId>`
                  // pane and the terminal dock's TerminalPane stay at stable
                  // tree positions across every Project↔agent tab switch.
                  agentPane: projectAgentPane,
                  toolPanel: projectToolPanel,
                  terminalDock: projectTerminalDock,
                  paneHostLayer: projectPaneHostLayer,
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
