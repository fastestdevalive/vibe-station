import { useCallback, useEffect, useMemo, useState } from "react";
import { Columns3, EyeOff, LayoutList } from "lucide-react";
import { Link } from "react-router-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { ApiInstance } from "@/api";
import type { ConnectionState } from "@/api/client";
import type { HealthResponse, Project, Session, SessionState, Worktree } from "@/api/types";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { StatusDot } from "@/components/layout/StatusDot";
import { useSubscription } from "@/hooks/useSubscription";
import { useWorkspaceStore } from "@/hooks/useStore";
import { type WorktreeRolledUpStatus, worktreeRolledUpStatus } from "@/lib/worktreeStatus";

interface DashboardPanelProps {
  api: ApiInstance;
  initialProjects?: Project[];
  initialWorktrees?: Worktree[];
  initialSessions?: Session[];
}

function applySessionState(s: Session, state: SessionState): Session {
  return { ...s, state, lifecycleState: state };
}

function bucketForRollup(r: WorktreeRolledUpStatus): "working" | "idle" | "finished" {
  if (r === "working" || r === "spawning") return "working";
  if (r === "idle") return "idle";
  return "finished";
}

const DASHBOARD_VIEW_KEY = "dashboard:view";

export function DashboardPanel({ api, initialProjects, initialWorktrees, initialSessions }: DashboardPanelProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [connState, setConnState] = useState<ConnectionState>(() => api.getConnectionState());

  useEffect(() => api.subscribeConnection(setConnState), [api]);

  // Fetch the daemon health snapshot once for the port label. The live "is the
  // daemon reachable?" indicator comes from the WS connection state — the
  // health endpoint is just for the metadata.
  useEffect(() => {
    let cancelled = false;
    void api.health()
      .then((h) => { if (!cancelled) setHealth(h); })
      .catch(() => { if (!cancelled) setHealth(null); });
    return () => { cancelled = true; };
  }, [api]);
  const [projects, setProjects] = useState<Project[]>(initialProjects ?? []);
  const [worktrees, setWorktrees] = useState<Worktree[]>(initialWorktrees ?? []);
  const [sessions, setSessions] = useState<Session[]>(initialSessions ?? []);
  const [pendingDismiss, setPendingDismiss] = useState<Worktree | null>(null);
  const setActiveWorktree = useWorkspaceStore((s) => s.setActiveWorktree);
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const clearWorkspaceSelection = useWorkspaceStore((s) => s.clearWorkspaceSelection);
  const patchSessionState = useWorkspaceStore((s) => s.patchSessionState);
  const syncSessionsFromApi = useWorkspaceStore((s) => s.syncSessionsFromApi);

  const refreshDashboard = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
    } catch {
      setHealth(null);
    }
    const [ps, wts, ss] = await Promise.all([
      api.listProjects(),
      api.listWorktrees(),
      api.listSessions(),
    ]);
    setProjects(ps);
    setWorktrees(wts);
    setSessions(ss);
    syncSessionsFromApi(ss);
  }, [api, syncSessionsFromApi]);

  const isMobile = useMediaQuery("(max-width: 768px)");

  const [dashboardView, setDashboardView] = useState<"list" | "kanban">(() => {
    try {
      const v = localStorage.getItem(DASHBOARD_VIEW_KEY);
      if (v === "kanban" || v === "list") return v;
    } catch {
      /* ignore */
    }
    return "list";
  });

  useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_VIEW_KEY, dashboardView);
    } catch {
      /* ignore */
    }
  }, [dashboardView]);

  useEffect(() => {
    // Skip initial fetch when the parent passed bundle data in — Workspace already
    // loaded everything and we don't want a second round-trip on mount.
    if (initialProjects) return;
    void refreshDashboard();
  }, [refreshDashboard, initialProjects]);

  // Mirror parent bundle into local state when it changes. The bundle is empty
  // on the very first render (before Workspace's load resolves) — without this
  // sync, the dashboard shows blank until you navigate away and back.
  useEffect(() => {
    if (initialProjects) setProjects(initialProjects);
  }, [initialProjects]);
  useEffect(() => {
    if (initialWorktrees) setWorktrees(initialWorktrees);
  }, [initialWorktrees]);
  useEffect(() => {
    // Don't call syncSessionsFromApi here — initialSessions is the frozen
    // bundle from app load, so writing it back into the global store on every
    // remount would clobber live state that arrived via WS while the panel
    // was unmounted. The rollup falls back to s.state when sessionStates has
    // no entry, so the bundle's stale state never wins over fresh WS data.
    if (initialSessions) setSessions(initialSessions);
  }, [initialSessions]);

  useEffect(() => {
    return api.on("*", (ev) => {
      if (ev.type === "worktree:deleted") void refreshDashboard();
    });
  }, [api, refreshDashboard]);

  const sessionIdKey = useMemo(
    () =>
      sessions
        .map((s) => s.id)
        .sort()
        .join(","),
    [sessions],
  );
  useSubscription(sessionIdKey ? sessionIdKey.split(",").filter(Boolean) : [], api);

  useEffect(() => {
    const offState = api.on("session:state", (ev) => {
      if (ev.type !== "session:state") return;
      setSessions((prev) =>
        prev.map((s) => (s.id === ev.sessionId ? applySessionState(s, ev.state) : s)),
      );
      patchSessionState(ev.sessionId, ev.state);
    });
    const offCreated = api.on("session:created", (ev) => {
      if (ev.type !== "session:created" || !ev.snapshot) return;
      const snap = ev.snapshot;
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === snap.id);
        if (exists) return prev.map((s) => (s.id === snap.id ? snap : s));
        return [...prev, snap];
      });
      patchSessionState(snap.id, snap.state);
    });
    const offDeleted = api.on("session:deleted", (ev) => {
      if (ev.type !== "session:deleted") return;
      setSessions((prev) => prev.filter((s) => s.id !== ev.sessionId));
    });
    const offExited = api.on("session:exited", (ev) => {
      if (ev.type !== "session:exited") return;
      setSessions((prev) =>
        prev.map((s) => (s.id === ev.sessionId ? applySessionState(s, "exited") : s)),
      );
      patchSessionState(ev.sessionId, "exited");
    });
    const offResumed = api.on("session:resumed", (ev) => {
      if (ev.type !== "session:resumed") return;
      setSessions((prev) =>
        prev.map((s) => (s.id === ev.sessionId ? applySessionState(s, "working") : s)),
      );
      patchSessionState(ev.sessionId, "working");
    });
    return () => {
      offState();
      offCreated();
      offDeleted();
      offExited();
      offResumed();
    };
  }, [api, patchSessionState]);

  const projectById = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);

  /** Live states from the global store. Same source LeftSidebar reads — keeps
   *  the rollup correct across remounts, since the store is updated via WS
   *  even when DashboardPanel was unmounted. The bundle's session.state is
   *  used as a fallback inside worktreeRolledUpStatus when no live entry. */
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);

  const { working, idle, finished } = useMemo(() => {
    const wtsWorking: Worktree[] = [];
    const wtsIdle: Worktree[] = [];
    const wtsFinished: Worktree[] = [];
    for (const wt of worktrees) {
      const agentSessions = sessions.filter((s) => s.worktreeId === wt.id && s.type === "agent");
      if (agentSessions.length === 0) continue;
      const rolled = worktreeRolledUpStatus(agentSessions, sessionStates);
      const b = bucketForRollup(rolled);
      if (b === "working") wtsWorking.push(wt);
      else if (b === "idle") wtsIdle.push(wt);
      else wtsFinished.push(wt);
    }
    return { working: wtsWorking, idle: wtsIdle, finished: wtsFinished };
  }, [worktrees, sessions, sessionStates]);

  const daemonOk = connState === "online";

  const renderWorktreeCard = useCallback(
    (wt: Worktree) => {
      const agentSessions = sessions.filter((s) => s.worktreeId === wt.id && s.type === "agent");
      const rolled = worktreeRolledUpStatus(agentSessions, sessionStates);
      const sessionsForWt = sessions.filter((s) => s.worktreeId === wt.id);
      const proj = projectById[wt.projectId];
      const showDismiss = rolled === "done" || rolled === "exited";
      return (
        <div
          key={wt.id}
          className={`dashboard-card-shell${showDismiss ? " dashboard-card-shell--dismissable" : ""}`}
        >
          <Link
            to={`/worktree/${wt.id}`}
            className="dashboard-card dashboard-card--session dashboard-card--worktree"
            onClick={() => setActiveWorktree(wt.projectId, wt.id, sessionsForWt)}
          >
            <span className="dashboard-card__dot dashboard-card__dot--status">
              <StatusDot status={rolled} />
            </span>
            <span className="dashboard-card__session-main">
              <span className="dashboard-card__primary">{wt.branch}</span>
              <span className="dashboard-card__branch">{wt.id}</span>
            </span>
            <span className="dashboard-card__secondary">{proj?.name ?? ""}</span>
          </Link>
          {showDismiss ? (
            <button
              type="button"
              className="icon-btn dashboard-card__dismiss"
              aria-label={`Dismiss ${wt.branch} from tracking`}
              title="Dismiss from tracking (keep files)"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setPendingDismiss(wt);
              }}
            >
              <EyeOff size={16} />
            </button>
          ) : null}
        </div>
      );
    },
    [projectById, sessionStates, sessions, setActiveWorktree],
  );

  const toggleViewLabel =
    dashboardView === "list" ? "Switch to kanban layout" : "Switch to list layout";

  return (
    <div className="dashboard-panel">
      <div
        className={`dashboard-panel__inner${dashboardView === "kanban" ? " dashboard-panel__inner--kanban" : ""}`}
      >
        <div className="dashboard-header">
          <div className="dashboard-header__wordmark">vibe-station</div>
          <div className="dashboard-header__daemon">
            <span
              className="dashboard-header__daemon-dot"
              style={{ color: daemonOk ? "var(--success)" : "var(--destructive)" }}
            >
              {daemonOk ? "●" : "○"}
            </span>
            <span className="dashboard-header__daemon-label">
              {daemonOk
                ? `daemon · port ${health?.port ?? "—"}`
                : connState === "connecting"
                  ? "connecting…"
                  : "daemon unreachable"}
            </span>
          </div>
          {!isMobile ? (
            <button
              type="button"
              className="icon-btn dashboard-header__view-toggle"
              aria-label={toggleViewLabel}
              title={toggleViewLabel}
              onClick={() => setDashboardView((v) => (v === "list" ? "kanban" : "list"))}
            >
              {dashboardView === "list" ? <Columns3 size={18} /> : <LayoutList size={18} />}
            </button>
          ) : null}
        </div>

        {/* On mobile always render the list layout — kanban columns don't work on narrow screens */}
        {isMobile || dashboardView === "list" ? (
          <>
            {working.length > 0 ? (
              <section className="dashboard-section">
                <div className="dashboard-section__label">working</div>
                <div className="dashboard-card-list">{working.map((wt) => renderWorktreeCard(wt))}</div>
              </section>
            ) : null}

            {idle.length > 0 ? (
              <section className="dashboard-section">
                <div className="dashboard-section__label">idle</div>
                <div className="dashboard-card-list">{idle.map((wt) => renderWorktreeCard(wt))}</div>
              </section>
            ) : null}

            {finished.length > 0 ? (
              <section className="dashboard-section">
                <div className="dashboard-section__label">finished</div>
                <div className="dashboard-card-list">{finished.map((wt) => renderWorktreeCard(wt))}</div>
              </section>
            ) : null}

            {working.length === 0 && idle.length === 0 && finished.length === 0 ? (
              <p className="dashboard-empty">No agent worktrees yet. Add a project with the CLI.</p>
            ) : null}
          </>
        ) : (
          <div className="dashboard-kanban">
            <div className="dashboard-kanban__col">
              <div className="dashboard-kanban__col-header">
                Working <span className="dashboard-kanban__col-count">({working.length})</span>
              </div>
              <div className="dashboard-card-list">{working.map((wt) => renderWorktreeCard(wt))}</div>
            </div>
            <div className="dashboard-kanban__col">
              <div className="dashboard-kanban__col-header">
                Idle <span className="dashboard-kanban__col-count">({idle.length})</span>
              </div>
              <div className="dashboard-card-list">{idle.map((wt) => renderWorktreeCard(wt))}</div>
            </div>
            <div className="dashboard-kanban__col">
              <div className="dashboard-kanban__col-header">
                Finished <span className="dashboard-kanban__col-count">({finished.length})</span>
              </div>
              <div className="dashboard-card-list">{finished.map((wt) => renderWorktreeCard(wt))}</div>
            </div>
          </div>
        )}

        {/* Projects — always shown below worktree sections */}
        {projects.length > 0 ? (
          <section className="dashboard-section">
            <div className="dashboard-section__label">projects</div>
            <div className="dashboard-card-list">
              {projects.map((p) => {
                const wts = worktrees.filter((w) => w.projectId === p.id);
                const activeCount = wts.filter((w) =>
                  sessions.some(
                    (s) => s.worktreeId === w.id && (s.state === "working" || s.state === "idle"),
                  ),
                ).length;
                return (
                  <div key={p.id} className="dashboard-card dashboard-card--project">
                    <span className="dashboard-card__primary">{p.name}</span>
                    <span className="dashboard-card__secondary">
                      {wts.length} {wts.length === 1 ? "worktree" : "worktrees"}
                      {activeCount > 0 ? ` · ${activeCount} active` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>

      <ConfirmDialog
        open={pendingDismiss !== null}
        title="Dismiss worktree?"
        message={
          pendingDismiss
            ? `Remove “${pendingDismiss.branch}” from vst tracking? Files and git branch stay on disk.`
            : ""
        }
        confirmLabel="Dismiss"
        onConfirm={() => {
          void (async () => {
            const wt = pendingDismiss;
            if (!wt) return;
            setPendingDismiss(null);
            try {
              await api.dismissWorktree(wt.id);
              if (activeWorktreeId === wt.id) clearWorkspaceSelection();
              await refreshDashboard();
            } catch {
              /* surface errors later */
            }
          })();
        }}
        onCancel={() => setPendingDismiss(null)}
      />
    </div>
  );
}
