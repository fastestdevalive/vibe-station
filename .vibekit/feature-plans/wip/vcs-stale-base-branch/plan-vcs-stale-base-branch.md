<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: VCS tab — fetch base branch on demand instead of using a stale local ref

> Single follow-up bug, found while live-diagnosing the `console-home` project's `ch-64` worktree
> right after shipping `vcs-canvas-ux-fixes`. Not a regression from that change — a pre-existing
> gap the new "Diff from main" toggle made newly visible.

**Issue:** vcs-stale-base-branch
**Branch:** `vcs-pr-main` (current worktree branch)
**Status:** planned
**PRD:** none — single bug, skipped
**Parent:** none (follow-up to `vcs-canvas-ux-fixes`, commit `16bc635`)

**Reference files:**
- `daemon/src/services/git.ts:148-172` — `resolveBaseSha()`
- `daemon/src/services/git.ts` — `fetchOrigin(repoPath, ref)`, best-effort, already swallows errors
- `daemon/src/routes/worktrees.ts:392-395` — the ONLY existing `fetchOrigin` call site (worktree creation, first-time-only)
- `daemon/src/routes/worktrees.ts:1135-1152` — `GET /worktrees/:id/commits` (what `VcsPanel.tsx` calls)

---

## Problem

- Live-diagnosed on `console-home`'s `ch-64` worktree: local `main` ref last updated 2026-08-17;
  `origin/main` (freshly fetched) at 2026-08-20 with 11 more commits landed in between
- `merge-base(HEAD, local main)` → 13 "unique to branch" commits; `merge-base(HEAD, origin/main)` → 2
  (matches the real PR diff)
- `fetchOrigin()` is only ever called once, at worktree-creation time, and only if the local branch
  doesn't exist yet at all (`worktrees.ts:392-395`) — after that the local `baseBranch` ref is never
  refreshed, so it silently drifts further behind actual GitHub `main` for as long as the daemon runs
- The VCS tab's commit list, the "Diff from main" toggle, and `/changed-paths?scope=branch` are all
  downstream of `resolveBaseSha()`, so all inherit this staleness

## Out of Scope (per explicit user direction)

