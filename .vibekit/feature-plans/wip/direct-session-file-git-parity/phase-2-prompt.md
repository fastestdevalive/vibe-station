# Turn-implement: Phase 2 — Git-status project scope (changed-paths, gutter, diff)

You are a scoped implementer for ONE phase of a larger plan. You have no memory of any other
phase and will not exist when later phases run — write anything future phases need into the
plan file itself under `## Key Decisions` (it already exists) or a note near your checklist
items, not just in your own head. Phase 1 (file-watch project scope) is ALREADY DONE and
committed — do not touch `rust/vst-types/src/ws.rs`, `file_watch.rs`, `tree_watch.rs`, or
`useSubscription.ts`'s watch hooks; they are out of your scope.

**Before touching any file:** read the `coding-agent-guardrails` skill, then the `coding` skill.

**Plan file (read the whole file for context, but you only OWN Phase 2's checklist items below):**
`.vibekit/feature-plans/wip/direct-session-file-git-parity/plan-direct-session-file-git-parity.md`

Repo root for all commands: this worktree's top level (contains `rust/`, `web-ui/`,
`pnpm-workspace.yaml`).

## Relevant Key Decisions (read these in full from the plan file before starting)

- **Decision 3** (Project git routes reuse `worktrees.rs`'s helpers via `pub` cross-module calls,
  no duplication) — includes the non-git short-circuit rules, critical, read carefully.
- **Decision 4** (Frontend `listChangedPaths`/`listCommits`/`getDiff` gain a `fileScope: FileScope`
  param, distinct from their existing `scope` param) — you implement the `listChangedPaths`/`getDiff`
  half of this; `listCommits` is Phase 3's job, not yours.

## Relevant System Boundaries / API Contracts (read these sections in full from the plan file)

- `## Design Details > System Boundaries` — the REST contract row for `/projects/:id/...`, and the
  non-git-project short-circuit rule (critical — a currently-clean Files tab must not start 500ing).
