# Revision 4 plan — rail spacing, toggle icon direction, stacked-mode insets, VCS rail-driven sidebar

Follow-up to revision 3 (commits `e5996e12`, `ced0764a`, `b441a18b`, `279d95b4`). Five items, confirmed with the user via ASCII diagrams before writing this plan — see the "VCS states" section below for the agreed flow.

---

## 1. Remove top spacing above the first rail icon

`.files-left-rail` (in `web-ui/src/styles/workspace.css`, ~line 6569) has `padding: var(--space-1) 0`, which pushes the whole icon stack down before the first icon (Tree). Remove the top padding (`padding-top: 0`) — keep the bottom padding if removing both looks wrong, but the top gap specifically is the complaint.

## 2. Layout-toggle icon shows the wrong (next, not current) state

In `web-ui/src/components/layout/ToolPanel.tsx`, the split-orientation toggle currently renders `masterDetailVertical ? <Columns2/> : <Rows2/>` — i.e. it shows the icon for the state a click would *switch to*, not the state you're currently in. Swap it: render `<Rows2/>` (stacked look) while `masterDetailVertical` is `true` (currently stacked), and `<Columns2/>` (side-by-side look) while it's `false` (currently side-by-side). Leave the `aria-label`/`title` text as-is (those already describe the destination, which is correct for an action label) — only the icon direction is wrong.

## 3. Stacked-mode insets — every side-panel body needs its own 32px topbar + right inset

When the expanded side panel is in **stacked** (top) orientation, it spans the full width of the tools pane at `top: 0` — the same corner where the fullscreen button + orientation toggle float (`ToolPanel.tsx`'s `.tool-panel__top-actions`). Revision 3 already fixed this for `.files-topbar` (the open-file tabs bar) and `.preview-diffinfo` (the back/forward arrows), but each of the four side-panel bodies still has its own inconsistent header, none of which reserve space for those floating buttons:

- `FileTreeSidebar.tsx`'s `<FileTreeHeader>` 
- `SearchPanel.tsx`'s `.search-panel__controls`
- `OutlinePanel.tsx`'s `.outline-panel__header` (wrapping `.outline-panel__filter-box`)
- `ReferencesPanel.tsx`'s `.references-panel__header`

Normalize all four to a fixed height matching `.files-topbar` (32px, `box-sizing: border-box`), and give each the same right-side inset the `.files-topbar`/`.preview-diffinfo` fix from revision 3 uses (read from `useToolsInset()`/the top-actions cluster width) so their own content never sits under the fullscreen/toggle buttons when stacked. In left-side (non-stacked) orientation this inset should evaluate to 0 (or close to it) since the panel doesn't reach that corner in that mode — condition it the same way revision 3's `.files-topbar` fix already does (check that fix in `FilesPanel.tsx`/`FilePreviewPane.tsx` for the exact pattern to replicate here).

## 4 & 5. VCS gets the same rail-driven sidebar + topbar as Files

Confirmed flow (see diagrams below) — three states:

**State A — VCS active, no commit open (list view):** the commit log + PR badges + submodules status (today's entire `VcsPanel.tsx` content) fill the *full* content width, exactly like Files before a file tree/search/etc. has ever been opened. No sidebar content exists yet in this state — the rail's VCS icon has nothing to toggle here, and tapping it again is expected to be a no-op (same as any of the Files-mode icons before anything's been opened).

**State B — tap a commit → "navigate inside":** the sidebar (rail's overlay mechanism, same one Files uses) now shows that commit's changed-file list (`ChangedFileList`, what `VcsCommitView.tsx` already renders as its `leftPane`); the content area shows the diff (`FilePreviewPane`, `VcsCommitView.tsx`'s `rightPane`). This is `VcsCommitView`'s existing split — just wired through the rail's overlay+content mechanism instead of its own `MasterDetailShell` toggles.

**State C — tap the VCS rail icon again while a commit is open:** closes the sidebar (changed-file list hides), diff draws full width behind the rail — same overlap pattern as Files' rail (§4b from revision 2/3).

Returning from B/C to A is via the topbar's own back arrow (`DiffScopeSelector`'s `onBack`, already wired in `VcsCommitView.tsx`) — **not** the rail icon. The rail icon only opens/closes the sidebar *within* the commit view; it never exits the commit.

```
State A (list view, sidebar empty/not rendered):
┌──┬──────────────────────────────────────────────────────────────┐
│  │ VCS · <branch>                                    [⇕][⤢]      │
│T │──────────────────────────────────────────────────────────────│
│S │  ● <sha>  <message>                    <when>  <PR badge?>    │
│O │  ● ...                                                         │
│R │  ...                                                           │
│──│  Submodules: ...                                               │
│D │                                                                 │
│A │                                                                 │
│V │                                                                 │
└──┴──────────────────────────────────────────────────────────────┘

State B (commit open, sidebar open):
┌──┬────────┬─────────────────────────────────────────────────────┐
│T │← <sha>                                             [⇕][⤢]      │
│S │────────│─────────────────────────────────────────────────────│
│O │ <changed files tree/list>│  <diff for selected file>          │
│R │        │                                                       │
│──│        │                                                       │
│D │        │                                                       │
│A │        │                                                       │
│V │        │                                                       │
└──┴────────┴─────────────────────────────────────────────────────┘

State C (commit open, sidebar closed via 2nd VCS-icon tap):
┌──┬─────────────────────────────────────────────────────────────┐
│T │← <sha>                                             [⇕][⤢]      │
│S │─────────────────────────────────────────────────────────────│
│O │  <diff for selected file, full width, behind rail>            │
│R │                                                                 │
│──│                                                                 │
│D │                                                                 │
│A │                                                                 │
│V │                                                                 │
└──┴─────────────────────────────────────────────────────────────┘
```

**Implementation notes:**
- Remove the two redundant built-in toggles: pass `treeToggle={false} layoutToggle={false}` into `VcsCommitView.tsx`'s `<MasterDetailShell>` call (they currently default to `true`, which is where the extra "sidebar toggle" and "layout toggle" the user saw come from).
- Give `VcsPanel.tsx`/`VcsCommitView.tsx` a `.files-topbar`-equivalent top bar (32px, same right-inset treatment as item 3) — `VcsCommitView.tsx` already has a `topbarExtra` (the `DiffScopeSelector` back-arrow + commit breadcrumb) which should become (or move into) this shared-height topbar rather than whatever `MasterDetailShell`'s own topbar row currently renders it as.
- The VCS rail icon (`FilesLeftRail.tsx`) needs actual open/closed state now, mirroring the Files-mode icons' `aria-pressed`/press-again-to-close behavior — currently it's a plain radio-style tool-selector button with no notion of "open." This state should be scoped to "is a commit currently open + is its sidebar visible," independent of the Files rail-mode's own open/closed state.
- State A doesn't need a sidebar-open concept at all — don't force one into existence just for consistency; only build the toggle-close behavior for the commit-open case (State B → C), matching the agreed diagrams.

---

## Verification

- Typecheck, eslint, and the test suite green.
- In the sandbox (`http://localhost:7182`): (1) confirm no gap above the Tree icon; (2) confirm the orientation toggle's icon matches the *current* layout, not the one a click would switch to; (3) switch to stacked mode and confirm none of Tree/Search/Outline/References' own headers get covered by the fullscreen/toggle buttons; (4) open VCS, confirm the commit list fills full width with no sidebar; (5) open a commit, confirm sidebar (changed files) + content (diff) match State B; (6) tap the VCS rail icon again, confirm it collapses to State C; (7) confirm the two old `MasterDetailShell`-provided toggles are gone from the commit view.
