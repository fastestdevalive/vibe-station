<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Never land on a removed/hidden agent

> Opening a worktree (or direct-agent workspace) must never select an agent absent from the tab strip; removal must re-select live.

**Branch:** `opened-opening-direct`
**Status:** WIP
**Paths:** all under `web-ui/src/` (web-ui only; no daemon change)

**Reference files:**
- Store: `hooks/useStore.ts` (`setActiveWorktree` ~L1086, `setActiveSession` ~L1223, `closeProjectAgentTab` ~L1242, `removeTilesForSession` ~L2052)
- Worktree URL sync: `hooks/useWorkspaceUrlSync.ts` (read effect L19-84)
- Project URL sync: `hooks/useProjectWorkspaceUrlSync.ts` (read effect L46-91; sid validation L63-68)
- Live WS handlers: `hooks/useServerSync.ts` (`removeTilesForSession` callers L155-158 + L339-363; `session:updated` L364-397)
- Tab strip: `components/layout/TabsStrip.tsx` (`orderedSessions` L326, `fetchSessions` pick L452-465, `session:deleted` handler L497-517)
- Mount point: `routes/Workspace.tsx` (L228-229 calls both URL-sync hooks)

---

## Problem & Concept

- Opening `/worktree/ch-76` on a long-idle client selected a stopped agent (with a Resume button) that has no tab; the one live agent was not selected.
- Root cause: `lastSessionByWorktree[wt]`/`activeSessionId` (persisted) point at a session still in the server list but hidden from tabs (`supersededBy != null`, e.g. after a reset); on reconnect `useServerSync.ts:160-165` relinks with `followSelection:false`, so the stale pointer survives; URL sync (`useWorkspaceUrlSync.ts:67-72`) then only checks list membership.
- Same class: explicit `/worktree/:wt/:sessionId` URL and the direct-agent `/project/:pid/:sessionId` URL accept hidden ids; direct-agent deletion falls to project home instead of the next direct agent.
- Success: the active agent is always a tab-visible agent; if it stops being one (deleted/superseded, any client, any source) selection moves in real time.

## Out of Scope

- Daemon/Rust changes; terminal-session (`activeTerminalSessionId`) handling.
- Changing the "exited last-session is skipped" rule (Req 4a, `useStore.ts` L1100-1112) — kept as is.
- Archived-but-still-tabbed agents: they stay visible in tabs, so they stay valid targets.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | "Tab-visible agent" = `type === "agent" && supersededBy == null`; worktree: same `worktreeId`; direct: `worktreeId == null`, same `projectId`, and id in `openDirectAgentTabsByProject[pid]` |
| 2 | Worktree open (URL or `setActiveWorktree`): explicit id → last-used (non-exited) → main (non-archived) → first non-archived by `sortOrder` → null; each must be tab-visible |
| 3 | Active worktree agent removed or superseded live → superseded: follow `supersededBy` chain (existing behavior); deleted/other: main, else first live |
| 4 | Direct URL with hidden/missing id → keep store's active id if still a valid direct tab, else first visible open tab, else project home |
| 5 | Active direct agent removed/closed/terminated (any client or source) → neighbor in tab-strip order (prefer before, else first remaining), else project home |
| 6 | One shared pure module owns the rules; TabsStrip agent selection writes use it or are removed |
| 7 | User deliberately clicking a hidden/superseded sidebar row is NOT bounced anywhere (URL pick, guard, TabsStrip refetch) — strict validation applies at OPEN time only (Decision 9) |

---

## Change Map

```
web-ui/src/
  lib/sessionVisibility.ts          + pure pick helpers
  hooks/useStore.ts                 ~ use helpers in 3 actions
  hooks/useWorkspaceUrlSync.ts      ~ validated pick + live guard
  hooks/useProjectWorkspaceUrlSync.ts ~ validated pick + live guard
  hooks/useServerSync.ts            ~ pass project-scoped remaining sessions
  components/layout/TabsStrip.tsx   ~ drop competing agent selection
  components/layout/LeftSidebar.tsx ~ neighbor nav after terminate
  routes/Workspace.tsx              ~ neighbor nav after terminate
```

