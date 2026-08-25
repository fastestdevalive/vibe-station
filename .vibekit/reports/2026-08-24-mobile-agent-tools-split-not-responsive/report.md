<!--
RULES — read before writing this report:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. ANSWER FIRST: the finding goes at the top, before any evidence
3. EVERY CLAIM CITED: file:line, a command + its output, or a screenshot
4. READING TIME: optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Report: Mobile — agent pane / tools panel split isn't responsive, reads as a stray scrollable strip

**Date:** 2026-08-24 · **Commit:** `13daa0042309ecadbb7a914b81dc7d2a2bb6e974` (unrelated to the `chat-thinking-scroll-send` working-tree changes on this branch — pre-existing bug) · **Scope:** `web-ui` mobile layout (`Layout.tsx`, agent-pane/tools-panel split) · **Method:** Docker dev sandbox (`scripts/dev-sandbox.sh up vs-55 5180`) + Playwright headless Chromium at a 390×844 mobile viewport (`isMobile: true, hasTouch: true`), against the demo-seeded dataset

## Answer

- Not a border bug: `Layout.tsx:238` (`toolsInSplit = showToolPanel && paneFullscreen !== "tools"`) never checks `isMobile`, so the desktop agent-pane/tools-panel `PanelGroup` split (58%/42%) still renders side-by-side on a 390px-wide phone screen whenever the Files/tools panel happens to be toggled on (its visibility persists per-worktree, so it can be "on" from a prior desktop session)
- Both panes get squeezed to ~227px / ~163px; text overlaps, the file tree wraps to one word per line, and several inner elements (tab strip, file tree, breadcrumb tabs) become independently horizontally-scrollable within their own cramped width — that's the "small area that's scrollable both directions"
- The colored status border (`chat.css:33-35`, `.agent-pane-slot--waiting_for_human`) is incidental — it outlines the squeezed left sliver, which is what made the bug visible
- The whole page/document does NOT overflow (`document.documentElement.scrollWidth` stays `390` — confirmed below), so this isn't a global viewport-overflow bug, it's several sub-regions independently overflowing inside their own too-narrow box
- `isMobile` is already plumbed into `Layout.tsx` and used for the left sidebar (`:186,328`) — it was just never wired into this second split, unlike the sidebar which correctly collapses to an overlay on mobile

## Evidence

| Claim | Source |
|-------|--------|
| `isMobile` computed once per route, from a real media query | `web-ui/src/routes/Workspace.tsx:75` — `const isMobile = useMediaQuery("(max-width: 768px)");` |
| `isMobile` passed into `Layout` and used for the sidebar only | `web-ui/src/components/layout/Layout.tsx:32,49,186,328` |
| The agent/tools split has no `isMobile` check anywhere | `web-ui/src/components/layout/Layout.tsx:238` — `const toolsInSplit = showToolPanel && paneFullscreen !== "tools";` |
| `PanelGroup` renders the 58/42 horizontal split unconditionally when `toolsInSplit` is true | `web-ui/src/components/layout/Layout.tsx:240-269` |
| Colored border is a separate, correctly-implemented feature (not the bug) | `web-ui/src/styles/chat.css:4-11,29-45` (`.agent-pane-slot`, `box-sizing: border-box` already set) |
| Reproduced at 390×844 mobile viewport: agent pane and files panel both squeezed side-by-side | `screenshots/02-mobile-agent-view-squeezed-split.png` |
| Mobile dashboard (list view, no split) renders correctly at the same viewport — confirms this is specific to the agent/tools split, not a global mobile-layout bug | `screenshots/01-mobile-dashboard-ok.png` |
| Document itself does not overflow — the bug is several inner regions each overflowing within their own squeezed box, not the whole page | `$ page.evaluate(() => document.documentElement.scrollWidth)` → `390` (viewport width, no page-level overflow) |
| Four inner elements independently horizontally-scrollable at the squeezed width: `.tabs-strip__scroll` (101px box, 353px content), `.tool-panel__tabs-scroll` (99px box, 304px content), `.files-topbar__tabs` (39px box, 154px content), and the unlabeled file-tree `[role=tree]` container (54px box, 156px content) inside `.files-panel > .tool-panel__body` | Playwright DOM query over `body *`, filtering `scrollWidth > clientWidth` elements with `overflow(-x): auto\|scroll` |

