<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# PRD: Code Navigation (LSP go-to-def, hover/references, outline)

> Adds Ctrl/Cmd-click go-to-definition, LSP-backed hover and find-references, and an outline/symbols view to the file preview pane, working for both direct and worktree sessions.

**Status:** Draft
**Technical plan:** `.vibekit/feature-plans/pending/code-nav-lsp-outline/plan-code-nav-lsp-outline.md` _(link once the plan exists)_

---

## Problem

- The file preview pane is read-only text with no structural awareness — no way to jump to a symbol's definition, see its type, or find where it's used
- Understanding an unfamiliar file (especially one an agent just touched) requires manually scanning or switching to a terminal-based tool
- There is no at-a-glance list of a file's functions/classes/symbols — orientation in a large file is slow

## Goals

- Jump to a symbol's definition, from mouse or keyboard, from the file preview pane
- See a symbol's type/signature and short doc on hover, without leaving the file
- List and jump to all references of a symbol
- See a file's symbol structure (outline) and jump to any entry
- Retrace navigation history (back/forward) across all of the above
- All of the above work identically whether the session is a worktree checkout or a direct (no-worktree) project session

## Non-goals

- Editing (the preview pane stays read-only; LSP-driven autocomplete, rename, code actions, diagnostics/squiggles are out of scope for this version)
- A new caret/text-cursor model for the preview pane — the keyboard path acts on the browser's native text selection, not a virtual cursor
- Call hierarchy (in/out calls) — deferred, not requested
- Touch/mobile input (Ctrl/Cmd-click and hover have no touch equivalent in this version) — explicit non-goal, not silently broken
- Cross-worktree navigation (jumping from one worktree's file into a different worktree's copy) — each worktree's LSP is scoped to its own root
- Installing/managing language servers for the user — assume common ones are present on the daemon host; a missing server shows a clear status, no bundled installer flow in this version
- Navigation, hover, references, and outline inside diff views, rendered-markdown view, or historical-commit view — plain working-tree file view only, since line numbers elsewhere don't match what the language server sees
- Precise per-symbol hover cues while a modifier key is held (would require an LSP round trip per mouse movement) — the only pre-click affordance is a crosshair pointer-cursor change, confirmed navigability comes from the click itself

---

## Requirements

### 1. Go-to-definition

| ID | Requirement |
|----|-------------|
| R1 | Ctrl/Cmd-click a symbol jumps to its definition; a matching keyboard shortcut acts on the current text selection; a single match navigates directly, multiple matches show a pickable list anchored at the click/selection point. |
| R2 | Go-to-def, references, and outline jumps share one ephemeral preview slot with the existing search-result peek — a new jump always replaces whatever is currently previewed (tagged with its own icon so the source is clear); whatever occupied the slot at the moment it's replaced is pushed to back/forward (R4), so it's always recoverable, even a search peek the user never "committed." |
| R3 | Double-clicking a preview tab itself (not the code body) promotes it to a permanent tab; jumping to a file already open as a tab, or the same file, reuses/scrolls it instead of creating a duplicate preview. |
| R4 | A per-session (worktree or direct) back/forward history retraces every preview-pane navigation — tree clicks, search commits, go-to-def, references, outline — via dedicated buttons and a shortcut that does not collide with the browser's own back/forward. |

### 2. Hover & references

| ID | Requirement |
|----|-------------|
| R5 | Hovering a symbol shows its type/signature and short doc in a tooltip; it stays open while the pointer is over it (including scrolling inside its own doc text) and dismisses on Esc, click-away, or scrolling the code underneath. |
| R6 | "Find references" opens a persistent list, grouped by file, in the same panel area as outline/search; clicking a result previews it without closing the list; the declaration is marked; long lists load more rather than truncating unreachably. |

### 3. Outline / symbols

| ID | Requirement |
|----|-------------|
| R7 | An Outline view lists the current working-tree file's symbols, with distinct empty/loading/unsupported-file-type states and a filter box for large files, tracks whatever file the preview is showing, and highlights the innermost symbol enclosing the current scroll position. |

### 4. Scope & status

