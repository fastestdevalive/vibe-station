# Mini-Design: Terminal-mode features — channel toggle + file upload

> Two terminal-mode affordances for agent sessions: (1) a terminal→JSON toggle (IMPLEMENTED), (2) terminal-mode file upload (DESIGN ONLY).

**Branch:** `json-mode-chat-with-file-upload`
**Status:** Feature #1 Done · Feature #2 Pending approval

**Reference files:**
- Terminal view: `web-ui/src/components/layout/TerminalPane.tsx`
- Agent pane wiring: `web-ui/src/components/layout/AgentPaneSlot.tsx`
- JSON→terminal mirror affordance: `web-ui/src/components/chat/StatusBar.tsx:101`
- Client method: `web-ui/src/api/client.ts:773` (`setSessionChannel`)
- Daemon channel route: `daemon/src/routes/sessions.ts:1276`
- Importer gate: `daemon/src/services/nativeHistoryImporter.ts:57`
- Upload staging: `daemon/src/routes/attachments.ts:112`
- Claude workspace hooks: `daemon/src/agent-plugins/claude.ts:278` (`setupWorkspaceHooks`)

---

## Problem

- Terminal view has no channel control — a JSON→terminal toggle exists (StatusBar) but there is no terminal→JSON path in the UI, despite the daemon supporting both directions.
- Terminal-mode agent sessions cannot attach files; JSON mode can (AttachmentPicker + `POST /sessions/:id/attachments`).

## Out of Scope

- Daemon changes for #1 — `PATCH /sessions/:id/channel` already handles tty→json.
- Feature #2 implementation — design only, pending user approval.
- cursor/agy channel toggle or upload (no native-history importer; deferred).

## Concept

- **#1:** A `⇄ JSON` control in the terminal view switches a tmux/pty agent session back to JSON chat behind a `ConfirmDialog`; terminal-phase turns are backfilled by the P2 importer.
- **#2:** Terminal-mode upload stages files server-side (reusing JSON staging) into a per-session pending list; a claude `UserPromptSubmit` hook injects the paths before the next turn, then clears the list.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | #1: terminal→JSON control shown only for worktree-backed **agent** sessions on tmux/pty whose CLI has an importer (claude/opencode) |
| 2 | #1: mirror StatusBar styling/behaviour; confirm via `ConfirmDialog`; call `api.setSessionChannel(id,"json")` |
| 3 | #1: web-ui only; no daemon change |
| 4 | #2: reuse existing upload/staging; claude-first via `UserPromptSubmit` hook; gate other CLIs |

---

## Research

### Terminal→JSON endpoint (exists)

- **File:** `daemon/src/routes/sessions.ts:1276` — `PATCH /sessions/:id/channel`.
- **Trigger:** `{ channel: "json" }` on a tmux/pty agent.
- Gates: agent-only (400), worktree-only (400, `:1294`), importer-only (400, `:1307`); idle gate applies **only** to json→tty (`:1316`) — tty→json has none.
- **Risk:** LOW — verified by P3; client just needs to avoid showing a button that 400s.

### Reading CLI/channel/type on the client

- **File:** `web-ui/src/api/types.ts:62` — `Session` carries `type`, `worktreeId`, `channel`, `modeId` but **not** `cli`.
- CLI resolved via `api.listModes()` → `mode.cli` (no central modes cache; dialogs fetch per-use, e.g. `NewAgentDialog.tsx:170`).
- **Risk:** LOW — one extra `listModes()` fetch per mounted terminal toggle.

### Upload staging (for #2)

- **File:** `daemon/src/routes/attachments.ts:132` — stages to `sessionDataDir(project,worktree,session)/uploads/<uploadId>/<name>`.
- **Risk:** MEDIUM — path lives under `~/.vibe-station`, outside the worktree; claude must be handed an absolute path.

### Claude workspace hooks (for #2)

- **File:** `daemon/src/agent-plugins/claude.ts:278` — writes `.claude/vibe-recorder.sh` + merges a `SessionStart` hook into `.claude/settings.json`.
- Injection extends this: add a `UserPromptSubmit` hook entry + script.
- **Risk:** MEDIUM — claude-only mechanism; opencode/others need a different path or stay gated.

