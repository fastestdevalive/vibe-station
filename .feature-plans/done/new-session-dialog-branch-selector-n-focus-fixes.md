# New Session Dialog — real branch selector + mobile focus-steal fix

- **Status:** done
- **Branch:** `new-session-dialog-branch-selector-n-focus-fixes`
- **PRD:** n/a (small feature + bug fix)
- **Author:** Claude

## Verification results

- `pnpm -r typecheck` — clean (web-ui + cli).
- `pnpm lint` — 8 problems, **identical to clean base** (all pre-existing: TerminalPane
  control-regex errors + unused-var warnings); zero new issues.
- web-ui tests — 111/111 pass (new Dialog focus tests + branch-selector tests included).
- daemon tests — 196 pass (added 2 branch-endpoint tests); the 4 failures (`lifecycle.test.ts`
  timing, `modes.test.ts` gemini model) are pre-existing on the base, unrelated to this work.
- **Docker (dev.Dockerfile):** image builds; daemon boots; `GET /projects/:id/branches` against a
  real multi-branch repo returns `{"branches":["develop","feature-x","main","release/2.0"],"defaultBranch":"main"}`
  (confirms shell-quoted `--format` handles `release/2.0`), and unknown project → 404.

---

## Problem

Two independent issues in the "New session" dialog (`web-ui/src/components/dialogs/NewSessionDialog.tsx`):

1. **Hardcoded base branch.** The "Base branch" field defaults to the literal string `"main"`
  (`NewSessionDialog.tsx:32`) and is a free-text `<Input>` (`:155-160`). Projects that use
  `master`, or any other branch, get a wrong default and no list of what actually exists. Typos
  only fail server-side after submit.

2. **Mobile keyboard hides itself / Close button looks focused.** When typing in the dialog on a
  mobile on-screen keyboard — especially while a background agent chat in the open worktree is
  streaming output — focus jumps to the Close (`×`) button (visible focus border) and the keyboard
  collapses.

---

## Root cause — issue 2 (focus steal) — CONFIRMED on desktop

- `Dialog` auto-focuses the first focusable element on open via a `setTimeout` inside a
  `useEffect` whose deps are `[open, handleKeyDown]` (`Dialog.tsx:56-69`).
- `handleKeyDown` is `useCallback`-memoized on `[onClose]` (`Dialog.tsx:29-54`).
- The caller passes a **new inline `onClose` each render**:
  `onClose={() => setNewSessProject(null)}` (`LeftSidebar.tsx:539`).
- `LeftSidebar` re-renders whenever the server-data store changes. A background agent chat
  streaming output triggers `session:*` WS events → store updates → `LeftSidebar` re-renders.
- Each re-render → new `onClose` → new `handleKeyDown` → effect cleanup + **re-run** → `setTimeout`
  fires → `first?.focus()` focuses the **Close button** (first focusable in the card) → steals
  focus from the `<input>`/`<textarea>` the user is typing in.

This is a **pure focus-management bug, not a keyboard/IME bug**. Confirmed reproducing on desktop
(focus jumps to the Close button mid-typing while a background agent streams); the mobile keyboard
collapse is just a downstream symptom of the same focus jump. Two distinct defects to fix:

1. **When** auto-focus runs — it re-runs on every background re-render instead of once per open.
2. **What** it focuses — the first focusable element is the **Close (`×`) button**, which is the
   wrong target (a stray Enter/Space closes the dialog). Initial focus should land on the **branch
   name field** (the first meaningful input), per product decision.

---

## Goals

- Base branch field becomes a **dropdown of real branches** for the project, defaulting to the
  detected default branch (`master`/`main`/origin-HEAD fallback chain already implemented in
  `detectDefaultBranch`).
- All error/loading/empty states handled (offline daemon, empty repo, fetch failure).
- Auto-focus runs **once per open**, never re-steals focus on background re-renders.
- No regression to Escape handling, Tab focus-trap, or overlay-click-to-close.