| ID | Requirement |
|----|-------------|
| R8 | Navigation, hover, references, and outline work the same for direct sessions and worktree sessions, scoped to that session's own working directory; a definition outside that root opens read-only (viewable, not promotable to a permanent tab) with an "outside workspace" indicator. |
| R9 | Every surface (go-to-def, hover, references, outline) surfaces starting/indexing/no-results at its own point of use (hover is exempt from a no-results message — it just shows nothing); language-unavailable/server-not-found/stopped are shown once, in the shared Files-tab status, since they're per-worktree-language facts, not per-surface ones; a lookup that's still genuinely pending shows a cue after a short delay instead of looking like a dead click. |

---

## Options considered

### Go-to-def preview behavior

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — One shared ephemeral preview slot for both search peek and definition/reference/outline jumps, protected by back/forward instead of a no-clobber guarantee | Matches the existing single-preview-tab UI exactly; no new tab-strip layout; nothing is ever silently lost — the prior peek is one Back away | A definition jump does replace a live search peek (and vice versa) — this is a real, visible interruption, just a recoverable one | ✅ chosen |
| B — Two independently-tracked preview tabs shown side by side (search peek + definition peek) | Neither navigation source ever interrupts the other | New tab-strip layout question (two preview-style tabs competing for space); doubles the "why is this tab open" surface for the user to parse | ❌ deferred |

**Decision:** Option A. An earlier draft of this PRD claimed search and definition peeks would "never clobber" each other while still using one slot — that was inconsistent with the existing single-`peekFile`-slot store design and has been corrected here: they share the slot, a new jump always wins, and recoverability comes entirely from R4's back/forward history, not from slot isolation.

### Outline/symbols panel placement

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — New mode of the existing Files-tab left pane, alongside its current Tree/Search modes | Reuses the existing tree\|preview two-pane shell and its mode-switching pattern as-is; zero new panel/dock infrastructure | Outline/References and Tree/Search can't be visible at the same time | ✅ chosen |
| B — New panel on the right of the open file | Outline and code visible simultaneously | No right-side panel/dock infrastructure exists anywhere in the app today — this is a new N-pane docking system, not a small addition | ❌ deferred |

**Decision:** Option A — Outline and References become two more modes of the Files tab's left pane (alongside its existing Tree and Search modes), each scoped to whatever file is currently shown in the preview pane. Revisit Option B only if a genuine multi-panel dock gets built for other reasons.

### Outline data source

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — LSP-sourced only | One data source, consistent with go-to-def/hover/references; symbol kinds and nesting are accurate | Outline is only as fast/available as the language server (shares its status states) | ✅ chosen |
| B — Fast structural-parse fallback shown first, LSP symbols swapped in when ready | Outline appears instantly even before the server is ready | A second symbol-extraction engine to build and keep consistent with LSP output — real scope for a "keep it tiny" PRD | ❌ deferred |

**Decision:** Option A — outline shares go-to-def/hover/references' LSP connection and status states (R9); it is **not** independent of the language server, and cannot ship ahead of the foundation sub-feature 1 establishes (see Priority & sequencing).

---

## Resolved design questions

