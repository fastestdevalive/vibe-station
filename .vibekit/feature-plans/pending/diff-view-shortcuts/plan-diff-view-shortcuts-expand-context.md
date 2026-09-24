<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Expand git-omitted context gaps in diff view

> Small follow-on to `plan-diff-view-shortcuts.md` — adds a click affordance to reveal the unchanged source lines git trims between/around hunks.

**Issue:** diff-view-shortcuts-expand-context
**Branch:** `diff-view-shortcuts`
**Status:** Pending
**Parent:** [`plan-diff-view-shortcuts.md`](./plan-diff-view-shortcuts.md) _(sibling feature, not a dependency — reuses its hunk-collapse UI language)_

**Reference files:**
- Parser: `web-ui/src/preview/diffParser.ts`
- Core UI: `web-ui/src/components/preview/DiffView.tsx`
- Side-by-side UI: `web-ui/src/components/preview/DiffSideBySide.tsx`
- Call sites: `web-ui/src/components/layout/FilePreviewPane.tsx`, `web-ui/src/components/tools/VcsCommitView.tsx`

---

## Problem & Concept

- `git diff`'s unified format only ships a few context lines around each hunk — everything else in the file is silently omitted, and today's diff view has zero representation of those gaps (unlike hunk-collapse, which only toggles hunks already present in the diff text).
- Add a clickable "N lines hidden" affordance between/around hunks that expands to show the real source lines pulled from the full file content, mirroring the existing hunk-collapse caret visually and structurally.

## Out of Scope

- Keyboard shortcut for gap-expand (mouse-only; see Decision 3 for why).
- Fetching file-at-commit content for the VCS commit-diff path (Decision 2 — flagged as a real gap, not silently worked around).
- Editing/diffing inside an expanded gap — gaps render as plain read-only context lines, same visual treatment as existing context lines.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Gap affordance appears before hunk 1, between consecutive hunks, and after the last hunk, whenever the corresponding line range is non-empty |
| 2 | Clicking a gap affordance expands it in place to real source lines (context-styled, no +/- marker) |
| 3 | Works in both inline (`DiffView.tsx`) and side-by-side (`DiffSideBySide.tsx`) layouts |
| 4 | Works for both plain file-preview diffs and VCS commit diffs (same `DiffView`, per Research) |
| 5 | Gaps degrade gracefully (affordance omitted, not broken) when full file text isn't available |
| 6 | `revealLine` (jump-to-line) that falls inside a currently-collapsed gap auto-expands that gap, same contract as it already has for collapsed hunks |

---

## Change Map

```
web-ui/src/preview/
  diffParser.ts              ~ add structured hunk range fields + gap computation
web-ui/src/components/preview/
  DiffView.tsx               ~ gap state, expand affordance (inline path), revealLine gap-case
  DiffSideBySide.tsx         ~ gap affordance row spanning both columns
web-ui/src/styles/
  workspace.css              ~ gap-row styling (reuses hunk-collapsed visual language)
```

| Today | After this plan |
|-------|-----------------|
| Hunks render with no indication that lines were omitted between them | A "⋯ N lines hidden — click to expand" row appears at each gap; clicking reveals real source lines |
| `revealLine` only auto-expands a collapsed *hunk* | `revealLine` also auto-expands a collapsed *gap* if the target line falls in one |

---

## Research