- `## Design Details > API Contracts` — exact response shapes and error codes for
  `changed-paths`/`gutter`/`diff` (the `commits` contract is Phase 3's, not yours).

## Your checklist items — Phase 2

Mark each `[x]` in the plan file as you complete it. Items 2.1–2.10 are implementation;
2.T1–2.T12 are the verify block (the orchestrator will re-run these itself after you finish —
you do not need to trust your own run, but do run them to catch mistakes before handing off).
Do NOT implement 2.5 (`commits`) beyond adding it as specified below — Phase 3 builds on it, but
you still own it per the checklist (it's numbered 2.5, part of your phase).

- [ ] **2.1** In `rust/vst-routes/src/projects.rs`, add `use crate::worktrees::{parse_porcelain_z,
  parse_branch_name_status, merge_numstat, run_numstat_cmd, untracked_numstat_cmd,
  is_valid_commit_sha, compute_etag, resolve_inside_worktree, MAX_DIFF_BYTES, DiffResponse};` and
  `use vst_git::git::{list_commits, rev_parse, resolve_parent_sha};` (extend the existing
  `vst_git::git::{...}` import list already in the file — check if `rev_parse` is already imported
  before adding it again, it may cause a duplicate-import error) and `use
  vst_types::rest::worktrees::{ChangedPath, GutterResult, CommitsResult, CommitLogEntry};`.
  `resolve_inside_worktree`, `MAX_DIFF_BYTES`, and `DiffResponse` are ALL already `pub` in
  `worktrees.rs` — no visibility change needed, just import.
- [ ] **2.2** Add `pub async fn changed_paths(&self, project_id: &str, scope: Option<&str>, sha:
  Option<&str>) -> Result<Vec<ChangedPath>, ProjectRouteError>` to `ProjectRoutes`. Body: resolve
  `project` via `self.store.get_project(project_id).await` (404 `ProjectRouteError::NotFound` if
  missing, matching the existing pattern in this file); if `!project.is_git`, return `Ok(vec![])`
  immediately (Decision 3 — non-git short-circuit, THIS ORDER MATTERS: check `is_git` before the
  `scope == "branch"` validation or any subprocess spawn); `scope.unwrap_or("local")`; if
  `scope == "branch"` return `ProjectRouteError::validation("scope=branch is not supported for
  project-scope routes")`; if `scope == "commit"` reuse `worktrees.rs`'s commit-diff changed-paths
  logic verbatim against `project.absolute_path` instead of `wt_path`; otherwise (local) reuse
  `worktrees.rs`'s `git status --porcelain=v1 -z -uall` + numstat logic verbatim against
  `project.absolute_path`. The worktree route's `changed_paths` body does NOT call
  `resolve_inside_worktree` at all — only `gutter`/`diff` do — so you likely won't need the
  `.map_err` translation here; only add it if you actually call `resolve_inside_worktree` from this
  method. If you do, `resolve_inside_worktree` returns `Result<_, WorktreeRouteError>` and there is
  no `From<WorktreeRouteError> for ProjectRouteError` impl, so translate via `.map_err(|e|
  ProjectRouteError::unprocessable(e.to_string(), None))?` — a bare `?` will not compile. Note the
  two error types' `Unprocessable` variants differ in shape
  (`WorktreeRouteError::Unprocessable(String)` vs `ProjectRouteError::Unprocessable{message,
  reason}`), so any such translation is not a straight copy.
- [ ] **2.3** Add `pub async fn gutter(&self, project_id: &str, file_path: &str) ->
  Result<GutterResult, ProjectRouteError>` — resolve `project`; if `!project.is_git`, return
  `Ok(GutterResult { added: vec![], deleted: vec![], modified: vec![] })` immediately (Decision 3);
  otherwise port the worktree route's `gutter` body, resolving the root as
  `PathBuf::from(&project.absolute_path)` instead of `self.paths.worktree_path(...)`, translating any
  `resolve_inside_worktree` error via `.map_err(...)` per 2.2 (this method DOES call it in the
  worktree version).
- [ ] **2.4** Add `pub async fn diff(&self, project_id: &str, file_path: &str, scope: Option<&str>,
  sha: Option<&str>) -> Result<DiffResponse, ProjectRouteError>` (reuse `worktrees.rs`'s already-`pub`
  `DiffResponse` struct, imported in 2.1) — resolve `project`; if `!project.is_git`, return
  `Err(ProjectRouteError::unprocessable("project is not a git repository", None))` (422, Decision 3);
  port the worktree route's `diff` body, dropping the `"branch"` match arm entirely (return
  `ProjectRouteError::validation(...)` for `scope == "branch"` before the match, same as 2.2) and
  resolving the root against `project.absolute_path`, translating any `resolve_inside_worktree`
  error via `.map_err(...)` per 2.2.
- [ ] **2.5** Add `pub async fn commits(&self, project_id: &str, limit: Option<usize>) ->
  Result<CommitsResult, ProjectRouteError>` — resolve `project`; if `!project.is_git`, return
  `Ok(CommitsResult { commits: vec![] })` immediately (Decision 3); otherwise
  `limit.unwrap_or(200).clamp(1, 1000)`, call `list_commits(&project.absolute_path, limit, None)`.
  CHECK the actual return type of `list_commits` before wrapping it — it returns
  `vst_git::git::CommitLogEntry` (which may use different integer width fields, e.g. `u64` counts)
  from the REST `vst_types::rest::worktrees::CommitLogEntry` (which may use `i64`) — if they differ,
  map/convert field-by-field the same way `worktrees.rs`'s own `commits()` method does (copy its
  conversion logic, not just the call), then wrap in `CommitsResult { commits }`. Do NOT call
  `resolve_base_sha`/`fetch_origin` — see Decision 3, every commit stays implicitly on-branch.
- [ ] **2.6** In `rust/vst-daemon/src/server.rs`, add 4 new route registrations under the existing
  `/projects/:id/...` block: `.route("/projects/:id/changed-paths",
  get(handle_project_changed_paths))`, `.route("/projects/:id/gutter/*path",
  get(handle_project_gutter))`, `.route("/projects/:id/diff/*path", get(handle_project_diff))`,
  `.route("/projects/:id/commits", get(handle_project_commits))`. Add the 4 corresponding handler
  functions near the existing `handle_project_get_file`-style handlers, mirroring
  `handle_worktree_changed_paths`/`handle_worktree_gutter`/`handle_worktree_diff`/`handle_worktree_commits`
  exactly — reuse the SAME `DiffQuery`/`CommitsQuery` query-param structs the worktree handlers
  already use (no new structs needed), route errors through the existing `project_err_to_response`
  mapping already used by the other `/projects/:id/...` handlers in this file.
