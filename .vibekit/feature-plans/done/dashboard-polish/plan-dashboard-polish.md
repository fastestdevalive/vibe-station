<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Dashboard polish — kanban chips, PR-bucket rollup, sidebar search, preview-restore fix

> Rework dashboard/kanban chips, fix two real bugs, add worktree-level PR bucketing, add sidebar fuzzy search.

**Issue:** dashboard-polish
**Branch:** `design-dashboard-ptal` (current worktree, no new branch)
**Status:** Pending
**PRD:** none — bug-fix + small-feature scope, captured directly in [`2026-09-26-dashboard-kanban-chips-search-scope.md`](../../reports/2026-09-26-dashboard-kanban-chips-search-scope.md)

**Reference files:**
- Bucket/status logic: `web-ui/src/components/layout/DashboardPanel.tsx`
- PR/status resolution: `web-ui/src/lib/statusColor.ts`
- File-tab store: `web-ui/src/hooks/useStore.ts`
- Sidebar: `web-ui/src/components/layout/LeftSidebar.tsx`
- Project overview (vertical UI): `web-ui/src/components/layout/ProjectHomeTab.tsx`
- Existing chip precedent: `web-ui/src/components/chat/SubagentRow.tsx`
- Kanban grid CSS: `web-ui/src/styles/workspace.css:5258-5299`

---

## Problem & Concept

- Kanban's 4th/5th column wraps to its own row (CSS/JSX column-count mismatch); "PR Created" bucket lists one row per session instead of one per worktree, on both the Dashboard and the newer `ProjectHomeTab.tsx`.
- Chips carry `worktree · session` on one line, forcing wide columns; no cap, so a busy worktree floods a kanban column.
- Sidebar has no search; finding a session means manually expanding every project.
- Reopening a worktree after visiting Home silently drops the previewed file even though its tab is still present.
- Success state: kanban boards sit on one row, chips are compact two-line pills capped at 10 with a working "More", PR/merged buckets show worktrees (not duplicate session rows) everywhere they appear, sidebar search works, and the Home→worktree file-preview regression is gone.

## Out of Scope

- Redesigning list-view bucket grouping beyond swapping in the new chip (Decision 2) — section structure (5 buckets, `showFinished` toggle) is unchanged.
- Server-side search endpoint — Decision 5 concludes client-only is sufficient; revisit only if this plan's search proves too slow against real data volumes.
- Android app work itself — Decision 2 only shapes the web chip/search logic to be portable later, it does not port anything.
- Any change to `bucketForRollup`'s bucket assignment rules (`working`/`needs-you`/`idle`/`pr`/`finished`) — only how the `pr` bucket **renders** changes (Phase 3).

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Kanban shows all boards (Working / Needs You / Idle / PR Created / Finished-when-shown) on one row at desktop widths |
| 2 | Each kanban chip is a two-line pill: worktree/project name above, session name below |
| 3 | Each kanban column caps at 10 chips with a "More" control that reveals the rest in place |
| 4 | List view uses the same chip component/markup as kanban — one chip style, not two |
| 5 | The `pr` bucket (covers both PR-open and PR-merged sessions per `bucketForRollup`, `DashboardPanel.tsx:52-58`) renders one row per worktree on `DashboardPanel.tsx` (list + kanban) and `ProjectHomeTab.tsx` |
| 6 | Sidebar has a search input below "Create new agent"; fuzzy-matches session/branch/project/mode name across Pinned, Workspaces, Projects |
| 7 | Search force-expands every project/worktree group while a query is active; clearing search restores the pre-search expand/collapse state exactly |
| 8 | Reopening a worktree after navigating Home restores the previously active file tab and its preview |
| 9 | New shared logic (fuzzy scorer, PR-worktree rollup) is written as plain TS functions with no React/store coupling, so it can be ported to the Android client later (user requirement) |

---

## Change Map

```
web-ui/src/
  hooks/useStore.ts                        ~ fix clearWorkspaceSelection (Phase 1)
  lib/
    fuzzyMatch.ts                          + pure fuzzy scorer (Phase 4)
    prWorktreeRollup.ts                    + pure pr-bucket → worktree[] rollup (Phase 3)
  components/
    layout/
      SessionChip.tsx                      + shared two-line chip (Phase 2)
      DashboardPanel.tsx                    ~ kanban grid, cap+More, chip swap, pr rollup (Phase 2, 3)
      ProjectHomeTab.tsx                    ~ pr bucket → worktree rows (Phase 3)
      LeftSidebar.tsx                       ~ search input + force-expand/restore (Phase 4)
  styles/
    workspace.css                          ~ kanban grid track, chip, search input styles (Phase 2, 4)
```

