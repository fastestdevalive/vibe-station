# Turn-implement: Phase 4 of plan-themes-ides-markdown

You are implementing **Phase 4 only** of a larger plan. Do not read or touch any other phase's files. Full plan (for your own reference only, do not implement beyond Phase 4): `.vibekit/feature-plans/pending/themes-ides-markdown/plan-themes-ides-markdown.md`

**Before touching any file:** read the `coding-agent-guardrails` skill, then the `coding` skill.

## What this feature is / what's already done

Vibe-station is adding a multi-theme system (14 total UI themes). Phase 1 (Rust server), Phase 2 (14-theme registry + generated CSS, `web-ui/src/theme/registry.ts` has `id`/`shikiThemeId`/`appearance`/`cssVars` per theme), and Phase 3 (the shared `useThemeStore`/`useTheme.ts`, which now returns BOTH `theme` (the derived `"dark"|"light"` appearance, unchanged shape) AND a new `themeId` field exposing the full 14-way value; `CodeView.tsx`/`DiffView.tsx` already destructure `themeId` from `useTheme()`, just don't use it for Shiki yet) are DONE and committed. Phase 4 is making Shiki syntax highlighting actually follow `themeId` instead of the old hardcoded `dark-plus`/`light-plus` binary. Phase 5 (Markdown style editor) is NOT your job.

## Your checklist (mark each `[x]` in the plan file's "### Phase 4" section as you complete it)

- [ ] 4.1 Rewrite `web-ui/src/components/preview/shikiHighlighter.ts`'s `getShikiHighlighter()` to create the highlighter with only the currently-active theme's `shikiThemeId` (not all themes eagerly), and add a way to load an additional theme on demand (Shiki's `Highlighter.loadTheme(idOrTheme)` — check the installed Shiki version's actual API surface) when the active theme changes to one not yet loaded, caching which ids have been loaded so re-switching back doesn't reload. The distinct `shikiThemeId` set across the registry is 13 values (`dark-plus`, `light-plus`, plus the 12 borrowed themes — check `web-ui/src/theme/registry.ts` for the authoritative list, don't hardcode a count)
- [ ] 4.2 `CodeView.tsx` and `DiffView.tsx`: replace the `dark|light → dark-plus|light-plus` map with a `themeId → registry.shikiThemeId` lookup (using the `themeId` field already destructured from `useTheme()` in Phase 3 — you may need to look up the registry entry by that id, e.g. via a `themeById` map/helper if `registry.ts` already exports one)
- [ ] 4.3 Confirm `web-ui/src/components/preview/codeHighlight.ts` needs no code change: hljs's per-appearance CSS variant already exists in `workspace.css` (Phase 2 rewrote the relevant block to key on `data-appearance`, and Phase 3 now writes that attribute) and hljs has no JS-side theme-switching logic to update — it was always CSS-only. Just verify this is actually true by reading the file; if you find hljs DOES need a code change (the plan's research could be wrong), make the minimal necessary fix and note it as a deviation.
- [ ] 4.T1 Test: render a file preview and a diff view under 3 different `themeId` values (one Vibestation, one other dark theme, one light theme) → assert the Shiki-highlighted output's inline colors actually differ between the 3 (not just that a class name changed — the whole point of this feature is real color output)
- [ ] 4.T2 Test: switching themes does not re-fetch/re-load an already-loaded Shiki theme a second time (assert your `loadTheme`-equivalent call count / cache hit)

## Files you may touch (nothing outside this list)

- `web-ui/src/components/preview/shikiHighlighter.ts`
- `web-ui/src/components/preview/CodeView.tsx`
- `web-ui/src/components/preview/DiffView.tsx`
- `web-ui/src/components/preview/codeHighlight.ts` — read first; only edit if you find it genuinely needs a change (see 4.3), and note that as a deviation if so
- `web-ui/src/theme/registry.ts` — READ ONLY, to look up `shikiThemeId` by `themeId`; do not modify it (that's Phase 2's territory, already done)
- The plan file itself, only to check off your `[x]` items
- Do NOT touch anything under `rust/`, `web-ui/src/styles/*.css`, `web-ui/src/hooks/useTheme*.ts`, or `web-ui/src/components/settings/` — all other phases' territory, already done or not yet started

## When you're done

- Mark items 4.1-4.3 and 4.T1-4.T2 `[x]` in the plan file's Phase 4 checklist section
- Append a `## Key Decisions` note to this file (`.vibekit/feature-plans/pending/themes-ides-markdown/turn-prompts/phase-4.md`) recording any deviation, especially if `codeHighlight.ts` turned out to need a real change (4.3) and the exact Shiki API you used for on-demand theme loading
- Do NOT run the full web-ui test suite as a completion gate — the orchestrator verifies independently. Do run `pnpm --filter @vibestation/web typecheck` and your own new/updated test files, and report the result.
- Report back concisely: what you changed, any deviation from the plan, and your verification result.

## Key Decisions

- **On-demand Shiki theme API (4.1):** confirmed the installed Shiki `3.23.0` API. `Highlighter.loadTheme(...themes: (ThemeInput | BundledThemeKeys | SpecialTheme)[]) => Promise<void>` is a real method (lives on the `ShikiInternal` interface, inherited by `Highlighter`). Verified empirically: `createHighlighter({ themes: [] })` is valid, `loadTheme("dark-plus")`/`loadTheme("dracula")` work, and `codeToHtml(..., { theme })` bakes inline `style="color:..."` per token. `setActiveTheme(shikiThemeId: string)` keeps a module-level `loadedShikiThemeIds: Set<string>` so re-switching back never calls `loadTheme` again. Because `loadTheme`'s parameter is typed as `BundledTheme` (not arbitrary `string`), the string param is cast via `as BuiltinTheme` — all 13 registry `shikiThemeId` values are valid bundled themes, so the cast is safe. `getShikiHighlighter()` now creates with only the currently-active theme (empty array when none active yet).
- **themeMode prop semantics (4.2):** `CodeView`/`DiffView` resolve `shikiThemeId` as `themeById[themeId]?.shikiThemeId ?? (appearance-based dark/light fallback)`. The `themeMode?: "dark"|"light"` prop is preserved as an appearance-only override: it only wins when it *differs* from the store's active `appearance` (the Settings hover-preview case, which carries no full themeId and needs dark-plus/light-plus). `FilePreviewPane` passes the store's own appearance as `themeMode`, which equals `appearance`, so the file preview path correctly uses the real `themeId` → 14-way Shiki lookup.
- **4.3 — no change needed to `codeHighlight.ts`:** confirmed. The file is pure hljs language registration + `languageForFilePath`/`languageForName`/`highlightFileContentByLines` — no JS-side theme-switching logic at all; hljs theming is CSS-only (the `workspace.css` blocks keyed on `data-appearance`, Phase 2/3 territory). No deviation.
- **Tests:** added `web-ui/src/components/preview/shikiTheming.test.tsx`. 4.T1 renders both `CodeView` (via `language="typescript"`) and `DiffView` (via `filePath="auth.ts"` to avoid the plaintext no-color fallback) under `vibestation-dark`/`dracula`/`github-light`, asserting the inline token color sets are pairwise distinct per theme. 4.T2 spies on the singleton highlighter's `loadTheme` and asserts switching `dracula → nord → dracula` triggers exactly 2 loads. Added a test-only `__resetShikiHighlighterForTests()` export for isolation. The 3 component-heavy tests are given 30s timeouts (real Shiki render).
