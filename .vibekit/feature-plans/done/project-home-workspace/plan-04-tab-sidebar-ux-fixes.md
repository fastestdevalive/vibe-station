# Small plan: project-home-workspace tab/sidebar UX fixes

> Follow-up to `plan-project-home-workspace.md` from live browser testing (sandbox :7174). Web-ui only, no daemon change.
> Paths are relative to `web-ui/src/` unless noted.

## Fixes

### 1. Tappable agent rows (Project tab)
- Root cause: bucket rows are plain `<div>`s with no handler (`components/layout/ProjectHomeTab.tsx:145-152`); the "Direct agents" rows are also bare `<div>`s (`ProjectHomeTab.tsx:280-286`).
- Fix, worktree rows: make the row a `<button type="button">` whose `onClick` calls the parent callback with `{ worktreeId: s.worktreeId, sessionId: s.id }`.
  - Reuse `handleAgentCreated` (`routes/Workspace.tsx:174-203`). It already calls `setActiveWorktree` and then `setActiveSession(sessionId)` before `navigate('/worktree/:id')`. That avoids the one-shot URL-sync gap described at `Workspace.tsx:167-173`. It's already passed in as `onWorktreeCreated` (`Workspace.tsx:799`).
  - Rename the prop `onWorktreeCreated` → `onOpenAgent` (`ProjectHomeTab.tsx:24,32`) because it now does both jobs. Don't hand-roll `navigate('/worktree/:wt/:sid')`, because that path is exactly the gap described above.
- Fix, direct rows: `onClick` → `openProjectAgentTab(project.id, s.id)` + `setActiveSession(s.id)`. This is the same pair the "New direct agent" handler already uses (`ProjectHomeTab.tsx:129-130`). The write effect then syncs the URL (`hooks/useProjectWorkspaceUrlSync.ts:86-96`).
- CSS: add `cursor: pointer`, a hover background, a `:focus-visible` outline and `width: 100%; text-align: left; font: inherit` for a button reset to `.project-home__worktree-row, .project-home__direct-row` (`styles/workspace.css:5379`).
- Test (`components/layout/ProjectHomeTab.test.tsx`):
  - Clicking a worktree bucket row calls `onOpenAgent` with `{ worktreeId, sessionId }`.
  - Clicking a direct row adds the id to `openDirectAgentTabsByProject[pid]` and sets `activeSessionId`.

### 2. Worktree shown in agent chip
- Root cause: bucket rows render only `sessionLabel(s)` (`ProjectHomeTab.tsx:148-150`). For a worktree's main session that label is `"main"`, otherwise `"Agent"` (`lib/sessionLabel.ts:19-23`). No worktree identifier is shown. The buckets are worktree-only (`ProjectHomeTab.tsx:56`), so every row has a `worktreeId`.
- Fix:
  - Look up `worktrees.find(w => w.id === s.worktreeId)`. The `worktrees` prop is already scoped to this project (`Workspace.tsx:798`, `ProjectHomeTab.tsx:32`).
  - Render a `project-home__wt-chip` span with `w.name ?? w.branch` before the session label, plus a `GitBranch` icon.
  - Move LeftSidebar's inner `worktreeLabel` (`components/layout/LeftSidebar.tsx:461-463`) into `lib/sessionLabel.ts` as an exported `worktreeLabel(w)`, and use it from both files so the naming never drifts.
- CSS: new `.project-home__wt-chip` (muted, `--font-size-xs`, pill border, `flex-shrink: 0`, ellipsis) in `styles/workspace.css` near `:5390`.
- Test: a bucket row for a session on worktree `{ name: null, branch: "feat/x" }` shows the text `feat/x`; with `name: "Fix login"` it shows `Fix login`.

### 3. "+" button creates a draft, not an immediate agent
- Root cause: the project-scope "+" resolves a mode and calls `api.createDirectSession(...)` right away (`components/layout/TabsStrip.tsx:961-989`). The worktree-scope "+" instead calls `api.createDraftSession({ target: "worktree", ..., draftConfig: { entryPoint: "tab" } })` (`TabsStrip.tsx:991-1011`).
- Confirmed: `CreateDraftSessionBody` accepts `{ target?: "direct"; projectId }` (`api/types.ts:220-229`).
- Confirmed: entryPoint `"tab"` hides the project and worktree fields in the composer (`components/draft/DraftComposer.tsx:825,849-857`).
- Confirmed: the daemon starts a `"tab"` draft as a direct session, with no worktree and no git gate (`rust/vst-routes/src/sessions.rs:1786,1815-1826,2017-2023`). Only the new-worktree path is git-gated (`sessions.rs:1851-1859`).
- How a worktree draft renders today:
  - It's a normal tab in the strip, with the `Draft` chip on drafting sessions (`TabsStrip.tsx:758-759,901`).
  - The agent pane swaps `PaneOutlet` for `<DraftComposer>` when the active session is drafting (`Workspace.tsx:652-676`, flag at `Workspace.tsx:76`).
  - The project pane has **no** drafting branch. It always renders `<PaneOutlet agent:<id>>` (`Workspace.tsx:787-788`), so a draft opened there would show a broken agent pane.
