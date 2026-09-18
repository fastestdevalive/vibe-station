Implement phase 1 of `.vibekit/feature-plans/wip/terminal-ansi-theming/plan-terminal-ansi-theming.md` fully.

- Read the `coding-agent-guardrails` skill, then `coding`, before touching any file.
- Working directory: `/home/gb/.vibe-station/projects/vibe-station/worktrees/vs-152`
- Mark each checklist item [x] as you complete it, in the plan file.
- Do NOT edit .sdlc-state.yaml — the orchestrator owns it.
- Do NOT commit source. Commit ONLY the plan checklist changes (`.vibekit/feature-plans/**`).
- Stop and report if a step is ambiguous rather than guessing.

Start at item 1.0 (pnpm install).

## Phase 1 scope (items 1.0–1.6 + verify 1.T1–1.T4)

**1.0** Run `pnpm install` from repo root (node_modules may be absent)

**1.1** Add `brighten(hex: string, amount: number): string` helper to `scripts/generate-theme-css.ts` after `darken()` around line 215. Adds `amount` to each RGB channel, clamps at 255, returns hex. Mirror of `darken()`:
```ts
function brighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([Math.min(255, r + amount), Math.min(255, g + amount), Math.min(255, b + amount)]);
}
```

**1.2** Add `deriveTerminal(c: Record<string, string>, bg: string, fg: string, appearance: Appearance): Record<string, string>` function above `deriveChrome()` at line 219.

Reads VS Code `terminal.*` keys with appearance-conditional fallbacks. The function MUST:
- Compute regular ansi* colors as local consts FIRST (before bright fallbacks — bright fallbacks depend on them)
- Normalize all primary-key reads from VS Code to opaque hex using `mix(raw, raw, 0)` (strips 8-digit alpha, same pattern as line 235-236 in `deriveChrome` for `--accent`, with comment referencing the same Tokyo Night issue)
- Use `appearance === "dark"` to switch fallbacks for black/white family
- For `--term-selection-bg` fallback: use `hexToRgb()` (already at line 178) to convert the mix result: `const [r,g,b] = hexToRgb(mix(fg, bg, 0.3)); return \`rgba(${r},${g},${b},0.3)\``

Full fallback table:
| `--term-*` key | Primary VS Code key | Fallback |
|---|---|---|
| `--term-background` | `terminal.background` | `editor.background` (= `bg` param) |
| `--term-foreground` | `terminal.foreground` | `editor.foreground` (= `fg` param) |
| `--term-cursor` | `terminalCursor.foreground` | `fg` |
| `--term-cursor-accent` | `terminalCursor.background` | `bg` |
| `--term-selection-bg` | `terminal.selectionBackground` | `rgba(R,G,B,0.3)` where RGB from `hexToRgb(mix(fg,bg,0.3))` |
| `--term-black` | `terminal.ansiBlack` | dark: `mix(bg,fg,0.15)` / light: `mix(bg,fg,0.85)` |
| `--term-red` | `terminal.ansiRed` | `#ef4444` |
| `--term-green` | `terminal.ansiGreen` | `#22c55e` |
| `--term-yellow` | `terminal.ansiYellow` | `#eab308` |
| `--term-blue` | `terminal.ansiBlue` | `#3b82f6` |
| `--term-magenta` | `terminal.ansiMagenta` | `#8250df` |
| `--term-cyan` | `terminal.ansiCyan` | `#06b6d4` |
| `--term-white` | `terminal.ansiWhite` | dark: `mix(bg,fg,0.85)` / light: `mix(bg,fg,0.15)` |
| `--term-bright-black` | `terminal.ansiBrightBlack` | dark: `mix(bg,fg,0.35)` / light: `mix(bg,fg,0.65)` |
| `--term-bright-red` | `terminal.ansiBrightRed` | `brighten(ansiRed, 20)` (where `ansiRed` = resolved `--term-red` value) |
| `--term-bright-green` | `terminal.ansiBrightGreen` | `brighten(ansiGreen, 20)` |
| `--term-bright-yellow` | `terminal.ansiBrightYellow` | `brighten(ansiYellow, 20)` |
| `--term-bright-blue` | `terminal.ansiBrightBlue` | `brighten(ansiBlue, 20)` |
| `--term-bright-magenta` | `terminal.ansiBrightMagenta` | `brighten(ansiMagenta, 20)` |
| `--term-bright-cyan` | `terminal.ansiBrightCyan` | `brighten(ansiCyan, 20)` |
| `--term-bright-white` | `terminal.ansiBrightWhite` | dark: `mix(bg,fg,0.95)` / light: `mix(bg,fg,0.05)` |

