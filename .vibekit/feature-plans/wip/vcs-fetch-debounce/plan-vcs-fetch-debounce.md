<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: VCS tab — dedupe/debounce the on-demand `fetchOrigin` call, keep stale data visible while syncing

> Follow-up to `vcs-stale-base-branch` (PR #65, merged). That fix made `GET /worktrees/:id/commits`
> fetch `origin/<baseBranch>` on every request. This plan closes the gap the opus review on that PR
> flagged and deliberately deferred ("Finding 5" — concurrent fetches into the same repo racing) and
> adds the client-side "don't blank the list while refreshing" guarantee the user explicitly asked for.

**Issue:** vcs-fetch-debounce
**Branch:** `vcs-fetch-debounce` (fresh branch off `origin/main`, per lesson learned on PR #65 — do
not extend an already-merged branch, GitHub's rebase-merge recreates commit SHAs and reusing a
merged branch causes ghost "already merged" commits to reappear in the next PR's diff)
**PRD:** none — small, skipped
**Parent:** `vcs-stale-base-branch` (PR #65)

**Reference files:**
- `daemon/src/services/git.ts:291-337` — `fetchOrigin()`, the function being wrapped
- `daemon/src/routes/worktrees.ts` — `GET /worktrees/:id/commits`, the only call site
- `daemon/src/services/github.ts` — `CACHE_TTL_MS = 5_000` + `_clearPrCacheForTest()` — existing
  precedent in this codebase for a module-level TTL cache with a test-reset export; mirror this
  convention rather than inventing a new one
- `web-ui/src/components/tools/VcsPanel.tsx:220-380` — `loading`/`commits` state, `load()`

---

## Problem

- `GET /worktrees/:id/commits` calls `fetchOrigin(project.absolutePath, worktree.baseBranch)` on
  **every** request (mount, worktree switch, manual refresh, "Load more") — by design, per the user's
  explicit "only when the tab is open, no periodic stuff" direction in the parent plan
- Gap (opus review on PR #65, "Finding 5", deferred): rapid re-triggers — toggling between two
  worktrees of the same project, or just refreshing twice quickly — can run `git fetch origin <ref>`
  concurrently in the **same** primary-clone repo path. Git's own ref-lock contention makes one of
  the concurrent fetches fail (harmless here, swallowed), but it's wasted subprocess/network work,
  and at worst interacts badly with the ALSO-concurrent one-time fetch at worktree-creation time
  (`worktrees.ts:392-395`), which is not swallowed the same way (see that code's 400 error path)
- User's explicit new ask: (1) don't re-fetch if a fetch for the same repo+ref is already in flight —
  await the existing one instead of starting a second; (2) don't re-fetch again immediately after one
  just finished (debounce a rapid toggle); (3) confirm the UI shows the previous commit list while a
  refresh is in flight, not a blank/loading state, with some visible "still syncing" affordance

## Out of Scope

- Any change to the `/pr`, `/diff/*`, `/changed-paths` routes — still untouched, per the parent plan
- No periodic/background fetch — still explicitly rejected, this is purely dedupe/debounce of the
  existing on-demand behavior, not a new trigger
- No cross-process dedupe (e.g. via the DB/file lock) — this daemon is a single Node process per
  install, an in-memory `Map` is sufficient

## Concept

- `fetchOrigin()` gains an internal in-flight dedupe: concurrent callers for the same
  `(repoPath, ref)` key share ONE underlying `git fetch` call/promise instead of each starting their
  own
- `fetchOrigin()` also gains a short post-completion cooldown (mirrors `github.ts`'s existing
  `CACHE_TTL_MS = 5_000` precedent and its `_clearPrCacheForTest()` reset-export convention): a call
  for the same key within the cooldown window of the previous call's completion resolves immediately
  without spawning a new `git fetch` at all
- Client-side: confirm (and if needed, strengthen) that `VcsPanel.tsx` never clears `commits` while a
  refetch is in flight — the existing `loading` state already gates a spinning refresh icon, not a
  full-list blank-out, but add an explicit small "syncing" indicator so the in-flight state is visibly
  distinct from "idle up to date", not just inferred from the icon's spin animation

## Requirements

| # | Requirement |
|---|-------------|
| 1a | Two `fetchOrigin(repoPath, ref)` calls for the SAME `(repoPath, ref)` pair, started concurrently, result in exactly ONE `git fetch` subprocess — the second caller's promise resolves from the first's result |
| 1b | A `fetchOrigin(repoPath, ref)` call for a DIFFERENT `repoPath` or DIFFERENT `ref` is NOT deduped against an in-flight call for another key — keys are independent |
| 1c | After a fetch for `(repoPath, ref)` completes (success OR swallowed failure), a subsequent call for the same key within a short cooldown window (mirror the existing `CACHE_TTL_MS = 5_000` constant/value used elsewhere in this codebase) resolves immediately with no new subprocess |
| 1d | After the cooldown window elapses, a new call for the same key performs a real fetch again — this is NOT a permanent cache, just a debounce |
| 1e | A test-reset export (`_clearFetchOriginStateForTest()` or similarly named, matching the `_clearPrCacheForTest()`/`_clearStoreForTest()` naming convention already used in this codebase) clears both the in-flight map and the cooldown timestamps |
| 1f | `resolveBaseSha`'s correctness (ancestry-aware origin-vs-local comparison, shipped in PR #65) is completely unaffected — this plan only changes WHEN/HOW OFTEN the underlying fetch subprocess runs, never what `resolveBaseSha` does with the resulting refs |
| 2a | `VcsPanel.tsx`: while a refresh/reload is in flight (`loading === true`) AND there is already a previously-loaded commit list (`commits != null`), the existing commit list stays rendered — no blank/"Loading commits…" state |
| 2b | A visible, non-blocking "syncing" indicator is shown during that in-flight state (distinct from the bare spinning refresh icon already present) — e.g. a small inline label or subtle progress affordance near the panel bar — and disappears when the load resolves |
| 2c | The "Loading commits…" full-blank state remains ONLY for the true first-ever load of a worktree (`commits === null`) — unchanged from today |

---

## Research

### Existing TTL-cache + test-reset precedent in this codebase
- `daemon/src/services/github.ts`: `CACHE_TTL_MS = 5_000`, module-level `Map`, `_clearPrCacheForTest()` exported for test isolation — this plan's `fetchOrigin` cooldown should look and feel like this, not invent a new shape
- Risk: LOW — mechanical mirroring of an existing, already-reviewed pattern

### `VcsPanel.tsx` already mostly satisfies 2a
- `commits` state is `CommitLogEntry[] | null`, only ever set via `setCommits(list)` on a successful fetch — a refresh's `mode === "initial"` path does NOT null it out first, so the previous list survives visually during a refetch already
- What's missing is 2b — the only in-flight signal today is the refresh button's spin animation on its icon, easy to miss, not a real "syncing" affordance
- Risk: LOW — additive UI change, no restructuring of the existing load/render logic

## Root Cause

- The parent plan (`vcs-stale-base-branch`) correctly implemented "fetch on demand, no periodic job,"
  but didn't defend against the same demand arriving concurrently/rapidly from the UI — a gap flagged
  in its own opus review and knowingly deferred as out of scope for that "very small" pass

---

## Implementation Phases

### Phase 1 — in-flight dedupe + debounce cooldown (daemon)

- [x] **1.1** `daemon/src/services/git.ts`: add in-flight `Map<string, Promise<void>>` dedupe to `fetchOrigin`, keyed by `${repoPath}::${ref}`
- [x] **1.2** Add a cooldown `Map<string, number>` (last-completed timestamp) with the same TTL value as `github.ts`'s `CACHE_TTL_MS` (5000ms) — a call within the window after the previous call's completion resolves immediately, no subprocess. **Revised after opus review**: the cooldown is stamped only on a SUCCESSFUL fetch, not on a swallowed failure — a failed fetch (e.g. transient network blip) must not block a subsequent real attempt within the window, since that could otherwise cause a spurious 400 on worktree creation if it lands right after a failed VCS-tab fetch for the same branch
- [x] **1.3** Export `_clearFetchOriginStateForTest()` clearing both maps
- [x] **1.4** Unit tests: concurrent calls for the same key → one subprocess (via the existing PATH-shadowed fake-git test pattern, extended with a counter file); different keys → independent; within-cooldown same-key call → no subprocess; after-cooldown same-key call → new subprocess; **added per review**: a failing fetch still clears the in-flight map and does NOT enter cooldown; `_clearFetchOriginStateForTest()` actually restores real-fetch behavior

**Verify phase 1:**
- [x] **1.T1** `pnpm --filter cli exec vitest run src/daemon/__tests__/git.fetchOrigin.test.ts src/daemon/__tests__/git.resolveBaseSha.test.ts src/daemon/__tests__/worktrees.test.ts` — 66 tests pass
- [x] **1.T2** `pnpm typecheck` (repo-wide) clean

### Phase 2 — keep stale data visible + visible syncing indicator (web-ui)

- [x] **2.1** `VcsPanel.tsx`: confirmed Requirement 2a already held (verified by reading the code, not assumed) — but review found a related gap: switching WORKTREES (not refreshing the same one) showed the PREVIOUS worktree's stale commits captioned "Syncing…", which is actively misleading. Fixed: `setCommits(null)` added to the worktree-change effect only, not to manual refresh/load-more
- [x] **2.2** Added a "syncing" indicator shown when `loading && commits != null` (Requirement 2b), separate from the "Loading commits…" empty-state (Requirement 2c, unchanged). **Revised after opus review**: rendered unconditionally (not conditionally mounted) with `aria-live="polite"` for reliable screen-reader announcement (matches `TerminalPane.tsx`/`ConnectionStatus.tsx` convention), positioned after the refresh button with reserved width so it doesn't shift layout on every refresh
- [x] **2.3** Extended `VcsPanel.test.tsx` covering 2a/2b/2c, plus a negative test (review-requested) pinning that "Load more" does NOT show the syncing indicator (separate `loadingMore` state)

**Verify phase 2:**
- [x] **2.T1** `pnpm --filter @vibestation/web exec vitest run src/components/tools/VcsPanel.test.tsx` — 19 tests pass
- [x] **2.T2** `pnpm typecheck` (repo-wide) clean

### Phase 3 — review + docker verify

- [x] **3.1** Opus reviewer pass on the full diff — verified dedupe race-safety, cleanup-on-error, cooldown/dedupe interaction, key-collision-freedom, and mutation-tested the counter-file tests (confirmed they fail without the fix) all CORRECT; found 1 real bug (cooldown-on-failure poisoning worktree creation, see 1.2) plus 6 smaller findings (a11y live-region mounting, stale cross-worktree display, layout shift, 2 doc-comment gaps, 3 missing test cases, 1 nit)
- [x] **3.2** All findings addressed in a follow-up implementation pass (see revised notes on 1.2, 2.1, 2.2 above); doc comments added to `fetchOrigin` (deduped caller's own `timeoutMs` is ignored) and to the two module-level maps (intentionally unbounded for the daemon's lifetime, matching the `github.ts` PR-cache precedent); PATH-restore nit in `git.fetchOrigin.test.ts` guarded against `undefined`
- [x] **3.3** Docker sandbox (`scripts/dev-sandbox.sh up vs-52`, port 5180 — 5174 was held by another process on this host): rebuilt the same stale-vs-fresh fixture technique from `vcs-stale-base-branch`'s verification (true diff = 3, stale-local diff = 6), fired 3 concurrent `GET /commits` requests via parallel `curl` — all 3 returned the correct `isOnBranch` count (3) with no errors, confirming end-to-end correctness under concurrent access. Subprocess-count proof itself (exactly one `git fetch` for N concurrent callers) is NOT independently re-verified black-box in this pass — the fixture's origin is a local bare repo (fetch is near-instant either way, so timing can't distinguish deduped-vs-not), and re-instrumenting the running daemon's `git` binary mid-container wasn't practical without a restart. That exact claim is proven directly and rigorously by the Phase 1 unit tests instead, which opus mutation-tested (confirmed to fail — count 2 instead of 1 — with the dedupe/cooldown logic disabled)

**Verify phase 3:**
- [x] **3.T1** No unresolved CONFIRMED findings — all addressed
- [x] **3.T2** Full repo-wide `pnpm typecheck` clean; `pnpm --filter cli test` 776/776 assertions pass (1 pre-existing, documented, unrelated flake flips exit code); `pnpm --filter @vibestation/web test` 484/484 pass

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/services/git.ts` | Modified | 1 | `fetchOrigin` in-flight dedupe + cooldown |
| `daemon/src/__tests__/git.fetchOrigin.test.ts` | Modified | 1 | Dedupe/cooldown tests |
| `web-ui/src/components/tools/VcsPanel.tsx` | Modified | 2 | Syncing indicator, stale-data-stays-visible confirmation |
| `web-ui/src/components/tools/VcsPanel.test.tsx` | Modified | 2 | New coverage |

---

## Verification Method

- Node/vitest: targeted + repo-wide typecheck, both packages' full suites
- Docker: `scripts/dev-sandbox.sh up vs-52`, concurrent-request fixture reusing the prior plan's
  stale-vs-fresh setup technique
- Reviewer: opus subagent, one pass on the complete diff
