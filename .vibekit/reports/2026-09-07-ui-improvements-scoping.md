# Report: Desktop UI improvements — 10-item scoping

**Date:** 2026-09-07 · **Commit:** 5ab73f6 · **Scope:** research/scoping only, no implementation · **Method:** opus subagent read of `web-ui/src/components/{layout,dialogs,tools,preview}`, `web-ui/src/hooks`, `daemon/src/ws`, `daemon/src/routes/worktrees.ts`, `daemon/src/services/git.ts`

## Goal

Ten minor UI requests against the Tauri desktop shell (worktree UI, files/VCS tabs, session-creation dialogs). For each: find the exact current implementation and the smallest correct fix, without violating the invariants in `AGENTS.md` (TerminalPane never unmounts, agent-plugin boundary, WS session-lock, two-axis status model, "Rich Chat"/`json` split).

## Findings

### 1. Draft persistence for new-session prompt
**Files:** `web-ui/src/components/dialogs/NewAgentDialog.tsx` (prompt state L194; reset-on-close L341/L355) · `NewSessionDialog.tsx` (L54–56) · `NewTabDialog.tsx` (L35) · `web-ui/src/hooks/useComposerDraft.ts`

The dialogs explicitly clear the prompt on close/reset — the text isn't lost to unmounting, it's discarded on purpose. Fix: persist via a hook modelled on the existing `useComposerDraft` (localStorage, debounced write, `loadDraft()` as the `useState` initializer), keyed per context (`vst-newagent-draft-${projectId ?? "new"}`, `vst-newsession-draft-${worktreeId}`). Clear only on successful create, not on cancel. **Easy — precedent hook already does this shape.**

### 2. Split-handle drag inverted when tools panel is on top
**Files:** `web-ui/src/components/layout/Layout.tsx` L237–273 (`topRow`) · `react-resizable-panels@^3.0.6`

`topRow` renders the two panels as a keyed array whose *order* flips with orientation — horizontal is `[agent, handle, tools]`, vertical is `[tools, handle, agent]` — but the `key`s (`"agent"`/`"tools"`) stay the same in both. React reconciles by key and **reorders** the existing Panel instances instead of remounting them, so react-resizable-panels' internal registration order goes stale relative to DOM order, and dragging applies the resize delta with the wrong sign. Fix: give each Panel an explicit `order` prop (the library's documented mechanism for conditionally-ordered panels), or make the keys orientation-specific, or key the `PanelGroup` itself by orientation to force a clean remount — the `autoSaveId` already varies by orientation, so a remount loses no saved layout. **Genuine bug, not a missing feature.**

### 3. VCS tab missing branch name
**Files:** `web-ui/src/components/tools/VcsPanel.tsx` (props L6–11; header bar L412–465) · `web-ui/src/components/layout/ToolPanel.tsx` L110 · `web-ui/src/api/types.ts` L40–46 (`Worktree.branch`)

`ToolPanel` already threads `baseBranch` into `VcsPanel`; thread the worktree's own `branch` (already on the `Worktree` record) the same way and render it as a chip next to the "Commits (n)" title. **No daemon work.**

### 4. Files list / fuzzy search doesn't live-update
**Files:** `daemon/src/ws/handlers/treeWatch.ts` + `treeUnwatch.ts` · `daemon/src/ws/connection.ts` (`registerTreeWatcher`/`unregisterTreeWatcher`) · `web-ui/src/hooks/useSubscription.ts` `useTreeWatch` L121–141 · `web-ui/src/hooks/useWorktreeFiles.ts`

Root cause is almost certainly a **missing refcount** on the shared watch key. `handleTreeWatch` no-ops if `tree:${worktreeId}:` is already registered; `handleTreeUnwatch` closes it unconditionally. `FileTreeSidebar` and Quick Open's `useWorktreeFiles` both call `useTreeWatch` for the same worktree on the same WS connection — whichever unmounts first (e.g. closing Quick Open) kills the watcher the other still depends on. Matches the "sometimes doesn't update" symptom exactly. Fix: refcount watchers in `WSConnection` (increment on watch, close only at zero); same fix applies to `fileWatch`/`fileUnwatch`. Client side is already correct. **Genuine bug.**

