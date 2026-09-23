<!--
RULES — read before writing this report:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. ANSWER FIRST: the finding goes at the top, before any evidence
3. EVERY CLAIM CITED: file:line, a command + its output, or a screenshot
4. READING TIME: optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Report: In-file search ("/", Ctrl+F-style) inside the preview pane

**Date:** 2026-09-22 · **Commit:** `e763fa9` (branch `search-ux-nav-and-layout`) · **Scope:** `web-ui/src/components/layout/FilePreviewPane.tsx`, `MasterDetailShell.tsx`, `web-ui/src/components/preview/CodeView.tsx`, `MarkdownView.tsx`, `DiffView.tsx`, `web-ui/src/hooks/useStore.ts`, `useWorkspaceKeyboardShortcuts.ts`, `web-ui/src/styles/workspace.css` · **Method:** full reads of the above, no code changed

**Note on scope:** this is a *different* feature from `.vibekit/feature-plans/wip/search-ux-nav-and-layout/` (that one is cross-file content search — the Search rail mode, backed by `rg` on the daemon). This report covers a new, purely client-side **in-file** find — search only the text already loaded for the currently-open file in the preview pane, like browser/VS Code Ctrl+F, triggered by a bare `/`. Nothing below exists in the codebase yet.

## Answer

- **Trigger:** bind bare `/` **locally** to the preview pane's own container (`onKeyDown` on the `.pane.pane-stack` wrapper in `FilePreviewPane.tsx:579`), not as a new case in the global `useWorkspaceKeyboardShortcuts.ts` window listener. Two independent reasons force this: (1) that hook's handler returns early on any key when `!mod` (`useWorkspaceKeyboardShortcuts.ts:80`), so bare `/` never reaches it today — folding it in would mean carving out a mod-less path in a hook whose entire contract today is "mod-chord shortcuts only"; (2) workspace-canvas mode can mount **multiple `FilePreviewPane` instances at once** (`Workspace.tsx:475,598,666` — one Files tile per worktree tile), so a single global `/` listener has no principled way to pick *which* pane's file to search. A container-scoped listener sidesteps the ambiguity by construction: `/` only searches whichever pane last had DOM focus.
- **State lives locally**, not in the global Zustand store. `peekFile`/`pendingLineTarget` are global-but-worktree-keyed (`useStore.ts:178,187`) because they represent a *cross-component* handoff (Search rail → preview pane). In-file search has no second consumer — it's entirely internal to one `FilePreviewPane` instance — so `useState` inside the component is sufficient and (per the multi-instance point above) actually the only option that doesn't need extra keying gymnastics.
- **Render-path scope for v1: `CodeView` only.** The app has three preview renderers and only one exposes a searchable, per-line DOM: `CodeView.tsx` renders one `.workspace-code-line` div per line (`CodeView.tsx:99-108`); `MarkdownView.tsx` renders arbitrary React-Markdown output with no per-line structure at all; `DiffView.tsx` has its own `diff-line`/`diff-gutter` structure and accepts no `highlightLine`/`highlightMatchText` props today. Recommendation: restrict v1 to `scope === "none"` (plain file, not a diff view) and, for `.md` files, **force `rawMarkdown = true`** when search activates (reusing the existing Source/Formatted toggle at `FilePreviewPane.tsx:101,565-574`) so `CodeView` is guaranteed to be mounted. This mirrors a limitation the codebase already has and accepts: the jump-to-line effect's own comment notes it silently no-ops "e.g. Markdown pretty-view" (`FilePreviewPane.tsx:400-402`).
- **Highlighting mechanism:** extend `CodeView`'s existing single-line-single-match raw-text-splice technique (`CodeView.tsx:73-88`, already used for jump-to-line's `highlightMatchText`) to *all* matched lines / *all* matches per line, with the current match getting a distinct modifier class. This reuses a technique the codebase has already accepted the tradeoff for ("trading syntax color for one line... is a safe tradeoff", `CodeView.tsx:76-78`) rather than introducing a new overlay/Range-measurement subsystem — see Key Decisions for the overlay alternative and why it's not the v1 pick.
- **Navigation:** Enter / Shift+Enter cycles next/previous match (wrap-around), reusing the exact same `scrollIntoView({block: "center"})` call already used for jump-to-line (`FilePreviewPane.tsx:396-398`) — driven by the search bar's local match-index state, not the store's `effectiveLine`. Escape closes the bar, clears all highlights, and returns focus to the preview container (mirrors the existing `search-ux-nav-and-layout` report's Escape convention — "returns to the [input]" — for the same reasoning: predictable full-reset on Escape).

## Evidence

| Claim | Source |
|---|---|
| Global shortcut hook only fires when a mod key is held; bare `/` never reaches it | `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.ts:56,80` |
| `Mod+/` is already bound (tool split orientation toggle) — bare `/` is free, but the chord is taken | `web-ui/src/hooks/useWorkspaceKeyboardShortcuts.ts:115-122` |
| No existing bare-`/` binding anywhere in `web-ui/src` | `grep -rn 'key === "/"\|"Slash"' web-ui/src` → only unrelated hits (paths, slash-commands) |
| Workspace canvas mode can mount multiple worktree tiles, each with its own Files/preview pane, simultaneously | `web-ui/src/routes/Workspace.tsx:475` (`inWorkspaceCanvas`), `:598,666` (`<WorkspaceCanvas>` render sites) |
| No "active/focused tile" concept exists to disambiguate a global shortcut across canvas tiles | `grep -n "activeTile\|focusedTile\|focusTile" web-ui/src/components/layout/WorkspaceCanvas.tsx` → no matches |
| `CodeView` renders one real DOM line per source line, addressable via `.workspace-code-line` | `web-ui/src/components/preview/CodeView.tsx:99-108` |
| Existing single-line match-highlight already special-cases raw-text splicing around Shiki HTML to avoid mid-tag corruption | `web-ui/src/components/preview/CodeView.tsx:73-88` |
| `MarkdownView` renders via `react-markdown`, no per-line structure | `web-ui/src/components/preview/MarkdownView.tsx:106-115` |
| `DiffView` has its own line structure (`diff-line`/`diff-gutter`/`diff-marker`), no `highlightLine` prop | `web-ui/src/components/preview/DiffView.tsx:16-34,202-204` (props interface has no highlight fields; body render uses `diff-gutter`/`diff-marker`, not `workspace-code-*`) |
| Jump-to-line already accepts "no matching line element in current render" as a known no-op case (pretty-Markdown) | `web-ui/src/components/layout/FilePreviewPane.tsx:400-402` |
| `rawMarkdown` toggle already exists and is exactly the lever needed to force `CodeView` for `.md` files | `web-ui/src/components/layout/FilePreviewPane.tsx:101,524,565-574` |
| Existing jump-to-line scroll mechanism (`scrollIntoView`, consumed-key tracking) is directly reusable for match navigation | `web-ui/src/components/layout/FilePreviewPane.tsx:304-403` (`lastScrolledKeyRef`, `effectiveLine`, the scroll effect) |
| `peekFile`/`pendingLineTarget` are single global store slots (not per-instance) — the precedent for why NEW in-file-search state should NOT follow this pattern | `web-ui/src/hooks/useStore.ts:167-187,653-654` |
| Preview body is explicitly exempted from the tree's click-steals-focus behavior — clicking into the preview to focus it for `/` is already safe today | `web-ui/src/components/layout/MasterDetailShell.tsx:96-105` (`handleRightPanePointerDown` exempts `.preview-body`) |
| Existing top-right absolute-positioned overlay precedent (font size controls) — the slot a search bar would compete with / dock near | `web-ui/src/components/layout/FilePreviewPane.tsx:557-576`; CSS `web-ui/src/styles/workspace.css:5628-5637` (`.preview-font-overlay { position: absolute; top: var(--space-2); right: var(--space-2); }`) |
| Slim `diffInfo` strip already occupies the top of every preview pane, all scopes, all files | `web-ui/src/components/layout/FilePreviewPane.tsx:451-467`; CSS `web-ui/src/styles/workspace.css:5658-5669` |
| No highlighting/text-search library (mark.js or similar) is already a dependency — any approach is new code | `web-ui/package.json` — only `highlight.js`, `shiki`, `rehype-highlight`, `remark-gfm`, no `mark.js`/`fuse`/search-text lib |
| Cross-file `SearchPanel`'s case/regex/word toggles + sticky-persistence pattern (`Aa .* \b`) — the UI convention this feature should visually rhyme with | `web-ui/src/components/tools/SearchPanel.tsx:68-100` |

## Detail

### Current state — three preview render paths, one searchable

```
FilePreviewPane (FilePreviewPane.tsx:40)
 ├─ scope=binary image        → ZoomableMedia              (no text at all)
 ├─ scope=local/branch/commit → DiffView                    (own diff-line DOM, no highlight props)
 ├─ scope=none, isMd, !raw    → MarkdownView (react-markdown) (no per-line DOM)
 └─ scope=none, (!isMd||raw)  → CodeView                     (.workspace-code-line per line — SEARCHABLE)
```
- `body` selection logic: `FilePreviewPane.tsx:490-549`.
- Only the last branch produces a DOM shape (`highlightLine`/`highlightMatchText` props already flow into it) that a per-line/per-match highlight scheme can hook into.

### Current focus/keyboard model

- `FilePreviewPane`'s root is a plain `<div className="pane pane-stack" style={{position:"relative"}}>` (`FilePreviewPane.tsx:579`) — no `tabIndex`, not currently focusable, no `onKeyDown`.
- `MasterDetailShell.tsx:96-105`'s `handleRightPanePointerDown` walks the composed event path on every pointerdown in the right pane and **exempts** `.preview-body` (among others) from its "refocus the tree" behavior — clicking inside the preview to give it focus already works without side effects today.
- The app-wide keyboard hook (`useWorkspaceKeyboardShortcuts.ts:42-55`) has an `inEditable` guard pattern (`INPUT`/non-xterm `TEXTAREA`/`SELECT`/`contentEditable`) worth mirroring for the new local handler, so `/` typed into the chat composer, a dialog field, etc. is never intercepted — though scoping the listener to the preview container's own `onKeyDown` (React synthetic event, not `window`) already achieves this for free: it only fires when that specific container (or a focusable descendant that lets it bubble) has focus.

### Proposed approach

**1. Activation surface**
- Make the preview container focusable: `tabIndex={-1}` on the `.pane.pane-stack` root (or on `.preview-body`, `FilePreviewPane.tsx:582-589`), focused via the container's own `onPointerDown` (mousedown) so a single click anywhere in the preview — which already doesn't steal focus to the tree per the exemption above — leaves DOM focus inside this specific pane.
- `onKeyDown` on that same container: if `e.key === "/"` and not already inside an editable descendant (reuse the `inEditable`-style tag check), `e.preventDefault()` and open the search bar.
- This is inherently per-instance — two canvas tiles each get their own listener, each only fires for the tile the user actually clicked into. No global disambiguation needed.

**2. Search bar UI**
- New local component (e.g. `InFileSearchBar.tsx`), rendered conditionally inside `FilePreviewPane`'s `position:relative` wrapper, alongside the existing `fontOverlay` (`FilePreviewPane.tsx:557-576`) and `diffInfo` (`:451-467`).
- Controls, modeled on `SearchPanel.tsx:68-100`'s existing case/regex toggle convention for visual/behavioral consistency: query input, `Aa` (case), `.*` (regex) toggle buttons, match counter (`3/17`), prev/next chevrons, close `×`.
- Local `useState` only: `{ open, query, caseSensitive, regex, matches: {line, start, end}[], currentIndex }`. No store slice, no persistence (sticky case/regex prefs are a nice-to-have follow-up, not required for v1 — see Follow-ups).

**3. Match computation**
- Pure client-side over the already-fetched `fileBody` string (`FilePreviewPane.tsx:90`) — no API call, unlike cross-file search. Debounce not strictly required (single-file text scan is cheap) but a light debounce (e.g. 50-100ms) avoids recomputing on every keystroke for very large files.
- Regex mode: wrap user pattern in `new RegExp(pattern, caseSensitive ? "g" : "gi")`, guarding invalid patterns (`try/catch`, show inline error) — same defensive pattern the daemon-side cross-file search presumably already needs for user-supplied regex.

**4. Highlighting**
- Extend `CodeView` props: replace singular `highlightLine`/`highlightMatchText` usage-for-search with a `searchMatches?: {line: number; matches: {start: number; end: number}[]}[]` (or a `Map<number, {start,end}[]>`) plus `currentMatch?: {line: number; start: number}`.
- Per matched line, split the raw line text around each match span (same technique as `CodeView.tsx:79-88`, generalized from "one match" to "N matches on this line"), wrapping each in `<mark className="workspace-code-match">`, with the current match getting `workspace-code-match--current` for a distinct color/outline.
- This **bypasses Shiki's highlighted HTML for every matched line** (not just the single jump-to-line target) while search is active — an extension of a tradeoff the codebase already made once, not a new one.

**5. Navigation & lifecycle**
- Enter → next match (wrap), Shift+Enter → previous (wrap), also expose prev/next buttons in the bar for mouse users.
- On `currentIndex` change: reuse the exact `scrollIntoView({block:"center"})` call pattern from the jump-to-line effect (`FilePreviewPane.tsx:396-398`), targeting the current match's line element directly (no need to route through the store's `effectiveLine`/`peekFile` machinery — that's for cross-component handoff, this is self-contained).
- Escape → close bar, clear `matches`/highlights, `container.focus()` (so arrow keys / further `/` presses keep working without a re-click).
- Query change while `.md` file forced into raw mode: if the bar closes and the user never manually re-toggled Source/Formatted, restore `rawMarkdown` to whatever it was before activation (track a "was auto-forced" flag) — avoids permanently flipping a file into raw view just because the user searched it once.

**Key design decisions and tradeoffs**

| Decision | Options | Recommendation |
|---|---|---|
| Where does the `/` listener live? | (a) new case in the global `useWorkspaceKeyboardShortcuts.ts` window listener; (b) local `onKeyDown` on the focused preview container | **(b)** — (a) requires carving a mod-less exception into a hook whose contract is "mod chords only" (`:80` early-return), and still can't disambiguate which of N canvas tiles should receive it; (b) is correct by construction and requires no new global state |
| Where does search state live? | (a) new global store slice (worktree-keyed, like `peekFile`); (b) local `useState` inside `FilePreviewPane`/the new bar component | **(b)** — nothing outside this one component ever needs to read it; a worktree-keyed global slot doesn't even fully solve multi-instance (two tiles on the *same* worktree, if ever possible, would collide) where local state can't collide by definition |
| Which render paths get search in v1? | (a) `CodeView` only (scope=none, non-diff); (b) also extend `DiffView`; (c) also extend rendered Markdown | **(a)** — `DiffView` has a structurally different, currently non-extensible DOM/props surface (bigger lift, own report-worthy design); rendered Markdown has no per-line addressable DOM at all (would need a Range/TreeWalker-based approach, see next row). Both are plausible fast-follows, not v1 blockers, since `/` can simply be a no-op (or show "search unavailable in diff view") outside scope=none |
| Markdown handling | (a) disable `/` entirely on `.md` files unless already in raw/source mode; (b) auto-force `rawMarkdown=true` on activation, auto-restore on close | **(b)** — matches user intent better (most people expect Ctrl+F to "just work" on whatever they're looking at); the toggle already exists and is cheap to drive programmatically, and the restore-on-close keeps it from being a surprising permanent side effect |
| Highlight implementation | (a) extend the existing raw-text-splice-per-line technique to all matched lines; (b) new Range/`getClientRects()`-based absolutely-positioned overlay, leaving Shiki HTML untouched | **(a) for v1** — reuses a technique the codebase already accepted the syntax-color tradeoff for, no new subsystem, no risk of overlay-position drift on resize/scroll/font-zoom (the preview already has a font-zoom overlay at `FilePreviewPane.tsx:557-576`, meaning any overlay-based highlight would need to recompute on every zoom step too). (b) is the more "correct" long-term answer (keeps syntax coloring on every match line, not just the non-matched ones) but is a materially bigger, novel piece of work — flag as a fast-follow if the syntax-color loss on multi-match files reads as a regression in practice |
| Match navigation input | (a) Enter/Shift+Enter (browser/VS Code convention); (b) ↓/↑ arrows; (c) both | **(c)** — Enter/Shift+Enter is the dominant Ctrl+F convention (matches browsers, VS Code, GitHub code search) and should be primary; arrow keys are a low-cost addition since the container already owns keydown and nothing else claims them while the bar is open |
| Case/regex toggle persistence | (a) sticky via `api.getSettings()`/`updateSettings()`, mirroring `SearchPanel.tsx:78-100`; (b) resets every time the bar opens | **(b) for v1** — this is a much lighter-weight, more ephemeral interaction than cross-file search (open, find, close, gone); adding daemon-settings round-trips for a per-keystroke-adjacent toggle is disproportionate. Revisit as a follow-up if users ask for sticky regex/case here too |

**Risks / things that could break**

- **Shiki re-highlight timing**: `CodeView`'s syntax highlighting is async (`CodeView.tsx:47-64`, `highlightDocumentLines`) and only resolves after the initial render (plain-text lines shown first, then re-rendered with highlighted HTML once the effect resolves). If search activates before that effect resolves, matched-line splicing must work against `highlightedLines[i] ?? escapeHtml(line)`'s *eventual* value too, not just the immediate plain-text fallback — needs the highlight computation to re-run (or be deferred) whenever `highlightedLines` changes while search is active.
- **Large files**: `CodeView` renders every line unconditionally, no virtualization (`CodeView.tsx:68` maps over the full `lines` array) — a regex/plain scan over a very large file plus per-line splicing for potentially hundreds of matches could be a real perf cost; worth a sanity cap (e.g. stop highlighting past N matches, show "+more" in the counter) mirroring how the daemon-side search likely caps results.
- **Interaction with existing `highlightLine`/`highlightMatchText` (jump-to-line)**: a file can simultaneously have an active `peekFile`/`pendingLineTarget` highlight (from cross-file search or tree navigation) AND an in-file search open — `CodeView` needs a clear precedence rule (recommend: in-file search's own highlighting takes over visually while its bar is open; the peek/pending target highlight can coexist as long as the styling doesn't collide, e.g. different colors) rather than one silently overwriting the other.
- **Focus fights**: `MasterDetailShell.tsx:96-105`'s exemption list (`pre, .cm-scroller, .preview-body, .workspace-markdown-preview, [data-no-tree-focus]`) must keep including whatever the search bar's own input renders inside — if the bar is portaled or renders outside `.preview-body`'s subtree, add it (or a `[data-no-tree-focus]` attribute) to that exemption, or a click into the search input will get its focus stolen back to the tree.

## Not checked

- No existing test file for `FilePreviewPane.tsx`/`CodeView.tsx` keyboard interaction was read in depth — only grepped for prior art; a full implementation needs new coverage, and this report doesn't enumerate exactly what the existing `FilePreviewPane.test.tsx` already asserts that new behavior must not break.
- Did not measure actual render cost of per-line splicing for a large file with many matches (the "Large files" risk above is a reasoned inference, not a benchmark).
- Did not investigate the `VcsCommitView.tsx` embedding of `FilePreviewPane` (`controlled` prop path, `FilePreviewPane.tsx:23-38`) — whether in-file search should also be available there, or should be suppressed for `controlled` previews, is unresolved.
- Did not design the exact visual layout/CSS for the new search bar beyond "docks near the existing top-right overlay" — no mockup pixel-fitting against `.preview-font-overlay`'s real dimensions was done beyond reading its CSS rule.
- Did not check whether `/` is reserved by any browser/OS chrome in a way that would block `preventDefault()` (unlike e.g. Ctrl+N) — no evidence found of this being an issue since it's a non-modified printable key, but not exhaustively verified across browsers.

## ASCII mockups

**Preview pane, code view, before activation** (baseline — existing UI, unchanged):

```
┌──────────────────────────────────────────────────────────┐
│ +12 −3   Compared to HEAD                    [－][＋][Src]│  ← diffInfo (existing) + fontOverlay (existing, top-right)
├──────────────────────────────────────────────────────────┤
│  1  import { useState } from "react";                    │
│  2                                                        │
│  3  export function useRovingListNav(rows: RovingRow[]) { │
│  4    const [cursorPath, setCursorPath] = useState<...>();│
│  5    ...                                                 │
└──────────────────────────────────────────────────────────┘
     ↑ user clicks anywhere in here, pane gets focus (no side effects — already exempted from tree refocus)
```

**`/` pressed → search bar opens, docked below the font overlay, matches highlighted live as you type:**

```
┌──────────────────────────────────────────────────────────┐
│ +12 −3   Compared to HEAD                    [－][＋][Src]│
│                              ┌───────────────────────────┐│
│                              │ cursorPath  Aa .*  2/4 ↑↓ ×││  ← new InFileSearchBar
│                              └───────────────────────────┘│
├──────────────────────────────────────────────────────────┤
│  1  import { useState } from "react";                    │
│  2                                                        │
│  3  export function useRovingListNav(rows: RovingRow[]) { │
│  4    const [▓cursorPath▓, set▓CursorPath▓] = useState<..>│  ← all matches marked (dim)
│  5    ...                                                 │
│  6    function moveTo(█cursorPath█: string) {             │  ← CURRENT match (bright/outlined), line auto-scrolled
│  7      ...                                                │
└──────────────────────────────────────────────────────────┘
   ▓...▓ = ordinary match highlight (workspace-code-match)
   █...█ = current match, distinct style (workspace-code-match--current), centered via scrollIntoView
```

**Enter pressed → advances to next match, counter updates, previous current-match reverts to ordinary highlight:**

```
┌──────────────────────────────────────────────────────────┐
│ +12 −3   Compared to HEAD                    [－][＋][Src]│
│                              ┌───────────────────────────┐│
│                              │ cursorPath  Aa .*  3/4 ↑↓ ×││
│                              └───────────────────────────┘│
├──────────────────────────────────────────────────────────┤
│  4    const [▓cursorPath▓, set▓CursorPath▓] = useState<..>│
│  ...                                                       │
│ 22  export const initial█CursorPath█ = null;               │  ← view auto-scrolled to this line, now current
└──────────────────────────────────────────────────────────┘
```

**Escape pressed → bar closes, all highlights cleared, focus stays in the preview pane (no scroll jump):**

```
┌──────────────────────────────────────────────────────────┐
│ +12 −3   Compared to HEAD                    [－][＋][Src]│
├──────────────────────────────────────────────────────────┤
│ 22  export const initialCursorPath = null;                │  ← back to plain syntax-highlighted rendering
│ 23                                                         │
└──────────────────────────────────────────────────────────┘
```

Key behaviors encoded in these mockups:
- The bar is a small floating box, not a full-width strip — it does not push the code down or replace `diffInfo`.
- It docks near (below/beside) the existing font-size overlay rather than colliding with it — exact placement is a CSS detail, not resolved here (see Not checked).
- Match highlighting only exists while the bar is open; closing it (Escape or `×`) fully reverts to the normal syntax-highlighted view.
- The view auto-scrolls to keep the current match centered, reusing the exact mechanism jump-to-line already has.
- `Aa` / `.*` toggle icons and the `N/M` counter directly mirror the cross-file `SearchPanel`'s existing visual language for consistency, per Evidence.

## Follow-ups

| # | Question | Why it matters |
|---|---|---|
| 1 | Should in-file search eventually extend to `DiffView` (local/branch/commit scopes) and rendered Markdown, or stay CodeView-only indefinitely? | Determines whether the v1 scope limit is a permanent product decision or a phased rollout — affects how much the CodeView-specific highlight API should be designed for reuse vs. kept simple |
| 2 | Should case/regex toggles be sticky (persisted via `api.updateSettings()`, like cross-file search) or always reset? | This report recommends "always reset" for v1 as lower-effort/lower-risk; confirm that's acceptable UX before building |
| 3 | Does `VcsCommitView.tsx`'s `controlled` `FilePreviewPane` usage want in-file search too, or should it be suppressed there? | Unresolved in this report (see Not checked) — affects whether the trigger/bar mounts unconditionally or is gated by a new prop |
| 4 | Any interaction wanted between in-file search and cross-file search (e.g. "search in this file" launched FROM a cross-file search result)? | Out of scope for this report but a plausible follow-on UX request once both exist |
