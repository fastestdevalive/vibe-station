# Report: Revise the 14-theme catalog — drop Dracula, fix light/dark imbalance

**Date:** 2026-09-17 · **Commit:** `27c0bf9` · **Scope:** `scripts/generate-theme-css.ts` `THEMES` array, `@shikijs/themes@3.23.0` bundle · **Method:** imported theme modules directly (`node --input-type=module -e 'import x from ".../dist/<id>.mjs"'`) and read real `colors` maps + computed WCAG contrast ratios; no source files touched.

## Answer
- **Dracula's complaint is confirmed by data, not just taken on faith.** Its `panel.border`/`editorGroup.border` (feeds `--border-default`/`--border-subtle`) is `#BD93F9` — bright saturated purple at **5.90:1 contrast** against its `#282A36` background. Every other dark theme in the roster sits at 1.1–1.5:1 for the same token (borders that blend in, as intended); only Night Owl (4.29:1) and Monokai's `focusBorder` (4.87:1, a different token) come close. Dracula is the outlier — **drop it, no 1:1 replacement needed.**
- **Light-theme survey**: `@shikijs/themes@3.23.0` bundles ~90 real VS Code theme exports (`node_modules/.../@shikijs/themes/dist/*.mjs`, confirmed via `find`/cache listing). Recommend **7 additions**, each mirroring an existing kept dark-theme family and each with the generator's required VS Code keys present or safely fallback-able.
- **Proposed final roster: 20 themes, 11 dark / 9 light** (up from 14 total, 12 dark / 2 light).

## Evidence
| Claim | Source |
|-------|--------|
| Dracula `panel.border`/`editorGroup.border` = `#BD93F9`, `focusBorder` = `#6272A4` | `import("@shikijs/themes/dist/dracula.mjs")` → `.colors` |
| Dracula border-default contrast 5.90:1 vs. bg; other dark themes 1.11–1.48:1 (except Night Owl 4.29:1) | computed WCAG contrast, see table below |
| `deriveChrome()` maps `panel.border`→`--border-default`, `editorGroup.border`→`--border-subtle`, `focusBorder`→`--border-strong`/accent | `scripts/generate-theme-css.ts:159-163` |
| Full Shiki bundle listing (90 themes incl. `solarized-light`, `one-light`, `ayu-light`, `catppuccin-latte`, `night-owl-light`, `github-light-default`, `gruvbox-light-*`, `rose-pine-dawn`, `kanagawa-lotus`, `min-light`, `vitesse-light`, `everforest-light`, `material-theme-lighter`) | `ls /home/gb/.bun/install/cache/@shikijs/themes@3.23.0@@@1/dist` |
| Current roster hardcoded at `THEMES` array | `scripts/generate-theme-css.ts:44-70` |

## Detail

### 1. Dracula — remove (validated)
| Theme | bg | `panel.border` | contrast vs bg | `focusBorder` | contrast vs bg |
|---|---|---|---:|---|---:|
| **dracula** | `#282A36` | `#BD93F9` | **5.90** | `#6272A4` | 3.03 |
| nord | `#2e3440` | `#3b4252` | 1.24 | `#3b4252` | 1.24 |
| one-dark-pro | `#282c34` | `#3e4452` | 1.44 | `#3e4452` | 1.44 |
| monokai | `#272822` | `#414339` | 1.48 | `#99947c` | 4.87 |
| github-dark | `#24292e` | `#1b1f23` | 1.13 | `#005cc5` | 2.33 |
| solarized-dark | `#002B36` | `#2b2b4a` | 1.11 | `#2AA19899` | 4.75 |
| gruvbox-dark-hard | `#1d2021` | `#3c3836` | 1.41 | `#3c3836` | 1.41 |
| catppuccin-mocha | `#1e1e2e` | `#585b70` | 2.46 | `#cba6f7` | 8.07 |
| tokyo-night | `#1a1b26` | `#101014` | 1.11 | `#545c7e33` | 2.61 |
| night-owl | `#011627` | `#5f7e97` | 4.29 | `#122d42` | 1.29 |
| ayu-dark | `#10141c` | `#1b1f29` | 1.12 | `#e6b450` | 9.67 |

`--border-default` (from `panel.border`) is used pervasively for ordinary panel/card edges across the whole UI — for 9 of 11 other dark themes that token is near-invisible (1.1–1.5:1). Dracula's is 4x brighter than the pack median and reads as an outlier, not a matter of taste. Note ayu-dark and catppuccin-mocha do have a bright `focusBorder` (`--border-strong`, used sparingly for focus rings only, not general borders) — that's a different, intentionally-prominent token, not comparable to Dracula's *default* border being bright.

**Action:** delete the `dracula` entry from `THEMES` (`scripts/generate-theme-css.ts:65`). No replacement required — general dark-theme count is already broad (11 remaining).

### 2. Light-theme candidates (real hex, mirroring plan's Theme Roster table format)
Each pairs with an existing kept dark theme's "family" and was checked against `deriveChrome()`'s required keys (`editor.background`, `editor.foreground`, `sideBar.background`, `editorWidget.background`, `descriptionForeground`, `panel.border`, `focusBorder`, `terminal.ansi*`).