| Today | After this plan |
|-------|-----------------|
| Kanban's 4th/5th column wraps to a new row | All boards sit on one row |
| Chip = `session name` + `branch · id` on one/two ad-hoc lines, unbounded count | Two-line pill, capped at 10 + "More" |
| List and kanban chips are visually different implementations | Both render `<SessionChip>` |
| `pr` bucket = 1 row per session (duplicates per worktree) | `pr` bucket = 1 row per worktree |
| No sidebar search | Fuzzy search across Pinned/Workspaces/Projects, force-expand while active |
| Home → worktree drops the active file preview | Preview restores exactly as before leaving |

---

## Research

- `DashboardPanel.tsx:52-58` — `bucketForRollup` returns `"pr"` for `pr.state === "open" \| "merged"` when lifecycle isn't `working`/`needs-you`/`done`/`exited` — one bucket already covers both PR states (Requirement 5 confirms it, doesn't change it).
- `DashboardPanel.tsx:95-172` (`useSessionBuckets`) buckets `Session[]`, reused verbatim by `ProjectHomeTab.tsx:64-68` — both consumers need the same worktree-rollup applied to their `pr` array.
- `web-ui/src/lib/statusColor.ts` `worktreePrStatus()` already resolves PR per-worktree (branch-guarded) — the rollup needs no new PR-resolution logic, only a de-dup/group step over sessions already in the `pr` bucket.
- `web-ui/src/styles/workspace.css:5260` (`.dashboard-kanban { grid-template-columns: repeat(3, 1fr) }`) vs `DashboardPanel.tsx:450-483` (4 `.dashboard-kanban__col` divs always, 5 when `showFinished`) — the CSS track was never updated when columns were added.
- `web-ui/src/components/chat/SubagentRow.tsx:14,149,325` — existing "+N more" precedent is a static count, not an interactive expand; Phase 2's "More" needs local `expanded` state instead (no existing pattern to reuse as-is).
- `web-ui/src/hooks/useStore.ts:1494-1523` (`closeFileTab`) — correct semantics for a *real* tab close: sets `activeFileTabIdxByWorktree[wt] = -1` only when `nextTabs.length === 0`, otherwise picks a neighboring index.
- `web-ui/src/hooks/useStore.ts:1641-1660` (`clearWorkspaceSelection`) — sets the *same* map to `-1` unconditionally, called from the "Home" link (`LeftSidebar.tsx:1240`) where no tab was actually closed.
- `web-ui/src/hooks/useStore.ts:987,1024-1027` (`setActiveWorktree`) — on re-entry, restores `activeFilePath` by reading `activeFileTabIdxByWorktree[worktreeId]`; reads the `-1` `clearWorkspaceSelection` left behind and restores `null`.
- **Root cause:** `activeFileTabIdxByWorktree` is shared between two different meanings — "which tab is really closed/gone" (owned by `closeFileTab`) and "which tab was showing before we navigated away" (read by `setActiveWorktree` on return) — `clearWorkspaceSelection` writes the first map as if handling the second case.
- **Root cause (kanban):** the CSS grid track and the JSX's actual rendered column count were never kept in sync as columns were added (3 → 4 → conditionally 5).

---

## Architecture Diagram

_Pure client-side (web-ui only) — no module boundary crossed; no daemon/Rust changes identified anywhere in this scope (see Risk 1)._

---

## Design Details

### System Boundaries

_Not applicable — every change in this plan is contained inside `web-ui/`, no new/changed REST or WS contract._

### Critical User Journeys (CUJs)

#### CUJ 1 — Reopen a file after visiting Home

```
User opens worktree W, opens file F (tab created, F previewed)
  → User clicks "Home"
  → User clicks back into worktree W
  → Preview shows F immediately (tab strip already showed F's tab — now the pane matches it)
```

- **Edge case:** worktree deleted while away (`LeftSidebar.tsx:914` call site) — unaffected, that path still clears state on an actual delete.

#### CUJ 2 — Scan PR status across a busy project

```
User opens the Dashboard
  → "PR Created" column shows one card per worktree with an open/merged PR
  → User does NOT see the same worktree twice because it has 2 agent sessions
```

- **Error path:** worktree's `isMain` session has no resolvable PR (`worktreePrStatus` returns null) → worktree never appears in `pr` bucket, same as today's per-session behavior.

#### CUJ 3 — Find a session by typing

