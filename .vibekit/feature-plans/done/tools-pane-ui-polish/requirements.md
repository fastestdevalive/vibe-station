
# Requirements: Tools-pane redesign + Top-bar overlay revamp

**Roadmap source:** `.vibekit/reports/2026-09-22-roadmap-cli-parity-website-codenav-ui.md`, item **#6 — UI polish**, "Tools-pane redesign" sub-bullet. Scope here is that sub-bullet plus the additional Top-bar/overlay requirements given directly by the user. The other #6 bullets (`ArtifactsPanel` fake data, `QuickOpen`'s dead `>` command mode, login/loading `TopBar`'s hardcoded `isMobile={false}`) are **out of scope** for this doc — tracked separately, not touched here. The one #6 bullet that *is* in scope by explicit roadmap cross-reference is the Devices tool (Browser/Emulator sub-tabs) becoming a disabled **rail** icon instead of a disabled **tab** (superseded by this redesign) — see R7, corrected after review.

**Status:** Planning only. No code changes. Reviewed by an adversarial opus subagent (§ Review notes) and revised in response before being finalized.

---

## Current state (for reference)

- `ToolPanel.tsx` renders a horizontal tab strip (`TABS`: Files/Devices/Artifacts/VCS) plus `ToolFullscreenButton`, both in one `.tool-panel__tabs` row that consumes real layout height.
- `FilesLeftRail.tsx` is Files-tool-internal only: a 36px-wide column with a "Show/Hide file tree" toggle button plus Tree/Search/Outline/References mode buttons. It's a real flex sibling inside `FilesPanel.tsx`'s row (`.files-panel__row`), consuming real width.
- `FilesLeftPane.tsx` (tree/search/outline/references body) sits in `MasterDetailShell.tsx`'s `PanelGroup` (`react-resizable-panels`) as a genuine resizable split against the preview pane — real width consumed, not an overlay.
- The global `TopBar.tsx` is one full-width header row above `layout-main` (sidebar + main column), height ≈36px mobile / ≈32px desktop (`.top-bar__brand` 36px, `.top-bar--desktop .top-bar__brand` 28px + 2px padding). It renders left (sidebar toggle + breadcrumb) and right (Search icon, "More options" overflow, pane-visibility toggle — 3 icons total) in the same row, and this row occupies its own dedicated vertical space above both the agent pane and the tools pane.
- Agent pane (`AgentPaneSlot.tsx`) already has an overlay-style header (`.agent-pane-header--overlay`, absolutely positioned over the terminal, doesn't reserve space) for the terminal's live controls — this is the closest existing precedent for the overlay pattern being proposed here.
- Agent pane and tools pane are true `react-resizable-panels` siblings in one `PanelGroup` (`Layout.tsx`'s `topRow`), orientation horizontal (side-by-side) by default on desktop, vertical (stacked) by default on mobile unless the user has explicitly toggled `toolSplitOrientation`. **Tools is the first/top `Panel` in vertical mode regardless of desktop/mobile** (`Layout.tsx:288-327`) — not just a mobile default — and either pane can independently collapse to 0 / become hidden via the existing pane-visibility toggle, which changes which pane physically occupies the top-right corner. See R11 (coordinate-based inset, revised again per live feedback after the review) and Review notes #2.
- Workspace-canvas mode (`WorkspaceCanvas.tsx`) portals the same singleton `ToolPanel` instance into a tile via `PaneOutlet`/`PaneHostLayer` — any chrome change to `ToolPanel` needs to still fit inside a tile body, below the tile's own drag/close/fullscreen header row. The canvas container establishes its own CSS stacking context (`workspace-canvas.css:310`).
- Real current z-index values in use (corrected from initial draft, per review — see Review notes #5): 200 (`.pane-viewport-fullscreen`, the canvas fullscreen tile escape, **and** `.top-bar__overflow-menu` — all tied today), 300 (image zoom), 999 (CodeView backdrops), 1000 (dialogs, quick-open, LSP tooltips/popups), 1010, 2000 (dev-state simulator), 4000 (context menus). No documented scale/convention; these are ad hoc.
- No existing RTL support anywhere in the CSS. No `--inset-*` custom properties exist yet (fullscreen uses literal `inset: 0`).

---

## Requirements

| ID | Area | Requirement | Notes / edge cases |
|----|------|-------------|---------------------|
| R1 | Rail — tool selection | Remove `ToolPanel.tsx`'s horizontal tab strip (`TABS` array + its rendering). The left rail (today's `FilesLeftRail.tsx`) becomes the single control for **which tool is active** (Files / Devices / Artifacts / VCS), rendered as one icon **per tool, stacked vertically down the rail column** — not a horizontal bar. | The rail is no longer Files-internal-only; it moves up a level conceptually even though it stays visually inside the tools pane. Exactly one tool is always "active" (radio-group semantics — see R17) — there is no "no tool selected" state, so this group does **not** use toggle-on-second-press. |
| R2 | Rail — Files sub-modes | When the active tool is **Files**, the rail additionally shows the Tree/Search/Outline/References mode icons (today's existing 4, minus the removed standalone show/hide button), stacked below the tool-selector group with a visual divider. For any other active tool (Devices/Artifacts/VCS), this second icon group is not rendered — those tools have no left-pane concept. **These Files-mode icons are always visible whenever Files is the active tool, regardless of whether the expanded panel is currently open or closed** — only their active/highlighted state depends on whether the panel is open and in that mode. (Corrected per review — see Review notes #1: without this, once the panel is closed there is nothing left to click to reopen it, since R3 removes the old show/hide button entirely.) | Two visually distinct icon groups in one rail: tool-selector (always present, radio) and Files-mode (conditional on Files being active, but always rendered while it is — never conditionally hidden on panel-closed). |
| R3 | Rail — remove show/hide toggle | Delete the standalone "Show file tree" / "Hide file tree" button (`PanelLeftClose`/`PanelLeftOpen` in `FilesLeftRail.tsx`) entirely. Replace with **press-active-icon-again-to-close**: clicking a Files-mode icon that is already active (and open) closes the expanded `FilesLeftPane` (no mode icon shows as active/open, no left panel visible — but the 4 icons themselves remain visible per R2); clicking any other mode icon opens the panel in that mode (whether it was closed or already open in a different mode). | This only applies to the Files-mode icon group (R2), not the tool-selector group (R1) — you can't "close" the tools pane's active tool this way, only collapse Files' own left panel. |
| R4 | Rail & expanded panel — overlay, not layout | The rail and the `FilesLeftPane` it opens (tree/search/outline/references body) both become **overlays** positioned on top of the content pane (`FilePreviewPane`), not `react-resizable-panels` siblings. Neither consumes/resizes the content pane's real width — `MasterDetailShell`'s current genuine split for this pair is replaced. | Content pane keeps its full width in the layout tree; it visually avoids the overlay via padding (R5), except below the narrow-viewport breakpoint where it becomes a true non-padding overlay instead (R15). Losing the drag-to-resize behavior of the current split is an accepted tradeoff. |
| R5 | Insets mechanism | The rail (fixed width) and the expanded `FilesLeftPane` (when open) must expose their current combined width/height as CSS custom properties (e.g. `--tools-rail-w`, `--tools-rail-panel-w`) or via a layout context, so the content pane and the expanded panel itself can each pad/offset to avoid being visually covered. | Needs a single source of truth updated synchronously with open/close and any width changes — a React context provider scoped to the tools pane is preferable to prop drilling, given `ToolPanel`/`FilesPanel`/`FilePreviewPane`/`MasterDetailShell` are all separately-mounted siblings today. This provider must live **inside** the fullscreen wrapper (see R16), not outside it, so insets keep working when the tool pane is fullscreened. |
| R6 | `ToolFullscreenButton` relocation | Moves out of the (now-removed) tab-bar row to the right, overlaid on top of content. Its height must match the content pane's own top bar (`.files-topbar`, the bar holding open-file tabs) — that bar must reserve a right-side inset (padding or a `calc()` max-width on the tab-scroll region) so the button never covers tab content. When the global top-bar-right overlay (R9) is also present in the same corner (whichever pane's own top bar computes non-zero overlap per R11), the two must be explicitly ordered (fullscreen button innermost/closest to the content edge, top-bar-right overlay outermost, or vice versa) and their combined width is what the content's own top bar insets against — not just one of them. | Devices/Artifacts/VCS tools don't have a `.files-topbar` — needs a consistent per-tool "own top bar" concept (or the button floats independent of tab content for those tools, since there's nothing to cover there). |
| R7 | Devices as a disabled rail icon | Per roadmap #6's cross-reference: the **Devices** tool (which internally hosts the Browser/Emulator placeholder sub-tabs) becomes a **grayed-out, non-clickable rail icon** (not a tab) until its backend lands. Files and VCS are both fully functional today (`VcsPanel.tsx` is real git-log/PR/submodule UI, not a placeholder) and remain enabled, clickable rail icons. (Corrected per review — see Review notes #11: the initial draft wrongly listed "Devices/Artifacts/VCS" as disabled, conflating VCS — which is real — with Artifacts, whose fake-`SAMPLE`-data cleanup is a separate, out-of-scope #6 bullet.) | Artifacts' rail icon stays clickable under this doc's scope (its content still shows fake data until the separate fake-data fix lands) — flagged here as a known inconsistency to resolve in practice (ideally in the same PR that fixes the fake data, even though this doc doesn't own that fix), not something this redesign silently papers over. |
| R8 | Top bar — left zone | Left side keeps sidebar-toggle button + app/project name, in its own dedicated header row (not an overlay) sitting above the sidebar column. Its right edge must always align with the sidebar's right edge when the sidebar is open. When the sidebar is closed on mobile, the left zone shrinks to just the toggle button + OS window-chrome reservation (mac traffic lights), if present. | "Aligns with sidebar's right edge" means the left zone's width tracks the sidebar's current (possibly user-resized) width live, not a fixed value. |
| R9 | Top bar — right zone becomes overlay (desktop) | On desktop, the right zone (existing 3 icons: Search, "More options" overflow, pane-visibility toggle) stops occupying a dedicated full-width row and instead **overlays on top of** the agent pane and tools pane. **Both panes always render at full viewport height, starting at y=0 — neither pane's own size, position, or content ever shrinks or excludes space to make room for this overlay.** The overlay covers whichever pane happens to be underneath it; that pane's own top bar (not the pane itself) is what reserves the inset (R11). | Only the right zone becomes an overlay — the left zone (R8) is unaffected and keeps its own row above the sidebar. This creates an asymmetric top bar: conventional on the left, overlay on the right. **Does not apply on mobile** — see R9a. (Clarified per live feedback: earlier drafts implied the panes started *below* the overlay's row, which was wrong — they start at the very top, full height, always; only each pane's own top bar pads itself.) |
| R9a | Top bar — right zone stays in-row (mobile) | On mobile, the right zone does **not** become an overlay. The `☰` toggle already claims a full-width row on mobile (diagram 6); floating 3 icons over pane content on top of that saves no vertical space and would cover real content instead. Keep the 3 icons in that same row on mobile, collapsing Search + the pane-visibility toggle into the existing `⋯` overflow menu if the row gets too cramped, so at most 2 controls (`☰` and `⋯`) need to fit. All touch targets in this row must be ≥44px, not the current 32px desktop bar height. (New — see Review notes #7.) | This is a behavior fork on `isMobile`, matching the existing fork pattern already used elsewhere in `TopBar.tsx` (e.g. `crumbNode` vs mobile `top-bar__crumb--mobile-stack`). |
| R10 | Seam continuity + terminal interaction | Because the top bar's right zone no longer reserves its own vertical space over the panes (desktop only, per R9), each pane's own title-bar-equivalent (content pane's `.files-topbar`; agent pane's `.agent-pane-header--overlay`) must be resized to match the top bar's height, so the visual seam between "left zone row" and "pane's own bar + overlay icons" reads as one continuous bar. `.agent-pane-header--overlay` doesn't reserve space today (floats over the terminal at an arbitrary position) — this requirement forces it to adopt a fixed, top-bar-matching height for the first time. Must explicitly state whether xterm reserves space for this overlay (i.e. whether it triggers a `fit()`/resize of the terminal grid) or whether the overlay purely paints over the top rows — and must reaffirm the existing **`TerminalPane` never-unmount invariant** (AGENTS.md): this restructure must not change `TerminalPane`'s React tree position, or it will re-trigger the double-echo bug that invariant exists to prevent. (Extended per review — see Review notes #9.) | If xterm does reserve space, the terminal's usable rows shrink whenever the overlay is visible, which needs to be an intentional, tested tradeoff, not an accidental side effect discovered later. |
| R11 | Inset calculation — coordinate-based, sent to both panes | (Revised per live feedback, replaces the earlier "resolve target from layout state" framing of R11/R12.) The top-bar-right overlay exposes its own absolute bounding rect (e.g. via `ResizeObserver` + `getBoundingClientRect`, published through the same context/custom-properties mechanism as R5) to **every** pane's own top bar — both the tools-pane's `.files-topbar` and the agent-pane's `.agent-pane-header--overlay` receive it, unconditionally, not just "whichever one is the current target." Each receiving top bar independently computes its **own** needed inset as the actual geometric overlap between its own bounding rect and the overlay's rect. A pane whose top bar doesn't actually sit under the overlay (e.g. the agent pane's header when tools occupies that corner) computes zero overlap and reserves no inset on its own — no enumeration of "horizontal vs vertical, tools-visible vs collapsed" cases is needed, because the geometry answers it automatically for every orientation, collapse state, and pane-visibility combination. | This is a strictly more general replacement for the old "special-case which pane is the target" approach — implement it as one shared hook/utility (e.g. `useOverlayInset(overlayRect, ownRect)`) consumed by both top-bar-equivalents, not two independent implementations that could drift. |
| R13 | Canvas-tile compatibility | The rail-as-overlay (R1–R5) must still work when `ToolPanel` is portaled into a workspace-canvas tile (`WorkspaceCanvas.tsx`) — the rail/expanded-panel overlay renders inside the tile body, below the tile's own drag/close/fullscreen header row, without colliding with tile chrome. Tile fullscreen already uses its own `position: fixed; inset: 0` escape (distinct from `.pane-viewport-fullscreen`), and the canvas container establishes its **own CSS stacking context** (`workspace-canvas.css:310`) — any "fullscreen renders above the top-bar-right overlay" claim (R14) must be checked against *that* container's stacking context, not just the tile's own z-index number, since a descendant's z-index is meaningless once an ancestor establishes a new stacking context. (Corrected per review — see Review notes #5.) | |
| R14 | Z-index scale | Define explicit, documented z-index tiers for the three new overlays, using real current values as the baseline (§ Current state): `.pane-viewport-fullscreen`/canvas-tile-fullscreen/`.top-bar__overflow-menu` all currently tie at 200; other existing tiers are 300, 999, 1000, 1010, 2000, 4000. Concrete mechanism (per review — see Review notes #5): apply `isolation: isolate` on the tools-pane root so the rail (e.g. z-index 10) and the expanded panel `[P]` (e.g. z-index 20) only stack against each other, not against the rest of the app; give the top-bar-right overlay its own stacking context at roughly z-index 100, confirmed to render *below* `.pane-viewport-fullscreen` (200) so a fullscreened pane fully covers it (R16); and re-verify R13's canvas case against the canvas container's own stacking context specifically. | This repo has no z-index convention today — this redesign is a reasonable place to start one, scoped at least to these new overlays, with the exact numbers above as the concrete starting point rather than TBD. |
| R15 | Narrow-viewport degradation | (New — see Review notes #3.) Below a defined breakpoint, the fixed-sum-of-widths approach (rail + expanded panel + minimum content width) can exceed the available pane width — e.g. the tools pane's `minSize` is 18%, ≈65px on a 360px-wide phone, which is already narrower than the rail alone (36px) plus any non-zero expanded-panel width. Concrete rules: (a) expanded-panel width = `min(fixedWidth, paneWidth − railWidth − minContentWidth)`, never negative; (b) below a set breakpoint, the expanded panel drops the "pad the content" behavior entirely and becomes a true full-covering overlay with no reserved content padding, auto-closing itself the moment the user picks a file/result (so it never persists as permanently-covering chrome); (c) the file-tabs region and any other inset-consuming row use `max(0, …)` for its available width and moves overflowing tabs into an overflow menu rather than letting them shrink to unreadable/negative widths; (d) the rail itself must handle vertical overflow — 4 tool icons + up to 4 Files-mode icons + a divider is roughly 8 icons, needing ~270px of height, while 18% of a typical phone viewport height is only ~126px, so the rail needs to scroll or otherwise degrade gracefully when the pane is short, not clip silently. | Ground the specific pixel/percentage numbers above in real measurement during implementation — they're derived from today's `minSize`/icon-height values (§ Current state) and are illustrative, not to be treated as final without re-checking against the actual implementation's CSS. |
| R16 | Rail/expanded-panel state across fullscreen | (New — see Review notes #4.) Toggling the tools pane into/out of fullscreen must **preserve** the expanded panel `[P]`'s open/closed state and active mode, and must **not remount** it — remounting would lose in-progress state (file-tree scroll position, LSP outline expansion, in-flight search query) that has no reason to reset just because the pane's chrome moved to a different CSS box. The inset-exposing context/custom-properties from R5 must be provided from *inside* the fullscreen wrapper so they keep resolving correctly once fullscreened. Escape-key handling order when both are active: pressing Esc first closes `[P]` (if open); a second Esc then exits fullscreen — it should never take one Esc to do both at once, since that silently discards the "which mode was I in" context the user may still want after backing out of fullscreen. Diagram 7 (§ ASCII diagrams) is updated to show `[P]` open, since this is a state combination that must work, not an edge case to design around. | This mirrors the existing `TerminalPane`/`.pane-viewport-fullscreen` invariant (AGENTS.md: never unmount on a tree-position change) — the same principle now explicitly extends to the tools-pane's own rail/panel state. |
| R17 | Keyboard focus & accessibility | (New — see Review notes #8.) Once the rail, expanded panel, and top-bar-right cluster become overlays instead of normal document-flow elements, focus order must still follow logical DOM order: top-bar-left zone → top-bar-right overlay → agent pane → tools pane (rail → expanded panel → content) — if the top-bar-right cluster is portaled elsewhere in the DOM for CSS-overlay purposes, its *tab order* must still land in this position (e.g. via explicit `tabIndex` sequencing or DOM placement independent of visual position), not wherever the portal happens to attach. The tool-selector rail group (R1) is a `role="radiogroup"` with arrow-key navigation between icons; the Files-mode icon group (R2) uses `aria-pressed` (for the toggle-on-second-press open/closed state) plus `aria-expanded`/`aria-controls` pointing at the expanded panel. The expanded panel `[P]` is a non-modal overlay — it must **not** trap focus; pressing Esc while it has focus closes it and returns focus to the rail icon that opened it (consistent with R3/R16's Esc ordering). Anything visually hidden or covered by an overlay (top-bar-right icons during fullscreen; content pane underneath `[P]` in the narrow-viewport true-overlay case, R15) must be made properly inert (`inert` attribute / `aria-hidden` + un-focusable), not just painted over and still reachable by keyboard/screen reader. The top-bar-right cluster should sit inside a labeled landmark (`role="banner"` or `nav` with an accessible name). | |
| R18 | RTL & theming | (New — see Review notes #10.) RTL support is explicitly a **non-goal** for this redesign (matches current codebase state — no RTL anywhere today), but the new overlay CSS should use logical properties (`inset-inline-start`, `padding-inline-end`, etc.) instead of physical ones (`left`, `padding-right`) wherever there's no extra cost to doing so, since it costs nothing now and avoids a larger rewrite if RTL is ever added later. All three new overlays (rail, expanded panel, top-bar-right cluster) need opaque background color tokens (not transparent — they sit on top of arbitrary underlying content, including the terminal's own background) plus border/shadow tokens, all sourced from the existing theme-token system so they render correctly in both light and dark themes and over the xterm terminal's own background specifically. No bare hex values, per the existing project-wide rule (AGENTS.md § Status indicators applies the same "no bare hexes" rule to status colors — same rule, different surface). | |

---

## ASCII diagrams

Legend: `S` = sidebar, `TB-L` = top-bar left zone (own row), `TB-R` = top-bar right-zone overlay (floats, doesn't reserve space, desktop only per R9/R9a), rail = tool-selector (+ Files-mode) icon column stacked **vertically, always** (never sideways in a bar, in any of the cases below), `[P]` = expanded FilesLeftPane overlay, `[FS]` = `ToolFullscreenButton`.

*(Diagrams below are corrected from the initial draft per review — see Review notes #6: the rail's icons now run down the left column instead of sideways across a bar; panes are drawn starting flush with the very top of the viewport, consistent with "full viewport height"; diagram 1 now includes `[FS]`; and `[FS]`/`TB-R` are shown as two distinct, explicitly-ordered elements at the right edge per R6, not implicitly merged. Diagrams 4–6 were revised again after live feedback: the rail was still drawn sideways in those three even after the review pass — fixed to the same vertical column as 1–3, 7; and diagrams 1–3 were confirmed correct for "both panes start at y=0, full height, regardless of the overlay.")*

### 1. Desktop, sidebar open, horizontal split, rail closed

```
┌────────────────┬────────────────────────────────────────────────────────┐
│ ☰  Vibe Station│                                                         │
├────────────────┤ ← TB-L's own row ends here; panes below start at y=0    │
│                │┌──────────────────────────┬─────────────┬──────────────┐│
│  Project A     ││ AGENT PANE                │ TOOLS PANE                ││
│  Project B     ││ ╔════════════════════════╗│F│           [a.ts][b.ts]+ [FS][🔍][⋯][▭]│
│                ││ ║ (overlay header, live) ║│D│───────────────────────────┤│
│  Worktree 1    ││ ║                        ║│A│                          ││
│  Worktree 2    ││ ║    chat / terminal     ║│V│      file preview        ││
│                ││ ║                        ║│ │  (padded on the right    ││
│                ││ ║                        ║│ │   by [FS] + TB-R's       ││
│                ││ ╚════════════════════════╝│ │   combined inset width)  ││
└────────────────┘└──────────────────────────┴─┴──────────────────────────┘┘
   TB-L's right edge aligns exactly with S's right edge.  ^rail (36px,
   overlay — content pane is full-width underneath, padded to clear it)
   `[FS]` sits closer to the content edge; `TB-R`'s 3 icons sit outboard
   of it (order per R6 — could be reversed, but must be consistently one
   or the other, and the content's own top bar must inset for BOTH).
```

### 2. Desktop, sidebar open, horizontal split, rail open (Files tree/search expanded)

```
┌────────────────┬────────────────────────────────────────────────────────┐
│ ☰  Vibe Station│                                                         │
├────────────────┤┌──────────────────────────┬──┬───────┬──────────────────┐
│                ││ AGENT PANE                │F │[P]    │ TOOLS PANE       │
│  Project A     ││                           │D │───────│  [a.ts][b.ts] + [FS][🔍][⋯][▭]│
│  Project B     ││        chat / terminal    │A │ Tree  ├──────────────────┤
│                ││                           │V │ Search│   preview        │
│  Worktree 1    ││                           │  │ Outl. │  (padded left by │
│  Worktree 2    ││                           │  │ Refs  │  --tools-rail-w  │
│                ││                           │  │       │  + --tools-rail- │
│                ││                           │  │       │  panel-w, per R5)│
└────────────────┘└──────────────────────────┴──┴───────┴──────────────────┘
                                                ^rail  ^[P] expanded panel — BOTH overlay
                                                        the preview pane, which stays full-
                                                        width underneath and pads itself.
```
Pressing the already-active Files-mode icon (e.g. "Tree" again) collapses `[P]` back to case 1 — the 4 mode icons themselves stay visible (R2); there is no separate close button (R3).

### 3. Desktop, sidebar closed

```
┌──┬─────────────────────────────────────────────────────────────────────┐
│☰ │                                                                      │
├──┤┌──────────────────────────┬─┬──────────────────────────────────────┐│
│  ││ AGENT PANE                │F│ TOOLS PANE                          ││
│  ││                           │D│    [a.ts][b.ts]  +   [FS][🔍][⋯][▭] ││
│  ││       chat / terminal     │A│──────────────────────────────────────┤│
│  ││                           │V│           file preview               ││
│  ││                           │ │                                       ││
└──┘└──────────────────────────┴─┴──────────────────────────────────────┘┘
 ^TB-L shrinks to just the toggle (S is collapsed to width 0 / off-canvas)
```

### 4. Vertical stacking, rail closed

```
┌────────────────┬────────────────────────────────────────────────────────┐
│ ☰  Vibe Station│                                                         │
├────────────────┤┌───────────────────────────────────────────────────────┐│
│                ││F│      TOOLS PANE (top — default order in vertical    │
│  Project A     ││D│       mode, desktop or mobile; see R11)              │
│  Project B     ││A│                    [a.ts][b.ts]  +    [FS][🔍][⋯][▭]││
│                ││V├──────────────────────────────────────────────────  ││
│                ││ │              file preview                           ││
│                ││ │                                                      ││
│                ││─┴──────────────────────────────────────────────────  ││
│                ││ AGENT PANE (bottom — its own header overlay computes   ││
│                ││  ~zero overlap with TB-R here, per R11 — no inset      ││
│                ││  reserved; if tools collapses/hides, agent moves into  ││
│                ││  that corner and its overlap becomes non-zero instead) ││
│                ││                chat / terminal                        ││
└────────────────┘└───────────────────────────────────────────────────────┘┘
```
Rail icons (`F│D│A│V`) always run **vertically** down a column overlaid on the left edge of the tools pane's own content — never sideways in a bar — regardless of whether the tools/agent split itself is horizontal or vertical.

### 5. Vertical stacking, rail open

```
┌────────────────┬────────────────────────────────────────────────────────┐
│ ☰  Vibe Station│                                                         │
├────────────────┤┌───────────────────────────────────────────────────────┐│
│                ││F│[P]      TOOLS PANE (top)                             │
│  Project A     ││D├───────┐             [a.ts][b.ts]  +    [FS][🔍][⋯][▭]││
│  Project B     ││A│ Tree  │                                              │
│                ││V│ Search├──────────────────────────────────────────  ││
│                ││ │ Outl. │        preview (padded)                      ││
│                ││ │ Refs  │                                              ││
│                ││─┴───────┴──────────────────────────────────────────  ││
│                ││ AGENT PANE (bottom)                                    ││
│                ││                chat / terminal                        ││
└────────────────┘└───────────────────────────────────────────────────────┘┘
```
Rail + `[P]` overlay the tools pane's own preview only; the agent pane below is unaffected either way. Rail stays vertical, same as case 4.

### 6. Mobile, sidebar closed (minimal top-bar left side; TB-R stays in-row, per R9a)

```
┌───┬───────────────────────────────────────────────────┐
│ ☰ │                              [🔍] [⋯]              │ ← TB-R does NOT overlay on mobile (R9a) —
├───┴───────────────────────────────────────────────────┤    it's in-row here, same as today, just
│F│         TOOLS PANE (full width, stacked mode)          │    with the pane-visibility toggle folded
│D│                          [a.ts]  +                      │    into `⋯` if the row is tight. Targets ≥44px.
│A├───────────────────────────────────────────────────┤     │
│V│              preview                                │   │
│ │                                                       │   │
├─────────────────────────────────────────────────────┤   │
│  AGENT PANE                                              │
│              chat / terminal                             │
└───────────────────────────────────────────────────────┘
```
`TB-L` is just the `☰` toggle — no app/project name, no traffic-light reservation needed (mobile has no OS window chrome). Sidebar itself is off-canvas (opens as a drawer, unaffected by this redesign). Rail stays vertical here too — same column shape as every other case, just narrower overall screen around it.

### 7. Fullscreen tool pane, with `[P]` open (corrected per review — see Review notes #4/#6; this combination must work, not be undefined)

```
┌────────────────────────────────────────────────────────────────────────┐
│ F│[P]    │                              [a.ts][b.ts]  +        [FS exit]│ ← ToolFullscreenButton is the
│ D│───────│──────────────────────────────────────────────────────────────│   only right-edge control here —
│ A│ Tree   │                                                             │   TB-R's icons render BELOW this
│ V│ Search │              file preview (full viewport)                  │   surface in the stacking order
│  │ Outl.  │                                                             │   (z-index 200 vs ~100, R14) and
│  │ Refs   │                                                             │   so are fully covered, not
│  │        │                                                             │   independently visible.
└────────────────────────────────────────────────────────────────────────┘
```
The whole fullscreen viewport is the tools pane's own escape (`.pane-viewport-fullscreen`-equivalent, z-index 200) — it fully covers the sidebar, the global `TopBar`'s left zone, **and** the top-bar-right overlay. `[P]`'s open/mode state is preserved unchanged across the fullscreen toggle (R16) — it is not forced closed just because the surrounding chrome moved. Pressing Esc once closes `[P]` (returns to the state on the left half of case 6/case 2's diagram, still fullscreen); pressing Esc again exits fullscreen (R16's two-step order).

---

## Review notes (opus adversarial pass)

Reviewed by a `claude-opus` subagent against this doc's requirements table and diagrams. All 11 findings below were judged real issues and incorporated into the requirements/diagrams above (not just noted) — see the specific R-numbers each one maps to.

1. **Files panel had no way to reopen once closed.** R3 removes the show/hide button, but the initial diagram-1 caption implied the Files-mode icons only *appear* once the panel is expanded — combined, a closed panel had no control left to reopen it. Fixed in **R2**: the 4 Files-mode icons are always visible while Files is the active tool, open or closed; only the active/open highlight changes.
2. **R11 (horizontal inset) and R12 (vertical inset target) were both wrong in the same way** — hardcoding "tools pane" / "agent pane" as the inset target. `Layout.tsx:288-327` puts tools first in vertical mode regardless of desktop/mobile, not just as a mobile default, and either pane can independently collapse/hide via the existing pane-visibility toggle, changing which pane is actually in the top-right corner in *either* orientation. Originally merged into one "resolve the target from live layout state" rule; **revised again after live feedback** into the simpler, strictly more general **R11**: both panes' top bars always receive the overlay's bounding rect and compute their own inset from actual geometric overlap — no target enumeration at all, "which pane" falls out of the geometry automatically.
3. **Narrow viewports can drive the overlay's own width math negative.** The tools pane's `minSize` (18%) is ≈65px on a 360px phone — narrower than the rail alone (36px). Added **R15**: explicit `min()`/`max(0, …)` arithmetic, a breakpoint where the expanded panel drops to a true no-padding overlay that auto-closes on selection, tab overflow instead of shrink-to-nothing, and rail vertical-scroll handling for ~8 stacked icons in a short pane.
4. **Rail/`[P]` state and fullscreen weren't specified together.** Added **R16**: no remount, no state loss, inset context lives inside the fullscreen wrapper, and a defined two-step Esc order (close `[P]`, then exit fullscreen). Diagram 7 redrawn to show `[P]` open rather than omitting the combination.
5. **Z-index values in the initial draft were incomplete and one clashed.** Real values: 200 ties across `.pane-viewport-fullscreen`, the canvas fullscreen tile, *and* `.top-bar__overflow-menu`; also 300, 999, 1000, 1010, 2000, 4000 exist and weren't accounted for. Rewrote **R14** with `isolation: isolate` scoping for the rail/`[P]` pair, a distinct ~100 tier for the top-bar-right overlay (confirmed below 200 so fullscreen covers it), and a correction to **R13** noting the canvas container's own stacking context (`workspace-canvas.css:310`) is what must be checked, not the tile's z-index number in isolation.
6. **The diagrams contradicted R1/R9 as originally drawn** — the tool-selector icons ran sideways in a bar instead of down the rail, panes appeared to start below a `TB-R` row (contradicting "full viewport height"), and diagram 1 omitted `[FS]` entirely. All diagrams redrawn; `[FS]` and `TB-R` are now shown as two distinct, explicitly-ordered elements per **R6**.
7. **Mobile overlay saved nothing and covered content.** The mobile diagram already gives `☰` a full row, so floating 3 icons over pane content on top of that just covers real content for no space savings. Added **R9a**: keep the right-zone icons in-row on mobile, collapse into `⋯` if needed, ≥44px touch targets.
8. **Focus order, ARIA roles, and inert-content handling were unaddressed** for the new overlay elements. Added **R17**: DOM tab order independent of visual/portal position, `radiogroup` for tool selection, `aria-pressed`/`aria-expanded`/`aria-controls` for Files-mode toggles, no focus trap on `[P]`, `inert` (not just visual covering) for hidden content, landmark role for the top-bar-right cluster.
9. **Terminal-resize and never-unmount interactions weren't addressed** for the agent-pane header becoming fixed-height. Extended **R10** to require stating whether xterm's grid resizes in response, and to explicitly restate the existing `TerminalPane` never-unmount invariant so this restructure doesn't reintroduce the double-echo bug that invariant was written to prevent.
10. **RTL/theming had no guidance.** Added **R18**: RTL is a non-goal but use CSS logical properties anyway (no cost today), and require themed, opaque, no-bare-hex tokens for the three new overlay surfaces (consistent with the project-wide "no bare hexes" rule already applied to status colors).
11. **R7 named the wrong tools as disabled.** The roadmap's actual decision was Devices (which hosts the Browser/Emulator placeholders) — the initial draft wrongly listed "Devices/Artifacts/VCS," but `VcsPanel.tsx` is fully implemented (real git log/PR/submodule data), not a placeholder. Corrected **R7**: only Devices is a disabled rail icon; Artifacts' fake-data issue is separately tracked and out of scope, flagged as a known inconsistency rather than silently resolved here.
