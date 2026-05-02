import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiInstance } from "@/api";
import type { HealthResponse, Project, Session, Worktree } from "@/api/types";
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

export function DashboardPanel({ api }: DashboardPanelProps) {
  const navigate = useNavigate();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const setActiveWorktree = useWorkspaceStore((s) => s.setActiveWorktree);

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
    })();
  }, [api]);

  const activeSessions = sessions.filter((s) => s.state === "working" || s.state === "idle");
  const daemonOk = health !== null;

  return (
    <div className="dashboard-panel">
      <div className="dashboard-panel__inner">
        <div className="dashboard-header">
          <div className="dashboard-header__wordmark">viberun</div>
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

        {activeSessions.length > 0 ? (
          <section className="dashboard-section">
            <div className="dashboard-section__label">active</div>
            <div className="dashboard-card-list">
              {activeSessions.map((s) => {
                const wt = worktrees.find((w) => w.id === s.worktreeId);
                const proj = projects.find((p) => p.id === wt?.projectId);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="dashboard-card dashboard-card--session"
                    onClick={() => {
                      if (wt) {
                        const sessionsForWorktree = sessions.filter((ss) => ss.worktreeId === wt.id);
                        setActiveWorktree(wt.projectId, wt.id, sessionsForWorktree);
                        void navigate("/workspace");
                      }
                    }}
                  >
                    <span
                      className="dashboard-card__dot"
                      style={{ color: stateColor(s.state) }}
                    >
                      {stateDot(s.state, s.type)}
                    </span>
                    <span className="dashboard-card__primary">{s.label}</span>
                    <span className="dashboard-card__secondary">
                      {proj?.name}{wt ? ` / ${wt.branch}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
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
