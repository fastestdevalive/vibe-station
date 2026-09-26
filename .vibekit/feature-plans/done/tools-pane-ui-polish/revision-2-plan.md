# Revision 2 plan — revert top-bar split, refine rail

Follow-up to the tools-pane redesign implemented in commit `0ae94a50` (`feat(web-ui): tools-pane redesign and asymmetric top-bar overlay`), based on live feedback after trying the UI. The rail/overlay work is liked and stays. The global top-bar split into a conventional-left/overlay-right zone (R8–R11, plus the top-bar-related part of R16) is **not** wanted and must be reverted — the top bar goes back to being a normal single full-width row above both panes, exactly as it was before this feature branch touched it.

`0976b531` is the last commit before any tools-pane-redesign work started (docs commits `5ca0667c`/`05a6b28a`/`3726a92a` in between are planning-doc-only, no code). Use it as the "before" baseline for the revert.

---

## 1. Revert — top-bar/full-height overlay

- **Delete** `web-ui/src/context/TopBarOverlayContext.tsx` entirely — it only exists to support the global overlay being reverted here.
- **Revert** `web-ui/src/components/layout/TopBar.tsx` to its pre-redesign, single full-width-row behavior (no `zone` prop, no left/right split, no overlay positioning). Compare against `git show 0976b531:web-ui/src/components/layout/TopBar.tsx` for the "before" shape.
- **Revert** `web-ui/src/components/layout/Layout.tsx`'s changes that made the agent pane and tools pane render full-height from `y=0` and moved the top-bar-left zone into the sidebar column. Restore the original single dedicated top-bar row sitting above both panes.
- **Revert** `web-ui/src/routes/Workspace.tsx`'s related restructuring (it changed by 113 lines in the redesign commit — most or all of that is top-bar-zone wiring).
- **Revert** `web-ui/src/components/layout/TabsStrip.tsx`'s inset-consuming changes — it no longer needs to read any top-bar-overlay inset.
- **Revert** `web-ui/src/components/layout/AgentPaneSlot.tsx`'s fixed-height-header-matching-top-bar change — not needed once the top bar isn't an overlay.
- In `web-ui/src/components/layout/ToolPanel.tsx`: remove the `useOverlayInset(panelRef)` call (from `TopBarOverlayContext`) and the `--tools-right-overlay-inset` custom property / its use in positioning `ToolFullscreenButton`. `ToolFullscreenButton` should just sit at the top-right of the tools pane's own top bar with simple fixed padding — no global-overlay-inset math, since there's no global overlay anymore.

A reasonable mechanical approach: `git diff 0976b531 HEAD -- web-ui/src/components/layout/TopBar.tsx web-ui/src/components/layout/Layout.tsx web-ui/src/routes/Workspace.tsx web-ui/src/components/layout/TabsStrip.tsx web-ui/src/components/layout/AgentPaneSlot.tsx` shows exactly what the redesign commit changed in these five files. Revert each to its `0976b531` state, then double-check nothing unrelated-but-wanted got reverted along with it (expected: nothing — these five files were only touched for the top-bar-overlay work in the redesign commit).

## 2. Keep — tool-pane-level changes (R1–R7)

No reverting needed for: `ToolPanel.tsx`'s rail/overlay-panel structure (minus the overlay-inset bits removed in §1), `web-ui/src/components/layout/FilesLeftRail.tsx` (further modified below), `web-ui/src/components/tools/FilesPanel.tsx`, `web-ui/src/context/ToolsInsetContext.tsx`, and the rail/expanded-panel CSS in `web-ui/src/styles/workspace.css`. These are the parts that were well-received.

## 3. Rail changes

a. **Remove "Files" as a standalone tool-selector entry.** There's no separate "Files" icon/button anymore — Tree/Search/Outline/References themselves are the entry points into the files tool; a distinct "Files" icon on top of those four was redundant.

b. **New rail order, top to bottom:**
   1. Tree
   2. Search
   3. Outline
   4. References
   — divider —
   5. Devices (disabled)
   6. Artifacts (**disabled — new**; previously only Devices was disabled, now Artifacts is too)
   7. VCS (enabled)