1. **Can search and definition peeks both stay visible at once?** — No (see Options § Go-to-def preview behavior). One shared slot; a new jump always replaces the current peek; back/forward is how the user recovers what was replaced.
2. **Where do Outline and References live?** — As two more modes of the Files tab's left pane, next to its existing Tree/Search modes — not a new right-side panel.
3. **Does code nav require a worktree?** — No. It resolves each session's own working directory (worktree checkout, or the project root for a direct session) as the LSP workspace root, same as file-tree/file-content endpoints already do today.
4. **What happens if references/definition can't be found via LSP?** — Show an explicit "No definition/references found for `<symbol>`" message at the point of use (R9) — never a silent no-op, once the server has actually answered. A regex/text-search fallback is not required for this version.
5. **Does hover/go-to-def work across languages a server isn't installed for?** — No; the UI shows "not available for this file type" (unsupported language) distinctly from "language server not found on daemon host" (supported language, missing binary) — both covered by R9, neither silent.
6. **What happens to a click on a non-navigable spot (whitespace, punctuation, keyword, comment/string)?** — Once the server has confirmed it's ready and answered for that exact position: silent no-op, no status shown. While readiness for that position is still unconfirmed (server starting/indexing), the click instead shows "waiting for language server…" uniformly — the UI cannot tell "not a symbol" from "not answered yet" until an answer arrives, so it doesn't try to guess.
7. **What signals a symbol is navigable before the user clicks?** — Holding the go-to-def modifier (Ctrl, or Cmd on macOS) switches the pointer to a crosshair over code text — a local-only, no-server-round-trip cue. It does not underline a precise symbol boundary (that would need an LSP call per mouse movement); actual navigability is confirmed only on click.
8. **What if the click coincides with a text selection or drag?** — Ignored if the mouse moved between press and release (i.e. it was a drag/selection), so selecting text never accidentally triggers a jump.
9. **What happens to an in-flight request if the user navigates again, or the file changes, before it resolves?** — Discarded if superseded by further navigation; also discarded (not auto-retried) if the file's content changed between request and response — the next hover/click simply re-resolves against current content.
10. **What if the language server is still starting/indexing when the user clicks?** — Held for up to ~5 seconds; applied if the server becomes ready in that window and the user hasn't navigated elsewhere meanwhile; otherwise the click point shows "still starting — click again."
11. **Is there a visible cue while a lookup is in flight, and does that include hover?** — Yes for all surfaces including hover: a brief pending indicator appears if a request takes longer than ~300ms, so a slow language server never looks like a dead click or a tooltip that simply never appears.
12. **What happens with two browser tabs/clients open on the same worktree?** — The daemon, not the browser client, owns each language server's document open/close bookkeeping and disk-change sync — independent of how many clients are currently viewing a file. Peek state, back/forward history, and preview/permanent tabs stay per-browser-client, same as today.
13. **How do out-of-workspace definitions (stdlib, dependencies) get served?** — Read-only, via a daemon endpoint scoped to paths the language server itself returned for that worktree's active session — never an arbitrary client-supplied absolute path. Not persisted across reload, not promotable to a permanent tab; hover/go-to-def/outline still work inside them, and they do enter the back/forward stack for the current session only.
14. **What does sub-feature 1 (go-to-def) actually establish that sub-features 2–3 depend on?** — The per-worktree/direct-session language-server lifecycle, the shared status vocabulary (R9), and click/hover-to-LSP-position resolution. Sub-features 2 and 3 reuse that connection rather than re-establishing it — neither can ship ahead of sub-feature 1.
15. **Does a language server's resource cost interfere with an agent's own build in the same worktree?** — Flagged for the technical plan, not spec'd here: servers idle-shut-down after a period of no requests (surfaced via R9's stopped/idle status), and isolating server-triggered builds/checks from an agent's own build process is a technical-plan concern.

---

## Screen layouts

### File preview — Files-tab left-pane modes

```
┌───────────────────────────────────────────────────────────────────┐
│  FILES                                                              │  ← ToolPanel tab strip
├───────────────────┬───────────────────────────────────────────────┤
│ [Tree][Search]      │ ◀ ▶  main.rs                       [def ↦]   │  ← back/forward (R4),
│ [Outline][Refs]     │                                   LSP: ready │    definition-preview tab
│                    │  1  fn main() {                               │
│ ▸ fn main          │  2      let x = parse_args();                 │
│ ▸ fn parse_args     │  3      run(x)   ← Ctrl/Cmd-click "run"       │
│   ● current line   │  4  }                                          │
└───────────────────┴───────────────────────────────────────────────┘
```

Notes:
- `[Tree][Search][Outline][Refs]` are modes of the same left pane (R6, R7; Options § Outline/symbols panel placement) — only one is visible at a time
- Outline empty states: "No file open" / "No symbols in this file" / "Loading symbols…" / "Outline not available for .json" (R7, R9); Outline is unavailable while the preview shows a diff, rendered-markdown, or historical-commit view
- Ctrl/Cmd-click on `run` navigates to its definition, replacing whatever the `[def ↦]`/`[search]` slot currently shows (R1, R2 — resolved design question 1)
- Double-clicking the preview tab promotes it to a permanent tab; jumping to a file that's already a permanent tab (or the same file) just scrolls there, no duplicate preview (R3)
- `◀ ▶` back/forward retrace every preview navigation, not just go-to-def (R4)