```
User types "auth" in the sidebar search box
  → Every project/worktree group expands
  → Rows whose session name / branch / project name / mode fuzzy-match "auth" stay visible, others are hidden
  → User clears the box
  → Sidebar returns to exactly the expand/collapse state it had before typing
```

### Key Decisions

#### Decision 1: Preview-restore fix — stop writing the shared index from `clearWorkspaceSelection` — *no snippet needed*

- **Decision:** `clearWorkspaceSelection` (`useStore.ts:1641-1660`) drops the `activeFileTabIdxByWorktree` write entirely; it still clears `activeFilePath`, `activeWorktreeId`, `activeProjectId`, etc.
- **Rationale:** the index map's only other writers (`closeFileTab`, tab-click handlers) already encode "really gone" vs "just not focused right now" correctly — see Research; `clearWorkspaceSelection` was the one writer conflating the two.
- **Where:** `web-ui/src/hooks/useStore.ts:1641-1660` — delete the `nextIdxMap` computation and the `activeFileTabIdxByWorktree: nextIdxMap` field from the returned object.

#### Decision 2: One shared `<SessionChip>`, plain-object props — *with a snippet, because the portability constraint shapes the signature*

- **Decision:** new `web-ui/src/components/layout/SessionChip.tsx` takes plain serializable props (no `Session`/`Worktree` objects, no store hooks inside it) — kanban, list, and `ProjectHomeTab` each map their own data into this shape.
- **Rationale:** Requirement 9 — a props-in, JSX-out component with no Zustand/React-Router coupling is the part of this plan closest to portable to a future Android/Compose chip; the mapping (`Session` → `SessionChipProps`) stays in each web-only call site.
- **Where:** `web-ui/src/components/layout/DashboardPanel.tsx` (`renderDashboardItem`, `:302-358`), `ProjectHomeTab.tsx` (`renderSessionRow`, `:146-181`) both build `SessionChipProps` and render `<SessionChip>`.

```tsx
// Plain data in, no hooks/store access inside the component itself —
// keeps the chip's actual render logic portable to a non-React client later.
export interface SessionChipProps {
  status: WorktreeRolledUpStatus;
  pr: PrStatus | null;
  groupLabel: string;   // worktree/project name — line 1
  sessionLabel: string; // session name — line 2
  modeIconKey?: string;
  onClick?: () => void;
}
export function SessionChip(props: SessionChipProps) { /* two-line pill markup */ }
```

#### Decision 3: "More" is expand-in-place, per column, ephemeral local state — *no snippet needed*

- **Decision:** each kanban column tracks its own `expanded: boolean` via `useState` in `DashboardPanel.tsx`, not a modal, not persisted to the store/localStorage.
- **Rationale:** matches the existing "no modal" bias in this file (list/kanban toggle is also local `useState`); expand state resetting on reload is acceptable for a "show more of this list" affordance.
- **Where:** `DashboardPanel.tsx` kanban column render (`:450-483`) — cap `.slice(0, 10)` per bucket array, render `<button>` when `bucket.length > 10 && !expanded[bucketKey]`.

#### Decision 4: PR-bucket worktree rollup is a pure function, not a `useSessionBuckets` shape change — *with a snippet*

- **Decision:** add `web-ui/src/lib/prWorktreeRollup.ts` exporting `rollupPrSessionsByWorktree(sessions: Session[], worktreeById: Map<string, Worktree>): Worktree[]`; call sites run their existing `pr: Session[]` through it before rendering. `useSessionBuckets`'s return type is unchanged.
- **Rationale:** resolves the open question from the report (item 4) — changing `SessionBuckets.pr` to `Worktree[]` would ripple through both call sites' types and any future consumer; a pure post-processing function is additive and portable (Requirement 9).
- **Where:** new file, consumed by `DashboardPanel.tsx:473` (kanban `pr.map`) and its list-view `pr` section, and `ProjectHomeTab.tsx:289-296`.

```ts
// De-dup Session[] already known to be in the PR bucket down to one Worktree
// per branch — bucketForRollup already proved each session's worktree has
// an open/merged PR, this just collapses siblings on the same worktree.
export function rollupPrSessionsByWorktree(
  sessions: Session[],
  worktreeById: Map<string, Worktree>,
): Worktree[] {
  const seen = new Set<string>();
  const out: Worktree[] = [];
  for (const s of sessions) {
    const wt = s.worktreeId ? worktreeById.get(s.worktreeId) : undefined;
    if (!wt || seen.has(wt.id)) continue;
    seen.add(wt.id);
    out.push(wt);
  }
  return out;
}
```

#### Decision 5: Sidebar search is client-only, plain fuzzy scorer — *with a snippet*

