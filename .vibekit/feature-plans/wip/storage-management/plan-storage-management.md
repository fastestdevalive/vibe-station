---
Issue: N/A
Branch: management-ui-option
Status: planning (post-review rev 2)
PRD: docs/STORAGE-MANAGEMENT-PRD.md
---

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

## Problem & Concept

- Settings panel (desktop) renders ALL sections stacked in one scrollable column — adding Storage produces an unusably tall dump
- No way to see how much disk each worktree uses or delete stale ones from the UI
- "Dismiss (keep files)" leaves orphaned git checkouts with no re-import path — a confusing half-deleted state
- `DELETE /worktrees/:id` has no guard: any worktree can be deleted regardless of session lifecycle state

Success state:
- Desktop settings nav is a true section-switcher (one section at a time, active pill highlight)
- Settings → Storage shows device disk bar + filterable/sortable worktree list with per-row disk usage + multi-select delete
- Dismiss is removed from all surfaces; DELETE always purges and rejects worktrees that aren't fully done with 409

---

## Requirements

| # | Requirement |
|---|-------------|
| R1 | Desktop SettingsPanel nav switches sections (one at a time); active item gets filled pill |
| R2 | Mobile SettingsPanel unchanged (already tab-based) |
| R3 | `DELETE /worktrees/:id` always purges; rejects 409 if any **agent** session ≠ `done` or any **terminal** session ∉ {`done`, `exited`} |
| R4 | `dismissWorktree()` removed from client.ts, mock.ts, and all UI call sites atomically |
| R5 | `GET /api/worktrees/disk-usage` returns per-worktree diskBytes + device used/total/available |
| R6 | StorageSetting shows device disk bar, worktree list defaulting to filter=`done`, sort=creation-date-desc |
| R7 | Checkboxes and delete icons enabled only for worktrees where ALL agent sessions are `done` and all terminal sessions ∈ {`done`, `exited`} |
| R8 | Multi-select bulk delete with confirmation dialog listing names + sizes + total freed |
| R9 | Filter dropdown: Done (default) / All; Sort dropdown: Creation date ↓ / Disk usage ↓ |
| R10 | Confirmation dialog shows inline error banner on mid-flight 409 from daemon guard |
| R11 | Controls bar shows summary: `N done worktrees · X GB` (filter=Done) or `N worktrees · X GB` (filter=All) |
| R12 | Hint line when filter=Done with N>0 hidden worktrees: `N others hidden by filter` |

---

## Change Map

```
daemon/src/routes/
  worktrees.ts                  ~ remove purge branch; add done guard; add disk-usage route
web-ui/src/api/
  client.ts                     ~ remove dismissWorktree; add getDiskUsage
  mock.ts                       ~ remove dismissWorktree mock; add getDiskUsage mock
  types.ts                      ~ add DiskUsageResponse, WorktreeDiskUsage, DeviceDiskInfo
web-ui/src/components/
  settings/
    SettingsPanel.tsx            ~ desktop: section-switcher (no scroll refs)
    StorageSetting.tsx           + new Storage section component
  layout/
    DashboardPanel.tsx           ~ remove dismiss button, pendingDismiss state, dismiss ConfirmDialog
    LeftSidebar.tsx              ~ remove dismiss context menu item, pendingDismiss, confirmDismissWorktree
web-ui/src/styles/
  workspace.css                  ~ remove two dismiss CSS blocks
```

| Today | After this plan |
|-------|-----------------|
| Desktop settings nav scrolls to anchored section cards | Desktop nav switches sections; only active section renders |
| `DELETE /worktrees/:id?purge=true` deletes; no purge = dismiss | DELETE always purges; 409 if sessions not fully done |
| Dismiss (keep files) affordance on dashboard card and sidebar context menu | Dismiss removed from all surfaces |
| No disk usage data exposed by daemon | `GET /api/worktrees/disk-usage` returns per-worktree bytes + device stats |
| No Storage settings section | Settings → Storage shows disk bar + filterable/deletable worktree list |

