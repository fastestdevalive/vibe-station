import { useCallback, useEffect, useMemo, useState } from "react";
import { Columns3, LayoutList } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { ApiInstance } from "@/api";
import type { PrStatus, Session } from "@/api/types";
import { StatusDot } from "@/components/layout/StatusDot";
import { useSubscription } from "@/hooks/useSubscription";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { type WorktreeRolledUpStatus, sessionStatus } from "@/lib/worktreeStatus";
import { worktreePrStatus } from "@/lib/statusColor";
import { sessionLabel } from "@/lib/sessionLabel";
import { ModeIcon } from "@/components/agent/ModeIcon";
import { useModeIcon } from "@/store/modesStore";
import { sessionModeId } from "@/lib/modeIcon";

interface DashboardPanelProps {
  api: ApiInstance;
  /** When set, restrict the dashboard to exactly this one project (Decision 6 —
   *  the `/project/:id` single-project view). Undefined renders the full
   *  multi-project dashboard. */
  projectFilter?: string;
}

/**
 * Dashboard buckets, coarser than the full `WorktreeRolledUpStatus` set.
 * `pr` is checked out-of-band from the session's own lifecycle status (`r`)
 * — it's the orthogonal PR axis (`statusColor.ts`), not a
 * `WorktreeRolledUpStatus` value.
 *
 * Order (D19): `done`/`exited` are checked FIRST and unconditionally bucket
 * to "finished" — a merged PR must never pull a done/exited session back
 * into the PR column (this reverses the earlier "done + merged → PR
 * bucket" behavior). Only then does live lifecycle activity
 * (`working`/`spawning`) win over PR outcome, since active work is the more
 * urgent signal; PR outcome in turn wins over a merely idle/waiting-for-human
 * lifecycle, since a merged/open PR is a more meaningful summary than "idle".
 *  - "finished": `done` or `exited` (D19, checked first) — or no
 *    recognizable state at all. Hidden by default behind "Show finished".
 *  - "working": actively running, or not started yet (`spawning`).
 *  - "pr": this session's branch has an open or merged PR (`session.pr`).
 *  - "needs-you": `waiting_for_human` — the agent is explicitly blocked on a
 *    human. Was previously folded into "waiting" together with `idle`,
 *    which put a neutral, nothing-to-see idle session in a column labeled
 *    "Waiting" with no red indicator — read as a bug (Phase 6, 6.6). Split
 *    out so this column is always the red-`!` "needs you" case.
 *  - "idle": stopped after finishing a turn, nothing flagged. Deliberately
 *    NOT "finished" — an idle session is still open work, just not urgent.
 *    Shown by default (not hidden behind "Show finished").
 */
export function bucketForRollup(
  r: WorktreeRolledUpStatus,
  pr: PrStatus | null,
): "working" | "needs-you" | "idle" | "pr" | "finished" {
  if (r === "done" || r === "exited") return "finished";
  if (r === "working" || r === "spawning") return "working";
  if (pr?.state === "open" || pr?.state === "merged") return "pr";
  if (r === "waiting_for_human") return "needs-you";
  if (r === "idle") return "idle";
  return "finished";
}

export interface SessionBuckets {
  working: Session[];
  needsYou: Session[];
  idle: Session[];
  pr: Session[];
  finished: Session[];
}

export interface UseSessionBucketsOptions {
  /**
   * When true, only worktree-attached agent sessions are bucketed — direct
   * (worktree-less) sessions are excluded from every bucket entirely. Used by
   * ProjectHomeTab, which renders direct agents in its own "Direct agents"
   * list instead (Decision 6). Defaults to false (full dashboard behavior).
   */
  worktreeOnly?: boolean;
}

/**
 * Decision 6 — the dashboard's per-session bucketing loop, extracted from the
 * `DashboardPanel` render so `ProjectHomeTab` can reuse it verbatim (R9: the
 * worktree status-bucket grouping must stay logic-identical to today's
 * dashboard, which is why this is an extraction, not a rewrite — and why no
 * `docs/STATUS-INDICATORS.md` update is needed: `bucketForRollup` and the
 * section labels are untouched). Reads `sessions`/`sessionStates`/
 * `hiddenProjectIds`/`worktreeById`/`worktreePrById` internally via the same
 * store selectors `DashboardPanel` uses.
 *
 * @param projectFilter restrict to exactly one project (or undefined for all).
 * @param opts.worktreeOnly exclude direct (worktree-less) sessions.
 */
