<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# PRD: Diff View Shortcuts

> Keyboard shortcuts to jump to a file's git diff, toggle inline vs. side-by-side rendering, and expand/collapse individual diff hunks.

**Status:** Draft
**Technical plan:** `.vibekit/feature-plans/pending/diff-view-shortcuts/plan-diff-view-shortcuts.md` _(link once the plan exists)_

---

## Problem

- Reaching a file's diff today requires mouse navigation (select file, switch preview scope) — no keyboard path
- The diff preview only renders inline/unified; there is no side-by-side mode, unlike other editors users compare against
- Long diffs render every hunk in full with no way to collapse sections already reviewed

## Goals

- Jump to the active file's diff with one keystroke
- Switch between inline and side-by-side diff layout with one keystroke
- Expand/collapse an individual diff hunk with one keystroke

## Non-goals

- No new diff algorithm/engine — side-by-side reuses the existing parsed hunk data, just re-laid-out
- No "collapse all hunks at once" command — only one hunk toggles per keypress
- No keyboard hunk-to-hunk navigation (e.g. "next hunk") in this version
- No persistence of view preference across app restarts (in-memory for the session only, see Resolved design questions)

---

## Requirements

### 1. Navigation

| ID | Requirement |
|----|-------------|
| R1 | A shortcut opens the currently active/selected file in the diff preview, at its default (working-tree) diff scope. |

### 2. Diff layout

| ID | Requirement |
|----|-------------|
| R2 | A shortcut, or the preview header's Inline/Side-by-side button (new, next to the existing Source/Rendered toggle), switches the focused diff preview between inline and side-by-side layout. Always available — no minimum pane-width gate. |
| R3 | Both side-by-side columns always split the pane 50/50. Within a column, a line wraps once it needs more than ~100 characters of width; a column narrower than ~100 characters doesn't shrink the wrap point further — it scrolls horizontally instead. Applies to the plain (non-diff) file preview too; Markdown rendering is unchanged. |

### 3. Hunk collapse

| ID | Requirement |
|----|-------------|
| R4 | A shortcut expands or collapses one diff hunk: the one under mouse hover, or — with no hover — the topmost hunk currently visible in the preview's scroll viewport. |

---

## Options considered

### Shortcut key choices

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — Alt+D / Alt+Shift+D / Alt+H | Free of collisions with existing app shortcuts and the dev state simulator's Ctrl+Shift+D; matches the app's existing bare-Alt mnemonic pattern (Alt+N, Alt+Shift+N) | Alt+D is Firefox's address-bar-focus default (Windows/Linux); Alt+H opens Firefox's Help menu; both are also intercepted by the shell (readline kill-word / zsh run-help) when the terminal has focus | ✅ chosen |
| B — Ctrl+Shift+D for jump-to-diff | Shorter mnemonic ("diff") | Collides with the documented dev state simulator shortcut | ❌ rejected |

**Decision:** Option A. `preventDefault()` suppresses the Firefox defaults whenever the app (not the terminal) has focus, same precedent as Ctrl+P overriding the browser's own quick-open today. The terminal double-fire is an accepted, pre-existing tradeoff — Alt+N already double-fires into the shell the same way (see Resolved design question 3).

---

## Resolved design questions