---

## Research

- `web-ui/src/components/settings/SettingsPanel.tsx:58-60` — `scrollTo` calls `ref.current?.scrollIntoView` on desktop; `activeTab` state (line 26) already exists but only drives the mobile branch
- `web-ui/src/components/settings/SettingsPanel.tsx:179-201` — desktop nav buttons call `scrollTo(section.ref)`, not `setActiveTab`; fix: wire buttons to `setActiveTab`, collapse dual-branch
- `web-ui/src/api/client.ts:328-343` — `deleteWorktree` appends `?purge=true`; `dismissWorktree` (lines 337-343) omits it; remove `dismissWorktree` only
- `web-ui/src/api/mock.ts:416-423` — `dismissWorktree` mock; remove
- `web-ui/src/components/layout/DashboardPanel.tsx:83,218,244,262-273,441-466` — `pendingDismiss` state, `showDismiss` flag, EyeOff icon button, ConfirmDialog for dismiss
- `web-ui/src/components/layout/LeftSidebar.tsx:609,765-776,1859-1870,1990-1997` — `pendingDismiss` state, `confirmDismissWorktree()`, two ConfirmDialogs, context-menu item "Dismiss (keep files)"
- `web-ui/src/styles/workspace.css:3407-3418` — two dismiss CSS blocks: `.dashboard-card-shell--dismissable:hover .dashboard-card__dismiss` (3407-3409) and `.dashboard-card__dismiss` (3411-3418); both must be removed
- `daemon/src/routes/worktrees.ts:824-856` — `POST /worktrees/:id/done` marks agent sessions `done` and terminal sessions `exited` (comment at line 818-819 explains why terminals have no `done` state); the delete guard must mirror this: agents need `done`, terminals accept `done` OR `exited`
- `daemon/src/routes/worktrees.ts:859-909` — DELETE handler; `shouldPurge` variable at line 863; `releaseSessionRuntime` loop at lines 872-878; guard goes BEFORE the loop
- `daemon/src/routes/worktrees.ts:24` — existing import: `import { worktreePath as getWorktreePath, cleanupSessionDataDir, sessionDataDir } from "../services/paths.js"`; add `vstHome, projectDir` to this import for disk-usage route
- `daemon/src/services/paths.ts:43` — `vstHome(): string` returns `~/.vibe-station`; use as `df` target (the partition vst data lives on); **`$VST_DATA_DIR` is a child-process env var, not in the daemon's own process.env**
- `daemon/src/services/paths.ts:48,63,88` — `projectDir(pid)`, `worktreePath(pid, wid)` (git checkout path), `sessionDataDir(pid, wid, sid)` (per-session data dir)
- `daemon/src/types.ts:8-14` — `LifecycleState` (daemon): `"not_started" | "working" | "idle" | "waiting_for_human" | "done" | "exited"`
- `daemon/src/types.ts:384-430` — `WorktreeRecord`: fields `id, branch, baseBranch, createdAt, sessions: SessionRecord[]`; no `absolutePath` on the worktree — git checkout path = `worktreePath(project.id, wt.id)`
- `web-ui/src/api/types.ts:24-53` — UI `Worktree` type: **no `sessions` array**; StorageSetting must call `api.listSessions()` separately and group by `session.worktreeId`
- `web-ui/src/api/client.ts:301` — `listWorktrees(projectId?: string): Promise<Worktree[]>`
- `web-ui/src/api/client.ts:444` — `listSessions(worktreeId?: string): Promise<Session[]>`
- `web-ui/src/api/types.ts:103` — `Session.state: SessionState` is the right field; `Session.lifecycleState` (line 104) is a legacy alias populated only from the initial REST fetch — use `state`
- `web-ui/src/api/types.ts:74-84` — `SessionState`: `"not_started" | "working" | "idle" | "waiting_for_human" | "done" | "exited"`
- `web-ui/src/api/index.ts:8` — `ApiInstance` is `ReturnType<typeof createMockApi> | ReturnType<typeof createClientApi>`; removing `dismissWorktree` from **both** `client.ts` and `mock.ts` must happen in a single edit pass — removing from only one breaks the union type
- Node 24.14.0 is available; `statfs` from `node:fs/promises` is supported (Node 19.6+) — cleaner than parsing `df` output; use it for device stats
- `du -sb` is GNU/Linux only; macOS `du` requires `-sk` (kilobytes) → multiply by 1024; branch on `process.platform`

