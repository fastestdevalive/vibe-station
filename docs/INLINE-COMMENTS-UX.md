# Inline Comments → Agent Prompt — UX Spec

Status: **proposed, not yet implemented**. This resolves the open UX questions for
"comment on a line/selection in a file, rendered markdown, or diff view, then send the
comments as a tagged prompt to an agent (Rich Chat) or paste them into a terminal."

Grounding in the current codebase (so implementers don't have to re-derive this):

- There is **one** file-viewing surface, not three: `web-ui/src/components/layout/FilePreviewPane.tsx`,
  which picks a renderer by scope — `CodeView` (plain code), `MarkdownView` (rendered `.md`), `DiffView`/
  `DiffSideBySide` (diffs). All three already key rows by line number (`data-line`, `.diff-line`).
- There is **no open-files tab list** — one file is previewed at a time per worktree
  (`activeFilePath`/`peekFile`/`pendingLineTarget` in `useWorkspaceStore`, `useStore.ts:207-229`).
- `TabsStrip.tsx` only models **agent/terminal session tabs** (`TabKind = "agent" | "terminal"`), not files.
- Rich Chat's draft box (`Composer.tsx`) already has a "pending attachments before send" pattern
  (`useAttachmentDrafts`, `AttachmentChip.tsx`) — the comment feature should reuse that shape, not invent
  a new one.
- Terminal input is a raw PTY byte stream (`session:input` → `api.sendKeystroke`, `client.ts:1352`).
  There is no structured "paste"/"move cursor" message — anything we do there is just bytes on the wire.

---

## 1. What can be commented on

Any of the three `FilePreviewPane` renderers:

| Surface | Anchor unit | Anchor shape |
|---|---|---|
| `CodeView` (plain file) | line range | `{path, startLine, endLine}` |
| `MarkdownView` (rendered) | line range *of the source file*, not the rendered DOM | `{path, startLine, endLine, quotedText}` |
| `DiffView`/`DiffSideBySide` | line range on one side | `{path, side: "old"\|"new", startLine, endLine, base, head}` |

**Rendered markdown decision:** comments anchor to the *source* line range backing the rendered block
(every segment from `segmentMarkdownWithMermaid` already knows its source line span), not to DOM
position. A rendered paragraph that spans source lines 40–44 is one commentable unit; you can't
comment on half a rendered sentence. If the user selects text inside it, we snap the anchor to that
paragraph/block's full source range and store the selected substring as `quotedText` for display and
for fuzzy re-anchoring if the file changes later.

Both `CodeView` and `DiffView` already carry real line numbers, so for those the anchor is exact.

## 2. Making a comment

- **Hover a line** → a `+` affordance appears in the gutter (same place `highlightLine` already renders).
  Click = single-line comment. Shift-click a second line = extend to a range (GitHub PR convention).
- **Drag-select text** → a small floating "Add comment" button appears above the selection (Google
  Docs convention). Confirms the anchor is the range covering the selection, not just the clicked line.
- Either path opens an inline composer box docked to the **right margin**, at the vertical position of
  the anchor's first line.
  - **Decision: comments always render on the right**, never the left. One consistent side beats a
    configurable one for a v1, and the right margin is the established convention (GitHub, Google Docs,
    most PR tools) — don't make this a setting.
  - Narrow viewports: the card collapses to a small numbered badge in the gutter; tapping it opens the
    same card as a popover instead of a fixed-width margin column.
- **Editing**: tapping an existing card re-opens it as an editable textarea in place. Blur/Enter saves,
  Esc cancels, a trash icon deletes it.
- Comments are **draft state until sent** — nothing is written to the daemon. They live in a new slice
  of `useWorkspaceStore`, keyed by worktree, independent of which file is currently the active
  `FilePreviewPane` render (so switching files via `activeFilePath` doesn't lose comments on other
  files — see §3).

## 3. Multi-file selection: the Comment Tray

Since there's no open-files tab list to "select multiple files" from, comments don't live in the
viewer — they accumulate in a **Comment Tray**: a collapsible panel (bottom-right, like a cart) that
persists across file navigation within the current worktree.

- Opening a file/diff that already has draft comments re-hydrates its cards from the Tray at the
  stored anchors (best-effort: if line numbers no longer match, fall back to finding `quotedText`
  nearby and flag the card "anchor may have moved" rather than silently mis-anchoring).
- The Tray lists every draft comment grouped by file, each with a one-line code preview, and a
  checkbox to include/exclude it from the next send (default: all included).
- The Tray header has:
  - A **target picker**, defaulting to whichever agent/terminal tab in `TabsStrip` was last focused
    before the user opened the file/diff view. User can switch it to any other open tab for the
    current worktree.
  - A **Send** button, disabled when zero comments are checked.
- On send: checked comments are removed from the Tray (sent = done); unchecked ones remain as drafts.
  The sent record lives in the target conversation's own history (§4) — the Tray is not a durable log.

This also answers "can one comment cover multiple lines / can there be multiple comments per file":
yes to both — each selection is its own Tray entry, grouped under its file.

## 4. Prompt format sent to the agent

Each comment becomes one tagged block. The selected source (or diff hunk) is embedded **verbatim
inside the tag**, not just referenced by line number — the agent may not have that exact working-tree
state checked out (e.g. commenting on a diff against a commit that isn't HEAD), so the tag must be
self-sufficient.

Plain file / rendered markdown:

```
<file-comment path="rust/vst-daemon/src/server.rs" lines="42-58">
```rust
<verbatim selected source lines>
```
Comment: <user's comment text>
</file-comment>
```

Diff:

```
<diff-comment path="rust/vst-daemon/src/server.rs" side="new" lines="42-58" base="main" head="HEAD">
```diff
<verbatim selected diff lines, with +/- prefixes>
```
Comment: <user's comment text>
</diff-comment>
```

When more than one comment is sent in the same turn, they're concatenated with a one-line lead-in:

```
I'm leaving 3 inline comments across 2 files:

<file-comment ...>...</file-comment>

<diff-comment ...>...</diff-comment>

<file-comment ...>...</file-comment>
```

**Decision on existing draft text:** if the user had already typed something in the Rich Chat
composer before sending comments, the tagged blocks are inserted **first**, the user's freeform text
is appended **after** a blank line, unchanged. Comments are context; the typed text is almost always
the instruction/question about that context, so it reads naturally last. For terminal targets there is
no equivalent "draft text" to merge with (see §6).

## 5. Rich Chat history rendering

Per the existing attachment-draft pattern (`useAttachmentDrafts`/`AttachmentChip`), a sent message
carries a **UI-only sidecar** alongside the plain-text prompt: the structured list of
`{path, lines, side?, quotedText}` that produced it. `MessageList` renders that sidecar as a row of
small per-file preview cards above the message bubble — one card per file touched in that turn, each
showing the commented snippet with the comment overlaid — rather than re-parsing the `<file-comment>`/
`<diff-comment>` tags out of the raw text. This keeps rendering robust even if the agent's reply quotes
the tags back, and matches how attachments already render in history today.

## 6. Terminal delivery

A terminal has no structured insertion point — `session:input` is just bytes appended to whatever the
PTY currently has buffered at the cursor. Given that:

- **Decision: don't try to "move cursor to end" first.** Many foreground programs (vim, tmux status
  lines, any TUI) interpret arrow/End keystrokes as application commands, not line-editing — sending
  them blind risks doing something unrelated to the paste. There is no reliable way to detect "is this
  shell at an idle prompt" from the daemon side.
- Instead, send the same tagged block text as one **bracketed paste** (`ESC[200~ … ESC[201~`) via
  `sendKeystroke`, exactly where the cursor already is — identical to what happens if the user pasted
  it themselves with their terminal's native paste. This avoids per-character side effects (auto-indent,
  reverse-history-search-on-paste, etc.) that a raw keystroke stream would trigger.