1. **What happens if the "jump to diff" shortcut fires with no file selected, or for a direct/project-scoped session with no git repo at all?** — **No-op.** No error toast, no pane change — consistent with how other shortcuts behave with no valid target.
2. **What happens if the active file has no diff (untracked, unchanged, binary, image)?** — **Preview pane still opens and shows that file's existing fallback state** (untracked/binary/no-changes messaging already built into the preview pane). Images keep their existing image-viewer branch, which already takes precedence over the diff view — this shortcut doesn't change that precedence, it only changes how the file gets selected. No new empty state, no crash.
3. **Do the new shortcuts collide with existing keybindings or browser-reserved combos? What about terminal focus?** — **No app-level collisions** (checked against Ctrl+P/B/E/\//Shift+F/Shift+Z/Shift+G/Shift+M, Alt+N, Alt+Shift+N, and the dev-only Ctrl+Shift+D simulator shortcut). **Terminal focus:** matches the existing Alt+N/Alt+Shift+N precedent — bare-Alt shortcuts are deliberately let through even when the terminal has keyboard focus (`useWorkspaceKeyboardShortcuts.ts`'s `inEditable` check excludes xterm's helper textarea), so the shell may also interpret the same Alt combo (e.g. Alt+H as zsh's `run-help`). This is an accepted existing tradeoff, not a new one — not fixed here.
4. **What happens toggling to side-by-side on a very narrow pane / mobile viewport?** — **Superseded — no gate at all** (revised after live testing: an earlier ~800px, then ~560px, minimum-width gate was found to disable the toggle by default at nearly any normal pane size, since the tool panel's default split is only ~300-500px wide). The toggle is now always available. Both columns split the pane exactly 50/50 regardless of width; within a column, text wraps once it needs more than ~100 characters, and a column narrower than that doesn't shrink the wrap point further — it scrolls horizontally instead. On a very wide column, text is free to extend past 100 characters before wrapping (the 100-character point is a floor, not a cap). The same wrap-with-a-floor rule applies to the plain (non-diff) file preview; Markdown rendering is deliberately unchanged.
5. **Collapsing all hunks vs. a file with only one hunk?** — **No special case.** The shortcut always targets exactly one hunk (hover target, or topmost-visible per R4); a one-hunk file just collapses that one hunk like any other.
6. **Does toggle state persist when navigating between files, or across multiple open diff previews?** — **Split by toggle:** the inline/side-by-side layout choice persists for the browser session (not saved to disk) and applies to every diff subsequently opened, since it's a viewing preference rather than per-file state. Hunk-collapsed/expanded state always resets to fully-expanded per file — a stale collapsed hunk on a file the user hasn't reviewed yet would be misleading. Both shortcuts act only on the currently-focused diff preview pane; with no diff preview focused/visible (e.g. only canvas tiles with other content focused), both are a no-op.
7. **What do the layout and hunk shortcuts do while a `.md` diff is in Rendered mode (the existing Source/Rendered toggle)?** — **No-op in Rendered mode.** Rendered markdown has no hunk/line structure to lay out side-by-side or collapse; both shortcuts only act while the diff is showing Source. Switching to Rendered while side-by-side is active simply hides the layout distinction until switching back to Source (the session-persisted choice in Q6 is preserved underneath, not reset).

---

## Screen layouts

### Side-by-side diff mode (new)

```
┌────────────────────────────────────────────────────────────┐
│  filename.ts                    [ Inline | Side-by-side ]   │  ← existing toggle pattern (like Source/Rendered)
├──────────────────────────┬───────────────────────────────────┤
│  @@ -12,6 +12,8 @@  ▾     │  @@ -12,6 +12,8 @@  ▾              │  ← hunk header, collapse caret per side
│  old line                 │  new line                        │
│  old line                 │  new line                        │
├──────────────────────────┴───────────────────────────────────┤
│  @@ -40,3 +42,1 @@  ▸ (collapsed)                            │  ← collapsed hunk, one row
└────────────────────────────────────────────────────────────┘
```
- Left column: removed/old lines. Right column: added/new lines. Unchanged lines mirror on both sides.
- Collapse caret sits on the hunk header, same row on both sides when expanded; collapses to a single summary row spanning both columns.

---

## Priority & sequencing

| Step | Depends on |
|------|-----------|
| Side-by-side rendering mode in DiffView | none |
| Hunk collapse/expand UI + state | none (independent of layout mode) |
| Three keyboard shortcuts wired into existing shortcuts hook + help dialog | above two |

## Open questions

None — all edge cases resolved above.