c. **Click behavior for Tree/Search/Outline/References:**
   - Always switches the tools-pane's active tool to "files" (main content area shows `FilePreviewPane`), even if Devices/Artifacts/VCS was previously active.
   - If that exact mode is already active *and* the expanded panel is open: closes the panel (press-active-icon-again-to-close — same rule as before, just no longer gated behind a separate "Files" selection).
   - Otherwise: opens the panel (if closed) in that mode, or switches mode if already open in a different one.

d. **Devices/Artifacts** (disabled): clicking does nothing, same non-clickable/grayed-out treatment for both now. **VCS** (enabled): clicking switches the main content area to the VCS panel; the Files expanded panel has no meaning here and should not appear over VCS content.

e. **Remove border-radius on the active/selected rail-button state.** The rail column is narrow enough that its buttons touch the column's left/right edges — a rounded active-highlight looks visually wrong there (rounded corners read well with surrounding space, not when flush against both edges). Use a square (no border-radius) active-state treatment instead — e.g. a solid fill and/or a thin accent bar on one edge, but no `border-radius` on the highlight itself.

f. **Re-introduce the split-orientation toggle** (vertical/horizontal — the old `Columns2`/`Rows2` button, `masterDetailVertical`/`setMasterDetailVertical` in the store) that used to live on the pre-redesign "Files" tab (see `git show 0976b531:web-ui/src/components/layout/ToolPanel.tsx` for exactly how it worked before). It's still needed, but its home is different now: put it on the **expanded side panel itself** (`FilesLeftPane`'s own overlay chrome — e.g. a small icon button in a corner of that overlay), not in the rail and not in any tab strip, since neither exists for this purpose anymore.

## Verification

- Typecheck, eslint, and the existing test suite green (update/add tests for the rail reorder, Artifacts-disabled, and the relocated split toggle).
- Visually confirm in the dev sandbox (already running at `http://localhost:7182`, hot-reload on `web-ui/src` edits):
  1. Top bar is back to a single full-width row, like before this feature branch.
  2. Rail shows Tree/Search/Outline/References on top, then Devices + Artifacts (both grayed out) then VCS below.
  3. The active rail icon's highlight has no rounded corners.
  4. The vertical/horizontal split toggle appears on the expanded side panel (not the rail, not a tab strip) and works.
  5. Clicking Tree/Search/Outline/References while VCS is active switches back to file preview + opens that mode.

## 4. Addendum — drag-resize + rail overlap (found during manual testing of revision 1)

a. **Restore drag-to-resize on the expanded side panel.** Before the original tools-pane redesign (commit `0ae94a50`), the tree/search/outline/references panel was resizable by dragging its edge (via `MasterDetailShell`'s `react-resizable-panels` split). The redesign replaced that with a fixed-width (`PANEL_WIDTH = 240`) overlay and lost the drag handle entirely. Restore drag-resize: add a resize handle on the panel's right edge; dragging it updates the panel's width (persist it the same way the old split width was persisted, e.g. per-worktree in the store), which then flows into `--tools-rail-panel-w` / `ToolsInsetContext` so the content pane's padding (where still applicable, see §4b) stays in sync live while dragging. The panel stays an **overlay** (`position: absolute`, per R4/R5) — only its width becomes user-adjustable, it does not become a real flex/grid split again.

b. **The rail must NOT be inset for — file preview draws full-width underneath it, overlapping.** Currently `ToolPanel.tsx`'s content body has `paddingLeft: RAIL_WIDTH` (36px) so `FilePreviewPane` avoids the rail. Remove that padding: `FilePreviewPane` should render at full width starting from `left: 0`, with the **rail floating on top of it** (rail's `z-index` stays above content, so it visually overlaps/covers the leftmost 36px of the preview — the preview draws *behind* the rail, it does not pad itself away from it). This is scoped to the **rail only** (36px icon column) — the wider expanded side panel from §4a is a different case: keep the content pane padding for that one (when the panel is open, the visible tree/search/etc. content should not have file-preview text rendering underneath it) — only the thin icon rail itself should have zero content-side inset.