### 5. Open file preview doesn't live-update
**Files:** `web-ui/src/components/layout/FilePreviewPane.tsx` L36, refetch effect L42–92 · `useSubscription.ts` `useFileWatch` L92–119 · `daemon/src/ws/streams/fileWatcher.ts`

Same refcount bug as #4 likely applies here too, plus `FileWatcher.watch()` points chokidar at a single file path, which loses the inode on atomic rename-replace saves (the common editor/agent save pattern) — the watch dies after the first such save. Fix (b): watch the parent directory and filter by path in the handler; also cheap-insurance: add the tree-watch `lastChanged` to this effect's deps so a directory-level change also triggers a refetch of the open file.

### 6. "Focus" concept + arrow-key tree navigation
**Files:** `web-ui/src/components/layout/FileTreeSidebar.tsx` (`TreeNode` L70–168; `expanded: Set<string>` + `toggle()` L199/L325) · precedent: `QuickOpen.tsx` L86–95 (`activeIndex` list nav), `NewAgentDialog.tsx` combobox · `useWorkspaceKeyboardShortcuts.ts` (global keys only) · `useStore.ts`

No general focus infrastructure exists — only per-widget `activeIndex` nav inside dialogs, plus a global hotkey hook. Plan: add a `focusedPane: string | null` slice to the workspace store, set on pointerdown/focus-capture of a pane wrapper; flatten the recursive tree render into an ordered `visibleRows` list derived from `root` + `expanded` + loaded children, with a `cursorPath` state; use roving tabindex (`tabIndex = cursorPath === path ? 0 : -1`) with one `onKeyDown` for Up/Down/Left/Right/Enter (Right expands a dir, Left collapses-if-expanded else moves to parent). The real cost is hoisting children-loading out of `TreeNode` so a flat list exists to move a cursor over — everything else is additive.

### 7. Diff-stat + local/branch toggle in non-diff preview
**Files:** `FilePreviewPane.tsx` (`diffStats` memo L152–164; `diffInfo` strip L189–203, gated to `scope !== "none"`) · `FileTreeSidebar.tsx` L360–394 (local/branch scope chips, only rendered in diff mode) · `web-ui/src/preview/diffParser.ts`

Both pieces already exist, just gated off in plain-file mode. Fetch diff stats alongside the plain `getFile` call when `scope === "none"` and reuse the existing `summarizeDiffLines` memo; lift the local/branch chip group out of `FileTreeSidebar`'s header into a small shared component and render it in the `diffInfo` strip unconditionally (state is already shared via `diffScopeByWorktree` in the store). Hide both behind a width container query on narrow panes. **Mostly re-wiring existing pieces.**

### 8. Rendered markdown preview in diff view
**Files:** `web-ui/src/components/preview/MarkdownView.tsx` (react-markdown + remark-gfm + rehype-highlight) · `web-ui/src/preview/mdSegments.ts` · `FilePreviewPane.tsx` L223–251 (`isMd` branch) L71–75 (`scope === "branch"` fetch)

Rendering itself is fully solved already — the non-diff path renders markdown via `MarkdownView`/`mdSegments`. Add a Source/Rendered segmented control to the diff strip for `.md` files; "Rendered" reuses the existing non-diff markdown branch.

