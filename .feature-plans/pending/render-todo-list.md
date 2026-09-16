# Persistent TODO strip in Rich Chat (above the composer)

> **Status: implemented** (branch `ui-file-ellipsized`). `TodoStrip.tsx` +
> `extractTodos`/`parseTodoResult`/`isTodoToolName` in `toolFormat.ts`, wired
> into `ChatPane` above the composer. Shows whenever a todo snapshot exists;
> user-dismissable in `waiting_for_human` via a close button, reappearing on a
> fresh snapshot. (Data arrives in the tool_RESULT's `toolInput` as an
> object-array `{content,status,priority}` — see "Data & persistence".)

## Problem

`TodoWrite` (Claude Code) and `todoWrite` (opencode) are the agent's "here's my
plan" tool. Today we treat them as a generic tool call:

- In `ToolRunSummary.tsx:20` `todowrite` sits in `READ_ONLY_TOOL_NAMES`, so a
  run bucket counts it and the inline falls back to a single muted string
  (`summarizeToolInput` picks the first string field it knows: `description` /
  `prompt`, else the `todo` title). The structured **todo list** the agent
  actually maintains is never parsed or shown.
- The list arrives in `toolInput` as `{ todo, status, todos }` (opencode sends
  the **full current** `todos: string[]` on every update; Claude sends a `todo`
  title + `status` and lets `tool_result` text carry the list). Because it's not
  parsed, the user never sees the checklist — just "used TodoWrite 1 time".

## Goal

A **persistent TODO strip pinned above the composer** that shows the agent's
**current** plan for the session — a single live list, updated whenever a
todoWrite/TodoWrite tool call arrives, and removed when the agent yields back
to the human. The agent's plan should be visible at a glance while it works,
and not linger once control returns to the user.

```
┌── TODO ──────────────────────────────────────────────┐
│  ✓  Scaffold vite project          (done)            │
│  ▸  Implement splitPath helper      (active)  ◄ bright│
│  ○  Add checklist rendering         (pending)        │
│  ○  Write tests                    (pending)         │
│  [1/4 — click an item to jump to its tool row]       │
└──────────────────────────────────────────────────────┘
```

## Data & persistence

**Data:** `toolInput` is already preserved end-to-end (daemon
`normalize.ts:233` passes `raw.rawInput ?? raw.input` through unchanged) and
**persisted** to SQLite (`sqliteTranscriptStore.ts` persists each full
`NormalizedEvent`, including `toolInput`), so the latest snapshot is durable
and replays on load. No daemon change needed. Parse on the client from:

- `toolInput.todos` — full ordered list (`string[]`), opencode (sent on every
  update).
- `toolInput.todo` + `toolInput.status` — current/active item, both CLIs.
- A `todos` array embedded in `toolResult.content` text (JSON or markdown
  checkbox list) as a fallback for adapters that only return text.

**Persistence model — "last snapshot wins":** there is no live, continuously
synced todo object; the protocol only gives point-in-time snapshots. The strip
therefore renders the **most recent** todoWrite snapshot in the transcript for
that session, and updates in place as new `todoWrite` events arrive. opencode
re-sends the full list each time, so the newest snapshot is always the current
truth.

## Lifecycle / dismissal — the key decision

We **do not** rely on detecting "all todos completed" to hide the strip: there
is **no completion event** for todos, and an agent may finish or stop without
writing an all-complete list (turn abort, error, user stop, agent just stops).
That signal is unreliable.

The strip **shows whenever a todo snapshot exists**, in any lifecycle state —
so a finished plan stays visible for review. Dismissal is user-driven:

- When the agent yields back to the human (**`waiting_for_human`**), a close
  (×) button appears on the strip. Clicking it hides the strip.
- The dismissal is keyed to that specific snapshot: it stays hidden until a
  **new** todoWrite snapshot arrives (the next resumed turn), at which point
  the strip reappears with the updated plan.
- There is no auto-hide — the agent's plan is never silently dropped; the user
  controls when to dismiss it.

The lifecycle state is resolved as `sessionStates[id] ?? session.state` (per
AGENTS.md), never `.lifecycleState`.

## Changes

### 1. `web-ui/src/components/chat/toolFormat.ts`

Add `extractTodos(toolName, toolInput, toolResultContent?)` returning
`TodoItem[] | undefined` (`TodoItem = { text, state: "done"|"active"|"pending" }`):

- `toolInput.todos` as an **object-array** (`{ content, status, priority }` —
  opencode's real shape) → per-item `status` maps to state (`completed`→done,
  `in_progress`→active, `pending`→pending).
- `toolInput.todos` as a `string[]` → position relative to the active `todo`.
- `toolInput.todo` + `status` alone → single active/done item (Claude).
- Else parse a markdown checkbox list / JSON from the result text
  (`parseTodoResult`).

Also `isTodoToolName(name)`.

### 2. New `web-ui/src/components/chat/TodoStrip.tsx`

Props `events: NormalizedEvent[]` + `liveState?: string`. It finds the **last**
todo snapshot and renders the checklist (done/active/pending styling, `n/m`
progress). Because opencode delivers the list in the `tool_result`'s refined
`toolInput` (the `tool_use` carries `{}`), it tracks todo tool ids from their
`tool_use` events and reads the matching `tool_result`, newest-first. In
`waiting_for_human` it renders a close button that dismisses the strip until a
new snapshot arrives.

### 3. `web-ui/src/components/layout/ChatPane.tsx`

Place `<TodoStrip events={events} liveState={liveState}/>` immediately **above
the composer** (inside a `chat-pane__composer` wrapper), below the transcript.

### 4. `web-ui/src/components/chat/TodoStrip.test.tsx`

- Parses the object-array shape; string-array shape; single-todo; result-text
  fallback.
- Strip shown in any state once a snapshot exists; close button only in
  `waiting_for_human`.
- Dismissing hides until a NEW snapshot arrives; last snapshot wins.

## Out of scope

- No daemon/persistence changes — `toolInput` already round-trips and persists.
- No per-tool-row checklist in `ToolRunSummary.tsx` — the persistent strip
  replaces that idea.
- No interactive toggling of items — display-only.
- No cross-session board — one strip per session.

## Acceptance

In the dev sandbox (`http://localhost:7148`), start a Rich Chat turn that
maintains a todo list. The strip appears above the composer showing the live
plan (active item bright, done items struck-through, `n/m` progress) while the
agent works, and stays visible when it reaches `waiting_for_human`. A close
button in that state dismisses the strip; replying resumes the agent and the
strip reappears with the updated plan.
