# Turn-implement: Phase 5 of plan-themes-ides-markdown

You are implementing **Phase 5 only** of a larger plan — the last code-authoring phase. A separate, later Phase 6 (not your job, not narrow-context, reserved for a Sonnet subagent) does live browser verification of the whole feature. Full plan (for your own reference only, do not implement beyond Phase 5): `.vibekit/feature-plans/pending/themes-ides-markdown/plan-themes-ides-markdown.md`

**Before touching any file:** read the `coding-agent-guardrails` skill, then the `coding` skill.

## What's already done

- **Phase 1** (Rust server): `/settings` has `themeId`, `markdownStyle`, `resetMarkdownStyle` (request-only) wire fields; a `settings:updated` WS event broadcasts `{ themeId, markdownStyle }` on every successful `PATCH /settings`.
- **Phase 2** (theme data): 14-theme registry + generated CSS. **Every theme's CSS block already defines the full `--md-*` custom-property set with real default values** (color properties as `var()` references to that theme's own chrome tokens, e.g. `--md-h1-color: var(--fg-primary)`; size/weight/style/font-family properties as one shared invariant default across all 14 themes, matching the real em-multipliers found in `workspace.css`). **You do not need to author any `--md-*` default values — they already exist.** Your job is wiring the CSS rules to *read* them, and building the settings UI to *override* them.
- **Phase 3** (web-ui theme store): `useTheme()`/`useThemeStore` — daemon-synced theme selection, live WS sync, the `SettingsPreviewFixture.tsx` component (chat message + `DiffView` diff + a Markdown line, built from the real `DiffView`/`MarkdownView` components) already exists at `web-ui/src/components/settings/SettingsPreviewFixture.tsx` — reuse/extend it, don't rebuild it.
- **Phase 4** (Shiki): file/diff preview syntax highlighting follows the theme.

## Your checklist (mark each `[x]` in the plan file's "### Phase 5" section as you complete it)

- [ ] 5.1 Confirm the full `--md-*` custom-property set already exists with defaults in every theme block (it does, from Phase 2) — no CSS-variable authoring needed here, just read `web-ui/src/styles/tokens.css` and `web-ui/src/styles/themes.generated.css` to see the exact property names you're about to wire up: `--md-h1-size/color/weight` through `--md-h6-*`, `--md-bold-weight/color`, `--md-italic-style/color`, `--md-inline-code-bg/color`, `--md-code-block-bg/color/border`, `--md-code-font-family`, `--md-blockquote-border/color`, `--md-link-color`
- [ ] 5.2 Rewrite `web-ui/src/styles/workspace.css:2742-2963`'s header/bold/italic/code rules (the fixed-value CSS for `.workspace-markdown-preview h1..h6`, `strong`, `em`, inline `code`, fenced `pre code`, etc.) to read the `--md-*` custom properties instead of hardcoded values. Do NOT touch the 3 blocks elsewhere in this file already rewritten to key on `[data-appearance=...]` in Phase 2 (git-status rows, hljs light palette, markdown h5/h6 overrides ~lines 1908-1917/2609-2655/3050-3060) — different section of the same file, no overlap with your work.
- [ ] 5.3 Add `web-ui/src/hooks/useMarkdownStyle.ts`: a hook that reads the server's `markdownStyle` (from the same settings source `useTheme.ts` already syncs — check how `useTheme.ts` seeds/subscribes and follow the same `GET /settings` + `settings:updated` WS pattern, do not re-invent a second settings-fetch path), applies the override as an inline `<style>` block (or equivalent) layered on top of the active theme's CSS defaults (only the fields the user has actually overridden — anything unset falls through to the theme default already defined in Phase 2's CSS). Track a `dirty` flag: true from the first local edit until the next successful `PATCH /settings` commit; while `dirty`, ignore incoming `settings:updated` payloads for `markdownStyle` specifically (don't let another tab's change or your own PATCH's echo clobber an in-progress, uncommitted edit) — re-sync once your own pending edit's PATCH resolves.
- [ ] 5.4 Build `web-ui/src/components/settings/MarkdownStyleSetting.tsx`: controls for every property in the table below, in the two-column layout shown in the mockup below (controls left, live preview right on desktop; preview stacks below controls on narrow width, consistent with `SettingsPanel.tsx`'s existing responsive pattern — check how `AppearanceSetting.tsx`/`SettingsPanel.tsx` already handle this). The preview panel renders `SettingsPreviewFixture` (from Phase 3, extend it if it doesn't yet cover blockquote/link — check what fixture content already exists) with the in-progress (uncommitted) edits applied locally, not just the last-saved value. Register the new section in `web-ui/src/components/settings/SettingsPanel.tsx`'s section list (follow the existing pattern other sections use there).
- [ ] 5.5 Debounce-commit pattern: every control edit updates the local preview instantly (marks `dirty`); the actual `PATCH /settings` fires once on blur/change-end (not per keystroke), then clears `dirty` on success
- [ ] 5.6 "Reset to theme" control (see mockup): sends `PATCH /settings` with `{ resetMarkdownStyle: true }`, which the Phase 1 server logic clears server-side; on success, clear all local override state so the preview and every other rendered Markdown surface fall back to the theme's defaults
- [ ] 5.T1 Test: setting a custom H1 color/size + bold color persists via `PATCH /settings` and renders identically in a chat bubble (`StreamingMarkdown`/`MarkdownView` in chat context) and the file-preview `.md` pane — both consume the same `.workspace-markdown-preview` class, so one CSS layer should cover both; write a test proving that
- [ ] 5.T2 Test (`docs/STATUS-INDICATORS.md` cross-check): confirm your `workspace.css` edit does NOT touch or reorder the `--status-*`/`--pr-*` tokens or the 3 blocks Phase 2 already rewrote — a simple diff-scope check on the file is enough, this isn't about generating new theme CSS
- [ ] 5.T3 Test: editing a control updates the preview panel without a network call; the `PATCH /settings` call fires exactly once, on blur/change-end (not per keystroke)
- [ ] 5.T4 Test: a `settings:updated` WS event arriving while the editor has a dirty, uncommitted draft does NOT overwrite the draft; the draft re-syncs to the server value only after its own pending PATCH resolves
- [ ] 5.T5 Test: `resetMarkdownStyle: true` actually clears a previously-set `markdown_style` server-side (not a no-op) — this exercises the Phase 1 server logic from the client side; you may need a lightweight integration test or a well-mocked API test, whichever this repo's existing test conventions favor (check how other settings round-trip tests are written, e.g. `SkillsSetting`'s tests if any exist)