- `web-ui/src/preview/diffParser.ts:8-11` — `DiffHunk` stores only the raw `header` string; `HUNK_HEADER_RE` (line 13) already parses `oldStart/oldLines/newStart/newLines` into `m[1..4]` but discards them after building the display string.
- `web-ui/src/preview/diffParser.ts:118-128` — `syntheticUntrackedHunks` (new/untracked files) produces one hunk covering the whole file → no gaps possible for that path; gap logic only applies to real unified-diff hunks.
- `web-ui/src/components/preview/DiffView.tsx:117-125` — three hunk sources: structured `oldText`/`newText` (via `diffLinesToHunks`, no raw header at all), parsed unified diff, or synthetic untracked. Gap computation needs the hunks' start/end line numbers regardless of source, so it must key off `hunk.lines[0].newLineNumber`/`hunk.lines[last].newLineNumber` rather than only the parsed header — more robust than adding fields to `DiffHunk` alone.
- `web-ui/src/components/preview/DiffView.tsx:24,606-620` — `fileContentFallback` (current/new-side full text) is passed by `FilePreviewPane.tsx:606,610` from `fileBody`, which is the file's full content at the tip.
- `web-ui/src/components/layout/FilePreviewPane.tsx:191-194` — **for `scope === "commit"`, `fileBody` is explicitly set to `null`** ("No plain file content: the commit view is diff-only, same as branch scope used to be") — `fileContentFallback` is therefore `undefined` on the VCS commit-diff path today.
- `web-ui/src/api/client.ts:807-818` (`getFile`) — `FileScope` (`web-ui/src/api/types.ts:111`) is only `"worktree" | "project"`; there is no way to fetch a file's content as of an arbitrary commit sha with the current API surface.
- `web-ui/src/components/tools/VcsCommitView.tsx:5,83-86` — confirms the design-constraint claim: `VcsCommitView` renders `FilePreviewPane` with `controlled={{ scope: "commit", commitSha: sha }}` — same shared `DiffView`, so gap-expand code is automatically shared, but its data prerequisite (full file text) is not.
- `web-ui/src/components/preview/DiffView.tsx:165-177,238-271` — existing `collapsedHunks: Set<number>` + `revealLine` effect (expands the hunk containing the target line, then fires `onRevealReady` after commit) is the direct precedent for gap state + gap-aware reveal.
- `web-ui/src/components/preview/DiffSideBySide.tsx:85-99` — hunk header/collapsed rows are rendered as single elements *outside* the two-column line grid (grid CSS from `workspace.css:2848-2849` spans both columns) — a gap row can reuse the same single-row-spanning pattern.
- **Root cause:** the diff pipeline (parser → `DiffView` → `DiffSideBySide`) only ever models "hunks," never the space between them; there's no data structure for the omitted ranges and no full-file source is guaranteed at every call site.

---

## Design Details

### Key Decisions

#### Decision 1: Compute gaps in `DiffView`, not `diffParser.ts`, keyed by line numbers already on `DiffLine`

- **Decision:** add a `computeGaps(hunks, fileLines)` helper (co-located in `DiffView.tsx` or a small new `web-ui/src/preview/diffGaps.ts`) that derives gap ranges from each hunk's first/last `newLineNumber`, not from re-parsing `hunk.header`.
- **Rationale:** all three hunk sources (`diffLinesToHunks`, `parseUnifiedDiff`, `syntheticUntrackedHunks`) already populate `newLineNumber` on every `DiffLine` — see Research; this avoids depending on a header string that `diffLinesToHunks` never produces.
- **Where:** `web-ui/src/preview/diffGaps.ts` (new) — exports `{ before: number|null; after: number|null }` line-range-based gap list; consumed by `DiffView.tsx`.

```ts
// A gap is the [start,end] new-file line range git omitted between two hunks
// (or before the first / after the last). Returns [] when fileLines is
// unavailable — callers must treat that as "no gap affordance," not an error.
export interface DiffGap { id: string; startLine: number; endLine: number; lineCount: number }

export function computeGaps(hunks: DiffHunk[], fileLines: string[] | null): DiffGap[] {
  if (!fileLines || hunks.length === 0) return [];
  const gaps: DiffGap[] = [];
  const firstNew = hunks[0]!.lines.find((l) => l.newLineNumber != null)?.newLineNumber ?? 1;
  if (firstNew > 1) gaps.push({ id: "gap-start", startLine: 1, endLine: firstNew - 1, lineCount: firstNew - 1 });
  for (let i = 0; i < hunks.length - 1; i++) {
    const endOfThis = [...hunks[i]!.lines].reverse().find((l) => l.newLineNumber != null)?.newLineNumber;
    const startOfNext = hunks[i + 1]!.lines.find((l) => l.newLineNumber != null)?.newLineNumber;
    if (endOfThis != null && startOfNext != null && startOfNext - endOfThis > 1) {
      gaps.push({ id: `gap-${i}`, startLine: endOfThis + 1, endLine: startOfNext - 1, lineCount: startOfNext - endOfThis - 1 });
    }
  }
  const lastHunk = hunks[hunks.length - 1]!;
  const lastNew = [...lastHunk.lines].reverse().find((l) => l.newLineNumber != null)?.newLineNumber ?? fileLines.length;
  if (lastNew < fileLines.length) gaps.push({ id: "gap-end", startLine: lastNew + 1, endLine: fileLines.length, lineCount: fileLines.length - lastNew });
  return gaps;
}
```

