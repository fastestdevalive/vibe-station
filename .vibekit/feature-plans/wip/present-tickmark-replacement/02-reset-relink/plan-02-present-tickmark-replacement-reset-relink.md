<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: 02-present-tickmark-replacement-reset-relink

> Bug bundle spawned from user verification of `01`'s reset-termination fix (`910e4bb`):
> that fix made the tmux kill itself reliable, but never addressed the client. After a
> reset, the OLD session's tab/tile never goes away and the NEW session never takes its
> place — the classic tab strip shows a permanent duplicate "Archived" tab, and a canvas
> tile keeps rendering the dead session forever while the replacement gets no tile at all.

**Branch:** `present-tickmark-replacement` (same branch/PR as `01`)
**Status:** WIP
**Spawned from:** `../plan-present-tickmark-replacement.md` (Phase 2) — verification finding,
origin `bug-bundle` (M5).
**No PRD** — bug fix, root cause is a confirmed, fully-traced client-side gap.

**Reference files:**
- Backend schema/broadcast: `daemon/src/types.ts`, `daemon/src/routes/sessions.ts`,
  `daemon/src/services/dbSchema.ts`, `daemon/src/state/sqliteRowMappers.ts`,
  `daemon/src/state/project-store.ts`, `daemon/src/ws/protocol.ts`
- Client store: `web-ui/src/hooks/useStore.ts`, `web-ui/src/hooks/useServerSync.ts`
- Client UI: `web-ui/src/components/layout/TabsStrip.tsx`,
  `web-ui/src/api/types.ts`

---

## Problem

- `POST /sessions/:id/reset` (`daemon/src/routes/sessions.ts:1274-1460`) archives the old
  `SessionRecord` and creates a new one with a new id, inheriting `isMain`/`sortOrder`.
- Nothing on the client ever consumes this to relink existing UI state to the new id.
- **Canvas:** a `TileSpec.sessionId` pointing at the archived session keeps resolving via
  `sessionById.get(tile.sessionId)` (`WorkspaceCanvas.tsx:819`, unfiltered) — the tile
  renders a frozen, read-only `ChatPane` (`archived = session?.archivedAt != null`,
  `ChatPane.tsx:174`) forever. The new session gets **no tile anywhere**.
- **Classic tab strip:** `TabsStrip.tsx`'s `orderedSessions` (253-260) has no `archivedAt`
  filter — the archived tab renders indefinitely with an "Archived" badge (545, 675-679),
  indistinguishable in kind from an intentionally-kept `/done` history tab, sitting next
  to the new session's own (correctly created and focused) tab as a permanent duplicate.
- Both `resetSession` call sites (`TabsStrip.tsx:810-815`, `WorkspaceCanvas.tsx:1451-1460`)
  discard the response `{archivedSessionId, newSessionId}` entirely.

## Out of Scope