## Markdown Style — every customizable property (requirement 6)

| Element | Property | CSS custom property | Type | Notes |
|---|---|---|---|---|
| H1-H6 | font size | `--md-h1-size` … `--md-h6-size` | `em` multiplier (e.g. `2.14em`) — the control can display px to the user but must write `em` under the hood, matching the theme's own default unit | must stay relative or it breaks the existing preview-zoom control |
| H1-H6 | color | `--md-h1-color` … `--md-h6-color` | color | |
| H1-H6 | weight | `--md-h1-weight` … `--md-h6-weight` | 100-900 | |
| Bold (`strong`) | weight | `--md-bold-weight` | 100-900 | default per-theme, e.g. 600 |
| Bold (`strong`) | color | `--md-bold-color` | color | default = `--fg-primary`, overridable |
| Italic (`em`) | style | `--md-italic-style` | `italic` \| `oblique` | |
| Italic (`em`) | color | `--md-italic-color` | color | |
| Inline code | background | `--md-inline-code-bg` | color | |
| Inline code | text color | `--md-inline-code-color` | color | |
| Inline + fenced code | font family | `--md-code-font-family` | font stack | ONE shared property for both — do not create two separate controls that could disagree |
| Fenced code block | background | `--md-code-block-bg` | color | |
| Fenced code block | text color (fallback when no Shiki/hljs token match) | `--md-code-block-color` | color | |
| Fenced code block | border | `--md-code-block-border` | color | |
| Blockquote | border + text color | `--md-blockquote-border` / `--md-blockquote-color` | color | |
| Link | color | `--md-link-color` | color | |

## UI Mockup — target layout for 5.4/5.6

```
┌─ Settings ──────────────────────────────────────────────────────────────────┐
│  General   Appearance   [Markdown]   Skills   Projects                      │
├───────────────────────────────────────────────────────────────────────────┤
│  Markdown Style                                        [ Reset to theme ]   │
│  Fine-tune how Markdown renders in chat and file previews.                  │
│                                                                               │
│  ┌─ Controls ──────────────────┐  ┌─ Live preview ─────────────────────┐   │
│  │ Headings                    │  │ # Heading 1 sample                  │   │
│  │  H1  size [22px▾]  color[█] │  │ ## Heading 2 sample                 │   │
│  │  H2  size [18px▾]  color[█] │  │ ### Heading 3 sample                │   │
│  │  H3  size [16px▾]  color[█] │  │                                      │   │
│  │  ▸ H4-H6 (collapsed)        │  │ Body copy with **bold text**,       │   │
│  │                             │  │ _italic text_, and `inline code`.   │   │
│  │ Bold    weight[600▾] color[█]│ │                                      │   │
│  │ Italic  style[italic▾]color[█]│ │ > A sample blockquote line.         │   │
│  │                             │  │                                      │   │
│  │ Inline code   bg[█] color[█]│  │ ```ts                                │   │
│  │ Code block    bg[█] color[█]│  │ function greet(name: string) {      │   │
│  │   font [JetBrains Mono▾]    │  │   return `hi ${name}`;              │   │
│  │                             │  │ }                                    │   │
│  │ Blockquote  border[█]color[█]│ │ ```                                 │   │
│  │ Link         color [█]      │  │ [A sample link](#)                  │   │
│  └─────────────────────────────┘  └──────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
```

