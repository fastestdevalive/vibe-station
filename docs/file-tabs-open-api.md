# Files Tab — Multi-Tab Support & Agent File-Open API

> Requirements + ASCII UI mocks  
> Branch: `improvements-files-file`  
> Date: 2026-09-12

---

## Background

The current Files tab in the tools pane is single-file: `activeFilePath: string | null` in the
Zustand workspace store, a single chip in the tab strip, and a disabled "+" button labelled
"coming soon". Ctrl+P sets `activeFilePath` directly and closes. There is no way for an agent
running in a worktree to surface a file it just wrote in the UI.

This document covers three tightly related improvements:

1. **Multi-tab file viewer** — up to N open file tabs, tree focus follows the active tab, Ctrl+P
   selection replaces the active tab unless the file is already open somewhere.
2. **New-tab via Ctrl+P** — Ctrl+P opens a new tab only when the selected file is not already
   open in any existing tab.
3. **Daemon `file:open` event + REST API + CLI command** — agents broadcast a file-open event
   that every connected browser handles exactly like a Ctrl+P selection.

---

## Requirement 1 — Multi-tab file viewer

### User-facing behaviour

- The Files tab header shows a horizontal tab strip of open file chips (basename, with a
  close × on each).
- **Selecting a file from the tree** (click or arrow keys) replaces the active tab's file —
  does not open a new tab.
- **Switching tabs** re-focuses the tree to that tab's file (the node is expanded-to and
  highlighted).
- **Closing a tab** activates the previous tab (or the next one if the first tab was closed).
- **Zero open tabs** shows the existing "no file selected" empty state.
- Scroll position is preserved per (worktreeId, filePath) as today.
- The tabs strip is horizontally scrollable when there are many tabs.

### State changes (Zustand store)

State is **per-worktree**, keyed the same way as the existing `diffScopeByWorktree`,
`treeScopeByWorktree`, and `lastFileByWorktree` fields. The current `activeFilePath` is
effectively global (one value across all worktrees), which is a latent bug when multiple
worktrees are open side by side — this refactor fixes that too.

```
BEFORE
  activeFilePath: string | null          // global — shared across all worktrees (bug)

AFTER
  openFileTabsByWorktree: Record<string, string[]>   // ordered open paths, per worktree
  activeFileTabIdxByWorktree: Record<string, number> // active index (-1 when empty), per worktree
```

Derived helper (backwards-compat): `activeFilePath(worktreeId) = openFileTabsByWorktree[worktreeId]?.[activeFileTabIdxByWorktree[worktreeId]] ?? null`

New actions (all take `worktreeId` as first arg):
- `openFileTab(worktreeId, path)` — if path is already open, switch to it; else replace current
  tab (or append if no tabs open). Does NOT open a new tab.
- `openFileTabNew(worktreeId, path)` — if path is already open, switch to it; else append a new
  tab and activate it.
- `closeFileTab(worktreeId, idx)` — remove tab at idx, activate closest remaining tab.
- `setActiveFileTabIdx(worktreeId, idx)` — switch to an existing tab.

`setActiveFile(path)` call sites are updated to pass `worktreeId` explicitly (already available
at every call site via props or context).

---

## Requirement 2 — Ctrl+P opens a new tab only for new files

### User-facing behaviour

- Ctrl+P search list behaviour is unchanged.
- When the user selects a file from the Ctrl+P list:
  - **File already open in any tab** → switch to that tab (no new tab).
  - **File not open** → open a new tab (`openFileTabNew`) and activate it.

### Implementation delta

`QuickOpen.tsx` `selectFile` callback:

```ts
// today
setActiveFile(path);   // always replaces
setToolPanelTab("files");
onClose();

// new (worktreeId is the wt prop already available in QuickOpen)
const tabs = openFileTabsByWorktree[worktreeId] ?? [];
const existingIdx = tabs.indexOf(path);
if (existingIdx >= 0) {
  setActiveFileTabIdx(worktreeId, existingIdx);
} else {
  openFileTabNew(worktreeId, path);
}
setToolPanelTab("files");
onClose();
```

---