| Today | After this plan |
|-------|-----------------|
| URL sync accepts any listed session id, incl. superseded | Only tab-visible agents are ever selected on open |
| Only a mounted TabsStrip reacts to deletion, picking "previous tab" | Store-level handling picks main (worktree) / neighbor (direct) deterministically |
| Deleting the active direct agent → project home | → neighbor direct agent, else project home |

---

## Research

- `hooks/useWorkspaceUrlSync.ts:67-72` — `lastSessionId && wtSessions.some(id)`: no `supersededBy`/exited/type check (bug site); `wtSessions[0]` may even be a terminal.
- `hooks/useServerSync.ts:160-165` — reconnect relink uses `followSelection:false`, leaving stale persisted ids (why a long-idle client hits it).
- `hooks/useStore.ts:1107-1113` — `setActiveWorktree` checks only `state !== "exited"`.
- `components/layout/TabsStrip.tsx:326-334` — strip hides exactly `supersededBy != null`, sorts by `sortOrder` then id (visibility + neighbor order definition).
- `components/layout/TabsStrip.tsx:452-465,497-517` — strip's own fetch pick and `session:deleted` neighbor pick compete with the store (last writer wins).
- `hooks/useServerSync.ts:339-363` — `deletedWorktreeId` is null for direct agents → `remainingSessions` undefined → null fallback (`useStore.ts:2086`); `:155-158` caller passes all direct sessions of all projects when `activeWorktreeId` is null.
- `hooks/useStore.ts:1242-1248` — `closeProjectAgentTab` nulls `activeSessionId`; callers `TabsStrip.tsx:1107`, `Workspace.tsx:821`, `LeftSidebar.tsx:1356` (+ `:1100-1104` navigates to `/project/:pid` before deleting).
- `hooks/useProjectWorkspaceUrlSync.ts:46-91` — read effect reruns on every `sessions` change; `refMatches` (L76) fails after a store-side pick, so it can overwrite the neighbor with the URL's stale sid.
- `hooks/useStore.ts:614-617` — reconnect deliberately doesn't move selection (user may view an archived session); sidebar still lists superseded rows (`LeftSidebar.tsx:~2767`).
- **Root cause:** pointers are validated by list membership, not tab visibility, and removal selection is split across uncoordinated writers.

---

## Design Details

### Module contract — `lib/sessionVisibility.ts`

```ts
export function isTabVisibleAgent(s: Session): boolean;            // type==="agent" && supersededBy==null
export function compareTabOrder(a: Session, b: Session): number;   // sortOrder ?? 0, then id — same as TabsStrip.tsx:326-334 (TabsStrip imports it)
export function resolveSupersededChain(id: string, sessions: Session[]): string; // follows supersededBy to the final id
export function pickWorktreeAgent(
  sessions: Session[],                                  // already filtered to the worktree
  opts: { explicitId?: string | null; lastId?: string | null },
): string | null;
// order: explicit(visible) → last(visible && state!=="exited") → main(visible, archivedAt==null)
//        → first visible, archivedAt==null, by compareTabOrder → first visible → null
export function pickFirstDirectAgent(openTabIds: string[], sessions: Session[]): string | null;
export function pickNextDirectAgent(
  openTabIds: string[], closed: Session, sessions: Session[], // openTabIds = tabs BEFORE removal; sessions may be post-deletion
): string | null; // visible tabs minus closed, sorted by compareTabOrder; the one just before closed.sortOrder/id, else first remaining, else null
```

## Key Decisions

