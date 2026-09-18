# Turn-implement: Phase 3 of plan-themes-ides-markdown

You are implementing **Phase 3 only** of a larger plan. Do not read or touch any other phase's files. Full plan (for your own reference only, do not implement beyond Phase 3): `.vibekit/feature-plans/pending/themes-ides-markdown/plan-themes-ides-markdown.md`

**Before touching any file:** read the `coding-agent-guardrails` skill, then the `coding` skill.

## What this feature is / what's already done

Vibe-station is adding a multi-theme system (14 total UI themes) and customizable Markdown styling, stored server-side. Phase 1 (Rust `/settings` schema + `settings:updated` WS broadcast) and Phase 2 (the 14-theme registry + generated CSS, `web-ui/src/theme/registry.ts` and `web-ui/src/styles/themes.generated.css`, plus a `data-appearance` selector rewrite in `workspace.css` and `index.html`) are DONE and committed — not your concern, but you consume both. Phase 3 is the web-ui theme-selection plumbing: a shared store, daemon-sync, a theme picker UI with live preview, and a real, confirmed pre-existing bug fix. Phases 4-5 (Shiki syntax highlighting, Markdown style editor) are NOT your job.

## The bug you're fixing (requirement 9)

`web-ui/src/hooks/useTheme.ts` today is a **per-call-site local `useState`**, not a shared store — every component calling `useTheme()` keeps its own independent copy of `theme`, seeded once from `localStorage` at mount, never told about a change made by a different mounted instance. When the user toggles theme in one component, only that instance's `useEffect` updates `document.documentElement.dataset.theme` (a single global DOM attribute, so CSS-variable-driven colors update everywhere instantly — the illusion of "it works"). But `DiffView.tsx`/`CodeView.tsx` derive a Shiki theme id from their own stale `theme` variable and Shiki bakes colors as **inline `style="color:#xxx"`** per token span (not CSS variables) — so diff/code text keeps showing yesterday's colors until that component remounts (a page refresh, which is why refreshing "fixes" it). The fix: replace the local `useState` with a single shared zustand store (`useThemeStore`) that every consumer subscribes to, so a `set()` call fans out to every mounted instance instantly, no remount needed.

**Confirmed 6 existing call sites of `useTheme()` today** (do not miss any): `web-ui/src/components/preview/DiffView.tsx:68`, `web-ui/src/components/preview/CodeView.tsx:18`, `web-ui/src/components/layout/FilePreviewPane.tsx:59`, `web-ui/src/components/chat/StreamingMarkdown.tsx:48`, `web-ui/src/components/layout/LeftSidebar.tsx:215`, `web-ui/src/components/settings/AppearanceSetting.tsx:95`.

## Your checklist (mark each `[x]` in the plan file's "### Phase 3" section as you complete it)