#### Decision 2: VCS commit-diff path gets no gap affordance until a commit-scoped `getFile` exists — explicit gap, not silently patched

- **Decision:** `computeGaps` returns `[]` whenever `fileContentFallback` is `undefined` (Research: true for `scope === "commit"` today) — no gap rows render, existing hunk-only view is unchanged for that path.
- **Rationale:** fixing this properly needs a new backend capability (fetch file content as of an arbitrary commit sha — `FileScope`/`getFile` has no such mode per Research) which is out of scope for a UI-only plan; silently reusing stale worktree-tip content would show wrong context lines for old commits.
- **Where:** `web-ui/src/components/preview/DiffView.tsx` — gate the gap computation call on `fileContentFallback` being defined; no change to `FilePreviewPane.tsx`/`VcsCommitView.tsx` in this plan.
- **Follow-up (not this plan):** add a `sha`-scoped file-content fetch to `getFile`/`FileScope` if commit-diff gap-expand is wanted later.

#### Decision 3: No keyboard shortcut for gap-expand

- **Decision:** click-only affordance, no Alt+-style binding.
- **Rationale:** gaps are positionally arbitrary (0 to N per file) unlike the single "hunk under focus" hunk-collapse had — there's no natural "current gap" to target with one keystroke, and the user's brief doesn't ask for one.
- **Where:** N/A (no `useWorkspaceKeyboardShortcuts.tsx` changes).

#### Decision 4: `revealLine` auto-expands a collapsed gap, mirroring the collapsed-hunk case

- **Decision:** extend the existing reveal effect (`DiffView.tsx:243-264`) to also check `expandedGaps`/gap ranges when `hunks.findIndex(...)` misses (target line falls between hunks, not inside one).
- **Rationale:** per the feature brief, a reveal target can now legitimately land in an omitted gap; leaving it unhandled would silently fail to scroll (Research cites the exact effect this extends).
- **Where:** `web-ui/src/components/preview/DiffView.tsx:243-271` — add a gap-lookup branch before the existing `onRevealReady?.()` early-return, add the matching gap id to an `expandedGaps: Set<string>` state, fire `onRevealReady` after that commits (same two-effect pattern already used for `collapsedHunks`).

### CUJ — click to expand a gap

```
User views a diff with 2 hunks 40 lines apart
  → Between the hunks, sees "⋯ 38 lines hidden — click to expand"
  → Clicks it
  → Row is replaced by 38 real context lines sourced from fileContentFallback
  → Re-clicking (now a "collapse" caret) re-collapses back to the summary row
```

- **Edge case — no full file text (commit-diff path):** no gap rows render at all (Decision 2) — hunks display exactly as they do today.
- **Edge case — gap before first hunk / after last hunk:** same affordance, `startLine`/`endLine` computed against `1`/`fileLines.length` (Decision 1 snippet).

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Should expanded-gap line count affect virtualization/perf for very large files?** | Diff view isn't virtualized today (existing hunks render fully); gap expansion of a huge file is the same order of magnitude risk as an already-large hunk — no new mitigation added in this plan. |
| 2 | **Should gap state reset on `filePath` change, like `collapsedHunks` does?** | Yes — same `useEffect([filePath])` reset pattern (`DiffView.tsx:166-168`) applies to the new `expandedGaps` state. |

---

## Implementation Phases

### Phase 1 — Gap computation + inline layout

