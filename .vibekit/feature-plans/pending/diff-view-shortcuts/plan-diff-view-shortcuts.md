<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Diff View Shortcuts

> Alt+D jumps to a file's diff, Alt+Shift+D (+ button) toggles inline/side-by-side layout, Alt+H (+ caret) collapses one hunk — all web-ui, no backend change.

**Issue:** diff-view-shortcuts
**Branch:** `diff-view-shortcuts`
**Status:** Pending
**PRD:** `.vibekit/feature-plans/pending/diff-view-shortcuts/prd-diff-view-shortcuts.md`

**Reference files:**
- Shortcuts hook: `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.ts`
- Diff renderer: `web-ui/src/components/preview/DiffView.tsx`
- Diff scope wiring: `web-ui/src/components/layout/FilePreviewPane.tsx`
- Store: `web-ui/src/hooks/useStore.ts`
- Help dialog: `web-ui/src/components/layout/KeyboardShortcutsDialog.tsx`

---

## Problem & Concept

- See `prd-diff-view-shortcuts.md` for the full problem statement and resolved design questions — this plan covers *how*, not *what*.
- Three new behaviors: jump-to-diff (Alt+D), inline/side-by-side toggle (Alt+Shift+D + button), one-hunk collapse (Alt+H + caret).

## Out of Scope

- Collapse-all-hunks command
- Keyboard hunk-to-hunk navigation
- Cross-restart persistence of layout choice (PRD Non-goals)
- Any backend/daemon change (see Change Map — none needed)

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Alt+D opens the active/selected file's diff at `"local"` scope; no-op with no file selected or no worktree (git) context |
| 2 | Alt+Shift+D and a new "Inline / Side-by-side" button toggle diff layout; side-by-side re-lays-out existing parsed hunk data, no new diff engine |
| 3 | Side-by-side unavailable below ~560px of diff pane width — button disabled, shortcut no-op entering that mode, auto-fallback to inline on shrink below threshold, no auto-restore on grow |
| 4 | Alt+H (+ per-hunk caret) collapses/expands one hunk: hover target, else topmost hunk visible in the scroll viewport |
| 5 | Layout choice (inline/side-by-side) is global, in-memory-only, persists across files for the browser session, NOT written to the persisted store allowlist |
| 6 | Hunk-collapsed state is per-file, resets to fully-expanded on file change |
| 7 | All three behaviors no-op while a `.md` diff is in Rendered mode; underlying layout choice is preserved, just inert |
| 8 | Alt+D/Alt+Shift+D/Alt+H act only on the currently-focused/visible diff preview (resolved via DOM focus/containment among `interactive` `DiffView` instances, see Decision 2); no-op if none focused/visible; chat-transcript and settings-fixture `DiffView`s never participate |
| 9 | No backend/daemon change — confirmed by Research (below) |

---

## Change Map

```
web-ui/src/preview/
  diffSideBySide.ts      + pairs hunk lines into left/right columns
  diffViewRegistry.ts     + multi-instance "interactive DiffView" registry, focus-resolved
web-ui/src/components/preview/
  DiffView.tsx            ~ `interactive` prop, hunk collapse (gated), registry registration
                            (gated), width gate (gated), renders <DiffSideBySide> when active
  DiffSideBySide.tsx      + new — side-by-side two-column render branch, split out of
                            DiffView.tsx to keep it under the repo's size guardrail (Decision 6)
web-ui/src/components/layout/
  FilePreviewPane.tsx      ~ passes `interactive` to its `DiffView` (only call site that does)
web-ui/src/hooks/
  useStore.ts              ~ diffLayoutMode field + setter (session-only, unpersisted)
  useWorkspaceKeyboardShortcuts.ts   ~ Alt+D / Alt+Shift+D / Alt+H handlers
web-ui/src/components/layout/
  KeyboardShortcutsDialog.tsx        ~ 3 new help-dialog rows, in the "Layout" group
web-ui/src/styles/
  workspace.css            ~ side-by-side grid, layout-toggle, hunk-caret, disabled states
```

`+` new file · `~` modified · unmarked = context only.

| Today | After this plan |
|-------|-----------------|
| No keyboard path to a file's diff — mouse-only (select file, switch scope chip) | Alt+D jumps straight to the active file's local diff |
| Diff view only renders inline/unified | Alt+Shift+D / button switches to a new side-by-side layout, reusing the same parsed hunks |
| Every hunk always renders in full, no way to collapse | Alt+H / per-hunk caret collapses/expands one hunk at a time |
| `KeyboardShortcutsDialog` lists only existing shortcuts | Lists the 3 new ones too |

---

## Research

