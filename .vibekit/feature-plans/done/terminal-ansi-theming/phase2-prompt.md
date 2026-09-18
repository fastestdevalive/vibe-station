Implement phase 2 of the terminal-ansi-theming feature.

Working directory: /home/gb/.vibe-station/projects/vibe-station/worktrees/vs-152

## Context

Phase 1 is already complete and committed. The theme generator now emits 21 `--term-*` CSS vars
per theme into `web-ui/src/theme/registry.ts` (every ThemeRegistryEntry.cssVars has these keys).

## Your task

Wire `TerminalPane.tsx` to use the active theme's terminal palette from the registry, replacing
the hardcoded colors, and subscribe to live theme changes.

## Step 2.1 — Add imports to TerminalPane.tsx

In `web-ui/src/components/layout/TerminalPane.tsx`, add after the existing imports (around line 15):

```ts
import { useThemeStore } from "@/hooks/useThemeStore";
import { themeById, defaultThemeId } from "@/theme/registry";
import type { ITheme } from "@xterm/xterm";
```

Note: `Terminal` is already imported from `@xterm/xterm` — just add `ITheme` to the type imports.

## Step 2.2 — Add terminalThemeFromCssVars helper

Add this function above the component definition (after any utility functions like `isXtermAutoResponse`):

```ts
function terminalThemeFromCssVars(themeId: string): ITheme {
  const entry = themeById[themeId] ?? themeById[defaultThemeId]!;
  const v = entry.cssVars;
  return {
    background:          v["--term-background"],
    foreground:          v["--term-foreground"],
    cursor:              v["--term-cursor"],
    cursorAccent:        v["--term-cursor-accent"],
    selectionBackground: v["--term-selection-bg"],
    black:               v["--term-black"],
    red:                 v["--term-red"],
    green:               v["--term-green"],
    yellow:              v["--term-yellow"],
    blue:                v["--term-blue"],
    magenta:             v["--term-magenta"],
    cyan:                v["--term-cyan"],
    white:               v["--term-white"],
    brightBlack:         v["--term-bright-black"],
    brightRed:           v["--term-bright-red"],
    brightGreen:         v["--term-bright-green"],
    brightYellow:        v["--term-bright-yellow"],
    brightBlue:          v["--term-bright-blue"],
    brightMagenta:       v["--term-bright-magenta"],
    brightCyan:          v["--term-bright-cyan"],
    brightWhite:         v["--term-bright-white"],
  };
}
```

## Step 2.3 — Replace hardcoded theme in Terminal constructor

In the mount useEffect around line 197-200, the Terminal is constructed with:
```ts
theme: {
  background: "#0f0f0f",
  foreground: "#e5e5e5",
},
```

Replace this with:
```ts
theme: terminalThemeFromCssVars(useThemeStore.getState().themeId),
```

(This is safe — `useThemeStore.getState()` is a Zustand store API call, not a React hook, so
calling it inside useEffect is fine.)

## Step 2.4 — Add live theme subscription

Inside the same mount useEffect, after `term.open(host)` (around line 231), before the cleanup
`return () => {`, add:

```ts
const unsubTheme = useThemeStore.subscribe((state, prev) => {
  if (state.themeId !== prev.themeId) {
    term.options.theme = terminalThemeFromCssVars(state.themeId);
  }
});
```

The guard `state.themeId !== prev.themeId` prevents rebuilding the ITheme on unrelated store
mutations (e.g. font changes).

## Step 2.5 — Add cleanup

Inside the cleanup `return () => { ... }` (around line 486), add `unsubTheme()` alongside the
other disposal calls (before `term.dispose()`).

## Verification

1. `pnpm --filter @vibestation/web typecheck` exits 0
2. `pnpm --filter @vibestation/web test` exits 0 (pre-existing failures in TerminalPane.test.tsx
   are expected — 17 tests fail due to a broken xterm mock unrelated to this feature; confirm the
   count does not increase)

## After completion

Mark checklist items 2.1–2.5 and 2.T1–2.T2 [x] in the plan file at:
`.vibekit/feature-plans/wip/terminal-ansi-theming/plan-terminal-ansi-theming.md`

Commit ALL changes (source + plan):
```bash
git add web-ui/src/components/layout/TerminalPane.tsx
git add .vibekit/feature-plans/wip/terminal-ansi-theming/plan-terminal-ansi-theming.md
git commit -m "feat(terminal): live ANSI theme palette from useThemeStore"
```