- Fix A, new helper `lib/projectDraft.ts` → `createProjectDirectDraft(api, projectId): Promise<Session>`:
  - It calls `api.createDraftSession({ target: "direct", projectId, type: "agent", draftConfig: { entryPoint: "tab", channel: "json" } })`, then `useServerStore.getState().applySessionCreated(s)`, then returns `s`.
  - It does **not** open the tab itself. See item 4 for the seed-order reason.
- Fix B, `TabsStrip.tsx:961-989`: replace the body with `const s = await createProjectDirectDraft(api, worktreeId); openProjectAgentTab(worktreeId, s.id); setActiveSession(s.id)`.
  - Delete the now-dead `noModes` state (`TabsStrip.tsx:172-175`) and the disabled/title props (`TabsStrip.tsx:956-957`).
  - Drop the `resolveDefaultModeId` import (`TabsStrip.tsx:34`) if nothing else uses it. `DraftComposer` picks its own first mode (`DraftComposer.tsx:219-222`).
- Fix C, `Workspace.tsx:787-788`: mirror the worktree branch at `:652-670`. When `activeSessionIsDrafting`, render `<DraftComposer key draftSessionId={activeSessionId} ...>` with:
  - `onStarted={handleAgentCreated}`. A `"tab"` start returns only a `sessionId` (same id, promoted in place), so `handleAgentCreated` navigates to `/project/:pid/:id` (`Workspace.tsx:204-214`), a no-op on the current URL. Do **not** null `activeSessionId` first the way the worktree branch does (`:659`). That would bounce the URL through `/project/:pid`.
  - `onDiscard`: `api.terminateSession(id)`, then `closeProjectAgentTab(projectId, id)`. The latter also nulls the active session (`hooks/useStore.ts:1048-1055`).
- Fix D (optional, same file): leave `agent:<id>` out of `projectPaneKeys` while a session is drafting (`Workspace.tsx:738-740`). That stops an offscreen `AgentPaneSlot` from mounting for a draft.
- **DECIDED (human confirmed):** the Project tab's own "New direct agent" button (`ProjectHomeTab.tsx:111-136`) must ALSO switch to opening a draft via `createProjectDirectDraft`, for consistency with the "+" button. Replace its `createDirectSession` call the same way as Fix B: `const s = await createProjectDirectDraft(api, project.id); openProjectAgentTab(project.id, s.id); setActiveSession(s.id)`. Remove the `resolveDefaultModeId`/`noModes` disabled-state plumbing from this button too, matching Fix B's cleanup — `DraftComposer` handles its own mode resolution once the draft tab is opened. Add a test: clicking "New direct agent" calls `createDraftSession` with `{ target: "direct", draftConfig.entryPoint: "tab" }`, never `createDirectSession`.
- Tests (`components/layout/TabsStrip.test.tsx`):
  - Rewrite `4.T5` (`:1658`): "+" calls `createDraftSession` with `{ target: "direct", projectId, draftConfig.entryPoint: "tab" }`, never calls `createDirectSession`, and the new tab shows the `Draft` chip.
  - Delete `4.T6` (`:1697`), since the no-modes state is gone.
  - Add to `routes/Workspace.test.tsx`: at `/project/p/:draftId`, `DraftComposer` renders instead of the agent pane.

### 4. Sidebar "+" menu's Agent option matches tab "+" behavior
- Root cause:
  - The menu's "Agent in project dir" item (`components/layout/ProjectPlusMenu.tsx:57-67`) is wired at `LeftSidebar.tsx:2319-2323` to `handleNewDirectAgent`.
  - `handleNewDirectAgent` creates an `entryPoint: "direct", useWorktree: false` draft and calls `gotoDraft` → `/draft/:id` (`LeftSidebar.tsx:1107-1125`). That's the global full-page composer, not a tab in the project workspace.
- Root cause (highlight): the sidebar only lists drafts whose entryPoint isn't `"tab"` (`LeftSidebar.tsx:1169`). Draft rows link to and highlight on `/draft/:id` (`LeftSidebar.tsx:1889,1893-1894`). `directSessionMap` skips drafts entirely (`LeftSidebar.tsx:280`).
- Fix, create:
  - `handleNewDirectAgent` → `const s = await createProjectDirectDraft(api, project.id); navigate(`/project/${project.id}/${s.id}`)`.
  - The URL-sync read effect then runs `seedProjectAgentTabsIfEmpty` → `setActiveSession(sid)` → `openProjectAgentTab(pid, sid)` in that order (`useProjectWorkspaceUrlSync.ts:80-82`). It accepts the draft because it is `worktreeId === null && type === "agent"` (`:58`).
  - Don't call `openProjectAgentTab` before navigating. It would make the entry non-`undefined`, and the seed (`useStore.ts:1060-1062`) would then skip the project's other existing direct agents.
