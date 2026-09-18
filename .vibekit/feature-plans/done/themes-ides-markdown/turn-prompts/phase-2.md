# Turn-implement: Phase 2 of plan-themes-ides-markdown

You are implementing **Phase 2 only** of a larger plan. Do not read or touch any other phase's files. Full plan (for your own reference only, do not implement beyond Phase 2): `.vibekit/feature-plans/pending/themes-ides-markdown/plan-themes-ides-markdown.md`

**Before touching any file:** read the `coding-agent-guardrails` skill, then the `coding` skill.

## What this feature is / what's already done

Vibe-station is adding a multi-theme system (14 total UI themes) and customizable Markdown styling, stored server-side so every browser tab/session shares the same setting live. Phase 1 (Rust server schema/routes/WS broadcast) is DONE and committed — not your concern. Phase 2 is the theme *data*: picking real IDE color palettes (sourced from the `@shikijs/themes` npm package, already a transitive dependency via `shiki` — do NOT clone or vendor any external IDE repo) and generating the CSS + registry that every later phase consumes. Phases 3-5 (web-ui wiring, syntax highlighting, Markdown UI) are NOT your job.

**Environment note:** this worktree may not have `node_modules` installed yet. If `@shikijs/themes` isn't resolvable, run `pnpm install` from the repo root first (this is a normal monorepo install, not a scope violation).

## Your checklist (mark each `[x]` in the plan file's "### Phase 2" section as you complete it)