### Multiple-match picker (R1)

```
┌───────────────────────────────────┐
│  Go to definition: "run"  (3)      │
├───────────────────────────────────┤
│  lib.rs:12    pub fn run(cfg) {…}  │  ← anchored at click point; ↑↓ + Enter,
│  lib.rs:40    fn run(cfg) → …      │    or click a row; Esc dismisses
│  bin/x.rs:5   fn run() {…}         │
└───────────────────────────────────┘
```

### Hover tooltip

```
┌───────────────────────────────────────────┐
│  fn run(cfg: Config) -> Result<(), Error>  │  ← signature
│  ─────────────────────────────────────────│
│  Runs the app with the given config.       │  ← doc summary; scrolling this
│  [Find references]                         │    text does not dismiss the tooltip
└───────────────────────────────────────────┘
```

Notes:
- Tooltip appears after the pointer rests ~500ms on a symbol; if the server still hasn't answered 300ms after that rest-triggered request fires, a pending cue replaces it until the answer arrives (R5, resolved question 11)
- Dismissed by Esc, click-away, or scrolling the code underneath — not by scrolling inside the tooltip itself (R5)
- "Find references" jumps straight into the references list (R6)

### References list

```
┌───────────────────────────────────────────┐
│  References: run  (3)          LSP: ready  │  ← status at point of use (R9)
├───────────────────────────────────────────┤
│  ▾ lib.rs                                   │
│     12   pub fn run(cfg: Config) { ... } def│  ← declaration marked "def"
│     40   run(default_config())              │
│  ▾ main.rs                                  │
│      3   run(x)                             │
│         [Show more]                          │  ← incremental load, not a hand-off
└───────────────────────────────────────────┘     to text search (which can't
                                                     match semantic references)
```

Notes:
- Grouped by file, collapsible; clicking a line previews it in the shared preview slot, list stays open (R6)
- Zero results: "No references found for `run`" in place of the list (R6, R9)

### Status states (R9) — shown at each surface's own point of use

```
Go-to-def click point:   "waiting for language server…" / "still starting — click again" / "No definition found for `run`"
Hover tooltip:            pending cue past 300ms, then signature/doc, or nothing shown once genuinely no result
References list header:   "LSP: indexing…" / "No references found for `run`"
Outline panel:             "Loading symbols…" / "Outline not available for .json"
Files-tab topbar (shared): "LSP: not available for Go — server not found on host" / "LSP: stopped — click to resume"
```

---

## Priority & sequencing

| Order | Sub-feature | Depends on | Can ship independently? |
|-------|-------------|------------|--------------------------|
| 1 | Go-to-definition + shared preview slot + back/forward + LSP foundation (R1–R4, R9 for this surface) | — | Yes — and establishes the LSP lifecycle/status/position-resolution plumbing sub-features 2–3 reuse |
| 2 | Hover + references (R5–R6, R9 for these surfaces) | Sub-feature 1's LSP foundation | No |
| 3 | Outline (R7, R9 for this surface) | Sub-feature 1's LSP foundation | No |

Each sub-feature ships its own status states as part of its definition of done (R9) — status is not a separate step bolted on afterward.

---

## Open questions

| # | Question | Proposed answer / owner |
|---|----------|--------------------------|
| 1 | **Per-worktree LSP process lifecycle — spawn on file open, or pre-warm on worktree open?** | Proposed: spawn on first file open per worktree/language (lazy), matching the starting/indexing status states; a "stopped — click to resume" server (idled per resolved question 15) restarts the same lazy way, on the next navigation/hover attempt against it — technical plan to confirm |
| 2 | **Multiple worktrees of the same project open at once — one LSP server per worktree, or shared where safe?** | Proposed: one per worktree (matches vibe-station's isolated-checkout model); technical plan to confirm process/resource cost is acceptable, per resolved design question 15 |
| 3 | **How does the language server learn about an agent's uncommitted edit before the user's next hover/jump?** | Proposed: daemon syncs from its own file-watcher, independent of which browser clients are currently subscribed (resolved design question 12); technical plan to confirm ordering against resolved design question 9's stale-response handling |
