<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: VCS tab + sidebar/canvas session-lifecycle fixes

> Small bundle of 5 user-reported UX bugs. No new architecture — reuses existing patterns
> (`relinkSessionTiles`, `resolveBaseSha`/`isOnBranch`, GraphQL PR lookup) already in the codebase.

**Issue:** vcs-canvas-ux-fixes
**Branch:** `vcs-pr-main` (current worktree branch)
**Status:** planned
**PRD:** none — small bug bundle, skipped per user request (`/sdlc` "very small plan-implement-verify")
**Parent:** none

**Reference files:**
- `web-ui/src/components/tools/VcsPanel.tsx` — VCS tab commit list + PR banner
- `daemon/src/services/git.ts:148-390` — `resolveBaseSha`, `listCommits`/`isOnBranch` (already rebase-safe)
- `daemon/src/services/github.ts:291-320,442-570` — GraphQL PR lookup (`orderBy: CREATED_AT DESC, last: 1`)
- `daemon/src/services/prPoller.ts:59-118` — `nextPrStatus`, same-branch hold-forward on error
- `daemon/src/routes/worktrees.ts:1069-1149` — `/changed-paths`, `/commits`, `/pr` routes
- `web-ui/src/hooks/useStore.ts:342-410,757-783` — `removeTileFromCanvas`, `relinkSessionInCanvas`, `relinkSessionTiles` action (pattern to mirror)
- `web-ui/src/hooks/useStore.ts:563-598` — `setActiveWorktree` fallback chain (the sidebar bug)
- `web-ui/src/hooks/useServerSync.ts:162-163` — `session:deleted` handler (where tile cleanup hooks in)
- `web-ui/src/api/types.ts:68-74` — `SessionState` (`"exited"` is the terminal/dead state)

---

## Problem

| # | Symptom | Root cause found in Research |
|---|---------|-------------------------------|
| 1 | VCS tab shows more commits than the PR will contain after a rebase | Already fixed server-side (`isOnBranch` recomputed live via `merge-base`) — but the UI shows base-branch commits as a **collapsed group at the bottom** on first load, not an explicit **toggle at the top**, so it reads as "still broken" |
| 2 | A worktree's branch gets a second/different PR later — is it detected? | **Real bug, opus review caught it**: query is `orderBy: {field: CREATED_AT, direction: DESC}, last: 1` — in a GraphQL Relay connection, `orderBy` sorts the full list then `first`/`last` slice from front/back; DESC-sorted + `last: 1` takes the TAIL = the OLDEST PR ever opened for that branch, not the newest. A worktree whose branch previously had an old PR permanently shows that one; a later new PR is never surfaced. Fix is `first: 1` (keep DESC) |
| 3 | Worktree submodules' own commits/PRs aren't shown | Confirmed gap — no submodule detection anywhere in `daemon/src/services/git.ts` or worktree routes |
| 4 | Clicking a worktree whose last-known agent is terminated doesn't fall back to main | `setActiveWorktree` only checks the last session's **id** still exists in the list, never its `state` — a session stuck in `state: "exited"` (dies naturally, never explicitly deleted) still "wins" the fallback check |
| 5 | Terminated agent's canvas tile lingers | `session:deleted` handler (`useServerSync.ts:162`) only calls `applySessionDeleted` (removes from session list) — no code path removes the tile referencing that session from any canvas/workspace doc |

## Out of Scope

- Any new PR-fetch machinery for #2 — already correct, this plan only adds a regression test
- Submodule **PR** lookup (nested GitHub API calls per submodule) — #3 ships submodule commit/branch info only, no PR banner per submodule (real scope creep for a "very small" plan)
- Removing a tile on `session:exited` (natural death, not user-terminate) — a session can resume; only explicit deletion (`session:deleted`) removes its tile
- Rewriting the base/upstream split algorithm in `git.ts` — already rebase-safe, untouched

## Concept