**1.3** Inside `deriveChrome()` return statement (around line 261), spread `...deriveTerminal(c, bg, fg, appearance)` into the returned object. `bg` = `c["editor.background"] ?? "#000000"` and `fg` = `c["editor.foreground"] ?? "#ffffff"` — already computed as locals at lines 221-222.

**1.4** Add 21 `--term-*` entries to `vibestationVars` for `vibestation-dark` (the inline dict around lines 52-93):
```
"--term-background": "#0f0f0f",
"--term-foreground": "#e5e5e5",
"--term-cursor": "#e5e5e5",
"--term-cursor-accent": "#0f0f0f",
"--term-selection-bg": "rgba(229,229,229,0.2)",
"--term-black": "#262626",
"--term-red": "#f85149",
"--term-green": "#22c55e",
"--term-yellow": "#eab308",
"--term-blue": "#3b82f6",
"--term-magenta": "#8250df",
"--term-cyan": "#06b6d4",
"--term-white": "#d4d4d4",
"--term-bright-black": "#404040",
"--term-bright-red": "#fca5a5",
"--term-bright-green": "#86efac",
"--term-bright-yellow": "#fde047",
"--term-bright-blue": "#93c5fd",
"--term-bright-magenta": "#c084fc",
"--term-bright-cyan": "#67e8f9",
"--term-bright-white": "#e5e5e5",
```

**1.5** Add 21 `--term-*` entries to `vibestationVars` for `vibestation-light` (around lines 100-141):
```
"--term-background": "#fafafa",
"--term-foreground": "#171717",
"--term-cursor": "#171717",
"--term-cursor-accent": "#fafafa",
"--term-selection-bg": "rgba(23,23,23,0.15)",
"--term-black": "#404040",
"--term-red": "#dc2626",
"--term-green": "#15803d",
"--term-yellow": "#a16207",
"--term-blue": "#1d4ed8",
"--term-magenta": "#6e40c9",
"--term-cyan": "#0e7490",
"--term-white": "#737373",
"--term-bright-black": "#a3a3a3",
"--term-bright-red": "#ef4444",
"--term-bright-green": "#22c55e",
"--term-bright-yellow": "#ca8a04",
"--term-bright-blue": "#3b82f6",
"--term-bright-magenta": "#8250df",
"--term-bright-cyan": "#06b6d4",
"--term-bright-white": "#a3a3a3",
```

**1.6** Regenerate: run `pnpm tsx scripts/generate-theme-css.ts` from the repo root. This regenerates `web-ui/src/theme/registry.ts` and `web-ui/src/styles/themes.generated.css`.

## Verify phase 1

**1.T1** `pnpm --filter @vibestation/web typecheck` exits 0 (NOTE: `scripts/` dir is not covered by this tsconfig — the `tsx` run in 1.6 is the real generator typecheck; a clean tsx run counts as typecheck for the generator)

**1.T2** `pnpm --filter @vibestation/web test` exits 0 (NOTE: `web-ui/src/theme/registry.test.ts` enforces key-set parity across all themes — any typo in `--term-*` key names will show as a diff failure here)

**1.T3** `grep -c '"--term-background"' web-ui/src/theme/registry.ts` → output is `20`

**1.T4** `grep -c '\-\-term-background' web-ui/src/styles/themes.generated.css` → output is `40` (2 selectors × 20 themes)

## What to report when done

- Which items are [x] (completed)
- Output of each verify step
- Any deviations from the plan (with rationale)
- Any unexpected findings to pass to the phase 2 agent
