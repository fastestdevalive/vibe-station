<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: present-tickmark-replacement

> Two independent small fixes: (1) Add-tile picker shows a tickmark on already-placed
> tiles instead of hiding them, click toggles add/remove; (2) `/vst reset --handoff`
> gets a verified-kill hardening so a swallowed tmux failure can never leave the old
> agent alive after the new one is spawned.

**Branch:** `present-tickmark-replacement`
**Status:** WIP
**No PRD** — both fixes are self-contained, single-file-cluster, low-ambiguity.

**Reference files:**
- Picker: `web-ui/src/components/layout/WorkspaceCanvas.tsx`, `web-ui/src/styles/workspace-canvas.css`
- Reset termination: `daemon/src/services/sessionRuntime.ts`, `daemon/src/services/tmux.ts`

---

## Problem

- **Picker:** `WorkspaceCanvas.tsx`'s "Add tile" picker filters out any
  session/tools pane already present as a tile on the canvas.
- **Picker:** a user can't see what's already open in the picker, and can't remove
  a tile from the picker itself.
- **Reset:** `POST /sessions/:id/reset` kills the old runtime
  (`releaseSessionRuntime`, `daemon/src/services/sessionRuntime.ts:56-61`) via
  `killSession(session.tmuxName)` before archiving + spawning the replacement.
- **Reset:** `killSession` (`tmux.ts:27-33`) swallows every error, including a
  kill that failed for a reason other than "session already gone" — nothing
  verifies the pane is actually dead before the route archives the old row.

## Out of Scope

- Any change to the already-verified archive/spawn/slot-inheritance logic in
  `daemon/src/routes/sessions.ts`'s `POST /sessions/:id/reset` handler.
- Any change to the `/vst` in-chat command wording in `daemon/src/agent-plugins/*.ts`.
- Cross-project "done worktree" filtering in the picker — already shipped
  (`.vibekit/feature-plans/wip/add-tile-picker-filters/`), unrelated to this fix.
- Detached/orphaned child processes outside the tracked tmux pane's process group —
  no reproducible case found; `spawn.ts`'s `onSpawn` already requires every plugin
  to launch its own process group (Decision 13).
- `directPtyRegistry`/`jsonAgentRegistry` kill-verification — see Risk #2: reasoned
  to be a materially different (lower-risk) failure mode than the tmux path, not
  bundled into this fix.

## Concept

- **Picker:** every item the picker can offer is always shown; a `Check` icon
  replaces the trailing kind-tag when the item is already on the canvas. Clicking a
  ticked item removes that tile from the canvas (same as its own close button);
  clicking an unticked item adds it, exactly like today.
- **Reset:** after `killSession`, verify the pane is actually gone
  (`hasSession`); if not, retry once and log loudly on continued failure — the
  archive+spawn still proceeds either way (never blocks a reset on a kill), but the
  failure is no longer silent.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Add-tile picker never excludes an already-placed session/tools pane from its list |
| 2 | Each picker item shows a checkmark when its tile is already on the canvas |
| 3 | Clicking a checked item removes that tile from the canvas; clicking an unchecked item adds it |
| 4 | Toggle applies to own-worktree agents/terminals/tools AND cross-project sessions/tools (saved workspaces) |
| 5 | `releaseSessionRuntime`'s tmux kill is verified (not fire-and-forget) before the caller archives the old session row |
| 6 | A kill that still leaves the pane alive after one retry is logged, never silently dropped |

---

## Research

### Picker filtering

- **File:** `web-ui/src/components/layout/WorkspaceCanvas.tsx:396-503`
- `placedSessionIds` (396-398) / `placedToolWorktrees` (399-401): already-computed
  sets of "on canvas right now" — reused as-is for the tickmark, no longer used to
  *exclude*.
- `availableAgents` (409-411) / `availableTerminals` (412-414): filter
  `!placedSessionIds.has(s.id) && matchesSearch(...)` — drop the placed clause.