| # | Decision | Where |
|---|----------|-------|
| 1 | Visibility = `supersededBy == null` (matches tab strip); deleted ids are absent from the list | `lib/sessionVisibility.ts` |
| 2 | Guard + pick live in the URL-sync hooks and store actions, not TabsStrip, so they work with no strip mounted | both hooks |
| 3 | Effects read `useWorkspaceStore.getState()` (precedent: `useWorkspaceUrlSync.ts:92-95`, `useProjectWorkspaceUrlSync.ts:24-26`) | both hooks |
| 4 | Never read `.lifecycleState`; exited check uses `session.state` | `lib/sessionVisibility.ts` |
| 5 | Guard is EDGE-triggered: a ref holds ids last seen as visible; it acts only when the ACTIVE id was in that set and is now hidden/missing. Ids never seen visible (just-created, sidebar-clicked superseded row, not yet in server store) are left alone; open-time cleanup is done by the pick on URL/`setActiveWorktree` | both hooks |
| 6 | Worktree fallback = main (user requirement); direct fallback = neighbor then project home (user requirement) | `lib/sessionVisibility.ts` |
| 7 | `closeProjectAgentTab(pid, id, sessions)` takes sessions as a param — `useStore.ts` must not import `useServerStore` | `hooks/useStore.ts` |
| 8 | TabsStrip agent-kind deletion/fetch selection writes replaced by helpers; the `session:created` focus write (~L490) is intentionally KEPT (user intent); terminal-kind untouched | `components/layout/TabsStrip.tsx` |
| 9 | OPEN-time vs IN-APP: strict visibility validation only on first apply (`lastParamsRef`/`lastAppliedRef` null: mount, re-entry, full reload) and in `setActiveWorktree`; on later URL param changes (sidebar click: `LeftSidebar.tsx:1256-1262`, `:2843`) accept any listed agent of that worktree/project (sidebar lists superseded rows: `LeftSidebar.tsx:299-308`, `:318-337`). TabsStrip `fetchSessions` keeps `cur` if it is in the UNFILTERED list, validating `last` strictly | both hooks, `TabsStrip.tsx` |
| 10 | Guard snapshot = the visible-id set from the PREVIOUS effect run, REPLACED (not accumulated) on every run, updated even when the guard doesn't act or the route isn't `/worktree`/`/project`; so a row that was visible earlier but was already hidden at the previous run never fires the guard | both hooks |
| 11 | `pickNextDirectAgent` takes the deleted `Session` object (`closed`) not just its id, so its `sortOrder` is available post-deletion; `useServerSync` already looks it up before `applySessionDeleted` (L349-351) | `lib/sessionVisibility.ts`, `useServerSync.ts` |
| 12 | `closeProjectAgentTab` is a no-op for selection if the id is not in the pre-close tab set (WS delete may have already pruned/moved it); set `lastAppliedRef.sid` to the kept id in the project read effect | `useStore.ts`, `useProjectWorkspaceUrlSync.ts` |
| 13 | Test harness: `useWorkspaceUrlSync.test.tsx` uses `render` + a stateful harness (swaps the `sessions` prop via state, navigates via a captured `useNavigate`) rather than `renderHook`, because in this testing-library setup `renderHook`'s `wrapper` does not render the router `Route`'s `element` children (the harness component's render body — and thus the hook's effects — never execute, so the read-effect assertions never fire). `render` renders the Route children correctly | `useWorkspaceUrlSync.test.tsx` |
| 14 | When the deleted/closed direct `Session` object is unavailable (reconnect safety-net `removeTilesForSession` call with no post-deletion Session), `removeTilesForSession` degrades to `pickFirstDirectAgent(preCloseTabs, remainingSessions)` instead of `pickNextDirectAgent` (which needs `closed.sortOrder`); the `session:deleted` WS handler always has the Session, so the neighbor pick is used there | `hooks/useStore.ts` |
| 15 | `useProjectWorkspaceUrlSync.test.ts` keeps its existing `renderHook`-based tests (they pass) and adds the live-churn Phase 2 tests (swapping `sessions`, navigating) via a separate stateful `render` harness mirroring Decision 13; `seedProjectAgentTabsIfEmpty` is called unconditionally at the top of the read effect so the open-tab set is always populated before any fallback pick | `useProjectWorkspaceUrlSync.test.ts`, `useProjectWorkspaceUrlSync.ts` |

---

## Implementation Phases

### Phase 1 — Worktree agents

