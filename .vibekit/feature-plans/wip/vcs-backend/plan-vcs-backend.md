<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: VCS tool tab backend — test coverage + polish

> Close the test-coverage gap on the already-implemented VCS tab backend (commit graph + PR banner). No new behavior — this is a "small" plan per user request.

**Issue:** vcs-backend
**Branch:** `lot-times-see` (current worktree branch)
**Status:** Implemented, opus-reviewed, review findings addressed — see Review Findings Addressed below
**PRD:** none — small, test-only follow-up to already-shipped behavior, skipped per user request (`/sdlc plan-implement`)
**Parent:** none

**Reference files:**
- `daemon/src/services/git.ts:180-311` — `CommitLogEntry`, `listCommits()`, `attachFullBodies()` (already implemented, commit `7479886`)
- `daemon/src/services/github.ts` — `getRemoteUrl()`, `parseGithubRepo()`, `fetchPrForBranch()` (already implemented)
- `daemon/src/routes/worktrees.ts:1090-1127` — `GET /worktrees/:id/commits`, `GET /worktrees/:id/pr` (already implemented)
- `daemon/src/__tests__/worktrees.test.ts` — existing route-test conventions to follow; `createWorktree()` helper (line 632) is scoped *inside* the `describe("PATCH /worktrees/:id/pin", ...)` block (line 631), not file-level — new tests add their own local helper (or a top-level `describe("GET /worktrees/:id/commits and /pr", ...)` with its own) rather than importing that one across describe blocks
- `cli/vitest.config.ts:5` — `preserveSymlinks: true`; `cli/src/daemon` is a symlink to `../../daemon/src`, so vitest resolves daemon test files under `src/daemon/__tests__/`, not `daemon/src/__tests__/`

---

## Problem

- `listCommits()`, `attachFullBodies()`, `getRemoteUrl()`, `parseGithubRepo()`, `fetchPrForBranch()`, and the two new routes have zero automated test coverage
- Several edge cases were exercised manually during implementation (empty repo, binary diff, multi-line body, real GitHub PR lookup) but aren't codified as tests

## Out of Scope

- Any change to already-implemented, already-committed behavior (`git.ts`, `github.ts`, `worktrees.ts` routes, all of `web-ui/src`) — touch only if a new test surfaces a real bug
- New markdown docs — `GITHUB_TOKEN`/`GH_TOKEN` already has a one-line mention in `github.ts`'s own JSDoc at the point of use; no dedicated env-var reference doc exists in this repo to extend (checked in Research), so nothing new is added
- Rate-limit/backoff hardening, GitHub Enterprise / GitLab support, `gh` CLI fallback — none requested

## Concept