- `canAddTools` (402): `hasTools && !placedToolWorktrees.has(worktreeId)` — becomes
  two separate values: `showTools = hasTools` (render gate, used at line 500's
  `pickerEmpty` calc and line 1177's render condition) and `toolsPlaced =
  placedToolWorktrees.has(worktreeId)` (tickmark state, used at the render site).
- `otherContextGroups` (457-493): worktree-nested `sessions` filter (474) drops
  `!placedSessionIds.has(s.id)`; `directSessions` filter (489) drops the same
  clause; `canAddTools: !placedToolWorktrees.has(w.id) && wtNameMatches` (477)
  becomes `showTools: wtNameMatches` + `toolsPlaced: placedToolWorktrees.has(w.id)`
  as two fields on the mapped entry.
- **Every reference to the renamed field must be updated, not just its
  definition** — `canAddTools`/`entry.canAddTools` is read again at line 480
  (`entry.sessions.length > 0 || entry.canAddTools`) and destructured again at line
  1214 (`{ worktree, sessions, canAddTools: wtTools }`); both must become
  `showTools`. `pickerEmpty` at line 502 reads top-level `canAddTools` too — rename
  to `showTools` there as well. Grep `canAddTools` after the edit — it must return
  zero hits.
- `pickerEmpty`'s semantics genuinely shift, not just its variable name: today
  `showTools`'s predecessor (`canAddTools`) was `false` whenever Tools was already
  placed, so `pickerEmpty` (detached view only) could read as "nothing left to
  add" even when Tools was on the canvas. With `showTools = hasTools`
  (placement-independent), `pickerEmpty` now means "this worktree truly has
  nothing offerable" — update the empty-state copy at the `pickerEmpty` render site
  (~1132) from `"Everything's already on the canvas"` to `"Nothing to add"`, since
  the message must also cover the case where an active search matched nothing (a
  pre-existing ambiguity, not introduced here, but now the dominant case since
  placement no longer empties the list).
- Group-emptiness filters at 480 (post-rename: `entry.sessions.length > 0 ||
  entry.showTools`) and 493 (`group.worktrees.length > 0 ||
  group.directSessions.length > 0`) need no *behavioral* change beyond the rename
  — `sessions`/`showTools` stay non-empty for an all-placed entry, so the entry
  keeps rendering (now fully ticked) instead of vanishing.
- Click handlers (6 sites): `addTile("agent", s.id)` (1154), `addTile("terminal",
  s.id)` (1168), `addTile("tools")` (1181), `addTile(s.type as TileKind, s.id,
  worktree.id)` (1227), `addTile("tools", undefined, worktree.id)` (1244),
  `addTile(s.type as TileKind, s.id)` (1266) — all six become
  `togglePickerItem(...)` calls with the same arguments.
- `removeTile(tileId: string)` (560-567): already exists, already does exactly
  "remove this tile from the canvas geometry, no session/data deletion" — reuse
  as-is, no new removal logic needed.
- Per-row "is this placed?" check — each of the 6 render sites already has the data
  needed without any new lookup: own agents/terminals/cross-session/cross-direct
  rows use `placedSessionIds.has(s.id)` directly; own-Tools row uses `toolsPlaced`;
  cross-Tools row uses the mapped entry's `toolsPlaced` field. No new helper
  function needed for this check (only `togglePickerItem`, for the click, per
  Decision 1).
- `Check` icon: already imported (`WorkspaceCanvas.tsx:5`), already used once
  (1079, unrelated "confirm save workspace" button) — reuse the same import.

### Reset termination

- **File:** `daemon/src/routes/sessions.ts:1274-1460` — `POST /sessions/:id/reset`.
  Order verified against current source: validate → resolve handoff text →
  `releaseSessionRuntime` (1341) → `forceCloseSessionStreams` (1342) →
  build+archive+append new row in one `mutateProject` (1406-1427) →
  `spawnNewSessionForChannel` (1450) → reply (1459). `isMain`/`sortOrder` inherited
  onto the new row (1372-1373); old row's `isMain` explicitly cleared (1415, "Bug 3
  fix" comment). No change in this plan.
- **File:** `daemon/src/services/sessionRuntime.ts:35-64` — `releaseSessionRuntime`.
  Tmux branch (55-60):
  ```ts
  try {
    await killSession(session.tmuxName);
  } catch {
    // Pane already gone — nothing to reclaim.
  }
  ```
  This try/catch is dead code today — `killSession` (`tmux.ts:27-33`) already
  swallows every error internally, so nothing ever throws here.
- **File:** `daemon/src/services/tmux.ts:27-33` — `killSession` catches ALL errors,
  including ones that are not "session doesn't exist." No caller anywhere checks
  whether the kill actually worked.
- **File:** `daemon/src/services/tmux.ts:17-24` — `hasSession(name)` already exists:
  `tmux has-session -t <name>`, resolves `true`/`false`, never throws — exactly the
  verification primitive needed.
- **File:** `daemon/src/__tests__/sessionRuntime.test.ts` — existing coverage mocks
  `killSession` only; needs a `hasSession` mock added, plus new cases per Phase 2's
  verify block.
- **CLI/plugin layer already correct** (verified, no changes): self-target guard
  (`cli/src/commands/session/reset.ts:33-41`) rejects `--handoff` against one's own
  session before any daemon call; all three plugins' `/vst` command docs
  (`daemon/src/agent-plugins/claude.ts:302-357`, `opencode.ts:415-433`,
  `cursor.ts:414-432`) correctly route `reset --handoff` through the self-write +
  `--handoff-file` path, never the blocking `--handoff` path.
- **json-channel / direct-pty path — deliberately not touched, see Risk #2.**
  `releaseSessionRuntime:51-61` only reaches the tmux branch when
  `session.useTmux`. For `useTmux: false`, termination is either
  `directPtyRegistry.get(id)?.kill?.()` (line 54, node-pty's own `.pty.kill()` —
  `directPty.ts:233-240`, a direct OS syscall, not a separate CLI/socket
  round-trip like `tmux kill-session`) or, for a json-channel session mid-turn,
  `agent.release()` (line 47) against whatever `jsonAgentRegistry.get(session.id)`
  returned at line 41 — a registry miss there is the documented no-live-turn case
  (json sessions "spawn per turn and hold no long-lived pty" per the function's own
  doc comment, lines 8-33), not a missed-termination case.

## Root Cause

- **Picker:** the picker's item lists were built as "addable" lists (filter out
  what can't be added).
- **Picker:** never built as "everything, annotated with state" lists — a modeling
  choice, not a bug, but the wrong one for "let me see and manage what's open."
- **Reset:** `killSession`'s blanket error-swallow (added so a "session already
  gone" kill never surfaces as a route-level 500) has no companion verification
  step.
- **Reset:** that same swallow also silently absorbs the one failure mode that
  actually matters — a kill that failed for a real reason.

---

## Design Details

### Critical User Journeys (CUJs)

#### CUJ 1 — Toggle a picker item off, then back on

```
User opens the Add-tile picker on a canvas with an agent tile already placed
  → That agent's picker row renders with a checkmark instead of being absent
  → User clicks the checked row
  → System calls removeTile(tile.id) — the tile disappears from the canvas
  → Picker closes (setPickerOpen(false))
  → User reopens the picker
  → The same row now renders unchecked
  → User clicks it
  → System calls addTile(...) — the tile reappears on the canvas, picker closes
```

- **Edge case:** a Tools row is worktree-scoped, not session-scoped — toggling it
  off must remove the tile whose `kind === "tools"` for that worktree id, not any
  session-backed tile.

#### CUJ 2 — tmux kill fails silently today, is now surfaced

```
Agent runs `/vst reset --handoff` in-chat
  → Daemon calls releaseSessionRuntime → killSession(tmuxName)
  → tmux kill-session fails for a non-"already gone" reason (swallowed internally)
  → hasSession(tmuxName) still resolves true
  → Daemon retries killSession(tmuxName) once
  → hasSession(tmuxName) still resolves true
  → console.warn logs the session id + tmux name
  → Route proceeds to archive the old row and spawn the replacement regardless
    (never blocks the reset on a stuck kill)
```

### Key Decisions

#### Decision 1: Toggle, don't add a second "remove" control — *with a snippet*

- **Decision:** one click handler per picker item, branching on whether a matching
  tile already exists on the canvas, rather than a separate remove button/icon.
- **Rationale:** matches the ask exactly ("clicking over them again would remove
  the tickmark") and reuses the existing `removeTile`/`addTile` primitives
  untouched — no new canvas-geometry mutation code.
- **Where:** `web-ui/src/components/layout/WorkspaceCanvas.tsx` — new
  `togglePickerItem` function, placed next to `addTile`/`removeTile` (~line 567).

```tsx
// Single toggle for every picker item — session-backed (agent/terminal) or
// worktree-scoped (tools). Mirrors the tile-close button's semantics: this only
// touches canvas geometry, never the underlying session/data.
// `t.sessionId != null` guards a "tools" call site (sessionId undefined) from
// ever matching a tools tile, whose own `sessionId` field is also undefined.
function togglePickerItem(kind: TileKind, sessionId?: string, tileWorktreeId?: string) {
  const existing =
    kind === "tools"
      ? cv.tiles.find((t) => t.kind === "tools" && (t.worktreeId ?? worktreeId) === (tileWorktreeId ?? worktreeId))
      : cv.tiles.find((t) => t.sessionId != null && t.sessionId === sessionId);
  if (existing) {
    removeTile(existing.id);
    setPickerOpen(false);
  } else {
    addTile(kind, sessionId, tileWorktreeId);
  }
}
```

#### Decision 2: Verify-then-retry-then-log, never block the reset — *with a snippet*

- **Decision:** `releaseSessionRuntime`'s tmux branch calls `killSession`, then
  `hasSession` to verify; on a still-alive pane, retries the kill once and logs a
  `console.warn` if it's still alive after the retry. Return type and caller
  control flow are unchanged — never throws, never delays a reset past one extra
  `has-session` + one retried `kill-session` round-trip.
- **Rationale:** the reset route must never get stuck because a pane won't die; the
  fix is making the survivor *visible* (server log), not retrying forever or
  failing the request.
- **Where:** `daemon/src/services/sessionRuntime.ts:55-61`.

```ts
} else {
  await killSession(session.tmuxName);
  if (await hasSession(session.tmuxName)) {
    // First kill-session didn't take — try exactly once more before giving up
    // loudly. Never throws, never blocks the caller past this one retry.
    await killSession(session.tmuxName);
    if (await hasSession(session.tmuxName)) {
      console.warn(
        `[sessionRuntime] tmux session '${session.tmuxName}' (session ${session.id}) ` +
          `survived two kill-session attempts — it may still be running.`,
      );
    }
  }
}
```

- `killSession` keeps its internal try/catch (`tmux.ts:27-33`) — it still never
  throws, so no new try/catch is needed at this call site.

---

## Implementation Phases

---

### Phase 1 — Picker tickmark toggle

- [x] **1.1** `WorkspaceCanvas.tsx:409-414` — drop `!placedSessionIds.has(s.id)` from
      `availableAgents`/`availableTerminals` filters (keep `matchesSearch`).
- [x] **1.2** `WorkspaceCanvas.tsx:402` — split `canAddTools` into `const showTools =
      hasTools` and `const toolsPlaced = placedToolWorktrees.has(worktreeId)`;
      update the `pickerEmpty` calc (~502) to read `!showTools` instead of
      `!canAddTools`; update the empty-state copy (~1132) from `"Everything's
      already on the canvas"` to `"Nothing to add"`.