- Before sending, show a one-line confirmation ("Paste N comments into `<tab name>` at the current
  cursor position?") rather than silently firing bytes into a session the user may not be looking at —
  this is the one target type where "did that even land somewhere sane" isn't visible until the user
  switches to that tab.
- No history rendering is attempted for terminal sends — a terminal has no structured message log to
  render into; the pasted text is just what appears in the scrollback like any other paste.

## 7. Data model summary (new state, no daemon changes required for v1)

```ts
type CommentAnchor =
  | { kind: "file"; path: string; startLine: number; endLine: number; quotedText: string }
  | { kind: "diff"; path: string; side: "old" | "new"; startLine: number; endLine: number;
      base: string; head: string; quotedText: string };

type DraftComment = { id: string; worktreeId: string; anchor: CommentAnchor; text: string };
```

Lives client-side only, scoped to the worktree, cleared per-comment on send. No persistence to the
daemon/SQLite is needed for v1 — comments that outlive a page reload are an explicit non-goal here.

## 8. Explicitly out of scope for v1

- Anchor re-mapping when a file changes significantly (we flag "may have moved" via `quotedText`
  fuzzy-match; we don't attempt a real diff-based re-anchor).
- Persisting draft comments across reloads/devices.
- Threaded replies on a comment card (a card is one comment, editable, not a mini-thread).
- Comments on anything other than `FilePreviewPane`'s three renderers (e.g. no commenting inside the
  Rich Chat transcript itself).