- `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.ts:62-78` — Alt+N/Alt+Shift+N precedent: bare-Alt branch placed *before* the `if (!mod) return;` gate (line 80), guarded by `e.code` (layout-independent) not `e.key`, and by its own `inEditable` check (not the later shared one) so it fires from terminal focus too.
- `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.ts:44-54` — `inEditable` excludes xterm's helper textarea by class name; real `<input>`/`<textarea>`/`<select>`/contenteditable still block.
- `web-ui/src/components/layout/ToolPanel.tsx:194-201` — `effectiveTab === "files" ? <FilesPanel/> : null` / `"vcs" ? <VcsPanel/> : null` — **real conditional mount/unmount**, not `display:none`; only one of `FilesPanel`/`VcsPanel` is ever mounted per `ToolPanel` instance at a time.
- `web-ui/src/components/tools/VcsPanel.tsx` → `VcsCommitView.tsx:83-87` is the only other `<FilePreviewPane>` call site (`controlled` prop, Decision 6 in that file) besides `FilesPanel.tsx:163` — and it's behind the same mutually-exclusive tab switch above.
- **Correction (plan-review):** `DiffView` mounts from far more places than the tool-panel/file-preview path above:
  - `web-ui/src/components/chat/ToolResultCard.tsx:43` — one per rendered diff tool-result card in a chat transcript (many simultaneously).
  - `web-ui/src/components/chat/ToolRunSummary.tsx:250,260` — same, per tool-run summary card.
  - `web-ui/src/components/settings/SettingsPreviewFixture.tsx:87` — theme-preview fixture, static fixture text.
  - Canvas mode: `routes/Workspace.tsx:552` renders one `<ToolPanel>` per worktree tile (factory passed into `PaneHostLayer`/`WorkspaceCanvas.tsx`'s tile renderer, `WorkspaceCanvas.tsx:457-461`) → `ToolPanel` → `FilesPanel` → `FilePreviewPane` → `DiffView`, so **multiple interactive `DiffView` instances can be mounted and visible at once**, one per tile.
  - Net effect: a plain "last-register-wins" singleton is **wrong** — Alt+H/Alt+Shift+D would hit whichever chat-transcript card or canvas tile mounted most recently, not the file preview the user is looking at, and could flip session-wide `diffLayoutMode` based on an off-screen chat card. See Decision 2 (revised) below for the fix.
- `web-ui/src/components/preview/DiffView.tsx:89` — `displayMode` state (`"source"|"rendered"`), `:100-108` hunks memo, `:110` `flatRows = flattenHunks(hunks)`, `:112-135` async Shiki highlight keyed by `flatRows`' `${hi}-${li}` key (`hi`=hunk index, `li`=line index within `hunk.lines`) into `highlightedByKey`.
- `web-ui/src/components/preview/DiffView.tsx:137-156` — existing Source/Rendered toggle group markup/pattern (`aria-pressed`, `--active` class) to mirror for the new layout toggle.
- `web-ui/src/components/layout/FilePreviewPane.tsx:597-610` — `DiffView` only mounted for `scope === "local"|"branch"|"commit"`; `:581-596` images render before this branch and never reach `DiffView` — confirms PRD's "images keep precedence" needs no code change.
- `web-ui/src/components/layout/FilePreviewPane.tsx:663-670` — `.preview-body` (`overflow: auto`) is `DiffView`'s scroll ancestor; `DiffView` has no ref to it today, must resolve via `closest(".preview-body")`.
- `web-ui/src/hooks/useStore.ts:214,670,1041-1044` — `diffScopeByWorktree: Record<string, DiffScope>` + `setDiffScopeForWorktree(worktreeId, scope)`; `web-ui/src/api/types.ts:755` — `DiffScope = "local"|"branch"|"none"|"commit"`.
- `web-ui/src/hooks/useStore.ts:1041-1044,730-731` — `setToolPanelTab(tab)` already sets `toolPanelVisible: true` as a side effect (`patchLayout(s, { toolPanelTab: tab, toolPanelVisible: true })`) — one call both switches tab and un-hides the tool panel.
- `web-ui/src/hooks/useStore.ts:1683-1715` — `partialize` is an **allowlist**; any new store field simply omitted here is automatically excluded from `localStorage` persistence (comment at `:1684-1687` explicitly warns against spreading `...s`) — this is the mechanism for req. 5's "session-only, not on disk".
- `web-ui/src/components/layout/FileTreeHeader.tsx:24,54` — existing precedent for user-driven `setDiffScopeForWorktree` calls (the scope chip), confirms `"local"` is a valid, already-wired scope value.
- `web-ui/src/styles/workspace.css:2729-2745` — `.preview-diff-root`/`.preview-diff-hunk-header` current CSS; `:5959-5991` `.preview-diff-mode-toggle`/`__btn`/`__btn--active` — class-naming pattern to extend for the new layout toggle and hunk caret.
- **Root cause:** no keyboard path exists because shortcuts are hard-coded `if` branches with no diff-view awareness, and no side-by-side/collapse UI exists because `DiffView` only ever emits one flat inline row list (`flattenHunks`, `DiffView.tsx:44-56`).
- **Backend/daemon:** no Rust/daemon change is required — layout mode and hunk-collapse state are both explicitly session-only/in-memory per PRD (Non-goals, Resolved Q6) and every new field lives in the existing client-only `useWorkspaceStore` (Zustand) or local component state; no new API call, no new persisted field reaches the daemon. **Commit shape: 1 web-ui commit only, 0 backend commits.**

---

## Architecture Diagram

_Single-module change (web-ui only) — no backend/service boundary crossed. One line: keyboard hook → Zustand store + a new multi-instance, focus-resolved registry → the `interactive` `DiffView` instance(s), all client-side._

---

## Design Details

### System Boundaries

_N/A — no new/changed boundary. All state (diff scope, layout mode, hunk-collapse) is existing or new client-only Zustand/component state; no API/RPC contract changes. `getDiff`/`getFile` calls are unchanged (side-by-side re-lays-out data already fetched for inline)._

### Critical User Journeys (CUJs)

#### CUJ 1 — Alt+D jump to diff (happy path)

```
User has worktree active, file "src/foo.ts" selected (activeFilePath set), Files tab not focused
  → Presses Alt+D
  → Handler reads activeWorktreeId + activeFilePath from store
  → setDiffScopeForWorktree(worktreeId, "local")
  → setToolPanelTab("files")  (also sets toolPanelVisible: true)
  → FilesPanel re-renders → FilePreviewPane scope becomes "local" → DiffView mounts/updates
  → User sees the file's working-tree diff
```

- **Error path — no file selected:** `activeFilePath` is `null` → handler returns without calling any store setter (`preventDefault()` still called to suppress Firefox's address-bar-focus default, matching PRD Decision).
- **Error path — no git repo (direct/project session):** `activeWorktreeId` is `null` → same no-op.

##### Jump-to-line interaction with side-by-side + collapsed hunks (plan-review addition)

- **Background:** `FilePreviewPane.tsx:446-452` scrolls to a target line by querying an element with a matching `data-line` attribute inside `.preview-body`; today only inline `DiffView` rows exist, each tagged with the NEW-side line number.
- **(a) Side-by-side rows keep `data-line` on the new/right-side cell:** in `DiffSideBySide.tsx`, each paired row's right-hand (`added`/new-side) cell carries `data-line={row.right?.newLineNumber}` — same attribute name/value convention as today's inline rows — so the existing `bodyRef`-based jump-to-line effect in `FilePreviewPane.tsx` keeps working unchanged when side-by-side is active. The left/old-side cell does not carry `data-line` (avoids two elements matching the same query).
- **(b) Jump target inside a collapsed hunk:** if the resolved target line falls inside a hunk that is currently in `collapsedHunks`, that hunk must auto-expand (its index removed from the `Set`) before the scroll-into-view runs, so the jump always lands on a real row instead of silently no-op'ing against the collapsed summary row (which has no matching `data-line`). Applies in both inline and side-by-side layouts.
- **Design (plan-review correction):** the original design routed this through `getActiveDiffView()` (a global, focus-based registry lookup) — wrong, because `FilePreviewPane` should reach its own child `DiffView` directly, not a focus-resolved global that could return `null` or a *different* tile's controller on a multi-tile canvas. It was also broken on timing: expanding a hunk only schedules a React state update inside `DiffView`, but `FilePreviewPane`'s scroll-to-line effect (`:446-452`) runs `querySelector` synchronously/immediately, before the newly-expanded hunk's row exists in the DOM — and nothing in that effect's dependency array changed afterward to trigger a retry, so the scroll could run against a DOM that hasn't caught up yet.
  - Instead: `FilePreviewPane` passes the target line straight down as a prop, `revealLine={effectiveLine}`, to its own `DiffView` child (plain props, no registry). `DiffView` — which already owns `collapsedHunks` state — runs an effect keyed on `revealLine` that finds the hunk containing that line and, if it's currently collapsed, removes it from `collapsedHunks`.
  - After that expansion is committed (and the newly-visible row has actually rendered), `DiffView` bumps a `hunksVersion` counter and reports it back up via an `onRevealReady` callback prop (or an out-param ref) so `FilePreviewPane` learns exactly when the row became available — not just when the expand *started*.
  - `FilePreviewPane`'s scroll-to-line effect (`:446-452`, now depending on the `hunksVersion` value received via `onRevealReady`) adds that value to its dependency array, so the effect re-runs once the row actually exists in the DOM, instead of racing the state update.
- **Where:** `web-ui/src/components/preview/DiffView.tsx` accepts `revealLine?: number` and `onRevealReady?: () => void` props (interactive-only); an internal effect keyed on `revealLine` expands the matching hunk in `collapsedHunks` then calls `onRevealReady()`. `web-ui/src/components/layout/FilePreviewPane.tsx` passes `revealLine={effectiveLine}` and an `onRevealReady` that bumps its own `hunksVersion` state, and adds `hunksVersion` to the jump-to-line scroll effect's dependency array (`:446-452`/`~461`). No registry/controller method involved — this is a direct parent→child prop, not a focus-resolved lookup.

#### CUJ 2 — Alt+Shift+D toggle layout, width-gated (edge case)

```
User has a side-by-side-eligible diff open (pane ≥ 560px), presses Alt+Shift+D
  → DiffView's registered controller.toggleLayout() runs
  → displayMode !== "rendered" → proceed
  → target = "side-by-side"; current paneWidth ≥ 560 → setDiffLayoutMode("side-by-side")
  → DiffView re-renders two-column layout from the SAME `hunks` data
User later shrinks the pane below 560px while side-by-side is active
  → ResizeObserver callback fires → effect sees diffLayoutMode==="side-by-side" && width<560
  → setDiffLayoutMode("inline")  (auto-fallback; does not flip back when pane grows again)
```

- **Edge case — Rendered mode:** `.md` file in Rendered mode → `toggleLayout()` returns immediately; `diffLayoutMode` in the store is untouched (preserved for when the user switches back to Source).
- **Edge case — no interactive DiffView mounted:** registry's `getActiveDiffView()` returns `null` (Vcs tab active, tool panel closed, only non-interactive chat/settings `DiffView`s mounted, or multiple interactive instances with none focused, per Decision 2) → shortcut handler no-ops.
- **Edge case — multi-tile canvas mode:** two worktree tiles each have an interactive `DiffView` open; user clicks somewhere inside tile A's diff (a line, a hunk header — anywhere in the `rootEl` wrapper, which carries `tabIndex={-1}`) → that click moves `document.activeElement` to tile A's `rootEl` → `getActiveDiffView()` returns tile A's controller via `rootEl.contains(document.activeElement)`; tile B is unaffected by Alt+Shift+D. Without the click (e.g. focus still on `<body>` from page load), `document.activeElement` contains neither tile's `rootEl` and, with two instances registered, `getActiveDiffView()` returns `null`.

#### CUJ 3 — Alt+H collapse one hunk (happy + edge)

```
User hovers hunk #2's rows, presses Alt+H
  → controller.toggleHunkAtFocus() reads hoveredHunkIndexRef.current === 2
  → collapsedHunks (Set<number>, local state) toggles index 2
  → hunk 2 renders as a single summary row; others unchanged
User presses Alt+H with no hover, after scrolling so hunk 0's header is above the viewport top
  → hoveredHunkIndexRef.current is null → fall back to topmost-visible:
    for each hunk header element, in order, first whose getBoundingClientRect().bottom
    is >= scrollContainer's own bounding top → that hunk's index
  → toggles that hunk
```

- **Edge case — single-hunk file:** same code path, no special case (PRD Resolved Q5).
- **Edge case — file switch:** `collapsedHunks` resets via `useEffect(() => setCollapsedHunks(new Set()), [filePath])`.

### Data Model

_N/A — no persisted entity. `diffLayoutMode` is in-memory global store state (see Key Decision 1); `collapsedHunks` is in-memory per-`DiffView`-instance component state. Neither is written to disk or sent to the daemon._

### API Contracts

_None — no new/changed REST/RPC/event contract. Existing `getDiff`/`getFile` calls (already used by `FilePreviewPane.tsx`) are unchanged; side-by-side is a pure client-side re-layout of the same unified-diff text already fetched for inline mode._

### Key Decisions

#### Decision 1: `diffLayoutMode` lives in the global Zustand store, deliberately excluded from `partialize`

- **Decision:** add `diffLayoutMode: "inline" | "side-by-side"` (default `"inline"`) + `setDiffLayoutMode` to `useStore.ts`, but do **not** add it to the `partialize` allowlist at `useStore.ts:1683-1715`.
- **Rationale:** PRD Resolved Q6 — persists across files for the *browser session* (single page lifetime) but never to `localStorage`; the store's `partialize` is already an explicit allowlist (Research), so simply omitting the field is the whole mechanism — no new persistence code needed.
- **Where:** `web-ui/src/hooks/useStore.ts` — new field near `diffScopeByWorktree` (~line 214/670), new action near `setDiffScopeForWorktree` (~line 1041).

#### Decision 2 (revised): `interactive`-gated registry, multi-instance safe, resolved by DOM focus/containment

- **Correction (plan-review):** `DiffView` mounts from many more places than `FilePreviewPane` (chat transcript cards, settings fixture, and — in canvas mode — one `FilePreviewPane`/`DiffView` per worktree tile, Research above). A bare last-register-wins singleton would let a chat-transcript card's mount steal the shortcut target from the file-preview pane the user is actually looking at, and could write a narrow chat card's width into the session-wide `diffLayoutMode` (see Decision 5 revision). Fixed via an opt-in prop instead of "every `DiffView` participates":
- **Decision:**
  - `DiffView` accepts a new prop `interactive?: boolean` (default `false`).
  - Only `FilePreviewPane.tsx:601`'s `DiffView` usage passes `interactive`. `ToolResultCard.tsx:43`, `ToolRunSummary.tsx:250,260`, and `SettingsPreviewFixture.tsx:87` do **not** pass it and keep the default `false`.
  - When `interactive` is `false`: no layout-toggle button is rendered, no `ResizeObserver`/width-gate effect runs, hunk hover/collapse handlers are not attached (hunks always render fully expanded, non-interactive), and the instance never calls `registerActiveDiffView` — it does not participate in the registry at all.
  - When `interactive` is `true`: all of the above run, and the instance registers itself.
  - Registry becomes **multi-instance**: `diffViewRegistry.ts` exports `registerActiveDiffView(controller): () => void` (adds to a `Set<DiffViewController>`, not a single slot) and `getActiveDiffView(): DiffViewController | null`, which resolves the *target* instance — not "whichever registered last" — by DOM focus/containment: each controller also exposes `rootEl: HTMLElement` (the `interactive` instance's wrapper div); `getActiveDiffView()` walks the registered set and returns the controller whose `rootEl.contains(document.activeElement)` is true. If none contains focus (e.g. focus is on a chat input, or no tile is focused) and exactly one interactive instance is registered, fall back to that one (covers the common single-pane case without requiring an explicit click-to-focus first). If none contains focus and more than one is registered (multi-tile canvas with no tile focused), return `null` — no-op, satisfying PRD Resolved Q6 ("no diff preview focused/visible → no-op").
  - **Making focus-containment actually work (plan-review correction):** neither `DiffView`'s root nor `.preview-body` is focusable today, so clicking anywhere in a diff's text leaves `document.activeElement` on `<body>` — `rootEl.contains(document.activeElement)` would then never match any instance, and on a multi-tile canvas with 2+ open diffs the shortcuts would almost always no-op. Fix: the `interactive` instance's root wrapper div (Decision 5's `rootRef`) gets `tabIndex={-1}` — the standard pattern for making an element programmatically/click-focusable without adding it to normal Tab order. A click anywhere inside that `DiffView` (text, hunk row, caret) now moves `document.activeElement` to `rootEl` via the browser's default "focus nearest focusable ancestor" behavior, so `rootEl.contains(document.activeElement)` reliably matches the tile the user last clicked into. No new event wiring beyond what focus already gives the containment check.
- **Rationale:** gating on `interactive` means chat/settings `DiffView`s are inert by construction (can't steal shortcuts, can't touch `diffLayoutMode`), while DOM-focus/containment correctly picks the tile the user is in when multiple interactive instances coexist (multi-tile canvas mode), which a plain last-register-wins singleton cannot do. `tabIndex={-1}` is what makes that containment check actually resolvable by an ordinary click, rather than requiring the user to first Tab into the pane.
- **Where:** `web-ui/src/preview/diffViewRegistry.ts` (new), used from `DiffView.tsx` and `useWorkspaceKeyboardShortcuts.ts`; `interactive` prop threaded through `DiffView.tsx` and passed at `FilePreviewPane.tsx:601` only; `tabIndex={-1}` added to the same root wrapper div from Decision 5.

```ts
// diffViewRegistry.ts — multi-instance registry, resolved by DOM focus/containment
// at read time (not "last register wins"). Relies on the interactive DiffView's
// rootEl having tabIndex={-1} so a click actually moves document.activeElement there.
export interface DiffViewController {
  rootEl: HTMLElement;
  toggleLayout(): void;
  toggleHunkAtFocus(): void;
}
const active = new Set<DiffViewController>();
export function registerActiveDiffView(c: DiffViewController): () => void {
  active.add(c);
  return () => {
    active.delete(c); // stale-unmount safe: Set.delete is a no-op if already removed/replaced
  };
}
export function getActiveDiffView(): DiffViewController | null {
  const focused = document.activeElement;
  for (const c of active) {
    if (focused && c.rootEl.contains(focused)) return c;
  }
  return active.size === 1 ? [...active][0]! : null;
}
```

#### Decision 3: side-by-side pairing algorithm — bucket consecutive removed/added runs

- **Decision:** `pairHunkLines(lines: DiffLine[])` walks a hunk's flat `DiffLine[]`, mirrors `context` lines on both columns, and for each consecutive `removed`-run followed by `added`-run pairs them index-wise (`Math.max(removed.length, added.length)` rows, `null` padding the shorter side).
- **Rationale:** matches unified-diff's actual emission order (removed lines always precede their replacement added lines within a change block) and matches the PRD's side-by-side mockup exactly (`prd-diff-view-shortcuts.md:91-103`) — no new diff algorithm, just a re-bucketing of already-parsed `hunk.lines` (PRD Non-goal: "no new diff algorithm").
- **Where:** `web-ui/src/preview/diffSideBySide.ts` (new).

```ts
// diffSideBySide.ts
import type { DiffLine } from "./diffParser";

export interface SideBySideRow {
  key: string;
  left: DiffLine | null;
  right: DiffLine | null;
}

export function pairHunkLines(lines: DiffLine[], hunkIndex: number): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "context") {
      rows.push({ key: `${hunkIndex}-${n++}`, left: line, right: line });
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === "removed") { removed.push(lines[i]!); i++; }
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === "added") { added.push(lines[i]!); i++; }
    const max = Math.max(removed.length, added.length);
    for (let k = 0; k < max; k++) {
      rows.push({ key: `${hunkIndex}-${n++}`, left: removed[k] ?? null, right: added[k] ?? null });
    }
  }
  return rows;
}
```

- Shiki highlight lookup for a paired `DiffLine` reuses the *existing* `highlightedByKey` map unchanged: build a `Map<DiffLine, string>` once from `flatRows` (`row.line → row.key`, `DiffView.tsx:110`) and look up `highlightedByKey[lineKeyMap.get(line)]` for whichever `DiffLine` object (same reference as in `hunk.lines`) lands in `left`/`right` — no second highlight pass, no new keying scheme.

#### Decision 4: hunk-target resolution — hover ref, else topmost-visible via `getBoundingClientRect`

- **Decision:** each hunk gets `onMouseEnter={() => (hoveredHunkIndexRef.current = i)}` / `onMouseLeave={() => { if (hoveredHunkIndexRef.current === i) hoveredHunkIndexRef.current = null; }}` attached to the **entire hunk wrapper element** (the `<div>` containing the header row *and* all of that hunk's line rows / collapsed-summary row), not just `.preview-diff-hunk-header` — otherwise moving the mouse off the header onto the hunk's own body lines would (incorrectly) clear the hover target before Alt+H fires. `toggleHunkAtFocus()` uses the hover ref if non-null; otherwise resolves the scroll container via `rootEl.current?.closest(".preview-body") ?? null` (optional-chained; `null` outside `FilePreviewPane`, e.g. a chat-card instance) and, if a container was found, picks the first hunk header element whose `getBoundingClientRect().bottom >= container.getBoundingClientRect().top`. If the container is `null`, `toggleHunkAtFocus()` no-ops (defense-in-depth — after Decision 2's `interactive` gating this path only runs for the `FilePreviewPane` instance, where `.preview-body` always exists, but the null check stays as a guard against future call sites).
- **Rationale:** PRD R4 — "hover, or topmost visible in the scroll viewport"; `.preview-body` (`FilePreviewPane.tsx:663-670`) is the only scrolling ancestor (Research), so `closest()` is sufficient — no new scroll-container prop threading needed. The whole-hunk hover target and the null-safe `closest()` are both plan-review corrections: the header-only hover area was too small to match R4's "hunk under mouse hover," and the non-null assertion (`rootEl.current!`) would throw if this code path ever ran for a non-`FilePreviewPane` instance.
- **Where:** `web-ui/src/components/preview/DiffView.tsx` (only runs when `interactive` is true, per Decision 2).

#### Decision 5: width gate — ResizeObserver on `DiffView`'s own root wrapper, 560px threshold, `interactive`-only

- **Decision:** wrap `DiffView`'s entire return value in one persistent `<div ref={rootRef} className="preview-diff-view">` (across all branches: Rendered, empty-state, hunks) so the `ResizeObserver` target never remounts on mode/branch switches; a `paneWidthRef`-backed state drives (a) the toggle button's `disabled` on the side-by-side option and (b) the CUJ-2 auto-fallback effect. **The `ResizeObserver` is only created, and the auto-fallback effect only runs, when `interactive` is `true`.** A non-interactive instance (chat card, settings fixture) never observes its width and never calls `setDiffLayoutMode`.
- **Rationale:** PRD R3's ~560px threshold must survive Source/Rendered toggling and hunk-collapse re-renders without losing the observed element; a single stable wrapper avoids re-registering the observer on every state change. The `interactive` gate is a plan-review correction: `diffLayoutMode` is global/session-wide (Decision 1), so an un-gated ResizeObserver on a narrow chat-transcript `DiffView` card would spuriously flip the *session-wide* layout mode back to `"inline"` based on a chat card's width, even though the user is looking at a wide, side-by-side file-preview pane — auto-fallback must only ever be driven by the one `interactive` (`FilePreviewPane`) instance.
- **Where:** `web-ui/src/components/preview/DiffView.tsx` — replaces the current early-return structure (`:158-188`) with one wrapper + conditional inner content; `ResizeObserver` setup/effect wrapped in `if (interactive) { ... }`.

#### Decision 6: side-by-side render branch goes in a new `DiffSideBySide.tsx`, not inline in `DiffView.tsx`

- **Decision:** `DiffView.tsx` is already ~224 lines before this plan's changes (wrapper div, width gate, hunk collapse state, hover tracking, registry wiring, layout toggle button, plus the existing Source/Rendered toggle and Shiki highlight plumbing all land in the same file). The two-column side-by-side render (pairing rows via `pairHunkLines`, rendering left/right cells, collapsed-hunk summary spanning both columns) is pulled out into a new `web-ui/src/components/preview/DiffSideBySide.tsx` component, taking `hunks`, `collapsedHunks`, `lineKeyMap`, `highlightedByKey` as props and rendering the `.preview-diff-side-by-side` grid; `DiffView.tsx` just picks which of {inline rows, `<DiffSideBySide>`} to render based on `diffLayoutMode`.
- **Rationale:** keeps `DiffView.tsx` from growing past the repo's file-size guardrail by folding an entire second rendering mode into it; the split is a clean prop boundary (pure presentational component, same data `DiffView` already computes) with no new state or registry involvement — `DiffSideBySide` is not `interactive`-aware itself, it just renders what `DiffView` hands it.
- **Where:** `web-ui/src/components/preview/DiffSideBySide.tsx` (new), imported by `DiffView.tsx`.

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does wrapping all `DiffView` branches in one root div change any existing snapshot/DOM-query test?** | `DiffView.test.tsx` queries by class (`.diff-line--removed` etc.), which stay nested inside the new wrapper — no existing selector breaks; verify in 1.T-series below anyway. |
| 2 | **What if `hoveredHunkIndexRef` is stale after a hunk collapses/expands and hunk indices shift?** | They don't shift — `collapsedHunks` is a `Set<number>` of hunk *array indices* into the same stable `hunks` array; collapsing never removes/reorders hunks, only changes how one renders. |

---

## Implementation Phases

- Each phase ends with a **verification block** — the phase is not complete until those tests pass.
- Test items use `N.Tn` numbering to distinguish them from implementation items.

---

### Phase 1 — Side-by-side layout + hunk collapse (core `DiffView` rework)

- [x] **1.1** Add `web-ui/src/preview/diffSideBySide.ts` — `pairHunkLines(lines, hunkIndex): SideBySideRow[]` (Decision 3).
- [x] **1.2** Add `web-ui/src/preview/diffViewRegistry.ts` — multi-instance `registerActiveDiffView`/`getActiveDiffView`, focus/containment-resolved (Decision 2, revised).
- [x] **1.3** `useStore.ts`: add `diffLayoutMode: "inline" | "side-by-side"` (default `"inline"`) near `diffScopeByWorktree` (~`:214,670`) + `setDiffLayoutMode: (mode) => void` action near `setDiffScopeForWorktree` (~`:1041`) — **not** added to `partialize` (~`:1683-1715`) (Decision 1).
- [x] **1.4** `DiffView.tsx`: add `interactive?: boolean` prop (default `false`). Wrap the whole component return in one stable `<div ref={rootRef} className="preview-diff-view" tabIndex={-1}>` covering the Rendered/empty-state/hunks branches (Decision 5), replacing the current independent early-returns at `:158-188`. `tabIndex={-1}` makes the wrapper click-focusable (not Tab-order-visible) so Decision 2's focus/containment resolution actually has something to match against.
- [x] **1.5** `DiffView.tsx`: when `interactive`, `ResizeObserver` on `rootRef` → `paneWidth` state; effect auto-falls-back `diffLayoutMode` from `"side-by-side"` to `"inline"` when `paneWidth < 560` (CUJ 2) — reads/writes the store field from 1.3. When not `interactive`, no observer is created and this effect does not run (Decision 5, revised — prevents a narrow chat-card instance from flipping the session-wide layout mode).
- [x] **1.6** `DiffView.tsx`: local `collapsedHunks` state (`Set<number>`), reset on `filePath` change; when `interactive`, each hunk's full wrapper (header row + its line/summary rows, not just the header) renders a caret button (`aria-expanded`) toggling that hunk's membership in the set; a collapsed hunk renders one summary row (`"{header} — N lines collapsed"`) instead of its lines. When not `interactive`, no caret is rendered and hunks always render fully expanded (no collapse state UI). Also accept `revealLine?: number` and `onRevealReady?: () => void` props (interactive-only): an effect keyed on `revealLine` finds the hunk containing that line, removes it from `collapsedHunks` if present, then calls `onRevealReady()` after the expansion commits — see CUJ 1's jump-to-line design (plan-review correction).
- [x] **1.7** `DiffView.tsx`: build `lineKeyMap: Map<DiffLine, string>` from `flatRows` (reuses existing `highlightedByKey` keys, Decision 3's snippet note) once per `hunks` change.
- [x] **1.8** Add `web-ui/src/components/preview/DiffSideBySide.tsx` (Decision 6) — presentational component taking `hunks`, `collapsedHunks`, `lineKeyMap`, `highlightedByKey` props; for each non-collapsed hunk, `pairHunkLines(hunk.lines, i)`, renders a two-column grid row per pair (left=old, right=new, both via `lineKeyMap`→`highlightedByKey` for Shiki HTML), right-side/new cell carries `data-line={row.right?.newLineNumber}` (jump-to-line fix, see CUJ 1); collapsed hunks render the same one-row summary spanning both columns. `DiffView.tsx` renders `<DiffSideBySide>` in place of inline rows when `diffLayoutMode === "side-by-side"` and `interactive`.
- [x] **1.9** `DiffView.tsx`: when `interactive`, new "Inline / Side-by-side" toggle button group next to the existing Source/Rendered toggle (`:137-156` pattern) — reads/writes `diffLayoutMode` from the store; "Side-by-side" option `disabled` when `paneWidth < 560` or `displayMode === "rendered"`, with a `title` tooltip explaining why. When not `interactive`, no toggle button is rendered at all.
- [x] **1.10** `DiffView.tsx`: when `interactive`, implement hover tracking (`hoveredHunkIndexRef`, attached to each hunk's whole wrapper element per Decision 4) and topmost-visible fallback with a null-safe `rootEl.current?.closest(".preview-body") ?? null` container lookup; register a `DiffViewController` (`rootEl`, `toggleLayout`, `toggleHunkAtFocus`) via `registerActiveDiffView` in a mount-time effect, unregistering (removing from the `Set`) on unmount/prop change. All controller methods no-op when `displayMode === "rendered"`. When not `interactive`, none of this runs and nothing registers. (Jump-to-line's hunk expansion is handled separately via the `revealLine`/`onRevealReady` props from 1.6 — a direct parent→child path, not part of this registry/controller.)
- [x] **1.11** `FilePreviewPane.tsx:601`: pass `interactive` on its `DiffView` usage (the only call site that does).
- [x] **1.12** `FilePreviewPane.tsx`: pass `revealLine={effectiveLine}` and `onRevealReady={() => setHunksVersion(v => v + 1)}` to its own `DiffView` child (own child, not resolved via the registry); jump-to-line effect (`:446-452`/`~461`) adds `hunksVersion` to its dependency array so it re-runs — and finds the now-rendered row — only after `DiffView` has actually expanded the target hunk and reported readiness, fixing the immediate-`querySelector`-before-expand race (see CUJ 1). Keeps `data-line` matching working for both inline and side-by-side (1.8).
- [x] **1.13** `workspace.css`: add `.preview-diff-side-by-side` (two-column grid), `.preview-diff-layout-toggle`/`__btn`/`__btn--active`/`__btn--disabled` (mirrors `.preview-diff-mode-toggle` at `:5959-5991`), `.preview-diff-hunk-caret`, `.preview-diff-hunk-collapsed` summary-row style.

**Verify phase 1:**
- [x] **1.T1** Unit — `diffSideBySide.test.ts` (new): `pairHunkLines` on `[context, removed, removed, added]` → 1 mirrored context row + 2 paired rows (`left`/`right` from `removed[k]`/`added[k]`).
- [x] **1.T2** Unit — `diffSideBySide.test.ts`: unequal removed/added run lengths (2 removed, 1 added) → 2 rows, second row's `right` is `null`.
- [x] **1.T3** Unit — `DiffView.test.tsx`: with `interactive`, renders `.preview-diff-layout-toggle` with "Inline"/"Side-by-side" buttons whenever `hunks.length > 0`; without `interactive` (default), no `.preview-diff-layout-toggle` renders even with `hunks.length > 0`.
- [x] **1.T4** Unit — `DiffView.test.tsx`: clicking "Side-by-side" (pane width mocked ≥560 via `ResizeObserver` stub, `interactive`) shows a `.preview-diff-side-by-side` container with old lines on the left, new lines on the right.
- [x] **1.T5** Unit — `DiffView.test.tsx`: clicking a hunk's caret (`interactive`) collapses it to a single `.preview-diff-hunk-collapsed` row; clicking again re-expands.
- [x] **1.T6** Regression — `DiffView.test.tsx` existing suites (`diff-line--removed`/`--added`/`--context` selectors, Source/Rendered toggle) still pass unchanged after the wrapper-div refactor (1.4).
- [x] **1.T7** Unit — `DiffView.test.tsx`: button-disabled + shortcut-no-op below width threshold — mock `ResizeObserver` to report `paneWidth < 560` on an `interactive` instance → "Side-by-side" button has `disabled`; calling the registered controller's `toggleLayout()` directly leaves `diffLayoutMode` at `"inline"`.
- [x] **1.T8** Unit — `DiffView.test.tsx`: automatic fallback to inline on shrink — start `interactive` + `diffLayoutMode: "side-by-side"` at width ≥560, fire the mocked `ResizeObserver` callback with width <560 → store's `diffLayoutMode` becomes `"inline"`.
- [x] **1.T9** Unit — `DiffView.test.tsx`: no auto-restore on grow-back — from 1.T8's post-fallback state, fire the observer callback again with width ≥560 → `diffLayoutMode` stays `"inline"` (not auto-restored).
- [x] **1.T10** Unit — `DiffView.test.tsx`: hover-target vs. topmost-visible fallback — (a) with `hoveredHunkIndexRef` set via a simulated `mouseenter` anywhere in hunk 2's wrapper (including a body line, not just the header), `toggleHunkAtFocus()` toggles hunk 2; (b) with no hover and hunk 0 scrolled above the viewport top, `toggleHunkAtFocus()` toggles the topmost currently-visible hunk.
- [x] **1.T11** Unit — `DiffView.test.tsx`: Rendered-mode no-op — `.md` file, `displayMode: "rendered"`, `interactive` — calling `toggleLayout()` and `toggleHunkAtFocus()` on the registered controller are both no-ops (`diffLayoutMode`/`collapsedHunks` unchanged).
- [x] **1.T12** Unit — `DiffView.test.tsx`: hunk-collapsed state resets on file change — collapse hunk 1, then re-render with a new `filePath` → `collapsedHunks` is empty (all hunks render expanded).
- [x] **1.T13** Unit — `DiffView.test.tsx`: non-interactive instances never register — mount `<DiffView diffText={...} />` (no `interactive` prop, matching `ToolResultCard`/`ToolRunSummary`/`SettingsPreviewFixture` usage) → `getActiveDiffView()` stays `null`, and the rendered output has no `.preview-diff-layout-toggle` button and no hunk caret.
- [x] **1.T14** Unit — `useStore.test.ts` (or equivalent): `diffLayoutMode` is confirmed absent from the object returned by `partialize` — construct/inspect the `partialize` output and assert it has no `diffLayoutMode` key, so it never reaches `localStorage`.
- [x] **1.T15** Unit — `diffViewRegistry.test.ts` (new): registering two controllers, then calling the first's unregister function twice (simulating a stale/duplicate unmount) does not remove the second — `getActiveDiffView()` (with focus inside the second's `rootEl`) still returns the second controller.
- [x] **1.T16** Unit — `FilePreviewPane.test.tsx` (or `DiffView.test.tsx` jump-to-line suite): verify the ordering explicitly, not just the end state — render with `revealLine` targeting a line inside a currently-collapsed hunk; assert `querySelector` for that `data-line` finds nothing on the render right after `revealLine` is set (hunk still collapsed, row doesn't exist yet); only after `DiffView`'s expand effect commits and calls `onRevealReady` (bumping `hunksVersion`, driving a `FilePreviewPane` re-render) does `querySelector` find the row and does the scroll-into-view actually run — i.e. hunk expands, THEN scroll happens, never before. Also confirm a side-by-side row's `data-line` lands on the right/new-side cell so the same scroll-matching logic finds it there too.

---

### Phase 2 — Keyboard shortcuts + help dialog wiring

- [x] **2.1** `useWorkspaceKeyboardShortcuts.ts`: add an Alt+D/Alt+Shift+D/Alt+H branch before the `if (!mod) return;` gate (~after `:78`, mirroring the Alt+N block at `:58-78`), guarded by `e.altKey && !e.metaKey && !e.ctrlKey && (e.code === "KeyD" || e.code === "KeyH")` and its own `inEditable` check.
- [x] **2.2** Within that branch: `KeyH` → `e.preventDefault(); getActiveDiffView()?.toggleHunkAtFocus();`.
- [x] **2.3** Within that branch: `KeyD` + `e.shiftKey` → `e.preventDefault(); getActiveDiffView()?.toggleLayout();`.
- [x] **2.4** Within that branch: `KeyD` without shift → `e.preventDefault()`; read `state.activeWorktreeId`/`state.activeFilePath` via `useWorkspaceStore.getState()`; no-op if either is `null`/`undefined`; else `state.setDiffScopeForWorktree(activeWorktreeId, "local"); setToolPanelTab("files");` (reuses the `setToolPanelTab` already destructured at `:36`).
- [x] **2.5** `KeyboardShortcutsDialog.tsx`: add 3 rows to the existing **"Layout"** group (`GROUPS[1]`, `:53-60`, alongside `Ctrl+B`/`Ctrl+E`/`Ctrl+/`/`Ctrl+Shift+Z`) — `{ keys: ["Alt+D"], action: "Jump to file diff" }`, `{ keys: ["Alt+Shift+D"], action: "Toggle inline/side-by-side diff" }`, `{ keys: ["Alt+H"], action: "Expand/collapse diff hunk" }`. Not the "Navigation" group (that's reserved for quick-open/search) and not "Agents & Worktrees" — "Layout" already holds the other viewing/panel-arrangement shortcuts, which these three match in kind. Renders via the existing `KeyCombo`, no new group needed.

**Verify phase 2:**
- [x] **2.T1** Unit — `useWorkspaceKeyboardShortcuts.test.tsx`: with `activeWorktreeId` and `activeFilePath` set, `fireEvent.keyDown(window, { code: "KeyD", altKey: true })` → `diffScopeByWorktree[wt]` becomes `"local"` and `toolPanelTab` becomes `"files"`.
- [x] **2.T2** Unit — `useWorkspaceKeyboardShortcuts.test.tsx`: with `activeFilePath: null`, same keydown → `diffScopeByWorktree` unchanged (no-op).
- [x] **2.T3** Unit — `useWorkspaceKeyboardShortcuts.test.tsx`: with `activeWorktreeId: null` (direct session), same keydown → no-op.
- [x] **2.T4** Integration — mount an `interactive` `DiffView`, `fireEvent.click()` on its root wrapper (simulating the real click-to-focus interaction, exercising the `tabIndex={-1}` path rather than programmatically calling `.focus()`) so it registers itself as the focus-contained instance, then `fireEvent.keyDown(window, { code: "KeyD", altKey: true, shiftKey: true })` → `useWorkspaceStore.getState().diffLayoutMode` flips from `"inline"` to `"side-by-side"`.
- [x] **2.T5** Integration — no interactive `DiffView` mounted, `fireEvent.keyDown(window, { code: "KeyH", altKey: true })` → no throw, no state change (`getActiveDiffView()` returns `null`).
- [x] **2.T6** Regression — existing Alt+N/Alt+Shift+N tests in `useWorkspaceKeyboardShortcuts.test.tsx` still pass (new branch placed before, does not short-circuit them since `e.code` differs).
- [x] **2.T7** Integration — mount a non-interactive `DiffView` the way `ToolResultCard`/`ToolRunSummary`/`SettingsPreviewFixture` do (no `interactive` prop) alongside no other `DiffView` → Alt+D's scope/tab side effects still run (jump-to-diff doesn't depend on the registry), but `fireEvent.keyDown(window, { code: "KeyH", altKey: true })` and `{ code: "KeyD", altKey: true, shiftKey: true }` are no-ops (`getActiveDiffView()` returns `null` since the mounted instance never registered).
- [x] **2.T8** Integration — Q7 no-op in Rendered mode: `interactive` `DiffView` showing a `.md` diff with `displayMode: "rendered"` and focus inside it — Alt+Shift+D and Alt+H both no-op (`diffLayoutMode`/`collapsedHunks` unchanged); Alt+D is unaffected (it only changes scope/tab, independent of Rendered mode).
- [x] **2.T9** Unit — `KeyboardShortcutsDialog.test.tsx` (or snapshot): the "Layout" group renders all three new rows (`Alt+D`, `Alt+Shift+D`, `Alt+H`) with the expected action text.

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/src/preview/diffSideBySide.ts` | **New** | 1.1 | Contract: `pairHunkLines(lines: DiffLine[], hunkIndex: number): SideBySideRow[]` — pure, no state |
| `web-ui/src/preview/diffViewRegistry.ts` | **New** | 1.2 | Contract: `registerActiveDiffView(c): () => void`, `getActiveDiffView(): DiffViewController \| null` · Owns: module-level multi-instance `Set`, resolved by DOM focus/containment (Decision 2, revised) |
| `web-ui/src/hooks/useStore.ts` | **Modified** | 1.3 | Add `diffLayoutMode` field + `setDiffLayoutMode` action; deliberately excluded from `partialize` |
| `web-ui/src/components/preview/DiffView.tsx` | **Modified** | 1.4-1.7, 1.9-1.10 | New `interactive` prop (default `false`); wrapper div with `tabIndex={-1}` (click-focusable for registry containment resolution); ResizeObserver width gate, hunk collapse state, `revealLine`/`onRevealReady` jump-to-line expansion, layout toggle button, registry registration, hover/topmost hunk targeting — all gated on `interactive`; renders `<DiffSideBySide>` when active |
| `web-ui/src/components/preview/DiffSideBySide.tsx` | **New** | 1.8 | Presentational two-column side-by-side render branch, split out of `DiffView.tsx` for file-size guardrails (Decision 6); tags right/new-side cell with `data-line` |
| `web-ui/src/components/layout/FilePreviewPane.tsx` | **Modified** | 1.11-1.12 | Passes `interactive` to its `DiffView` (only call site that does); also passes `revealLine`/`onRevealReady` (direct prop path to its own child `DiffView`, not the registry); jump-to-line effect (`:446-452`) depends on `hunksVersion` so it re-runs — and scrolls — only after the target hunk has actually expanded |
| `web-ui/src/styles/workspace.css` | **Modified** | 1.13 | New classes for side-by-side grid, layout toggle, hunk caret/collapsed row |
| `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.ts` | **Modified** | 2.1-2.4 | New Alt+D/Alt+Shift+D/Alt+H branch |
| `web-ui/src/components/layout/KeyboardShortcutsDialog.tsx` | **Modified** | 2.5 | 3 new rows in the existing "Layout" `GROUPS` entry |
| `web-ui/src/preview/diffSideBySide.test.ts` | **New** | 1.T1-1.T2 | Unit tests for the pairing algorithm |
| `web-ui/src/preview/diffViewRegistry.test.ts` | **New** | 1.T15 | Unit tests for multi-instance registration/unregistration and focus resolution |
| `web-ui/src/components/preview/DiffView.test.tsx` | **Modified** | 1.T3-1.T14, 1.T16 | New layout-toggle/collapse/width/hover/Rendered-no-op/non-interactive tests + regression pass |
| `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.test.tsx` | **Modified** | 2.T1-2.T8 | New Alt+D/Alt+Shift+D/Alt+H tests (incl. Q7 Rendered no-op, non-interactive no-op) + regression pass |
| `web-ui/src/components/layout/KeyboardShortcutsDialog.test.tsx` | **Modified** | 2.T9 | Assert the 3 new rows render in the "Layout" group |