**Branch-scope note (per user, confirmed against code):** `scope === "branch"` in `VcsPanel.tsx`/`FilePreviewPane.tsx` already means "diff from `{baseBranch}`" — see `VcsPanel.tsx` L424 (`Diff from {baseBranch}`) and `FilePreviewPane.tsx` L200 (`"Compared to fork base"`), i.e. the *fork base*, not literally `origin/main`. Today, `scope === "branch"` only fetches the diff and explicitly sets `setFileBody(null)` (L71–75) — no file content is loaded. For the rendered-preview toggle to work in branch scope, it must fetch the file's content **as of the branch tip, diffed against that same fork-base**, i.e. reuse the identical base-ref resolution `VcsPanel`'s "Diff from {baseBranch}" already uses — not `HEAD`, not a hardcoded `main`. Concretely: extend the branch-scope fetch to also call `api.getFile` at the working-tree/branch-tip revision (same revision the existing diff endpoint already diffs against base), so content and diff stay consistent with the same base-branch model already established. This keeps #7's local/branch toggle and #8's rendered preview both anchored to the one "diff from base branch" concept already in use, rather than introducing a second, divergent notion of "branch diff."

### 9. Commit quick-diff view in VCS tab
**Files:** `VcsPanel.tsx` (`CommitRow` L117–194; `vcs-graph__meta` already shows `+ins/−del`) · `FileTreeSidebar.tsx` + `ChangedFileList.tsx` + `FilePreviewPane.tsx` + `FilesPanel.tsx` (master-detail shell to mirror) · `daemon/src/routes/worktrees.ts` L1134 (`GET /worktrees/:id/diff/*`, `scope=local|branch`), L1230 (`GET /worktrees/:id/changed-paths`)

Needs both ends. Daemon: extend the two existing routes with a `scope=commit&sha=<sha>` variant (`git diff --name-status <sha>^ <sha>` / `git diff <sha>^ <sha> -- <path>`) — small change, same branching shape already present. UI: add an overlay button to `CommitRow` (same slot as `vcs-graph__stats`); generalize `FilesPanel`'s tree+preview `PanelGroup` into a reusable master-detail shell parameterized by a `DiffScope` that can now carry a `sha` (`ChangedFileList`/`DiffView` are already scope-agnostic); swap the VCS body to that shell with a "Commits › commit #x" breadcrumb. Reuse #6's focus/keyboard construct for the file list. **Biggest lift of the ten — do after #7** (which already pushes toward a shared diff-scope selector).

### 10. Worktree sidebar +/− LOC indicator
**Files:** `web-ui/src/components/layout/LeftSidebar.tsx` (`wt-row__trail`/`wt-row__id`, e.g. L1691–1695, mirrored at L1125 and collapsed variants) · `daemon/src/routes/worktrees.ts` L1230 (`changed-paths` — name-status only, no line counts) · `daemon/src/services/git.ts` L488–561 (`listCommits`, per-commit `--numstat` only)

No existing per-worktree line-count source. Needs a new lightweight daemon endpoint, e.g. `GET /worktrees/:id/diffstat?scope=branch` running `git diff --shortstat <baseSha>`, polled on the same cadence as (or piggybacked onto) the PR poller. UI: render `+N −N` immediately before `wt-row__id` in `wt-row__trail`, hidden under a width threshold the same way `wt-row__id` already hides when collapsed. Reuse `vcs-graph__add`/`vcs-graph__del` colour tokens. **One of two items needing a new daemon endpoint** (the other is #9).

## Notable

- **#2 and #4/#5 are genuine root-caused bugs**, not missing features: a keyed-array reorder that defeats react-resizable-panels' ordering, and un-refcounted WS tree/file watchers that one consumer can tear down out from under another.
- **#3, #7, #8 mostly reuse code that already exists** (branch data, diff-stat memo, markdown renderer) — low risk, low cost.
- **#9 and #10 are the only items needing new daemon endpoints**; #9 is the largest single item and should follow #7 so it can reuse the same diff-scope selector.
- **#8's branch-scope fetch must anchor to the same "diff from base branch" concept `VcsPanel` already exposes** (`baseBranch`, "fork base"), not a second ad hoc notion of "branch" — see the note under #8.
