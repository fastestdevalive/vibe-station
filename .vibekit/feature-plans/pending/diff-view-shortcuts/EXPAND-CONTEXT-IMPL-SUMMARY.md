# EXPAND-CONTEXT Implementation Summary

Implements the plan `plan-diff-view-shortcuts-expand-context.md`: an affordance to
expand the unchanged source lines git omits between/around diff hunks in the
vibe-station web-ui diff view.

## What was implemented

All 3 phases in order. Checklist items 1.1–1.5, 1.T1–1.T4, 2.1–2.2, 2.T1–2.T2,
3.1, 3.2 are marked `[x]` in the plan file. 3.T1 and 3.T2 are left `[ ]` (see
"Test results" below — they are not fully satisfiable in this environment).

### Phase 1 — Gap computation + inline layout
- **`web-ui/src/preview/diffGaps.ts` (new)** — `DiffGap` interface + `computeGaps(hunks, fileLines)`, exactly per Decision 1. Derives gaps from each hunk's first/last `newLineNumber` (not re-parsing `hunk.header`), returns `[]` when `fileLines` is null or there are no hunks.
- **`web-ui/src/components/preview/DiffView.tsx`**
  - `fileLines` memo (`fileContentFallback ? split(/\r?\n/) : null`) + `gaps` memo (`computeGaps(hunks, fileLines)`) — gated on `fileContentFallback` being defined (Decision 2).
  - `expandedGaps: Set<string>` state + `toggleGap(id)`, reset on `filePath` change exactly like `collapsedHunks` (Risk 2).
  - Inline `<pre>` branch now interleaves a gap row (`renderGap`) before hunk 0 (`gap-start`), between hunks (`gap-<i>`), and after the last hunk (`gap-end`). Expanded state renders `fileLines.slice(startLine-1, endLine)` as `diff-line diff-line--context` rows (no `+`/`-` marker), reusing the existing gutter/`escapeHtml` markup.
  - `revealLine` effect extended (Decision 4): when the target line isn't inside any hunk, it now looks up a containing gap, expands it via `expandedGaps`, and fires `onRevealReady` after commit (same two-effect pattern as `collapsedHunks`).

### Phase 2 — Side-by-side layout
- **`web-ui/src/components/preview/DiffSideBySide.tsx`** — accepts `gaps`/`expandedGaps`/`fileLines`/`onToggleGap` props; renders gap rows as `.preview-diff-side-by-side__gap` (a 2-column grid like a hunk, header spanning both columns). Expanded gap shows identical context text in both left and right columns.

### Phase 3 — Styling + commit-diff confirmation
- **`web-ui/src/styles/workspace.css`** — `.preview-diff-gap`, `.preview-diff-gap-header`, `.preview-diff-gap-caret`, `.preview-diff-gap-caret:hover`, plus `.preview-diff-side-by-side__gap` grid rules, mirroring the existing `.preview-diff-hunk-collapsed`/`.preview-diff-hunk-caret` token-based visual language (theme-agnostic `--fg-muted`/`--fg-primary`).

## Test results

New/changed tests all pass:
- `web-ui/src/preview/diffGaps.test.ts` — **6 passed** (1.T1 gap-before/between/after, adjacent-no-gap, trailing-only; 1.T2 `fileLines === null` → `[]`; empty-hunks; synthetic-untracked no-gap).
- `web-ui/src/components/preview/DiffView.test.tsx` — **18 passed** (15 pre-existing + 3 new: 1.T3 expand/collapse, 1.T4 reveal-into-gap, 2.T1 side-by-side).
- Full `src/preview/` + `src/components/preview/` run: **13 files / 79 tests all passed**.

Verification commands run (all clean):
- `pnpm exec tsc --noEmit -p .` — clean.
- `pnpm exec eslint <changed files>` — clean (diffGaps.ts, diffGaps.test.ts, DiffView.tsx, DiffView.test.tsx, DiffSideBySide.tsx).
- `pnpm exec vitest run <changed test files>` — clean.

## Pre-existing failures (not caused by this change) — plan item 3.T2

The full `web-ui` suite reports **8 failures across 4 files** that are NOT related
to this feature and predate it. I verified by stashing ALL working-tree changes
(including sibling sessions' uncommitted work) and re-running: the identical 8
failures occur with my changes absent:

- `TopBar.test.tsx` (5) — canvas-mode pane toggle tests
- `WorkspaceCanvas.test.tsx` (1) — saveAsWorkspace detachment
- `FileTreeSidebar.test.tsx` (1)
- `VcsPanel.test.tsx` (2) — Phase 10 commit quick-diff view

None of these files import any module I changed (`DiffView`, `diffGaps`,
`DiffSideBySide`), so my changes cannot affect them. Hence **3.T2 (full suite
passes) is left `[ ]`** — my changed areas pass, but the suite as a whole does
not due to these pre-existing, unrelated failures.

## Deviations from the plan

No architecture deviations. I followed the plan's specified approach exactly:
gaps computed by `newLineNumber`, gated on `fileContentFallback`, `expandedGaps`
`Set<string>` mirroring `collapsedHunks`.

Minor implementation notes (within the plan's latitude):
- **3.T1 (manual/visual light/dark matching)** left `[ ]`: I cannot run a browser to visually verify. The gap CSS reuses the exact theme tokens (`--fg-muted`, `--fg-primary`) that the existing hunk-collapse styles use, so it is theme-correct by construction; a human visual pass is still recommended.
- **3.2 (VCS commit-diff manual check)** confirmed by code inspection rather than an interactive browser session: `FilePreviewPane.tsx:195` sets `fileBody = null` for `scope === "commit"`, so `fileContentFallback` is `undefined`, `fileLines` is `null`, and `computeGaps` returns `[]` — no gap rows render on the commit-diff path (Decision 2 holds).
- `renderGap` is defined as a closure inside `DiffView`/`DiffSideBySide` (not a separate top-level component) to keep access to `expandedGaps`/`toggleGap`/`fileLines` and stay within the file-size guardrail.

## Files changed
- `web-ui/src/preview/diffGaps.ts` (new)
- `web-ui/src/preview/diffGaps.test.ts` (new)
- `web-ui/src/components/preview/DiffView.tsx`
- `web-ui/src/components/preview/DiffSideBySide.tsx`
- `web-ui/src/components/preview/DiffView.test.tsx`
- `web-ui/src/styles/workspace.css`

Changes are left uncommitted in the working tree for human review.
