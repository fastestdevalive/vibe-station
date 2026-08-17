/**
 * PR-status poller (pr-status-axis plan, Phase 2).
 *
 * Mirrors `lifecycle.ts`'s `pollAll`/`startLifecyclePoller`/`stopLifecyclePoller`
 * shape: one `setInterval`, one sweep per tick over every worktree, not one
 * timer per worktree.
 *
 * Ownership invariant (D5/D6): this poller writes **only** `SessionRecord.pr`
 * — the orthogonal VCS-outcome axis. It never touches `SessionLifecycle`
 * (agent-activity axis); `lifecycle.ts` is the sole writer of that. This is
 * what removes the three-writer clobber race that made PR detection
 * effectively dead (see
 * `.vibekit/reports/2026-08-16-pr-detection-broken-root-cause-and-fix.md`).
 *
 * Every tick batches ALL worktrees' branch lookups into a single
 * `fetchPrsForBranches` call (R3) rather than one call per worktree —
 * `fetchPrsForBranches` itself groups by GitHub account internally (one
 * aliased GraphQL query per account, K4).
 */

import { getAllProjects, updateSessionPr } from "../state/project-store.js";
import { getRemoteUrl, resolveGithubRemote, fetchPrsForBranches } from "./github.js";
import { listAccounts } from "./githubAuth.js";
import { broadcastAll } from "../broadcaster.js";
import type { PrInfo, PrLookupResult } from "./github.js";
import type { PrStatus, SessionRecord } from "../types.js";

/**
 * 10s (K8) — matches `github.ts`'s own 5s cache TTL closely enough that the
 * cache never defeats the interval, while staying well under the authed
 * GitHub rate limit (5,000 req/hr) given the batching above.
 */
export const PR_POLL_INTERVAL_MS = 10_000;

let pollerHandle: ReturnType<typeof setInterval> | null = null;

/** Warn once per daemon lifetime — not once per tick, not once per worktree. */
let warnedNoCredentials = false;

/** Warn at most once per 10 minutes, per error `reason`. */
const ERROR_WARN_THROTTLE_MS = 10 * 60 * 1000;
const lastErrorWarnAt = new Map<string, number>();

function classifyPrState(pr: PrInfo): PrStatus["state"] {
  if (pr.merged) return "merged";
  if (pr.draft) return "draft";
  if (pr.state === "closed") return "closed";
  return "open";
}

/**
 * Maps one `PrLookupResult` to the `SessionRecord.pr` write it produces, per
 * the plan's § System boundaries table. Returns `null` when nothing should be
 * written (not reached in practice here — `not_github`/no-remote worktrees
 * are filtered out before this is called — but kept total for safety).
 */
function nextPrStatus(
  current: PrStatus | undefined,
  lookup: PrLookupResult,
  now: string,
  branch: string,
): PrStatus | null {
  switch (lookup.kind) {
    case "pr": {
      const { pr } = lookup;
      return { state: classifyPrState(pr), number: pr.number, url: pr.url, checkedAt: now, prBranch: branch };
    }
    case "no_pr":
      return { state: "none", checkedAt: now, prBranch: branch };
    case "no_credentials": {
      if (!warnedNoCredentials) {
        warnedNoCredentials = true;
        console.warn(
          "[prPoller] No credentialed GitHub account found (env vars / ~/.config/gh/hosts.yml / gh CLI) " +
            "— PR status will not update until credentials are available.",
        );
      }
      return {
        state: current?.state ?? "none",
        ...(current?.number != null ? { number: current.number } : {}),
        ...(current?.url != null ? { url: current.url } : {}),
        checkedAt: now,
        error: "No credentialed GitHub account available",
        prBranch: branch,
      };
    }
    case "error": {
      const last = lastErrorWarnAt.get(lookup.reason) ?? 0;
      const nowMs = Date.now();
      if (nowMs - last >= ERROR_WARN_THROTTLE_MS) {
        lastErrorWarnAt.set(lookup.reason, nowMs);
        console.warn(`[prPoller] GitHub lookup failed (${lookup.reason}): ${lookup.message}`);
      }
      return {
        state: current?.state ?? "none",
        ...(current?.number != null ? { number: current.number } : {}),
        ...(current?.url != null ? { url: current.url } : {}),
        checkedAt: now,
        error: lookup.message,
        prBranch: branch,
      };
    }
    case "not_github":
      // Never reached — filtered out before the batch call — but stays a
      // no-op (untouched, no log, ever) if it ever is.
      return null;
  }
}

/** True iff `next` differs from `current` in nothing but `checkedAt` — B2:
 *  `checkedAt` changes every tick, so without this every tick is a "change"
 *  and there is no no-op case; skip the write AND the broadcast entirely in
 *  that case (an unwritten `checkedAt` just goes stale in the DB, which is
 *  the accepted tradeoff — see B2 in the pr-status-axis review). */
