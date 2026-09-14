---
feature: global-draft-server
worktree: /home/gb/.vibe-station/projects/vibe-station/worktrees/vs-131
commit-strategy: amend   # amend existing commits on branch create-ui-db, not new ones
---

# Plan: Server-persisted global draft sessions

## Problem

Clicking **New project** (`.sidebar-projects-heading__add`, `FolderPlus` icon) always navigates
to the shared `/draft/new` route — a single localStorage slot (`useGlobalDraftStore`). Every
click overwrites or re-uses the same form; you can never have two independent pending drafts.

## Goal

Each click of **New project** creates a real server-persisted draft session with a unique ID
and navigates to `/draft/<id>`, just like the per-project `+` button already does.

## Change Map

```
Before (Today)                  After
──────────────────────────────  ───────────────────────────────────────
handleGlobalNewAgent            handleGlobalNewAgent
  globalDraftSet({...})           api.createDraftSession({target:"global"})
  navigate("/draft/new")          applySessionCreated(s)
                                  navigate(`/draft/${s.id}`)

/draft/new  ← shared localStorage  /draft/<id>  ← unique server session
                                    session.projectId = null
                                    draftConfig.entryPoint = "global"

DraftComposer (Tier 2)          DraftComposer (Tier 1, entryPoint="global")
  shows project picker              shows project picker (same UI)
  stored in localStorage            stored server-side, survives reload
  only 1 at a time                  N drafts, each with own URL/sidebar row

Sidebar: 1 Tier-2 row at most   Sidebar: N server global drafts at top
(globalDraft != null)           (sessions where projectId=null)
```

## Decisions

- **D1**: New `global_drafts` table (no FK to `projects`) rather than making `sessions.projectId`
  nullable. Avoids recreating the `sessions` table and touching FK-enforced inserts everywhere.
- **D2**: `generateSessionId("global", "agent")` → IDs look like `global-a-<hex>`.
- **D3**: `DraftComposer` reuses existing Tier-1 render path. When `session.projectId === null`
  and `entryPoint === "global"`, show `ProjectCombobox`. On project selection call
  `handleSelectProject(p)` (already exists, just wire it up).
- **D4**: `/draft/new` route and `useGlobalDraftStore` are **kept as-is** for backward-compat.
  The "New project" button no longer touches them.
- **D5**: When user selects a project inside a global draft, create a new Tier-1 direct session
  for that project (same as current `handleSelectProject`), delete the global draft, navigate
  to the new session's draft URL.
- **D6**: WS broadcast on global draft creation uses the existing `session:created` event shape
  with `projectId: null`. `useServerSync` already calls `applySessionCreated` on that event.

---

## Phase 1 — Daemon: `global_drafts` table + route support

### File table

| File | Change |
|------|--------|
| `daemon/src/services/dbSchema.ts` | Add `CREATE TABLE IF NOT EXISTS global_drafts` to `db.exec()` block in `ensureSchema` |
| `daemon/src/state/project-store.ts` | Add `getAllGlobalDrafts`, `addGlobalDraft`, `updateGlobalDraft`, `removeGlobalDraft` — plain SQLite helpers (no mutex, no `mutateProject`) |
| `daemon/src/routes/sessions.ts` | Accept `target:"global"` in `CreateDraftSessionBody`; add `kind:"global"` to `findSessionContext` return union + search `getAllGlobalDrafts()`; add `serializeGlobalDraft` helper; wire global CRUD into GET/POST/DELETE/PATCH routes |
| `daemon/src/ws/handlers/sessionLookup.ts` | **No change** — global drafts have no live process; WS input/resize/open never need them |

---

### 1.1 `dbSchema.ts` — add `global_drafts` table

**File:** `daemon/src/services/dbSchema.ts`  
**Where:** inside the `db.exec(`` ` `` ... `` ` ``)` block, after the `tunnel_state` table definition (line ~120), before the closing backtick.

```sql
-- global_drafts: server-persisted drafts with no project assigned yet.
-- No FK to projects — that is the whole point (sessions.projectId is NOT NULL
-- and FK-enforced; we cannot store project-less rows there).
CREATE TABLE IF NOT EXISTS global_drafts (
  id         TEXT PRIMARY KEY,
  draftPrompt TEXT,
  draftConfig TEXT,
  createdAt  TEXT NOT NULL
);
```

No `addColumnIfMissing` calls needed — new table, not retrofitting an existing one.

---

