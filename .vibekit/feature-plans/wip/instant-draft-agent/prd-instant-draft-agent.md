---
title: Instant Draft Agent
status: final
plan: ~
---

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Instant Draft Agent

Replace all "New Agent" modal dialogs with a single flow: a draft row in the sidebar (navigation only) + a full-pane draft composer in the main content area.

---

## Entry points (3 UI triggers, 4 dialogs)

| Entry point | Dialog replaced | Where in the UI |
|-------------|-----------------|-----------------|
| Global "Create new agent" | `NewAgentDialog` | Top-nav button in sidebar |
| "Agent in worktree" (git projects only) | `NewAgentSessionDialog` | "+" on project row → menu |
| "Agent in project dir" | `NewAgentDirectDialog` | "+" on project row → menu |
| "+ New Tab" inside a worktree | `NewAgentTabDialog` | Tab strip inside a worktree pane |

The "+" on a project row opens `ProjectPlusMenu` with two items; both become DraftComposer with different presets.

---

## What is created eagerly vs. on Start

| Thing | When created |
|-------|-------------|
| Draft session record (Tier 1 entry points) | Immediately — `projectId`/`worktreeId` known at click time |
| Global-new draft, no project selected | Client-side localStorage only — top-level sibling row in sidebar; no server record |
| Global-new draft, existing project selected | Upgrades to Tier 1 on project selection — `POST /sessions` fires; row moves under the selected project |
| Global-new draft, project deselected or switched | Previous Tier 1 session deleted; row returns to top-level; back to localStorage |
| Worktree | On Start — start call creates worktree and promotes draft session to `isMain` |
| Agent process | On Start |
| Project (global new, new name typed) | On Start — same atomic flow as today's `NewAgentDialog` |

**Tier 1** = "Agent in worktree", "Agent in project dir", "+ New Tab", and global-new once an existing project is selected (all have a known `projectId`).
**Tier 2** = Global new with no project or a brand-new project name. No project stub is created eagerly: a stub renders in the sidebar like a real project with a live "+" button, which would let users nest draft agents inside an uninitialized project — every downstream call would fail or need special-casing.

---

## Problem

- All "New Agent" dialogs block the UI; nothing appears in the sidebar until the API responds
- Dialogs have no persistence — closing loses the half-written prompt
- Four separate dialogs duplicate UI with slightly different field sets

---

## Goals

- Pressing "New" instantly shows a draft row and opens the right pane to a composer — no modal
- Tier 1 drafts survive a page refresh (server-persisted); Tier 2 survives browser navigation (localStorage)
- All four entry points collapse into one composer, differentiated only by pre-populated fields

## Non-goals

- Collaborative / shared drafts visible to other users
- Draft recovery across projects or machines
- No keyboard shortcut for new draft (no `Cmd+N` or similar)
- No draft expiry / auto-delete

---

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | Any "New Agent" trigger immediately inserts a draft row in the sidebar and navigates the right pane to the Draft Composer — no modal opens. |
| R2 | Tier 1: `POST /sessions` with `state: "drafting"` fires immediately; row shown optimistically. Tier 2 (global new): localStorage-only until Start. |
| R3 | The draft row shows only: generated name (updates live from first prompt words), "Draft" chip, and [×] discard — no input fields in the sidebar. |
| R4 | The Draft Composer body shows config fields (pre-populated per entry point) with breathing room; prompt textarea + [▶ Start] are pinned to a bottom bar. |
| R5 | When the WebSocket is open, [▶ Start] with a non-empty prompt triggers the start call immediately; the draft row transitions to a normal session row. |
| R6 | All field components are reused from existing dialogs unchanged (SkillEditor, AttachmentPicker, Select, Input, Radio, project combobox, NewModeDialog); net-new code is the DraftComposer shell, sidebar draft row, and draft lifecycle wiring only. |

---

## Entry point presets

### Common fields (all four entry points)

| Field | Notes |
|-------|-------|
| Mode | Select; + New Mode button (all except tab) |
| Prompt | SkillEditor (rich text, skill slash-commands) |
| Attachments | AttachmentPicker |
| Channel | Radio: Terminal \| Rich Chat; Rich Chat disabled when CLI doesn't support JSON |
| Use tmux | Checkbox — Terminal channel only (NewAgentSessionDialog + NewAgentTabDialog) |

### Per-entry-point extra fields

| Entry point | Extra fields |
|-------------|--------------|
| Global "+ New Agent" | Project combobox + Browse; Directory (create only); Use worktree toggle; Branch (optional, worktree); Base branch (worktree) |
| "Agent in worktree" | Worktree radio (New \| Existing); if New: Branch + Base branch; if Existing: worktree select |
| "Agent in project dir" | None — projectId implicit |
| "+ New Tab" | None — worktreeId implicit |

---

## Screen layouts

### Current — modal blocks everything

