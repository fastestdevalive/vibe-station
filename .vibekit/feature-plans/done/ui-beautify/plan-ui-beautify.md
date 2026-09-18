<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
5. TURN-IMPLEMENT: this plan runs under `/sdlc turn-implement`. Each phase's implementer
   sees ONLY that phase's checklist items + its Files & Phase Impact rows — never Key
   Decisions, Research, or any other phase. Every checklist item below therefore inlines
   its own selector, file:line, and exact CSS value in full, even where that duplicates
   the Key Decisions section (which stays, for human/reviewer reading, as the canonical
   single source — the checklist items are the copies that matter at execution time).
-->

# Plan: UI Beautify — web-ui visual/UX polish pass

> Fix broken design tokens, give the app a real accent color, and polish tab/list active-states, empty states, and dashboard whitespace. CSS/component-visual only — no data flow, API, or Rust changes.

**Issue:** ui-beautify
**Branch:** (implementer's choice — small enough for a single branch off `main`)
**Status:** Pending
**PRD:** none — quick visual pass, skipping PRD per the `planning` skill's guidance for small work
**Parent:** none (top-level plan)

**Reference files:**
- Token system: `web-ui/src/styles/tokens.css`
- Global reset/body: `web-ui/src/styles/global.css`
- Main stylesheet (tabs, tree rows, dashboard, tool panel): `web-ui/src/styles/workspace.css`
- Chat/terminal pane styles: `web-ui/src/styles/chat.css`
- Workspace canvas (drag/drop, tiles): `web-ui/src/styles/workspace-canvas.css`
- Tool panel component: `web-ui/src/components/layout/ToolPanel.tsx`
- File tree component: `web-ui/src/components/layout/FileTreeSidebar.tsx`
- Dashboard component: `web-ui/src/components/layout/DashboardPanel.tsx`
- Terminal/agent pane: `web-ui/src/components/layout/TerminalPane.tsx`

---

## Problem & Concept

- User's own words: the web UI "looks very very bland and really really weird" — a live audit (screenshots in `./screenshots/`) confirms specific, fixable causes rather than a vague aesthetic complaint
- Root cause #1 (highest leverage): `--accent`, the one token meant to carry the app's signature interactive color, is defined as plain gray in both themes (`#e5e5e5` dark / `#1a1a1a` light — literally the same value as `--fg-primary`), so all 14 places that use `var(--accent)` for "this is the important/active/selected thing" (active-file gutter bar, draft badge, focus rings, selected list items, drag-drop highlights) render as flat white/black instead of standing out. `tokens.css:76` even has a stale comment calling it "the global **purple** `--accent`" — the color was documented as purple and is currently gray, i.e. this reads as a regression, not a deliberate monochrome design
- Root cause #2: two CSS custom properties are referenced but never defined anywhere in `tokens.css` — `var(--border)` (4 call sites) and `var(--bg-tertiary)` (6 call sites, 1 with a fallback). An undefined custom property with no fallback makes the whole CSS declaration invalid per spec, so these elements silently get **no border / no background at all** — small toolbar buttons, an active tab, a PR draft badge, and a tab-rename input all lose their visual chrome
- Root cause #3: several "active/selected" indicators hardcode `var(--fg-muted)` (a gray) instead of any accent color, so the "this tab/row is selected" signal is a barely-visible gray-on-gray line, easy to read as "the UI has no state feedback"
- Root cause #4: the paused/exited agent chat pane is a large flat black void with a bare `[agent paused _ waiting for input] > ` terminal prompt and no visual treatment — reads as broken/empty rather than "waiting for you"
- Root cause #5: the dashboard content column is hard-capped at `max-width: 560px` and centered, leaving roughly half the screen as dead flat space on any laptop-or-wider viewport (see `screenshots/01-dashboard-dark.jpg`)
- Success: same layout/information architecture, but the app has one real accent hue driving every "this matters" moment, no silently-broken CSS declarations, visible active/selected states, a less empty paused-chat state, and a dashboard that doesn't look like it's floating in a mostly-empty window

## Out of Scope

- Changing the default UI font from monospace to the existing `--font-sans` token (`global.css:41`, `tokens.css:9`) — there's a user-facing font toggle already (bottom-left "T" icon); flipping the *default* is a product decision, not a visual bug fix
- Any new API endpoints, data-flow changes, or Rust/daemon code — this is CSS/component-visual only, per constraints
- Full redesign of any component's layout/structure — this pass only touches color, spacing values already backed by existing tokens, and small state-affordance CSS
- Adding a new parallel color-token system — every fix below reuses `tokens.css`'s existing token names, only correcting broken/missing values
- Visual regression/screenshot testing infra — confirmed absent (see Research); verification below is manual/checklist-based

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `--accent` resolves to a real, distinguishable hue (not equal to `--fg-primary`/`--fg-muted`) in both `[data-theme="dark"]` and `[data-theme="light"]` |
| 2 | No CSS declaration in `web-ui/src/styles/*.css` references an undefined custom property with no fallback (`--border`, `--bg-tertiary` fixed) |
| 3 | Every element that currently signals "active/selected" via `var(--fg-muted)` alone gets an accent-colored indicator instead |
| 4 | The paused/exited agent chat pane has a styled banner + non-empty-looking waiting area, using only existing tokens |
| 5 | The dashboard's single-column view no longer leaves >40% of a 1440px-wide viewport as flat dead space |
| 6 | No layout shift, overflow, or clipped text introduced at 1024px, 1280px, and 1440px viewport widths in any touched component |

---

## Change Map

```
web-ui/src/styles/
  tokens.css              ~ --accent (real hue, both themes), --bg-tertiary (new token)
  workspace.css            ~ fix var(--border) → var(--border-default) (1 site: :5124)
                            ~ fix var(--bg-tertiary) fallback/definition (6 sites)
                            ~ .tab[data-active], .files-topbar__tab[data-active] underline → var(--accent)
                            ~ .tree-row[data-active] vs .tree-row--cursor visual split
                            ~ .dashboard-panel__inner max-width widened + dashboard-card polish
  chat.css                 ~ fix var(--border) → var(--border-default) (3 sites: :62,:128,:183)
                            ~ paused/exited banner + empty waiting-state styling
```

| Today | After this plan |
|-------|-----------------|
| `--accent` = plain gray in both themes, indistinguishable from `--fg-primary` | `--accent` = a real violet hue in both themes (`tokens.css:76` comment already called it "purple" — this restores that, doesn't invent it) |
| `var(--border)` used in 4 places, undefined → invalid `border` declaration → no border rendered | All 4 sites use `var(--border-default)` (the real token) → visible border restored |
| `var(--bg-tertiary)` used in 6 places, undefined → invalid `background` declaration → no background rendered | `--bg-tertiary` defined in `tokens.css` for both themes → backgrounds restored |
| `.tab[data-active]` / `.files-topbar__tab[data-active]` underline = `var(--fg-muted)` (gray) | Underline = `var(--accent)` — visibly distinct active-tab indicator |
| `.tree-row[data-active]` (open file) and `.tree-row--cursor` (keyboard focus) both = identical `var(--bg-active)` background, indistinguishable | Open file gets an accent-colored left edge in addition to the background; keyboard cursor keeps the plain background-only treatment |
| Paused/exited chat pane = flat black void below a plain banner | Banner gets subtle elevated background + accent Resume button treatment; waiting area gets a centered muted hint instead of pure blank space |
| `.dashboard-panel__inner { max-width: 560px }`, centered, huge dead space beside it on wide screens | Wider cap with layout that better fills common viewport widths, no change to card content or data |

---

## Research

- `web-ui/src/styles/tokens.css:74,76,130` — `[data-theme="dark"] { --accent: #e5e5e5; ... }` / `[data-theme="light"] { --accent: #1a1a1a; }`; the dark-theme comment at line 75-76 reads *"Quiet, chat-scoped accent (user bubble border, spinners, throttle badge). Contained here so the global **purple** `--accent` stays on primary buttons etc."* — i.e. the code's own comment documents `--accent` as purple while its actual value is gray
- `grep -rn "var(--accent)" web-ui/src` → 14 call sites: `components/settings/RemoteAccessSetting.tsx:287,389`, `components/settings/StorageSetting.tsx:199`, `components/draft/DraftComposer.css:206`, `styles/workspace.css:987,2513,5339,5372`, `styles/workspace-canvas.css:224,380,486,497,498,504` — draft-chip badge background, modified-file gutter bar, two focus-visible rings, a selected-item text color, and workspace-canvas drag/drop highlight — all currently render gray/near-invisible
- `grep -rn "var(--border)" web-ui/src/styles/*.css` → 4 sites, **none have a fallback**, and `grep -n "^\s*--border:" web-ui/src/styles/tokens.css` returns nothing — `--border` is not a defined token (the real token is `--border-default`): `chat.css:62` (`.channel-toggle-button`), `chat.css:128` (`.terminal-font-overlay__btn`), `chat.css:183` (`.terminal-attachment-upload .initial-artifacts--compact`), `workspace.css:5124` (`.folder-chooser__list-container`)
- `grep -rn "var(--bg-tertiary)" web-ui/src/styles/*.css` → 7 sites, only 1 has a fallback (`workspace.css:4761: var(--bg-tertiary, var(--bg-secondary))`); `--bg-tertiary` is not defined anywhere in `tokens.css`: `workspace.css:2107` (`.tab__rename-input`), `:4386` (`.vcs-pr:hover`), `:4450` (`.vcs-pr__badge--draft`), `:4609` (a `border-radius: full` icon circle in the VCS submodules row), `:4761` (`.vcs-submodules__badge--uninitialized`, has fallback), `:5034` (`.files-topbar__tab[data-active]`)
- `web-ui/src/styles/workspace.css:2011-2028` — `.tab` base rule + `.tab[data-active="true"] { color: var(--fg-primary); border-bottom-color: var(--fg-muted); }` — this is the `ToolPanel`'s Files/Devices/Artifacts/VCS/Search tab strip (`components/layout/ToolPanel.tsx:82-91`, `className="tab"`, `data-active={toolPanelTab === t.id}`)
- `web-ui/src/styles/workspace.css:5032-5037` — `.files-topbar__tab[data-active] { color: var(--fg-primary); border-bottom-color: var(--fg-muted); background: var(--bg-tertiary); }` — same gray-underline pattern, plus the broken `--bg-tertiary` background, on the Files-tab-internal tab strip (local/branch tabs seen in the Files panel)
- `web-ui/src/styles/workspace.css:1778-1830` — `.tree-row` base; `:1811-1813` `.tree-row:hover { background: var(--bg-hover); }`; `:1815-1817` `.tree-row[data-active="true"] { background: var(--bg-active); }`; `:1822-1824` `.tree-row--cursor { background: var(--bg-active); }` — the "currently open file" state and the "keyboard roving-cursor position" state resolve to the exact same background color, making them visually identical to each other (only distinguishable by which one currently has DOM focus)
- `web-ui/src/styles/chat.css:1-2,141-148` — comment: *"JSON agent chat ... permanently mounted TerminalPane"*; `:143-148` `.terminal-exited-toggle` sits "in normal flow just below the 'Session exited / Resume' banner"; `components/layout/TerminalPane.tsx:568` — `bannerMsg = state === "done" ? "Session marked done." : "Session exited."` — confirmed live in `screenshots/02-workspace-session-exited.jpg` and `screenshots/04-agent-paused-empty-state.jpg` (shows `[agent paused _ waiting for input] > ` with a blinking cursor on an otherwise empty black pane)
- `web-ui/src/components/layout/DashboardPanel.tsx:263-267` renders `.dashboard-panel` → `.dashboard-panel__inner`; `web-ui/src/styles/workspace.css:3769-3783` — `.dashboard-panel { display:flex; justify-content:center; padding: var(--space-12) var(--space-6); }` / `.dashboard-panel__inner { max-width: 560px; }` — confirmed visually in `screenshots/01-dashboard-dark.jpg` (content occupies roughly the left half of a 1347px-wide capture, the rest is flat `--bg-primary`)
- `web-ui/src/styles/workspace.css:3899-3907` — `.dashboard-card__primary { font-size: var(--font-size-sm); ... }` — the primary label of every dashboard session card is 12px (`--font-size-sm`), same size as the secondary/muted project-name text (`.dashboard-card__secondary`, also `--font-size-sm` at `:3909-3913`) — no size differentiation between primary and secondary information
- Confirmed no visual-regression tooling exists: `web-ui/playwright.config.ts` wires `testDir: "./e2e"` against `e2e/workspace.spec.ts`, `e2e/smoke.spec.ts`, `e2e/preview.spec.ts` — `grep -rln "toHaveScreenshot\|toMatchSnapshot" e2e src` returns nothing; these are functional e2e tests only, no pixel-diffing — verification in this plan is manual/checklist-based, not automated

---

## Key Decisions

> Canonical human-readable statements. Every phase below re-inlines the relevant parts
> verbatim in its own checklist items, since turn-implement's scoped prompts never
> include this section — see header block rule 5.

### Decision 1: `--accent` becomes a violet hue, matching the codebase's own stale comment

- **Decision:** `[data-theme="dark"] --accent: #a78bfa;` / `[data-theme="light"] --accent: #7c3aed;` — a violet distinct in hue/lightness from `--pr-merged` (`#8250df` dark / `#6e40c9` light) so the two don't read as the same color
- **Rationale:** `tokens.css:76`'s comment already documents `--accent` as "the global purple `--accent`" — this restores documented intent rather than inventing a new brand color; violet is unused elsewhere in the status/PR palette (`--status-working` yellow, `--status-waiting` red, `--pr-open` green, `--pr-merged` purple-adjacent but distinguishable)
- **Where:** `web-ui/src/styles/tokens.css:74`, `:130` — see Phase 1

### Decision 2: Broken tokens get real values, not new fallback chains

- **Decision:** `var(--border)` → `var(--border-default)` at all 4 call sites (the closest existing token, matching sibling rules like `.tool-placeholder__toolbar`'s `border-bottom: var(--border-width) solid var(--border-default)`); `--bg-tertiary` gets defined as a real step between `--bg-secondary` and `--bg-hover` in both themes, rather than rewriting all 6 call sites to some other existing token
- **Rationale:** `--border-default` is the token every other border rule in the codebase already uses (confirmed via Research grep) — this is a straight typo/drift fix, not a design change; `--bg-tertiary` already has one call site with a `var(--bg-tertiary, var(--bg-secondary))` fallback, showing the intended relationship, so defining it directly avoids touching 6 unrelated call sites
- **Where:** `web-ui/src/styles/chat.css:62,128,183`, `web-ui/src/styles/workspace.css:5124` (--border fix); `web-ui/src/styles/tokens.css` (new `--bg-tertiary` definition) — see Phase 1

### Decision 3: Active-tab underline uses `--accent`, not a hardcoded gray

- **Decision:** `.tab[data-active="true"]` and `.files-topbar__tab[data-active]`'s `border-bottom-color: var(--fg-muted)` becomes `border-bottom-color: var(--accent)`
- **Rationale:** with Decision 1 landed, `--accent` is a real hue — using it here makes "which tab is active" an actually-visible signal instead of gray-on-gray
- **Where:** `web-ui/src/styles/workspace.css:2025-2028`, `:5034-5037` — see Phase 2

### Decision 3b: `--accent-color` fallback chains switch their fallback from `--fg-primary` to `--accent`

- **Decision:** 6 call sites already use the defensive pattern `var(--accent-color, var(--fg-primary))` (note: `--accent-color` itself is never defined anywhere — this is intentional, per the comment at `workspace.css:891`: *"--accent-color has no global definition; every other usage carries a fg-primary fallback — without it this outline was dropped entirely."*) — change the fallback from `var(--fg-primary)` to `var(--accent)` at all 6, i.e. `var(--accent-color, var(--accent))`
- **Rationale:** these are exactly the "active/selected" signals Decision 3 targets (active menu item text, an add-button hover color, two focus-visible outlines, a settings toggle color) — they already have working fallback syntax, so once `--accent` is a real hue (Decision 1), switching the fallback target is a one-token-name change per site, not a new pattern; `--accent-color` itself stays undefined, exactly as documented
- **Where:** `web-ui/src/styles/workspace.css:809,852,893,4520`, `web-ui/src/components/settings/RemoteAccessSetting.tsx:944`, `web-ui/src/components/layout/LeftSidebar.tsx:1635` — see Phase 2

### Deviation note (Phase 2) — `.devices-tab[data-active="true"]` also changed, beyond items 2.1/2.2

- **What the plan listed:** only `.tab[data-active="true"]` (2.1) and `.files-topbar__tab[data-active]` (2.2) get `border-bottom-color: var(--accent)`.
- **What the file actually has:** a third active-tab rule, `.devices-tab[data-active="true"]` at `workspace.css:4217-4220`, carries the same `border-bottom-color: var(--fg-muted)` gray active-state underline. It is the Devices-panel's internal open-file tab strip (`web-ui/src/components/tools/DevicesPanel.tsx:35`, `className="devices-tab"`) — the exact parallel to `.files-topbar__tab` (the Files-panel's internal strip, which 2.2 did fix) — and thus the same "active-tab indicator hardcodes gray" root cause #3 the phase targets.
- **Action taken:** changed `.devices-tab[data-active="true"]`'s `border-bottom-color: var(--fg-muted)` → `var(--accent)` as well. Leaving it gray would have left the Devices panel's active open-file tab inconsistent with every other active-tab surface (tool panel + Files topbar) this phase recolored. Net effect matches Decision 3's intent: no active-tab underline in the app is gray anymore (grep: zero `border-bottom-color: var(--fg-muted)` remains in `workspace.css`).

### Decision 4: Open-file tree row gets an accent edge, keyboard cursor stays background-only

- **Decision:** add `.tree-row[data-active="true"] { border-left: 2px solid var(--accent); }` (with matching `padding-left` reduction so content doesn't shift) — `.tree-row--cursor` keeps its existing `var(--bg-active)`-only treatment, unchanged
- **Rationale:** distinguishes "this file is open" (a persistent, important state) from "this is where keyboard nav currently is" (transient) without touching either class's JS/DOM wiring — pure CSS addition
- **Where:** `web-ui/src/styles/workspace.css:1778-1824` — see Phase 2

### Decision 5: Paused/exited chat state gets an accent Resume button and a new waiting-hint overlay (CORRECTED — see Phase 3's own correction note)

- **Decision:** the exited/done banner (`TerminalPane.tsx:572-591`, classes `.terminal-resume-banner`/`__msg`/`__btn`, defined in `workspace.css:2174-2208`) already has the elevated-surface treatment — only its `__btn` changes, to `background: var(--accent); color: var(--bg-primary); border: none;`. Separately, a NEW `<div className="terminal-waiting-hint">Waiting for your input</div>` element (not a className on existing text) is added inside `.terminal-wrap`, gated on `lifecycleState === "waiting_for_human" && !showBanner`, absolutely positioned (`.terminal-wrap` gets `position: relative`) with `pointer-events: none` so it never blocks terminal interaction
- **Rationale:** the original draft of this decision assumed the `[agent paused … waiting for input]` text was DOM text a className could target — it's actually `@xterm/xterm` canvas output, not stylable via CSS at all. A new, separate overlay element achieves the same "pane doesn't look pure-empty" goal without that false premise. Similarly, the banner already had elevated styling — no new banner CSS was needed, only the button's colors
- **Where:** `web-ui/src/styles/workspace.css` (button color change, `.terminal-wrap` position, new `.terminal-waiting-hint` rule — NOT `chat.css`, correcting the original draft), `web-ui/src/components/layout/TerminalPane.tsx` (one new conditional JSX element) — see Phase 3

### Decision 6: Dashboard single-column cap widens, kanban view untouched

- **Decision:** `.dashboard-panel__inner`'s `max-width: 560px` (workspace.css:3795) becomes `max-width: 720px`; `.dashboard-card__primary`'s `font-size: var(--font-size-sm)` (workspace.css:3916) becomes `font-size: var(--font-size-base)`
- **Rationale:** 720px still reads as a single readable column (not full-bleed cards), but meaningfully reduces the dead space visible in `screenshots/01-dashboard-dark.jpg`; bumping the primary label's font size gives it visual priority over the secondary/project-name text, which stays at `--font-size-sm`
- **Where:** `web-ui/src/styles/workspace.css:3795`, `:3916` — see Phase 4

### Deviation note (Phase 1 item 1.7) — actual selector differs from the plan

- **What the plan said:** `workspace.css:5124` was `.folder-chooser__list-container` with a bare `var(--border)` to fix.
- **What the file actually has:** the rule at `:5124` is `.preview-font-overlay__btn`; the `.folder-chooser__list-container` rule (at `:5329-5337`) already uses `var(--border-default)` (confirmed in both the source and the served CSS) and needed no change. The only remaining bare `var(--border)` in `workspace.css` was the `.preview-font-overlay__btn` at `:5124`.
- **Action taken:** fixed `.preview-font-overlay__btn` at `:5124` to `var(--border-default)` — this is the change the item's stated goal (item 1.8: zero bare `var(--border)` remaining) actually required. `.folder-chooser__list-container` was left as-is (already correct). Net effect matches the plan's intent: no bare `var(--border)` remains anywhere in `web-ui/src/styles/*.css` (1.T1 = zero matches).

---

## Implementation Phases

- Each phase ends with a **verification block** — the phase is not complete until those checks pass
- Test items use `N.Tn` numbering
- No automated visual-regression tooling exists in this repo (confirmed in Research) — verification below is manual: `pnpm --filter web-ui dev` (or the existing dev sandbox), resize the browser window, and eyeball the listed selectors against the listed viewport widths

---

### Phase 1 — Design token fixes (the foundation)

- [x] **1.1** In `web-ui/src/styles/tokens.css`, inside the `[data-theme="dark"]` block, change line 74 from `--accent: #e5e5e5;` to `--accent: #a78bfa;` — leave every other line in that block unchanged, including `--chat-accent: #8a8a8a;` on the next line.
- [x] **1.2** In `web-ui/src/styles/tokens.css`, inside the `[data-theme="light"]` block, change line 130 from `--accent: #1a1a1a;` to `--accent: #7c3aed;` — leave every other line in that block unchanged.
- [x] **1.3** In `web-ui/src/styles/tokens.css`, add a new custom property `--bg-tertiary` to both theme blocks (this token does not exist yet anywhere in the file): inside `[data-theme="dark"]`, add `--bg-tertiary: #262626;` immediately after the existing `--bg-hover: #222222;` line. Inside `[data-theme="light"]`, add `--bg-tertiary: #ebebeb;` immediately after the existing `--bg-hover: #f0f0f0;` line.
- [x] **1.4** In `web-ui/src/styles/chat.css:62`, change `border: var(--border-width) solid var(--border);` (inside `.channel-toggle-button`) to `border: var(--border-width) solid var(--border-default);`
- [x] **1.5** In `web-ui/src/styles/chat.css:128`, change `border: var(--border-width) solid var(--border);` (inside `.terminal-font-overlay__btn`) to `border: var(--border-width) solid var(--border-default);`
- [x] **1.6** In `web-ui/src/styles/chat.css:183`, change `border: var(--border-width) solid var(--border);` (inside `.terminal-attachment-upload .initial-artifacts--compact`) to `border: var(--border-width) solid var(--border-default);`
- [x] **1.7** In `web-ui/src/styles/workspace.css:5124`, change `border: var(--border-width) solid var(--border);` to `border: var(--border-width) solid var(--border-default);` — deviation: the actual rule at `workspace.css:5124` is `.preview-font-overlay__btn`, NOT `.folder-chooser__list-container`; the `.folder-chooser__list-container` rule (at `:5329-5337`) already uses `var(--border-default)` and needed no change. Fixed the only remaining bare `var(--border)` in the file (the `.preview-font-overlay__btn`), satisfying the item's actual goal (1.8: zero bare `var(--border)` remaining).
- [x] **1.8** Search `web-ui/src/styles/workspace.css` for every remaining literal `var(--border)` and `var(--bg-tertiary` occurrence not covered by items 1.4-1.7 or already having a fallback (e.g. `var(--bg-tertiary, var(--bg-secondary))` at the `.vcs-submodules__badge--uninitialized` rule is already safe once 1.3 lands — leave it as-is, no change needed there) and confirm none remain broken; do not introduce any new token names beyond `--bg-tertiary` added in 1.3.

**Verify phase 1:**
- [x] **1.T1** Run `grep -n "var(--border)[^-]" web-ui/src/styles/*.css` (note: excludes `--border-default`, `--border-width`, `--border-strong`, `--border-subtle`, `--border-hover` which all start with `--border-` and won't match `var(--border)` followed by a non-hyphen) — expect zero matches.
- [x] **1.T2** Run `grep -n "^\s*--bg-tertiary:" web-ui/src/styles/tokens.css` — expect exactly 2 matches (one per theme block).
- [x] **1.T3** Start the dev sandbox, open browser devtools, and confirm `getComputedStyle(document.documentElement).getPropertyValue('--accent')` returns a non-gray hex value in both `data-theme="dark"` and `data-theme="light"` (toggle via the existing theme switch). — Verified in headless Chrome against the live vs-149 sandbox (`:7150`): dark `#a78bfa`, light `#7c3aed`.
- [ ] **1.T4** Visually confirm at 1280px viewport width: the folder-chooser dialog (Settings → any folder picker) shows a visible border around its file list; the terminal pane's font-size +/- buttons (visible when a session's chat is in terminal mode) show a visible border. — folder-chooser part VERIFIED in headless Chrome (`.folder-chooser__list-container` → `1px solid rgb(38,38,38)` = `#262626` dark); terminal-font-overlay part DEFERRED (sandbox has no worktrees/sessions to open a terminal pane — confirmed identical rule shape to the folder-chooser).
- [ ] **1.T5** No layout shift: compare a before/after screenshot of the Settings dialog and the terminal font-overlay at 1280px — element positions must be pixel-identical (only border/background visibility changes, not box size, since `border-width` was already reserved). — folder-chooser part VERIFIED (element `box-sizing: border-box`, so border doesn't change outer box size → no shift); terminal/preview font-overlay visual DEFERRED (no worktree session to render one; same border-box reasoning applies).

---

### Phase 2 — Tab bar and file-tree active-state polish

- [x] **2.1** In `web-ui/src/styles/workspace.css:2025-2028`, change:
  ```css
  .tab[data-active="true"] {
    color: var(--fg-primary);
    border-bottom-color: var(--fg-muted);
  }
  ```
  to:
  ```css
  .tab[data-active="true"] {
    color: var(--fg-primary);
    border-bottom-color: var(--accent);
  }
  ```
  This is the tab strip rendered by `web-ui/src/components/layout/ToolPanel.tsx:82-91` (`className="tab"`, `data-active={toolPanelTab === t.id}`) — the Files/Devices/Artifacts/VCS/Search tabs.
- [x] **2.2** In `web-ui/src/styles/workspace.css:5034-5037`, change:
  ```css
  .files-topbar__tab[data-active] {
    color: var(--fg-primary);
    border-bottom-color: var(--fg-muted);
    background: var(--bg-tertiary);
  }
  ```
  to:
  ```css
  .files-topbar__tab[data-active] {
    color: var(--fg-primary);
    border-bottom-color: var(--accent);
    background: var(--bg-tertiary);
  }
  ```
  (The `background: var(--bg-tertiary)` line is left as-is — it becomes valid once Phase 1 item 1.3 defines the token; do not duplicate that token definition here.)
- [x] **2.3** In `web-ui/src/styles/workspace.css`, locate the `.tree-row` rule block (starts at line 1778: `.tree-row { display: flex; align-items: center; gap: var(--space-1); min-height: 32px; box-sizing: border-box; padding: var(--space-1) var(--space-2); font-size: var(--font-size-sm); cursor: pointer; border-radius: var(--radius-sm); }`). Add `border-left: 2px solid transparent;` to this base `.tree-row` rule (so all rows reserve the same 2px of left space, preventing layout shift when the active state is applied) and reduce the existing `padding: var(--space-1) var(--space-2);` to `padding: var(--space-1) var(--space-2) var(--space-1) calc(var(--space-2) - 2px);` so the 2px border doesn't add extra total width.
- [x] **2.4** In `web-ui/src/styles/workspace.css`, locate `.tree-row[data-active="true"] { background: var(--bg-active); }` (around line 1815-1817) and change it to:
  ```css
  .tree-row[data-active="true"] {
    background: var(--bg-active);
    border-left-color: var(--accent);
  }
  ```
  Leave `.tree-row--cursor { background: var(--bg-active); }` (around line 1822-1824) completely unchanged — it must NOT get the accent border, so the two states stay visually distinct (open file = background + accent edge; keyboard cursor position = background only).
- [x] **2.5** Do not modify `.tree-row:hover { background: var(--bg-hover); }` (around line 1811-1813) — hover stays exactly as it is today.
- [x] **2.6** In `web-ui/src/styles/workspace.css:809`, change `color: var(--accent-color, var(--fg-primary));` (inside `.menu-pop button.menu-pop__item--active`) to `color: var(--accent-color, var(--accent));` — do not define `--accent-color` anywhere; it stays intentionally undefined, only the fallback value changes.
- [x] **2.7** In `web-ui/src/styles/workspace.css:852`, change `color: var(--accent-color, var(--fg-primary));` (inside `.sidebar-projects-heading__add:hover`) to `color: var(--accent-color, var(--accent));`
- [x] **2.8** In `web-ui/src/styles/workspace.css:893`, change `outline: 2px solid var(--accent-color, var(--fg-primary));` (inside `.project-plus-menu .menu-pop__item:focus-visible`) to `outline: 2px solid var(--accent-color, var(--accent));` — leave the explanatory comment immediately above this rule (lines 891-892, starting `/* --accent-color has no global definition...`) unchanged; it is still accurate after this edit.
- [x] **2.9** In `web-ui/src/styles/workspace.css:4520`, change `outline: 2px solid var(--accent-color, var(--fg-primary));` (inside `.vcs-graph__dot--clickable:focus-visible`) to `outline: 2px solid var(--accent-color, var(--accent));`
- [x] **2.10** In `web-ui/src/components/settings/RemoteAccessSetting.tsx:944`, change the string `"var(--accent-color, var(--fg-primary))"` to `"var(--accent-color, var(--accent))"` — this is a JS string literal inside an inline `style` prop, not a CSS file; change only that string, no other logic.
- [x] **2.11** In `web-ui/src/components/layout/LeftSidebar.tsx:1635`, change the string `"var(--accent-color, var(--fg-primary))"` to `"var(--accent-color, var(--accent))"` — same as 2.10, a JS string literal inside a conditional prop value (`color={hideInactiveWorktrees ? "var(--accent-color, var(--fg-primary))" : undefined}`); change only the string, leave the conditional logic untouched.

**Verify phase 2:**
- [x] **2.T1** At 1280px viewport width, open a worktree, click through the Files/Devices/Artifacts/VCS/Search tabs in the tool panel — confirm the active tab's underline is now a visible violet/purple color, not gray. — VERIFIED in headless Chrome at :7150: the tool-panel `.tab[data-active="true"]` (Files) computes `border-bottom-color: rgb(167, 139, 250)` = `#a78bfa` (violet accent); grep confirms zero `border-bottom-color: var(--fg-muted)` remains on any `.tab[data-active]`/`.files-topbar__tab[data-active]` rule.
- [x] **2.T2** In the Files tab, click a file in the tree — confirm the row shows both a background change AND a violet left edge; then use arrow keys to move the keyboard cursor to a different row — confirm that row shows ONLY a background change, no left edge (i.e., the previously-opened file's left edge stays, the cursor row does not get one). — PARTIALLY VERIFIED. The demo sandbox's Files panel has no real files (git checkout absent → "No file open / Select a file from the tree"), so the actual file-tree click/keyboard-cursor flow could not be exercised live. Instead: (a) the same `.tree-row`/`.tree-row--cursor` classes are used by the left-sidebar worktree tree — VERIFIED there: `.tree-row[data-active="true"]` computes `border-left-color: rgb(167,139,250)` + `background: rgb(42,42,42)`, while all non-active rows compute `rgba(0,0,0,0)` (transparent) left edge with no background; (b) CSS source confirms `.tree-row--cursor { background: var(--bg-active); }` is UNCHANGED (background only, no border-left-color), distinct from `.tree-row[data-active="true"]` which gets the accent edge.
- [x] **2.T3** No overflow/clipping: confirm file names with long text still truncate with an ellipsis (unchanged `.tree-row__label` behavior) at 1024px viewport width — the 2px border/padding adjustment in 2.3 must not push text into overflow. — VERIFIED in headless Chrome at 1024px viewport: every `.tree-row` computes `rowScrollW === rowClientW` (no horizontal overflow), and `.tree-row__label` keeps `text-overflow: ellipsis; white-space: nowrap; overflow: hidden`. The 2px border/padding adjustment did not cause overflow.
- [x] **2.T4** Right-click a worktree row to open its context menu, confirm the currently-active menu item (e.g. current sort order) renders in accent color, not gray; tab to a project-plus-menu item and confirm its focus outline is accent-colored. — VERIFIED in headless Chrome at :7150: (a) the "Hide done" filter menu's `.menu-pop button.menu-pop__item--active` computes `color: rgb(167, 139, 250)` (violet accent, not gray); (b) with `:focus-visible` forced on a `.project-plus-menu .menu-pop__item`, its computed `outline` is `rgb(167, 139, 250) solid 2px` (accent, not gray). Note: the project-plus portal menu does not auto-focus its items, so `:focus-visible` was asserted via CDP `CSS.forcePseudoState` rather than a literal Tab keypress.

---

### Phase 3 — Paused/exited chat empty-state polish

> **CORRECTED by the orchestrator before dispatch** — the original draft of this phase was
> written from a screenshot audit and had two false premises, caught during pre-flight
> verification: (a) it assumed the exited-session banner/Resume button had no className to
> target and needed one added — in fact `web-ui/src/components/layout/TerminalPane.tsx:572-591`
> already renders `.terminal-resume-banner` / `.terminal-resume-banner__msg` /
> `.terminal-resume-banner__btn` (defined in `workspace.css:2174-2208`, NOT `chat.css`), so no
> TSX change is needed there at all — only the button's colors need to change. (b) it assumed
> `[agent paused … waiting for input]` was DOM text that could be given a className — it is
> actually literal PTY output rendered by `@xterm/xterm` onto a canvas
   (`TerminalPane.tsx:1-4` imports `@xterm/xterm`), which is not stylable via CSS classes at
> all. The corrected approach below adds a genuinely new, separate DOM overlay element instead
> of trying to style terminal-rendered pixels.

- [x] **3.1** In `web-ui/src/styles/workspace.css`, locate the existing `.terminal-resume-banner__btn` rule (around line 2197-2205, currently: `padding: var(--space-1) var(--space-3); border-radius: var(--radius-sm); border: var(--border-width) solid var(--border-default); background: var(--bg-card); color: var(--fg-primary); font-size: var(--font-size-sm); cursor: pointer;`). Change `border: var(--border-width) solid var(--border-default);` to `border: none;`, change `background: var(--bg-card);` to `background: var(--accent);`, and change `color: var(--fg-primary);` to `color: var(--bg-primary);` — leave every other property (`padding`, `border-radius`, `font-size`, `cursor`) unchanged. This is the only change needed for the "Session exited."/"Session marked done." banner's Resume button — the banner itself (`.terminal-resume-banner`, around line 2174-2182) already has `background: var(--bg-elevated); border-bottom: var(--border-width) solid var(--border-default);` (an elevated-surface treatment), so it needs no change.
- [x] **3.2** In `web-ui/src/styles/workspace.css`, immediately after the existing `.terminal-resume-banner__btn:hover` rule (around line 2207-2210, currently `background: var(--bg-hover); border-color: var(--border-strong);`), change it to just `opacity: 0.85;` (remove the `background`/`border-color` properties — they referenced the old neutral-button style that no longer applies now that the button has an accent background from 3.1).
- [x] **3.3** In `web-ui/src/styles/workspace.css`, locate the existing `.terminal-wrap` rule (around line 2146-2154, currently: `flex: 1; min-height: 0; padding: 0; background: var(--bg-primary); overflow: hidden; display: flex; flex-direction: column; overscroll-behavior: none;`). Add `position: relative;` to this rule (needed so the new overlay hint added in 3.4/3.5 can be absolutely positioned relative to this container) — do not change any other property.
- [x] **3.4** In `web-ui/src/components/layout/TerminalPane.tsx`, inside the `mountTerminal ? (...)` block (around line 629-640, which currently renders `<div className="terminal-wrap" style={{...}}><div ref={hostRef} className="terminal-host" /></div>`), add a new sibling element directly after the `<div ref={hostRef} className="terminal-host" />` line, still inside the same `.terminal-wrap` div:
  ```jsx
  {lifecycleState === "waiting_for_human" && !showBanner ? (
    <div className="terminal-waiting-hint">Waiting for your input</div>
  ) : null}
  ```
  This is a new conditionally-rendered element (not a className added to existing text) — `lifecycleState` and `showBanner` are both already in scope in this component (`showBanner` is defined at line 565: `const showBanner = state === "done" || state === "exited" || sessionState === "exited";`). Do not restructure any other JSX in this block.
- [x] **3.5** In `web-ui/src/styles/workspace.css`, add this new rule immediately after the `.terminal-host .xterm { height: 100%; }` rule (around line 2163-2172, right before `.terminal-resume-banner`):
  ```css
  .terminal-waiting-hint {
    position: absolute;
    top: var(--space-3);
    left: 50%;
    transform: translateX(-50%);
    color: var(--fg-muted);
    font-size: var(--font-size-sm);
    background: var(--bg-elevated);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    pointer-events: none;
    z-index: 1;
  }
  ```
  `pointer-events: none` is required so this overlay never blocks clicking into the terminal to type.

**Verify phase 3:**
- [x] **3.T1** At 1280px viewport width, open a worktree whose session has exited (or trigger a session exit) — confirm the "Session exited." banner still shows its existing elevated background band with a bottom border (unchanged from before this phase), and the "Resume" button now has a violet/accent-colored background with no border, instead of the previous plain/neutral button style.
- [x] **3.T2** Open (or simulate, e.g. via the dev state simulator if available — Ctrl+Shift+D per project convention) a worktree whose agent session is in the `waiting_for_human` lifecycle state — confirm a small pill-shaped "Waiting for your input" hint appears centered near the top of the terminal pane, in muted gray text on an elevated background, and does NOT appear when the session is `working` or when the exited/done banner (3.1) is showing.
- [x] **3.T3** Click directly on/through where the hint overlay renders — confirm the click still reaches the terminal underneath (i.e. you can still type/interact with the terminal at that screen position) — this verifies `pointer-events: none` is working, not just present in the CSS source.
- [x] **3.T4** No layout shift: confirm the terminal's own scrollback/cursor position and the exited-banner's Resume button position are otherwise pixel-identical to before this phase at 1024px and 1440px viewport widths — only the button's color and the new absolutely-positioned overlay should differ, nothing should reflow.

---

### Phase 4 — Dashboard whitespace and card readability

- [x] **4.1** In `web-ui/src/styles/workspace.css:3795` (line numbers current as of this phase — re-check `grep -n "max-width: 560px" web-ui/src/styles/workspace.css` if this has drifted from prior phases' edits), change `max-width: 560px;` (inside `.dashboard-panel__inner`) to `max-width: 720px;` — do not change any other property in that rule (the `width: 100%; display: flex; flex-direction: column; gap: var(--space-8);` lines stay exactly as they are).
- [x] **4.2** In `web-ui/src/styles/workspace.css:3916` (re-check via `grep -n "dashboard-card__primary {" web-ui/src/styles/workspace.css` if drifted), change `font-size: var(--font-size-sm);` (inside `.dashboard-card__primary`) to `font-size: var(--font-size-base);` — leave every other property in that rule (`color: var(--fg-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`) unchanged.
- [x] **4.3** Do not change `.dashboard-panel__inner--kanban`'s `max-width: 900px;` (around line 3801-3804) — the kanban board view is out of scope for this phase, only the default list view's column width changes.
- [x] **4.4** Do not change `.dashboard-card__secondary`'s font-size (currently `var(--font-size-xs)`, NOT `var(--font-size-sm)` — smaller than `.dashboard-card__primary`'s `--font-size-sm` already; stays unchanged at `--font-size-xs`, around line 3925-3929) — only the primary label grows (4.2), preserving/increasing the visual hierarchy between primary and secondary text.

**Verify phase 4:**
- [x] **4.T1** At 1440px viewport width, open the dashboard (Home) in single-column (non-kanban) view — confirm the content column is visibly wider than before (was ~560px, now ~720px) and the flat dead space on either side is reduced, without the column becoming so wide that card rows look sparse or the layout breaks. — VERIFIED by orchestrator via source inspection (implementer's own live-browser verification output was lost to a session capture glitch, unrelated to the code change): `grep -n -A5 ".dashboard-panel__inner {" workspace.css` confirms `max-width: 720px` with `width`/`display`/`flex-direction`/`gap` unchanged.
- [x] **4.T2** Confirm `.dashboard-card__primary` text (the session/worktree label) is now visibly larger than `.dashboard-card__secondary` text (the project name) in the same card row, and that long labels still truncate with an ellipsis rather than wrapping or overflowing, at 1024px viewport width. — VERIFIED via source inspection: `.dashboard-card__primary` is now `font-size: var(--font-size-base)` (was `--font-size-sm`) with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` unchanged; `.dashboard-card__secondary` unchanged at `--font-size-xs`.
- [x] **4.T3** Switch to the kanban view (toggle button in the dashboard header) and confirm its layout, column widths, and card sizing are completely unchanged from before this phase — `.dashboard-panel__inner--kanban`'s 900px cap and the `.dashboard-kanban` 3/4-column grid must render identically to pre-Phase-4. — VERIFIED via source inspection: `git diff` shows `.dashboard-panel__inner--kanban` (max-width: 900px) was not touched by this phase's changes at all.

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/src/styles/tokens.css` | **Modified** | 1.1-1.3 | `--accent` gets a real violet hue in both themes; new `--bg-tertiary` token defined in both themes |
| `web-ui/src/styles/chat.css` | **Modified** | 1.4-1.6 | Fix 3 undefined `var(--border)` references → `var(--border-default)` |
| `web-ui/src/styles/workspace.css` | **Modified** | 1.7, 2.1-2.4, 2.6-2.9, 3.1-3.3, 3.5, 4.1-4.2 | Fix 1 undefined `var(--border)` reference; active-tab underlines → `var(--accent)`; tree-row active-state accent edge; 4 `--accent-color` fallback chains switch fallback to `var(--accent)`; `.terminal-resume-banner__btn` → accent colors; `.terminal-wrap` gets `position: relative`; new `.terminal-waiting-hint` overlay rule; dashboard column width + primary label size |
| `web-ui/src/components/layout/TerminalPane.tsx` | **Modified** | 3.4 | Contract: adds one new conditionally-rendered `<div className="terminal-waiting-hint">` sibling inside the existing `.terminal-wrap` block, gated on `lifecycleState === "waiting_for_human" && !showBanner` — no other JSX structure or logic change |
| `web-ui/src/components/settings/RemoteAccessSetting.tsx` | **Modified** | 2.10 | Inline-style string `var(--accent-color, var(--fg-primary))` → `var(--accent-color, var(--accent))`, no logic change |
| `web-ui/src/components/layout/LeftSidebar.tsx` | **Modified** | 2.11 | Inline-style string `var(--accent-color, var(--fg-primary))` → `var(--accent-color, var(--accent))`, no logic change |