- [ ] **2.7** In `web-ui/src/api/client.ts`, update `listChangedPaths` to add a `fileScope:
  FileScope = "worktree"` 5th param per Decision 4's snippet, building its URL via
  `fileBase(fileScope, worktreeId)`. ALSO update `getDiff` the same way — add a `fileScope: FileScope
  = "worktree"` 5th param and build its URL via `fileBase(fileScope, worktreeId)` instead of its
  current hardcoded `${baseUrl()}/worktrees/${id}/diff/...`. `getGutter` needs NO change — it
  already routes through `fileBase(scope, worktreeId)`. Do NOT touch `listCommits` — that's Phase 3.
- [ ] **2.8** In `web-ui/src/components/layout/FileTreeSidebar.tsx`: drop the `|| isProject`
  condition from the local-changed-paths fetch guard (so it becomes `if (!activeWorktreeId)
  {...}`), and pass `fileScope` into the `api.listChangedPaths(activeWorktreeId, "local")` call →
  `api.listChangedPaths(activeWorktreeId, "local", undefined, fileScope)`. This is the change that
  actually fixes the missing git-status markers. Also drop the `isProject ? "none" :` ternary
  forcing `scope` to `"none"` (become `const scope: DiffScope = scopeRaw ?? "none";`), and drop the
  redundant `isProject` term from the branch-changed-paths fetch guard (keep the
  `effectiveTreeScope !== "branch"` check, which alone already keeps branch scope unreachable for a
  project id).
