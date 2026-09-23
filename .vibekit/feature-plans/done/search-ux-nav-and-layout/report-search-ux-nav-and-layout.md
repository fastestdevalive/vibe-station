<!--
RULES — read before writing this report:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. ANSWER FIRST: the finding goes at the top, before any evidence
3. EVERY CLAIM CITED: file:line, a command + its output, or a screenshot
4. READING TIME: optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Report: Search UX keyboard nav (Enter/arrows/Escape) + restructuring Search into the Files tab

**Date:** 2026-09-17 · **Commit:** `4cb92f2` (branch `ide-track1-refine`) · **Scope:** `web-ui/src/components/tools/SearchPanel.tsx`, `ToolPanel.tsx`, `FilesPanel.tsx`, `FileTreeSidebar.tsx`, `FilePreviewPane.tsx`, `MasterDetailShell.tsx`, `useStore.ts`, `useWorkspaceKeyboardShortcuts.ts`, `useRovingListNav.ts`, `ChangedFileList.tsx`, `DiffScopeSelector.tsx`, `Dialog.tsx` · **Method:** full reads of the above, no code changed

## Answer

- **Item 1 (Enter → focus results, arrow nav):** the `useRovingListNav` hook (`web-ui/src/hooks/useRovingListNav.ts`) already implements exactly this contract and is reused verbatim by two unrelated list shapes (a tree and a flat list). It is directly reusable for `SearchPanel` — no new hook needed, just a flattened `RovingRow[]` derived from `results.files[].matches[]`.
- **Item 2 (Escape → back to input):** no global Escape handler exists in this codebase (`useWorkspaceKeyboardShortcuts.ts` has none); every existing Escape binding is a component-local `keydown` listener scoped to a stack-top check (`Dialog.tsx:62-70`). A local Escape handler on the results container is safe and precedent-consistent.
- **Item 3 (Search into Files tab, icon rail):** **recommended approach is a 3-pane restructure of `FilesPanel.tsx`** — icon rail | left-pane-with-mode-toggle (tree *or* search) | tabs+preview — built by adding a rail + mode switch around the *existing* `MasterDetailShell`, not by rewriting it. Search stays reachable **only** through the rail (remove `"search"` from `ToolPanel`'s `TABS`, keep the `ToolTab` union value for the store/`Mod+Shift+F` compat, repoint the shortcut to open Files tab + switch the rail to search mode). The live-preview-as-you-arrow behavior needs a **new "peek" concept**, distinct from `setActiveFilePathAtLine` (which unconditionally mutates the permanent tab strip) — reusing it as-is on every arrow keystroke would spam-open tabs and refetch the whole file per keypress.

## Evidence

| Claim | Source |
|---|---|
| Roving-cursor hook already generic over tree vs. flat list | `web-ui/src/hooks/useRovingListNav.ts:1-136`; consumers: `FileTreeSidebar.tsx:393-402`, `ChangedFileList.tsx:123-134` |
| No global Escape handler in the app | `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.ts:1-153` (no `"Escape"` anywhere) |
| Existing Escape handling is local + stack-scoped | `web-ui/src/components/dialogs/Dialog.tsx:62-70` |
| `Mod+Shift+F` currently opens the Search **tab** | `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.ts:124-128` |
| `setActiveFilePathAtLine` always mutates the permanent tab list | `web-ui/src/hooks/useStore.ts:898-919` |
| `openFileTabNew` / `setActiveFile` semantics (click vs. Ctrl-click) | `web-ui/src/hooks/useStore.ts:828-897`; call sites `FileTreeSidebar.tsx:377-385` (`openFile`) |
| `FilePreviewPane` fetch is keyed by `bodyKey` and cached (10-entry LRU), not free to call every keystroke | `web-ui/src/components/layout/FilePreviewPane.tsx:73-183` |
| `pendingFileLine` scroll-to-line is a fire-once effect keyed on the DOM being loaded | `web-ui/src/components/layout/FilePreviewPane.tsx:322-340` |
| `SearchPanel`'s click handler already routes through `setActiveFilePathAtLine` + tab switch | `web-ui/src/components/tools/SearchPanel.tsx:131-136` |
| Existing Local/Branch toggle lives in `FileTreeSidebar`'s header, shared via `DiffScopeSelector` | `web-ui/src/components/layout/FileTreeSidebar.tsx:475-501`, `DiffScopeSelector.tsx:36-58` |
| Existing "layout toggle" icon (stacked/side-by-side) already lives in `MasterDetailShell`'s topbar | `web-ui/src/components/layout/MasterDetailShell.tsx:104-127` |
| `ToolTab` union + tab array — only 2 call sites reference `"search"` | `web-ui/src/hooks/useStore.ts:8-10`, `ToolPanel.tsx:53-59,138-140` |
| `FilesPanel` currently composes `MasterDetailShell` with tree as `leftPane` | `web-ui/src/components/tools/FilesPanel.tsx:93-101` |
| Never-unmount invariant precedent (terminal) — same class of risk applies to swapping tree/search in place | `AGENTS.md` § "Terminal — never unmount TerminalPane during UI transitions" |

## Detail

### Item 1 — Enter moves focus into results, arrow nav

**Current state**
- `SearchPanel.tsx:149-157` — query `<input>`, `autoFocus`, no `onKeyDown`.
- `SearchPanel.tsx:232-251` — matches rendered as `<button className="search-panel__match-row">`, one per match, inside a per-file `<div className="search-panel__matches">`; no `tabIndex`/roving state at all today — every button is natively tabbable in DOM order (Tab, not arrow keys).
- `useRovingListNav.ts:46-136` — generic hook: takes `RovingRow[]` (`{path, expandable?}`), returns `{cursorPath, setCursorPath, handleKeyDown, isTabbable}`. `ArrowUp`/`ArrowDown` move without wrapping (`rows[idx±1]`, `undefined` at either end is a no-op — see Key Decisions). `Enter`/`Space` call `onOpen(cursorPath ?? rows[0].path)`.

**Proposed approach**
- Flatten `results.files[].matches[]` into `RovingRow[]` where `path` is a synthetic composite key (`${fileGroup.path}#${match.line}#${idx}` — match lines can repeat within a file for multi-column matches, so file path alone is not unique) — mirror `FlatRow` pattern in `FileTreeSidebar.tsx:66-70`, or add a `MatchRow extends RovingRow` in `SearchPanel.tsx` directly.
- Call `useRovingListNav(matchRows, { onOpen: (rowId) => focusPreview(rowId) })` inside `SearchPanel.tsx` — no new hook needed; the hook's list-shape assumption already fits (flat, ordered, keyed by a `path` string).
- Query input `onKeyDown`: on `"Enter"`, if `results` has ≥1 match, call `setCursorPath(matchRows[0].path)` and move DOM focus to that row's ref (mirror `FileTreeSidebar.tsx:406-410`'s "focus follows cursor" effect — a `rowRefs` map + `useEffect` on `cursorPath`). Do **not** wire the input's Enter through `handleKeyDown` from the hook itself — the hook's own `Enter` case means "open the cursored row," which is the wrong action from the input (nothing is cursored yet).
- Results container (the outer `<div className="search-panel__matches-list">`, new wrapping div needed — today matches are split per-file group with no single container): `onKeyDown={handleKeyDown}` from the hook, `tabIndex={-1}` (container itself not tabbable — matches `FileTreeSidebar.tsx:512`'s convention), each match row gets `tabIndex={isTabbable(row.path) ? 0 : -1}`.
- File-group header buttons (`search-panel__file-header`, `SearchPanel.tsx:220-230`) stay outside the roving set for v1 (see Key Decisions) — collapsing/expanding a group is a secondary action, not a nav target.

**Key design decisions and tradeoffs**
| Decision | Options | Recommendation |
|---|---|---|
| Where does the Enter-from-input handler live? | (a) on the `<input>` itself; (b) on a wrapping container catching bubbled events | **(a) input's own `onKeyDown`** — the transition ("leave input, enter list") is a property of the input, not the list; matches how `QuickOpen.tsx`-style dialogs typically wire this (input owns "commit/advance", list owns "navigate within") |
| Do file-group headers participate in roving nav? | (a) yes, headers are `RovingRow`s with `expandable: true`, arrow-through toggles them; (b) no, only match rows are in the roving set | **(b) for v1** — the ask is "up/down through *results*" (matches), and folding headers in doubles the row-shape work (composite ids, `onToggle` wiring) for a need not stated; revisit as a fast-follow if users want to collapse/skip whole files while navigating |
| Up at first result / Down at last result | (a) stop (hook's current default — `rows[idx-1]` is `undefined` at idx 0, so `setCursorPath` is skipped, cursor stays put); (b) wrap around; (c) Up-at-first moves focus back to the input | **(c)** for Up-at-first only (matches item 2's "Escape returns to input" spirit — Up is a natural way back too, VS Code's Quick Open list does this); plain **(a) stop, no wrap** at the bottom, since "search more" isn't a boundary action the way "back to input" is. This needs a **small addition to `useRovingListNav`** (an `onBoundary` callback fired when Up/Down finds no `prev`/`next`) or a local wrapper in `SearchPanel` that special-cases `idx === 0 && e.key === "ArrowUp"` before calling the hook's `handleKeyDown` |
| Reuse the tree's exact hook vs. a parallel search-specific hook | (a) reuse `useRovingListNav` as-is; (b) fork a new `useSearchResultsNav` | **(a)** — the row shape (`{path, expandable?}`) already fits flat lists (proven by `ChangedFileList.tsx`); forking would duplicate ~90 lines for no behavioral gain |

**Risks / things that could break**
- `useRovingListNav`'s `cursorPath` reset effect (`useRovingListNav.ts:75-81`) fires whenever `rows` changes identity — since `SearchPanel` recomputes `results` on every keystroke (200ms debounce, `SearchPanel.tsx:104-117`), the flattened `matchRows` array must be memoized (`useMemo` keyed on `results`) or the cursor will spuriously reset on every re-render even when the same rows are still present by content.
- Existing `search-panel__match-row` buttons have `onClick` only; adding `tabIndex`-driven roving focus changes their native Tab order — verify no existing test asserts Tab-order over these buttons (none found in scope of this report — see Not checked).

---

### Item 2 — Escape returns focus to the search bar

**Current state**
- No app-level Escape listener exists (`useWorkspaceKeyboardShortcuts.ts` has zero `Escape` references).
- Every existing Escape use is scoped and stack-aware: `Dialog.tsx:62-70` checks `openDialogs[openDialogs.length - 1] !== closeFn` before acting, then `e.stopPropagation()`.

**Proposed approach**
- Add `"Escape"` as a case inside the same results-container `onKeyDown` from item 1 (or a thin wrapper around the hook's `handleKeyDown` that intercepts `Escape` before delegating): on Escape, call `queryInputRef.current?.focus()` and `setCursorPath(null)` (so a later Enter re-seeds at row 0, not wherever the cursor last was — matches "returns to the search bar" as a clean reset, not a pause).
- `e.stopPropagation()` on this Escape handler, matching `Dialog.tsx`'s pattern — prevents any future ancestor Escape handler (e.g. a dialog Search is ever embedded in) from also firing.

**Key design decisions and tradeoffs**
| Decision | Options | Recommendation |
|---|---|---|
| Conflict with dialog Escape-to-close | None found — Search is not rendered inside a `Dialog.tsx` instance today | Note as a constraint if Search is ever surfaced inside a dialog/quick-open shell later: that dialog's Escape-to-close would fire on results-Escape too unless this handler `stopPropagation()`s, which the proposal already does |
| Reset cursor to null vs. keep it (so Enter resumes where you left off) | (a) clear cursor; (b) keep cursor, only move DOM focus | **(a) clear** — "returns to the search bar" reads as a full context reset to the user; keeping stale cursor state invisible to them is a latent surprise on the next Enter |

**Risks / things that could break**
- None identified beyond the (currently nonexistent) future-dialog case above.

---

### Item 3 — Search takes over the Files tab's left pane

**Current state — component tree today**
```
ToolPanel (tabs: Files | Devices | Artifacts | VCS | Search)
 └─ FilesPanel  (mounted only when toolPanelTab === "files")
     └─ MasterDetailShell (leftPane=FileTreeSidebar, rightPane=FilePreviewPane)
 └─ SearchPanel (mounted only when toolPanelTab === "search", sibling, fully separate)
```
- `ToolPanel.tsx:53-59` — `TABS` array drives the tab strip; `ToolPanel.tsx:130-140` conditionally mounts each panel body (Files and Search are mutually exclusive mounts today — switching tabs unmounts one, mounts the other).
- `FilesPanel.tsx:93-101` — `MasterDetailShell` given `leftPane={<FileTreeSidebar/>}`, `rightPane={<FilePreviewPane/>}`, plus `topbarExtra` = open-file tab strip + "+" button.
- `MasterDetailShell.tsx:101-151` — owns: tree-visibility toggle button (`fileTreeVisible`), stacked/side-by-side layout toggle button (`vertical`, per-worktree), the resizable `PanelGroup` split, and a `handleRightPanePointerDown` that refocuses the tree when the user clicks into the preview (`MasterDetailShell.tsx:52-70`).
- `FileTreeSidebar.tsx:475-501` — "Local/Branch" scope chips (`DiffScopeSelector`) + diff-view toggle button, both in the tree's own pane header — **this is the sketch's "Local/Branch" mini title bar**, already exactly where the sketch puts it (top of the left pane).
- File-open semantics (must be preserved): `openFile()` in `FileTreeSidebar.tsx:377-385` — plain click → `setActiveFile(path)` (replaces the active tab, "preview" semantics per `useStore.ts:828-877`'s comment "Replace active tab (tree-navigation intent)"); Ctrl/Cmd-click → `openFileTabNew(path)` (always appends a new permanent tab, `useStore.ts:878-897`). **This existing plain-click-replaces / Ctrl-click-pins duality already *is* the "peek vs. pin" pattern** the user is asking about for item 3 — it doesn't need to be invented, it needs to be extended to search-result focus-without-click.

**Proposed approach — target component tree**
```
FilesPanel
 └─ new: FilesLeftRail (icon-only, 3 buttons: layout-toggle, tree, search)
 └─ MasterDetailShell (leftPane = FilesLeftPane, rightPane = FilePreviewPane)  ← unchanged internals
     └─ new: FilesLeftPane (mode: "tree" | "search")
          - mode header (existing DiffScopeSelector row when mode="tree";
            SearchPanel's own query+toggles+glob controls when mode="search")
          - body: <FileTreeSidebar/> OR <SearchPanel/> (both ALWAYS MOUNTED, CSS-hidden
            when inactive — see risk below)
```
- **New store slice**: `filesLeftPaneMode: "tree" | "search"` (per-worktree, like `diffScopeByWorktree`) in `useStore.ts`, + `setFilesLeftPaneMode(worktreeId, mode)`. Rail buttons in `FilesLeftRail.tsx` (new file, `web-ui/src/components/layout/`) call this setter; the layout-toggle icon in the rail is **the same action** as `MasterDetailShell`'s existing `setMasterDetailVertical` button (`MasterDetailShell.tsx:117-127`) — do not add a second implementation, just relocate/duplicate the button into the rail and remove it from `MasterDetailShell`'s topbar (or keep both wired to the same store value — see Key Decisions).
- **`SearchPanel.tsx` changes**: split its render into "controls" (query input, toggles, glob — becomes the left-pane's mode-specific header, replacing the tree's `DiffScopeSelector` row when mode="search") and "results" (becomes the pane body). `worktreeId`/`api`/`scope` props unchanged.
- **Live preview without permanent tabs — the "peek" mechanism**:
  - Add a **new store field** `peekFile: { worktreeId: string; path: string; line: number } | null` (not reusing `pendingFileLine`/`activeFilePath`, which are "committed" state — see Key Decisions), and `setPeekFile()` / `clearPeekFile()` actions.
  - `FilePreviewPane.tsx` resolves what to show as `peekFile?.path ?? activeFilePath` (peek wins when set), and `peekFile?.line ?? null` feeds the existing scroll-to-line effect (`FilePreviewPane.tsx:322-340`) — that effect already scrolls-then-clears a line number, so it can drive from either source with a one-line change to which state field it reads.
  - As roving focus moves through search results (item 1's `cursorPath` changes), call `setPeekFile({worktreeId, path, line})` — **debounced** (150-250ms) so holding Down doesn't fire a fetch per row; `FilePreviewPane`'s existing `bodyKey`-keyed fetch + 10-entry LRU cache (`FilePreviewPane.tsx:73-183`) already absorbs rapid re-selection of recently-viewed files cheaply, but the *initial* fetch of an unvisited file is a real network round-trip worth debouncing at the source.
  - **Committing** a peek into a real tab happens only on: Enter/click on a result (existing `handleMatchClick`, `SearchPanel.tsx:131-136`, changed to call `setActiveFilePathAtLine` — today's behavior — instead of `setPeekFile`), or Ctrl/Cmd-click (routes to `openFileTabNew`, matching the tree's existing modifier-click convention exactly, per the "respect existing semantics" requirement).
  - On leaving search mode (rail switches back to tree) or clearing the query, call `clearPeekFile()` so the preview falls back to `activeFilePath` (whatever was last actually opened) rather than leaving a stale peeked file on screen with no way to tell it's uncommitted.

**Key design decisions and tradeoffs**
| Decision | Options | Recommendation |
|---|---|---|
| Does Search remain a top-level `ToolPanel` tab? | (a) keep both — tab AND rail icon; (b) remove `"search"` from `TABS`, rail is the only entry point | **(b)** — the user's ask is a replacement, not an addition; two entry points to the same feature with two different layouts (full-tab vs. rail-embedded) is confusing UI surface, and the sketch shows no separate Search tab remaining |
| `ToolTab` type / store shape when Search tab is removed | (a) delete `"search"` from the `ToolTab` union entirely; (b) keep it in the union (for persisted-state/migration compat) but remove it from `TABS` and never route to it | **(b)** — `useStore.ts` has version-migration code (`v6→v7` etc., `useStore.ts:1350-1538`) that defaults stale/unknown `toolPanelTab` values to `"files"`; removing the union member entirely risks a TS-widened `string` sneaking into old persisted state on load. Keep the type value, just stop emitting/reading it from `TABS`/routing — cheap insurance, matches this codebase's existing migration-defensiveness style |
| `Mod+Shift+F` behavior once Search isn't a tab | (a) drop the shortcut; (b) repoint it to `setToolPanelTab("files")` + `setFilesLeftPaneMode(activeWorktreeId, "search")` | **(b)** — same physical action ("get me to search fast") should keep working; `useWorkspaceKeyboardShortcuts.ts:124-128` becomes a 2-line change, need `activeWorktreeId` already available via `useWorkspaceStore.getState()` in that same file |
| Tree/search mount strategy when switching rail modes | (a) always-mounted, CSS `display:none` on the inactive one; (b) conditionally mount/unmount like `ToolPanel` does today between Files/Search tabs | **(a) always-mounted** — switching modes must not unmount `FileTreeSidebar` (it owns non-trivial async state: `expanded`, `childrenByPath`, git-status fetches, roving cursor) or `SearchPanel` (in-flight debounce/abort-controller state, scroll position in results) every time the user glances at search. This is the exact class of bug the `AGENTS.md` terminal invariant warns about — not a PTY stream, but the same "remount destroys live async/interaction state" shape. Unlike the terminal, there's no daemon-side stream to leak, so the risk is state-loss/flicker, not ghost connections, but the fix is identical: one stable tree position, toggle visibility with CSS/props, never a conditional `{mode === X ? <A/> : <B/>}` swap at the same slot |
| Where does the relocated layout-toggle button live — rail only, or rail + kept in `MasterDetailShell`'s topbar too? | (a) move it into the rail, remove from `MasterDetailShell` topbar; (b) leave it in `MasterDetailShell` topbar (it already applies regardless of tree/search mode, since it toggles the split orientation, not pane content) | **(b) leave it in `MasterDetailShell`, do NOT duplicate into the rail** despite the sketch showing 3 icons — re-reading the sketch's description, "layout-toggle" in the rail most plausibly maps to *this exact* existing control; moving it doesn't buy anything MasterDetailShell's topbar doesn't already give it (still visible in both modes), and duplicating the same store-backed toggle in two places is a maintenance hazard for one pixel of sketch fidelity. Flag this explicitly for the human to confirm against the actual sketch intent — this report's author cannot see the image |
| `peekFile` as new state vs. reusing `pendingFileLine`+`activeFilePath` | (a) new `peekFile` field, preview reads `peekFile ?? activeFilePath`; (b) keep calling `setActiveFilePathAtLine` on every arrow-move, accept the permanent-tab side effect | **(a)** — (b) is explicitly what the user flagged as likely wrong ("regular file semantics... should be respected"); committing a tab on every arrow-key tap violates "Ctrl-click / Enter = pin" semantics the tree already established. New minimal state is cheaper than teaching every `activeFilePath` consumer about a "provisional" flag on the existing field |
| Debounce vs. distinct peek/open events for the perf concern | (a) debounce `setPeekFile` calls (150-250ms) at the roving-nav callback; (b) no debounce, rely solely on `FilePreviewPane`'s content cache | **(a)** — the LRU cache (`FilePreviewPane.tsx:76-84`) only helps for files already fetched; the first arrow-key pass through N never-before-seen result files still fires N network requests without a debounce. Debouncing at the source is cheaper than teaching the cache to coalesce in-flight requests |

**Risks / things that could break**
- **Always-mounted tree+search doubles the "Files" pane's baseline async work** (git-status polling, `useTreeWatch`, search debounce timers) even when the user is looking at the other mode — acceptable (matches ToolPanel's existing model where Devices/Artifacts/VCS panels *do* fully unmount when not the active tab, so this is a net-new persistent-mount cost only for these two, not a regression of an existing invariant) but worth calling out for review.
- `MasterDetailShell.tsx:52-70`'s `handleRightPanePointerDown` refocuses "the roving-tabindex winner in `leftPaneRef`" via a generic `[tabindex='0']` query — this is mode-agnostic by construction (works whether the left pane currently renders tree rows or search-result rows), so no change needed there, but worth a regression check once `FilesLeftPane` wraps both.
- `SearchPanel.tsx:41-49`'s settings-persistence effect (`toggleAndPersist`) assumes one mount per "visit" (comment at `SearchPanel.tsx:23-26` explicitly says "SearchPanel remounts fresh each time, per ToolPanel's conditional render") — under the new always-mounted model this comment's premise (fresh mount re-reads settings from the daemon each time) becomes false; harmless (settings are just stale-if-changed-elsewhere, not wrong) but the comment needs updating so a future reader doesn't rely on remount timing.
- `ToolFullscreenButton` (`ToolPanel.tsx:107`) and `hidePanelControls`/canvas-tile portaling (`ToolPanel.tsx:23-38`) operate one level above `FilesPanel` — unaffected by this restructure, but any implementer should re-verify the tool-panel-in-canvas-tile path still renders correctly with the new rail, since that's a second render context for the same components.
- No existing test file covers `SearchPanel.tsx` or `FileTreeSidebar.tsx` keyboard nav in this repo snapshot (see Not checked) — item 1/2/3 all need new test coverage, not just updates to existing tests.

**Rough sequencing**
1. **Item 1 + 2 first, standalone, inside the existing tab-based Search** — smallest surface, no store/layout changes, immediately useful even if item 3 never ships. Validates the roving-nav-on-search-rows approach in isolation.
2. **`peekFile` store slice + `FilePreviewPane` read-side change**, still wired only to the existing (tab-based) `SearchPanel`'s `handleMatchClick`/roving-focus — proves the "peek vs. pin" split works before touching the panel layout.
3. **The rail + `FilesLeftPane` restructure** (`FilesPanel.tsx`, new `FilesLeftRail.tsx`/`FilesLeftPane.tsx`, `ToolPanel.tsx` tab removal, `Mod+Shift+F` repoint) — largest, most layout-risky change, done last once 1-2 are proven correct in the simpler host.

## Not checked

- No hand-drawn sketch image was available to this report (text description only, per the task prompt) — the rail's exact icon set/order and the "layout-toggle" icon's identity (recommended above as == the existing `MasterDetailShell` vertical/horizontal toggle) is an inference, not a confirmed reading; **flag for human confirmation against the actual image** before implementing.
- No existing test files for `SearchPanel.tsx`, `FileTreeSidebar.tsx` keyboard paths, or `MasterDetailShell.tsx` were found via targeted search in this pass — did not exhaustively enumerate the full `web-ui` test suite for indirect coverage (e.g. an integration test that types into search and asserts on tab state).
- Did not check `web-ui/src/components/layout/WorkspaceCanvas.tsx`'s tile-portal path for how `ToolPanel`/`FilesPanel` render inside a canvas tile beyond the one `grep` hit found — a second render context for the same component tree that a full implementation should re-verify.
- Did not measure actual network/render cost of the debounce recommendation (item 3) — the 150-250ms figure is a starting-point convention (matches `SearchPanel.tsx:108`'s existing 200ms query debounce), not a benchmarked value.

## Addendum — confirmed rail mockup (resolves Follow-up #1)

The user has confirmed the following ASCII mockup as their intended target layout for item 3. It resolves Follow-up #1 (rail icon meanings) below — treat it as ground truth over the report's own inference in the "Key design decisions" table for Item 3.

**Rail in "tree" mode** (current default Files experience, restructured):

```
┌───┬─────────────────────────┬──────────────────────────────────────────────┐
│ ▤ │ Files          [local][branch] ⇄ │ report.md ×  plan.ts ×  ⊕            │
│───│─────────────────────────│──────────────────────────────────────────────┤
│ ⊟ │ ▾ src/                  │  # Report: Search UX nav                     │
│   │   ▾ components/         │                                              │
│ 🔍│     ▸ dialogs/          │  ## Answer                                   │
│   │     ▸ layout/  ●cursor  │  - The finding, in 1-3 bullets...            │
│   │     ▸ tools/            │                                              │
│   │   ▸ hooks/              │  ## Evidence                                 │
│   │   useStore.ts        M  │  | Claim | Source |                         │
│   │ ▸ .vibekit/             │  ...                                         │
│   │                         │                                              │
└───┴─────────────────────────┴──────────────────────────────────────────────┘
  ↑                ↑                              ↑
  rail          left pane                   tabs + preview (unchanged)
 (3 icons)   (mode header: Local/Branch
              chip row, same as today's
              FileTreeSidebar header)
```

**Rail switched to "search" mode** — left pane swaps content, right pane stays live:

```
┌───┬─────────────────────────┬──────────────────────────────────────────────┐
│ ▤ │ [ setActiveFile▁▁▁▁▁ ] Aa .* \b │ useStore.ts ×  ⊕                     │
│───│  [ *.ts________________]│──────────────────────────────────────────────┤
│ ⊟ │ ▾ hooks/useStore.ts  3  │  898  setActiveFilePathAtLine: (worktreeId,  │
│   │    898: setActiveFile…  │  899    path, line) =>                       │
│▶🔍│    899:  (worktreeId,   │  900    set((s) => {                         │
│   │   ●cursor→ path, line)  │  901      const tabs = s.openFileTabs...     │
│   │    920: clearPendingF…  │                          ▲                   │
│   │ ▾ components/tools/     │                     preview auto-scrolled    │
│   │    Search.tsx ...  1    │                     + focused to the line    │
│   │                         │                     under the arrow-key      │
│   │                         │                     cursor (peek, not pinned)│
└───┴─────────────────────────┴──────────────────────────────────────────────┘
   ↑ rail: search icon now highlighted/active
```

Key behaviors encoded in this mockup:
- Rail (▤ layout-toggle, ⊟ tree, 🔍 search) is a persistent narrow strip, always visible, both modes.
- Left-pane header swaps: `Local/Branch` chips (tree mode) ↔ query input + `Aa .* \b` toggles + glob field (search mode) — same slot, different content.
- Right-pane tab strip + preview is shared and untouched by mode — search never opens its own preview area, it drives the same one Files always had.
- Arrow-key focus on a match (`●cursor→` above) updates the preview live via peek (no new tab, no `×` added to the strip) — only Enter/click commits a real tab.
- The "▤ layout-toggle" icon is understood to be the SAME existing stacked/side-by-side `MasterDetailShell` toggle, just represented in the rail — not a new/duplicate control.

**Note — this overrides one of the report's own recommendations:** the Item 3 decision table above recommended (b) "leave [the layout-toggle] in `MasterDetailShell`'s topbar, do NOT duplicate into the rail." The confirmed mockup instead shows the layout-toggle living IN the rail (as ▤, the first of 3 icons) with no second copy in `MasterDetailShell`'s topbar. Per the mockup's own annotation ("not a new/duplicate control"), the intended reading is **relocate** — move the existing `MasterDetailShell` toggle button into the rail, remove it from `MasterDetailShell`'s topbar — i.e. option (a) from that decision table, not (b). Downstream planning should follow the mockup (relocate to rail), not the report's original (b) recommendation.

This mockup was drawn from a text description of the original hand-drawn sketch only (the report's author, and the person who drew this mockup, never saw the actual image) — but the user has explicitly confirmed it matches their intent, so it should be treated as resolved design direction for Follow-up #1.

## Follow-ups — RESOLVED by user 2026-09-18

| # | Question | Why it matters | **Resolution** |
|---|---|---|---|
| 1 | Confirm the rail's 3 icons against the actual sketch (is "layout-toggle" really the existing stacked/side-by-side control, or a different action?) | Determines whether `MasterDetailShell`'s existing button is relocated, duplicated, or left alone | **Confirmed** — see the "Addendum — confirmed rail mockup" section above. The layout-toggle icon (▤) is the existing `MasterDetailShell` stacked/side-by-side control, **relocated into the rail** (removed from `MasterDetailShell`'s topbar, not duplicated). This overrides the report's own tentative recommendation (b) in favor of option (a). |
| 2 | Should file-group headers (collapse/expand) join the roving-nav set in a later pass? | Affects whether `RovingRow`'s `expandable`/`onToggle` machinery needs extending for search rows | **Yes, include from v1** — user wants file-group headers navigable via arrow keys, not deferred. `RovingRow`'s `expandable`/`onToggle` machinery needs to be wired for search rows now, not as a fast-follow. |
| 3 | Does `peekFile` need to survive a rail mode switch (tree→search→tree) or always clear? | Affects whether "leaving search mode" should restore the last *committed* file or the last *peeked* one | **Persist, don't force-clear** — user's read is that keeping the same peeked file visible across a tree↔search mode switch is the better experience. `clearPeekFile()` should NOT be called just because the rail mode changed; only clear peek on an actual query change / explicit reset. Preview falls back to `activeFilePath` only when there is no peek, not as a side effect of switching modes. |
