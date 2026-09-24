# Fix: opus code-review findings on direct-session-file-git-parity

You are fixing real bugs found by a code review of an already-implemented, already-committed
feature on this branch. Read `.vibekit/reports/2026-09-22-direct-session-file-staleness-and-git-indicators.md`
and `.vibekit/feature-plans/wip/direct-session-file-git-parity/plan-direct-session-file-git-parity.md`
first for context on what this feature does and why (direct-session/project-scope parity with
worktree sessions for file-watch, git-status/gutter/diff, and VCS commits).

**Before touching any file:** read the `coding-agent-guardrails` skill, then the `coding` skill.

Repo root for all commands: this worktree's top level (contains `rust/`, `web-ui/`,
`pnpm-workspace.yaml`). Current branch has 2 commits for this feature on top of `a231c4a3`:
`feat(daemon): ...` and `feat(web-ui): ...` — both already landed. Your fixes are NEW work on
top of them; do not amend/rebase those commits.

## Fix these 4 issues exactly as specified

### 1. (Medium) Project routes give wrong paths when the project folder is a subdirectory of a git repo

**Where:** `rust/vst-routes/src/projects.rs` — the local `git status` call (~line 1405), the
numstat calls (~lines 1399, 1419), the commit `--name-status` call (~lines 1377-1386).

**Why it happens:** `is_git` comes from `git rev-parse --git-dir`, which also succeeds inside a
subdirectory of a repo, not just at its root. So a project registered at e.g. `repo/pkg` has
`is_git=true`. Worktrees were never affected by this because they always sit at a repo root — but
a direct-session project can be any directory.

**What goes wrong:** `git status --porcelain` and `git diff --numstat`/`--name-status` report
paths relative to the REPO ROOT, not the project's own directory. Running from `pkg/`, `git
status` prints `pkg/a.txt` for a file that should show as `a.txt` relative to the project, AND
also prints paths for files entirely outside the project (e.g. `top.txt` at the repo root). This
breaks: tree markers/QuickOpen's changed-first list not lining up with project-relative paths,
files outside the project appearing in the list, the mtime lookup (`root.join(c.path)`) missing
the file, `untracked_numstat_cmd` pointing at the wrong file, and the VCS commit view's diff calls
resolving to a doubled path (`pkg/pkg/a.txt`) and returning an empty diff.

**Fix:**
- Run `git rev-parse --show-prefix` once per call (against `project.absolute_path`).
- If the prefix is non-empty: add `--relative` to both `git diff` calls (the commit
  `--name-status` call and `run_numstat_cmd`'s args), and run `git status` with the pathspec `--
  .` (scopes it to the current directory), then strip the prefix from each returned entry's path
  before returning it (including rename entries' `orig_path`, if present).
- If the prefix is empty (project IS the repo root), behavior is unchanged.
- Add an integration test in `rust/vst-routes/tests/projects.rs`: register a project whose
  `absolute_path` is a SUBDIRECTORY of a git repo (not the repo root), modify a file inside that
  subdirectory AND a file outside it (at the repo root, above the subdirectory), call
  `changed_paths`/`diff`/`gutter` — assert only the in-project file appears, with a path relative
  to the PROJECT directory (not the repo root), and that a `diff`/`gutter` call on that file
  actually returns real content (not empty, proving the path resolution is correct end-to-end).

### 2. (Low) Path traversal in the project gutter route returns 422 instead of 403

**Where:** `rust/vst-routes/src/projects.rs` (~lines 1463-1465), in the `gutter` method.

**What's wrong:** it calls `resolve_inside_worktree(...)` and wraps its `AccessDenied` error in
`ProjectRouteError::unprocessable(e.to_string(), None)` (422). The worktree `gutter` route returns
403 for the same traversal case. The error message also gets doubled ("Access denied: Access
denied: path traversal attempt") because both layers prepend the same text.

**Fix:** use `resolve_inside_dir(&root, file_path)` instead of `resolve_inside_worktree(...)` —
`resolve_inside_dir` already exists in this file (used by `tree`/`get_file`, around line 1721) and
already returns `ProjectRouteError::AccessDenied` (403) directly, no wrapping needed. Drop
`resolve_inside_worktree` from this file's imports if the `gutter` method was its only caller
(check `diff` too — if `diff` also called it, decide per-callsite; `diff`'s worktree equivalent
DOES use `resolve_inside_worktree`-style resolution today, only `gutter`'s status-code mismatch is
the actual bug here, so only fix `gutter` unless you find `diff` has the SAME wrong status code,
in which case apply the same fix there too — check what worktree `diff` actually returns for
traversal before changing it).
- Add/update a test asserting the gutter route returns 403 (not 422) for a path-traversal attempt
  (e.g. `../../etc/passwd`), with a single (not doubled) "Access denied" message.

### 3. Test coverage gaps

**3a.** No test that OLD clients (that never send a `scope` field) still parse correctly. Add a
test in `rust/vst-types/src/ws.rs`'s test module: deserialize
`{"type":"file:watch","worktreeId":"w","path":"p"}` (no `scope` key at all) and
`{"type":"tree:watch","worktreeId":"w"}` (no `scope` key) — assert `scope == WatchScope::Worktree`
on both. Also deserialize a message WITH `"scope":"project"` and assert it parses to
`WatchScope::Project`. This is the concrete guarantee behind the plan's backward-compatibility
decision (`#[serde(default)]`) — nothing currently pins it as a test.