## Non-goals

- Changing how worktrees are actually created server-side (branch creation logic stays).
- Letting users pick an arbitrary branch for "existing worktree" flow (that flow has no base
  branch field).
- Caching branch lists across dialog opens.

---

## Design

### Backend: new `GET /projects/:projectId/branches` endpoint

- Add a `listBranches(repoPath)` helper to `daemon/src/services/git.ts` that returns local branch
  names via `git branch --list --format=%(refname:short)` (clean, no `*`/whitespace parsing).
- Add endpoint in `daemon/src/routes/projects.ts` returning
  `{ branches: string[]; defaultBranch: string }`:
  - `getProject(projectId)` → 404 if missing.
  - `isGitRepo(project.absolutePath)` → 400 if not a repo.
  - `branches = await listBranches(...)`.
  - `defaultBranch = (await detectDefaultBranch(...)) ?? project.defaultBranch`.
  - Return both so the client doesn't re-implement the fallback chain.
- Endpoint already registered via `registerProjectRoutes` in `server.ts:115` — no new register call.

### Frontend: API client + types

- Add `listProjectBranches(projectId): Promise<{ branches: string[]; defaultBranch: string }>` to
  `web-ui/src/api/client.ts` (mirror `listWorktrees` pattern, `encodeURIComponent`).
- Add response type to `web-ui/src/api/types.ts`.

### Frontend: NewSessionDialog branch selector

- Replace `baseBranch` free-text `<Input>` (`:155-160`) with a `<Select>` of fetched branches.
- New state: `branches: string[]`, `branchesError: string | null`, `branchesLoading: boolean`.
- Extend the on-open `useEffect` (`:41-53`) to also call `api.listProjectBranches(projectId)`:
  - On success: `setBranches(res.branches)`; set `baseBranch` to `res.defaultBranch` if present in
    list, else first branch.
  - On failure (offline/non-repo): `setBranchesError(...)`; **fall back to a free-text Input** so
    the user can still type a branch and submit (graceful degradation — keeps current behavior
    working when the endpoint is unavailable).
- Empty list (new/empty repo): show the free-text Input fallback + a hint.
- Default `baseBranch` initial state changes from `"main"` to `""` (populated after fetch).
- Keep sending `baseBranch.trim() || undefined` in `createWorktree` (`:74`) — server still applies
  its own fallback to `project.defaultBranch`.

### Frontend: Dialog focus fix (the core bug)

Fix both defects — *when* focus runs and *what* it focuses.

- **Stable keydown handler via ref.** Add `onCloseRef = useRef(onClose)` updated every render
  (`onCloseRef.current = onClose`). Define `handleKeyDown` with `useCallback(..., [])` (empty deps)
  and have it call `onCloseRef.current()` for Escape. The handler identity is now permanently
  stable, so nothing it touches forces an effect re-run, while Escape still calls the *latest*
  `onClose` (no stale-closure bug). Tab focus-trap logic is unchanged.
- **Split the single effect** (`Dialog.tsx:56-69`) into two:
  1. **Keydown listener effect** — keyed on `[open, handleKeyDown]` (handleKeyDown is now stable,
     so effectively just `[open]`): add/remove the `keydown` listener once per open.
  2. **Auto-focus effect** — keyed on `[open]` **only**. Runs once when the dialog opens; never
     re-runs on background re-renders.
- **Correct initial focus target.** The auto-focus effect focuses, in priority order:
  1. An element marked `[data-autofocus]` inside the card (the New Session dialog tags its branch
     name input with `data-autofocus`), else
  2. the first `input, select, textarea` that is **not** a button and not `[disabled]`, else
  3. the dialog card itself (give `cardRef` `tabIndex={-1}` so it can receive focus as a neutral
     fallback when there is no field).
  The Close button is **never** a default focus target.
