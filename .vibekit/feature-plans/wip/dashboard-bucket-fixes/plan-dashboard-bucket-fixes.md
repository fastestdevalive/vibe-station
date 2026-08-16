# Plan: dashboard-bucket-fixes

Small bug-fix bundle, no PRD. Found via investigation (opus subagent), see summary below.

## Scope

1. **Mixed-session worktree hides live "Working" activity.** A worktree with one `waiting_for_human`
   session and one genuinely `working` session doesn't show in the dashboard's "Working" bucket,
   because `worktreeRolledUpStatus` picks a single winner by rank (`waiting_for_human`=8 beats
   `working`=6). Also: archived sessions aren't excluded from the bucketing scan, so a handed-off/
   archived session stuck in `waiting_for_human` can poison a worktree's bucket too.
2. **Merging a PR silently loses the "this had a PR" signal.** `prPoller.ts`'s `fallbackStateFor()`
   reverts the session to `idle`/`working` on merge — indistinguishable from a worktree that never
   had a PR. Dashboard should keep showing "PR created" for a worktree whose PR merged, until a
   *new* reviewable PR appears on the same branch.

## Root causes / design (from investigation)

1. `web-ui/src/lib/worktreeStatus.ts`'s rank table and `worktreeRolledUpStatus` are correct AS
   WRITTEN — no propagation bug, no off-by-one. The issue is purely that `DashboardPanel.tsx`'s
   bucket loop (`web-ui/src/components/layout/DashboardPanel.tsx:96-112`) uses that single-winner
   rollup as-is for its Working/Waiting/PR/Finished split, when the "Working" bucket's actual intent
   ("is there live activity here right now") is better served by "ANY agent session live-working",
   not "the single highest-ranked session across the whole worktree". Fix is bucket-layer only —
   `worktreeStatus.ts`/`StatusDot` stay untouched (still correct for single-session displays: the
   worktree card's own status dot, sidebar rows, canvas tile borders).
2. "PR merged" is never persisted anywhere today — `prPoller.ts` derives `needs_review` fresh every
   60s tick and forgets it the instant the PR closes. `PrInfo.merged` (`daemon/src/services/
   github.ts:17-24`) already carries the fact live but it's discarded. Chosen fix (investigation's
   "Option 2", lowest risk): persist a small worktree-level `prMergedAt` timestamp, mirroring the
   existing `pinnedAt` field's exact plumbing (SQLite column + migration-safe `addColumnIfMissing`,
   row mapper, INSERT, WS broadcast via the existing passthrough `worktree:updated` event — no
   protocol schema change needed, `WorktreeUpdatedEvent.worktree` is `z.record(z.string(),
   z.unknown())`). No new `SessionState` value, no change to `needs_review`'s own lifecycle.

## Checklist

### Daemon (issue 2 — retain "PR created" through a merge)

- [x] 1. `daemon/src/types.ts`: add `prMergedAt?: string;` to `WorktreeRecord`, doc comment mirroring `pinnedAt`.
- [x] 2. `daemon/src/services/dbSchema.ts`: `addColumnIfMissing(db, "worktrees", "prMergedAt", "TEXT");`
- [x] 3. `daemon/src/state/sqliteRowMappers.ts`: add `prMergedAt: string | null` to `WorktreeRow`; `rowToWorktree`/`worktreeToRow` mirror `pinnedAt`'s present-if-non-null pattern.
- [x] 4. `daemon/src/state/project-store.ts`: add `prMergedAt` to the `INSERT INTO worktrees` column list + `VALUES` placeholder in `writeProjectFull`.
- [x] 5. `daemon/src/routes/worktrees.ts`: export `serializeWorktree`; add `prMergedAt: w.prMergedAt ?? null,`.
- [x] 6. `daemon/src/services/prPoller.ts`: `pollWorktree` gains a `currentPrMergedAt` param (passed from `pollAllPrs` as `worktree.prMergedAt`); add `setWorktreePrMergedAt(projectId, worktreeId, value)` helper (mutateProject + broadcastAll, mirrors the `/pin` route's pattern). On the reviewable branch, clear `prMergedAt` if set (new PR cycle). On the not-reviewable branch, if `pr?.merged === true` and `currentPrMergedAt == null`, set it to `new Date().toISOString()` before falling back to `working`/`idle`. A closed-without-merge or vanished PR must NOT set it.
- [x] 7. `daemon/src/__tests__/prPoller.test.ts`: new cases — merged PR sets `prMergedAt`; closed-without-merge does NOT; a fresh open+non-draft PR on the same branch clears a previously-set `prMergedAt`.

### Web-ui (both issues)

- [x] 8. `web-ui/src/api/types.ts`: add `prMergedAt: string | null;` to `Worktree`, doc comment mirroring `pinnedAt`.
- [x] 9. `web-ui/src/components/layout/DashboardPanel.tsx`:
  - Exclude `s.archivedAt != null` from the agent-session list used for bucketing (not just for `worktreeRolledUpStatus`'s own callers elsewhere — scoped to this component only).
  - Bucket a worktree into "Working" if ANY (non-archived) agent session's live state (`sessionStates[s.id] ?? s.state`) is `working` or `not_started`, taking priority over the rollup-driven bucket.
  - Bucket a worktree with `wt.prMergedAt` set into "PR created", taking priority over the session-state-driven bucket (but still losing to the "Working" check above — a worktree that's actively working again after merge should read as Working, not stuck showing a stale PR badge).
- [x] 10. `web-ui/src/components/layout/DashboardPanel.test.tsx`: new/updated cases for the "any session working" bucket rule and the archived-session exclusion. (`prMergedAt` daemon-persistence itself is covered by the daemon test above; the mock API's `Worktree` fixtures don't need a new PR-merge scenario for this small pass — the bucket-priority logic is a one-line conditional, verified by code review + the daemon-side test.)

## Verification

- Daemon: `npm test` (vitest) in `daemon/`, specifically `prPoller.test.ts`.
- Web-ui: `npx tsc -b --noEmit`, `npm run build`, `npx vitest run`.
- Manual: none available (no live daemon+GitHub in this environment) — daemon logic verified via the mocked `github.js` test harness already in place.