- [x] 1.1 Create `lib/sessionVisibility.ts` with every export in the contract above (all five agent-pick helpers + `isTabVisibleAgent`, `compareTabOrder`, `resolveSupersededChain`)
- [x] 1.2 `useWorkspaceUrlSync.ts` read effect (L55-80): replace inline pick with `pickWorktreeAgent(wtSessions, {explicitId: sessionId, lastId})` on first apply only (Decision 9); on later param changes accept `sessionId` if it is any listed agent of that worktree, else fall back to the pick
- [x] 1.3 `useStore.ts` `setActiveWorktree` (L1100-1113): `defaultSessionId = pickWorktreeAgent(agents, {lastId})`; note the idempotent early return (L1096-1098) keeps an existing active id — the guard (1.4) covers it
- [x] 1.4 `useWorkspaceUrlSync.ts`: edge-triggered guard effect per Decision 5 (only while on a `/worktree` path with `ready`; snapshot semantics per Decision 10): active id was known-visible and is now hidden/missing → if it has `supersededBy`, `setActiveSession(resolveSupersededChain(...))`, else `setActiveSession(pickWorktreeAgent(wtSessions, {lastId}))`; ensure order read → guard → write has no URL loop
- [x] 1.5 `useStore.ts` `removeTilesForSession` (L2086): fallback = `pickWorktreeAgent(remainingSessions, {})` instead of main-only
- [x] 1.6 `TabsStrip.tsx` agent kind: in `fetchSessions` (L452-465) filter `supersededBy == null` before validity checks and pick via `pickWorktreeAgent` (keep `cur` if in the unfiltered list, Decision 9); delete the `setActiveSession` neighbor call in the `session:deleted` handler (L497-517) for `isAgent` (terminal-kind keeps it); import `compareTabOrder` for `orderedSessions` (L326)
- [x] 1.T Tests (vitest): new `lib/sessionVisibility.test.ts` (superseded last, exited last, archived main, terminal never picked, none live → null, chain resolve); extend existing `hooks/useWorkspaceUrlSync.test.tsx` (stale superseded last → live main; explicit superseded id → main; edge guard: active agent deleted → main; superseded → replacement; never-seen-visible id untouched); extend `hooks/useStore.test.ts` (`setActiveWorktree` skips superseded last; `removeTilesForSession` main fallback). Router/`renderHook` harness: copy `hooks/useProjectWorkspaceUrlSync.test`

- [x] 1.T2 Tests also cover Decision 9: sidebar-style param change to a superseded id stays selected; TabsStrip refetch keeps a superseded `cur`

**Verify phase 1:** `cd web-ui && pnpm vitest run src/lib/sessionVisibility.test.ts src/hooks src/components/layout/TabsStrip.test.tsx && pnpm typecheck && pnpm lint`

### Phase 2 — Direct agents