## Requirement 3 — Daemon file:open event + REST API + CLI command

### Purpose

An agent that creates a file (plan, report, generated code) should be able to surface it in
the UI without the user having to navigate to it manually. The event fan-out to all clients
ensures every open browser tab for that worktree reacts.

### REST API

```
POST /worktrees/:worktreeId/open-file
Body: { "path": "/absolute/or/relative/path/to/file.md" }
Response 200: { "ok": true }
Response 404: worktree not found
Response 422: path outside worktree root
```

The daemon handler:
1. Validates `path` is inside `worktree.path` (reject traversal).
2. Checks the file exists (optional warning if not — let the UI handle missing files gracefully).
3. Broadcasts a `file:open` WS event to every connection subscribed to that worktree.

### WebSocket event (server → client)

```json
{
  "type": "file:open",
  "worktreeId": "wt-abc123",
  "path": "/abs/path/to/file.md"
}
```

Fan-out scope: all WS connections that have sent a `tree:watch` for this `worktreeId` (reuse
the existing subscription set).

### Client handling

The WS client adds a listener for `file:open`. Handler in `useSubscription.ts` or the relevant
workspace hook:

```ts
case "file:open":
  if (msg.worktreeId === currentWorktreeId) {
    // identical to Ctrl+P selection logic
    const tabs = openFileTabsByWorktree[msg.worktreeId] ?? [];
    const existingIdx = tabs.indexOf(msg.path);
    if (existingIdx >= 0) {
      setActiveFileTabIdx(msg.worktreeId, existingIdx);
    } else {
      openFileTabNew(msg.worktreeId, msg.path);
    }
    setToolPanelTab("files");
  }
  break;
```

### CLI command

```
vst file open <worktree-id> <path>
```

- Calls `POST /worktrees/<worktree-id>/open-file` via the daemon REST API.
- Resolves relative paths relative to CWD before sending.
- Exits 0 on success, non-zero with an error message on failure.
- Agents can use `$VST_WORKTREE` + `$VST_DAEMON_URL` to target the current worktree.

Example agent use:
```bash
# After writing a plan file
vst file open $VST_WORKTREE ./plan-auth-flow.md
```

### Skill documentation (`skill/SKILL.md`)

Add a section under the existing CLI reference documenting `vst file open` so externally
spawned agents learn about it from the skill. The vibe-station L1 system prompt
(`daemon/src/assets/agent-system-prompt.md`) should also be updated to mention it.

---

## ASCII UI Mocks

### Single tab (today → new default; tree focus shown)

```
┌─ Tools ────────────────────────────────────────────────────────────────────┐
│  Files  Git  Search                                                         │
│ ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  [  plan-auth-flow.md  ×  ]  [+]                                           │
│                                                                             │
│  ┌─ Tree ──────────────────┐  ┌─ Preview ───────────────────────────────┐  │
│  │ ▶ daemon/               │  │ # Auth Flow Plan                        │  │
│  │ ▶ web-ui/               │  │                                         │  │
│  │ ▼ docs/                 │  │ ## Phase 1 — Data layer                 │  │
│  │   ├── AGENTS.md         │  │ …                                       │  │
│  │   ├── STATUS-INDICATORS │  │                                         │  │
│  │   └── ▶ plan-auth-flow  │◀─┤  (tree scrolled-to and highlighted)    │  │
│  │         .md  ●          │  │                                         │  │
│  └─────────────────────────┘  └─────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
  ● = active tab indicator in tree
```

### Multiple tabs open — tab 2 active

```
┌─ Tools ────────────────────────────────────────────────────────────────────┐
│  Files  Git  Search                                                         │
│ ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  [ plan-auth-flow.md × ]  [ Layout.tsx × ]  [ spawn.ts × ]  [+]           │
│       (inactive)               (active)         (inactive)                 │
│                                                                             │
│  ┌─ Tree ──────────────────┐  ┌─ Preview ───────────────────────────────┐  │
│  │ ▶ daemon/               │  │  // Layout.tsx                          │  │
│  │ ▼ web-ui/               │  │  export function Layout({ … }) {        │  │
│  │   ▼ src/                │  │    …                                    │  │
│  │     ▼ components/       │  │                                         │  │
│  │       ▼ layout/         │  │                                         │  │
│  │         └── Layout.tsx ●│  │                                         │  │
│  │ ▶ docs/                 │  │                                         │  │
│  └─────────────────────────┘  └─────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
  Clicking "plan-auth-flow.md" tab → tree jumps to docs/plan-auth-flow.md
  Clicking any tree node → replaces Layout.tsx in the active tab
```