**3b.** The actual client URL fix (routing project-scope calls to `/projects/:id/...` instead of
`/worktrees/:id/...`) is never exercised by a real test — every component test mocks
`listChangedPaths`/`listCommits`/`getDiff` directly on the mock API object, so nothing verifies
that `client.ts`'s URL-building logic itself produces the right URL. This is the actual fix for
the bugs this whole feature exists to fix (files not refreshing / git markers missing / VCS tab
404ing) — it deserves a real test. Add cases to `web-ui/src/api/client.test.ts` that stub `fetch`
directly (not the mock API) and assert: `listChangedPaths(id, "local", undefined, "project")`
fetches a URL containing `/api/projects/<id>/changed-paths`; `listChangedPaths(id, "local")` (no
fileScope arg, default) fetches `/api/worktrees/<id>/changed-paths`; same pattern for
`listCommits` and `getDiff` (one project-scope assertion + one default-worktree-scope assertion
each, 6 test cases total). Check `client.test.ts`'s existing tests for how `fetch` is stubbed and
match that pattern.

**3c.** `web-ui/src/components/layout/FileTreeSidebar.test.tsx` around line 172 spies on the
module-level shared `api` object (declared near the top of the file) and never restores it — no
`afterEach`/`restoreMocks` cleanup. It's harmless today only because it happens to be the last
test in the file, which is fragile. Fix: add `spy.mockRestore()` at the end of that test (or use
`vi.spyOn(...)` inside a `try/finally`, or build a fresh `createMockApi()` instance scoped to that
one test instead of spying on the shared instance — pick whichever matches the file's existing
conventions most closely).

### 4. (Nit) `FileTreeSidebar.tsx` branch-scope fetch missing `fileScope`

**Where:** `web-ui/src/components/layout/FileTreeSidebar.tsx` (~line 350) — a
`api.listChangedPaths(activeWorktreeId, "branch")` call is missing the trailing `fileScope`
argument that the local-scope call (~line 317) already has. This branch scope call can't actually
be reached under project scope today (the UI hides the branch chip for project scope), so it's
not a live bug, but it's inconsistent and would silently misbehave (404 against `/worktrees/...`
instead of the intended 400) if that ever changed. Fix: add `, undefined, fileScope` to match the
local-scope call site's shape.

## Verification

After all fixes, run:
```
cd rust && cargo test -p vst-types -p vst-routes -p vst-daemon
pnpm --filter @vibestation/web test -- src/api/client.test.ts src/components/layout/FileTreeSidebar.test.tsx
pnpm --filter @vibestation/web typecheck && pnpm --filter @vibestation/web lint
```
Paste the actual output, don't summarize as "passed". The known pre-existing flaky tests
(`FileTreeSidebar.test.tsx`'s "first row is tabbable", `VcsPanel.test.tsx`'s two Phase-10 tests)
are NOT your concern — they're documented as pre-existing in the plan file, unrelated to this
fix. Don't try to fix them; if they fail, that's expected and fine.

## When done

1. Do NOT commit — the orchestrator will independently re-verify and commit.
2. Do NOT touch `.sdlc-state.yaml`.
3. Report: what you changed (file:line for each of the 4 issues), the actual verification output,
   and any deviation from these instructions (e.g. if issue 2's `diff` caveat applies).
