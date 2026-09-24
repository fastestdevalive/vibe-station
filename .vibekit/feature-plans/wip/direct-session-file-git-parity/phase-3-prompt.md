# Turn-implement: Phase 3 — VCS commits project scope

You are a scoped implementer for the FINAL phase of a larger plan. You have no memory of any
other phase. Phases 1 (file-watch) and 2 (git-status/gutter/diff routes) are ALREADY DONE and
committed — do not touch anything in `rust/vst-types/src/ws.rs`, `file_watch.rs`, `tree_watch.rs`,
`rust/vst-routes/src/projects.rs`'s `changed_paths`/`gutter`/`diff` methods, or `client.ts`'s
`listChangedPaths`/`getDiff` (those exist and work — you only ADD to `listCommits` and consume
the existing routes).

**Before touching any file:** read the `coding-agent-guardrails` skill, then the `coding` skill.

**Plan file (read the whole file for context, but you only OWN Phase 3's checklist items below):**
`.vibekit/feature-plans/wip/direct-session-file-git-parity/plan-direct-session-file-git-parity.md`

Repo root for all commands: this worktree's top level (contains `rust/`, `web-ui/`,
`pnpm-workspace.yaml`).

## What Phase 2 already built (you depend on this, read carefully)

Phase 2 added these routes, already live and tested:
- `GET /projects/:id/changed-paths?scope=local|commit&sha=<sha>` → `ChangedPath[]`
- `GET /projects/:id/gutter/*path` → `GutterResult`
- `GET /projects/:id/diff/*path?scope=local|commit&sha=<sha>` → text/plain diff
- `GET /projects/:id/commits?limit=<n>` → `{ commits: CommitLogEntry[] }` (`ProjectRoutes::commits`
  already exists on the backend from Phase 2's item 2.5 — every commit has `isOnBranch: true`,
  no synthetic base ref)