### Ctrl+P — file already open

```
  ┌─ Quick Open ──────────────────────────────────────────────────────────┐
  │  🔍  layout                                                           │
  │  ─────────────────────────────────────────────────────────────────── │
  │  ★  Layout.tsx          web-ui/src/components/layout/   (already open)│
  │     LayoutPanel.tsx     web-ui/src/components/layout/                │
  │     LayoutUtils.ts      web-ui/src/lib/                              │
  └───────────────────────────────────────────────────────────────────────┘

  Selecting "Layout.tsx" → switches to its existing tab, no new tab opened.
  Selecting "LayoutPanel.tsx" → opens a NEW tab (file not yet open).
```

### Ctrl+P — new file (not yet open)

```
  ┌─ Quick Open ──────────────────────────────────────────────────────────┐
  │  🔍  spawn                                                            │
  │  ─────────────────────────────────────────────────────────────────── │
  │     spawn.ts            daemon/src/services/                         │
  │     spawnUtils.ts       daemon/src/services/                         │
  └───────────────────────────────────────────────────────────────────────┘

  Selecting "spawn.ts" → new tab added, becomes active:

  [ plan-auth-flow.md × ]  [ Layout.tsx × ]  [ spawn.ts × ]  [+]
                                                  (active)
```

### Agent-triggered file open (Req 3 flow)

```
  Agent writes plan-data-layer.md
      │
      ▼
  vst file open $VST_WORKTREE ./plan-data-layer.md
      │
      ▼  POST /worktrees/wt-abc/open-file { path: ".../plan-data-layer.md" }
      │
      ▼  Daemon broadcasts file:open WS event to all subscribed connections
      │
      ▼  Browser receives file:open
         → plan-data-layer.md not in any open tab
         → openFileTabNew(".../plan-data-layer.md")
         → setToolPanelTab("files")

  Result: new tab appears and file is shown — same as if the user had
  found and selected it via Ctrl+P.
```

---

## Key files to touch

| Area | File | Change |
|------|------|--------|
| Store | `web-ui/src/hooks/useStore.ts` | Replace `activeFilePath` with `openFileTabs` + `activeFileTabIdx`; new actions |
| Files panel | `web-ui/src/components/tools/FilesPanel.tsx` | Multi-tab strip; wire tree selection to `openFileTab` |
| File tree | `web-ui/src/components/layout/FileTreeSidebar.tsx` | Scroll-to + highlight when active tab changes |
| Quick Open | `web-ui/src/components/dialogs/QuickOpen.tsx` | `openFileTabNew` vs `setActiveFileTabIdx` |
| WS types | `web-ui/src/api/types.ts` + `daemon/src/ws/protocol.ts` | Add `file:open` S→C message |
| WS handler | `daemon/src/ws/handlers/` | New `fileOpen.ts` broadcast handler |
| Route | `daemon/src/routes/worktrees.ts` | `POST /worktrees/:id/open-file` |
| Client WS | `web-ui/src/api/client.ts` + subscription hook | Handle `file:open` event |
| CLI | `cli/src/commands/file.ts` (new) | `vst file open` subcommand |
| CLI index | `cli/src/index.ts` | Register `file` command |
| L1 prompt | `daemon/src/assets/agent-system-prompt.md` | Document `vst file open` |
| vst skill | `skill/SKILL.md` | Document `vst file open` |

---

## Out of scope (not in this feature)

- Persistent tab state across page reload (session storage only, or not at all for now).
- Drag-to-reorder tabs.
- Per-tab diff scope (all open tabs share the worktree diff scope for now).
- Project-scope multi-tab (same implementation, trivially extends once worktree tabs work).