- #1: Replace the bottom "Expand/Collapse commits from `<base>`" affordance with a top-of-panel toggle labeled `Diff from main` (or `Diff from {baseBranch}`), checked (ON) by default; ON = today's default filtered view (own commits only, `isOnBranch` split); OFF = full unfiltered list, inline, no grouping
- #2: One-token fix — `daemon/src/services/github.ts:315` `last: 1` → `first: 1` (keep `orderBy: CREATED_AT DESC`); add a `github.test.ts` case that asserts the outgoing GraphQL query string contains `first: 1` (locks in the correct slice direction — a test that only inspects the mocked response `nodes` array would pass under either `first`/`last` and wouldn't have caught this)
- #3: `listSubmodules(repoPath)` in `git.ts` (parses `.gitmodules` + `git submodule status --recursive`) → new route `GET /worktrees/:id/submodules` → small "Submodules" section under the commit list in `VcsPanel.tsx` (name, short sha, subject of the pinned commit, dirty/out-of-date badge from `git submodule status`'s leading char)
- #4: `setActiveWorktree`'s `lastInWorktree` check also requires `state !== "exited"` (mirror for the terminal fallback `lastTerm` too — same bug class)
- #5: New `removeTilesForSession(sessionId)` action in `useStore.ts` (mirrors `relinkSessionTiles`, uses `removeTileFromCanvas` instead of `relinkSessionInCanvas`), called from `useServerSync.ts`'s `session:deleted` handler right alongside `applySessionDeleted`

## Requirements