### 1.2–1.5 `project-store.ts` — global_drafts CRUD helpers

**File:** `daemon/src/state/project-store.ts`  
**Where:** add after the last exported function (near EOF).  
**Pattern:** direct `db.prepare(...).run(...)` — no `mutateProject` / no mutex (global drafts are not part of any project's object graph).

```ts
// ── global_drafts helpers ────────────────────────────────────────────────

export interface GlobalDraftRow {
  id: string;
  draftPrompt: string | null;
  draftConfig: string | null;   // JSON string
  createdAt: string;
}

export function getAllGlobalDrafts(): GlobalDraftRow[] {
  return getDb().prepare("SELECT * FROM global_drafts ORDER BY createdAt ASC").all() as GlobalDraftRow[];
}

export function addGlobalDraft(row: GlobalDraftRow): void {
  getDb()
    .prepare(
      "INSERT INTO global_drafts (id, draftPrompt, draftConfig, createdAt) VALUES (?, ?, ?, ?)",
    )
    .run(row.id, row.draftPrompt ?? null, row.draftConfig ?? null, row.createdAt);
}

export function updateGlobalDraft(
  id: string,
  patch: { draftPrompt?: string; draftConfig?: string },
): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.draftPrompt !== undefined) { sets.push("draftPrompt = ?"); vals.push(patch.draftPrompt); }
  if (patch.draftConfig !== undefined) { sets.push("draftConfig = ?"); vals.push(patch.draftConfig); }
  if (sets.length === 0) return false;
  vals.push(id);
  const res = getDb().prepare(`UPDATE global_drafts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return res.changes > 0;
}

export function removeGlobalDraft(id: string): boolean {
  const res = getDb().prepare("DELETE FROM global_drafts WHERE id = ?").run(id);
  return res.changes > 0;
}
```

Import `getDb` is already present in this file.

---

### 1.6–1.10 `sessions.ts` — route changes

**File:** `daemon/src/routes/sessions.ts`

#### 1.6 New import at top of file

Add to the import block from `../state/project-store.js`:
```ts
import {
  // ... existing imports ...
  getAllGlobalDrafts,
  addGlobalDraft,
  updateGlobalDraft,
  removeGlobalDraft,
  type GlobalDraftRow,
} from "../state/project-store.js";
```

#### 1.6 `serializeGlobalDraft` helper

Add alongside `serializeSession` (after line ~427):

```ts
export function serializeGlobalDraft(row: GlobalDraftRow) {
  return {
    id: row.id,
    worktreeId: null,
    projectId: null,
    isMain: false,
    type: "agent" as const,
    modeId: null,
    name: null,
    nameSource: null,
    tmuxName: `__draft__-${row.id}`,
    useTmux: false,
    channel: "json",
    state: "drafting" as const,
    lifecycleState: "drafting" as const,
    createdAt: row.createdAt,
    pinnedAt: null,
    archivedAt: null,
    sortOrder: new Date(row.createdAt).getTime(),
    handoffSummary: null,
    parentSessionId: null,
    supersededBy: null,
    pr: null,
    draftPrompt: row.draftPrompt ?? null,
    draftConfig: row.draftConfig ? (JSON.parse(row.draftConfig) as DraftConfig) : null,
  };
}
```

#### 1.6 Extend `SessionContext` type + `findSessionContext`

Replace the current `SessionContext` type (line ~172) and `findSessionContext` function (lines ~176–188):

```ts
type SessionContext =
  | { kind: "worktree"; project: ProjectRecord; worktree: WorktreeRecord; session: SessionRecord }
  | { kind: "direct"; project: ProjectRecord; session: SessionRecord }
  | { kind: "global"; row: GlobalDraftRow };