export function useSessionBuckets(
  projectFilter?: string,
  opts?: UseSessionBucketsOptions,
): SessionBuckets {
  const projects = useServerStore((s) => s.projects);
  const worktrees = useServerStore((s) => s.worktrees);
  const sessions = useServerStore((s) => s.sessions);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);

  /** Hidden projects (and all their worktrees) are excluded from every dashboard
   *  list — visibility only; unhide from Settings. */
  const hiddenProjectIds = useMemo(
    () => new Set(projects.filter((p) => p.hidden).map((p) => p.id)),
    [projects],
  );

  const worktreeById = useMemo(
    () => new Map(worktrees.map((w) => [w.id, w])),
    [worktrees],
  );

  /**
   * PR is a property of the BRANCH, not any one session (BLOCKING-2 fix).
   * Resolve it once per worktree here via `worktreePrStatus()`, then apply it
   * to every non-archived agent session card of that worktree below.
   */
  const worktreePrById = useMemo(() => {
    const map = new Map<string, PrStatus | null>();
    for (const wt of worktrees) {
      const sessionsForWt = sessions.filter((s) => s.worktreeId === wt.id);
      map.set(wt.id, worktreePrStatus(sessionsForWt, wt.branch));
    }
    return map;
  }, [worktrees, sessions]);

  const worktreeOnly = opts?.worktreeOnly ?? false;

  const { working, needsYou, idle, pr, finished } = useMemo(() => {
    const sWorking: Session[] = [];
    const sNeedsYou: Session[] = [];
    const sIdle: Session[] = [];
    const sPr: Session[] = [];
    const sFinished: Session[] = [];
    // One card per non-archived agent session — worktree-attached and direct
    // alike (Phase 6). Archived (handed-off/reset) sessions are excluded:
    // one stuck in `waiting_for_human` shouldn't produce a stray card.
    for (const s of sessions) {
      if (s.type !== "agent" || s.archivedAt != null) continue;
      const wt = s.worktreeId != null ? worktreeById.get(s.worktreeId) : undefined;
      if (wt) {
        if (hiddenProjectIds.has(wt.projectId)) continue;
        // Decision 6: single-project view — only sessions of the filtered project.
        if (projectFilter != null && wt.projectId !== projectFilter) continue;
      } else {
        // Direct (worktree-less) session.
        if (worktreeOnly) continue;
        if (!s.projectId || hiddenProjectIds.has(s.projectId)) continue;
        if (projectFilter != null && s.projectId !== projectFilter) continue;
      }
      const status = sessionStatus(sessionStates[s.id] ?? s.state);
      // PR is resolved per WORKTREE (branch-guarded, D20), not per session —
      // `worktreePrById` reads it from the worktree's `isMain` session and
      // is applied to every non-archived agent session card of that
      // worktree. A direct session has no worktree, so it can never show a
      // PR (6.3).
      const sessionPr = wt ? worktreePrById.get(wt.id) ?? null : null;
      const b = bucketForRollup(status, sessionPr);
      if (b === "working") sWorking.push(s);
      else if (b === "needs-you") sNeedsYou.push(s);
      else if (b === "idle") sIdle.push(s);
      else if (b === "pr") sPr.push(s);
      else sFinished.push(s);
    }
    return { working: sWorking, needsYou: sNeedsYou, idle: sIdle, pr: sPr, finished: sFinished };
  }, [sessions, sessionStates, hiddenProjectIds, worktreeById, worktreePrById, projectFilter, worktreeOnly]);

  return { working, needsYou, idle, pr, finished };
}

const DASHBOARD_VIEW_KEY = "dashboard:view";
const DASHBOARD_SHOW_FINISHED_KEY = "dashboard:showFinished";

/**
 * Mode icon for a dashboard card. Wrapped in its own component so the
 * `useModeIcon` hook (which must run at the top level, not in the render map)
 * resolves the icon key for a single session and re-renders as modes
 * load/update/delete.
 */
function CardIcon({ session, api }: { session: Session; api: ApiInstance }) {
  const iconKey = useModeIcon(sessionModeId(session), api);
  // aria-hidden: decorative — the card's text label conveys the session name.
  return (
    <span className="dashboard-card__icon" aria-hidden="true">
      <ModeIcon iconKey={iconKey} channel={session.channel} size={14} />
    </span>
  );
}

