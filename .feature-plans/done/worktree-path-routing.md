# Plan: Worktree Path-Based Routing

**Status:** pending  
**Branch:** `worktree-url-change`  
**PRD:** n/a (routing refactor, no new user-facing features)

---

## Goal

Replace the query-param worktree URL (`/worktree?wt=<id>&session=<id>`) with a clean path-based URL:

| Before | After |
|--------|-------|
| `/worktree?wt=vs-7` | `/worktree/vs-7` |
| `/worktree?wt=vs-7&session=s-abc` | `/worktree/vs-7/s-abc` |
| `/worktree` (no worktree selected) | `/worktree` (unchanged) |
| `/` (dashboard) | `/` (unchanged) |
| `/settings` | `/settings` (unchanged) |

Session ID is only included in the path for non-main-slot sessions (`slot !== "m"`). Main slot navigates to `/worktree/:wtId` only.

---

## Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/App.tsx` | Add `:wtId` and `:wtId/:sessionId` route patterns |
| `apps/web/src/hooks/useWorkspaceUrlSync.ts` | Rewrite: `useSearchParams` → `useParams` + `useNavigate` |
| `apps/web/src/routes/Workspace.tsx` | Update `onWorktreeSelected` type; remove `isDashboard` arg |
| `apps/web/src/components/layout/LeftSidebar.tsx` | Update `onWorktreeSelected` prop signature |
| `apps/web/src/components/layout/DashboardPanel.tsx` | Update `navigate("/worktree")` → `navigate(\`/worktree/${wt.id}\`)` |
| `apps/web/src/App.test.tsx` | Update route assertions |
| `apps/web/src/hooks/useWorkspaceUrlSync.test.tsx` | Rewrite for path-param behaviour |

---

## Risks & Constraints

| Risk | Mitigation |
|------|-----------|
| Old bookmarked `?wt=` URLs break | Add one-shot redirect in `useWorkspaceUrlSync` read phase |
| `/worktree/:wtId` matches API-facing path `/api/worktrees/:id` | No conflict — UI routes are client-side, API calls use `/api/*` prefix |
| Vite dev server doesn't serve `index.html` for deep paths | Vite's dev server already serves `index.html` as SPA fallback; no config change needed |
| `TerminalPane` unmount on route change | Route parameters don't change the React tree position — only `<Workspace />` re-renders; TerminalPane stays mounted |
| Double-navigate loop in write effect | Guard: compare current path to intended path before calling `navigate` |

---

## Phase 1 — Route Definitions

**File:** `apps/web/src/App.tsx` (lines 6–13)

- [x] **1.1** Add two new parametrised routes, keeping the bare `/worktree` fallback:
  ```tsx
  <Route path="/worktree" element={<Workspace />} />
  <Route path="/worktree/:wtId" element={<Workspace />} />
  <Route path="/worktree/:wtId/:sessionId" element={<Workspace />} />
  ```
- [x] **1.2** Keep existing redirects:
  ```tsx
  <Route path="/workspace" element={<Navigate to="/worktree" replace />} />
  <Route path="/dashboard" element={<Navigate to="/" replace />} />
  ```

**1.T1** — `App.tsx` renders without TypeScript errors (`pnpm tsc --noEmit`).  
**1.T2** — Navigating to `/worktree/vs-7` in the browser shows the workspace (manual smoke).

---

## Phase 2 — Rewrite `useWorkspaceUrlSync`

**File:** `apps/web/src/hooks/useWorkspaceUrlSync.ts`

Current contract:
- Takes `(ready, worktrees, sessions, isDashboard?)`
- Uses `useSearchParams` to read `?wt=` and `?session=`
- Writes updated params back via `setSearchParams`

New contract:
- Takes `(ready, worktrees, sessions)` — drop `isDashboard` (path params are absent on `/` and `/settings`, so the read effect is a no-op there)
- Uses `useParams<{ wtId?: string; sessionId?: string }>()` for reading
- Uses `useNavigate` + `useLocation` for writing

### Read effect (one-shot on `ready`)

- [x] **2.1** Read `:wtId` from `useParams`. If present, resolve to a worktree and activate it (same logic as current `?wt=` handling).
- [x] **2.2** Read `:sessionId` from `useParams`. Use it to pick the active session (same fallback chain: explicit → last-used → main slot → first).
- [x] **2.3** Backward-compat redirect: if no `:wtId` param **and** `searchParams.get("wt")` is non-null (old URL), call `navigate(\`/worktree/${wtParam}${sessParam ? \`/${sessParam}\` : ""}\`, { replace: true })` and return early so the normal read fires on the next render with the new path.

### Write effect (ongoing mirror)