- [x] **1.3** `WorkspaceCanvas.tsx:470-480` — drop `!placedSessionIds.has(s.id)` from
      the worktree-nested `sessions` filter (474); rename the mapped entry's
      `canAddTools` field to `showTools: wtNameMatches` and add `toolsPlaced:
      placedToolWorktrees.has(w.id)` alongside it (477); update the emptiness
      filter at line 480 to read `entry.sessions.length > 0 || entry.showTools`.
- [x] **1.4** `WorkspaceCanvas.tsx:484-491` — drop `!placedSessionIds.has(s.id)` from
      the `directSessions` filter.
- [x] **1.5** Add `togglePickerItem` per Decision 1, next to `addTile`/`removeTile`
      (~line 567).
- [x] **1.6** `WorkspaceCanvas.tsx:1149-1276` — replace all 6 `addTile(...)` calls in
      the picker JSX (own agents 1154, own terminals 1168, own tools 1181, cross
      sessions 1227, cross tools 1244, cross direct sessions 1266) with
      `togglePickerItem(...)` using the same arguments; at line 1177 the render
      condition becomes `showTools && matchesSearch("Tools")`; at line 1214 the
      destructure becomes `{ worktree, sessions, showTools: wtShowTools, toolsPlaced:
      wtToolsPlaced }`; the Tools row's render condition at ~1240 becomes
      `wtShowTools`.