- Two new test files, written against the real on-disk location (`daemon/src/__tests__/`, resolved by vitest via the `cli/src/daemon` symlink): `git.commits.test.ts` (unit, real tmp git repos via `execSync`, no server) and `github.test.ts` (unit, mix of a real tmp repo for `getRemoteUrl` + `vi.stubGlobal("fetch", ...)` for `fetchPrForBranch`)
- Extend `daemon/src/__tests__/worktrees.test.ts` with route-level cases for `/commits` and `/pr`, matching its existing `app.inject` + `createWorktree()` fixture pattern
- Success state: `pnpm --filter cli test` green, every Requirement below has a corresponding assertion

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `listCommits()`: empty repo (no commits) → `[]`, no throw |
| 2 | `listCommits()`: binary-file commit → `hasBinaryChanges: true`, that file excluded from insertions/deletions sum |
| 3a | `listCommits()`: a commit **subject** line (the only thing `--numstat`'s parser ever sees per Research) containing an embedded tab and numstat-shaped text does not corrupt parsing of that commit or a following commit's numstat block |
| 3b | `attachFullBodies()`: a multi-paragraph commit **body** (`%B`, separate `git log` call, no `--numstat` involved) round-trips intact, including embedded newlines |
| 4 | `listCommits()`: commit with no body → `body === subject` |
| 5 | `parseGithubRepo()`: accepts `git@github.com:owner/repo.git`, `https://github.com/owner/repo.git`, `https://github.com/owner/repo` (no `.git`); rejects a non-GitHub remote (e.g. GitLab) → `null` |
| 6 | `getRemoteUrl()`: repo with no `origin` remote → `null`, no throw |
| 7 | `fetchPrForBranch()`: GitHub API error/non-200/network failure → `null`, no throw (mock `fetch`) |
| 8 | `fetchPrForBranch()`: successful response with a matching PR → parsed `PrInfo` (number/url/title/state/merged/draft/author) |
| 9 | `GET /worktrees/:id/commits`: unknown worktree → 404 |
| 10 | `GET /worktrees/:id/pr`: unknown worktree → 404; known worktree whose **project repo** has no `origin` remote → `200 { pr: null }` |
| 11 | `GET /worktrees/:id/commits`: worktree with a file committed inside it (beyond the fixture's initial empty commit) → 200, entry with non-zero `insertions` |

---

## Research

### Existing route-test harness

- **File:** `daemon/src/__tests__/worktrees.test.ts:1-95` — `vi.mock("../services/paths.js", ...)` redirects all daemon state under a `mkdtemp` tempDir; `beforeEach` creates a real git repo via `execSync("git init ...")`, boots `buildServer()`, registers a project via `app.inject POST /projects`
- **File:** `daemon/src/__tests__/worktrees.test.ts:631-638` — existing `createWorktree(branchSuffix)` helper wraps `POST /worktrees`, but is scoped inside the `PATCH /worktrees/:id/pin` describe block; new route tests write their own local equivalent in a new `describe` block rather than reaching across blocks
- **Risk:** LOW — new route tests append to this file using the same fixture; no new harness needed

### vitest resolves daemon tests through the `cli/src/daemon` symlink, not the `daemon/` dir directly

- **File:** `cli/vitest.config.ts:5` — `preserveSymlinks: true`
- **Confirmed empirically:** `vitest list --filesOnly src/__tests__/worktrees.test.ts` → no match; `vitest list --filesOnly src/daemon/__tests__/worktrees.test.ts` → matches
- **Decision:** every `Verify phase N:` command below runs vitest against `src/daemon/__tests__/<file>`, even though the files are edited at their canonical path `daemon/src/__tests__/<file>` (same inode, see Files & Phase Impact)

### No existing git.ts/github.ts unit test file

- **File:** `daemon/src/__tests__/` — grepped for `git.test.ts`/`github.test.ts`, none exist; `git.ts` functions are today only exercised indirectly through route tests
- **Decision:** new unit test files call `listCommits`/`getRemoteUrl`/`parseGithubRepo`/`fetchPrForBranch` directly against a `mkdtemp` repo (via `execSync`), no Fastify server needed

### `listCommits`'s numstat parser only ever sees the subject line, never the body

- **File:** `daemon/src/services/git.ts:214-221` — the `--numstat` `git log` call formats each commit header with `%s` (subject only), never `%B`/`%b` — so a commit's body text physically cannot reach this parser
- **File:** `daemon/src/services/git.ts:277-311` — `attachFullBodies()` is a *second*, separate `git log` call (no `--numstat`) that fetches `%B` and splits only on the RS/US bytes, never on `"\n"`
- **Implication:** Requirement 3's original framing ("a numstat-shaped body line") was untestable — split into 3a (adversarial **subject**, the thing the numstat parser actually processes) and 3b (adversarial **body**, round-tripped by the unrelated second call)
- **Risk:** LOW — the two-call split already structurally prevents this bug class; 3a/3b are regression guards

## Root Cause

- Feature was implemented interactively during a live session (skeleton → PR banner → expand/collapse), test coverage was deferred to this follow-up pass by design

---

## Architecture Diagram

- Test-only change, no new runtime component — not applicable

## Design Details

- Not applicable — no new API contracts, data model, or CUJs; this plan adds tests for contracts defined in the prior (already-implemented) work

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Should `fetchPrForBranch`'s 30s in-memory cache be reset between tests? | Module-level `Map`, no test-reset export — mitigated by using a distinct fake `owner/repo` per test case (Phase 2) so no two tests can share a cache key |

---

## Implementation Phases

- Each phase ends with a **`Verify phase N:`** block — the phase is not done until those tests pass
- Screenshots: none — backend/test-only change

### Phase 1 — `git.ts` unit tests

- [x] **1.1** Create `daemon/src/__tests__/git.commits.test.ts`: `mkdtemp` + `execSync git init`, cover Requirements 1, 2, 4
- [x] **1.2** Requirement 3a: commit with a **subject** line containing an embedded tab + numstat-shaped text (e.g. `git commit -m $'3\t1\tsomefile.ts'`), assert that commit *and* a subsequent normal commit both parse correctly
- [x] **1.3** Requirement 3b: commit with a multi-paragraph `-m subject -m body` message, assert `body` returned by `listCommits()` contains the full text with embedded newlines intact

**Verify phase 1:**
- [x] **1.T1** `pnpm --filter cli exec vitest run src/daemon/__tests__/git.commits.test.ts` — all cases pass (5/5)

### Phase 2 — `github.ts` unit tests

- [x] **2.1** Create `daemon/src/__tests__/github.test.ts`: `mkdtemp` + `execSync git init` fixture for `getRemoteUrl`, cover Requirement 6
- [x] **2.2** Same file: `global.fetch` stub for `fetchPrForBranch`, cover Requirements 7, 8; `parseGithubRepo` cases (no fixture needed, pure function), cover Requirement 5
- [x] **2.3** Use a distinct fake `owner/repo` string per `fetchPrForBranch` test case (per Risk #1) so the 30s cache never masks a mock-response change between tests

**Verify phase 2:**
- [x] **2.T1** `pnpm --filter cli exec vitest run src/daemon/__tests__/github.test.ts` — all cases pass (11/11)

### Phase 3 — Route tests

- [x] **3.1** Extend `daemon/src/__tests__/worktrees.test.ts` with a new top-level `describe("GET /worktrees/:id/commits and /pr", ...)` block (own local worktree-creation helper, following the pattern at line 631-638): Requirement 9 (`GET .../commits` 404), Requirement 10 (`GET .../pr` 404 + no-remote `200 { pr: null }`), Requirement 11 (commit a file inside the created worktree's checkout path, assert non-zero `insertions`)

**Verify phase 3:**
- [x] **3.T1** `pnpm --filter cli exec vitest run src/daemon/__tests__/worktrees.test.ts` — all cases pass (39/39), no regressions in existing tests in this file

### Phase 4 — Full suite + typecheck

- [x] **4.1** `pnpm typecheck` clean
- [x] **4.2** Full `cli` package test suite green (no regressions from the new files)

**Verify phase 4:**
- [x] **4.T1** `pnpm typecheck` — no errors
- [x] **4.T2** `pnpm --filter cli test` — 65 files / 626 tests pass. One pre-existing `UnhandledRejection` in `sessions.test.ts` ("2.T1e") flips pnpm's exit code even though every assertion is green — reproduced in isolation with none of this plan's new files loaded, confirming it predates this change and isn't a regression from it.

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/__tests__/git.commits.test.ts` | New | 1 | Unit tests for `listCommits()` — empty repo, binary changes, adversarial subject/body, no-body default, merge commits |
| `daemon/src/__tests__/gitFixture.ts` | New | 1/2 | Shared mkdtemp+git-init test fixture, deduped out of the two unit test files |
| `daemon/src/__tests__/github.test.ts` | New | 2 | Unit tests for `getRemoteUrl()`, `parseGithubRepo()`, `fetchPrForBranch()` — incl. request construction + cache TTL/reset |
| `daemon/src/__tests__/worktrees.test.ts` | Modified | 3 | Route-level cases for `GET /worktrees/:id/commits` and `GET /worktrees/:id/pr`; deduped `createWorktree()` to file scope |
| `daemon/src/services/git.ts` | Modified | Review fix | `FULL_SHA_RE` guard against RS/US-byte-in-subject corruption; `--diff-merges=first-parent` so merge commits get a real diffstat; doc clarifies full-HEAD-history contract |
| `daemon/src/services/github.ts` | Modified | Review fix | Adds `_clearPrCacheForTest()` test-reset export |

---

## Review Findings Addressed

Opus code-review pass (via `/code-review high --model=opus`) on the Phase 1-3 diff, run after initial implementation. All 10 findings addressed:

| # | Finding | Fix |
|---|---------|-----|
| 1 | **Real bug**: `listCommits` RS/US block-splitting corrupts on a commit subject containing those literal bytes; the "adversarial" test claimed to cover this but only tested a tab | Added `FULL_SHA_RE` guard in `git.ts` (drops fragments whose `sha` field isn't 40 hex chars); rewrote the test to inject actual RS/US bytes via `-F` and assert the guard's real, narrower scope (protects *other* commits, contains — doesn't fully repair — the adversarial one) |
| 2 | PR route's real GitHub-lookup wiring (owner/repo/branch pass-through) had zero coverage — only the trivial no-remote path was tested | Added a route test with a real git remote + `vi.spyOn(github, "fetchPrForBranch")`, asserting exact call args and response pass-through |
| 3 | **Real bug**: merge commits get `+0/-0` (git suppresses merge diffs by default without `-m`/`--diff-merges`) | Added `--diff-merges=first-parent` to the `git log` call in `git.ts`; added a merge-commit test |
| 4 | Binary-diffstat test committed the binary file alone — couldn't catch a `continue`→`break` regression dropping a co-committed text file's stats | Rewrote to commit a binary + text file together, asserting the text file's lines still count |
| 5 | No test asserted `sha`/`shortSha`/`authorName`/`authorEmail`/`date` — a field-order regression in the positional destructure would go unnoticed | Added assertions on all fields |
| 6 | 30s PR cache had no reset hook (unlike `_clearStoreForTest` etc. elsewhere) and no TTL/hit-miss test | Added `_clearPrCacheForTest()`; added cache-hit, different-key-different-fetch, and explicit-clear tests |
| 7 | `/commits` full-HEAD-history vs. `baseSha`-scoped contract was ambiguous | Clarified via doc comment on `listCommits` — full history is the intentional, correct contract (matches how a "commits" tab conventionally shows full branch history, not just the diff-from-base that `/changed-paths` already covers separately); no behavior change |
| 8 | The no-remote PR test couldn't distinguish "no remote" from "lookup itself is broken" | Superseded by finding #2's new wired-through test, which exercises the non-null path explicitly |
| 9 | `createWorktree()` helper duplicated verbatim across two describe blocks; `git()` exec wrapper duplicated across two new test files | Hoisted `createWorktree` to file scope (`worktrees.test.ts`); extracted `gitFixture.ts` shared helper |
| 10 | No-remote PR test round-tripped the full worktree-creation pipeline for a check that only reads `project.absolutePath` | Not changed — the I/O cost is real but small, and consolidating further would reduce test clarity; accepted as-is |
