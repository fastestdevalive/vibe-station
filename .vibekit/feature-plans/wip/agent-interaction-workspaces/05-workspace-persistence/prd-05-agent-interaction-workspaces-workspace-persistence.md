<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# PRD: Workspace Persistence (05, sub-feature of Agent Interaction State + Workspaces)

> Move SAVED workspace layouts (`WorkspaceDoc`) off client-only `localStorage` and into the daemon's `vibe-station.db`, synced live across every connected client over WS — so a saved workspace is a durable, shared record instead of a browser-local one.

**Status:** Draft
**Technical plan:** `.vibekit/feature-plans/wip/agent-interaction-workspaces/05-workspace-persistence/plan-05-agent-interaction-workspaces-workspace-persistence.md`
**Parent feature:** `.vibekit/feature-plans/wip/agent-interaction-workspaces/prd-agent-interaction-workspaces.md` (Workspaces canvas, §2-§5) — this sub-feature only changes *where a saved WorkspaceDoc lives*, not the canvas/tiling UX itself (04-workspaces, shipped) or the daemon interaction-state machine (03-interaction-states).

---

## Problem

- A saved workspace (`WorkspaceDoc` — name + tile layout) exists only in the browser profile that saved it (`localStorage`, zustand `persist`) — clearing browser data, switching browsers/machines, or opening vibe-station from a second device loses or fails to show it.
- Two browser tabs (or two devices) open on the same daemon today see **independent** copies of a saved workspace — renaming/retiling/deleting in one tab has no effect on the other until that tab happens to re-save over it, and normally never converges at all.
- Every other durable entity in the app (projects, worktrees, sessions) already lives in the daemon's `vibe-station.db` and syncs live over WS (`useServerStore`/`useServerSync`); `WorkspaceDoc` is the one exception, which is surprising and a real data-loss risk (a user who reinstalls a browser has genuinely lost work today).

## Goals

- A saved workspace is durable server-side truth: created once, visible identically from any browser/device pointed at the same daemon.
- Save / rename / delete / tile-layout-edit on one connected client appears live on every other connected client — no reload needed — matching the existing behavior for sessions/worktrees/projects.
- Existing users' `localStorage`-only workspaces are not lost on upgrade — they migrate to the daemon automatically.
- No change to the workspace canvas UX itself (tiling/free-form editing, tile chrome, state coloring) — this is a storage-layer move, not a feature redesign.

## Non-goals

- Any change to `WorktreeLayout.scratchCanvas` (the transient, unsaved, per-worktree canvas) — it stays exactly as-is, client-only `localStorage`, untouched by this work.
- Any change to the workspace canvas's tiling/free-form editing UX, tile chrome, or state-coloring behavior (04-workspaces, shipped) — this sub-feature only relocates *storage*.
- Multi-user permissions/ownership on a workspace — same single-local-user model as the rest of the app; "synced across clients" means every client pointed at one daemon, not multi-account sharing.
- Offline editing / conflict-free merge (CRDT-style) — see §4 Resolved design questions for the concurrency model chosen instead.
- A dedicated "Workspaces library" management page beyond what already exists (carried over as a non-goal from 04-workspaces).
- Real-time cursor/presence indicators ("who's editing this workspace right now") — out of scope; see Open questions for whether a simpler "someone else is editing" toast is worth a follow-on.

---

## 1. Server-side storage

| ID | Requirement |
|----|-------------|
| R1 | A saved workspace (name + its full tile layout, per Resolved Design Question 2) persists in the daemon's database, not the browser. |
| R2 | A workspace is a top-level record, not owned by or nested under any single project/worktree — it can reference tiles from multiple projects/worktrees at once. |
| R3 | Restarting the daemon, or connecting from a browser that has never loaded the app before, shows every previously saved workspace exactly as last saved. |
| R4 | Deleting a workspace removes it for every client; it does not delete or affect any underlying agent/terminal session referenced by its tiles. |

## 2. Live cross-client sync