- [ ] 3.1 Add `themeId?`, `markdownStyle?` to `Settings` in `web-ui/src/api/types.ts` and `web-ui/src/api/mock.ts`; add the `settings:updated` variant to the `ServerEvent` union in `types.ts` (payload: `{ themeId?: string, markdownStyle?: MarkdownStyle }` — match Phase 1's Rust wire shape exactly) and emit it from `api.updateSettings` in `mock.ts`
- [ ] 3.2 Create `web-ui/src/hooks/useThemeStore.ts` (zustand `create()`, same pattern as `web-ui/src/hooks/useStore.ts` — a **dedicated** store, do NOT fold this into `useStore.ts`): shared `{ themeId: string, appearance: "dark"|"light" (derived by looking up `themeId` in the Phase 2 registry), font }` state, with actions to update them
- [ ] 3.3 Rewrite `useTheme.ts` as a thin wrapper over `useThemeStore`: at init, read `localStorage`'s cached `themeId` (key: whatever `useTheme.ts` currently uses, check the existing code) synchronously as a first-paint hint, then seed from `GET /settings` once at app boot (server value wins once it resolves); migrate the old `localStorage["vibestation:theme"]` (`"dark"|"light"`) value via a single `PATCH /settings` **only when `GET /settings` returns no `themeId`** (prevents a second tab racing/overwriting a value already set from another device); subscribe to `settings:updated` WS events (calls the store's `set()`, fanning out to all consumers automatically); `setTheme(id)` calls `PATCH /settings`, optimistically updating the store first, and writes the new `themeId` to `localStorage` on success. **On every `themeId` change (including boot), set BOTH `document.documentElement.dataset.theme = themeId` AND `document.documentElement.dataset.appearance = <looked up from the registry>`** — this is what makes Phase 2's `[data-appearance=...]` CSS selectors start matching (they were inert until now, by design). `useTheme()`'s returned `theme` field is the derived `appearance` (`"dark"|"light"`, unchanged shape for existing consumers); add a new `themeId` field to the returned object exposing the full 14-way value for consumers that need it
- [ ] 3.4 Confirm the 3 call sites that only need `appearance` (`FilePreviewPane.tsx:59`, `StreamingMarkdown.tsx:48`, `AppearanceSetting.tsx:95`) need no code change beyond the `useTheme.ts` internals swap; update `CodeView.tsx:18` and `DiffView.tsx:68` to also destructure the new `themeId` field from `useTheme()` (a later phase will consume it — you just need to make sure it's available, no further Shiki wiring is your job); redefine `LeftSidebar.tsx:215`'s `toggleTheme()` to switch directly between `vibestation-dark` and `vibestation-light` (calls `setTheme("vibestation-light")` when `themeId !== "vibestation-light"`, else `setTheme("vibestation-dark")` — it no longer tries to preserve a non-Vibestation theme choice, that's what the Settings picker is for); update `web-ui/src/hooks/useTheme.test.ts` for the new async, `GET /settings`-seeded, dual-attribute behavior (mock the API, assert both `dataset.theme` and `dataset.appearance`)
- [ ] 3.5 Rework `AppearanceSetting.tsx`'s "Brightness" dark/light `SegmentedControl` row into a theme picker: a swatch grid grouped by appearance ("Dark" section, "Light" section), each swatch a miniature rendering of that theme's `--bg-primary`/`--bg-secondary`/`--fg-primary`/`--accent` from the registry's `cssVars`. See the ASCII mockup below for the target layout.
- [ ] 3.6 Build `web-ui/src/components/settings/SettingsPreviewFixture.tsx`: fixed fixture content (one chat-style message, a 3-line `DiffView` diff, one Markdown line with `#`/`**bold**`/`_italic_`/`` `code` ``), rendered via the REAL `DiffView`/`MarkdownView` components imported from `web-ui/src/components/preview/` (not a bespoke preview renderer) so the preview never drifts from actual output
- [ ] 3.7 Wire the live-preview panel in `AppearanceSetting.tsx`: wrap it in `<div className="theme-scope" data-theme={hoveredThemeId}>` (Phase 2's `.theme-scope[data-theme="..."]` CSS block applies within that subtree only, not `document.documentElement`); on swatch hover/focus, render `SettingsPreviewFixture` with the hovered theme's id passed through (no `PATCH /settings` until click-to-commit); falls back to the currently-committed theme when nothing is hovered/focused (touch devices)
- [ ] 3.T1 Regression test (requirement 9 — this is the test that would have caught the original bug): render `DiffView` + `CodeView` in the same test tree as `AppearanceSetting` (or directly exercise `useThemeStore`), call the picker's `setTheme`, assert both instances' rendered Shiki HTML/inline styles reflect the new theme's colors **without unmounting** either component
- [ ] 3.T2 Test: switching theme in one browser context updates `document.documentElement.dataset.theme` AND `dataset.appearance` in a second context via the `settings:updated` WS event (mock the WS layer)
- [ ] 3.T3 Test: hovering a non-committed swatch updates the preview panel's rendered colors but does NOT call `PATCH /settings`, and does NOT change `document.documentElement`'s `data-theme`
- [ ] 3.T4 Test: the localStorage migration PATCH fires when `GET /settings` returns no `themeId`, and does NOT fire when it already has one

## Files you may touch (nothing outside this list)

- `web-ui/src/api/types.ts`
- `web-ui/src/api/mock.ts`
- `web-ui/src/hooks/useThemeStore.ts` (new)
- `web-ui/src/hooks/useTheme.ts`
- `web-ui/src/hooks/useTheme.test.ts`
- `web-ui/src/components/settings/AppearanceSetting.tsx`
- `web-ui/src/components/settings/SettingsPreviewFixture.tsx` (new)
- `web-ui/src/components/preview/CodeView.tsx` — ONLY to destructure the new `themeId` field from `useTheme()`, no further Shiki logic change (that's Phase 4)
- `web-ui/src/components/preview/DiffView.tsx` — same, destructure only
- `web-ui/src/components/layout/LeftSidebar.tsx` — ONLY `toggleTheme()`'s redefinition
- `web-ui/src/components/layout/FilePreviewPane.tsx` — read-only reference, confirm no change needed
- `web-ui/src/components/chat/StreamingMarkdown.tsx` — read-only reference, confirm no change needed
- The plan file itself, only to check off your `[x]` items
- Do NOT touch `web-ui/src/theme/registry.ts`, `web-ui/src/styles/*.css`, or anything under `rust/` — those are other phases' territory, already done

## UI Mockup — target layout for 3.5/3.7 (Appearance tab, theme picker with live preview)

```
┌─ Settings ──────────────────────────────────────────────────────────────────┐
│  General   [Appearance]   Markdown   Skills   Projects                      │
├───────────────────────────────────────────────────────────────────────────┤
│  Appearance                                                                  │
│  Customize how vibe-station looks on your device.                           │
│                                                                               │
│  Theme                                                                       │
│  ┌─ Dark ──────────────────────────────────────────────────────────────┐    │
│  │ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │    │
│  │ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│  │    │
│  │ │▓ Aa 1▓ │ │▓ Aa 1▓ │ │▓ Aa 1▓ │ │▓ Aa 1▓ │ │▓ Aa 1▓ │ │▓ Aa 1▓ │  │    │
│  │ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│  │    │
│  │ │Vibe Dk✓│ │Dracula │ │ Nord   │ │OneDark │ │Monokai │ │GH Dark │  │    │
│  │ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘  │    │
│  │ (+ 5 more — Solarized, Gruvbox, Catppuccin, Tokyo Night, Night Owl,  │    │
│  │   Ayu Dark — wraps to a 2nd row on narrow widths)                    │    │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌─ Light ─────────────────────────────────────────────────────────────┐    │
│  │ ┌────────┐ ┌────────┐                                               │    │
│  │ │░░░░░░░░│ │░░░░░░░░│                                               │    │
│  │ │░ Aa 1░ │ │░ Aa 1░ │                                               │    │
│  │ │░░░░░░░░│ │░░░░░░░░│                                               │    │
│  │ │Vibe Lt │ │GH Light│                                               │    │
│  │ └────────┘ └────────┘                                               │    │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  Live preview — "Dracula" (updates on hover; commits on click)              │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │  Agent: Fixed the null check in auth.ts — here's the diff:         │    │
│  │  ┌─ auth.ts ──────────────────────────────────────────────────┐   │    │
│  │  │  12   function login(user) {                                │   │    │
│  │  │  13 - if (user.token) {                                     │   │    │
│  │  │  13 + if (user?.token) {                                    │   │    │
│  │  │  14     return session.create(user);                        │   │    │
│  │  └────────────────────────────────────────────────────────────┘   │    │
│  │  # Heading   **bold**   _italic_   `inline code`                   │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  Text style          [ Mono | Sans ]                                        │
│  Agent status borders  [ On | Off ]                                         │
└───────────────────────────────────────────────────────────────────────────┘
```

Swatch = a miniature rendering of that theme's `--bg-primary`/`--bg-secondary`/`--fg-primary`/`--accent` (no live Shiki/markdown inside the tiny swatch — too small to read; that detail lives in the one big preview panel below). Clicking a swatch commits the theme; hovering only re-renders the preview panel locally, no network call. "Text style" (Mono/Sans) and "Agent status borders" rows already exist in `AppearanceSetting.tsx` today — keep them, only the "Brightness" row above them is being replaced by the theme grid.

## When you're done

- Mark items 3.1-3.7 and 3.T1-3.T4 `[x]` in the plan file's Phase 3 checklist section
- Append a `## Key Decisions` note to this file (`.vibekit/feature-plans/pending/themes-ides-markdown/turn-prompts/phase-3.md`) recording any deviation, especially the exact `localStorage` key name you found in the existing `useTheme.ts` and reused
- Do NOT run the full web-ui test suite as a completion gate — the orchestrator verifies independently. Do run `pnpm --filter @vibestation/web typecheck` and your own new/updated test files, and report the result.
- Report back concisely: what you changed, any deviation from the plan, and your verification result.

---

## Key Decisions

- **localStorage key:** the existing `useTheme.ts` used `"vibestation:theme"` (`useTheme.ts:6`) for the `"dark"|"light"` value. Reused verbatim as the first-paint cache, now storing the full 14-way `themeId`. Legacy `"dark"`/`"light"` values are detected (they're never valid new-format ids) and mapped to `vibestation-dark`/`vibestation-light` for both the first-paint hint and the one-time migration PATCH. `"vibestation:font"` is likewise kept.
- **`toggleTheme` lives in the hook, not LeftSidebar.** The plan's "redefine `LeftSidebar.tsx:215`'s `toggleTheme()`" targets a function that is defined in `useTheme.ts` and merely consumed by LeftSidebar. Redefined it in `useTheme.ts` (switches `vibestation-light` ↔ `vibestation-dark` via `setTheme`), so LeftSidebar.tsx itself needed no edit — its `theme`/`toggleTheme`/`toggleFont` usage is unchanged. This is the only file-touch deviation from the plan's "Files you may touch" list: `LeftSidebar.tsx` was intentionally left untouched because the behavioral change lives in the shared hook.
- **The store owns the DOM-attribute write.** Per the plan, "the store's effect sets BOTH `data-theme` and `data-appearance`" — implemented as the `useThemeStore.setThemeId` action (a zustand action, since a store has no React effect): it updates state and writes both attributes in one place, so every path (boot hint, server seed, WS event, optimistic setTheme) reuses it. `data-appearance` is looked up from the Phase 2 registry's `appearance` field.
- **Boot is a module-level singleton** (`booted` flag in `useTheme.ts`): `useTheme` is consumed by 6+ components, and all of them must share ONE `GET /settings` seed + ONE `settings:updated` subscription at boot, not N copies (that was the original stale-color bug's shape). Exported `__resetThemeSyncForTests()` (test-only) to reset the singleton + store for isolation.
- **Shiki stays appearance-driven in Phase 3.** `CodeView`/`DiffView` destructure the new `themeId` from `useTheme()` (available for Phase 4) but keep passing the derived appearance (`dark-plus`/`light-plus`) to Shiki for now — passing the raw 14-way id would break Shiki, and the lookup is explicitly Phase 4's job.
- **Mock additions:** `api.updateSettings` now persists `themeId`/`markdownStyle` in-memory and emits `settings:updated`; added `__test.setSettings()` to seed server-side settings for tests. `test/setup.ts` also clears `data-appearance` between tests.