function findSessionContext(sessionId: string): SessionContext | null {
  for (const project of getAllProjects()) {
    for (const worktree of project.worktrees) {
      const session = worktree.sessions.find((s) => s.id === sessionId);
      if (session) return { kind: "worktree", project, worktree, session };
    }
    const directSession = project.directSessions.find((s) => s.id === sessionId);
    if (directSession) return { kind: "direct", project, session: directSession };
  }
  const globalRow = getAllGlobalDrafts().find((r) => r.id === sessionId);
  if (globalRow) return { kind: "global", row: globalRow };
  return null;
}
```

#### 1.7 `CreateDraftSessionBody` zod schema — drop the `.refine` that requires projectId/worktreeId

Replace the current `CreateDraftSessionBody` zod schema (lines ~96–108):

```ts
const CreateDraftSessionBody = z.object({
  target: z.enum(["worktree", "direct", "global"]).optional(),
  projectId: z.string().min(1).optional(),
  worktreeId: z.string().min(1).optional(),
  type: z.enum(["agent", "terminal"]),
  state: z.literal("drafting"),
  draftPrompt: z.string().optional(),
  draftConfig: z.any().optional(),
}).refine(
  (b) => b.target === "global" || b.projectId != null || b.worktreeId != null,
  { message: "projectId or worktreeId is required for non-global draft sessions" },
);
```

#### 1.7 `POST /sessions` — handle `target:"global"` branch

Inside the `if (bodyAny?.state === "drafting")` block (around line ~548), add a new branch **before** the existing `if (!derivedProjectId)` check:

```ts
// Global draft — no project yet; stored in global_drafts table.
if (draftData.target === "global") {
  const sessionId = generateSessionId("global", draftData.type);
  const now = new Date().toISOString();
  const draftConfig = draftData.draftConfig as DraftConfig | undefined;
  const row: GlobalDraftRow = {
    id: sessionId,
    draftPrompt: draftData.draftPrompt ?? null,
    draftConfig: draftConfig ? JSON.stringify(draftConfig) : null,
    createdAt: now,
  };
  addGlobalDraft(row);
  const serialized = serializeGlobalDraft(row);
  broadcastAll({
    type: "session:created",
    sessionId,
    projectId: null,
    worktreeId: null,
    sessionType: draftData.type,
    mode: undefined,
    parentSessionId: null,
    snapshot: serialized,
  });
  return reply.status(201).send(serialized);
}
```

#### 1.8 `GET /sessions` — append global drafts to the "all" branch

Replace the "all" return (lines ~452–456):

```ts
// Return all sessions (worktree + direct) across all projects, then global drafts
const all = getAllProjects().flatMap((p) => [
  ...p.worktrees.flatMap((w) => w.sessions.map((s) => serializeSession(w.id, p.id, s))),
  ...p.directSessions.map((s) => serializeSession(null, p.id, s)),
]);
const globalDrafts = getAllGlobalDrafts().map(serializeGlobalDraft);
return reply.send([...all, ...globalDrafts]);
```

Note: the `?worktree=:id` and `?project=:id` filtered branches do NOT need to return global drafts (they're scoped queries).

#### 1.9 `DELETE /sessions/:id` — pre-check global_drafts, skip runtime teardown

Replace the start of the `app.delete("/sessions/:id", ...)` handler body (after `const { id } = req.params`):

```ts
// Global draft: no process, no data dir — just remove the row.
const maybeGlobal = getAllGlobalDrafts().find((r) => r.id === id);
if (maybeGlobal) {
  const removed = removeGlobalDraft(id);
  if (!removed) return reply.status(404).send({ error: `Session '${id}' not found` });
  broadcastAll({ type: "session:deleted", sessionId: id });
  return reply.send({ ok: true });
}

const ctx = findSessionContext(id);
if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
// ... rest of existing handler unchanged ...
```

#### 1.10 `PATCH /sessions/:id/draft` — handle `kind:"global"` branch

After `const ctx = findSessionContext(id);` (line ~1133), add a new branch before the existing lifecycle-state check:

```ts
if (ctx.kind === "global") {
  // Global draft: update directly, no mutateProject, no name derivation.
  const patch: { draftPrompt?: string; draftConfig?: string } = {};
  if (draftPrompt !== undefined) patch.draftPrompt = draftPrompt;
  if (draftConfig !== undefined) patch.draftConfig = JSON.stringify(draftConfig);
  updateGlobalDraft(id, patch);
  broadcastAll({
    type: "session:updated",
    sessionId: id,
    draftPrompt: draftPrompt !== undefined ? draftPrompt : undefined,
    draftConfig: draftConfig !== undefined ? draftConfig : undefined,
  });
  return reply.send({ ok: true });
}
```

#### 1.11 `sessionLookup.ts` — **No change**

`findSessionRecord` in `ws/handlers/sessionLookup.ts` is used only by WS handlers (sessionInput/Resize/Open) which process live agent I/O. Global drafts have no tmux process and will never be opened/resized/sent input. Do not modify this file.

---

## Phase 2 — Client types + API

### File table

| File | Change |
|------|--------|
| `web-ui/src/api/types.ts` | `Session.projectId: string → string \| null`; add `{ target: "global" }` variant to `CreateDraftSessionBody` |
| `web-ui/src/api/index.ts` | Allow `createDraftSession({target:"global", type:"agent", draftConfig})` (only if the function currently validates projectId/worktreeId presence — check first) |

---

### 2.1 `api/types.ts` — widen `Session.projectId`

**Line 145.** Change:
```ts
  projectId: string;