- [ ] 2.1 Lock in the 12 net-new themes per the Theme Roster table below (Dracula, Nord, One Dark Pro, Monokai, GitHub Dark, GitHub Light, Solarized Dark, Gruvbox Dark, Catppuccin Mocha, Tokyo Night, Night Owl, Ayu Dark)
- [ ] 2.2 Write `scripts/generate-theme-css.ts`: for each picked theme, derive UI chrome tokens (`--bg-*`, `--fg-*`, `--border-*`, `--accent`, `--status-*`, `--pr-*`) per the deterministic key-lookup + `mix()` fallback table below; additionally emit the full `--md-*` set per the Markdown-default derivation described below (color properties as `var()` references to that theme's own chrome tokens; size/weight/style/font-family properties as one shared theme-invariant default, not derived per-theme)
- [ ] 2.3 Generate `web-ui/src/theme/registry.ts` (id, name, appearance, shikiThemeId) and `web-ui/src/styles/themes.generated.css` — both a root `[data-theme="..."]` block AND a scoped `.theme-scope[data-theme="..."]` block per theme (same properties including the `--md-*` set, scoped selector, for a future hover-preview panel — Phase 3's job to consume, not yours to wire up). These CSS blocks key on `[data-theme=...]` only — they do not and cannot set the `data-appearance` HTML attribute; that's a later phase's job (JS, not CSS)
- [ ] 2.4 Rename `[data-theme="dark"]` → `[data-theme="vibestation-dark"]` and `"light"` → `"vibestation-light"` in `web-ui/src/styles/tokens.css` (lines 73-127 and 129-177 only — leave the `:root` fallback at lines 61-72 untouched); add the same theme-invariant `--md-*` defaults used elsewhere, with color values referencing that block's own existing chrome tokens directly (e.g. `--md-h1-color: var(--fg-primary)`); add both as registry entries with `name: "Vibestation Dark"` / `"Vibestation Light"`, `shikiThemeId: "dark-plus"` / `"light-plus"`
- [ ] 2.5 Update `web-ui/index.html`'s `data-theme="dark"` literal (currently at line 2) to `data-theme="vibestation-dark"`; add `data-appearance="dark"` alongside it
- [ ] 2.6 Rewrite the 3 blocks in `web-ui/src/styles/workspace.css` keyed on the literal `[data-theme="dark"]`/`[data-theme="light"]` (git tree-row status colors ~lines 1908-1917, hljs light-mode syntax palette ~lines 2609-2655, markdown-preview h5/h6+body/li/table-td overrides ~lines 3050-3060) to key on `[data-appearance="dark"|"light"]` instead — a pure selector rewrite. These rules will stay inert (matching nothing) until a later phase actually writes the `data-appearance` attribute — that's expected, not a bug for you to chase. Do NOT touch any other part of `workspace.css` (the header/bold/italic/code `--md-*` wiring at lines ~2742-2963 is a different phase's job).
- [ ] 2.T1 Test: every registry entry's CSS block defines the full token set (`--status-*`/`--pr-*`/`--md-*` all included) — write a small script/test that diffs each block's property names against the `vibestation-dark` block's property names (a missing property in any theme is a failure)

## Files you may touch (nothing outside this list)

- `scripts/generate-theme-css.ts` (new)
- `web-ui/src/theme/registry.ts` (new)
- `web-ui/src/styles/themes.generated.css` (new, generated output)
- `web-ui/src/styles/tokens.css`
- `web-ui/index.html`
- `web-ui/src/styles/workspace.css` — ONLY the 3 blocks named in item 2.6, nothing else in this file
- The plan file itself, only to check off your `[x]` items

## Theme Roster (finalized — 14 total, do not add/remove/reorder)

| # | Theme id | Display name | Appearance | bg | fg | accent (illustrative) | border (illustrative) |
|---|----------|--------------|:---:|---|---|---|---|
| 1 | `vibestation-dark` | Vibestation Dark | dark | `#0f0f0f` | `#e5e5e5` | `#e5e5e5` | `#262626` |
| 2 | `vibestation-light` | Vibestation Light | light | `#fafafa` | `#171717` | `#1a1a1a` | `#e5e5e5` |
| 3 | `dracula` | Dracula | dark | `#282A36` | `#F8F8F2` | `#44475A` | `#BD93F9` |
| 4 | `nord` | Nord | dark | `#2E3440` | `#D8DEE9` | `#88C0D0` | `#3B4252` |
| 5 | `one-dark-pro` | One Dark Pro | dark | `#282C34` | `#ABB2BF` | `#404754` | `#3E4452` |
| 6 | `monokai` | Monokai | dark | `#272822` | `#F8F8F2` | `#75715E` | `#414339` |
| 7 | `github-dark` | GitHub Dark | dark | `#24292E` | `#E1E4E8` | `#176F2C` | `#1B1F23` |
| 8 | `github-light` | GitHub Light | light | `#FFFFFF` | `#24292E` | `#159739` | `#E1E4E8` |
| 9 | `solarized-dark` | Solarized Dark | dark | `#002B36` | `#839496` | `#2AA198` | `#2B2B4A` |
| 10 | `gruvbox-dark-hard` | Gruvbox Dark | dark | `#1D2021` | `#EBDBB2` | `#458588` | `#3C3836` |
| 11 | `catppuccin-mocha` | Catppuccin Mocha | dark | `#1E1E2E` | `#CDD6F4` | `#CBA6F7` | `#585B70` |
| 12 | `tokyo-night` | Tokyo Night | dark | `#1A1B26` | `#A9B1D6` | `#3D59A1` | `#101014` |
| 13 | `night-owl` | Night Owl | dark | `#011627` | `#D6DEEB` | `#7E57C2` | `#5F7E97` |
| 14 | `ayu-dark` | Ayu Dark | dark | `#10141C` | `#BFBDB6` | `#E6B450` | `#1B1F29` |

`shikiThemeId` = the theme id itself for rows 3-14 (all 12 borrowed themes are literally in Shiki's bundle already). Rows 1-2 pin `shikiThemeId: "dark-plus"` / `"light-plus"` — no custom Shiki theme is built for the Vibestation themes.

**Important:** the accent/border columns above are illustrative only, sampled by hand — do NOT hardcode them into the generator. `scripts/generate-theme-css.ts` must always re-read the live, installed `@shikijs/themes` package's `colors` data at build/generate time via the key-lookup table below, and use the `bg`/`fg` values from that same live read (not the table above either, though they should match — the table above is just a human-readable reference of what you should end up computing).

## Deterministic chrome-token derivation

For each theme, read its `colors` map from `@shikijs/themes` (import the theme module, e.g. `import dracula from "@shikijs/themes/dracula"` or via the themes bundle export — check what's actually available in the installed package version and use whatever import shape it provides). Then:

| Target token | Primary VS Code key | Fallback formula if key absent |
|---|---|---|
| `--bg-primary` | `editor.background` | n/a (always present) |
| `--fg-primary` | `editor.foreground` | n/a (always present) |
| `--bg-secondary` | `sideBar.background` | `bg` (editor.background) |
| `--bg-card` | `editorWidget.background` | `bg` |
| `--bg-elevated` | `editorWidget.background` | same as `--bg-card` |
| `--bg-hover` | `list.hoverBackground` | mix(`bg`, `fg`, 6%) |
| `--bg-active` | `list.activeSelectionBackground` | mix(`bg`, `fg`, 10%) |
| `--bg-input` | `input.background` | `bg-secondary` |
| `--fg-secondary` | `descriptionForeground` | mix(`fg`, `bg`, 25%) |
| `--fg-muted` | `tab.inactiveForeground` | mix(`fg`, `bg`, 45%) |
| `--fg-faint` | `editorLineNumber.foreground` | mix(`fg`, `bg`, 65%) |
| `--border-default` | `panel.border` | mix(`bg`, `fg`, 12%) |
| `--border-subtle` | `editorGroup.border` | mix(`bg`, `fg`, 6%) |
| `--border-strong` | `focusBorder` | mix(`bg`, `fg`, 25%) |
| `--accent` | `focusBorder` (or `button.background` if present) | `fg` |
| `--destructive` | `errorForeground` | `terminal.ansiRed` |
| `--status-working` | `terminal.ansiYellow` | `#eab308` |
| `--status-waiting` | `terminal.ansiRed` | `errorForeground` |
| `--pr-open` | `terminal.ansiGreen` | `#22c55e` |
| `--pr-merged` | `terminal.ansiMagenta` | `#8250df` |
| `--pr-draft` | `terminal.ansiBrightBlack` | `descriptionForeground` |
| `--pr-closed` | `terminal.ansiBlack` | `--fg-muted` |

`mix(a, b, pct)` = linear RGB interpolation from `a` toward `b` by `pct`.

Also emit `--destructive-muted`, `--success`, `--success-muted`, `--warning`, `--warning-muted`, `--shadow-sm/md/lg`, `color-scheme` — look at the existing `[data-theme="dark"]`/`[data-theme="light"]` blocks in `tokens.css` (lines 73-177) to see the FULL current token set each block must match field-for-field; the table above only lists the ones needing a new derivation rule, the rest reuse an obvious analog (e.g. `--success` ~ `terminal.ansiGreen`, `--warning` ~ `terminal.ansiYellow`, shadows can be a fixed reasonable rgba() based on appearance).

## Markdown default derivation (the `--md-*` set, added to every theme block)

Color-valued properties are `var()` references to that same theme block's own already-derived chrome tokens — no new per-theme lookup:

- `--md-h1-color` through `--md-h6-color`: `var(--fg-primary)`
- `--md-bold-color`: `var(--fg-primary)`
- `--md-italic-color`: `var(--fg-secondary)`
- `--md-inline-code-bg`: `var(--bg-secondary)`, `--md-inline-code-color`: `var(--fg-primary)`
- `--md-code-block-bg`: `var(--bg-secondary)`, `--md-code-block-color`: `var(--fg-primary)`, `--md-code-block-border`: `var(--border-default)`
- `--md-blockquote-border`: `var(--border-strong)`, `--md-blockquote-color`: `var(--fg-secondary)`
- `--md-link-color`: `var(--accent)`

Non-color properties are **theme-invariant** — write the exact same value in all 14 blocks, matching today's `workspace.css` values (check `workspace.css:2742` onward for the current fixed values before picking these, so they match exactly):
- `--md-h1-size` through `--md-h6-size` (em multipliers, e.g. `2.14em`/`1.71em`/`1.43em`/`1.14em`/`1em`/`0.86em` — verify against the actual current CSS, don't guess)
- `--md-h1-weight` through `--md-h6-weight`, `--md-bold-weight`: `600`
- `--md-italic-style`: `italic`
- `--md-code-font-family`: `var(--font-mono)`

## When you're done

- Mark items 2.1-2.6 and 2.T1 `[x]` in the plan file's Phase 2 checklist section
- Append a `## Key Decisions` note to this file (`.vibekit/feature-plans/pending/themes-ides-markdown/turn-prompts/phase-2.md`) recording any deviation, especially the exact import shape you used for `@shikijs/themes` and the exact em-multiplier values you found in `workspace.css`
- Do NOT run the full web-ui test suite as a completion gate — the orchestrator verifies independently. Do run `pnpm --filter web-ui typecheck` (or equivalent) and your own 2.T1 script/test to confirm your own work, and report the result.
- Report back concisely: what you changed, any deviation from the plan, and your verification result.

## Key Decisions

- **`@shikijs/themes` import shape.** The generator imports each borrowed theme via its
  subpath export, e.g. `import("@shikijs/themes/dracula")` (dynamic, driven by the roster's
  `shikiSpec` field). Each module's default export is `{ name, displayName, type, colors,
  tokenColors }`, so the chrome tokens are read from `theme.colors["editor.background"]` etc.
  The package also exposes a full-bundle `@shikijs/themes` index (`themeNames` + named theme
  exports), but the per-theme subpath was used as it is the explicit, self-documenting shape
  and avoids loading all ~60 theme JSONs. **Deviation:** `@shikijs/themes` was NOT resolvable
  by bare specifier from the repo root (`scripts/`) despite being a transitive dep of `shiki`
  — pnpm does not hoist transitive deps. To make `scripts/generate-theme-css.ts` able to
  import it, `@shikijs/themes: "3.23.0"` was added as a **root devDependency** (pinned to the
  exact version `shiki@3.23.0` already depends on, so no version drift). This is a build-time
  dev dependency for the theme generator, not a runtime change to shipped code.
- **Em-multiplier values found in `workspace.css` (these differ from the plan's example).**
  The actual heading sizes at `workspace.css:2742-2783` are h1=`2.14em`, h2=`1.57em`,
  h3=`1.29em`, h4=`1.07em`, h5=`0.86em`, h6=`0.86em` — NOT the plan's illustrative
  `2.14em/1.71em/1.43em/1.14em/1em/0.86em`. The generator writes the actual values (and the
  `tokens.css` + registry `--md-*` sets match), per the "verify against the actual current
  CSS, don't guess" instruction. Heading weights are `600` for all six levels (per the prompt,
  even though today's CSS uses 700/650/600/600/600) and bold-weight is `600`.
- **Accent alpha normalization.** The deterministic table's `--accent` primary is
  `focusBorder`, but several themes (e.g. Tokyo Night `#545c7e33`, Solarized `#2AA19899`)
  expose a focusBorder with alpha. Since `--accent` is used as text/link color (must be
  opaque), the generator strips alpha from the accent via `mix(x, x, 0)` (normalizes an
  8-digit hex to its 6-digit RGB). All other pass-through chrome tokens keep their value
  as-is (8-digit hex is valid CSS Color 4).
- **`--chat-accent`, `--destructive-soft/-muted`, `--success/-warning(-muted)` analogs.**
  These aren't in the deterministic table; they reuse obvious analogs: `--chat-accent`
  = `--fg-muted` (mix(fg,bg,45%)); `--destructive-soft` = mix(destructive, fg, 30%);
  `--destructive-muted`/`--success-muted`/`--warning-muted` = mix(<base>, bg, 60%);
  `--fg-danger`/`--fg-success`/`--fg-warning` = the destructive/success/warning bases;
  `--fg-inverse` = `bg`; `--border-hover` = `color-mix(in srgb, var(--fg-primary) 12%,
  transparent)`; shadows are fixed per appearance (dark/light), matching tokens.css exactly.
- **Registry `cssVars` includes the full token set** (chrome + `--md-*`), not just the
  four fields named in the checklist, so Phase 3's swatch/preview can render all 14 themes
  without parsing CSS. The 2 Vibestation entries' `cssVars` are embedded from their
  hand-authored `tokens.css` values.
- **2.T1 test** lives at `web-ui/src/theme/registry.test.ts` (vitest): diffs each entry's
  `cssVars` property-name set against `vibestation-dark` and asserts the status/pr/md groups
  are present. Passed. `pnpm --filter @vibestation/web typecheck` passes (note: the package
  name is `@vibestation/web`, not `web-ui`).
