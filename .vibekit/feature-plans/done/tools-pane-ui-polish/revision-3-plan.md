# Revision 3 plan — fix drag-resize, fix preview-nav occlusion, resize search UI, relocate+fix orientation toggle

Follow-up to revision 2 (commits `a8556d3c`, `ae388cd6`, `72381123`), based on more live feedback after trying the UI. Four items, each independently verifiable in the dev sandbox (`http://localhost:7182`, hot-reload).

---

## 1. Drag-to-resize on the expanded side panel doesn't work

Reported as broken in the running app. Code-reading (`web-ui/src/components/tools/FilesPanel.tsx`'s `startResize`/`onMove`/`onUp`, `web-ui/src/components/layout/ToolPanel.tsx`'s `dragWidth`/`activePanelWidth`/`--tools-rail-panel-w` wiring, and `.files-left-pane-resize-handle` in `workspace.css`) looks structurally correct at a glance — width state flows through `onWidthDrag` → `setDragWidth` → `activePanelWidth` → the `--tools-rail-panel-w` custom property. That means the bug is likely something that only shows up at runtime, not from reading the diff — check things like:
- Is the handle element actually receiving the `mousedown` (z-index/stacking/overflow issue — `.files-left-pane-overlay` has `overflow: hidden` inline; the handle is `position: absolute; right: 0; width: 8px` inside it — confirm it isn't being clipped or covered by a sibling with a higher effective stacking order)?
- Is `document.body`'s cursor/user-select mutation interfering, or is some other global mouseup/mousemove handler (e.g. from a drag-and-drop library elsewhere in the tree) swallowing the events first?
- Is the CSS transition (`transition: isDragging ? "none" : "padding-left 0.15s ease"` on `.files-panel__content`) fighting the live width update visually even if the state is changing correctly — i.e. is the bug actually "it works but you can't see it move smoothly" rather than "it doesn't work at all"?

**Actually test this with a real simulated drag** (e.g. Playwright: `mouse.down()` on the handle, several `mouse.move()` steps, `mouse.up()`, then assert the panel's rendered width changed) in the sandbox rather than only reading code — reading the code already looked plausible, so the bug is presumably a runtime-only issue a static read won't surface.

## 2. File-preview header doesn't respect the rail inset — back/forward arrows get occluded

Root cause found: `web-ui/src/components/layout/FilePreviewPane.tsx`'s `diffInfo` (defined once around line 559, reused at lines ~602/611/715 for the too-large/error/normal render branches) contains `.preview-diffinfo` → `.preview-nav` with the Back (◀) / Forward (▶) navigation buttons. This renders as the first child of `.preview-pane`, which is inside `.files-panel__content` (`FilesPanel.tsx`). That content div's `paddingLeft` is `0px` whenever the expanded side panel is **closed** (§4b: preview draws full-width behind the rail, intentionally) — but unlike `.files-topbar` (which explicitly re-adds `paddingLeft: var(--tools-rail-w, 36px)` for itself when the panel is closed, at `FilesPanel.tsx` around line 350), nothing gives `.preview-diffinfo`/`.preview-nav` that same rail-clearing padding. So when the panel is closed, the Back/Forward buttons sit at `left: 0` and the rail (which floats on top, z-index 10) visually covers them.

**Fix:** In `FilePreviewPane.tsx`, consume `useToolsInset()` (from `@/context/ToolsInsetContext`, same hook already used in `FilesPanel.tsx`) and apply the identical padding rule used for `.files-topbar` — `paddingLeft: isPanelOpen ? 0 : railWidth` — to `.preview-diffinfo` (or a wrapping element around just the nav buttons, whichever is cleaner given the 3 reuse sites share one `diffInfo` variable, so fixing it once there covers all 3 branches).

## 3. Content-search UI sizing — match the compact filter-symbols sizing

The user likes `OutlinePanel.tsx`'s "Filter symbols…" input styling (`.outline-panel__filter-box`/`.outline-panel__filter-input` in `workspace.css` — `font-size: var(--font-size-xs)`, `padding: 4px 8px`, no fixed height, 14px search icon) and wants `SearchPanel.tsx`'s content-search controls resized to match: the query input (`.search-panel__input`), the three toggle buttons (`.search-panel__toggle` × 3 — Aa / .* / \b), and the glob filter input (`.search-panel__glob-input`). Currently these use `font-size: var(--font-size-sm)`, `padding: var(--space-2) var(--space-3)`, and the toggles have a hardcoded `min-width: 32px; height: 32px` — noticeably chunkier than the outline panel's filter box. Resize `.search-panel__input`, `.search-panel__glob-input`, and `.search-panel__toggle` (in `workspace.css`, around lines 5611–5715) to use the same `--font-size-xs` + compact padding as `.outline-panel__filter-input`/`.outline-panel__filter-box`, dropping the fixed 32px toggle height in favor of sizing to the smaller padding/content, same as the outline panel does. Keep the existing layout structure (input-wrap + clear button, toggles group, separate glob row) — this is a sizing/typography change, not a structural one.

## 4. Split-orientation toggle — broken (no-op) and needs relocating

The vertical/horizontal split-orientation toggle (`Columns2`/`Rows2`, `masterDetailVertical`/`setMasterDetailVertical`) currently lives in `web-ui/src/components/layout/FilesLeftPane.tsx` (~lines 37-77). It correctly reads/writes `masterDetailVertical` in the store, **but nothing else in the codebase reads that flag anymore** — `FilesPanel.tsx`'s overlay (`.files-left-pane-overlay`) and content padding are hardcoded to a left-side/width-based layout regardless of the flag's value. Since the old `MasterDetailShell`-based split (which this flag used to control — tree-above-preview vs tree-left-of-preview) was removed in the tools-pane redesign, toggling this flag today visibly does nothing, which matches the "not working" report.

Two things needed:
- **Make it actually work.** `FilesPanel.tsx`'s expanded-panel overlay needs to branch on `masterDetailVertical`: when `false` (default), keep today's left-side overlay (`left: var(--tools-rail-w)`, width-based, resize handle on the right edge, per revision 2). When `true`, render it as a **top-stacked** overlay instead (`top: 0` spanning full width minus the rail, height-based sizing instead of width, with the resize handle on its *bottom* edge instead of its right edge) — i.e. actually implement both orientations, not just move a currently-inert button. Reuse the existing `filesLeftPaneWidthByWorktree`/drag-resize mechanism conceptually but for height when stacked (a `filesLeftPaneHeightByWorktree` or repurpose the same field with an orientation-aware label — implementer's call, just keep it consistent and persisted).
- **Relocate it.** Per live feedback, move the control out of the expanded panel and into the top-right area, immediately to the **left of `ToolFullscreenButton`** (in `ToolPanel.tsx`'s `.tool-panel__top-actions` cluster) — same icon size/style as the fullscreen button, always visible (not gated on the panel being open, since it affects the panel's layout whether or not it's currently expanded).

---

## Verification

- Typecheck, eslint, and the test suite green (update/add tests for the orientation-toggle relocation + the now-functional stacked layout, and the preview-nav inset fix).
- In the sandbox: (1) actually drag the side-panel's resize handle and confirm the width visibly changes and persists after reload; (2) close the side panel, open a diff view, confirm the ◀/▶ back/forward buttons are NOT covered by the rail; (3) open the content-search panel and visually confirm its input/toggles/glob field now match the outline panel's compact sizing; (4) click the relocated orientation toggle (next to the fullscreen button) and confirm the expanded panel actually switches between left-side and top-stacked layout.
