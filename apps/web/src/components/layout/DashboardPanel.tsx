import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiInstance } from "@/api";
import type { HealthResponse, Project, Session, SessionState, Worktree } from "@/api/types";
import { useSubscription } from "@/hooks/useSubscription";
import { useWorkspaceStore } from "@/hooks/useStore";

function stateColor(state: Session["state"]) {
  switch (state) {
    case "working": return "var(--success)";
    case "done": return "var(--fg-muted)";
    case "exited": return "var(--fg-muted)";
    default: return "var(--fg-secondary)";
  }
}

function stateDot(state: Session["state"], type: Session["type"]) {
  if (type === "terminal") return "─";
  switch (state) {
    case "working": return "●";
    case "idle": return "○";
    case "done": return "✓";
    case "exited": return "✕";
    default: return "○";
  }
}

interface DashboardPanelProps {
  api: ApiInstance;
}

function applySessionState(s: Session, state: SessionState): Session {
  return { ...s, state, lifecycleState: state };
}

export function DashboardPanel({ api }: DashboardPanelProps) {
  const navigate = useNavigate();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const setActiveWorktree = useWorkspaceStore((s) => s.setActiveWorktree);
  const patchSessionState = useWorkspaceStore((s) => s.patchSessionState);
  const syncSessionsFromApi = useWorkspaceStore((s) => s.syncSessionsFromApi);

  useEffect(() => {
    void (async () => {
      try {
        const h = await api.health();
        setHealth(h);
      } catch {
        setHealth(null);
      }
      const ps = await api.listProjects();
      setProjects(ps);
      const wts = (await Promise.all(ps.map((p) => api.listWorktrees(p.id)))).flat();
      setWorktrees(wts);
      const ss = (await Promise.all(wts.map((w) => api.listSessions(w.id)))).flat();
      setSessions(ss);
      syncSessionsFromApi(ss);
    })();
  }, [api, syncSessionsFromApi]);

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

  const workingSessions = sessions.filter((s) => s.state === "working");
  const idleSessions = sessions.filter((s) => s.state === "idle");
  const daemonOk = health !== null;

  const openSessionRow = useCallback(
    (s: Session) => {
      const wt = worktrees.find((w) => w.id === s.worktreeId);
      if (wt) {
        const sessionsForWorktree = sessions.filter((ss) => ss.worktreeId === wt.id);
        setActiveWorktree(wt.projectId, wt.id, sessionsForWorktree);
        void navigate("/worktree");
      }
    },
    [navigate, sessions, setActiveWorktree, worktrees],
  );

  const renderSessionCards = (list: Session[]) =>
    list.map((s) => {
      const wt = worktrees.find((w) => w.id === s.worktreeId);
      const proj = projects.find((p) => p.id === wt?.projectId);
      return (
        <button
          key={s.id}
          type="button"
          className="dashboard-card dashboard-card--session"
          onClick={() => openSessionRow(s)}
        >
          <span className="dashboard-card__dot" style={{ color: stateColor(s.state) }}>
            {stateDot(s.state, s.type)}
          </span>
          <span className="dashboard-card__session-main">
            <span className="dashboard-card__primary">{s.label}</span>
            {wt ? <span className="dashboard-card__branch">{wt.branch}</span> : null}
          </span>
          <span className="dashboard-card__secondary">{proj?.name ?? ""}</span>
        </button>
      );
    });

  return (
    <div className="dashboard-panel">
      <div className="dashboard-panel__inner">
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
              {daemonOk ? `daemon · port ${health.port}` : "daemon unreachable"}
            </span>
          </div>
        </div>

        {workingSessions.length > 0 ? (
          <section className="dashboard-section">
            <div className="dashboard-section__label">working</div>
            <div className="dashboard-card-list">{renderSessionCards(workingSessions)}</div>
          </section>
        ) : null}

        {idleSessions.length > 0 ? (
          <section className="dashboard-section">
            <div className="dashboard-section__label">idle</div>
            <div className="dashboard-card-list">{renderSessionCards(idleSessions)}</div>
          </section>
        ) : null}

        <section className="dashboard-section">
          <div className="dashboard-section__label">projects</div>
          {projects.length === 0 ? (
            <p className="dashboard-empty">No projects yet. Add one with the CLI.</p>
          ) : (
            <div className="dashboard-card-list">
              {projects.map((p) => {
                const wts = worktrees.filter((w) => w.projectId === p.id);
                const count = wts.length;
                const activeCount = wts.filter((w) =>
                  sessions.some(
                    (s) => s.worktreeId === w.id && (s.state === "working" || s.state === "idle"),
                  ),
                ).length;
                return (
                  <div key={p.id} className="dashboard-card dashboard-card--project">
                    <span className="dashboard-card__primary">{p.name}</span>
                    <span className="dashboard-card__secondary">
                      {count} {count === 1 ? "worktree" : "worktrees"}
                      {activeCount > 0 ? ` · ${activeCount} active` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