```
to:
```ts
  /** Project this session belongs to. null for global drafts (no project chosen yet). */
  projectId: string | null;
```

### 2.2 `api/types.ts` — extend `CreateDraftSessionBody`

Replace the current type (lines ~215–222):

```ts
export type CreateDraftSessionBody = {
  type: "agent";
  draftPrompt?: string;
  draftConfig: DraftConfig;
  state?: "drafting";
} & (
  | { target?: "direct"; projectId: string; worktreeId?: never }
  | { target?: "worktree"; worktreeId: string; projectId?: never }
  | { target: "global"; projectId?: never; worktreeId?: never }
);
```

### 2.3 Null-projectId ripple audit

After widening `Session.projectId`, check these locations — all are safe without code changes:

| File | Location | Why safe |
|------|----------|----------|
| `LeftSidebar.tsx` line ~1006 | `draftsByProject` memo: `if (s.projectId && ...)` | Short-circuits on null — global drafts won't key into any project bucket |
| `LeftSidebar.tsx` line ~253 | direct-session list: `if (s.projectId && ...)` | Same guard |
| `DraftComposer.tsx` | `projects.find(p => p.id === session?.projectId)` | Returns `undefined` when `projectId` is null — already handles that |
| `useServerStore.ts` | `applySessionCreated` upsert | Only uses `session.id` as a key |
| `useServerSync.ts` | `session:created` handler | Passes session object through unchanged |
| `Workspace.tsx` | `onDiscard` → `api.terminateSession(id)` | Only uses session ID |

Run `pnpm --filter @vibestation/web typecheck` after this phase — it will surface any missed usage.

---

## Baseline: what clear-sync already implemented

The `plan-draft-project-clear-sync` plan landed 3 commits (`9cccf8f`, `1b2021c`, `2e83a58`, `f97f11f`). Before starting Phase 3, understand what's already in `DraftComposer.tsx` vs what was reverted:

### Already done (do NOT redo):

| Item | File:line | Notes |
|------|-----------|-------|
| `onSelectExisting` → `void handleSelectProject(p)` | `DraftComposer.tsx:575` | Wired up |
| `handleClearProject()` function | `DraftComposer.tsx:336` | Demotes Tier-1 → Tier-2, navigates `/draft/new` |
| Project chip ✕ → `void handleClearProject()` | `DraftComposer.tsx:613` | Unconditional (not gated on `entryPoint`) |
| "Use project folder instead" button | `DraftComposer.tsx:620+` | Shown only when `entryPoint === "worktree"` |
| `onClear` resets stale project-scoped fields | `DraftComposer.tsx:585–598` | Resets 8 fields |

### Reverted / NOT in current file (f97f11f removed them):

| Item | Status | Impact on our plan |
|------|--------|-------------------|
| `selectingRef = useRef(false)` guard in `handleSelectProject` | Absent | Phase 3.4 must re-add it |
| `draftPrompt: prompt` in `handleSelectProject` createDraftSession body | Absent | Phase 3.4 must add it |
| `setComboMode("existing")` at start of `handleSelectProject` | Absent | Phase 3.4 must add it |

### Current `handleSelectProject` (lines 315–333) — verbatim for reference:

```ts
async function handleSelectProject(p: Project) {
  setSelectedProject(p);
  setNewProjectName("");
  setError(null);
  if (p.isGit) setUseWorktree(true);
  try {
    const created = await api.createDraftSession({
      target: "direct",
      projectId: p.id,
      type: "agent",
      draftConfig: { ...currentConfig, entryPoint: "global" },
    });
    useServerStore.getState().applySessionCreated(created);
    clearGlobalDraft();
    navigate(`/draft/${created.id}`);
  } catch (err) {
    setError(errorMessage(err, "Failed to create draft."));
  }
}
```

### Current project-picker JSX gate (line 570):

```tsx
{!isTier1 ? (
  <ProjectCombobox ... />
) : (
  // project chip block (only rendered for Tier-1 sessions with a project)
)}
```

`handleClearProject` navigates to `/draft/new` and seeds `useGlobalDraftStore` — correct behavior for all Tier-1 sessions with a project. For global Tier-1 sessions (no project yet), the ProjectCombobox is shown instead of the chip, so `handleClearProject` will never be triggered for those.

---

## Phase 3 — UI wiring

### File table

| File | Change |
|------|--------|
| `web-ui/src/components/layout/LeftSidebar.tsx` | Replace `handleGlobalNewAgent`; replace Tier-2 sidebar row with server global draft rows |
| `web-ui/src/components/draft/DraftComposer.tsx` | Show `ProjectCombobox` for global Tier-1 sessions; re-add `selectingRef`; fix `handleSelectProject` to terminate global draft on project select |

---

### 3.1 `LeftSidebar.tsx` — `handleGlobalNewAgent`

**Lines ~931–934.** Replace:
```ts
function handleGlobalNewAgent() {
  if (isMobile) setMobileSidebarOpen(false);
  globalDraftSet({ draftPrompt: "", draftConfig: { entryPoint: "global" } });
  navigate("/draft/new");
}
```
with:
```ts
function handleGlobalNewAgent() {
  if (isMobile) setMobileSidebarOpen(false);
  setDraftError(null);
  void (async () => {
    try {
      const s = await api.createDraftSession({
        target: "global",
        type: "agent",
        draftConfig: { entryPoint: "global" },
      });
      useServerStore.getState().applySessionCreated(s);
      gotoDraft(s.id);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "Couldn't create a new draft. Please try again.");
    }
  })();
}
```

The `useServerStore` import is already present. `gotoDraft` already exists (line ~923). `setDraftError` already exists.

Remove the three `globalDraftSet` / `globalDraftClear` / `globalDraft` lines from this function (lines ~918–920 in the draft flow section) — they are no longer needed here. Keep `handleDiscardGlobal` for the remaining `/draft/new` backward-compat path.

### 3.2 `LeftSidebar.tsx` — global draft sidebar rows

**Lines ~1497–1529.** Replace the single Tier-2 row (`{!collapsed && globalDraft ? ...}`) with server-side global draft rows:

```tsx
{/* Server-persisted global draft rows — sessions with projectId=null, state="drafting" */}
{!collapsed && sessions
  .filter((s) => s.projectId === null && s.state === "drafting")
  .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  .map((s) => (
    <div
      key={s.id}
      className="tree-row tree-row--project draft-row"
      data-active={location.pathname === `/draft/${s.id}`}
      style={{ position: "relative" }}
    >
      <Link to={`/draft/${s.id}`} className="wt-row__stretch-link" draggable={false} tabIndex={-1} />
      <div className="tree-row__project-expand" style={{ pointerEvents: "none" }}>
        <span className="tree-row__project-chevron" aria-hidden>
          <Folder size={14} />
        </span>
        <span className="tree-row__label draft-row__label">{draftLabel(s.draftPrompt)}</span>
      </div>
      <div className="wt-row__trail draft-row__trail">
        <span className="draft-chip">Draft</span>
        <button
          type="button"
          className="draft-row__discard icon-btn"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleDiscard(s);
          }}
          title="Discard draft"
        >
          ×
        </button>
      </div>
    </div>
  ))
}
{/* Keep Tier-2 row for /draft/new backward-compat */}
{!collapsed && globalDraft ? (
  <div
    className="tree-row tree-row--project draft-row"
    data-active={location.pathname === "/draft/new"}
    style={{ position: "relative" }}
  >
    <Link to="/draft/new" className="wt-row__stretch-link" draggable={false} tabIndex={-1} />
    <div className="tree-row__project-expand" style={{ pointerEvents: "none" }}>
      <span className="tree-row__project-chevron" aria-hidden>
        <Folder size={14} />
      </span>
      <span className="tree-row__label draft-row__label">{draftLabel(globalDraft.draftPrompt)}</span>
    </div>
    <div className="wt-row__trail draft-row__trail">
      <span className="draft-chip">Draft</span>
      <button
        type="button"
        className="draft-row__discard icon-btn"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDiscardGlobal(); }}
        title="Discard draft"
      >
        ×
      </button>
    </div>
  </div>
) : null}
```

`handleDiscard(s)` (line ~980) already calls `api.terminateSession(s.id)` and navigates away — works unchanged for global drafts since DELETE is handled in Phase 1.

### 3.3 `DraftComposer.tsx` — show `ProjectCombobox` for global Tier-1 sessions

**File:** `DraftComposer.tsx`, line 570.

Currently the project field gate is:
```tsx
{!isTier1 ? (
  <ProjectCombobox ... />
) : (
  // project chip block
)}
```

For a global Tier-1 session (`isTier1 === true`, `session?.projectId === null`), this falls into the `else` branch and renders the project chip with `name ?? "…"` — wrong. The user needs the combobox to pick a project.

Change the condition to:
```tsx
{(!isTier1 || !session?.projectId) ? (
  <ProjectCombobox ... />
) : (
  // project chip block — only for Tier-1 sessions that already have a project
)}
```

`onSelectExisting` is already wired to `void handleSelectProject(p)` (line 575, from clear-sync). No change needed there. All the `onClear`/`onNewName`/`onAddPath` callbacks survive unchanged.

### 3.4 `DraftComposer.tsx` — update `handleSelectProject` (lines 315–333)

Three additions are needed, all in `handleSelectProject`:

1. **Re-add `selectingRef` guard** (removed in f97f11f, still needed to prevent double-fires from `ProjectCombobox`'s auto-adopt `useEffect`). Add `const selectingRef = useRef(false)` near the other refs (around line ~106), then wrap the function body:

```ts
// Near other refs (~line 106):
const selectingRef = useRef(false);