- `client.ts`'s `listChangedPaths(worktreeId, scope, sha, fileScope)` and `getDiff(worktreeId,
  filePath, scope, sha, fileScope)` already accept a `fileScope: FileScope = "worktree"` 5th/4th
  param routing through `fileBase()`.

Your job is the FRONTEND-only piece: `listCommits` needs the same `fileScope` treatment, and it
needs to be threaded through the VCS panel component tree down to where diffs are rendered.

## Relevant Key Decisions (read these in full from the plan file before starting)

- **Decision 4** (only the `listCommits` part — the `listChangedPaths`/`getDiff` parts are already
  done by Phase 2).
- **Decision 5** (`scope: FileScope` threads through `ToolPanel → VcsPanel → VcsCommitView →
  FilePreviewPane`) — this is entirely your phase, read the full snippet and the `diffFromMainEff`
  explanation carefully.

## Your checklist items — Phase 3

Mark each `[x]` in the plan file as you complete it. Items 3.1–3.5 are implementation;
3.T1–3.T6 are the verify block (the orchestrator will re-run these itself after you finish).

- [ ] **3.1** In `web-ui/src/api/client.ts`, add the `fileScope: FileScope = "worktree"` param to
  `listCommits` per Decision 4's snippet, building its URL via `fileBase(fileScope, worktreeId)`.
- [ ] **3.2** In `web-ui/src/components/layout/ToolPanel.tsx`, pass `scope={scope}` into the
  `<VcsPanel ... />` element — the `scope` variable/prop already exists on `ToolPanel` itself.
- [ ] **3.3** In `web-ui/src/components/tools/VcsPanel.tsx`: add `scope?: FileScope` to
  `VcsPanelProps` (import `FileScope` from `@/api/types`), default `"worktree"` in the function
  signature. Compute `const isProject = scope === "project";` and `const diffFromMainEff =
  !isProject && diffFromMain;` (Decision 5). Update the `load()` function's `Promise.all` per
  Decision 5's first snippet — `listCommits` always fires with `scope` threaded through,
  `getPr`/`listSubmodules` guarded by `!isProject` (they must NOT fire under project scope — no
  PR/submodules concept for a direct session). Update `displayedCommits` to `diffFromMainEff ?
  ownCommits : (pageCommits ?? [])`. Update the load-more check to gate on `diffFromMainEff`
  instead of `diffFromMain`. Update the commits count label to read `diffFromMainEff ?
  ownCommits.length : pageCommits.length`. Hide the "Diff from `<baseBranch>`" toggle behind
  `{!isProject ? (...) : null}` per Decision 5's second snippet, and set its `checked=
  {diffFromMainEff}`. Thread `scope` into the `<VcsCommitView ... />` render.
- [ ] **3.4** In `web-ui/src/components/tools/VcsCommitView.tsx`: add `scope?: FileScope` to
  `VcsCommitViewProps` (import `FileScope`), default `"worktree"`. Pass it as the 4th arg to
  `api.listChangedPaths(worktreeId, "commit", sha, scope)`. Pass it as the `scope` prop to
  `<FilePreviewPane ... />` (currently missing entirely — add `scope={scope}` alongside the
  existing `api`/`worktreeId`/`controlled` props).
- [ ] **3.5** In `web-ui/src/components/layout/FilePreviewPane.tsx`'s own fetch effect, thread its
  `fileScope` prop (already destructured as `scope: fileScope = "worktree"`) into the 5th arg of
  every `api.getDiff(...)` call EXCEPT the one under the `scope === "none"` branch (leave that one
  untouched — out of scope for this plan): the `scope === "local"` branch call → `api.getDiff(
  worktreeId, path, "local", undefined, fileScope)`; the `scope === "branch"` branch call →
  `api.getDiff(worktreeId, path, "branch", undefined, fileScope)`; the `scope === "commit"` branch
  call → `api.getDiff(worktreeId, path, "commit", commitSha, fileScope)`. The `"commit"` branch is
  the call `VcsCommitView`'s controlled `scope="commit"` mode drives (3.4) — without this,
  `getDiff`'s `fileScope` param (already added by Phase 2) is wired but never reaches the one call
  site that actually needs it for the VCS tab's commit-diff view to work under project scope. This
  is the fix for the previously-identified "commit diff still 404s" issue — do not skip it.

**Verify phase 3 (run these yourself before finishing, orchestrator re-verifies independently):**
- [ ] **3.T1** Unit — `web-ui/src/components/tools/VcsPanel.test.tsx`: under `scope="project"`,
  `api.listCommits` is called with `(projectId, limit, "project")`; `api.getPr` and
  `api.listSubmodules` are NOT called at all. Use
  `vi.spyOn(api, "listCommits").mockResolvedValue([...])` for the project id —
  `web-ui/src/api/mock.ts`'s `listCommits` 404s for any id not in its `worktrees` fixture array,
  which a project id never is.
- [ ] **3.T2** Unit — `VcsPanel.test.tsx`: under `scope="project"`, the "Diff from `<baseBranch>`"
  checkbox/label is not present in the rendered output, and `displayedCommits` shows every fetched
  commit (no `isOnBranch`-based filtering).
- [ ] **3.T3** Regression — `VcsPanel.test.tsx`'s existing worktree-scope tests behave unchanged,
  BUT 3.3's `listCommits` call always threads `scope` through — find the existing assertion
  `expect(api.listCommits).toHaveBeenCalledWith("wt-1", 51)` and update it to `("wt-1", 51,
  "worktree")` (`toHaveBeenCalledWith` matches argument count exactly, so the trailing default arg
  is NOT invisible to it). No other existing assertion in this file needs a change.
- [ ] **3.T4** Unit — `web-ui/src/components/tools/VcsCommitView.test.tsx`: under `scope="project"`,
  `api.listChangedPaths` is called with `(worktreeId, "commit", sha, "project")`, and
  `FilePreviewPane` receives `scope="project"`. Use
  `vi.spyOn(api, "listChangedPaths").mockResolvedValue([...])` for the project id — same
  404-on-non-worktree-id mock limitation as 3.T1.
- [ ] **3.T5** Regression — `VcsCommitView.test.tsx`'s existing assertions need the trailing
  default argument added (same reasoning as 3.T3): find `listChangedPaths("wt-1", "commit",
  "abc1234def")` and add `, "worktree"`; find the `getDiff(..., "commit", "abc1234def")` call(s)
  and add `, "worktree"` to each. Confirms worktree-scope behavior is otherwise unchanged.
- [ ] **3.T6** Unit — `web-ui/src/components/layout/FilePreviewPane.test.tsx`: under
  `scope="project"` with `controlled={{ path, scope: "commit", commitSha }}` (mirrors how
  `VcsCommitView` drives it), `api.getDiff` is called with `(projectId, path, "commit", commitSha,
  "project")` — confirms 3.5's fix actually reaches the call site. The file's existing
  `scope === "none"` / project-scope-skips-getDiff test stays unmodified — out of scope for this
  plan.

**Run (do this yourself, then report the results — orchestrator re-runs independently after you exit):**
```
pnpm --filter @vibestation/web test -- src/components/tools/VcsPanel.test.tsx src/components/tools/VcsCommitView.test.tsx src/components/layout/FilePreviewPane.test.tsx
pnpm --filter @vibestation/web typecheck && pnpm --filter @vibestation/web lint
```

## Files you will touch (Files & Phase Impact table, Phase 3 rows only)

| File | Phase | Description / Contract Change |
|------|-------|-------------------------------|
| `web-ui/src/api/client.ts` | 3.1 | `listCommits` gains `fileScope` param (Phases 1/2 already edited this file — do not touch `send()`/`listChangedPaths`/`getDiff`, those are done) |
| `web-ui/src/components/layout/ToolPanel.tsx` | 3.2 | Pass `scope` prop into `<VcsPanel>` |
| `web-ui/src/components/tools/VcsPanel.tsx` | 3.3 | `VcsPanelProps` gains `scope?: FileScope`; hides branch toggle, guards PR/submodules under project scope |
| `web-ui/src/components/tools/VcsPanel.test.tsx` | 3.T1-3.T3 | New project-scope assertions; regression coverage |
| `web-ui/src/components/tools/VcsCommitView.tsx` | 3.4 | `VcsCommitViewProps` gains `scope?: FileScope`, threaded to `listChangedPaths` + `FilePreviewPane` |
| `web-ui/src/components/tools/VcsCommitView.test.tsx` | 3.T4-3.T5 | New project-scope assertion; regression coverage |
| `web-ui/src/components/layout/FilePreviewPane.tsx` | 3.5 | Threads `fileScope` prop into its own `api.getDiff(...)` calls (the `scope === "none"` branch call stays untouched — out of scope) |
| `web-ui/src/components/layout/FilePreviewPane.test.tsx` | 3.T6 | New project-scope `getDiff` call assertion; existing test unchanged |

## When done

1. Ensure all 3.1–3.5 and 3.T1–3.T6 are marked `[x]` in the plan file.
2. If you deviated from the plan's exact wording anywhere, record it as a short note in the plan
   file near the affected checklist item.
3. Do NOT commit. Do NOT touch `.sdlc-state.yaml`. This is the last phase — do not attempt to
   mark the plan or feature "done" yourself, the orchestrator owns that.
4. Report: which items are done, the actual test/typecheck/lint output (paste it, don't summarize
   as "passed"), and any deviation notes.