- `LeftSidebar.tsx`'s pinned/direct-session rows (919, 976-977, 1453, 1514-1515) — same
  badge-only treatment as `/done`-archived sessions; a reset-specific filter there is a
  smaller, separable follow-up (direct sessions can't be worktree-canvas-tiled, so the
  "no tile at all" half of this bug doesn't apply to them).
- Any change to the `/vst reset --handoff` termination logic itself — `01`'s fix already
  covers that; this is purely "what the client does after a correct reset."
- A "show archived sessions" toggle/setting — out of scope; this plan only hides the
  specific subset that was superseded by a live replacement, not archived history broadly.
- `01`'s picker tickmark fix — already shipped in `910e4bb`, untouched here.
- **Retroactive backfill for already-archived rows.** The new `supersededBy` column is
  added via `addColumnIfMissing` (Phase 1) with no backfill — every session archived by a
  reset BEFORE this fix ships stays `supersededBy: null` forever (there is no reliable way
  to reconstruct "which new session replaced this" after the fact; the two records are
  otherwise unlinked). Any duplicate tab/frozen tile that already exists from a past reset
  is NOT retroactively cleaned up by this fix — only resets that happen after it ships.

## Concept

- Add a `supersededBy?: string` field to `SessionRecord`, set on the archived row at
  reset time (mirrors the existing `spawnedFrom` field's plumbing exactly — same DB
  column pattern, same broadcast pattern, same client type pattern).
- Client store gets a pure `relinkSessionInCanvas` helper + a `relinkSessionTiles` action
  that walks every canvas (scratch canvases + saved workspace docs) and repoints any tile
  whose `sessionId` matches the archived id to the new id — same tile, same position.
- `useServerSync.ts`'s central `session:updated` handler calls `relinkSessionTiles` when
  the event carries `supersededBy` — this fires for every connected client, not just the
  one that triggered the reset.
- `TabsStrip.tsx` filters `supersededBy != null` sessions out of its visible tab list and,
  if the active tab was the superseded one, switches focus to its replacement.
- On every full bundle refetch (initial mount AND every WS reconnect —
  `useServerSync.ts`'s `refresh()`), walk the fetched sessions for any still-unrelinked
  `supersededBy` chain and relink it — covers a reset that happened via the CLI with no
  browser open, or while this client was offline/disconnected.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | A session archived by reset persists which session replaced it (`supersededBy`) |
| 2 | Every tile (scratch canvas + every saved workspace doc) referencing the archived session is repointed to the new session, same tile id/position |
| 3 | The relink happens for every connected client via the WS broadcast, not just the initiator |
| 4 | The relink also self-heals on reconnect/reload for a reset that happened while this client was offline |
| 5 | The classic tab strip never shows a reset-superseded tab as a normal live tab |
| 6 | If the superseded tab was active, focus moves to its replacement |
| 7 | Non-reset archival (`/done`, plain archive) is unaffected — those keep today's badge-and-show behavior |
| 8 | Mock API mode (`VITE_USE_MOCK=true`) exercises the same `supersededBy` contract as the real daemon |

---

## Research

### Backend — mirror the existing `spawnedFrom` field exactly

- **`daemon/src/types.ts:289`** — `spawnedFrom?: string | null;` on `SessionRecord`. Add
  `supersededBy?: string | null;` immediately after, same doc-comment style.
- **`daemon/src/services/dbSchema.ts:110`** — `addColumnIfMissing(db, "sessions",
  "spawnedFrom", "TEXT");`. Add an identical line for `"supersededBy"`.
- **`daemon/src/state/sqliteRowMappers.ts`** — `SessionRow` interface has `spawnedFrom:
  string | null;` (line 42); `rowToSession` reads it at line 100
  (`...(row.spawnedFrom != null ? { spawnedFrom: row.spawnedFrom } : {}),`);
  `sessionToRow` writes it at line 145 (`spawnedFrom: session.spawnedFrom ?? null,`). Add
  `supersededBy` to all three, same pattern, same relative position.
- **`daemon/src/state/project-store.ts:261-262`** — the `INSERT INTO sessions (...)`
  column list and `VALUES (...)` placeholder list both include `spawnedFrom` /
  `@spawnedFrom`. Add `supersededBy` / `@supersededBy` to both lists (order must match
  between the two).
- **`daemon/src/routes/sessions.ts:394`** — `serializeSession`'s `spawnedFrom: s.spawnedFrom
  ?? null,`. Add `supersededBy: s.supersededBy ?? null,` alongside it — this is what makes
  the field visible over REST (`GET /sessions/:id`, `GET /sessions`) for a page reload,
  not just the live WS event.
- **`daemon/src/routes/sessions.ts:1414-1415`** — the reset route's `archiveSession`
  lambda, currently:
  ```ts
  const archiveSession = (s: SessionRecord): SessionRecord =>
    s.id === session.id ? { ...s, archivedAt, handoffSummary: handoffText, isMain: false } : s;
  ```
  Add `supersededBy: newId` (the already-computed replacement id, `sessions.ts:1352`) to
  the patched object — see Decision 1.
- **`daemon/src/routes/sessions.ts:1430`** — `broadcastAll({ type: "session:updated",
  sessionId: session.id, archivedAt });`. Add `supersededBy: newId` to this call.
- **`daemon/src/ws/protocol.ts:317-336`** — `SessionUpdatedEvent` zod schema. Add
  `supersededBy: z.string().nullable().optional(),` after `archivedAt` (line 331), same
  style as the existing `spawnedFrom` field on `SessionCreatedEvent` (line 267).
- **Deliberately NOT setting `spawnedFrom` on the new replacement session** (the literal
  at `sessions.ts:1368-1394` already omits it, confirmed) — the Phase 4c auto-insert
  listener (`useServerSync.ts:116-136`) would otherwise fire on every reset and INSERT an
  extra tile via `insertTileIntoWorkspaceDoc`, rather than this plan's relink-in-place.

### Client types — mirror `spawnedFrom` again

- **`web-ui/src/api/types.ts:116`** (`Session` interface) — `spawnedFrom?: string | null;`.
  Add `supersededBy?: string | null;` alongside it, doc comment: "Set once a reset
  archives this session — the replacement session's id. Distinct from `archivedAt`
  (`/done` also sets that; only a reset sets this)."
- **`web-ui/src/api/types.ts:346-358`** (`WSEvent`'s `"session:updated"` variant) — add
  `supersededBy?: string | null;` alongside the existing `archivedAt?: string | null;`
  (357).

### Client store — the relink primitive

- **`web-ui/src/hooks/useStore.ts:335-345`** — `removeTileFromCanvas`, the closest
  existing "pure geometry transform" to model the new helper on: same signature shape
  (`(canvas: CanvasGeometry, ...) => CanvasGeometry`), same never-mutate contract.
- **No existing "walk every canvas" helper** — `findWorkspacesTilingSession`
  (`useStore.ts:354-359`) only scans `workspaceDocs`, not `layoutByWorktree[*
  ].scratchCanvas`. This plan's action is the first to need both.
- **`useStore.ts:697-705`** — `insertTileIntoWorkspaceDoc`, the closest existing action
  for "find affected canvases, patch them via `set()`" — model the new action's `set()`
  shape on this and on `updateScratchCanvas` (730-740).
- Persistence: `layoutByWorktree` and `workspaceDocs` are both in `partialize`
  (`useStore.ts:991-1015`) — no migration needed, this only rewrites existing tiles'
  `sessionId` field, no new persisted shape.

### `useServerSync.ts` — the hook point

- **`useServerSync.ts:159-176`** — the central `session:updated` handler, already applies
  `archivedAt`/`name`/`sortOrder`/`pinnedAt`/`channel`/`pr` patches from the event. Add a
  branch reading `ev.supersededBy` and calling the new store action — see Decision 2.
- This is the ONLY hook needed for the canvas half of the fix — `WorkspaceCanvas.tsx`
  itself needs zero changes: it already reads tiles from the store and sessions from the
  centrally-synced `useServerStore`, so once a tile's `sessionId` is repointed, the
  existing (unfiltered, live) `sessionById.get(tile.sessionId)` lookup just resolves to
  the new session on the next render.

### `TabsStrip.tsx` — tab filtering + active-tab redirect

- **`TabsStrip.tsx:253-260`** — `orderedSessions`, currently `sessions.slice().sort(...)`
  with no filter. `sessions` (set via `setSessions`) is a **separate, worktree-scoped
  list** fetched via `api.listSessions`, not the central store `useServerStore` —
  confirmed by the comment at 408-412 explaining why this file has its own duplicate
  `session:updated` listener — so it needs its own `supersededBy` handling independent of
  `useServerSync`.
- **`TabsStrip.tsx:413-430`** — this file's own `session:updated` listener, currently
  patches `name`/`archivedAt`/`sortOrder`/`pinnedAt`/`channel` into `sessions` via
  `setSessions`. Add `supersededBy` to the patch, per Decision 4.
- **`TabsStrip.tsx:385-406`** — `session:deleted`'s handler is the exact pattern to mirror
  for "if the affected tab was active, switch to a sibling": reads
  `isAgent ? st.activeSessionId : st.activeTerminalSessionId`, compares to the affected
  session id, calls `setActiveSession(target)`. Reuse this shape, target = `ev.
  supersededBy` (always known and correct here, unlike the deleted case's "nearest
  sibling" guess).
- `web-ui/src/components/layout/LeftSidebar.tsx` — NOT touched (see Out of Scope).

### Reconciliation on load/reconnect — closing the "offline reset" gap

- The broadcast-driven relink (Decision 2) only reaches a client that is connected AT THE
  MOMENT the reset happens. A reset triggered by the CLI with no browser open, or while
  this client was disconnected, is invisible to it until the next full refetch.
- **`useServerSync.ts:54-82`** — `refresh()` already runs on every mount AND every
  `ws:open` (initial connect AND every reconnect, per its own doc comment at 21-34) and
  already fetches the full `sessions` array (`api.listSessions()`, line 62) before calling
  `syncSessionsFromApi(sessions)` (line 69). This is the natural place to also resolve any
  still-unrelinked `supersededBy` chain, since it already has the freshest possible
  `sessions` snapshot in hand and already runs on exactly the events ("I might have missed
  something") this gap needs. See Decision 5.
- A double reset while offline produces a chain (`A.supersededBy = B`, `B.supersededBy =
  C`) — the reconciliation walk must resolve to the FINAL live id (`C`), not stop at the
  first hop, or the tile ends up pointing at `B`, itself archived-and-superseded.

### Mock API — `web-ui/src/api/mock.ts`

- **`web-ui/src/api/mock.ts:593-632`** — `resetSession`'s mock implementation. It emits
  `session:updated` with `archivedAt` only at line 606, and only computes `newId` at line
  608 — AFTER the emit, so `supersededBy: newId` cannot simply be added to the existing
  `emit(...)` call at line 606 without first moving `newId`'s computation earlier.
  `web-ui/src/api/index.ts:6` selects this implementation whenever `VITE_USE_MOCK=true`,
  and it backs roughly a dozen component tests — silently leaving it unthreaded means the
  relink is only ever exercised against the real daemon, never in mock-mode
  tests/demos/Storybook-style flows. See Decision 6.

## Root Cause

- The reset route was built "archive old, create new," never "archive old AND tell every
  client which live session replaced it" — every consumer of `archivedAt` (badges, the
  picker, tile rendering) can see "this is dead" but has no way to see "here's its
  replacement," so nothing could ever have implemented a relink even if someone had
  thought to.

---

## Design Details

### System Boundaries

| Boundary | Fields + types | Errors | Source of truth |
|----------|----------------|--------|------------------|
| SQLite ↔ daemon (`project-store.ts`) | `sessions.supersededBy TEXT` (nullable), read/written like `spawnedFrom` | none new — a missing column value reads back `null`, same as any other optional TEXT column | SQLite row |
| Daemon ↔ REST client | `Session.supersededBy?: string \| null` on `GET /sessions`, `GET /sessions/:id` (`serializeSession`) | none new — reset's existing error paths (400/404, `sessions.ts:1283-1299`) are unchanged | daemon |
| Daemon ↔ WS client | `session:updated` event gains `supersededBy?: string \| null` (`SessionUpdatedEvent` zod schema) | zod parse failure on a malformed event is already handled generically by the existing WS message parser — no new error path | daemon (event is fire-and-forget, at-most-once per reset) |
| Client store ↔ UI | `useWorkspaceStore.relinkSessionTiles(fromSessionId, toSessionId): void` — synchronous, always succeeds (a no-op when nothing matches) | none — pure client-side geometry rewrite, cannot fail | `useWorkspaceStore` (`layoutByWorktree`, `workspaceDocs`) |

### Data Model

| Entity | Field | Type | Constraints | Notes |
|--------|-------|------|-------------|-------|
| `sessions` (SQLite) | `supersededBy` | `TEXT` | nullable, no FK enforcement (mirrors `spawnedFrom`, `types.ts:289`'s doc comment: "a deleted source session leaving a dangling id is harmless") | Set only by the reset route, on the OLD (archived) row, to the NEW row's id |

- **Relationships:** `sessions.supersededBy` is a soft self-reference within the same
  `sessions` table (old row → new row), same shape as the existing `spawnedFrom` column.
- **Indexes:** none needed — always looked up by the row's own primary key (`id`), never
  queried BY `supersededBy`.
- **Migration:** additive only, via `addColumnIfMissing(db, "sessions", "supersededBy",
  "TEXT")` (idempotent `ALTER TABLE`, runs on every daemon start, same as every other
  column this table has gained over time). **No backfill** — see Out of Scope for exactly
  what this means for already-archived rows.

### Critical User Journeys (CUJs)

#### CUJ 1 — Reset a session that's tiled on the canvas

```
User has an agent session open as a canvas tile
  → Runs `/vst reset --handoff` (or the UI's Reset action)
  → Daemon archives the old session (supersededBy: newId), creates the new one
  → Daemon broadcasts session:updated {sessionId: oldId, archivedAt, supersededBy: newId}
  → useServerSync's session:updated handler calls relinkSessionTiles(oldId, newId)
  → The SAME tile (same id, same position/geometry) now has sessionId: newId
  → WorkspaceCanvas re-renders that tile showing the NEW session, no manual action needed
```

- **Edge case:** the archived session was tiled in 3 different saved workspace docs at
  once (a cross-context session can appear in multiple saved workspaces) — all 3 get
  relinked in the same `set()` call, not just the currently-viewed one.
- **Edge case:** the archived session had no tile anywhere (never was on a canvas) — the
  relink walk finds nothing, `set()` still runs but returns the same object references
  for every untouched canvas (Decision 3's identity-preserving requirement), no
  unnecessary re-renders.

#### CUJ 2 — Reset a session that's an open classic tab

```
User has an agent session open as a classic tab, it is the active tab
  → Runs reset
  → TabsStrip's own session:updated listener receives {sessionId: oldId, archivedAt,
    supersededBy: newId} and patches supersededBy into sessions (via setSessions)
  → orderedSessions' filter drops the now-supersededBy-set old session from the list
  → Active-tab check: activeSessionId === oldId → setActiveSession(newId)
  → User sees exactly one tab where there used to be one — the new session, focused
```

- **Error path:** the new session's own `session:created` event can race the old one's
  `session:updated` in transit — order independent: whichever arrives first, the tab list
  ends up correct once both have landed (the new tab is added by `session:created`
  regardless of ordering; the old tab is dropped by the filter regardless of ordering).

### Key Decisions

#### Decision 1: `supersededBy` mirrors `spawnedFrom`'s plumbing exactly — *no snippet needed*

- **Decision:** new field, same DB-column-add / row-mapper / INSERT-list / serialize /
  broadcast / zod / client-type shape as the existing `spawnedFrom` field, at every layer.
- **Rationale:** this exact "session A carries a soft reference to session B" shape
  already exists and is proven (spawn-tracking); reusing its plumbing means no new
  concepts, no new migration strategy, and reviewers already know the pattern.
- **Where:** every file/line listed in Research → Backend above.

#### Decision 2: relink triggers off the broadcast, not the response — *with a snippet*

- **Decision:** `useServerSync.ts`'s central `session:updated` handler triggers the
  relink, not the two `resetSession(...)` call sites' `.then()`.
- **Rationale:** the WS broadcast reaches every connected client/tab, so a reset done
  from one browser tab (or the CLI) correctly relinks tiles in every OTHER open browser
  tab too — a response-based fix would only ever fix the initiator's own view.
- **Where:** `web-ui/src/hooks/useServerSync.ts:159-176`.

```ts
const offSessUpdated = api.on("session:updated", (ev) => {
  if (ev.type === "session:updated") {
    const patch: Partial<Session> = {};
    if (ev.channel !== undefined) {
      patch.channel = ev.channel;
      patch.useTmux = ev.channel === "tmux";
    }
    if (ev.pinnedAt !== undefined) patch.pinnedAt = ev.pinnedAt ?? null;
    if (ev.name !== undefined) patch.name = ev.name ?? null;
    if (ev.archivedAt !== undefined) patch.archivedAt = ev.archivedAt ?? null;
    if (ev.sortOrder !== undefined) patch.sortOrder = ev.sortOrder;
    if (ev.pr !== undefined) patch.pr = ev.pr ?? undefined;
    if (ev.supersededBy !== undefined) patch.supersededBy = ev.supersededBy ?? null;
    applySessionUpdated(ev.sessionId, patch);
    // A reset's replacement takes the archived session's place in every canvas
    // it was tiled in — same tile id/position, just repointed. Fires for every
    // connected client (the broadcast, not the initiator's own response), so a
    // reset triggered from the CLI/another tab relinks here too.
    if (ev.supersededBy) {
      useWorkspaceStore.getState().relinkSessionTiles(ev.sessionId, ev.supersededBy);
    }
  }
});
```

#### Decision 3: relink is a pure, identity-preserving tile map — *with a snippet*

- **Decision:** `relinkSessionInCanvas` returns the SAME `canvas` object (not a shallow
  copy) when no tile matched, and `relinkSessionTiles`'s `set()` only replaces the
  specific `layoutByWorktree`/`workspaceDocs` entries whose canvas actually changed.
- **Rationale:** dozens of saved workspace docs can exist; re-rendering every one of them
  on every reset (because a naive implementation always produces a new object) would be
  wasteful and is easy to avoid for free.
- **Where:** `web-ui/src/hooks/useStore.ts`, next to `removeTileFromCanvas` (~line 345)
  for the pure helper, next to `insertTileIntoWorkspaceDoc`/`updateScratchCanvas`
  (~line 705) for the store action.

```ts
/**
 * Repoint every tile referencing `fromSessionId` to `toSessionId` — same tile
 * id, same position/geometry, just a different session behind it (a reset's
 * replacement taking the archived session's exact place). Returns the SAME
 * `canvas` reference when nothing matched, so callers can skip a `set()` for
 * canvases this reset didn't touch.
 */
export function relinkSessionInCanvas(
  canvas: CanvasGeometry,
  fromSessionId: string,
  toSessionId: string,
): CanvasGeometry {
  if (!canvas.tiles.some((t) => t.sessionId === fromSessionId)) return canvas;
  return {
    ...canvas,
    tiles: canvas.tiles.map((t) => (t.sessionId === fromSessionId ? { ...t, sessionId: toSessionId } : t)),
  };
}
```

```ts
// Store action, alongside insertTileIntoWorkspaceDoc/updateScratchCanvas:
relinkSessionTiles: (fromSessionId, toSessionId) =>
  set((s) => {
    let layoutChanged = false;
    const nextLayoutByWorktree = { ...s.layoutByWorktree };
    for (const [worktreeId, layout] of Object.entries(s.layoutByWorktree)) {
      if (!layout.scratchCanvas) continue;
      const relinked = relinkSessionInCanvas(layout.scratchCanvas, fromSessionId, toSessionId);
      if (relinked !== layout.scratchCanvas) {
        nextLayoutByWorktree[worktreeId] = { ...layout, scratchCanvas: relinked };
        layoutChanged = true;
      }
    }
    let docsChanged = false;
    const nextWorkspaceDocs = { ...s.workspaceDocs };
    for (const [docId, doc] of Object.entries(s.workspaceDocs)) {
      const relinked = relinkSessionInCanvas(doc, fromSessionId, toSessionId);
      if (relinked !== doc) {
        nextWorkspaceDocs[docId] = { ...doc, ...relinked };
        docsChanged = true;
      }
    }
    if (!layoutChanged && !docsChanged) return s;
    return {
      ...(layoutChanged ? { layoutByWorktree: nextLayoutByWorktree } : {}),
      ...(docsChanged ? { workspaceDocs: nextWorkspaceDocs } : {}),
    };
  }),
```

- Add `relinkSessionTiles: (fromSessionId: string, toSessionId: string) => void;` to the
  store interface, next to `insertTileIntoWorkspaceDoc`'s declaration (`useStore.ts:261-266`).

#### Decision 4: TabsStrip filters + redirects locally, mirroring `session:deleted` — *with a snippet*

- **Decision:** `orderedSessions` drops `supersededBy != null` sessions; the existing
  `session:updated` listener additionally checks whether the just-superseded session was
  the active tab and redirects if so.
- **Rationale:** `TabsStrip.tsx` maintains its own worktree-scoped session list
  independent of the central store (documented at `TabsStrip.tsx:408-412`) — the central
  `useServerSync` fix does not reach it, this needs its own, symmetric handling.
- **Where:** `TabsStrip.tsx:253-260` (filter), `TabsStrip.tsx:413-430` (listener).

```tsx
const orderedSessions = useMemo(() => {
  return sessions
    .filter((s) => s.supersededBy == null)
    .sort((a, b) => {
      const ao = a.sortOrder ?? 0;
      const bo = b.sortOrder ?? 0;
      if (ao !== bo) return ao - bo;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}, [sessions]);
```

```tsx
const offUpdated = api.on("session:updated", (ev) => {
  if (ev.type !== "session:updated") return;
  setSessions((prev) =>
    prev.map((s) => {
      if (s.id !== ev.sessionId) return s;
      const patch: Partial<Session> = {};
      if (ev.name !== undefined) patch.name = ev.name ?? null;
      if (ev.archivedAt !== undefined) patch.archivedAt = ev.archivedAt ?? null;
      if (ev.sortOrder !== undefined) patch.sortOrder = ev.sortOrder;
      if (ev.pinnedAt !== undefined) patch.pinnedAt = ev.pinnedAt ?? null;
      if (ev.supersededBy !== undefined) patch.supersededBy = ev.supersededBy ?? null;
      if (ev.channel !== undefined) {
        patch.channel = ev.channel;
        patch.useTmux = ev.channel === "tmux";
      }
      return { ...s, ...patch };
    }),
  );
  // The superseded session's tab is about to disappear from orderedSessions —
  // if it was the active one, follow it to its replacement instead of leaving
  // the strip with no selected tab (mirrors the session:deleted handler above).
  if (ev.supersededBy) {
    const st = useWorkspaceStore.getState();
    const cur = isAgent ? st.activeSessionId : st.activeTerminalSessionId;
    if (cur === ev.sessionId) setActiveSession(ev.supersededBy);
  }
});
```

#### Decision 5: reconcile `supersededBy` chains on every full refetch — *with a snippet*

- **Decision:** a new pure helper `resolveSupersededChains(sessions)` (in `useStore.ts`,
  alongside `relinkSessionInCanvas`) computes every `{oldId, finalId}` pair that still
  needs relinking, walking multi-hop chains to their final live id.
  `useServerSync.ts`'s existing `refresh()` (runs on mount + every WS reconnect) calls it
  right after `syncSessionsFromApi(sessions)` and relinks each pair.
- **Rationale:** the broadcast-driven relink (Decision 2) only reaches a client connected
  at the moment of the reset — a reset via the CLI with no browser open, or during this
  client's disconnect window, is otherwise never healed. `refresh()` already runs at
  exactly the right moments ("I might have missed events") and already has the freshest
  `sessions` array in hand. Extracting the chain-walk as a pure function (rather than
  inlining it in the effect) keeps it unit-testable without mocking the whole fetch flow.
- **Where:** `web-ui/src/hooks/useStore.ts` (next to `relinkSessionInCanvas`) for the pure
  helper; `web-ui/src/hooks/useServerSync.ts:54-82` (inside `refresh()`) for the call site.

```ts
// useStore.ts — pure, no store access, easy to unit-test in isolation.
/**
 * Every {oldId, finalId} pair still needing a relink, from a flat sessions
 * list. Walks multi-hop chains (a double reset while offline produces
 * A.supersededBy=B, B.supersededBy=C) to the FINAL live id — relinking to an
 * intermediate hop that is itself archived would just move the bug.
 */
export function resolveSupersededChains(
  sessions: Array<{ id: string; supersededBy?: string | null }>,
): Array<{ oldId: string; finalId: string }> {
  const supersededBy = new Map(
    sessions.filter((s) => s.supersededBy != null).map((s) => [s.id, s.supersededBy as string]),
  );
  const result: Array<{ oldId: string; finalId: string }> = [];
  for (const oldId of supersededBy.keys()) {
    const seen = new Set<string>();
    let finalId = oldId;
    while (supersededBy.has(finalId) && !seen.has(finalId)) {
      seen.add(finalId);
      finalId = supersededBy.get(finalId)!;
    }
    if (finalId !== oldId) result.push({ oldId, finalId });
  }
  return result;
}
```

```ts
// useServerSync.ts, inside refresh(), right after syncSessionsFromApi(sessions):
replaceAll({ projects, worktrees, sessions });
syncSessionsFromApi(sessions);
// Resolve any supersededBy chain this client missed the broadcast for (offline
// during a reset, or the reset came from the CLI with no browser connected).
for (const { oldId, finalId } of resolveSupersededChains(sessions)) {
  useWorkspaceStore.getState().relinkSessionTiles(oldId, finalId);
}
```

#### Decision 6: mock API mirrors the real daemon's `supersededBy` contract — *with a snippet*

- **Decision:** `mock.ts`'s `resetSession` computes `newId` BEFORE emitting
  `session:updated`, and includes `supersededBy: newId` in that emit — matching the real
  daemon's `sessions.ts:1414-1430` ordering (archive-with-`supersededBy` happens, then the
  broadcast carries it).
- **Rationale:** `VITE_USE_MOCK=true` backs component tests and demo flows; leaving this
  unthreaded means the whole relink feature is silently untestable outside a real daemon.
- **Where:** `web-ui/src/api/mock.ts:593-632`.

```ts
// Full function, current source (mock.ts:593-632) reproduced with the 4 changed
// lines marked — everything else is byte-identical to today.
async resetSession(
  id: string,
  body?: { handoff?: boolean; prompt?: string },
): Promise<{ ok: true; archivedSessionId: string; newSessionId: string }> {
  const s = sessions.find((x) => x.id === id);
  if (!s) throw new ApiError("not found", 404);
  if (s.type !== "agent") throw new ApiError("reset only applies to agent sessions", 400);
  if (s.archivedAt) throw new ApiError("session already archived", 400);

  const archivedAt = nowIso();
  const handoffSummary = body?.handoff ? "Mock handoff summary." : null;
  const newId = `sess-${Date.now()}`; // CHANGED: moved up from below the emit — supersededBy needs this before the emit
  s.archivedAt = archivedAt;
  s.handoffSummary = handoffSummary;
  s.supersededBy = newId; // CHANGED: new line
  emit({ type: "session:updated", sessionId: id, archivedAt, supersededBy: newId }); // CHANGED: added supersededBy

  const newSession: Session = {
    ...structuredClone(s), // NOTE: this spreads `s`, which now HAS supersededBy: newId set above —
    id: newId,             // the override below is load-bearing, not redundant, or the replacement
    state: "working",      // session ends up superseding ITSELF and gets filtered out by TabsStrip's
    lifecycleState: "working", // new supersededBy != null check (Decision 4) — the exact bug this
    tmuxName: `tmux-${Date.now()}`, // fix is supposed to remove, just moved onto the new session.
    createdAt: nowIso(),
    archivedAt: null,
    handoffSummary: null,
    pinnedAt: null,
    supersededBy: null, // CHANGED: new line — MUST override the spread, see NOTE above
  };
  sessions.push(newSession);
  emit({
    type: "session:created",
    sessionId: newId,
    worktreeId: newSession.worktreeId,
    projectId: newSession.projectId,
    sessionType: newSession.type,
    mode: typeof newSession.modeId === "string" ? newSession.modeId : undefined,
    snapshot: newSession,
  });

  return { ok: true, archivedSessionId: id, newSessionId: newId };
},
```

---

## Implementation Phases

---

### Phase 1 — Backend: persist + broadcast `supersededBy`

- [x] **1.1** `daemon/src/types.ts:289` — add `supersededBy?: string | null;` to
      `SessionRecord`, after `spawnedFrom`.
- [x] **1.2** `daemon/src/services/dbSchema.ts:110` — add `addColumnIfMissing(db,
      "sessions", "supersededBy", "TEXT");` after the `spawnedFrom` line.
- [x] **1.3** `daemon/src/state/sqliteRowMappers.ts` — add `supersededBy: string | null;`
      to `SessionRow` (~line 42), read it in `rowToSession` (~line 100), write it in
      `sessionToRow` (~line 145) — all three mirroring `spawnedFrom`'s exact pattern.
- [x] **1.4** `daemon/src/state/project-store.ts:261-262` — add `supersededBy` /
      `@supersededBy` to the `INSERT`'s column list and `VALUES` placeholder list.
- [x] **1.5** `daemon/src/routes/sessions.ts:394` — add `supersededBy: s.supersededBy ??
      null,` to `serializeSession`.
- [x] **1.6** `daemon/src/routes/sessions.ts:1414-1415` — add `supersededBy: newId` to the
      reset route's `archiveSession` patch.
- [x] **1.7** `daemon/src/ws/protocol.ts:317-336` — add `supersededBy: z.string()
      .nullable().optional(),` to `SessionUpdatedEvent` (**before** 1.8 — `broadcastAll`
      is typed against this zod schema, `daemon/src/broadcaster.ts:32`; adding the field
      to the broadcast call before the schema accepts it is a compile error).
- [x] **1.8** `daemon/src/routes/sessions.ts:1430` — add `supersededBy: newId` to the
      `session:updated` broadcast call.

**Verify phase 1:**
- [x] **1.T1** Unit — `daemon/src/__tests__/sessions.reset.test.ts`: new test "reset sets
      supersededBy on the archived row to the new session's id" — `POST .../reset`, then
      `GET /sessions/:archivedSessionId` (using the response's `archivedSessionId`), assert
      the JSON body's `.supersededBy === newSessionId` (mirror the existing 4.T5 test's
      request/assert structure at lines 195-213, but assert via the GET route response —
      not via `getProject` — so the test also exercises `serializeSession`'s new field,
      item 1.5).
- [x] **1.T2** Regression — `cd cli && npx vitest run
      src/daemon/__tests__/sessionRuntime.test.ts src/daemon/__tests__/sessions.reset.test.ts
      src/daemon/__tests__/sessions.reset.json.test.ts` — all passing, no regressions from
      the new column/field.

---

### Phase 2 — Client store: relink primitive + central hook

- [x] **2.1** `web-ui/src/api/types.ts:116` — add `supersededBy?: string | null;` to
      `Session`.
- [x] **2.2** `web-ui/src/api/types.ts:346-358` — add `supersededBy?: string | null;` to
      the `WSEvent` `"session:updated"` variant.
- [x] **2.3** `web-ui/src/hooks/useStore.ts` (~line 345, next to `removeTileFromCanvas`) —
      add `relinkSessionInCanvas` per Decision 3's first snippet.
- [x] **2.4** `web-ui/src/hooks/useStore.ts` — add `relinkSessionTiles` to the store
      interface (~line 261-266, next to `insertTileIntoWorkspaceDoc`'s declaration) and
      implement it (~line 705, next to `insertTileIntoWorkspaceDoc`'s implementation) per
      Decision 3's second snippet.
- [x] **2.5** `web-ui/src/hooks/useServerSync.ts:159-176` — wire the `relinkSessionTiles`
      call into the `session:updated` handler per Decision 2's snippet.
- [x] **2.6** `web-ui/src/hooks/useStore.ts` (next to `relinkSessionInCanvas`) — add the
      pure `resolveSupersededChains` helper per Decision 5's first snippet.
- [x] **2.7** `web-ui/src/hooks/useServerSync.ts:5` — add `resolveSupersededChains` to the
      existing `import { useWorkspaceStore, findWorkspacesTilingSession } from
      "./useStore"` line; `useServerSync.ts:54-82` — call it inside `refresh()` per
      Decision 5's second snippet.
- [x] **2.8** `web-ui/src/api/mock.ts:593-632` — reorder `newId`'s computation and thread
      `supersededBy` per Decision 6's snippet.

**Verify phase 2:**
- [x] **2.T1** `npx tsc --noEmit` in `web-ui/` — clean.
- [x] **2.T2** Unit — `web-ui/src/hooks/useStore.test.ts` (existing file — add cases to
      the existing `describe("removeTileFromCanvas")` (line 371) and
      `describe("findWorkspacesTilingSession")` (line 344) blocks, or a new adjacent
      `describe("relinkSessionInCanvas")`/`describe("relinkSessionTiles")` block matching
      the file's existing style): "a scratch-canvas tile referencing the old session gets
      `sessionId` repointed to the new session, same tile id"; "a tile in a saved
      workspace doc gets repointed"; "a tile in TWO saved docs at once both get repointed
      in the same call"; "a canvas with no matching tile is returned by reference-equal
      object (no unnecessary state update)".
- [x] **2.T3** Unit — same file, new `describe("resolveSupersededChains")` block:
      "sessions `[{id:A, supersededBy:B}, {id:B, supersededBy:C}]` resolve to a single
      `{oldId:A, finalId:C}` pair, never `{oldId:A, finalId:B}`"; "a session with no
      `supersededBy` produces no pair"; "a self-referencing/cyclic chain terminates
      instead of looping forever (the `seen` guard)".

---

### Phase 3 — Classic tab strip: filter + active-tab redirect

- [x] **3.1** `TabsStrip.tsx:253-260` — filter `supersededBy != null` out of
      `orderedSessions` per Decision 4's first snippet.
- [x] **3.2** `TabsStrip.tsx:413-430` — patch `supersededBy` into `sessions` (via
      `setSessions`) and add the active-tab redirect per Decision 4's second snippet.

**Verify phase 3:**
- [x] **3.T1** `npx tsc --noEmit` in `web-ui/` — clean (re-run after Phase 3, catches any
      cross-phase type drift).
- [x] **3.T2** `npm run build` in `web-ui/` — clean.
- [x] **3.T3** Unit — `web-ui/src/components/layout/TabsStrip.test.tsx` (existing file —
      match its existing render/mock-api setup, including driving WS events via
      `api.__test.emit(...)` wrapped in `act()`, `mock.ts:284-286` — the file's existing
      tests already use this pattern for `session:updated`/`session:created`, mirror it
      rather than inventing a new event-dispatch mechanism): "a session with
      `supersededBy` set is absent from the rendered tab list"; "when the active tab's
      session receives a `session:updated` event with `supersededBy`, the active tab
      switches to that id".
- [ ] **3.T4** Manual/browser — dev sandbox (`scripts/dev-sandbox.sh up`): reset an agent
      session that is (a) the active classic tab — confirm the old tab disappears and the
      new one is focused in the same position, no duplicate; (b) tiled on a canvas —
      confirm the SAME tile now shows the new session's live pane, no manual re-add
      needed; (c) tiled in a saved workspace doc from a second browser tab — confirm the
      first tab's canvas relinks too, without a manual refresh.

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/types.ts` | **Modified** | 1.1 | `SessionRecord.supersededBy?: string \| null` |
| `daemon/src/services/dbSchema.ts` | **Modified** | 1.2 | New idempotent column |
| `daemon/src/state/sqliteRowMappers.ts` | **Modified** | 1.3 | Row↔record mapping for the new field |
| `daemon/src/state/project-store.ts` | **Modified** | 1.4 | INSERT column list |
| `daemon/src/routes/sessions.ts` | **Modified** | 1.5, 1.6, 1.8 | `serializeSession`, reset's archive patch, `session:updated` broadcast all carry `supersededBy` |
| `daemon/src/ws/protocol.ts` | **Modified** | 1.7 | `SessionUpdatedEvent` zod schema — done before 1.8 (broadcast call) needs it |
| `daemon/src/__tests__/sessions.reset.test.ts` | **Modified** | 1.T1 | New `supersededBy` assertion |
| `web-ui/src/api/types.ts` | **Modified** | 2.1-2.2 | `Session.supersededBy`, `WSEvent["session:updated"].supersededBy` |
| `web-ui/src/hooks/useStore.ts` | **Modified** | 2.3-2.4, 2.6 | `relinkSessionInCanvas` (pure) + `relinkSessionTiles` (action) + `resolveSupersededChains` (pure) |
| `web-ui/src/hooks/useServerSync.ts` | **Modified** | 2.5, 2.7 | `session:updated` handler triggers relink; `refresh()` reconciles chains on load/reconnect |
| `web-ui/src/api/mock.ts` | **Modified** | 2.8 | `resetSession` mock threads `supersededBy` |
| `web-ui/src/hooks/useStore.test.ts` | **Modified** | 2.T2, 2.T3 | Relink + chain-resolution unit tests |
| `web-ui/src/components/layout/TabsStrip.tsx` | **Modified** | 3.1-3.2 | Filters superseded tabs, redirects active focus |
| `web-ui/src/components/layout/TabsStrip.test.tsx` | **Modified** | 3.T3 | Filter + active-tab redirect unit tests |

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does `WorkspaceCanvas.tsx` need ANY direct changes?** | Traced through: no. It reads tiles from the store and resolves `sessionById.get(tile.sessionId)` from the centrally-synced session list — once `relinkSessionTiles` repoints the tile and `applySessionUpdated`/`applySessionCreated` have the new session in the central store (already true today, `session:created`'s existing handling), the existing render path picks it up with no new code in that file. If manual verification (3.T4) finds otherwise, that's a signal this risk was wrong, not a reason to skip verifying it. |
| 2 | **`LeftSidebar.tsx` left inconsistent with `TabsStrip.tsx`?** | Yes, deliberately (Out of Scope) — a reset-superseded direct session still shows there with just an "archived" badge, same as today. Small, separate, low-priority follow-up if it turns out to bother users in practice; not bundled here to keep this fix reviewable. |
| 3 | **Momentary empty slot in a detached workspace view?** | `sessions.ts:1430`'s `session:updated` broadcast fires before `session:created` (1431+) — in a detached-workspace view keyed off a `sessions.some(...)` guard, a relinked tile can very briefly (single React tick, same WS message batch) fail to resolve before `session:created` lands and it resolves normally. Self-healing, not a stale state — not worth the complexity of reordering the two broadcasts or adding a loading placeholder for a sub-render-frame gap. |