- **Decision:** `web-ui/src/lib/fuzzyMatch.ts` exports a hand-rolled subsequence scorer (no new npm dependency); `LeftSidebar.tsx` runs it against already-loaded `sessions`/`worktrees`/`projects` on every keystroke (no debounce needed at expected sidebar data volumes).
- **Rationale:** confirms the report's open question (item 6) — sidebar data is already fully loaded client-side per `useServerSync.ts` (`AGENTS.md` session-status invariant), a server round-trip would only add latency; a pure function is also the portable piece for Requirement 9.
- **Where:** new file; `LeftSidebar.tsx` search input handler (new, placed after `:1258`'s divider).

```ts
// Case-insensitive subsequence match with a simple contiguity bonus —
// good enough for sidebar-sized lists (tens to low hundreds of rows),
// framework-free so it can be reused outside React later.
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0, score = 0, streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { qi++; score += 1 + streak; streak++; } else { streak = 0; }
  }
  return qi === q.length ? score : null; // null = no match
}
```

#### Decision 6: Search force-expand/restore uses a snapshot taken on first keystroke — *no snippet needed*

- **Decision:** `LeftSidebar.tsx` snapshots `openProj` + `workspacesOpen` into a ref the moment the query goes from empty → non-empty; force-expands everything while non-empty; restores the snapshot verbatim when the query goes back to empty.
- **Rationale:** Requirement 7 — "restore exactly," not "recompute a sensible default"; a ref survives re-renders without becoming reactive state itself.
- **Where:** `LeftSidebar.tsx`, near `openProj` (`:688`) and `workspacesOpen` (`:707`) state declarations.

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **User asked for "1 commit for daemon, 1 for UI" — no daemon/Rust change exists in this scope.** | Confirmed in Research: every item is `web-ui/`-only. Plan proceeds as UI-only; if implementation surfaces a genuine daemon need, split then — do not manufacture a no-op daemon commit. |
| 2 | Kanban 10-chip cap: does it count sessions (current per-session chips) or worktrees (after Decision 4's `pr` rollup)? | Cap applies to whatever the column actually renders post-rollup — for `pr` that's worktrees, for the other 4 buckets it's sessions. |
| 3 | Does `ProjectHomeTab.tsx`'s `finished` bucket also need worktree rollup? | Out of scope per this plan (Out of Scope) — `finished` = `done`/`exited` lifecycle, not a PR-outcome bucket; Requirement 5 only names `pr`. |

---

## Implementation Phases

- Each phase ends with a **verification block** — the phase is not complete until those tests pass
- Test items use `N.Tn` numbering to distinguish them from implementation items

---

### Phase 1 — Preview-restore bug fix

- [x] **1.1** `useStore.ts:1641-1660` — remove `activeFileTabIdxByWorktree` write from `clearWorkspaceSelection` (Decision 1)

**Verify phase 1:**
- [x] **1.T1** Manual — open a file in a worktree, click Home, click back into the worktree: preview shows the file immediately, no tab click needed
- [x] **1.T2** Regression — delete a worktree with an open file tab (`LeftSidebar.tsx:914` path) still behaves as today (no stale entry lingers visibly)
- [x] **1.T3** Unit — `useStore.test.ts`: `clearWorkspaceSelection` leaves `activeFileTabIdxByWorktree` untouched; `setActiveWorktree` after it restores the previously active file

---

### Phase 2 — Shared chip + kanban grid/cap/More

- [x] **2.1** `SessionChip.tsx` — new two-line chip component (Decision 2)
- [x] **2.2** `workspace.css:5260,5269` — fix `.dashboard-kanban`/`--with-finished` grid tracks to match actual rendered column count (Requirement 1)
- [x] **2.3** `DashboardPanel.tsx:450-483` — swap kanban chip rendering to `<SessionChip>`, add per-column `expanded` state + `.slice(0,10)` + "More" button (Decision 3)
- [x] **2.4** `DashboardPanel.tsx:302-358` (`renderDashboardItem`) — map `Session` → `SessionChipProps`

**Verify phase 2:**
- [x] **2.T1** Manual — desktop width: all kanban boards (incl. "Show finished" on) sit on one row
- [x] **2.T2** Manual — a bucket with >10 items shows exactly 10 + "More"; clicking "More" reveals the rest in place
- [x] **2.T3** Unit — `DashboardPanel.test.tsx`: column render caps at 10 before expand, full length after

---

### Phase 3 — PR-bucket worktree rollup

> Requirement 4 (list/kanban chip parity) is already satisfied by 2.4 — `renderDashboardItem`
> renders both the list `pr` section and the kanban `pr` column, so Phase 2's `<SessionChip>`
> swap covers list view too. No separate list-parity item here (opus review finding).

- [x] **3.1** `prWorktreeRollup.ts` — new pure function (Decision 4)
- [x] **3.2** `DashboardPanel.tsx` list-view `pr` section + kanban `pr` column (`:473`) — run `pr` through `rollupPrSessionsByWorktree` before rendering; update the `pr.length` count/empty-state checks (kanban header `:471`, list header, empty-state guard `:444-446`) to read the **rolled-up** length, not the raw session-array length, or the shown count won't match the card count
- [x] **3.3** `ProjectHomeTab.tsx:289-296` — same rollup for its `pr` section; this file has no `worktreeById` map today (unlike `DashboardPanel.tsx:276-279`) — build one from its `worktrees` prop before calling the rollup
- [x] **3.4** Define what a worktree-level `<SessionChip>` shows/does in the `pr` bucket: `groupLabel` = project name, `sessionLabel` = worktree branch (no single session to name — a worktree card, not a session card), `status`/`pr` from `worktreePrStatus`/the worktree's `isMain` session, `onClick` navigates to `/worktree/:id` (same target `renderDashboardItem` already uses for a worktree session today, `DashboardPanel.tsx:336`)

**Verify phase 3:**
- [x] **3.T1** Manual — a worktree with 2 sessions both in the `pr` bucket shows exactly 1 card, on both Dashboard and Project overview
- [x] **3.T2** Unit — `prWorktreeRollup.test.ts`: de-dups sessions sharing a worktree; preserves first-seen order; drops sessions with no resolvable worktree
- [x] **3.T3** Regression — `working`/`needs-you`/`idle`/`finished` buckets unaffected (still per-session)

---

### Phase 4 — Sidebar search

- [x] **4.1** `fuzzyMatch.ts` — new pure scorer (Decision 5)
- [x] **4.2** `LeftSidebar.tsx` — search input below "Create new agent" (after `:1258`)
- [x] **4.3** `LeftSidebar.tsx:688,707` area — snapshot/restore `openProj` + `workspacesOpen` on query transition (Decision 6)
- [x] **4.4** `LeftSidebar.tsx` — filter Pinned/Workspaces/Projects rows by `fuzzyScore` over session/branch/project/mode name; force-expand while query is non-empty

**Verify phase 4:**
- [x] **4.T1** Manual — typing a query expands all groups and narrows to matches across all 3 sections
- [x] **4.T2** Manual — clearing the query restores the exact pre-search expand/collapse state
- [x] **4.T3** Unit — `fuzzyMatch.test.ts`: matches subsequences case-insensitively, returns `null` on no match, higher score for contiguous matches

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/src/hooks/useStore.ts` | Modified | 1.1 | `clearWorkspaceSelection` no longer writes `activeFileTabIdxByWorktree` |
| `web-ui/src/components/layout/SessionChip.tsx` | New | 2.1 | Contract: `SessionChipProps` in → JSX out, no store/router access · Owns: nothing |
| `web-ui/src/styles/workspace.css` | Modified | 2.2 | `.dashboard-kanban` / `--with-finished` grid-template-columns |
| `web-ui/src/components/layout/DashboardPanel.tsx` | Modified | 2.3, 2.4, 3.2 | Kanban cap/More, chip swap (covers list+kanban), pr-bucket rollup + count fix |
| `web-ui/src/lib/prWorktreeRollup.ts` | New | 3.1 | Contract: `(Session[], Map<string,Worktree>) → Worktree[]` — pure |
| `web-ui/src/components/layout/ProjectHomeTab.tsx` | Modified | 3.3 | `pr` section renders worktree rows via `SessionChip`; adds local `worktreeById` map |
| `web-ui/src/lib/fuzzyMatch.ts` | New | 4.1 | Contract: `(query, target: string) → number \| null` — pure |
| `web-ui/src/components/layout/LeftSidebar.tsx` | Modified | 4.2, 4.3, 4.4 | Search input, expand-state snapshot/restore, row filtering |
| `web-ui/src/hooks/useStore.test.ts` | Modified | 1.T3 | New assertions |
| `web-ui/src/components/layout/DashboardPanel.test.tsx` | Modified | 2.T3 | New assertions |
| `web-ui/src/lib/prWorktreeRollup.test.ts` | New | 3.T2 | New unit tests |
| `web-ui/src/lib/fuzzyMatch.test.ts` | New | 4.T3 | New unit tests |