| Theme id (`@shikijs/themes/<id>`) | Display name | bg | fg | accent (sample: `focusBorder`) | border (sample: `panel.border`) | Key gaps → fallback used |
|---|---|---|---|---|---|---|
| `solarized-light` | Solarized Light | `#FDF6E3` | `#657B83` | `#b49471` | `#DDD6C1` | `descriptionForeground` missing → `mix(fg,bg,25%)` |
| `one-light` | One Light | `#FAFAFA` | `#383A42` | `#526FFF` | *(missing)* | `panel.border`, `descriptionForeground`, `terminal.ansi*` all missing → `mix()`/hardcoded ansi fallbacks (functional, less "authentic") |
| `gruvbox-light-hard` | Gruvbox Light | `#f9f5d7` | `#3c3836` | `#ebdbb2` | `#ebdbb2` | `descriptionForeground` missing → `mix()` fallback |
| `catppuccin-latte` | Catppuccin Latte | `#eff1f5` | `#4c4f69` | `#8839ef` | `#acb0be` | none — fully populated |
| `night-owl-light` | Night Owl Light | `#FBFBFB` | `#403f53` | `#93A1A1` | `#d9d9d9` | none — fully populated |
| `ayu-light` | Ayu Light | `#fcfcfc` | `#5c6166` | `#f29718` | `#6b7d8f1f` (8-digit w/ alpha) | none — fully populated; alpha border renders fine (CSS supports 8-digit hex) |
| `github-light-default` | GitHub Light | `#ffffff` | `#1f2328` | `#0969da` | `#d0d7de` | none — fully populated; GitHub's current default light theme (existing `github-light` id is an older/legacy variant, kept as-is per "don't cut without reason") |

- `one-light` has the weakest key coverage of the seven — usable (generator's fallback chain handles it, same pattern as several kept dark themes e.g. `nord`/`gruvbox-dark-hard` which also lean on fallbacks) but flagged for a visual sanity check after generation.
- Considered and **rejected**: `rose-pine-dawn` (`panel.border` = `#0000`, `focusBorder` = `#6e6a8614` — both effectively transparent by design, would render borderless/flat panels, needs generator special-casing to avoid); `vitesse-light` (`focusBorder` = `#00000000`, same transparency issue); `material-theme-lighter` (`editor.foreground` = `#90A4AE`, low-contrast blue-grey text, several keys missing/transparent); `min-light`/`kanagawa-lotus` (fine data quality, held back only to keep the addition count proportionate — good candidates for a future round if more light variety is wanted).

### 3. Proposed final roster (20 themes: 11 dark / 9 light)
| # | id | appearance | status |
|---|---|:---:|---|
| 1 | `vibestation-dark` | dark | unchanged |
| 2 | `vibestation-light` | light | unchanged |
| 3 | `nord` | dark | unchanged |
| 4 | `one-dark-pro` | dark | unchanged |
| 5 | `monokai` | dark | unchanged |
| 6 | `github-dark` | dark | unchanged |
| 7 | `github-light` | light | unchanged |
| 8 | `solarized-dark` | dark | unchanged |
| 9 | `gruvbox-dark-hard` | dark | unchanged |
| 10 | `catppuccin-mocha` | dark | unchanged |
| 11 | `tokyo-night` | dark | unchanged |
| 12 | `night-owl` | dark | unchanged |
| 13 | `ayu-dark` | dark | unchanged |
| — | ~~`dracula`~~ | ~~dark~~ | **removed** |
| 14 | `solarized-light` | light | **new** |
| 15 | `one-light` | light | **new** |
| 16 | `gruvbox-light-hard` | light | **new** |
| 17 | `catppuccin-latte` | light | **new** |
| 18 | `night-owl-light` | light | **new** |
| 19 | `ayu-light` | light | **new** |
| 20 | `github-light-default` | light | **new** |

## Not checked
- No visual/rendered check of the new themes in the actual app (no `npx tsx scripts/generate-theme-css.ts` run, no browser screenshot) — this is data-only validation of the Shiki `colors` maps; a follow-up visual pass after implementation is recommended, especially for `one-light` given its fallback-heavy key coverage.
- Did not audit every one of the ~90 bundled themes exhaustively for hidden gems beyond the ones named in the task's candidate list plus a few adjacent ones (e.g. didn't individually pull data for `andromeeda`, `laserwave`, `poimandres`, `slack-dark/ochin`, `synthwave-84`, `vesper`, `horizon*`, `houston`, `plastic`, `red`, `snazzy-light` — none looked like well-known/popular picks worth displacing the chosen set, but not individually verified).
- Did not check whether `web-ui/src/theme/registry.ts` or `themes.generated.css`'s current *uncommitted* working-tree diff (per git status) already touches theme data in a way that conflicts with this proposal — worth a diff review before implementing.

## Follow-ups
| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | Run `npx tsx scripts/generate-theme-css.ts` after editing `THEMES` and visually spot-check `one-light` and `ayu-light` (alpha border) in the Settings picker | Confirms fallback-derived chrome tokens actually look right, not just "present" |
| 2 | Decide whether to also upgrade the existing `github-light` id to `github-light-default`'s data (rename/replace) vs. keeping both as separate roster entries | Two GitHub-light variants may be redundant; current plan keeps both since the task says don't cut existing entries without reason |
| 3 | If even more light variety is wanted later, `min-light`, `kanagawa-lotus`, `rose-pine-dawn` (needs a border-alpha fallback fix in `deriveChrome()` first) are the next-best candidates | Already surveyed, ready to revisit without re-doing the bundle search |