- Fix, list: widen `draftsByProject` (`LeftSidebar.tsx:1169-1170`) to also include `entryPoint === "tab" && s.worktreeId === null` drafts, in the `direct` bucket. Worktree-tab drafts (with a `worktreeId`) stay hidden, as today.
- Fix, link and highlight: for those tab drafts, the draft row's `Link` (`LeftSidebar.tsx:1893-1894`) goes to `/project/${sess.projectId}/${sess.id}`, and `data-active` (`:1889`) compares against that same path. Legacy `"direct"` drafts keep `/draft/:id`.
- Fix, discard: `confirmDiscardSession` (`LeftSidebar.tsx:1129-1140`) should also handle `/project/:pid/:id`. When it matches, call `closeProjectAgentTab(pid, id)` and `navigate('/project/:pid', { replace: true })`, mirroring `confirmTerminateSession` (`:936-937`).
- After Start the session leaves `drafting`, so `directSessionMap` (`:280`) picks it up as a normal direct row on the same path. The highlight carries over with no extra work.
- Tests (`components/layout/LeftSidebar.test.tsx`; the plus menu has no coverage today):
  - Open the "+" menu and click "Agent in project dir". Assert `createDraftSession` is called with `entryPoint: "tab"` and `target: "direct"`, and the location is `/project/p/:id`.
  - A `"tab"` direct draft row renders with the `Draft` chip and `data-active="true"` at `/project/p/:id`.

### 5. Sidebar project-name tap target too small
- Root cause:
  - The name `<Link class="tree-row__project-link">` sits inside `.tree-row__project-main` (`LeftSidebar.tsx:1771-1801`).
  - `.tree-row` is `display:flex; align-items:center; min-height:32px` with `padding: var(--space-1) ...` (`styles/workspace.css:1949-1960`). The main wrapper is `inline-flex; align-items:center` (`workspace.css:760-768`), so it and the link are only as tall as one line of text.
  - The row's top and bottom padding, the extra height from `min-height`, the left padding and the `gap: var(--space-2)` beside the folder button are all dead zones.
  - `.tree-row` still shows `cursor:pointer` (`:1958`), which makes the dead zones look clickable. The row itself has only dnd `listeners`, no click handler (`LeftSidebar.tsx:1770`).
- Fix, JSX: switch to the stretch-link pattern every other sidebar row already uses (direct rows `LeftSidebar.tsx:1953-1962`, draft rows `:1893-1899`).
  - Render an empty `<Link className="wt-row__stretch-link" aria-label="Open project …">` that is absolutely positioned over the whole row (`workspace.css:894-902`, `inset:0; z-index:1`).
  - Move the visible `tree-row__label` span out of the Link and into `.tree-row__project-main`.
  - Keep `onClickCapture={suppressDoubleClickNavigation}`, `draggable={false}` and the mobile-close `onClick`.
- Fix, CSS:
  - `.tree-row--project { position: relative; }`.
  - Give `.tree-row--project .tree-row__project-expand` and `.tree-row--project .tree-row__action` `position: relative; z-index: 2`, so the folder toggle, "+" and "⋯" stay above the link (same trick as `.wt-row__trail`).
  - Delete the now-unused `.tree-row__project-link` rule (`workspace.css:785-800`) and its `:focus-visible` selector (`:808`).
  - Optional: raise the folder button's hit box to 28×28 (`workspace.css:770-783`). Today it's a bare 14px icon.
- Check the collapsed rail (`workspace.css:645-672`, a column layout): the stretch link covers the abbreviation chip, and "+" stays clickable through its z-index.
- Tests:
  - `LeftSidebar.test.tsx`: the project row contains a `.wt-row__stretch-link` with `href="/project/p"`.
  - `LeftSidebar.test.tsx`: clicking the folder button toggles expansion and does not navigate. The existing Decision 4 test should still pass.
  - Real hit area: check by hand in the sandbox (tap just above/below the name → `/project/:id`). jsdom can't test layout.

## Naming — DECIDED (human confirmed)
- Rename the pinned first tab from `"Project"` to **`"Overview"`**, with a small folder/home icon; collapse to icon-only on narrow screens.
- Update every site that hardcodes the label/expects it: `TabsStrip.tsx:722`, test `4.T3b` (`TabsStrip.test.tsx:1591`), and any other test asserting the literal text `"Project"` as the tab name (grep `Workspace.test.tsx` too). Also update the PRD's mockup text (`prd-project-home-workspace.md:110` and any other `Project` tab-strip references) so the doc matches shipped behavior — a one-line PRD edit, not a new PRD review cycle.
- Do not rename the route (`/project/:id` stays as-is) or the "Project tab"/"project workspace" terminology used in code comments/variable names (`isProjectView`, `ProjectHomeTab`, etc.) — only the user-visible tab LABEL changes.

## Verify
- `cd web-ui && npx vitest run src/components/layout/ProjectHomeTab.test.tsx src/components/layout/TabsStrip.test.tsx src/components/layout/LeftSidebar.test.tsx src/routes/Workspace.test.tsx src/hooks/useProjectWorkspaceUrlSync.test.ts && npm run typecheck`
- Then check by hand in the sandbox at http://localhost:7174 (`scripts/dev-sandbox.sh`): items 1–5 end to end.