---

## Architecture Diagram

```mermaid
flowchart LR
    subgraph Browser
        StorageSetting --> ClientDisk[api.getDiskUsage]
        StorageSetting --> ClientSessions[api.listSessions]
        StorageSetting --> ClientWorktrees[api.listWorktrees]
        StorageSetting --> ClientDelete[api.deleteWorktree]
        SettingsPanel --> StorageSetting
    end
    subgraph Daemon
        DiskRoute["GET /worktrees/disk-usage"]
        DeleteRoute["DELETE /worktrees/:id (guard + always-purge)"]
    end
    ClientDisk --"GET /worktrees/disk-usage"--> DiskRoute
    ClientDelete --"DELETE /worktrees/:id"--> DeleteRoute
    DiskRoute --> statfs["statfs(vstHome()) — device stats"]
    DiskRoute --> du["du per worktree (platform-branched)"]
    DeleteRoute --> Guard{agents=done, terminals=done|exited?}
    Guard --"no"--> 409
    Guard --"yes"--> Purge[worktreeRemove + manifest]
```

---

## Design Details

### Critical User Journeys

**Happy path — delete done worktrees from Storage settings:**
```
User opens Settings → clicks Storage in nav
  → StorageSetting mounts; fetches listWorktrees() + listSessions() + getDiskUsage() in parallel
  → Device disk bar renders with used/total/available
  → Worktree list shows only done worktrees (filter=Done default)
  → Summary: "2 done worktrees · 4.0 GB"
  → User checks two rows → "Delete selected" footer activates
  → Confirmation dialog: "Delete 2 worktrees?" listing branch + size + total freed
  → User confirms → sequential DELETE /worktrees/:id calls
  → Both 200 → rows removed, getDiskUsage() re-fetched, disk bar updates
```

**Error path — worktree no longer done at confirm time:**
```
User selects done worktree → opens confirm dialog
  → Sibling session starts (lifecycle → working)
  → User clicks Delete
  → Daemon returns 409 { error: "worktree_not_done", sessions: ["<id>"] }
  → Dialog button row replaced with:
      "! <branch> is no longer done — deletion cancelled."
      [Close]
```

**Error path — filter=Done, no done worktrees exist:**
```
User opens Storage → all worktrees are active
  → Worktree list empty
  → Shows: "No done worktrees. Switch to All to see active ones."
```

**Error path — no worktrees at all:**
```
User opens Storage → project has no worktrees
  → Shows: "No worktrees yet. Worktrees appear here once you spawn an agent."
```

---

### API Contracts

#### GET /api/worktrees/disk-usage

New route. No new auth — same session-cookie middleware as all other routes. Test via dev sandbox (`scripts/dev-sandbox.sh up`) which sets `VST_NO_AUTH=1`.

```
GET /api/worktrees/disk-usage

200 {
  device: {
    usedBytes: number,        // totalBytes - bfree*bsize
    totalBytes: number,       // blocks * bsize  (from statfs)
    availableBytes: number,   // bavail * bsize  (non-root free)
    mountPoint: string        // resolved via statfs on vstHome()
  },
  worktrees: [
    {
      id: string,             // WorktreeRecord.id
      diskBytes: number       // du on checkout + du on session-data/<wid>; 0 on individual failure
    }
  ]
}

500 { error: "disk_usage_failed", details: string }
```