## Root Cause

- #1: `AgentPaneSlot` renders `TerminalPane` for tmux/pty with no channel control; the toggle only ever lived on the JSON side.

---

## Architecture

```
AgentPaneSlot (channel !== json)
  → TerminalPane            (xterm stream)
  → TerminalChannelToggle   → api.listModes() → mode.cli gate
                            → ConfirmDialog
                            → api.setSessionChannel(id,"json")
                                 → PATCH /sessions/:id/channel
                                      → teardown TTY → JSON session → importer backfill
                                      → session:updated {channel:"json"} → ChatPane visible
```

---

## Design Details

### Critical User Journeys (CUJs)

#### CUJ 1 — terminal→JSON (happy path, #1)

```
User in a claude terminal agent
  → Clicks "⇄ JSON" (top-right overlay)
  → ConfirmDialog warns: ends live terminal, returns to JSON chat, turns backfilled
  → Confirms
  → api.setSessionChannel(id,"json")
  → daemon tears down TTY, reopens JSON, backfills terminal turns
  → session:updated flips channel → ChatPane becomes visible
```

- **Error path:** PATCH rejects (409/400) → dialog shows "Couldn't switch — try again in a moment."; terminal untouched.
- **Edge case:** cursor/agy agent, direct session, or plain terminal → button never renders.

#### CUJ 2 — terminal upload (design, #2)

```
User in a claude terminal agent
  → Picks a file (terminal upload UI)
  → POST /sessions/:id/attachments stages it → pending-uploads[session] += path
  → Types a prompt, submits
  → UserPromptSubmit hook injects pending paths as context → clears list
  → Removing a chip pre-submit unstages (deletes) the file; terminal buffer untouched
```

- **Error path:** non-claude CLI → upload UI hidden/disabled (no injection hook).
- **Edge case:** unsubmitted uploads on session close → cleanup policy (open question).

### API Contracts

- **#1:** `PATCH /sessions/:id/channel` — unchanged. Request `{ channel: "json" }`; response `{ ok, channel }`; errors 400 (non-agent / direct / no-importer), 404, 409 (busy, json→tty only), 500.
- **#2:** reuses `POST /sessions/:id/attachments` (201 `{ attachments }`) for staging; unstage = delete staged file (new endpoint TBD in impl phase).

### Key Decisions

#### Decision 1: Placement of the #1 control (CHOSEN + alternatives)

- **Decision:** absolutely-positioned overlay button, top-right of the terminal, rendered by `AgentPaneSlot` (not `TerminalPane`).
- **Rationale:** `AgentPaneSlot` is agent-only, so plain dock terminals never get it; an overlay avoids adding a toolbar strip that would resize the xterm and perturb the delicate fit/resize effect in `TerminalPane`.
- **Where:** `AgentPaneSlot.tsx` (render), `web-ui/src/styles/chat.css` (`.terminal-channel-toggle`).
- **Alternatives:**
  - *A — persistent top toolbar strip on `TerminalPane`:* clearer, but reduces terminal height and touches the resize-sensitive component (used by the terminal dock too).
  - *B — reuse the exit-only resume banner row:* only appears on exit; wrong lifecycle.

#### Decision 2: Client-side CLI gate for #1

- **Decision:** resolve `mode.cli` via `api.listModes()`; show only for `{claude, opencode}`; daemon 400 stays as backstop.
- **Rationale:** `Session` has no `cli`; mirrors the daemon importer set to avoid a button that fails.
- **Where:** `web-ui/src/components/layout/TerminalChannelToggle.tsx` (`CHANNEL_TOGGLE_CLIS`).

#### Decision 3 (#2): inject paths via a claude `UserPromptSubmit` hook, not the terminal buffer