- `Input`/`Select` already spread `{...props}` onto the native element (`ui/Input.tsx:5`,
  `ui/Select.tsx:5`), so `data-autofocus` passes straight through — no ref-forwarding needed.
- Net effect: focus lands on the branch field exactly once when the dialog opens; background
  re-renders never move focus; Escape/Tab/overlay-click behavior preserved. Fix lives entirely in
  `Dialog.tsx` + one attribute in `NewSessionDialog.tsx`, robust regardless of caller `onClose`
  hygiene.

---

## Review corrections (Opus review — incorporated below)

- **(B1)** `ApiInstance` is a **union** of `createMockApi` | `createClientApi` (`api/index.ts:8`).
  `listProjectBranches` MUST be added to **both** `client.ts` AND `mock.ts`, or typecheck and every
  dialog test (which use `createMockApi`) break.
- **(B2)** `NewSessionDialog.test.tsx:33` hard-asserts `baseBranch: "main"`. Mock must return a
  deterministic default (`proj-a` → `main`) so the assertion still holds after the field becomes a
  fetched dropdown; update the test if the asserted value changes.
- **(M3)** `git branch --list --format='%(refname:short)'` — the format string **must be
  single-quoted**; `git.ts` interpolates into a `/bin/sh` string (`git.ts:12-14`) and `()` are
  shell metacharacters that otherwise break.
- **(H1)** Fetch branches in a **separate try/catch**, NOT folded into the existing
  `Promise.all([listWorktrees, listModes])` (`NewSessionDialog.tsx:43-52`) — else a branch-fetch
  reject breaks worktree/mode loading and defeats graceful degradation.
- **(H2)** `LeftSidebar.tsx:534` conditionally renders the dialog → it **unmounts on close**, so
  `useState` resets naturally. No "reset-on-open" logic needed for the app; relevant only if a test
  toggles `open` on a persistent mount.
- **(M5)** Always coerce `baseBranch` to a value that exists in the rendered `<option>`s (default
  if present in list, else first branch) to avoid a controlled-`<select>` value/option mismatch.
- **(B3)** `Dialog.test.tsx` already exists (3 tests). New focus chain must keep them green; with a
  buttons-only dialog, focus now lands on the card (`tabIndex={-1}`) — `dlg.contains(activeElement)`
  still true since `contains` includes self. Audit `ConfirmDialog`/`NewModeDialog` etc.: their
  initial focus shifts from "first button" to "the card" (Enter no longer auto-confirms) — acceptable
  and arguably safer, but noted.

## Files to modify

| File | Change |
|------|--------|
| `daemon/src/services/git.ts` | Add `listBranches(repoPath)` helper (~`:91`, after `branchExists`); single-quote `--format` |
| `daemon/src/routes/projects.ts` | Add `GET /projects/:projectId/branches` handler in `registerProjectRoutes` |
| `web-ui/src/api/types.ts` | Add `ProjectBranchesResponse` interface |
| `web-ui/src/api/client.ts` | Add `listProjectBranches()` (~`:204`, near `listWorktrees`) |
| `web-ui/src/api/mock.ts` | **(B1)** Add `listProjectBranches()` returning per-project branches + default |
| `web-ui/src/components/dialogs/NewSessionDialog.tsx` | Branch `<Select>` + separate-catch fetch + error/empty fallback; default state `""`; `data-autofocus` on branch input |
| `web-ui/src/components/dialogs/Dialog.tsx` | Split effect; stable keydown via ref; focus-once on open; `[data-autofocus]`-first focus target; card `tabIndex={-1}` |
| `web-ui/src/components/dialogs/NewSessionDialog.test.tsx` | Update payload assertion; add branch selector + error fallback tests |
| `web-ui/src/components/dialogs/Dialog.test.tsx` | **Exists** — add focus-once + autofocus-target tests; keep existing 3 green |

## Risks

