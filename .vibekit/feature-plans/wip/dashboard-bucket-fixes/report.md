# /sdlc report — dashboard-bucket-fixes

**Scope:** small bug-fix bundle, no PRD. Investigated by an Opus subagent, then plan → implement.

## Issues

1. **Mixed-session worktree hides live activity.** A worktree with one `waiting_for_human`
   session and one genuinely `working` session didn't show under "Working" — confirmed as a
   rollup/ranking design issue, not a propagation bug: `worktreeRolledUpStatus` picks a single
   winning status per worktree by rank (`waiting_for_human`=8 beats `working`=6), which is correct
   for single-session displays (status dots, sidebar) but wrong for the dashboard's "is anything
   live here" bucket. Also found: archived sessions weren't excluded from bucketing, so a
   handed-off session stuck in `waiting_for_human` could poison a worktree's bucket too.
2. **Merging a PR silently loses the "PR created" signal.** `prPoller.ts` derives `needs_review`
   fresh every 60s tick and forgets it the instant the PR closes — a merged worktree looks
   identical to one that never had a PR. `PrInfo.merged` already carries the fact live but was
   discarded.

## What was implemented

- **Daemon** (`prPoller.ts` + a `pinnedAt`-style plumbing addition — `types.ts`, `dbSchema.ts`,
  `sqliteRowMappers.ts`, `project-store.ts`, `worktrees.ts`): a new `WorktreeRecord.prMergedAt`
  timestamp, set when the poller sees `pr.merged === true` while the session was `needs_review`
  (never on a plain close-without-merge), broadcast over the existing passthrough
  `worktree:updated` WS event (no protocol schema change needed). Cleared the moment a fresh
  open+non-draft PR appears on the same branch. SQLite migration is the existing
  `addColumnIfMissing` idempotent `ALTER TABLE` helper — verified against the live dev sandbox's
  pre-existing database, which booted and migrated cleanly.
- **Web-ui** (`DashboardPanel.tsx`): the bucket loop now (a) excludes archived sessions from the
  agent-session scan, (b) buckets a worktree as "Working" if ANY non-archived session is live
  `working`/`not_started`, taking priority over the single-winner rollup, and (c) buckets a
  worktree with `prMergedAt` set into "PR created" (unless something's actively working, which
  wins). `worktreeStatus.ts` and `StatusDot` are untouched — still correct for single-session
  displays elsewhere.

## Verification

- Daemon (`cli/` — `daemon/` is symlinked in): `npx vitest run` — **697/697 pass** (69 files),
  including 13/13 in `prPoller.test.ts` (10 pre-existing + 3 new: merge stamps `prMergedAt`,
  close-without-merge doesn't, a fresh PR clears a stale one). `tsc -b --noEmit` clean.
  One pre-existing flaky timing test (`handoff.test.ts`) failed once under parallel load and
  passed in isolation and on a full-suite rerun — confirmed unrelated to this change.
- Web-ui: `tsc -b --noEmit` clean, `npm run build` clean, `npx vitest run` — **406/406 pass**
  (60 files), including 2 new `DashboardPanel.test.tsx` cases (sibling-working overrides
  waiting_for_human; archived session excluded from bucketing).
- `npm run lint` (root, now runnable — installed root deps as a side effect) — 0 errors; fixed one
  unrelated warning (unused `tileMenuLabel`) left over from earlier work in `WorkspaceCanvas.tsx`.
- **Live-verified the risky part**: rebuilt and restarted the `vs-48` dev sandbox against its
  existing (pre-migration) SQLite database — daemon booted clean, no schema errors, dashboard
  rendered correctly with the new "Waiting for User" bucket. (Caught and reverted a near-miss
  mid-verification: ran `docker compose` directly without the per-worktree env vars first, which
  almost bound the shared `vst-dev-data`/`vst-dev-projects` volumes instead of `vst-dev-data-vs-48`
  — port conflict stopped it before any actual attach; no data was touched, redid it correctly via
  `scripts/dev-sandbox.sh`.)
- Not verified live: an actual GitHub PR merge (no live PR/GitHub token in this environment) — the
  daemon-side logic is covered by the mocked-`github.js` test harness already in place for
  `prPoller.ts`.

## Not committed yet

11 files changed (7 daemon, 4 web-ui) plus the plan/report — awaiting confirmation to commit and
push (single commit, per your earlier "separate commit in the same PR" preference, though this PR
is already merged — let me know if you want this on a fresh branch/PR instead).
