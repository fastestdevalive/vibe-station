/**
 * PR-review poller (plan 03, "Interaction States", Decision 3/3b).
 *
 * Mirrors `lifecycle.ts`'s `pollAll`/`startLifecyclePoller`/`stopLifecyclePoller`
 * shape: one `setInterval`, one sweep per tick over every worktree, not one
 * timer per worktree. Every tick, checks each worktree's branch for an open
 * non-draft PR via the existing `github.ts` service (`fetchPrForBranch`,
 * already cached/rate-limit-aware) and flips the worktree's MAIN agent
 * session's lifecycle to `"needs_review"` (R6/R7). When the PR is no longer
 * open (merged, closed, or gone) while that session is currently
 * `"needs_review"`, it reverts to `"working"`/`"idle"` (R6).
 *
 * `needs_review` is deliberately NOT part of the 1Hz `lifecycle.ts` poller's
 * idle/working detection (its membership guard excludes it, same as
 * done/exited) — this poller is its sole owner, entry and exit, matching R5
 * ("absorbed into done/exited like every other non-terminal state, no
 * special-case guard needed" — nothing OTHER than done/exited/this poller
 * ever touches a `needs_review` session).
 */

import { getAllProjects, mutateProject } from "../state/project-store.js";
import { getRemoteUrl, parseGithubRepo, fetchPrForBranch } from "./github.js";
import { persistLifecycleState } from "./lifecycle.js";
import { jsonAgentRegistry } from "../state/jsonAgentRegistry.js";
import { sessionChannel } from "./channel.js";
import { broadcastAll } from "../broadcaster.js";
import { serializeWorktree } from "../routes/worktrees.js";
import type { SessionRecord, WorktreeRecord } from "../types.js";

/**
 * 60s (Decision 3b): >= github.ts's own 30s cache TTL (polling faster is
 * pure churn against a cached value), and — per-worktree — already at the
 * unauthenticated GitHub rate-limit ceiling (60 req/hr) with a single
 * worktree polled continuously, which is exactly why 1b.4's token warning
 * exists. Not configurable this round (matches `lifecycle.ts`'s own
 * `POLL_INTERVAL_MS` precedent).
 */
export const PR_POLL_INTERVAL_MS = 60_000;

let pollerHandle: ReturnType<typeof setInterval> | null = null;

/** 1b.4 — warn once per daemon lifetime, not once per tick. */
let warnedNoToken = false;

function hasGithubToken(): boolean {
  return Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
}

/**
 * Best-effort "what should this session fall back to, now that its PR is no
 * longer open" (R6). The 1Hz lifecycle poller never touches a
 * `needs_review` session (see module doc), so by the time this fires the
 * session's activity is otherwise unobserved — a live JSON agent with a
 * turn in flight reports "working"; everything else falls back to "idle"
 * (matches plan CUJ 3's example transition).
 */
function fallbackStateFor(session: SessionRecord): "working" | "idle" {
  if (sessionChannel(session) === "json") {
    const agent = jsonAgentRegistry.get(session.id);
    if (agent && agent.getMeta().turnState !== "idle") return "working";
  }
  return "idle";
}

/**
 * Set/clear `WorktreeRecord.prMergedAt` (dashboard-bucket-fixes) and
 * broadcast the change — same mutate-then-broadcast shape as the `/pin`
 * route (`routes/worktrees.ts`), just triggered by the poller instead of a
 * user action. `null` drops the field entirely rather than persisting an
 * explicit null, matching `pinnedAt`'s own unset convention.
 */
async function setWorktreePrMergedAt(
  projectId: string,
  worktreeId: string,
  value: string | null,
): Promise<void> {
  let updated: WorktreeRecord | undefined;
  await mutateProject(projectId, (p) => ({
    ...p,
    worktrees: p.worktrees.map((w) => {
      if (w.id !== worktreeId) return w;
      if (value == null) {
        const { prMergedAt: _drop, ...rest } = w;
        void _drop;
        updated = rest;
        return rest;
      }
      const next = { ...w, prMergedAt: value };
      updated = next;
      return next;
    }),
  }));
  if (updated) {
    broadcastAll({ type: "worktree:updated", worktree: serializeWorktree(projectId, updated) });
  }
}