- [ ] **2.9** In `web-ui/src/components/layout/FileTreeHeader.tsx`, mirror 2.8's `isProject ? "none"
  :` removal: `const scope: DiffScope = isProject ? "none" : (scopeRaw ?? "none");` → `const scope:
  DiffScope = scopeRaw ?? "none";`. The toggle buttons stay hidden for `isProject` regardless
  (unrelated to this line) — this is harmless cleanup for consistency with 2.8, not a required fix.
- [ ] **2.10** In `web-ui/src/components/dialogs/QuickOpen.tsx`, drop the `scope !== "worktree"`
  term from the changed-files fetch guard (become `if (!open || !wt) return;`), passing `scope`
  through: `api.listChangedPaths(wt, "local", undefined, scope)`.

**Verify phase 2 (run these yourself before finishing, orchestrator re-verifies independently):**
- [ ] **2.T1** Integration — `rust/vst-routes/tests/projects.rs` (extend, using the existing
  `test_env()`/`init_git_repo()` helpers already in that file): create a project with
  `init_git_repo`, modify a tracked file + add an untracked file, call
  `routes.changed_paths(project_id, None, None).await` — assert both appear with correct `status`
  chars, matching `git status --porcelain` output.
- [ ] **2.T2** Integration — `changed_paths(project_id, Some("branch"), None)` returns
  `Err(ProjectRouteError::Validation(_))`.
- [ ] **2.T3** Integration — `changed_paths(project_id, Some("commit"), Some(<sha>))` against a repo
  with ≥2 commits returns the correct diff-name-status entries for that commit.
- [ ] **2.T4** Integration — `routes.gutter(project_id, "file.rs").await` on a file with an
  uncommitted single-line edit returns the correct `modified: [line]`.
- [ ] **2.T5** Integration — `routes.diff(project_id, "file.rs", None, None).await` (local scope)
  returns the same `git diff HEAD -- file.rs` output the worktree route would for an equivalent
  worktree fixture.
- [ ] **2.T6** Integration — `routes.diff(project_id, "file.rs", Some("branch"), None).await`
  returns `Err(ProjectRouteError::Validation(_))`.
- [ ] **2.T7** Integration — `routes.commits(project_id, None).await` on a repo with 3 commits
  returns exactly 3 entries, every `is_on_branch == true`, most-recent-first.
- [ ] **2.T8** Regression — every existing `rust/vst-routes/tests/worktrees.rs` test for
  `changed_paths`/`gutter`/`diff`/`commits` still passes unmodified (these methods were NOT touched,
  only read from for reuse).
- [ ] **2.T9** Integration — `rust/vst-routes/tests/projects.rs`: create a project with a plain
  `test_env()` base dir that is NOT a git repo (skip `init_git_repo`, or explicitly set `is_git:
  false` on the stored `ProjectRecord`) — assert `changed_paths(...)` returns `Ok(vec![])`,
  `gutter(...)` returns an empty `GutterResult`, `commits(...)` returns `Ok(CommitsResult { commits:
  vec![] })`, and `diff(...)` returns `Err(ProjectRouteError::Unprocessable { .. })` (422) — NONE of
  the four return `500`/`Internal`.
- [ ] **2.T10** Unit — `web-ui/src/components/layout/FileTreeSidebar.test.tsx`: under
  `scope="project"`, the local changed-paths fetch NOW fires (`api.listChangedPaths` called with
  `fileScope="project"`) — this is a NEW test (there is no existing "never called" assertion to
  replace). Use `vi.spyOn(api, "listChangedPaths").mockResolvedValue([...])` for the project id —
  `web-ui/src/api/mock.ts`'s `listChangedPaths` 404s for any id that isn't in its `worktrees`
  fixture array, which a project id never is.
- [ ] **2.T11** Regression — `FileTreeSidebar.test.tsx`'s existing worktree-scope tests (git status
  markers rendering, branch-scope fetch behavior) still pass unmodified.
- [ ] **2.T12** Unit — `web-ui/src/components/dialogs/QuickOpen.test.tsx`: under `scope="project"`,
  the changed-files-first-in-list behavior now fires (previously skipped) — same
  `vi.spyOn(api, "listChangedPaths").mockResolvedValue(...)` requirement as 2.T10 (mock.ts 404s on a
  non-worktree id).

**Run (do this yourself, then report the results — orchestrator re-runs independently after you exit):**
```
cd rust && cargo test -p vst-routes -p vst-daemon
pnpm --filter @vibestation/web test -- src/components/layout/FileTreeSidebar.test.tsx src/components/dialogs/QuickOpen.test.tsx
pnpm --filter @vibestation/web typecheck
```

## Files you will touch (Files & Phase Impact table, Phase 2 rows only)

| File | Phase | Description / Contract Change |
|------|-------|-------------------------------|
| `rust/vst-daemon/src/server.rs` | 2.6 | 4 new `/projects/:id/...` routes + handlers (Phase 1 already edited this file's resolver — do not touch that part) |
| `rust/vst-routes/src/projects.rs` | 2.1-2.5 | New `changed_paths/gutter/diff/commits` methods — reuse `worktrees.rs` git-subprocess helpers |
| `rust/vst-routes/src/worktrees.rs` | — | Unchanged — helpers already `pub`, read-only reuse |
| `rust/vst-routes/tests/projects.rs` | 2.T1-2.T7, 2.T9 | New integration tests, including non-git short-circuit coverage |
| `web-ui/src/api/client.ts` | 2.7 | `listChangedPaths`/`getDiff` gain `fileScope` param (Phase 1 already edited this file's `send()` — do not touch that part; do NOT touch `listCommits`, that's Phase 3) |
| `web-ui/src/components/layout/FileTreeSidebar.tsx` | 2.8 | Drop `isProject` guards on diff-scope force and local-changed-paths fetch |
| `web-ui/src/components/layout/FileTreeSidebar.test.tsx` | 2.T10-2.T11 | New project-scope assertion; regression coverage |
| `web-ui/src/components/layout/FileTreeHeader.tsx` | 2.9 | Drop `isProject` guard mirroring `FileTreeSidebar.tsx` |
| `web-ui/src/components/dialogs/QuickOpen.tsx` | 2.10 | Drop `scope !== "worktree"` guard on changed-files fetch |
| `web-ui/src/components/dialogs/QuickOpen.test.tsx` | 2.T12 | New project-scope changed-files assertion (Phase 1 already edited this file's tree-watch test — do not touch that part) |

## When done

1. Ensure all 2.1–2.10 and 2.T1–2.T12 are marked `[x]` in the plan file.
2. If you deviated from the plan's exact wording anywhere (e.g. a line number had drifted, a
   type mismatch needed a different conversion than described, a helper wasn't `pub` after all),
   record it as a short note in the plan file near the affected checklist item — Phase 3's
   implementer has no other way to learn about it, and it explicitly depends on your routes.
3. Do NOT commit. Do NOT touch `.sdlc-state.yaml`. Do NOT start Phase 3.
4. Report: which items are done, the actual test/typecheck output (paste it, don't summarize as
   "passed"), and any deviation notes — especially anything Phase 3 needs to know about the exact
   shape of the routes you built (query param names, response field names, error codes).