## Detail

### Root cause
- `Layout.tsx:238-269` builds `topRow` as a `PanelGroup` split between `agentWrapper()` (58%, min 25%) and `wrap(toolPanel)` (42%, min 18%) whenever `toolsInSplit` is true
- `toolsInSplit`'s only gates are `showToolPanel` (persisted visibility, not screen-size-aware) and `paneFullscreen !== "tools"` — no `isMobile` term
- Contrast with the sidebar just above it, which DOES branch: `{isMobile ? sidebarMobile : sidebarDesktop}` (`:186,328`) — collapses to a slide-over overlay instead of squeezing into the row
- Net effect: opening an agent session on a phone with the Files panel toggled on renders the full desktop IDE-style split, just proportionally shrunk, instead of one full-width pane

### What the squeeze does downstream
- Agent pane (`.agent-pane-slot`, ~227px wide): the `⇌ Rich Chat` channel-toggle overlay (`chat.css:50-56`, `position: absolute; top; right`) collides with the `📎 Attach files` button and the terminal's "[Agent paused, waiting for input]" banner text, all fighting for the same ~227px
- Files panel (`.files-panel`, ~163px wide): `[role=tree]` file names wrap to one word per line and the tree container itself picks up its own horizontal scrollbar (54px visible / 156px content) because tree-row indentation (`min-width: max-content` on the row wrapper) can't shrink further
- Both tab strips (`.tabs-strip__scroll`, `.tool-panel__tabs-scroll`) and the Files breadcrumb tabs (`.files-topbar__tabs`) also pick up independent horizontal scrollbars at their squeezed width — these are legitimate horizontal-scroll UI patterns at normal width, but at ~40-100px they read as broken/stray scrollable slivers

### Screenshots

**Mobile dashboard (390×844) — correct, no split, single column:**

![Mobile dashboard renders correctly](./screenshots/01-mobile-dashboard-ok.png)

**Mobile agent view (390×844) — agent pane + Files panel squeezed side-by-side, text overlapping, colored border outlining the narrow left sliver:**

![Agent pane and Files panel squeezed into a desktop-style split on a phone viewport](./screenshots/02-mobile-agent-view-squeezed-split.png)

## Not checked

- Whether other split surfaces have the same gap — `toolSplitOrientation === "vertical"` (stacked instead of side-by-side) was not tested at mobile width; a vertical split might already be less broken since both panes would at least span the full width
- The terminal dock split (`Layout.tsx:270-282`, agent/tools row stacked with the terminal dock) was not separately reproduced at mobile width — likely has the same missing-`isMobile` gap by the same pattern, not confirmed
- No fix implemented — this report is investigation only, per the user's request to identify the root cause, not to change code
- Real device testing (iOS Safari / Android Chrome) not done — Chromium headless only; touch-drag behavior on the resize handles at this width wasn't exercised

## Follow-ups

| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | Should mobile force `toolsInSplit`/`showTerminalDock` to `false` and instead render one full-width pane at a time (agent XOR tools, likely via a tab switcher), mirroring how the sidebar already collapses to an overlay via `isMobile`? | This is the actual fix — the split itself, not the border, is the bug; scope + UX (tabs vs. a toggle button) needs a decision before implementing |
| 2 | Does the terminal dock split (`Layout.tsx:270-282`) have the same missing-`isMobile` gap? | Not reproduced in this report — worth checking before scoping a fix, so one plan covers all affected splits instead of a second bug report later |
| 3 | Is `showToolPanel`'s persisted-per-worktree visibility itself mobile-appropriate, or should mobile always start with tools panel closed regardless of the desktop-set preference? | Affects whether the fix is purely layout (still splits, just responsively) or also touches what state mobile inherits from a desktop session |