- Device stats: `statfs(vstHome())` → `bsize * blocks` (total), `bsize * bavail` (available), `totalBytes - bsize * bfree` (used)
- Mount point: not directly in Node `statfs` result; omit or hard-code as `vstHome()` string
- Per-worktree: `diskUsageBytes(worktreePath(pid, wid)) + diskUsageBytes(join(projectDir(pid), "session-data", wid))` via `Promise.all`

```ts
// platform-branched du helper — include verbatim in the route file
async function diskUsageBytes(path: string): Promise<number> {
  try {
    const args = process.platform === "darwin" ? ["-sk", path] : ["-sb", path];
    const { stdout } = await execFileAsync("du", args);
    const n = parseInt(stdout.split("\t")[0], 10);
    return process.platform === "darwin" ? n * 1024 : n;
  } catch {
    return 0;
  }
}
```

- Route sits before the `GET /worktrees/:id/...` family; Fastify's radix router prefers the static segment `disk-usage` over the param `:id`, so no shadowing issue.

#### DELETE /worktrees/:id (modified)

```
DELETE /worktrees/:id
  (?purge param accepted but ignored — always purges for backward compat)

200 { ok: true }
409 { error: "worktree_not_done", sessions: ["<sessionId>", ...] }
      — lists IDs of sessions that are not in an acceptable terminal state
404 { error: "Worktree '<id>' not found" }
```

Guard predicate (must pass before entering the `releaseSessionRuntime` loop):
```ts
const notDone = worktree.sessions.filter(s =>
  s.type === "agent"
    ? s.lifecycle.state !== "done"
    : s.lifecycle.state !== "done" && s.lifecycle.state !== "exited"
);
if (notDone.length > 0) {
  return reply.status(409).send({
    error: "worktree_not_done",
    sessions: notDone.map(s => s.id),
  });
}
```

---

### Key Decisions

#### Decision 1: Always-purge on DELETE
- **Decision:** remove `shouldPurge` branch; `worktreeRemove()` called unconditionally
- **Rationale:** dismiss is removed; `client.ts:deleteWorktree` already always sent `?purge=true`; backward compat: param ignored, not rejected
- **Where:** `daemon/src/routes/worktrees.ts:862-890`

#### Decision 2: Done guard — agents need `done`; terminals accept `done` OR `exited`
- **Decision:** guard predicate matches the `/done` route's own semantics — see API Contracts above for exact code
- **Rationale:** `POST /worktrees/:id/done` (`worktrees.ts:824-856`) marks terminals `exited` by design (comment lines 818-819); a guard requiring `done` on terminals would make every worktree that ever had a terminal permanently undeletable
- **Where:** `daemon/src/routes/worktrees.ts` — new check before `releaseSessionRuntime` loop (line 872)

#### Decision 3: Device disk stats via Node `statfs`, per-worktree via `du`
- **Decision:** `statfs(vstHome())` from `node:fs/promises` for device totals; `du` (platform-branched) for per-directory apparent size
- **Rationale:** `statfs` is cross-platform, no subprocess, no output parsing; `du` apparent size matches user mental model of "how big is this folder"
- **Where:** `daemon/src/routes/worktrees.ts` — new `GET /worktrees/disk-usage` handler

#### Decision 4: Settings desktop → single `activeTab` state, no refs
- **Decision:** remove all `useRef` / `scrollIntoView` from desktop path; reuse existing `activeTab` state (already present at `SettingsPanel.tsx:26`) for both breakpoints; render only the active section
- **Rationale:** PRD §0 — mobile already works this way; Storage needs full panel height, not a card in a scroll
- **Where:** `web-ui/src/components/settings/SettingsPanel.tsx:22-241`