- **Decision:** a per-session pending-uploads list; hook injects absolute staged paths pre-turn, then clears.
- **Rationale:** buffer-paste + later removal is fragile (can't reliably edit a live TTY buffer); staging + hook keeps the buffer untouched and removal = unstage.
- **Where:** extends `daemon/src/agent-plugins/claude.ts:278` (`setupWorkspaceHooks`); pending list keyed by sessionId (store TBD).

---

## Files to Modify

| File | Change |
|------|--------|
| `web-ui/src/components/layout/TerminalChannelToggle.tsx` | NEW — #1 toggle component (gate + confirm + PATCH) |
| `web-ui/src/components/layout/AgentPaneSlot.tsx` | Render toggle for tmux/pty agent sessions |
| `web-ui/src/styles/chat.css` | `.terminal-channel-toggle` + positioning context |
| `web-ui/src/components/layout/TerminalChannelToggle.test.tsx` | NEW — component tests |
| `web-ui/src/components/layout/AgentPaneSlot.test.tsx` | Stub the toggle (isolate remount suite) |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **#1 placement final?** | Chose top-right overlay; toolbar strip / banner are alternatives — easy to move |
| 2 | **#2: inject path or file contents?** | Path is cheaper; contents needed for images/binaries claude can't read by path |
| 3 | **#2: images?** | claude reads image files by path via Read tool — path likely fine; confirm |
| 4 | **#2: multi-file?** | List semantics; inject all pending paths in one block |
| 5 | **#2: cleanup of unsubmitted uploads?** | On session close / channel switch — delete staged dir? |
| 6 | **#2: terminal upload UI placement?** | Overlay near the toggle vs a small dock control |
| 7 | **#2: non-claude CLIs?** | Only claude has `UserPromptSubmit`; gate others until an equivalent ships |

---

## Implementation Phases

### Phase 1 — #1 terminal→JSON toggle (DONE)

- [x] **1.1** `TerminalChannelToggle.tsx` — gate (agent + worktree + tmux/pty + importer CLI), `ConfirmDialog`, `setSessionChannel(id,"json")`
- [x] **1.2** Wire into `AgentPaneSlot.tsx` for `channel !== json`
- [x] **1.3** `.terminal-channel-toggle` CSS (mirror `.chat-statusbar__channel`)

**Verify phase 1:**
- [x] **1.T1** Unit — `TerminalChannelToggle`: shows for a worktree tmux claude agent; click→confirm calls `setSessionChannel("sess-main","json")`
- [x] **1.T2** Unit — `TerminalChannelToggle`: hidden for cursor (no importer), plain terminal, direct session, json channel
- [x] **1.T3** Regression — `AgentPaneSlot`: terminal/chat remount invariant still holds (toggle stubbed)
- [x] **1.T4** Typecheck — `web-ui tsc --noEmit` + `cli pnpm typecheck` green; full `vitest run` 211 passing

### Phase 2 — #2 terminal file upload (NOT STARTED — pending approval)

- [ ] **2.1** Per-session pending-uploads store (daemon) keyed by sessionId
- [ ] **2.2** Reuse `POST /sessions/:id/attachments` for staging; add unstage (delete) endpoint
- [ ] **2.3** claude `UserPromptSubmit` hook extending `setupWorkspaceHooks` — inject paths, clear list
- [ ] **2.4** Terminal upload UI (gated to claude)

**Verify phase 2:**
- [ ] **2.T1** Integration — upload→hook: staged path appears in the next claude turn's context, then pending list clears
- [ ] **2.T2** Unit — gate: upload UI hidden for non-claude CLIs

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `web-ui/src/components/layout/TerminalChannelToggle.tsx` | 1.1 | NEW component |
| `web-ui/src/components/layout/AgentPaneSlot.tsx` | 1.2 | Render toggle |
| `web-ui/src/styles/chat.css` | 1.3 | Toggle styling |
| `web-ui/src/components/layout/TerminalChannelToggle.test.tsx` | 1.T1/1.T2 | NEW tests |
| `web-ui/src/components/layout/AgentPaneSlot.test.tsx` | 1.T3 | Stub toggle |
| `daemon/src/routes/attachments.ts` | 2.2 | Reuse staging + unstage (design) |
| `daemon/src/agent-plugins/claude.ts` | 2.3 | UserPromptSubmit hook (design) |