| Risk | Mitigation |
|------|-----------|
| `git branch --list` slow on huge repos | Local-only, fast; runs once on dialog open; show loading state |
| Endpoint fails (offline daemon / non-repo) | Graceful fallback to free-text Input; surface error inline |
| Focus refactor breaks Tab focus-trap or Escape | Keep `handleKeyDown` logic identical; only change *when* effects run; covered by tests |
| Default branch not in branch list (detached/edge) | Fall back to first branch, else free-text |
| `replace_all`/state reset between opens | Reset branch state on `open` transition so a second open re-fetches |

---

## Implementation phases

### Phase 1 — Backend branch endpoint
- [ ] 1.1 Add `listBranches(repoPath): Promise<string[]>` to `git.ts` using
      `git branch --list --format=%(refname:short)`, splitting/filtering empty lines.
- [ ] 1.2 Add `GET /projects/:projectId/branches` to `projects.ts`: 404 (no project), 400 (not a
      repo), else `{ branches, defaultBranch }` with `detectDefaultBranch ?? project.defaultBranch`.
- **1.T1** `curl localhost:<port>/projects/<id>/branches` returns real branches + correct default.
- **1.T2** `curl` a bad project id → 404; a non-repo project → 400 with clear `error`.

### Phase 2 — Frontend API client
- [ ] 2.1 Add `ProjectBranchesResponse` to `types.ts`.
- [ ] 2.2 Add `listProjectBranches(projectId)` to `client.ts`.
- **2.T1** `npm run typecheck` (web-ui) passes.

### Phase 3 — Branch selector in dialog
- [ ] 3.1 Change `baseBranch` initial state to `""`; add `branches`, `branchesError` state.
- [ ] 3.2 In on-open effect, fetch branches; set default; handle reject → `branchesError`.
- [ ] 3.3 Render `<Select>` of branches when loaded & non-empty; free-text `<Input>` fallback
      when error or empty; reset state when `open` toggles.
- [ ] 3.4 Keep submit payload unchanged (`baseBranch.trim() || undefined`).
- **3.T1** Dialog shows a dropdown listing the project's branches; default = detected default.
- **3.T2** With daemon offline / non-repo, dialog falls back to free-text input and still submits;
      error message shown inline.
- **3.T3** Existing-worktree flow unaffected (no base branch field shown).

### Phase 4 — Dialog focus-steal fix
- [ ] 4.1 Add `onCloseRef`, update each render; make `handleKeyDown` stable via `useCallback([])`
      reading `onCloseRef.current`.
- [ ] 4.2 Split into keydown-listener effect and auto-focus effect (`[open]` only).
- [ ] 4.3 Auto-focus priority: `[data-autofocus]` → first non-button `input/select/textarea` →
      card (`tabIndex={-1}`). Never the Close button.
- [ ] 4.4 Tag the branch name `<Input>` in `NewSessionDialog.tsx` with `data-autofocus`.
- **4.T1** New `Dialog.test.tsx`: open Dialog, focus a child input, then re-render with a NEW
      `onClose` identity repeatedly → focus stays on that input (does NOT jump to Close button).
- **4.T2** `Dialog.test.tsx`: on open, `[data-autofocus]` element receives focus; Escape calls the
      *current* `onClose` (not a stale one); Tab from last focusable wraps to first.
- **4.T3** Manual: open dialog with a background agent streaming; type in branch field — focus
      stays put, Close button never gains focus; on mobile the keyboard stays up.

### Phase 5 — Full verification
- [ ] 5.1 `npm run typecheck` + `npm run lint` + `npm test` in `web-ui`.
- [ ] 5.2 Daemon typecheck/test.
- **5.T1** All suites green; manual smoke of new-worktree creation with a non-`main` default.

---

## Open questions

- Should the branch list also include remote-only branches (e.g. `origin/feature-x`)? Plan scopes
  to **local branches** only, matching what `worktreeAdd` can branch from without an explicit
  fetch. Server already fetches-on-miss for typed branches, so the free-text fallback still covers
  remote branches. Flag if remote branches should be selectable up front.