#### Decision 5: StorageSetting fetches worktrees + sessions + disk-usage in parallel on mount
- **Decision:** `Promise.all([listWorktrees(), listSessions(), getDiskUsage()])` on mount; `listSessions()` called without `worktreeId` to get all sessions, then grouped by `session.worktreeId` client-side
- **Rationale:** UI `Worktree` type has no `sessions` array — sessions must be fetched separately; parallel fetch minimises load time
- **Where:** `web-ui/src/components/settings/StorageSetting.tsx` — mount effect

#### Decision 6: Partial bulk delete — keep-and-report
- **Decision:** on bulk delete, call DELETE sequentially per worktree; if one returns 409, set `deleteError` for that worktree's branch name, abort remaining deletes, show error banner; successfully deleted rows are removed from the list
- **Rationale:** rolling back already-successful deletes is impossible; user sees exactly what was deleted and what failed
- **Where:** `web-ui/src/components/settings/StorageSetting.tsx` — delete handler

#### Decision 7: `session.state` is the right field on the UI Session type
- **Decision:** use `session.state` (not `session.lifecycleState`) when checking done-ness in StorageSetting
- **Rationale:** `Session.lifecycleState` (`types.ts:104`) is a legacy alias populated only from the initial REST fetch; `session.state` is updated by `session:state` WS events and is the canonical live value — see comment at `web-ui/src/api/types.ts:74-84`
- **Where:** `web-ui/src/components/settings/StorageSetting.tsx:4.4`

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | `du` on a large worktree with git history could take >200 ms | Mitigation: run all worktrees in parallel via `Promise.all`; zero returned on individual failure |
| 2 | macOS `du` uses `-sk` (KB), not `-sb` (bytes) | Handled in `diskUsageBytes()` helper in Decision 3 — branch on `process.platform` |
| 3 | Node `statfs` doesn't expose `mountPoint` | Omit from response or return `vstHome()` string; frontend doesn't render it |

---

## Implementation Phases

### Phase 1 — Remove dismiss + add done guard (daemon + UI cleanup)

- [ ] **1.1** `daemon/src/routes/worktrees.ts` — add `vstHome, projectDir` to the existing `paths.js` import (line 24); add done guard before `releaseSessionRuntime` loop using the exact predicate from API Contracts above; return 409 with non-done session IDs
- [ ] **1.2** `daemon/src/routes/worktrees.ts` — remove `const { purge } = req.query` and `shouldPurge` variable; call `worktreeRemove()` unconditionally inside the existing try/catch
- [ ] **1.3** `web-ui/src/api/client.ts` — delete `dismissWorktree()` method (lines 337-343); **do this in the same edit as 1.4** — `ApiInstance` is a union of both return types; removing from only one side breaks the type
- [ ] **1.4** `web-ui/src/api/mock.ts` — delete `dismissWorktree()` mock (lines 416-423); same edit pass as 1.3
- [ ] **1.5** `web-ui/src/components/layout/DashboardPanel.tsx` — remove `pendingDismiss` state (line 83), `showDismiss` (line 218), `dashboard-card-shell--dismissable` class (line 244), EyeOff button (lines 262-273), dismiss ConfirmDialog (lines 441-466)
- [ ] **1.6** `web-ui/src/components/layout/LeftSidebar.tsx` — remove `pendingDismiss` state (line 609), `confirmDismissWorktree()` (lines 765-776), dismiss ConfirmDialogs (lines 1859-1870), context-menu item "Dismiss (keep files)" (lines 1990-1997)
- [ ] **1.7** `web-ui/src/styles/workspace.css` — remove both dismiss CSS blocks: `.dashboard-card-shell--dismissable:hover .dashboard-card__dismiss` (lines 3407-3409) and `.dashboard-card__dismiss` (lines 3411-3418)