| ID | Requirement |
|----|-------------|
| R5 | Creating a workspace on client A makes it appear in client B's workspace list within the same latency budget as a new worktree/session appearing today (WS push, no polling). |
| R6 | Renaming a workspace on client A updates its displayed name on client B live. |
| R7 | Editing a workspace's tile layout (add/remove/move/resize a tile, switch tiled↔free-form) on client A updates client B's view of that workspace live, if client B is currently viewing it. |
| R8 | Deleting a workspace on client A removes it from client B's list live, and if client B currently has that workspace open, client B is taken to a graceful "workspace no longer exists" state (matching existing deleted-entity handling elsewhere in the app), not a crash. |
| R9 | A client that was offline (tab backgrounded, laptop asleep, WS dropped) reconciles to current server truth on reconnect — same refetch-on-`ws:open` pattern already used for projects/worktrees/sessions. |

## 3. Concurrent-edit behavior

| ID | Requirement |
|----|-------------|
| R10 | Two clients editing the same workspace's tile layout at the same time do not corrupt the stored layout — the last write applied by the server wins, and both clients converge to that same state shortly after. |
| R11 | A client actively mid-edit (e.g. mid-drag-resize) does not visibly jump or stutter because of an incoming remote update — exact mechanism (defer vs. apply-through) is an open question, not yet decided. |

## 4. Client migration