- [x] **1.7** For each of the 6 picker-item `<button>`s: compute `const placed =
      placedSessionIds.has(s.id)` (own agents/terminals, cross session, cross
      direct session rows) or use `toolsPlaced` / `wtToolsPlaced` directly (own
      Tools / cross Tools rows); add `aria-pressed={placed}`; swap the trailing
      `.workspace-canvas__picker-kind` label for `<Check size={13}
      className="workspace-canvas__picker-check" aria-hidden />` when `placed`;
      set `title`/`aria-label` to `"Remove from canvas"` vs `"Add to canvas"`
      (mirroring the tile close button's own wording at line 935-936).
- [x] **1.8** `web-ui/src/styles/workspace-canvas.css` — add
      `.workspace-canvas__picker-check { color: var(--accent); flex-shrink: 0; }`
      near the existing `.workspace-canvas__picker-kind` rule (~line 211).

**Verify phase 1:**
- [x] **1.T1** `grep -n "canAddTools" web-ui/src/components/layout/WorkspaceCanvas.tsx`
      returns zero matches (confirms every reference was renamed, not just the
      definition).
- [x] **1.T2** `npx tsc --noEmit` in `web-ui/` — clean.
- [x] **1.T3** `npm run build` in `web-ui/` — clean.
- [ ] **1.T4** Manual/browser — dev sandbox (`scripts/dev-sandbox.sh up`): open a
      saved workspace's Add Tile picker with at least one tile already on the
      canvas; confirm that tile's picker row shows a checkmark instead of being
      absent, clicking it removes the tile from the canvas (and the row goes back
      to unchecked on reopen), and clicking an unchecked row still adds a tile
      exactly as before. Cover: own-worktree agent, own-worktree Tools, and one
      cross-project session (saved workspace). Cover the empty state (search query
      matching nothing) shows the updated copy.

---

### Phase 2 — Reset termination verification

- [x] **2.1** `daemon/src/services/sessionRuntime.ts` — import `hasSession` from
      `./tmux.js` alongside the existing `killSession` import (line 5).
- [x] **2.2** `daemon/src/services/sessionRuntime.ts:55-61` — replace the tmux
      branch per Decision 2's snippet (verify → retry once → warn-log on continued
      survival; drop the now-pointless outer try/catch).