- [x] **2.4** After `urlConsumed`, when `activeWorktreeId` or `activeSessionId` changes:
  - Only run when `location.pathname.startsWith("/worktree")` — do not redirect away from `/settings` or `/`.
  - Compute the target path:
    - `activeSessionId` and its session has `slot !== "m"` → `/worktree/${activeWorktreeId}/${activeSessionId}`
    - otherwise → `/worktree/${activeWorktreeId}`
  - Guard: if `location.pathname + location.search` already equals the target, skip to avoid a render loop.
  - Call `navigate(target, { replace: true })`.
- [x] **2.5** Remove `useSearchParams` import. Remove `isDashboard` parameter.

**2.T1** — TypeScript compiles cleanly.  
**2.T2** — Switching worktrees in the sidebar updates the URL path (manual).  
**2.T3** — Switching to a non-main session appends `/:sessionId` (manual).  
**2.T4** — Switching back to main session removes `/:sessionId` (manual).  
**2.T5** — Opening `/worktree?wt=vs-7` redirects to `/worktree/vs-7` (backward compat).  

---

## Phase 3 — Update `Workspace.tsx`

**File:** `apps/web/src/routes/Workspace.tsx`

- [x] **3.1** Remove `isFullWidthPane` from `useWorkspaceUrlSync` call (drop the `isDashboard` third arg).
  - Line 45: `useWorkspaceUrlSync(bundleLoaded, bundle.worktrees, bundle.sessions);`
- [x] **3.2** Update `onWorktreeSelected` callback (line 114–117) to accept `wtId: string` and navigate with it:
  ```tsx
  onWorktreeSelected={(wtId) => {
    if (isMobile) setMobileSidebarOpen(false);
    if (isDashboard || isSettings) navigate(`/worktree/${wtId}`);
  }}
  ```
  When already on `/worktree/*`, no explicit navigate is needed — the write effect in `useWorkspaceUrlSync` fires on the `activeWorktreeId` store change.

**3.T1** — TypeScript compiles cleanly.

---

## Phase 4 — Update `LeftSidebar.tsx`

**File:** `apps/web/src/components/layout/LeftSidebar.tsx`

- [x] **4.1** Update prop type (line ~51):
  ```ts
  onWorktreeSelected?: (wtId: string) => void;
  ```
- [x] **4.2** In `selectWorktree` (line ~243–251), pass `w.id` when calling the callback:
  ```ts
  function selectWorktree(projectId: string, w: Worktree) {
    if (w.id === activeWorktreeId && activeSessionId != null) {
      onWorktreeSelected?.(w.id);
      return;
    }
    setActiveWorktree(projectId, w.id, sessionMap[w.id]);
    onWorktreeSelected?.(w.id);
  }
  ```

**4.T1** — TypeScript compiles cleanly.

---

## Phase 5 — Update `DashboardPanel.tsx`

**File:** `apps/web/src/components/layout/DashboardPanel.tsx` (line ~129)

- [x] **5.1** Change:
  ```ts
  void navigate("/worktree");
  ```
  to:
  ```ts
  void navigate(`/worktree/${wt.id}`);
  ```
  The `wt` variable is already in scope (line ~125: `const wt = worktrees.find(...)`).

**5.T1** — Clicking a session card from the dashboard navigates to `/worktree/<id>` (manual).

---

## Phase 6 — Tests

### `App.test.tsx`

**File:** `apps/web/src/App.test.tsx`

- [x] **6.1** Update comments and test descriptions to reference new path routes:
  - Change mention of `/worktree?wt=` → `/worktree/:wtId`
  - Add a comment noting that `/worktree/:wtId/:sessionId` is also valid

### `useWorkspaceUrlSync.test.tsx`

**File:** `apps/web/src/hooks/useWorkspaceUrlSync.test.tsx`

- [x] **6.2** Tests currently only test pure logic (slot identification) — no DOM render. Update to test:
  - Path-param read logic (given `wtId` param, correct worktree is activated)
  - Session omission when `slot === "m"` still applies to the path (no `/:sessionId` suffix)
  - Backward-compat: presence of `?wt=` triggers redirect path
- [x] **6.3** Add new test: "write effect produces `/worktree/:wtId` path for main-slot session"
- [x] **6.4** Add new test: "write effect produces `/worktree/:wtId/:sessionId` path for non-main session"

**6.T1** — `pnpm --filter web test` passes (all vitest tests green).

---

## Final Verification

- [x] `pnpm tsc --noEmit` — zero errors across the workspace
- [x] `pnpm --filter web test` — all tests pass (10 tests: 2 in App.test.tsx + 8 in useWorkspaceUrlSync.test.tsx)
- [ ] Manual: fresh load of `/worktree/vs-7` activates correct worktree
- [ ] Manual: old URL `/worktree?wt=vs-7` redirects → `/worktree/vs-7`
- [ ] Manual: switching sessions updates path correctly; `history.back()` works as expected
- [ ] Manual: `/settings` and `/` — no stray URL mutation when switching themes or viewing dashboard