async function pollWorktree(
  projectId: string,
  projectAbsolutePath: string,
  worktreeId: string,
  branch: string,
  mainSession: SessionRecord | undefined,
  currentPrMergedAt: string | undefined,
): Promise<void> {
  if (!mainSession) return; // No agent session to attribute needs_review to.
  // Terminal state — same as lifecycle.ts's own terminal-state early return.
  if (mainSession.lifecycle.state === "done" || mainSession.lifecycle.state === "exited") return;

  const remoteUrl = await getRemoteUrl(projectAbsolutePath);
  const gh = remoteUrl ? parseGithubRepo(remoteUrl) : null;
  if (!gh) return; // 1b.5 — non-GitHub remote, skip silently (matches GET /worktrees/:id/pr).

  const pr = await fetchPrForBranch(gh.owner, gh.repo, branch);
  const isReviewable = pr !== null && pr.state === "open" && !pr.draft;

  if (isReviewable) {
    if (mainSession.lifecycle.state !== "needs_review") {
      await persistLifecycleState(projectId, worktreeId, mainSession.id, "needs_review");
    }
    // A fresh reviewable PR on this branch is a new review cycle — any
    // earlier merge we remembered no longer applies.
    if (currentPrMergedAt != null) {
      await setWorktreePrMergedAt(projectId, worktreeId, null);
    }
    return;
  }

  // PR merged/closed/gone — only act if WE are the one holding this session
  // in needs_review; anything else (done/exited, handled above) wins as-is.
  if (mainSession.lifecycle.state === "needs_review") {
    // Distinguish "merged" (worth remembering — dashboard-bucket-fixes) from
    // "closed without merging" / "gone entirely": only a genuine merge sets
    // prMergedAt. `pr` can be null here (PR deleted/branch gone).
    if (pr?.merged && currentPrMergedAt == null) {
      await setWorktreePrMergedAt(projectId, worktreeId, new Date().toISOString());
    }
    await persistLifecycleState(projectId, worktreeId, mainSession.id, fallbackStateFor(mainSession));
  }
}

/** Exported for deterministic daemon tests (single poll tick). */
export async function pollAllPrs(): Promise<void> {
  const projects = getAllProjects();

  // 1b.4 — warn once, only when it's actually going to matter (more than one
  // worktree means we're already past the point a single continuously-polled
  // worktree already exhausts the unauthenticated rate limit — see Decision 3b).
  const worktreeCount = projects.reduce((n, p) => n + p.worktrees.length, 0);
  if (!warnedNoToken && !hasGithubToken() && worktreeCount > 1) {
    warnedNoToken = true;
    console.warn(
      `[prPoller] No GITHUB_TOKEN/GH_TOKEN set — polling ${worktreeCount} worktrees for PR status ` +
        `against the unauthenticated GitHub rate limit (60 req/hr). Set GITHUB_TOKEN to avoid rate-limiting.`,
    );
  }

  await Promise.all(
    projects.flatMap((project) =>
      project.worktrees.map((worktree) => {
        const mainSession = worktree.sessions.find((s) => s.isMain);
        return pollWorktree(
          project.id,
          project.absolutePath,
          worktree.id,
          worktree.branch,
          mainSession,
          worktree.prMergedAt,
        ).catch((err) => {
          console.error(`[prPoller] Poll error for worktree ${worktree.id}:`, err);
        });
      }),
    ),
  );
}

export function startPrPoller(): void {
  if (pollerHandle) return;
  // Overlap guard — same rationale as lifecycle.ts's poller: a slow tick
  // (many worktrees, slow GitHub API) must not stack on the next one.
  let inFlight = false;
  pollerHandle = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void pollAllPrs().finally(() => {
      inFlight = false;
    });
  }, PR_POLL_INTERVAL_MS);
  if (typeof pollerHandle === "object" && "unref" in pollerHandle) {
    (pollerHandle as { unref(): void }).unref();
  }
}

export function stopPrPoller(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}

/** Test helper — resets the once-per-lifetime token warning. */
export function _resetPrPollerWarningForTest(): void {
  warnedNoToken = false;
}