- [x] **1.1** Add `web-ui/src/preview/diffGaps.ts` with `DiffGap` type + `computeGaps()` (Decision 1)
- [x] **1.2** In `DiffView.tsx`: compute `fileLines = fileContentFallback?.split(/\r?\n/) ?? null`, memoize `gaps = computeGaps(hunks, fileLines)`
- [x] **1.3** Add `expandedGaps: Set<string>` state + `toggleGap(id)`, reset on `filePath` change (Risk 2)
- [x] **1.4** Render gap rows in the inline `<pre>` branch (`DiffView.tsx:363-426`): a `"⋯ N lines hidden — click to expand"` row before hunk 0, between hunks, and after the last hunk; expanded state renders `fileLines.slice(startLine-1, endLine)` as `diff-line diff-line--context` rows (no +/- marker), reusing `escapeHtml`/gutter markup already in that branch
- [x] **1.5** Extend the `revealLine` effect (`DiffView.tsx:243-271`) to also match against `gaps` and expand + report via `expandedGaps` (Decision 4)

**Verify phase 1:**
- [x] **1.T1** Unit — `diffGaps.test.ts` (new): gap before first hunk, gap between two hunks, gap after last hunk, no-gap (adjacent hunks) all return the correct `DiffGap[]`
- [x] **1.T2** Unit — `diffGaps.test.ts`: `fileLines === null` → `[]`
- [x] **1.T3** Component — `DiffView.test.tsx`: clicking a gap row reveals the expected source lines from `fileContentFallback`; re-click collapses
- [x] **1.T4** Component — `DiffView.test.tsx`: `revealLine` pointing inside a gap auto-expands it and calls `onRevealReady`

### Phase 2 — Side-by-side layout

- [x] **2.1** Thread `gaps`, `expandedGaps`, `fileLines`, `onToggleGap` props into `DiffSideBySide.tsx`
- [x] **2.2** Render gap rows spanning both columns, same grid pattern as `.preview-diff-hunk-header`/`.preview-diff-hunk-collapsed` (`workspace.css:2848-2849`); expanded gap shows identical context text in both left/right columns (no old/new distinction for pure context)

**Verify phase 2:**
- [x] **2.T1** Component — `DiffView.test.tsx` or `DiffSideBySide.test.tsx` (new, if it doesn't exist): gap row renders and expands identically when `diffLayoutMode === "side-by-side"`
- [x] **2.T2** Regression — existing `DiffView.test.tsx` hunk-collapse + layout-toggle tests still pass unchanged

### Phase 3 — Styling + VCS commit-diff confirmation

- [x] **3.1** Add `.preview-diff-gap` / `.preview-diff-gap-caret` rules in `workspace.css` mirroring `.preview-diff-hunk-collapsed`/`.preview-diff-hunk-caret` (`workspace.css:2739-2766`) visual language
- [x] **3.2** Manual check: open a VCS commit diff (`VcsCommitView`) and confirm gap rows correctly do NOT appear (Decision 2), rather than appearing with wrong/stale content

**Verify phase 3:**
- [x] **3.T1** Manual/visual — inline and side-by-side gap rows visually match hunk-collapse caret styling in both light and dark theme
- [x] **3.T2** Regression — full `web-ui` test suite passes (`npm test` or project's configured runner)

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/src/preview/diffGaps.ts` | **New** | 1.1 | `computeGaps(hunks, fileLines): DiffGap[]` — pure, no state |
| `web-ui/src/components/preview/DiffView.tsx` | **Modified** | 1.2–1.5 | Gap state (`expandedGaps`), gap rows in inline branch, `revealLine` gap-case; passes gap props to `DiffSideBySide` in Phase 2 |
| `web-ui/src/components/preview/DiffSideBySide.tsx` | **Modified** | 2.1–2.2 | Accepts `gaps`/`expandedGaps`/`fileLines`/`onToggleGap` props, renders spanning gap rows |
| `web-ui/src/styles/workspace.css` | **Modified** | 3.1 | `.preview-diff-gap*` rules |
| `web-ui/src/preview/diffGaps.test.ts` | **New** | 1.T1, 1.T2 | Unit tests for gap computation |
| `web-ui/src/components/preview/DiffView.test.tsx` | **Modified** | 1.T3, 1.T4, 2.T1, 2.T2 | Gap expand/collapse, reveal-into-gap, regression coverage |
