import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitBranch, GitCommitHorizontal, Sparkles } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { Project, Session, Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { createProjectDirectDraft, createProjectWorktreeDraft } from "@/lib/projectDraft";
import { useSessionBuckets } from "@/components/layout/DashboardPanel";
import { SessionChip } from "@/components/layout/SessionChip";
import { StatusDot } from "@/components/layout/StatusDot";
import { sessionStatus } from "@/lib/worktreeStatus";
import { sessionLabel, worktreeLabel } from "@/lib/sessionLabel";
import { worktreePrStatus } from "@/lib/statusColor";
import { rollupPrSessionsByWorktree, type PrWorktreeGroup } from "@/lib/prWorktreeRollup";

export interface ProjectHomeTabProps {
  api: ApiInstance;
  project: Project;
  sessions: Session[];
  worktrees: Worktree[];
  /**
   * Called when a bucket-row worktree agent is clicked (item 1). Reuses
   * Workspace.tsx's `handleAgentCreated`, which selects the target worktree
   * in the store before navigating — sidestepping the one-shot worktree
   * URL-sync gap rather than hand-rolling `navigate('/worktree/:wt/:sid')`.
   */
  onOpenAgent: (result: { worktreeId?: string; sessionId?: string }) => void;
}

/**
 * The pinned "Overview" tab of the project workspace. Shows the project's git
 * status, quick actions ("New agent in worktree" / "New direct agent"), and an empty
 * state that foregrounds those two actions (R11).
 */
export function ProjectHomeTab({ api, project, sessions, worktrees, onOpenAgent }: ProjectHomeTabProps) {
  const [gitInitError, setGitInitError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"worktree" | "direct" | null>(null);
  const navigate = useNavigate();

  // `isGit`/`defaultBranch` come straight off the `project` prop. Workspace.tsx
  // re-derives `project` from the projects store each render (and keyed
  // ProjectHomeTab by project.id), so git-init's `applyProjectUpdated` update
  // flows back through the prop on the next render — no local git-status
  // override needed.
  const isGit = project.isGit;
  const defaultBranch = project.defaultBranch;

  // Direct agents only — excludes drafting sessions, matching
  // `seedProjectAgentTabsIfEmpty` and the sidebar (both treat drafts separately,
  // as draft rows, never as live direct agents). This also keeps `isEmpty`
  // consistent: a project with only a draft still shows the empty state.
  const directAgents = sessions.filter(
    (s) =>
      s.projectId === project.id &&
      s.worktreeId === null &&
      s.type === "agent" &&
      s.archivedAt == null &&
      s.state !== "drafting",
  );

  const isEmpty = worktrees.length === 0 && directAgents.length === 0;

  // Decision 6 — reuse the dashboard's bucketing logic verbatim (worktree-only,
  // so direct agents are excluded from every bucket and rendered in their own
  // "Direct agents" list below). `bucketForRollup` is untouched, so no
  // docs/STATUS-INDICATORS.md update is needed.
  const { working, needsYou, idle, pr, finished } = useSessionBuckets(project.id, { worktreeOnly: true });

  const worktreeById = useMemo(() => {
    const map = new Map<string, Worktree>();
    for (const wt of worktrees) {
      map.set(wt.id, wt);
    }
    return map;
  }, [worktrees]);

  const rolledUpPr = useMemo(
    () => rollupPrSessionsByWorktree(pr, worktreeById),
    [pr, worktreeById],
  );

  const sessionStates = useWorkspaceStore((s) => s.sessionStates);

  // Mirror DashboardPanel's default: the "finished" section is collapsed
  // (hidden) by default, matching the dashboard's `showFinished` default.
  const [showFinished, setShowFinished] = useState(false);

  // Mirrors DraftComposer.tsx:698-709's gitInitAndApply — apply THIS client's
  // own HTTP response to the store immediately rather than waiting on our own
  // `project:updated` WS echo. The store update re-derives `project` in the
  // parent, so the header flips on the next render without local state.
  const gitInitAndApply = useCallback(async () => {
    const res = await api.gitInitProject(project.id);
    const cur = useServerStore.getState().projects.find((p) => p.id === project.id);
    if (cur) {
      useServerStore.getState().applyProjectUpdated({
        ...cur,
        isGit: res.isGit,
        ...(res.defaultBranch ? { defaultBranch: res.defaultBranch } : {}),
      });
    }
    return res;
  }, [api, project.id]);

  const handleGitInit = async () => {
    setGitInitError(null);
    try {
      await gitInitAndApply();
    } catch {
      setGitInitError("Could not initialize git. Check the project path and try again.");
    }
  };

  // Opens a DRAFT that creates its worktree only on Start — the same path as
  // the sidebar's project "+" → "Agent in worktree" (`createProjectWorktreeDraft`),
  // so an abandoned draft never leaves an orphan worktree behind.
  // `DraftComposer` resolves its own default mode, so no `resolveDefaultModeId`
  // gate here (same reasoning as `handleNewDirectAgent` below).
  const handleNewWorktreeAgent = async () => {
    setActionError(null);
    if (!isGit) return;
    try {
      setCreating("worktree");
      const s = await createProjectWorktreeDraft(api, project.id);
      navigate(`/draft/${s.id}`);
    } catch {
      setActionError("Could not start a new draft. Please try again.");
    } finally {
      setCreating(null);
    }
  };

  // Item 3 (DECIDED, human-confirmed): opens a DRAFT direct-agent tab —
  // same path as the tab-strip "+" button (`createProjectDirectDraft`) —
  // instead of creating a live agent immediately, for consistency between
  // the two "new direct agent" entry points. `DraftComposer` (rendered by
  // `Workspace.tsx`'s drafting branch once the tab is active) resolves its
  // own default mode, so this no longer needs a `resolveDefaultModeId` gate.
  const handleNewDirectAgent = async () => {
    setActionError(null);
    try {
      setCreating("direct");
      const s = await createProjectDirectDraft(api, project.id);
      useWorkspaceStore.getState().openProjectAgentTab(project.id, s.id);
      useWorkspaceStore.getState().setActiveSession(s.id);
    } catch {
      setActionError("Could not create the agent. Please try again.");
    } finally {
      setCreating(null);
    }
  };

  const newWorktreeDisabled = !isGit || creating !== null;
  const newDirectDisabled = creating !== null;

  // A worktree-attached session row in one of the 5 bucket sections. The dot
  // reflects the live lifecycle status (`sessionStates` override first); PR is
  // not shown on these rows — bucketing above already placed the session by PR,
  // and this list is a summary, not the full dashboard card. Item 1: tappable,
  // opening the row's worktree + agent tab via `onOpenAgent` (`handleAgentCreated`,
  // which selects the worktree before navigating — sidesteps the one-shot
  // worktree URL-sync gap). Item 2: shows the owning worktree's label as a
  // chip before the session name, since "main"/"Agent" alone doesn't say
  // which worktree a row belongs to.
  const renderSessionRow = (s: Session) => {
    const wt = s.worktreeId != null ? worktreeById.get(s.worktreeId) : undefined;
    return (
      <SessionChip
        key={s.id}
        status={sessionStatus(sessionStates[s.id] ?? s.state)}
        pr={null}
        sessionLabel={sessionLabel(s)}
        worktreeLabel={wt ? worktreeLabel(wt) : "direct"}
        projectLabel={project.name}
        groupLabel={wt ? worktreeLabel(wt) : project.name}
        isDirect={!wt}
        channel={s.channel}
        createdAt={s.createdAt}
        onClick={() => onOpenAgent({ worktreeId: s.worktreeId ?? undefined, sessionId: s.id })}
      />
    );
  };

  // `prSessions` is the pr-bucket group's own sessions (from
  // `rollupPrSessionsByWorktree`) — NOT every session on the worktree, so a
  // `working` sibling outside the pr bucket can never win this row's status
  // dot (found in review). `worktreePrStatus` still needs the FULL
  // per-worktree session list (it reads the `isMain` session specifically,
  // per its own branch-guard contract), so that one keeps using `sessions`.
  const renderWorktreePrRow = ({ worktree: wt, sessions: prSessions }: PrWorktreeGroup) => {
    const sessionsForWt = sessions.filter((s) => s.worktreeId === wt.id);
    const mainSession = prSessions.find((s) => s.isMain) ?? prSessions[0];
    const liveState = mainSession ? (sessionStates[mainSession.id] ?? mainSession.state) : "idle";
    const status = sessionStatus(liveState);
    const prStatus = worktreePrStatus(sessionsForWt, wt.branch);

    const agentLabel = mainSession ? sessionLabel(mainSession) : "main";
    return (
      <SessionChip
        key={wt.id}
        status={status}
        pr={prStatus}
        sessionLabel={agentLabel}
        worktreeLabel={wt.branch}
        projectLabel={project.name}
        groupLabel={project.name}
        isDirect={false}
        channel={mainSession?.channel}
        createdAt={mainSession?.createdAt ?? wt.createdAt}
        onClick={() => onOpenAgent({ worktreeId: wt.id, sessionId: mainSession?.id })}
      />
    );
  };

  return (
    // Item 2 (round 2): `.project-home` used to own both the scroll and the
    // `max-width` centering on the same box, so the scrollbar rendered at
    // the edge of the (narrower, centered) content instead of the true
    // right edge of the available pane, and the content itself hugged the
    // left edge with no `margin-inline: auto` to center it. Split into an
    // outer full-width scroll container (`.project-home-scroll`, owns
    // `overflow`, scrollbar sits flush against the pane's real edge) and an
    // inner centered content box (`.project-home`, keeps `max-width` +
    // gains `margin-inline: auto`).
    <div className="project-home-scroll">
      <div className="project-home">
      <header className="project-home__header">
        <div className="project-home__title">
          <h1 className="project-home__name">{project.name}</h1>
          <span className="project-home__path">{project.path}</span>
        </div>

        <div className="project-home__actions">
          <button
            type="button"
            className="project-home__action"
            onClick={handleNewWorktreeAgent}
            disabled={newWorktreeDisabled}
            title={!isGit ? "Run git init first" : undefined}
          >
            <GitBranch size={14} />
            New agent in worktree
          </button>
          <button
            type="button"
            className="project-home__action"
            onClick={handleNewDirectAgent}
            disabled={newDirectDisabled}
          >
            <Sparkles size={14} />
            New direct agent
          </button>
          <label className="project-home__show-finished">
            <input
              type="checkbox"
              checked={showFinished}
              onChange={(e) => setShowFinished(e.target.checked)}
            />
            Show finished
          </label>
        </div>
      </header>

      <div className="project-home__git-status">
        {isGit ? (
          <span className="project-home__git-ok">
            <GitCommitHorizontal size={14} />
            ✓ {defaultBranch}
          </span>
        ) : (
          <>
            <span className="project-home__git-warn">⚠ Not a git repo</span>
            <button
              type="button"
              className="project-home__git-init"
              onClick={handleGitInit}
              disabled={creating !== null}
            >
              Run git init
            </button>
          </>
        )}
        {gitInitError && <span className="project-home__error">{gitInitError}</span>}
      </div>

      {actionError && <div className="project-home__error">{actionError}</div>}

      {isEmpty && (
        <div className="project-home__empty">
          <p className="project-home__empty-text">
            This project has no worktrees or direct agents yet. Create a worktree to start on a branch, or spin up a
            direct agent in this directory.
          </p>
        </div>
      )}

      {!isEmpty && (
        <div className="project-home__buckets">
          {working.length > 0 ? (
            <section className="dashboard-section">
              <div className="dashboard-section__label">working</div>
              <div className="project-home__card-list">
                {working.map((s) => renderSessionRow(s))}
              </div>
            </section>
          ) : null}

          {needsYou.length > 0 ? (
            <section className="dashboard-section">
              <div className="dashboard-section__label">needs you</div>
              <div className="project-home__card-list">
                {needsYou.map((s) => renderSessionRow(s))}
              </div>
            </section>
          ) : null}

          {idle.length > 0 ? (
            <section className="dashboard-section">
              <div className="dashboard-section__label">idle</div>
              <div className="project-home__card-list">
                {idle.map((s) => renderSessionRow(s))}
              </div>
            </section>
          ) : null}

          {rolledUpPr.length > 0 ? (
            <section className="dashboard-section">
              <div className="dashboard-section__label">pr created</div>
              <div className="project-home__card-list">
                {rolledUpPr.map((group) => renderWorktreePrRow(group))}
              </div>
            </section>
          ) : null}

          {showFinished && finished.length > 0 ? (
            <section className="dashboard-section">
              <div className="dashboard-section__label">finished</div>
              <div className="project-home__card-list">
                {finished.map((s) => renderSessionRow(s))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      {directAgents.length > 0 && (
        <section className="dashboard-section project-home__direct-agents">
          <div className="dashboard-section__label">Direct agents</div>
          <div className="project-home__card-list">
            {directAgents.map((s) => (
              <button
                key={s.id}
                type="button"
                className="project-home__direct-row"
                onClick={() => {
                  // Item 1: a direct agent has no worktree — open/activate its
                  // own tab directly, same pair the "New direct agent" handler
                  // uses (the URL-sync write effect then syncs the URL).
                  useWorkspaceStore.getState().openProjectAgentTab(project.id, s.id);
                  useWorkspaceStore.getState().setActiveSession(s.id);
                }}
              >
                <StatusDot status={sessionStatus(sessionStates[s.id] ?? s.state)} pr={null} />
                <span className="project-home__direct-name" title={sessionLabel(s)}>
                  {sessionLabel(s)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      </div>
    </div>
  );
}