**Verify phase 1:**
- [ ] **1.T1** Manual — open Dashboard: no EyeOff / dismiss button on any done card
- [ ] **1.T2** Manual — open LeftSidebar worktree context menu: no "Dismiss (keep files)" item
- [ ] **1.T3** Integration — via dev sandbox (`scripts/dev-sandbox.sh up`); mark a worktree done via `POST /worktrees/:id/done`; then `DELETE /worktrees/:id` → 200, worktree removed from list
- [ ] **1.T4** Integration — `DELETE /worktrees/:id` on a working worktree → 409 `{ error: "worktree_not_done", sessions: [...] }`
- [ ] **1.T5** Regression — `DELETE /worktrees/:id?purge=true` on a done worktree → 200 (param ignored, not rejected)
- [ ] **1.T6** Regression — `pnpm --filter @vibestation/web typecheck` passes with no `dismissWorktree` errors
- [ ] **1.T7** Regression — `pnpm --filter @vibestation/cli typecheck` passes

### Phase 2 — Settings desktop section-switcher

- [ ] **2.1** `SettingsPanel.tsx` — remove `modesRef`, `appearanceRef`, `projectsRef`, `hiddenProjectsRef` useRef hooks (lines 23-26, 29) and the `scrollTo` callback (lines 58-60)
- [ ] **2.2** `SettingsPanel.tsx` — remove `ref: React.RefObject<HTMLElement | null>` field from the `Section` interface (line 13) and from every `sections` array entry (lines 31-56)
- [ ] **2.3** `SettingsPanel.tsx` — collapse the `if (isMobile)` split: both breakpoints now read `sections.find(s => s.id === activeTab)`; render only that section's `.content` in the right column; the mobile underline tab bar and the desktop sidebar nav both call `setActiveTab(section.id)` on click
- [ ] **2.4** `SettingsPanel.tsx` desktop nav — add active-state pill: when `activeTab === section.id`, apply `background: "var(--bg-hover)"`, `borderRadius: "var(--radius-sm)"`, `fontWeight: "var(--font-weight-medium)"` to the nav button's inline style
- [ ] **2.5** `SettingsPanel.tsx` desktop content — remove the `sections.map(...)` scroll loop (lines 207-238); remove `id`, `ref`, `scrollMarginTop` from the wrapper; remove the section-label caption (lines 212-222); replace with single `{activeSectionContent}` render
- [ ] **2.6** Add `{ id: "storage", label: "Storage", content: <div>Storage coming soon</div> }` to the `sections` array — placeholder replaced in Phase 4.8; note this placeholder is visible in dev but **must not ship to users without Phase 4 complete**

**Verify phase 2:**
- [ ] **2.T1** Manual — open Settings desktop: clicking each nav item shows only that section's content; no scroll
- [ ] **2.T2** Manual — active nav item has filled pill background; inactive items are plain
- [ ] **2.T3** Manual — open Settings mobile: underline tab bar still works, one section at a time (regression)
- [ ] **2.T4** Regression — Modes, Appearance, Projects, Hidden projects all render correctly when selected

### Phase 3 — Disk usage daemon endpoint

- [ ] **3.1** `daemon/src/routes/worktrees.ts` — add `execFile` (from `node:child_process`) and `promisify` (from `node:util`) and `statfs` (from `node:fs/promises`) to imports; add `vstHome, projectDir` to the `paths.js` import (already listed in 1.1 — ensure both phases share the same import line); add `diskUsageBytes()` helper (exact code from API Contracts section above); add `GET /worktrees/disk-usage` handler before the `GET /worktrees/:id/tree` route using `statfs(vstHome())` for device stats and `Promise.all` for per-worktree `diskUsageBytes`
- [ ] **3.2** `web-ui/src/api/client.ts` — add `getDiskUsage(): Promise<DiskUsageResponse>` calling `GET ${root}/worktrees/disk-usage`
- [ ] **3.3** `web-ui/src/api/mock.ts` — add `getDiskUsage()` returning static plausible data (e.g. device 50 GB total, 30 GB used; two mock worktree entries)
- [ ] **3.4** `web-ui/src/api/types.ts` — add:
  ```ts
  export interface DeviceDiskInfo {
    usedBytes: number;
    totalBytes: number;
    availableBytes: number;
    mountPoint: string;
  }
  export interface WorktreeDiskUsage {
    id: string;
    diskBytes: number;
  }
  export interface DiskUsageResponse {
    device: DeviceDiskInfo;
    worktrees: WorktreeDiskUsage[];
  }
  ```