function prStatusEquivalent(current: PrStatus | undefined, next: PrStatus): boolean {
  if (!current) return false;
  return (
    current.state === next.state &&
    current.number === next.number &&
    current.url === next.url &&
    current.error === next.error &&
    current.prBranch === next.prBranch
  );
}

async function setSessionPr(projectId: string, sessionId: string, pr: PrStatus): Promise<void> {
  const changed = await updateSessionPr(projectId, sessionId, pr);
  if (!changed) return;
  broadcastAll({ type: "session:updated", sessionId, pr });
}

interface PollContext {
  projectId: string;
  worktreeId: string;
  session: SessionRecord;
  owner: string;
  repo: string;
  branch: string;
}

function entryKey(owner: string, repo: string, branch: string): string {
  return `${owner}/${repo}#${branch}`;
}

/** Exported for deterministic daemon tests (single poll tick). */
export async function pollAllPrs(): Promise<void> {
  const projects = getAllProjects();

  const contexts: PollContext[] = [];
  for (const project of projects) {
    if (project.worktrees.length === 0) continue;

    // B2: `getRemoteUrl`/`resolveGithubRemote` resolve a PER-PROJECT value
    // (the project's own `origin`, shared by every worktree in it) — calling
    // them once per worktree here used to mean 147 `git remote get-url`
    // child processes + 147 `~/.ssh/config` stats per tick on a real
    // install. Hoisted to once per project per tick.
    const remoteUrl = await getRemoteUrl(project.absolutePath);
    if (!remoteUrl) continue; // R9/C5 — no remote at all, zero network, zero logs.
    const gh = await resolveGithubRemote(remoteUrl);
    if (!gh) continue; // not_github — zero network, zero logs, ever.

    for (const worktree of project.worktrees) {
      const mainSession = worktree.sessions.find((s) => s.isMain);
      if (!mainSession) continue;

      contexts.push({
        projectId: project.id,
        worktreeId: worktree.id,
        session: mainSession,
        owner: gh.owner,
        repo: gh.repo,
        branch: worktree.branch,
      });
    }
  }

  if (contexts.length === 0) return;

  // R3 — exactly one batched call per tick, regardless of worktree count.
  const results = await fetchPrsForBranches(
    contexts.map((c) => ({ owner: c.owner, repo: c.repo, branch: c.branch })),
  );

  const now = new Date().toISOString();
  await Promise.all(
    contexts.map(async (c) => {
      const lookup = results.get(entryKey(c.owner, c.repo, c.branch));
      if (!lookup) return;
      const nextPr = nextPrStatus(c.session.pr, lookup, now, c.branch);
      if (!nextPr) return;
      // B2: nothing but `checkedAt` changed — skip the write AND the
      // broadcast entirely rather than doing a full DB write + a
      // `session:updated` broadcast (which the web-ui rebuilds its whole
      // `sessions` array in response to) every 10s for every worktree,
      // forever, even when the PR status genuinely hasn't changed.
      if (prStatusEquivalent(c.session.pr, nextPr)) return;
      try {
        await setSessionPr(c.projectId, c.session.id, nextPr);
      } catch (err) {
        console.error(`[prPoller] Failed to persist PR status for worktree ${c.worktreeId}:`, err);
      }
    }),
  );
}

/**
 * D10 startup self-check — logged once, at daemon boot, so a misconfigured
 * environment (no resolvable remote, no credentials) is visible immediately
 * rather than discovered by "PR status never updates" weeks later.
 */
async function logStartupSelfCheck(): Promise<void> {
  try {
    const projects = getAllProjects();
    const accounts = await listAccounts();
    const credentialSummary =
      accounts.length > 0
        ? `credentialed (${accounts.length} account${accounts.length === 1 ? "" : "s"}: ${accounts.map((a) => a.login).join(", ")})`
        : "no credentials found";

    for (const project of projects) {
      if (project.worktrees.length === 0) continue;
      const remoteUrl = await getRemoteUrl(project.absolutePath);
      const gh = remoteUrl ? await resolveGithubRemote(remoteUrl) : null;
      const remoteSummary = gh
        ? `resolvable (${gh.owner}/${gh.repo})`
        : remoteUrl
          ? "remote is not GitHub"
          : "no git remote";
      console.log(`[prPoller] startup check — project ${project.id}: ${remoteSummary}, ${credentialSummary}`);
    }
  } catch (err) {
    console.error("[prPoller] startup self-check failed:", err);
  }
}

export function startPrPoller(): void {
  if (pollerHandle) return;
  void logStartupSelfCheck();
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

/** Test helper — resets the once-per-lifetime credentials warning + error throttle. */
export function _resetPrPollerWarningForTest(): void {
  warnedNoCredentials = false;
  lastErrorWarnAt.clear();
}