- [x] **2.3** `daemon/src/__tests__/sessionRuntime.test.ts:5-7` — extend the
      `../services/tmux.js` mock to also export `hasSession: vi.fn()`, defaulting
      to `mockResolvedValue(false)` (kill succeeds) unless a test overrides it.

**Verify phase 2:**
- [x] **2.T1** Unit — `sessionRuntime.test.ts`: kill succeeds, `hasSession`
      resolves `false` immediately → `killSession` called once, no retry, no
      `console.warn`.
- [x] **2.T2** Unit — `sessionRuntime.test.ts`: `hasSession` resolves `true` once
      then `false` → `killSession` called twice, `hasSession` called twice, no
      `console.warn`.
- [x] **2.T3** Unit — `sessionRuntime.test.ts`: `hasSession` resolves `true` both
      times → `killSession` called twice, `console.warn` called once, message
      includes the session id and tmux name.
- [x] **2.T4** Regression — run, via `cd cli && npx vitest run
      src/daemon/__tests__/sessionRuntime.test.ts
      src/daemon/__tests__/sessions.reset.test.ts
      src/daemon/__tests__/sessions.reset.json.test.ts` (daemon has no
      `package.json` of its own — its tests run through `cli/`'s vitest config via
      the `cli/src/daemon -> ../../daemon/src` symlink) — all passing, no
      regressions. `sessions.reset.json.test.ts` is included specifically because
      it covers the json-channel reset path this plan's Phase 2 does NOT modify
      (Risk #2) — a regression there would mean this change had an unintended
      cross-channel effect.

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/src/components/layout/WorkspaceCanvas.tsx` | **Modified** | 1.1-1.7 | Picker items always render; `togglePickerItem` replaces direct `addTile` calls in the picker JSX; `canAddTools` renamed to `showTools`/`toolsPlaced` throughout |
| `web-ui/src/styles/workspace-canvas.css` | **Modified** | 1.8 | `.workspace-canvas__picker-check` rule |
| `daemon/src/services/sessionRuntime.ts` | **Modified** | 2.1-2.2 | `releaseSessionRuntime`'s tmux branch verifies the kill via `hasSession`, retries once, logs on continued failure |
| `daemon/src/__tests__/sessionRuntime.test.ts` | **Modified** | 2.3, 2.T1-2.T3 | `hasSession` mock + 3 new cases |

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Is there a live bug beyond the swallowed-kill-error gap?** | Code read of `sessions.ts`'s reset route, `sessionRuntime.ts`, `tmux.ts`, the CLI self-target guard, and all 3 plugins' `/vst` command docs found the archive/spawn/slot-inheritance/self-target-guard logic already correct and covered by existing passing tests. The one non-speculative gap found is the unverified tmux kill, addressed above. If the reported symptom recurs after this lands, the new `console.warn` (Decision 2) captures the exact session id + tmux name at the moment of failure — that's the next debugging input, not more speculation now. |
| 2 | **Should json-channel/direct-pty termination get the same verify-retry-log treatment?** | Not bundled into this plan. `directPtyRegistry`'s `.kill()` (`directPty.ts:233-240`) calls `node-pty`'s own `.pty.kill()` directly — an OS syscall, not a separate CLI process shelling out over a socket the way `tmux kill-session` is — a meaningfully different (lower) failure surface. For json-channel sessions, `jsonAgentRegistry.get(session.id)` at the moment `/vst reset --handoff` runs is populated by construction (the reset command is itself running inside that very turn), so the release path is exercised, not skipped; a registry miss only occurs when no turn is in flight, i.e. nothing to terminate. If a future report specifically names a json-channel/direct-pty session, re-open this as its own follow-up rather than guessing at a fix now. |