// Replace handleSelectProject (lines 315–333) with:
async function handleSelectProject(p: Project) {
  if (selectingRef.current) return;
  selectingRef.current = true;
  setSelectedProject(p);
  setComboMode("existing");   // ← re-add: ensures startTier1ForProject fallback stays reachable
  setNewProjectName("");
  setError(null);
  if (p.isGit) setUseWorktree(true);
  try {
    const created = await api.createDraftSession({
      target: "direct",
      projectId: p.id,
      type: "agent",
      draftPrompt: prompt,    // ← re-add: preserve what the user typed before picking a project
      draftConfig: { ...currentConfig, entryPoint: "global" },
    });
    useServerStore.getState().applySessionCreated(created);
    // For global Tier-1 sessions: terminate the server draft we're "graduating" from.
    // For Tier-2 sessions: clearGlobalDraft handles cleanup (terminateSession is a no-op here).
    if (isTier1 && draftSessionId && !session?.projectId) {
      void api.terminateSession(draftSessionId).catch(() => {});
    }
    clearGlobalDraft();
    navigate(`/draft/${created.id}`);
  } catch (err) {
    setError(errorMessage(err, "Failed to create draft."));
  } finally {
    selectingRef.current = false;
  }
}
```

Note: `isTier1` and `session` are already in scope (lines ~51–56). `draftSessionId` is the component prop. `clearGlobalDraft` is a no-op for Tier-1 sessions (store is empty), so it's safe to call unconditionally.

The "Discard" path for global Tier-1 sessions needs no change: `Workspace.tsx`'s `onDiscard` already calls `api.terminateSession(draftSessionId)`, which will hit the `DELETE /sessions/:id` route added in Phase 1.

---

## Phase Checklist

### Phase 1 — Daemon

- [ ] 1.1 `dbSchema.ts`: add `global_drafts` table (`id`, `draftPrompt`, `draftConfig`, `createdAt`) inside the `db.exec()` block
- [ ] 1.2 `project-store.ts`: `getAllGlobalDrafts()` — SELECT all rows; returns `GlobalDraftRow[]`
- [ ] 1.3 `project-store.ts`: `addGlobalDraft(row)` — INSERT one row
- [ ] 1.4 `project-store.ts`: `updateGlobalDraft(id, patch)` — UPDATE draftPrompt/draftConfig; returns `changes > 0`
- [ ] 1.5 `project-store.ts`: `removeGlobalDraft(id)` — DELETE; returns `changes > 0`
- [ ] 1.6 `sessions.ts`: `serializeGlobalDraft(row)` → object shaped like `serializeSession` output with `projectId: null`, `lifecycleState: "drafting"`
- [ ] 1.6b `sessions.ts`: extend `SessionContext` union with `{ kind: "global"; row: GlobalDraftRow }`; add global_drafts search to `findSessionContext`
- [ ] 1.7 `sessions.ts`: `CreateDraftSessionBody` zod — add `"global"` to `target` enum, relax the `.refine` to allow `target:"global"` with no projectId/worktreeId
- [ ] 1.7b `sessions.ts`: `POST /sessions` — add `target:"global"` branch before `!derivedProjectId` check: call `addGlobalDraft`, broadcast `session:created`, return 201
- [ ] 1.8 `sessions.ts`: `GET /sessions` (all) — append `getAllGlobalDrafts().map(serializeGlobalDraft)` to result
- [ ] 1.9 `sessions.ts`: `DELETE /sessions/:id` — pre-check `getAllGlobalDrafts().find(r => r.id === id)`; on match call `removeGlobalDraft` + broadcast + return 204; skip `releaseSessionRuntime` / `cleanupDirectSessionDataDir`
- [ ] 1.10 `sessions.ts`: `PATCH /sessions/:id/draft` — after `findSessionContext`, add `kind:"global"` branch: `updateGlobalDraft` + broadcast; no `mutateProject`, no name derivation
- [ ] 1.11 `sessionLookup.ts`: **No change** (global drafts have no live process; WS handlers never need them)
- [ ] 1.T1 `curl -X POST localhost:<port>/sessions -d '{"target":"global","type":"agent","state":"drafting","draftConfig":{"entryPoint":"global"}}'` → 201 with `id` like `global-a-*`
- [ ] 1.T2 `GET /sessions` → response includes an entry with `projectId: null` and `lifecycleState: "drafting"`
- [ ] 1.T3 `DELETE /sessions/<id>` on the global draft → 200 `{ok:true}` and row gone from GET

### Phase 2 — Client types

- [ ] 2.1 `api/types.ts`: `Session.projectId: string | null` (line ~145)
- [ ] 2.2 `api/types.ts`: add `| { target: "global"; projectId?: never; worktreeId?: never }` to `CreateDraftSessionBody` union
- [ ] 2.3 `api/index.ts`: verify `createDraftSession` doesn't have a runtime guard blocking `target:"global"` (if it does, remove it)
- [ ] 2.T1 `pnpm --filter @vibestation/web typecheck` — PASS

### Phase 3 — UI

**Already done by clear-sync (skip these):** `onSelectExisting` → `handleSelectProject` wiring (line 575), `handleClearProject` function (line 336), project chip ✕ → `handleClearProject` (line 613), `onClear` field-reset (lines 585–598). Do not touch those.

- [ ] 3.1 `LeftSidebar.tsx` `handleGlobalNewAgent`: replace `globalDraftSet+navigate("/draft/new")` with async `api.createDraftSession({target:"global",...})` → `applySessionCreated` → `gotoDraft(s.id)` with `setDraftError` on catch
- [ ] 3.2 `LeftSidebar.tsx` sidebar: replace single Tier-2 global draft row with `sessions.filter(s => s.projectId === null && s.state === "drafting").map(...)` rendering rows with `handleDiscard(s)`; keep Tier-2 `/draft/new` row for backward-compat
- [ ] 3.3 `DraftComposer.tsx` line 570: change project-picker gate from `{!isTier1 ? ...}` to `{(!isTier1 || !session?.projectId) ? ...}` so global Tier-1 drafts show `ProjectCombobox` instead of the project chip
- [ ] 3.4 `DraftComposer.tsx` ~line 106: re-add `const selectingRef = useRef(false)` near other refs (was removed in commit f97f11f)
- [ ] 3.5 `DraftComposer.tsx` replace `handleSelectProject` (lines 315–333) with updated version: add `selectingRef` guard + `finally`; add `setComboMode("existing")` at start; add `draftPrompt: prompt` to `createDraftSession` body; add global Tier-1 cleanup (`if (isTier1 && draftSessionId && !session?.projectId) void api.terminateSession(draftSessionId).catch(() => {})`); keep `clearGlobalDraft()` unconditional (no-op for Tier-1)
- [ ] 3.T1 Click **New project** twice → confirm two separate `/draft/global-a-*` URLs open in sidebar
- [ ] 3.T2 Select a project inside a global draft → confirm redirects to `/draft/<project-session-id>`, global draft row disappears from sidebar
- [ ] 3.T3 Discard a global draft → confirm row gone, `GET /sessions` confirms no orphan
- [ ] 3.T4 `pnpm --filter @vibestation/web typecheck` — PASS

---

## Out of scope

- Migrating existing localStorage Tier-2 drafts to server drafts on upgrade
- Debounced server-side save as the user types in a global draft
- Showing global draft count badge on the "New project" button