```
┌─ Sidebar ───────────────┐    ┌─ Dialog (blocks) ──────────────┐
│  [my-project]            │    │  Task prompt                    │
│    ├ worktree-1  idle ●  │    │  ┌───────────────────────────┐  │
│    └ ● [+ New Agent]     │───▶│  │ type your task...         │  │
│                          │    │  └───────────────────────────┘  │
│                          │    │  Mode [claude ▾] Branch [auto ▾]│
│                          │    │  [Cancel]     [Create Agent]    │
└──────────────────────────┘    └─────────────────────────────────┘
  sidebar unchanged until API responds
```

### "Agent in worktree" — NewAgentSessionDialog replacement

```
┌─ Sidebar ──────────────────┐  ┌─ Right Pane: Draft Composer ──────────────────────────┐
│  [my-project]               │  │                                                        │
│    ├ worktree-1   idle ●    │  │   New agent                                            │
│    ├ worktree-2   done ●    │  │   ─────────────────────────────────────────────────   │
│    ├ [Draft] New agent… [×] │◀─┤   Worktree   ● New  ○ Existing [worktree-1 ▾]        │
│    └ ● [+ New Agent]        │  │   Branch     [auto-from-prompt      ] (optional)      │
│                             │  │   Base branch [main ▾]                                │
│  Direct sessions            │  │   Mode        [claude ▾] [+ Mode]                    │
│    ├ quick-fix    idle ●    │  │   Channel     ● Rich Chat  ○ Terminal                 │
└─────────────────────────────┘  │                                                        │
                                 │  ── bottom bar ─────────────────────────────────────  │
                                 │  📎  [  What should this agent do?      ] [▶ Start]  │
                                 └────────────────────────────────────────────────────────┘
```

### Global "+ New Agent" — NewAgentDialog replacement

**State A — no project selected yet** (localStorage only; row is a top-level sibling):

```
┌─ Sidebar ──────────────────┐  ┌─ Right Pane: Draft Composer ──────────────────────────┐
│  [my-project]               │  │   New agent                                            │
│  [another-project]          │  │   ─────────────────────────────────────────────────   │
│  [Draft] New agent…    [×]  │◀─┤   Project    [Search or type name…] [📁 Browse]       │
│  ^ sibling to projects      │  │              ↳ Directory [~/projects/    ] (create)   │
│  ● [+ New Agent]            │  │   Worktree   ☑ Use worktree                           │
└─────────────────────────────┘  │   Branch     [auto-from-prompt      ] (optional)      │
                                 │   Base branch [main ▾]                                │
                                 │   Mode        [claude ▾]                              │
                                 │   Channel     ● Rich Chat  ○ Terminal                 │
                                 │                                                        │
                                 │  ── bottom bar ─────────────────────────────────────  │
                                 │  📎  [  What should this agent do?      ] [▶ Start]  │
                                 └────────────────────────────────────────────────────────┘
  localStorage-only; nothing on server yet
```

**State B — existing project selected** (upgrades to Tier 1; row moves under the project):

```
┌─ Sidebar ──────────────────┐  ┌─ Right Pane: Draft Composer ──────────────────────────┐
│  [my-project]               │  │   New agent                                            │
│    ├ worktree-1   idle ●    │  │   ─────────────────────────────────────────────────   │
│    ├ [Draft] New agent… [×] │◀─┤   Project    [my-project ✓          ] [📁 Browse]     │
│  [another-project]          │  │              (existing project — no Directory field)  │
│  ● [+ New Agent]            │  │   Worktree   ☑ Use worktree                           │
└─────────────────────────────┘  │   Branch     [auto-from-prompt      ] (optional)      │
                                 │   Base branch [main ▾]                                │
                                 │   Mode        [claude ▾]                              │
                                 │   Channel     ● Rich Chat  ○ Terminal                 │
                                 │                                                        │
                                 │  ── bottom bar ─────────────────────────────────────  │
                                 │  📎  [  What should this agent do?      ] [▶ Start]  │
                                 └────────────────────────────────────────────────────────┘
  POST /sessions fired on project select; row moved under project; server-persisted
```

### "Agent in project dir" — NewAgentDirectDialog replacement

```
┌─ Sidebar ──────────────────┐  ┌─ Right Pane: Draft Composer ──────────────────────────┐
│  [my-project]               │  │   New direct agent — my-project                       │
│    ├ worktree-1   idle ●    │  │   ─────────────────────────────────────────────────   │
│  Direct sessions            │  │   Mode        [claude ▾] [+ Mode]                    │
│    ├ [Draft] New direct… [×]│◀─┤   Channel     ● Rich Chat  ○ Terminal                 │
│    ├ quick-fix    idle ●    │  │                                                        │
└─────────────────────────────┘  │  ── bottom bar ─────────────────────────────────────  │
                                 │  📎  [  What should this agent do?      ] [▶ Start]  │
                                 └────────────────────────────────────────────────────────┘
```

### "+ New Tab" — NewAgentTabDialog replacement