**Verify phase 3:**
- [ ] **3.T1** Integration — in dev sandbox (auth disabled): `curl http://localhost:<port>/api/worktrees/disk-usage` → 200 JSON with `device` object and non-empty `worktrees` array; replace `<port>` with the port printed by `scripts/dev-sandbox.sh up`
- [ ] **3.T2** Integration — each `worktrees[i].diskBytes` is a non-negative integer
- [ ] **3.T3** Integration — `device.availableBytes + device.usedBytes` is within 5% of `device.totalBytes`
- [ ] **3.T4** Regression — `pnpm --filter @vibestation/cli typecheck` passes

### Phase 4 — StorageSetting component

- [ ] **4.1** Create `web-ui/src/components/settings/StorageSetting.tsx` with props `{ api: ApiInstance }` and state:
  ```ts
  diskUsage: DiskUsageResponse | null
  worktrees: Worktree[]
  sessionsByWorktree: Record<string, Session[]>   // keyed by worktree.id
  loading: boolean
  error: string | null
  filter: "done" | "all"          // default "done"
  sort: "created" | "disk"        // default "created"
  selected: Set<string>           // worktree ids
  pendingDelete: Worktree[] | null
  deleteError: string | null
  ```
  Mount effect: `Promise.all([api.listWorktrees(), api.listSessions(), api.getDiskUsage()])` → populate state; group sessions by `session.worktreeId`

- [ ] **4.2** `isWorktreeDone(wt: Worktree, sessions: Session[]): boolean` pure helper:
  - agent sessions (`session.type === "agent"`): `session.state === "done"`
  - terminal sessions: `session.state === "done" || session.state === "exited"`
  - empty sessions array → treat as done (no sessions to block deletion)

- [ ] **4.3** Device disk bar: `usedBytes / totalBytes` as CSS width %; labels `<usedHuman> / <totalHuman>` and `<availHuman> free`; `formatBytes(n: number): string` helper (auto KB/MB/GB, 1 decimal)

- [ ] **4.4** Controls bar (three controls left to right):
  - "Select all" checkbox — checks all visible post-filter done worktrees
  - Sort dropdown: `Creation date ↓` / `Disk usage ↓`
  - Filter dropdown: `Done` / `All`
  - Summary line below controls: `N done worktrees · X GB` (filter=Done) or `N worktrees · X GB` (filter=All)
  - Hint when filter=Done and some are hidden: `M others hidden by filter`

- [ ] **4.5** Worktree list rows (using `session.state`, not `session.lifecycleState` — see Decision 7):
  - Checkbox: enabled iff `isWorktreeDone(wt, sessions)` (use `sessionsByWorktree[wt.id] ?? []`)
  - Display: `<wt.id> · <wt.branch>`, status dot (reuse `StatusDot` from `web-ui/src/components/layout/StatusDot.tsx`), `Created <date> · <N> sessions`, mini disk bar (`diskBytes / maxDiskBytes` in list), human-readable size, delete icon
  - Delete icon: enabled iff `isWorktreeDone`; disabled with `title="Only done worktrees can be deleted"`
  - Session count: `sessionsByWorktree[wt.id]?.length ?? 0`

- [ ] **4.6** Per-row delete icon click → `setPendingDelete([wt])`

- [ ] **4.7** Bulk delete footer (visible when `selected.size > 0`): `N selected (X GB)` + `Delete selected` button → `setPendingDelete(selectedWorktrees)`