- [x] 2.1 `useProjectWorkspaceUrlSync.ts` read effect (L63-91): on first apply (Decision 9) `sid` valid only if direct agent of `pid` and `isTabVisibleAgent`; on later param changes accept any listed direct agent of `pid`; when `params.sessionId` is present but invalid → keep `store.activeSessionId` if it is a valid visible direct tab of `pid`, else `pickFirstDirectAgent(useWorkspaceStore.getState().openDirectAgentTabsByProject[pid], sessions)` (re-read after `seedProjectAgentTabsIfEmpty`), else null; a missing `params.sessionId` stays null (Project home tab, R1)
- [x] 2.2 `useStore.ts` `closeProjectAgentTab(projectId, sessionId, sessions)` (signature + 3 callers `TabsStrip.tsx:1107`, `Workspace.tsx:821`, `LeftSidebar.tsx:1356`): when closing the active id set `activeSessionId = pickNextDirectAgent(preCloseTabs, sessionId, sessions)` (null if none); no-op when `sessionId` not in the pre-close tab set (Decision 12)
- [x] 2.3 `LeftSidebar.tsx` ~L1100-1104 (the only terminate navigation, currently goes to `/project/:pid` without calling `closeProjectAgentTab`): navigate to `/project/:pid/<next>` via `pickNextDirectAgent`, else `/project/:pid`; `LeftSidebar.tsx` ~L1351-1356 and `Workspace.tsx` ~L821 are draft discards — only pass the new `sessions` arg, no navigation change; update the stale "nulls activeSessionId" comment
- [x] 2.4 `useServerSync.ts` `session:deleted` handler (L339-363): capture deleted session's `projectId`/`worktreeId`; `remainingSessions` = same-worktree sessions, or for direct (`worktreeId == null`) same-project sessions with `worktreeId == null`; pass the deleted `Session` too (extend `removeTilesForSession(sessionId, remainingSessions, closed?)`); also fix L155-158 caller to filter by project when `activeWorktreeId` is null
- [x] 2.5 `useStore.ts` `removeTilesForSession`: if active session was direct (`activeWorktreeId == null` and `activeDirectContextId != null`), fallback = `pickNextDirectAgent(preCloseTabs, closed, remainingSessions)` computed BEFORE pruning the open-tab set
- [x] 2.6 `useProjectWorkspaceUrlSync.ts`: edge-triggered guard (Decisions 5, 10) — active direct id was in previous visible set, now hidden/missing → if it has `supersededBy` use `resolveSupersededChain` (as 1.4), else `pickNextDirectAgent` using the last known `Session` object and tab order, else null; plus read-effect must not overwrite a store-side pick (2.1 keep-if-valid rule)
- [x] 2.T Tests: extend `hooks/useProjectWorkspaceUrlSync.test.ts` (hidden sid URL → first open tab; none → project home; live deletion of active → neighbor-before, no overwrite by read effect; deleting the last → project home); `useStore.test.ts` (`closeProjectAgentTab` neighbor/null; `removeTilesForSession` direct case; tab order uses `compareTabOrder`)

- [x] 2.T2 Tests also cover Decision 9 (sidebar click on superseded direct agent not bounced) and Decision 12 (`closeProjectAgentTab` no-op after WS delete)

**Verify phase 2:** `cd web-ui && pnpm vitest run && pnpm typecheck && pnpm lint`

---

## Files & Phase Impact

| File | Change | Phase |
|------|--------|-------|
| `web-ui/src/lib/sessionVisibility.ts` | + helpers | 1 |
| `web-ui/src/lib/sessionVisibility.test.ts` | + tests | 1 |
| `web-ui/src/hooks/useWorkspaceUrlSync.ts` | ~ pick + guard | 1 |
| `web-ui/src/hooks/useWorkspaceUrlSync.test.tsx` | ~ tests (existing file) | 1 |
| `web-ui/src/components/layout/TabsStrip.tsx` | ~ fetch pick, deleted handler, comparator | 1 |
| `web-ui/src/hooks/useStore.ts` | ~ `setActiveWorktree`, `removeTilesForSession`, `closeProjectAgentTab` | 1, 2 |
| `web-ui/src/hooks/useStore.test.ts` | ~ tests | 1, 2 |
| `web-ui/src/hooks/useProjectWorkspaceUrlSync.ts` | ~ pick + guard | 2 |
| `web-ui/src/hooks/useProjectWorkspaceUrlSync.test.ts` | ~ tests | 2 |
| `web-ui/src/hooks/useServerSync.ts` | ~ project-scoped remaining sessions | 2 |
| `web-ui/src/components/layout/LeftSidebar.tsx` | ~ neighbor nav after terminate | 2 |
| `web-ui/src/routes/Workspace.tsx` | ~ neighbor nav, caller update | 2 |

## Final verification (orchestrator, dev sandbox — not an implementation phase)

- `scripts/dev-sandbox.sh up --port=71NN`; drive with Playwright MCP
- Edge cases: stale `lastSessionByWorktree` → superseded session (localStorage) → opens main; `/worktree/<wt>/<supersededId>` → main; reset active agent live → follows replacement; delete active worktree agent live → main; direct: delete middle/last/only active direct agent → neighbor / neighbor / project; `/project/<p>/<bogus>` → first tab or project home; second browser tab deletes the agent the first is on; sidebar click on a superseded row is not bounced