```
┌─ Tab strip ──────────────────────────────────────────────────────────────┐
│  [Agent]   [Terminal]   [Draft…] ×                                       │
├──────────────────────────────────────────────────────────────────────────┤
│   New agent tab — worktree-1                                             │
│   ────────────────────────────────────────────────────────────────────   │
│   Mode      [claude ▾]                                                   │
│   Channel   ● Rich Chat  ○ Terminal                                       │
│   [If Terminal]  ☑ Use tmux                                              │
│                                                                           │
│  ── bottom bar ──────────────────────────────────────────────────────    │
│  📎  [  What should this agent do?                        ] [▶ Start]   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Critical user journeys

| # | Journey | UI behavior | Daemon behavior |
|---|---------|-------------|-----------------|
| 1 | User clicks "Agent in worktree" on a project | Draft row appears under project immediately; right pane shows composer with worktree fields pre-filled | `POST /sessions` with `state: "drafting"`, `projectId` — returns session id |
| 2 | User types a prompt; sidebar name updates | Draft row label updates live (debounced, first words of prompt) | `PATCH /sessions/:id` debounced ≤ 300 ms with `draftPrompt` |
| 3 | User hits [▶ Start] with WS open | Bottom bar disabled, fields dimmed, spinner shown; row transitions to normal session row | `POST /sessions/:id/start` → creates worktree → promotes draft session to `isMain` → spawns agent |
| 4 | User hits [▶ Start] for direct or tab draft | Same optimistic disable/spinner | `POST /sessions/:id/start` → transitions `drafting → not_started` → spawns agent |
| 5 | User navigates away mid-draft | Right pane shows whatever was clicked; draft row collapses to `[Draft] name… [×]` badge | Draft session persists in `drafting` state |
| 6 | User clicks the collapsed draft badge row | Right pane re-opens the Draft Composer with saved state | No call — client reads `draftPrompt`/`draftConfig` from the existing session record |
| 7 | User discards draft via [×] | Row disappears immediately | If POST already landed: `DELETE /sessions/:id`. If POST in-flight: abort the request. If POST not yet sent (Tier 2): clear localStorage only |
| 8 | User presses "+" on a project that already has a `drafting` session | Client receives 409 on the new POST; navigates to the existing draft row instead of creating a second | `POST /sessions` returns 409 with the existing session id |
| 9 | User presses "+" on a project that has a worktree-draft, but selects "Agent in project dir" | Same 409 path — one draft per (projectId) regardless of type; user lands on the worktree-draft composer and can adjust fields | `POST /sessions` returns 409 |
| 10 | User presses global "+ New Agent" while a global draft already exists locally | Client finds the localStorage entry; navigates to it; no new row created | No server call (Tier 2 draft has no server record) |
| 10a | User selects an existing project in the global-new composer | Draft row moves from top-level into the selected project's subtree; POST fires to upgrade draft to Tier 1 | `POST /sessions` with `state: "drafting"`, `projectId`; 409 path if draft already exists for that project (navigate to it) |
| 10b | User clears or changes the project back to "new" after selecting one | Row returns to top-level; previous Tier 1 session deleted | `DELETE /sessions/:id` (the promoted draft) |
| 11 | User refreshes the page mid-draft (Tier 1) | Draft row re-appears (session record survives); right pane shows composer with saved prompt/config | Draft session still in `drafting` state in DB |
| 12 | User refreshes the page mid-draft (Tier 2 / global new) | Draft row is gone — localStorage is not read back on reload to avoid showing a stale project-less row | No server record to restore |
| 13 | Start call fails (network error or spawn error) | Error banner appears in composer body above bottom bar; fields re-enabled; [▶ Start] restored; sidebar row stays as draft | Session stays in `drafting` state (or `not_started` if worktree was created but spawn failed — same recovery as today) |
| 14 | Second browser tab opens while a draft exists | Other tab receives WS `session:created` with `state=drafting`; renders collapsed badge row only; right pane does not switch; clicking badge does nothing | `session:created` broadcast on draft POST |

---

## DB / API changes

| Change | Details |
|--------|---------|
| New `LifecycleState` value | Add `"drafting"` to `LifecycleState` in `daemon/src/types.ts` |
| Draft fields on `SessionRecord` | Add `draftPrompt?: string`, `draftConfig?: { entryPoint, modeId, channel, worktreeChoice?, existingWorktreeId?, branch?, baseBranch?, useTmux?, useWorktree?, projectId?, worktreeId? }` — set null on `not_started` transition |
| POST /sessions (draft) | Accept `{ state: "drafting", projectId, type, draftPrompt?, draftConfig? }`; enforce max-1 per `projectId`; return 409 with existing session id |
| PATCH /sessions/:id (draft update) | Allowed only while `state = "drafting"` |
| DELETE /sessions/:id (discard) | Allow in `drafting` state |
| POST /sessions/:id/start | Direct/tab: `drafting → not_started` → spawn. Worktree: create worktree → promote draft session to `isMain` → spawn. Global new: create project → worktree → promote → spawn |
| WS `session:created` | Broadcast on draft POST so other tabs render the badge row |
| Lifecycle poller | Skip `drafting` sessions — no tmux process; must not be marked `exited` |
| PR poller | Exclude `drafting` sessions |
| `docs/STATUS-INDICATORS.md` | Add `drafting` row (same commit as type change); `statusColor.ts` returns no-dot |