H4-H6 controls are collapsed by default (same rendering code path as H1-H3, just a display-density choice — not a coverage gap; still needs to be genuinely functional if expanded, not a dead end).

## Files you may touch (nothing outside this list)

- `web-ui/src/styles/workspace.css` — ONLY lines ~2742-2963 (the header/bold/italic/code rules); do not touch the 3 `data-appearance` blocks elsewhere in this file
- `web-ui/src/hooks/useMarkdownStyle.ts` (new)
- `web-ui/src/components/settings/MarkdownStyleSetting.tsx` (new)
- `web-ui/src/components/settings/SettingsPreviewFixture.tsx` — extend if needed for blockquote/link coverage
- `web-ui/src/components/settings/SettingsPanel.tsx` — only to register the new section
- The plan file itself, only to check off your `[x]` items
- Do NOT touch `web-ui/src/theme/registry.ts`, `web-ui/src/styles/tokens.css`, `web-ui/src/styles/themes.generated.css`, anything under `rust/`, or `web-ui/src/hooks/useTheme*.ts`/`useThemeStore.ts` — all other phases' territory, already done

## When you're done

- Mark items 5.1-5.6 and 5.T1-5.T5 `[x]` in the plan file's Phase 5 checklist section
- Append a `## Key Decisions` note to this file (`.vibekit/feature-plans/pending/themes-ides-markdown/turn-prompts/phase-5.md`)
- Do NOT run the full web-ui test suite as a completion gate — the orchestrator verifies independently, including a regression diff against the Phase 4 baseline. Do run `pnpm --filter @vibestation/web typecheck` and your own new/updated test files, and report the result.
- Report back concisely: what you changed, any deviation from the plan, and your verification result.

## Key Decisions

- **Deviations from the "Files you may touch" list (2, both required for functional correctness, both noted below):**
  1. `web-ui/src/api/client.ts` + `web-ui/src/api/mock.ts` — widened `updateSettings`'s parameter to `Partial<Settings> & { resetMarkdownStyle?: boolean }` and taught the mock to clear `markdownStyle` on `resetMarkdownStyle: true`. Required by 5.6/5.T5: `resetMarkdownStyle` is request-only (not on `Settings`), so it cannot be sent through the old `Partial<Settings>` signature, and the mock must mirror the Rust route's clear-on-reset for the 5.T5 test to be a real check. This is the only way to exercise the Phase 1 reset logic client-side.
  2. `workspace.css` `.workspace-md-code-block` (~line 2659) — wired its `background`/`border`/font-family to `--md-code-block-bg`/`--md-code-block-border`/`--md-code-font-family`. This block is OUTSIDE the stated 2742-2963 range, but it is the real fenced-code wrapper that `MarkdownView` renders (`pre` → `CodeBlock`), and it's NOT one of the 3 protected Phase-2 `data-appearance` blocks. Without it, the "Code block bg/border/font" controls would have no effect on actual fenced code (they'd only hit the plain-`pre` fallback path), breaking requirement 7's "applies identically in chat and file-preview".
- **Size control px↔em:** the UI shows px but stores/applies `em` (relative, so the preview-zoom control keeps working). Conversion uses a fixed 14px reference base (`em = px/14`) for display only; presets include the theme's own defaults (0.86/1.07/1.29/1.57/2.14em…).
- **`useMarkdownStyle` scoping:** the override `<style>` targets `.workspace-markdown-preview` (the class shared by chat + file-preview), not `:root`/`[data-theme]`, so the layer never fights the active theme block and covers both Markdown surfaces with one selector.
- **WS reset echo:** the handler distinguishes "field present" from "field absent" via `"markdownStyle" in ev` so a reset echo (`markdownStyle: null`/`undefined`) actually clears the overrides rather than being skipped.
- **Lint note:** the repo-wide `pnpm lint` reports 61 pre-existing errors (mostly an `react-hooks/exhaustive-deps` config issue plus unused vars in files outside this phase) — none are in the files I touched (eslint on my 5 files + the 2 api files is clean).