| # | Requirement |
|---|-------------|
| 1a | VCS panel renders a `Diff from {baseBranch}` checkbox/toggle at the top of the panel bar, checked by default |
| 1b | Toggle ON → commit list = today's `ownCommits` only (no upstream group) |
| 1c | Toggle OFF → commit list = full unfiltered `pageCommits`, inline (no grouping/accordion) |
| 1d | Toggling does not refetch from the server — pure client-side filter of already-fetched `commits` |
| 1e | `Commits (N)` header count reflects what's currently rendered: `ownCommits.length` when toggle ON, `pageCommits.length` when OFF |
| 1f | Clicking "Load more" while toggle is ON and the toggle is ON and it would produce **no visible change** (all of the newly loaded page is upstream) — auto-turns the toggle OFF (mirrors today's `setUpstreamOpen(true)` auto-expand-on-load-more behavior, adapted to the new toggle) |
| 1g | Toggle label falls back to `Diff from main` when `baseBranch` is unset (matches existing `"upstream branch"` fallback text's intent, using the more common default branch name) |
| 2a | Fix: `daemon/src/services/github.ts:315` GraphQL `pullRequests(...)` uses `first: 1` instead of `last: 1` |
| 2b | Regression test: branch with an old **closed** PR + a newer **open** PR for the same branch (2 nodes in the mocked GraphQL response, ordered as GitHub would return them — newest first per the query's DESC order) → lookup returns the open/newer one, AND the outgoing request body is asserted to contain `first: 1` |
| 3a | `listSubmodules()`: repo with no `.gitmodules` → `[]`, no throw |
| 3b | `listSubmodules()`: repo with 1+ **initialized** submodules → each entry has `path`, `sha`, `shortSha`, `branch` (from `.gitmodules`, may be `null`), `subject` (pinned commit's subject via `git -C <submodule-path> log -1 --format=%s`), `status: "clean" \| "modified" \| "out-of-date"` |
| 3c | `listSubmodules()`: **uninitialized** submodule (`-` prefix from `git submodule status`, no checked-out working tree) → `sha` present (the pinned sha, from the status line itself), `subject: null` (no local repo to read from), `status: "uninitialized"` |
| 3d | `listSubmodules()`: any `git submodule status`/`git` invocation failure (corrupted repo, git error) → `[]`, no throw — same fail-open contract as `listCommits`'s empty-repo case |
| 3e | `GET /worktrees/:id/submodules` (`:id` = worktree id, matching `/commits`/`/pr`'s existing convention): unknown worktree → 404; known worktree, no submodules → `200 { submodules: SubmoduleInfo[] }` (empty array) |
| 3f | VCS panel shows a "Submodules" section (only when non-empty) below the commit list, each row: path, short sha, subject (or "—" when null), status badge |

**API contract (`SubmoduleInfo`, shared type in `web-ui/src/api/types.ts` + daemon):**
```ts
interface SubmoduleInfo {
  path: string;
  sha: string | null;
  shortSha: string | null;
  branch: string | null;
  subject: string | null;
  status: "clean" | "modified" | "out-of-date" | "uninitialized";
}
// GET /worktrees/:id/submodules -> { submodules: SubmoduleInfo[] } | 404
```

**Explicitly out of scope (kept "very small"):** nested submodules-of-submodules (`--recursive` NOT used — top-level `.gitmodules` only, since nested paths can't map to a `.gitmodules` branch entry without recursive parsing); per-submodule PR lookup (already Out of Scope above); any timeout/cap beyond git's own — repo's submodule count is assumed small (single-digit) for this UI.
| 4a | `setActiveWorktree`: last-known agent session id that now has `state === "exited"` → falls through to `mainSlot` → `agents[0]` → `null`, same as if the id weren't found at all |
| 4b | Same fix applied to the terminal fallback (`lastTerm`/`defaultTerminalId`) — same bug class, same fallback shape |
| 4c | `archivedAt`/`supersededBy` sessions are explicitly NOT touched by this fix — they're a separate staleness class already handled by `relinkSessionTiles`'s chain-resolution (`resolveSupersededChains`); only the `state === "exited"` (naturally-dead, never explicitly handled) case is in scope here |
| 5a | `removeTilesForSession(sessionId)`: removes the tile from every worktree's `scratchCanvas` and every `workspaceDocs` entry that references it |
| 5b | `session:deleted` WS event → tile for that session disappears from any canvas/workspace it was placed in, without a page reload |
| 5c | `removeTilesForSession` returns the SAME store slice reference when nothing matched (mirrors `relinkSessionTiles`'s no-op shape) — no spurious re-render |
| 5d | `session:deleted` also clears `activeSessionId`/`activeTerminalSessionId` when they equal the deleted id, and deletes any `lastSessionByWorktree`/`lastTerminalByWorktree` entry pointing at it — same staleness class as #4, same event, cheap to fix alongside it |

---

## Research

### #1 — existing split is correct, only the presentation needs to move
- `web-ui/src/components/tools/VcsPanel.tsx:191-235` — `upstreamOpen` state (default `false`) + `ownCommits`/`upstreamCommits` split via `pageCommits.findIndex(c => !c.isOnBranch)`
- Reframe: keep the split memo, add a `diffFromMain` boolean (default `true`) that chooses which commits render — `true` → `ownCommits` grouping stays as today's default rendering path minus the "expand" affordance being reachable only after scrolling; `false` → render `pageCommits` flat
- Risk: LOW — pure presentational change, `isOnBranch` computation untouched

### #2 — GraphQL slice direction is backwards (real bug, found by opus plan review)
- `daemon/src/services/github.ts:315` — `pullRequests(headRefName: ..., last: 1, orderBy: {field: CREATED_AT, direction: DESC})`
- Relay connection semantics: `orderBy` sorts the full server-side list, THEN `first`/`last` slice from the front/back of that sorted list — `last: N` takes the LAST N of the DESC-sorted (newest-first) list, i.e. the OLDEST entries
- The doc comment at `github.ts:432-440` ("most recent PR") confirms `first: 1` was the intent — this is a genuine off-by-slice-direction bug, not intentional
- Existing `github.test.ts` mocks `fetch`'s JSON response directly (doesn't simulate real GitHub-side sorting/slicing) — a test that only checks the mocked `nodes` array would pass under either `first`/`last`, so the regression test must additionally assert the outgoing request body's query string contains `first: 1`
- Risk: LOW — one-token fix, well-isolated, existing test file to extend

### #3 — no existing submodule code
- `grep -rni submodule daemon/src` → no matches
- `git submodule status --recursive` output format: `[+| -|U]<sha> <path> (<describe>)` — leading char: ` ` clean, `+` modified/out-of-sync with index, `-` uninitialized, `U` merge conflict
- `.gitmodules` gives `path`→`branch` mapping (branch is optional per submodule)
- Risk: LOW-MEDIUM — new parsing code, needs a real nested-repo fixture in tests (`git submodule add` in a tmp repo)

### #4/#5 — both are narrow, mechanical fixes with an existing pattern to mirror
- #4: `web-ui/src/hooks/useStore.ts:573-579` — one added condition per fallback chain
- #5: `web-ui/src/hooks/useStore.ts:757-783` (`relinkSessionTiles`) is the exact shape to copy, swapping `relinkSessionInCanvas` for `removeTileFromCanvas` and dropping the `toSessionId` param
- Risk: LOW — both files already have unit test coverage (`useStore.test.ts`) to extend

## Root Cause

- #1: already functionally fixed by prior work (`3dae44a`) — user hadn't seen it / it doesn't match the expected UX shape (top toggle vs. bottom accordion)
- #2: real bug — GraphQL Relay `last`/`orderBy DESC` slice direction inverted, introduced when the PR lookup was built, never caught because most branches only ever have one PR
- #3: net-new feature, never built
- #4/#5: both are the same class of bug — a client-side reactive-sync gap where an event (session dies / session deleted) updates the `sessions` list but nothing reconciles the **derived** state (fallback selection, canvas tiles, active-session pointers) that referenced the old session

---

## Architecture Diagram

- Not applicable — no new services/processes; #3 adds one route + one service function following the exact shape of `/commits`+`listCommits`

## Design Details

- New API contract: `GET /worktrees/:id/submodules` → `{ submodules: SubmoduleInfo[] }` — see `SubmoduleInfo` shape under Requirement 3's contract block above; 404 on unknown worktree id, matching `/commits`/`/pr`'s existing convention
- No other new contracts — #4/#5 are client-only store fixes, #1 is client-only presentation, #2 is a one-token server-side fix with no contract shape change

---

## Risks / Open Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Should submodule PR lookup be included? | No — Out of Scope, would require nested owner/repo resolution per submodule; too large for "very small" |
| 2 | Should tile removal also fire on `session:exited` (not just `session:deleted`)? | No — a naturally-exited session can be resumed; only explicit deletion is a "this is gone" signal |

---

## Implementation Phases

- Each phase ends with a **`Verify phase N:`** block
- Screenshots: taken in the docker dev sandbox for #1, #3, #4, #5 (visual/interactive); #2 is test-only

### Phase 1 — VCS panel: diff-from-main toggle (#1)

- [x] **1.1** `VcsPanel.tsx`: add `diffFromMain` state (default `true`), render toggle in `.vcs-panel__bar`, wire rendering to it per Requirements 1a-1d, 1g
- [x] **1.2** Remove/replace the old bottom accordion group with the new top toggle (keep `ownCommits`/`upstreamCommits` split memo — just change what controls visibility and where the control lives)
- [x] **1.3** `Commits (N)` header count follows Requirement 1e
- [x] **1.4** `loadMore()`: when `diffFromMain` is ON and the newly loaded page adds zero `ownCommits`, auto-set `diffFromMain` to `false` instead of the old `setUpstreamOpen(true)` (Requirement 1f)
- [x] **1.5** Update/add tests in `web-ui/src/components/tools/*.test.tsx` (or new file) if a test harness for this component exists — otherwise cover via docker screenshot verification only

**Verify phase 1:**
- [x] **1.T1** `pnpm --filter @vibestation/web typecheck` clean
- [x] **1.T2** Docker sandbox (`scripts/dev-sandbox.sh up vs-52`, port 5174, demo seed): confirmed "Diff from main" toggle renders at the top of the VCS panel bar, checked by default; toggling on/off re-renders instantly with no extra network fetch. Demo repo's single-commit history didn't produce a visible upstream group to screenshot a content difference on — the own/upstream filtering itself is covered by `VcsPanel.test.tsx`'s new unit tests

### Phase 2 — PR re-latch fix + regression test (#2)

- [x] **2.1** `daemon/src/services/github.ts:315`: change `last: 1` → `first: 1` (keep `orderBy: CREATED_AT DESC`)
- [x] **2.2** Add a case to `daemon/src/__tests__/github.test.ts`: mock 2 PRs (older closed, newer open) for the same branch, assert `fetchPrForBranch` returns the newer/open one AND assert the outgoing request body contains `first: 1` (not `last: 1`) — this second assertion is the one that actually catches the bug being fixed

**Verify phase 2:**
- [x] **2.T1** `pnpm --filter cli exec vitest run src/daemon/__tests__/github.test.ts` — all pass, new case included, confirm it fails against the old `last: 1` code (sanity-check by temporarily reverting 2.1 — not committed)

### Phase 3 — Submodule detection + display (#3)

- [x] **3.1** `daemon/src/services/git.ts`: add `listSubmodules(repoPath)` — parse `.gitmodules`, run `git submodule status --recursive`, join into `SubmoduleInfo[]`
- [x] **3.2** `daemon/src/routes/worktrees.ts`: add `GET /worktrees/:id/submodules`
- [x] **3.3** `web-ui/src/api/types.ts` + `web-ui/src/api/client.ts`/`mock.ts`: add `SubmoduleInfo` type + `listSubmodules()` client method
- [x] **3.4** `VcsPanel.tsx`: fetch submodules alongside commits/PR, render "Submodules" section (Requirement 3d)
- [x] **3.5** New test file `daemon/src/__tests__/git.submodules.test.ts`: real tmp repo with `git submodule add` against a second tmp repo, cover Requirements 3a-3b

**Verify phase 3:**
- [x] **3.T1** `pnpm --filter cli exec vitest run src/daemon/__tests__/git.submodules.test.ts` — all pass
- [x] **3.T2** `pnpm --filter cli exec vitest run src/daemon/__tests__/worktrees.test.ts` — route test for 404 + empty-array case passes
- [x] **3.T3** Docker sandbox: confirmed `GET /worktrees/:id/submodules` returns `200 { submodules: [] }` live (network tab) and the empty case correctly renders no "Submodules" section (Requirement 3f). Demo seed repos have no actual submodules, so the populated-row rendering (path/sha/subject/status badge) wasn't screenshotted live — that path is covered by `VcsPanel.test.tsx`'s mocked-data unit tests plus `git.submodules.test.ts`'s real-tmp-repo `git submodule add` tests

### Phase 4 — Sidebar fallback fix (#4)

- [x] **4.1** `useStore.ts` `setActiveWorktree`: add `state !== "exited"` guard to both the agent (`lastInWorktree`) and terminal (`lastTerm`) fallback checks
- [x] **4.2** Extend `useStore.test.ts` (or add new test) covering: last-known agent exited → falls back to main; last-known agent still alive → still wins

**Verify phase 4:**
- [x] **4.T1** `pnpm --filter web-ui exec vitest run` (or targeted file) — new cases pass
- [x] **4.T2** Docker sandbox: terminated a worktree's non-main agent (Agent 2) from its canvas tile menu, navigated away to a different worktree and back — the worktree reopened cleanly showing main + Agent 1 tiles, no dead/exited session tile or blank pane. The exact race this fix targets (a `state:"exited"`-but-not-yet-deleted session id still in `lastSessionByWorktree`) is covered directly by `useStore.test.ts`'s new unit tests, since termination in this build fires `session:deleted` immediately (no live-reproducible gap between exited and deleted in the demo)

### Phase 5 — Canvas tile cleanup on session deletion (#5)

- [x] **5.1** `useStore.ts`: add `removeTilesForSession(sessionId)` action (mirrors `relinkSessionTiles`, Requirements 5a/5c)
- [x] **5.2** `useStore.ts`: extend (or add alongside) with the Requirement 5d cleanup — clear `activeSessionId`/`activeTerminalSessionId` and any `lastSessionByWorktree`/`lastTerminalByWorktree` entry equal to the deleted id
- [x] **5.3** `useServerSync.ts`: call both from the `session:deleted` handler (line ~162-163), alongside the existing `applySessionDeleted`
- [x] **5.4** Extend `useStore.test.ts` with unit tests for `removeTilesForSession` (canvas + workspace doc cases, no-op case) and the 5d pointer-clearing logic

**Verify phase 5:**
- [x] **5.T1** `pnpm --filter web-ui exec vitest run` (targeted) — new cases pass
- [x] **5.T2** Docker sandbox: opened the free-form canvas view (main + Agent 1 + Agent 2 + Terminal 1 + VCS tiles), terminated Agent 2 via its tile's "⋮ → Terminate" menu + confirm dialog — the Agent 2 tile disappeared from the canvas immediately, live, with no page reload. Confirmed via before/after screenshots

### Phase 6 — Full suite + typecheck + opus review

- [x] **6.1** `pnpm typecheck` (repo-wide) clean
- [x] **6.2** `pnpm --filter cli test` (761/761 passed; 1 pre-existing unrelated `UnhandledRejection` flake in `sessions.test.ts` flips pnpm's exit code — documented as predating this change in the prior `vcs-backend` plan too, reconfirmed here) and `pnpm --filter @vibestation/web test` (481/481 passed) — no regressions
- [x] **6.3** Opus reviewer pass on the full diff; found 3 CONFIRMED bugs (stale `pendingLoadMoreRef` misfiring the toggle, empty-state hiding the load-more/cap footer, stale submodules across worktree switch) + verified #2's GraphQL fix and #3's `runGitRaw` fix are correct; also flagged 4 PLAUSIBLE issues (unreachable `"modified"` status, `.gitmodules` parser edge cases, toggle not reset per-worktree, no active-session re-derivation on deletion) and cosmetic issues (undefined `--bg-tertiary` CSS var). All CONFIRMED + all PLAUSIBLE except the `.gitmodules` parser edge cases (deliberately deferred, low-likelihood for machine-written files) were fixed in a follow-up implementation pass; re-ran targeted + full suites after, all green

**Verify phase 6:**
- [x] **6.T1** All above green
- [x] **6.T2** Opus review: no unresolved CONFIRMED findings (all 3 fixed); 1 PLAUSIBLE finding (`.gitmodules` parser edge cases) knowingly deferred, documented above rather than silently dropped

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/src/components/tools/VcsPanel.tsx` | Modified | 1, 3 | Top diff-toggle; Submodules section |
| `daemon/src/__tests__/github.test.ts` | Modified | 2 | Newer-PR-wins regression case |
| `daemon/src/services/git.ts` | Modified | 3 | `listSubmodules()` |
| `daemon/src/routes/worktrees.ts` | Modified | 3 | `GET /worktrees/:id/submodules` |
| `web-ui/src/api/types.ts` | Modified | 3 | `SubmoduleInfo` type |
| `web-ui/src/api/client.ts`, `mock.ts` | Modified | 3 | `listSubmodules()` client method |
| `daemon/src/__tests__/git.submodules.test.ts` | New | 3 | Unit tests for `listSubmodules()` |
| `web-ui/src/hooks/useStore.ts` | Modified | 4, 5 | Fallback state guard; `removeTilesForSession` |
| `web-ui/src/hooks/useServerSync.ts` | Modified | 5 | Wire `removeTilesForSession` into `session:deleted` |
| `web-ui/src/hooks/useStore.test.ts` | Modified | 4, 5 | New unit tests |

---

## Verification Method

- Docker: `scripts/dev-sandbox.sh up` (default demo seed — worktrees/agents already present), used for phases 1, 3, 4, 5 interactive/visual verification
- Node/vitest: `pnpm typecheck`, `pnpm --filter cli test`, web-ui unit tests, for every phase's automated checks
- Reviewer: opus subagent, one pass on the complete diff after Phase 5, findings addressed before commit