- **No periodic/background fetch** — user explicitly rejected this ("i think its better to do only
  when vcs tab is opened. no periodic stuff"). No `prPoller`-style interval, no cron
- Fixing `/worktrees/:id/diff/*` (line 988, file-diff view) — different UI surface, not the VCS tab;
  same underlying `resolveBaseSha` staleness bug, but out of scope here to keep this "very small"
- Fixing `/changed-paths` — not called by `VcsPanel.tsx` (a different feature calls it); same bug
  class, deliberately left for a separate pass if it turns out to matter there too

## Concept

- `GET /worktrees/:id/commits` (the only route `VcsPanel.tsx` hits for its base-branch-relative
  view) does a best-effort `fetchOrigin(project.absolutePath, worktree.baseBranch)` immediately
  before calling `resolveBaseSha` — runs exactly once per tab-open/refresh/load-more/toggle-driven
  request, never on a timer
- `fetchOrigin` only updates the `refs/remotes/origin/<baseBranch>` tracking ref (via plain
  `git fetch origin <ref>`) — it does NOT fast-forward the local `<baseBranch>` branch itself (which
  would fail anyway if that branch is checked out in the project's primary clone). So
  `resolveBaseSha` must also change: prefer `merge-base HEAD origin/<baseBranch>` when that ref
  resolves, falling back to the local `<baseBranch>` name (today's behavior) when it doesn't
  (no remote, fetch failed and no remote-tracking ref ever existed, etc.)
- `fetchOrigin` gets a bounded timeout so a network hiccup can't hang a VCS tab load — currently
  unbounded (`execFile` with no `timeout` option)

## Requirements

| # | Requirement |
|---|-------------|
| 1a | `GET /worktrees/:id/commits` calls `fetchOrigin(project.absolutePath, worktree.baseBranch)` before `resolveBaseSha`, best-effort (errors swallowed, request proceeds regardless) |
| 1b | The fetch has a bounded timeout (~8s) — a hung/slow network must not hang the whole `/commits` response; on timeout, proceed with whatever local refs already exist |
| 2a | `resolveBaseSha(repoPath, baseBranch, fallbackBaseSha)`: when `origin/<baseBranch>` resolves, use `merge-base HEAD origin/<baseBranch>` |
| 2b | `resolveBaseSha`: when `origin/<baseBranch>` does NOT resolve (no remote, never fetched, local-only project), fall back to today's `merge-base HEAD <baseBranch>` (local ref) — unchanged behavior for local-only/no-remote projects |
| 2c | Existing `fallbackBaseSha` (cached `worktree.baseSha`) fallback, for when BOTH of the above fail, is unchanged |
| 3a | No new periodic job, interval, or cron — the fetch only ever runs inside the `/commits` request handler |
| 3b | `/worktrees/:id/pr`, `/worktrees/:id/diff/*`, `/worktrees/:id/changed-paths` are NOT touched by this plan (Out of Scope) |

---

## Research

### `fetchOrigin` already exists and is already best-effort
- `daemon/src/services/git.ts` — `fetchOrigin(repoPath, ref)`: `git fetch origin <ref>`, try/catch swallows all errors, callers already treat it as best-effort. Reused as-is; only the call site and a timeout are new.

### `git fetch origin main:main` would fail
- The project's primary clone (`project.absolutePath`) typically still has `main` checked out (worktrees are separate checkouts on separate branches) — git refuses to fetch directly into a checked-out branch ref. Fetching into the remote-tracking ref (`origin/main`) via plain `git fetch origin main` sidesteps this entirely and is the standard-safe approach.
- Remote-tracking refs live in the shared `.git` dir, visible from every worktree of the same repo — so fetching once in `project.absolutePath` makes `origin/<baseBranch>` immediately resolvable from `wtPath` (the worktree calling `resolveBaseSha`) too.

### No timeout on `execFile` today
- `daemon/src/services/git.ts`'s `runGit()` calls `execFile` with no `timeout` option — unbounded. A hung SSH/network fetch would hang the whole `/commits` response. Needs an explicit timeout, scoped to the fetch call only (not a blanket change to every `runGit` caller).

## Root Cause

- `fetchOrigin` was correctly written as best-effort/non-fatal, but its only call site was designed
  for the one-time "does this branch exist locally yet" case at worktree creation — nobody wired a
  second call site for "keep this fresh while the tab is actually being looked at"

---

## Risks / Open Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Does fetching on every `/commits` call (including "Load more" pagination) add noticeable latency? | Accepted — user-driven, bounded by the new timeout, and it's exactly the "only when the tab is open" behavior requested. Not fetching on every request risks staleness creeping back in between the first load and a later "Load more"/refresh |
| 2 | Could the timeout make `resolveBaseSha` silently regress to stale data indefinitely on a flaky network? | Yes, by design — best-effort was the existing contract for `fetchOrigin`; a hard-fail-the-request behavior was rejected as worse UX than "occasionally still a bit stale" |

---

## Implementation Phases

### Phase 1 — fetch-on-demand + resolveBaseSha origin-preference

- [x] **1.1** `daemon/src/services/git.ts`: add a bounded timeout to `fetchOrigin`'s underlying `execFile` call (~8s), scoped to this call only
- [x] **1.2** `daemon/src/services/git.ts`: `resolveBaseSha` tries `merge-base HEAD origin/<baseBranch>` first (when it resolves), falls back to local `<baseBranch>`, falls back to `fallbackBaseSha` — same overall fallback shape, new preferred first branch. **Revised after opus review**: when BOTH origin and local refs resolve, compares both merge-bases via `git merge-base --is-ancestor` and picks whichever is more-advanced, instead of blindly preferring origin (a blind preference regressed the case where local is ahead of origin)
- [x] **1.3** `daemon/src/routes/worktrees.ts`: `GET /worktrees/:id/commits` calls `fetchOrigin(project.absolutePath, worktree.baseBranch)` before `resolveBaseSha`, best-effort (don't fail the request if it throws/times out); logs the swallowed error at debug level
- [x] **1.4** Unit tests: `resolveBaseSha` prefers `origin/<baseBranch>` when present (tmp repo with a fake "origin" remote and a manually-advanced `origin/main` ref vs. a stale local `main`); falls back correctly when no `origin/<baseBranch>` exists; `fetchOrigin`'s timeout doesn't hang the test suite (optional `timeoutMs` param lets the test exercise the bound in ~300ms instead of the real 8s); regression test for local-ahead-of-origin added per review
- [x] **1.5** Route test: `/commits` triggers a fetch call (spy/mock) before computing `isOnBranch`; route still 200s when the fetch throws

**Verify phase 1:**
- [x] **1.T1** `pnpm --filter cli exec vitest run src/daemon/__tests__/git*.test.ts src/daemon/__tests__/worktrees.test.ts` — 77 tests pass
- [x] **1.T2** `pnpm typecheck` (repo-wide) clean
- [x] **1.T3** Docker sandbox (`scripts/dev-sandbox.sh up vs-52`, port 5174): built a purpose-made fixture (bare "origin" repo + a "clone" registered as the vst project, matching the real ch-64 mechanism exactly — a feature branch that merged a newer `origin/main` into itself, then the clone's local `main`/`origin/main` refs reset back to the pre-merge point to simulate "never fetched since project onboarding"). Buggy-code expectation (`HEAD..local main`): 8 "unique" commits. Hit `GET /worktrees/:id/commits` once — result: exactly 3 `isOnBranch:true` commits (2 own + the merge commit), matching the true diff against fresh `origin/main`. Confirmed via `git rev-parse origin/main` in the project's primary clone that the tracking ref itself moved from stale to fresh as a direct result of that one API call — proving the fetch is request-triggered, not periodic. Fixture torn down and project deregistered after verification.

### Phase 2 — review

- [x] **2.1** Opus reviewer pass on the diff — found 1 CONFIRMED (medium, the unconditional origin-preference regression), 1 CONFIRMED downstream consequence (out-of-scope routes inherit the behavior via shared `resolveBaseSha`, resolved by fixing the first), 1 CONFIRMED test-hygiene issue (leaked temp dir + 8s test), and 2 PLAUSIBLE issues (credential-prompt hang risk, orphaned grandchild processes) plus 1 observability nit
- [x] **2.2** Addressed: ancestry-aware origin/local comparison, `GIT_TERMINAL_PROMPT`/`GIT_SSH_COMMAND` env hardening, test fixture cleanup + `timeoutMs` param, debug logging on swallowed fetch errors. Deliberately deferred (per opus's own "cheap to fold in" vs. genuinely-lower-priority split, confirmed with the user's "very small" scope in mind): in-flight fetch dedupe for concurrent requests into the same primary clone, and `detached`+process-group-kill for orphaned grandchildren beyond the `BatchMode`/`ConnectTimeout` mitigation already applied

**Verify phase 2:**
- [x] **2.T1** No unresolved CONFIRMED findings — all 3 addressed; both PLAUSIBLE findings addressed (2 of them) or accepted as documented residual risk (in-flight dedupe race, rare)

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/services/git.ts` | Modified | 1 | `fetchOrigin` timeout; `resolveBaseSha` prefers `origin/<baseBranch>` |
| `daemon/src/routes/worktrees.ts` | Modified | 1 | `/commits` calls `fetchOrigin` before `resolveBaseSha` |
| `daemon/src/__tests__/git.commits.test.ts` or new file | Modified/New | 1 | Unit tests for the origin-preference + timeout behavior |
| `daemon/src/__tests__/worktrees.test.ts` | Modified | 1 | Route-level fetch-triggered test |

---

## Verification Method

- Node/vitest: targeted + repo-wide typecheck
- Docker: `scripts/dev-sandbox.sh up vs-52`, port 5174, simulate a stale-local-main scenario against a fake local "origin" remote (demo seed repos are local-only/no-remote, so this needs a purpose-built fixture, not the default seed)
- Reviewer: opus subagent, one pass on the complete diff