- [ ] **4.8** Confirmation dialog (`pendingDelete !== null`):
  - Title: `Delete N worktrees?` (or `Delete worktree?` for N=1)
  - Body: `This will permanently remove:` then bulleted list `• <branch> (<size>)`; `Total freed: X GB`; `This cannot be undone.`
  - On confirm: call `api.deleteWorktree(id)` sequentially; on 409 → set `deleteError` to `"! <branch> is no longer done — deletion cancelled."`, abort remaining; on all success → close dialog, clear selection, re-fetch `getDiskUsage()`

- [ ] **4.9** Three empty states:
  - Loading: spinner while mount fetch in-flight
  - Filter=Done, no done worktrees: `"No done worktrees. Switch to All to see active ones."`
  - No worktrees at all: `"No worktrees yet. Worktrees appear here once you spawn an agent."`

- [ ] **4.10** Replace Phase 2.6 placeholder with `<StorageSetting api={api} />`; add `api` prop to `SettingsPanel` if not already threaded through

**Verify phase 4:**
- [ ] **4.T1** Manual — Settings → Storage: device disk bar shows reasonable used/free values
- [ ] **4.T2** Manual — filter=Done (default): only done worktrees shown; summary count correct; hint visible when some are hidden
- [ ] **4.T3** Manual — filter=All: all worktrees shown; non-done rows have disabled checkbox + greyed delete icon with tooltip
- [ ] **4.T4** Manual — select 2 done worktrees → Delete selected → confirm → rows removed, disk bar updates
- [ ] **4.T5** Manual — per-row delete on a done worktree → confirm → removed
- [ ] **4.T6** Manual — sort=Disk usage: list reorders largest first
- [ ] **4.T7** Manual — "No done worktrees" empty state appears correctly when all worktrees are active
- [ ] **4.T8** Regression — other settings sections unaffected by section-switcher change
- [ ] **4.T9** Regression — `pnpm --filter @vibestation/web typecheck` passes

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/routes/worktrees.ts` | Modified | 1.1–1.2 | Done guard (409) + always-purge; add `vstHome, projectDir` to import — see API Contracts |
| `daemon/src/routes/worktrees.ts` | Modified | 3.1 | New `GET /worktrees/disk-usage` route — see API Contracts |
| `web-ui/src/api/client.ts` | Modified | 1.3, 3.2 | Remove `dismissWorktree`; add `getDiskUsage(): Promise<DiskUsageResponse>` |
| `web-ui/src/api/mock.ts` | Modified | 1.4, 3.3 | Remove `dismissWorktree` mock; add `getDiskUsage()` mock |
| `web-ui/src/api/types.ts` | Modified | 3.4 | Add `DiskUsageResponse`, `WorktreeDiskUsage`, `DeviceDiskInfo` |
| `web-ui/src/components/layout/DashboardPanel.tsx` | Modified | 1.5 | Remove `pendingDismiss`, `showDismiss`, EyeOff button, dismiss ConfirmDialog |
| `web-ui/src/components/layout/LeftSidebar.tsx` | Modified | 1.6 | Remove `pendingDismiss`, `confirmDismissWorktree`, dismiss ConfirmDialogs, context-menu item |
| `web-ui/src/styles/workspace.css` | Modified | 1.7 | Remove `.dashboard-card-shell--dismissable:hover .dashboard-card__dismiss` (3407-3409) and `.dashboard-card__dismiss` (3411-3418) |
| `web-ui/src/components/settings/SettingsPanel.tsx` | Modified | 2.1–2.6 | Section-switcher: remove refs + scrollTo; unify behind `activeTab`; add Storage entry |
| `web-ui/src/components/settings/StorageSetting.tsx` | New | 4.1–4.10 | Storage section — device disk bar, filtered/sorted worktree list, multi-select delete |