| ID | Requirement |
|----|-------------|
| R12 | On first load after upgrading to this version, every workspace currently sitting only in that browser's `localStorage` is uploaded to the daemon automatically, with no user action required. |
| R13 | If the daemon is unreachable at that moment, the local copies are not deleted — migration retries on the next successful connection, and the user sees their local workspaces in the meantime (degraded, read/edit-locally-only) rather than an empty list. |
| R14 | A workspace that has already been migrated is never re-uploaded as a duplicate on a subsequent load (from the same browser, or a second browser migrating the same locally-originated doc after it's already server-known elsewhere). |

## 5. Scope boundary (regression guards)

| ID | Requirement |
|----|-------------|
| R15 | The transient per-worktree scratch canvas continues to behave identically to today — worktree-scoped, client-only, not visible to other clients, not part of this sync. |
| R16 | Everything about how a workspace canvas is edited today (tiling, free-form drag, add/remove tile, state-colored tile borders) is visually and behaviorally unchanged — only the persistence/sync layer underneath changes. |

---

## Options considered

### Where does a saved workspace live server-side?

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — New top-level `workspaces` table in `vibe-station.db`, independent of `projects`/`worktrees`/`sessions` | Matches the data model (a workspace already spans multiple projects/worktrees, per the existing `workspaceDocs` flat map); no FK-cascade surprises when a referenced project/worktree/session is deleted | Yet another top-level table to maintain | ✅ chosen |
| B — Nest workspace rows under whichever project "owns" the workspace (mirroring `mutateProject`'s per-project blob pattern) | Reuses an existing, proven read/write path | Forces a false single-owner model onto a cross-project entity — exactly the ownership model 04-workspaces' detachment phase already rejected for the client-side `contextKey` field | ❌ rejected |

### Conflict resolution for concurrent tile-layout edits

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — Last-write-wins (server accepts the newest full-layout write it receives, broadcasts it, no merge) | Simple, matches every other entity's mutation model in this app (sessions/worktrees/projects have no merge logic either); workspace editing is a low-frequency, mostly-single-editor-at-a-time action | A genuinely simultaneous edit from two clients can silently drop one side's change | ✅ chosen |
| B — Operation-based merge (each tile add/move/remove is its own op, server serializes and replays) | No silent drop of concurrent edits | Real complexity (op log, replay, conflict rules) for a scenario (two humans actively retiling the same saved workspace at the same instant) that's rare for a single-local-user tool | ❌ deferred — revisit only if last-write-wins proves painful in practice |

### Client migration trigger

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A — Automatic, silent upload on first successful daemon connection post-upgrade, no prompt | Zero friction, matches "it just works" bar of the rest of the app; workspaces are low-stakes (recreatable) so a silent background action is low-risk | User isn't asked before their local data leaves the browser (mitigated: it's the user's own daemon, not a third party) | ✅ chosen |
| B — Prompt the user ("Upload N local workspaces to the daemon?") before migrating | Explicit consent | Adds a modal for something that should just work, inconsistent with how every other piece of local UI state (sort orders, font scale) is already silently daemon-agnostic vs. not | ❌ rejected |

---

## Resolved design questions

1. **Is a `WorkspaceDoc` scoped to a project/worktree the way sessions are?** — **No, it's a top-level entity.** A saved workspace can tile sessions from multiple projects/worktrees at once (already true client-side today); forcing single-project ownership would contradict the existing cross-context tile picker.
2. **What counts as "the layout" that must round-trip through the DB?** — **Everything in `CanvasGeometry`:** `mode`, `tiles[]` (including cross-context `worktreeId` per tile), `tree` (tiled-mode split structure — axis/children/sizes), and `freeRects` (free-mode per-tile x/y/w/h). Tile membership alone is not sufficient — positioning must persist too.
3. **Does the transient scratch canvas move server-side too?** — **No, explicitly out of scope.** Only named/saved `WorkspaceDoc`s move; `WorktreeLayout.scratchCanvas` remains exactly as today.
4. **What happens to a client actively viewing/editing a workspace when it's deleted by another client?** — **Graceful "no longer exists" state**, same class of handling the app already needs for a worktree deleted while open elsewhere (04-workspaces flagged the equivalent question for its own detached-view route; this sub-feature answers it the same way, reusing whatever pattern that lands on).
5. **Conflict resolution for simultaneous edits** — **Last-write-wins**, matching every other entity in the app. See Options above.
6. **How does migration behave when the daemon is unreachable** — **Local copies are never deleted before a confirmed successful upload; retried on next connect.** A user is never worse off than today (client-only) during an outage.

---

## Priority & sequencing

| Order | Sub-part | Depends on | Can ship independently? |
|-------|----------|------------|--------------------------|
| 1 | Server-side storage + REST CRUD (R1-R4) | — | Yes (daemon-only change, no client behavior change yet) |
| 2 | WS broadcast + client sync wiring (R5-R11) | 1 | No — needs server storage to exist first |
| 3 | Client migration (R12-R14) | 1, 2 | No — migration uploads into the storage/sync layer built in 1-2 |

---

## Open questions

| # | Question | Proposed answer / owner |
|---|----------|--------------------------|
| 1 | **Exact mechanism for R11 (remote update lands mid-local-gesture)** — defer the incoming patch, or apply-and-let-the-drag-jump? | Proposed: buffer/defer any remote patch to a workspace the local client is actively drag/resizing, apply immediately after gesture end (mouseup/touchend) — avoids a visible jump under the user's cursor. This is the plan's proposed answer, not yet locked — confirm at plan-review time. |
| 2 | **Should a "someone else is editing this workspace" indicator exist?** | Proposed: not this round — last-write-wins is silent by design (Options above); revisit only if real usage shows it's confusing. |
| 3 | **Does workspace deletion need a confirmation dialog, given it's now a shared/durable action affecting other clients too?** | Not decided — today's client-only delete may already have no confirmation; if so, propose keeping that (deletion is cheap — layouts are recreatable, no underlying sessions are destroyed per R4). Confirm current behavior at plan time. |
| 4 | **Rate limits / debounce on tile-layout-edit writes (R7)** — every drag-resize frame, or on gesture end only? | Proposed: write on gesture end only (mirrors how `sortOrder` drag-reorder likely already debounces) — avoids flooding the WS/DB with per-frame writes. Confirm at plan time against actual `WorkspaceCanvas.tsx` drag-handler granularity. |
| 5 | **Migration identity (R12-R14): does a locally-originated workspace keep its client-generated id as the server's canonical id, or does the server mint a new one?** | Proposed: keep the client-generated id as the canonical server id — simplest, and lets a retried/duplicate upload attempt from the same browser be recognized by id rather than needing a separate dedup key. Does not resolve cross-browser dedup (two browsers independently "created" what a human considers the same workspace get two distinct server rows — acceptable, not attempted this round). Confirm at plan time. |