export function DashboardPanel({ api, projectFilter }: DashboardPanelProps) {
  const navigate = useNavigate();

  // ── Header indicators ───────────────────────────────────────────────────────
  const [tunnelEnabled, setTunnelEnabled] = useState(false);

  const fetchHeaderStats = useCallback(async () => {
    const tunnelState = await api.getTunnelStatus().catch(() => null);
    if (tunnelState) {
      setTunnelEnabled(tunnelState.enabled);
    }
  }, [api]);

  useEffect(() => {
    void fetchHeaderStats();
    const id = setInterval(() => { void fetchHeaderStats(); }, 30_000);
    return () => clearInterval(id);
  }, [fetchHeaderStats]);
  // Server data + live state both come from central stores — see useServerSync
  // (mounted in Workspace) for the fetch + WS event reducers.
  const projects = useServerStore((s) => s.projects);
  const worktrees = useServerStore((s) => s.worktrees);
  const sessions = useServerStore((s) => s.sessions);
  const setActiveWorktree = useWorkspaceStore((s) => s.setActiveWorktree);
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

  const [showFinished, setShowFinished] = useState(() => {
    try {
      return localStorage.getItem(DASHBOARD_SHOW_FINISHED_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_SHOW_FINISHED_KEY, String(showFinished));
    } catch {
      /* ignore */
    }
  }, [showFinished]);

  // Subscribe to live session output for every session in the store so the
  // rollup updates in real time. The set of ids comes from the central store
  // (single source of truth) — no local fetch, no local listeners.
  const sessionIdKey = useMemo(
    () => sessions.map((s) => s.id).sort().join(","),
    [sessions],
  );
  useSubscription(sessionIdKey ? sessionIdKey.split(",").filter(Boolean) : [], api);

  const projectById = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);
  const visibleProjects = useMemo(
    () =>
      projects
        .filter((p) => !p.hidden)
        .filter((p) => (projectFilter != null ? p.id === projectFilter : true)),
    [projects, projectFilter],
  );

  /** Live state map (persisted across page loads, refreshed on every ws:open
   *  by useServerSync). The rollup uses it as the primary signal and falls
   *  back to the REST session's `state` field. */
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);

  const worktreeById = useMemo(
    () => new Map(worktrees.map((w) => [w.id, w])),
    [worktrees],
  );

  /**
   * PR is a property of the BRANCH, not any one session (BLOCKING-2 fix).
   * The daemon writes `session.pr` only to a worktree's `isMain` session
   * (`prPoller.ts`); resolve it once per worktree here via the same
   * `worktreePrStatus()` the sidebar rollup uses, then apply it to every
   * non-archived agent session card of that worktree below — this is what
   * makes sibling (non-main) agent sessions on the same branch also show the
   * PR colour/bucket, per docs/STATUS-INDICATORS.md § Per-session vs
   * per-worktree, without the daemon fanning out writes to N sessions.
   */
  const worktreePrById = useMemo(() => {
    const map = new Map<string, PrStatus | null>();
    for (const wt of worktrees) {
      const sessionsForWt = sessions.filter((s) => s.worktreeId === wt.id);
      map.set(wt.id, worktreePrStatus(sessionsForWt, wt.branch));
    }
    return map;
  }, [worktrees, sessions]);

  const { working, needsYou, idle, pr, finished } = useSessionBuckets(projectFilter);

  const renderDashboardItem = useCallback(
    (s: Session) => {
      const status = sessionStatus(sessionStates[s.id] ?? s.state);
      const wt = s.worktreeId != null ? worktreeById.get(s.worktreeId) : undefined;
      const sessionPr = wt ? worktreePrById.get(wt.id) ?? null : null;
      const proj = s.projectId != null ? projectById[s.projectId] : undefined;
      if (!wt) {
        // Direct (worktree-less) session — no worktree context to show, no
        // dismiss affordance (nothing to dismiss).
        return (
          <div key={s.id} className="dashboard-card-shell">
            <Link
              to={s.projectId ? `/project/${s.projectId}/${s.id}` : `/session/${s.id}`}
              className="dashboard-card dashboard-card--session dashboard-card--worktree"
            >
              <span className="dashboard-card__dot dashboard-card__dot--status">
                <StatusDot status={status} pr={sessionPr} />
              </span>
              <span className="dashboard-card__session-main">
                <CardIcon session={s} api={api} />
                <span className="dashboard-card__primary" title={sessionLabel(s)}>
                  {sessionLabel(s)}
                </span>
                <span className="dashboard-card__branch">direct</span>
              </span>
              <span className="dashboard-card__secondary">{proj?.name ?? ""}</span>
            </Link>
          </div>
        );
      }
      const sessionsForWt = sessions.filter((s2) => s2.worktreeId === wt.id);
      return (
        <div key={s.id} className="dashboard-card-shell">
          <Link
            to={`/worktree/${wt.id}`}
            className="dashboard-card dashboard-card--session dashboard-card--worktree"
            onClick={() => setActiveWorktree(wt.projectId, wt.id, sessionsForWt)}
          >
            <span className="dashboard-card__dot dashboard-card__dot--status">
              <StatusDot status={status} pr={sessionPr} />
            </span>
            <span className="dashboard-card__session-main">
              <CardIcon session={s} api={api} />
              <span className="dashboard-card__primary" title={sessionLabel(s)}>
                {sessionLabel(s)}
              </span>
              <span className="dashboard-card__branch">
                {wt.branch} · {wt.id}
              </span>
            </span>
            <span className="dashboard-card__secondary">{proj?.name ?? ""}</span>
          </Link>
        </div>
      );
    },
    [projectById, sessionStates, sessions, setActiveWorktree, worktreeById, worktreePrById, api],
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
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--fg-muted)",
              cursor: "pointer",
            }}
            onClick={() => navigate("/settings")}
          >
            · {tunnelEnabled ? "◎ tunnel on" : "○ tunnel off"}
          </span>
          <div className="dashboard-header__actions">
            <label className="dashboard-header__show-finished">
              <input
                type="checkbox"
                checked={showFinished}
                onChange={(e) => setShowFinished(e.target.checked)}
              />
              Show finished
            </label>
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
        </div>

        {/* On mobile always render the list layout — kanban columns don't work on narrow screens */}
        {isMobile || dashboardView === "list" ? (
          <>
            {working.length > 0 ? (
              <section className="dashboard-section">
                <div className="dashboard-section__label">working</div>
                <div className="dashboard-card-list">{working.map((s) => renderDashboardItem(s))}</div>
              </section>
            ) : null}

            {needsYou.length > 0 ? (
              <section className="dashboard-section">
                <div className="dashboard-section__label">needs you</div>
                <div className="dashboard-card-list">{needsYou.map((s) => renderDashboardItem(s))}</div>
              </section>
            ) : null}

            {idle.length > 0 ? (
              <section className="dashboard-section">
                <div className="dashboard-section__label">idle</div>
                <div className="dashboard-card-list">{idle.map((s) => renderDashboardItem(s))}</div>
              </section>
            ) : null}

            {pr.length > 0 ? (
              <section className="dashboard-section">
                <div className="dashboard-section__label">pr created</div>
                <div className="dashboard-card-list">{pr.map((s) => renderDashboardItem(s))}</div>
              </section>
            ) : null}

            {showFinished && finished.length > 0 ? (
              <section className="dashboard-section">
                <div className="dashboard-section__label">finished</div>
                <div className="dashboard-card-list">{finished.map((s) => renderDashboardItem(s))}</div>
              </section>
            ) : null}

            {working.length === 0 &&
            needsYou.length === 0 &&
            idle.length === 0 &&
            pr.length === 0 &&
            (!showFinished || finished.length === 0) ? (
              <p className="dashboard-empty">No agent sessions yet. Add a project with the CLI.</p>
            ) : null}
          </>
        ) : (
          <div className={`dashboard-kanban${showFinished ? " dashboard-kanban--with-finished" : ""}`}>
            <div className="dashboard-kanban__col">
              <div className="dashboard-kanban__col-header">
                Working <span className="dashboard-kanban__col-count">({working.length})</span>
              </div>
              <div className="dashboard-card-list">{working.map((s) => renderDashboardItem(s))}</div>
            </div>
            <div className="dashboard-kanban__col">
              <div className="dashboard-kanban__col-header">
                Needs You <span className="dashboard-kanban__col-count">({needsYou.length})</span>
              </div>
              <div className="dashboard-card-list">{needsYou.map((s) => renderDashboardItem(s))}</div>
            </div>
            <div className="dashboard-kanban__col">
              <div className="dashboard-kanban__col-header">
                Idle <span className="dashboard-kanban__col-count">({idle.length})</span>
              </div>
              <div className="dashboard-card-list">{idle.map((s) => renderDashboardItem(s))}</div>
            </div>
            <div className="dashboard-kanban__col">
              <div className="dashboard-kanban__col-header">
                PR Created <span className="dashboard-kanban__col-count">({pr.length})</span>
              </div>
              <div className="dashboard-card-list">{pr.map((s) => renderDashboardItem(s))}</div>
            </div>
            {showFinished ? (
              <div className="dashboard-kanban__col">
                <div className="dashboard-kanban__col-header">
                  Finished <span className="dashboard-kanban__col-count">({finished.length})</span>
                </div>
                <div className="dashboard-card-list">{finished.map((s) => renderDashboardItem(s))}</div>
              </div>
            ) : null}
          </div>
        )}

        {/* Projects — always shown below worktree sections (hidden projects excluded) */}
        {visibleProjects.length > 0 ? (
          <section className="dashboard-section">
            <div className="dashboard-section__label">projects</div>
            <div className="dashboard-card-list">
              {visibleProjects.map((p) => {
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

    </div>
  );
}
