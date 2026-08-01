# Plan: Existing Directory Autocomplete and Git Status Check

This plan details how to add directory autocomplete (suggestions), a dedicated "Browse" directory chooser dialog, and git status check to the "New Agent / New Project" dialog in the `vibe-station` UI.

Reconciled against `.feature-plans/done/project-dialog/opus-review.md` (all B1–B7 / D1–D7 / T1 items addressed or explicitly deferred — see the table in "Review reconciliation" below).

## UI Layout Sketches

### 1. Project Input and Autocomplete Suggestions
The autocomplete suggestions will appear in the combobox dropdown menu directly below the Project input field. A **Browse** button is placed immediately to the right of the input:

```
+-------------------------------------------------------------+
| New Agent                                                   |
+-------------------------------------------------------------+
|                                                             |
|  Project                                                    |
|  +-------------------------------------+ +---------------+  |
|  | ~/projects/                         | |  [📁 Browse]  |  |
|  +-------------------------------------+ +---------------+  |
|  +-------------------------------------+                    |
|  | +  Add existing directory           |                    |
|  |    "~/projects/"                    |                    |
|  |    not yet a vibe-station project   |                    |
|  |-------------------------------------|                    |
|  | SUGGESTED DIRECTORIES               |                    |
|  | 📁 ~/projects/vibe-station          |                    |
|  | 📁 ~/projects/fastestdevalive       |                    |
|  | 📁 ~/projects/react-app             |                    |
|  |-------------------------------------|                    |
|  | USE EXISTING (1)                    |                    |
|  | ▸ vibe-station                      |                    |
|  |   ~/projects/vibe-station           |                    |
|  +-------------------------------------+                    |
|                                                             |
```

### 2. Dedicated Folder Chooser Dialog
Clicking the **Browse** button opens a secondary dialog displaying the host's directory structure:

```
+-------------------------------------------------------------+
| Choose Directory                                         X  |
+-------------------------------------------------------------+
|                                                             |
|  [↱ Up]  [ /home/gb/projects/                            ]  |
|                                                             |
|  +-------------------------------------------------------+  |
|  | 📁 vibe-station                                       |  |
|  | 📁 fastestdevalive                                    |  |
|  | 📁 react-app                                          |  |
|  |                                                       |  |
|  |                                                       |  |
|  +-------------------------------------------------------+  |
|  Showing the first 50 entries — type more to narrow (if capped) |
|  Selected: /home/gb/projects/vibe-station                  |  |
|                                                             |
|                                         [Cancel] [Select]   |
+-------------------------------------------------------------+
```

---

## Checklist

- [x] **Phase 1: Backend Endpoint & Types**
  - [x] Implement `GET /fs/check` in `daemon/src/routes/fs.ts` with full validation (null bytes, absolute path check, `expandTilde` reuse, no 500s).
  - [x] Support file vs. directory detection (return `{ exists: true, isDirectory: false }` for files).
  - [x] Export `FsCheckResponse` interface in `web-ui/src/api/types.ts` — includes `hasCommits: boolean | null` (B6).
  - [x] Implement `checkFsPath` in `web-ui/src/api/client.ts` and `web-ui/src/api/mock.ts`.
  - [x] Add `hasCommits()` to `daemon/src/services/git.ts` (`git rev-parse --verify HEAD`) so `/fs/check` can report whether an already-git directory has any commits (B6).
  - [x] `/fs/complete` sorts before capping (not after) and returns `truncated: boolean` (D3).
- [x] **Phase 2: Custom Directory Hook & Dialog Fixes**
  - [x] Extract `useDirSuggestions` custom hook in `web-ui/src/hooks/useDirSuggestions.ts` containing the request-id stale guard and unmount timer cleanup. Exposes `truncated` alongside `suggestions` (D3).
  - [x] Implement open-dialogs stack tracking in `Dialog.tsx` to ensure topmost dialog handles Escape and Tab keys (solving the nested Escape-key close bug) (D4).
  - [x] Focus restore to the pre-open active element on close (D4).
  - [x] Per-instance `aria-labelledby`/title id via `useId()` instead of a hardcoded `"dialog-title"` — two simultaneously-open `Dialog`s previously collided on the same DOM id, which broke the accessible name (and `findByRole(..., {name})` lookups) for whichever dialog didn't "win" `getElementById`. Found while writing the D4 regression test.
- [x] **Phase 3: Folder Chooser Modal**
  - [x] Implement `FolderChooserDialog.tsx` under `web-ui/src/components/dialogs/` reusing `useDirSuggestions`.
  - [x] Style the chooser classes in `web-ui/src/styles/workspace.css` with dark/light themes (uses existing CSS custom properties, so both themes are covered without duplication).
  - [x] Hook Up-at-root as a no-op, filter dot-folders by default (typing a dot-prefixed path shows them), and support proper keyboard navigation inside the chooser list (D6 — see below).
  - [x] `//` normalization when descending from `/` (`currentPath + "/"` collapsed via `replace(/\/+/g, "/")`).
  - [x] Surface `truncated` as "Showing the first 50 entries — type more of the name to narrow the list." (D3).
  - [x] Nested-dialog overlay gets a bumped z-index (`.dialog-overlay--nested`) as a paint-order safety net independent of DOM append order (D4 second-order note).
- [x] **Phase 4: Combobox Autocomplete Integration**
  - [x] Add the `Browse` button next to the project input field in `NewAgentDialog.tsx`.
  - [x] Integrate path suggestions into the `ProjectRow` model and `rows` flat array.
  - [x] Render combobox directly from `rows` (map over `rows`, use its index directly for `id`/`aria-selected`) instead of re-deriving indices from `filteredProjects` — eliminates the B1 desync class of bug entirely rather than just computing the offset correctly in two places.
  - [x] Update `selectProjectRow` to handle `path-suggestion` selection: update query path (append trailing separator), fetch suggestions immediately (not debounced — it's a direct user action), keep popup open, reset `activeIndex` to 0, and early return **before** the `setError`/`setBranch`/`setUseWorktree` resets that a genuine row-kind commit performs (B2).
  - [x] `path-suggestion` selection calls `setQuery` directly, not `handleQueryChange` — stays in `"search"` mode rather than fighting the "keep it open" intent via R5's mode-reset (B2).
- [x] **Phase 5: Asynchronous Git Status Checks**
  - [x] Trigger check via `useEffect` debounced (250ms) on `showAddPathRow && trimmedQuery` (option (a) from the review — see B4 below).
  - [x] Render dynamic subtitle on the `Add existing directory` row and separately the full form-hint copy under the input, both driven by one `addPathGitCopy` computation (single source of truth so the two copies can't drift) (B6).
  - [x] Request-id guard (`checkGitReqIdRef`) + debounce-timer cleanup on both mount-unmount and per-effect-rerun (B3).
  - [x] Reset `isGitFolder`/`hasCommits` to `null` whenever the row stops being offered (`!showAddPathRow || !trimmedQuery`), and on a `checkFsPath` failure (B5).
- [x] **Phase 6: Verifying**
  - [x] Write unit/route tests in `daemon/src/__tests__/fs.test.ts` (17 tests — see Verification & Testing below).
  - [x] Write dialog integration tests in `web-ui/src/components/dialogs/NewAgentDialog.path-suggestions.test.tsx` (7 tests) and `FolderChooserDialog.test.tsx` (6 tests).
  - [x] Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` to ensure complete green build (see Verification & Testing).

---

## Technical Approach Details

### 1. Daemon (Backend)
The `GET /fs/check` route validates the path safely (mirrors `/fs/complete`'s existing contract exactly — same null-byte rejection, same 400 shape, same `expandTilde` reuse, never a 500):
```ts
import { hasCommits, isGitRepo } from "../services/git.js";
```
It returns `{ exists: boolean, isDirectory: boolean, isGit: boolean, hasCommits: boolean | null }`, normalizes the path with `expandTilde` once and reuses the same normalized value for both `stat` and `isGitRepo`/`hasCommits`. An existing **file** returns `{ exists: true, isDirectory: false, isGit: false, hasCommits: null }` (not lossy-`false` for `exists`). `hasCommits` is only meaningful when `isGit` is `true` — `null` otherwise (D1, B6).

`isGitRepo` deliberately returns `true` for any *subdirectory* of a repo (matches `routes/projects.ts`'s existing predicate exactly, so the hint and the actual registration behavior never diverge) — locked in by a dedicated test (B7). The copy in §4 below avoids implying the checked directory is the repo *root*.

`/fs/complete` now sorts the name-filtered dirent list **before** slicing to `MAX_ENTRIES`, not after (sorting is cheap — string compares only, no extra `stat()` calls — so the "cap before statting symlinks" perf property is preserved). It also returns `truncated: boolean` so a full-listing UI (the Browse dialog) can tell the user results are incomplete rather than silently omitting entries past the cap (D3).

### 2. Nesting Dialogs & Escape Key Stack
We keep a module-level stack `openDialogs: (() => void)[]` in `Dialog.tsx`.
When the dialog opens, it pushes its close callback (inside a `useEffect` gated on `open`, so a `Dialog` mounted-but-closed contributes nothing to the stack). The keydown listener checks:
```ts
if (openDialogs[openDialogs.length - 1] !== closeFn) return; // not topmost — ignore
if (e.key === "Escape") { e.stopPropagation(); closeFn(); }
```
The same guard applies to the Tab-trap handler, so a background dialog's focus trap can't fight the foreground one either (D4).

Focus is restored to whatever was focused immediately before the dialog opened, once it closes (`setTimeout(…, 0)` after the portal unmounts).

**Caveat validated in testing:** this ordering is correct for the realistic sequence — a host dialog (e.g. New Agent) is already open, and a nested dialog (Folder Chooser) transitions from `open=false` to `open=true` later, in response to a user action. Its `push` therefore always happens strictly after the host's. If two `Dialog`s were ever mounted with `open=true` on the *very same* render (not how this feature uses it — `FolderChooserDialog` always starts closed), React's child-before-parent effect ordering would push the nested one first and the host would incorrectly end up "on top." Not a risk for this feature; worth remembering before reusing the stack for a different nesting pattern.

Each `Dialog` now generates its own `aria-labelledby` id via `useId()` by default (falls back to a caller-supplied `ariaLabelledBy` prop, unused today) instead of a shared hardcoded `"dialog-title"` — required once two `Dialog`s can be in the DOM simultaneously, or `getElementById("dialog-title")` resolves to whichever one happens to be first in document order, breaking the other's accessible name.

### 3. Suggestions and Mapping
The flat array `rows` in `NewAgentDialog` looks like:
```ts
const rows: ProjectRow[] = useMemo(() => {
  const list: ProjectRow[] = [];
  if (showLeadingRow) {
    if (showAddPathRow) {
      list.push({ kind: "add-path" });
      for (const entry of pathSuggs.suggestions) {
        list.push({ kind: "path-suggestion", entry }); // sits directly after add-path, before USE EXISTING
      }
    } else {
      list.push({ kind: "create" });
    }
  }
  for (const p of filteredProjects) list.push({ kind: "existing", project: p });
  return list;
}, [showLeadingRow, showAddPathRow, pathSuggs.suggestions, filteredProjects]);
```
The popup renders by mapping over `rows` directly — `idx` in `rows.map((row, idx) => …)` is used verbatim for `id`, `aria-selected`, and the `onMouseEnter`/`onMouseDown` handlers, so the keyboard model (`activeIndex` into `rows`) and the rendered options can never desync (B1). Group headers ("SUGGESTED DIRECTORIES" / "USE EXISTING (n)") are derived per-row by checking whether the *previous* row was the same kind, so they appear exactly once, at the right boundary, with zero extra bookkeeping.

`selectProjectRow` early-returns for `row.kind === "path-suggestion"` **before** any of the `setError(null)` / `setBranch("feature")` / `setUseWorktree(false)` resets that a genuine row commit (`create` / `add-path` / `existing`) performs — clicking a suggestion only updates `query` (with a trailing separator appended) and immediately fetches the next level of suggestions, resets `activeIndex` to 0, and leaves `mode` alone (B2).

### 4. Git setup description copy (B6)
Copy is computed once per render (`addPathGitCopy` in `NewAgentDialog.tsx`) and used for both the row subtitle and the full form-hint, so the two can't drift apart:

| State | Subtitle (row) | Form hint (below input) |
|---|---|---|
| Checking | "Checking directory git status…" | same |
| Not a git repo | "Not yet a vibe-station project (will initialize git)" | "ⓘ Registers this directory, runs git init, adds a .gitignore, and makes an initial commit of the directory's current contents." |
| Git repo, has commits | "Git repository detected" | "ⓘ Registers this directory as a project (git repository detected)." |
| Git repo, **no** commits yet | "Git repository detected (no commits yet)" | "ⓘ Registers this directory as a project. It's already a git repository with no commits yet, so an initial commit of its current contents will be made." |
| Unknown / check failed | "not yet a vibe-station project" | "ⓘ Registers this directory and sets up git (init + .gitignore) if not already present." (generic fallback) |

This matches what `daemon/src/assets/project-setup.sh` actually does: it writes `.gitignore` only if absent (no clobber), but runs `git add -A && git commit` whenever `HEAD` doesn't resolve — including for an **already-git** directory that just happens to have zero commits. The "has commits" distinction comes from the new `hasCommits` field on `/fs/check`, computed via `git rev-parse --verify HEAD`.

The git-status check effect is keyed on `showAddPathRow && trimmedQuery` (review's option (a)), not on "`mode === 'add-path'` and the query changes" — the latter is unreachable, since editing the input while `mode === "add-path"` snaps `mode` back to `"search"` before the query itself finishes changing (R5 in `handleQueryChange`), so `trimmedQuery` can never be observed to change while `mode` stays `"add-path"`. Because option (a) runs on every keystroke while the row is merely *offered*, it needs (and has) the debounce (250ms — `/fs/check` shells out to `git`, so this is longer than the plain-listing `/fs/complete`'s 150ms) plus the request-id staleness guard (B3).

### 5. Folder Chooser keyboard + ARIA model (D6)
`role="listbox"` on the scroll container, `role="option"` + `aria-selected` on each entry, `aria-activedescendant` tracking the highlighted `id` — same pattern as the existing Project/Directory comboboxes.

- **Click** an entry: selects it (highlight follows, `Selected:` hint updates), does not navigate.
- **Double-click**: descends into the directory (accelerator).
- **ArrowDown / ArrowUp**: move the highlight, wrapping at the ends.
- **Enter / ArrowRight**: descends into the highlighted entry if one is highlighted, otherwise commits the current selection (same as clicking "Select Folder").
- **Backspace / ArrowLeft**: navigates up one level (no-op at `/`).
- **Escape**: closes the chooser only (governed by the `Dialog` stack in §2, not by this list).

### 6. Browse-dialog truncation (D3)
`/fs/complete`'s `MAX_ENTRIES = 50` cap is real (a directory with more children than that is a realistic case — `/usr/lib`, `node_modules`, `/nix/store`) and this plan does not remove it. Instead:
- The daemon sorts by name **before** capping, so the cap always keeps the alphabetically-first 50 rather than an arbitrary `readdir()`-order 50 (previously — before this fix — a target folder past the cut could simply never appear, silently).
- The response carries `truncated: boolean`. `FolderChooserDialog` shows "Showing the first 50 entries — type more of the name to narrow the list." when true, so the limitation is visible instead of silent.
- A dedicated higher-cap listing endpoint was considered and rejected for now — the sort-before-cap fix removes the "wrong folder silently missing" failure mode, which was the actively misleading part; a full redesign of the cap itself is deferred until it's shown to matter in practice.

---

## Review reconciliation (opus-review.md)

| Item | Status |
|---|---|
| B1 — row-index desync | **Fixed** — render directly from `rows`, no re-derived offset |
| B2 — `selectProjectRow` side effects on suggestion rows | **Fixed** — early return before resets; `setQuery` not `handleQueryChange` |
| B3 — stale-response guard / timer cleanup | **Fixed** — `useDirSuggestions`'s request-id + debounce cleanup, and a matching guard on the `checkFsPath` effect |
| B4 — dead effect trigger | **Fixed** — keyed on `showAddPathRow && trimmedQuery` (option (a)) |
| B5 — `isGitFolder` reset rule / failure fallback | **Fixed** — resets to `null` when the row stops being offered or the check errors |
| B6 — hint copy accuracy | **Fixed** — added `hasCommits` to `/fs/check`; four-state copy table above |
| B7 — subdirectory-of-a-repo semantics | **Confirmed intentional**, locked in by a dedicated daemon test; repo-root disambiguation (returning `git rev-parse --show-toplevel`) explicitly deferred — the review flagged it as optional |
| D1 — `/fs/check` contract | **Fixed** — matches `/fs/complete`'s validation contract; file path returns `isDirectory:false` not lossy `exists:false` |
| D2 — debounce ≥250ms | **Fixed** — 250ms, not the 150ms directory-listing debounce; a per-component result cache was considered and skipped as unnecessary at this scale |
| D3 — Browse-dialog truncation | **Fixed** — sort-before-cap + `truncated` flag; `//` normalized; Up-at-root a no-op; hidden dirs filtered by default |
| D4 — nested-dialog Escape | **Fixed** — `openDialogs` stack in `Dialog.tsx`; focus restore on close; found and fixed a related duplicate-`aria-labelledby`-id bug while testing |
| D5 — triplicated directory-listing logic | **Fixed** — `useDirSuggestions` used at all three call sites |
| D6 — chooser keyboard/ARIA model | **Fixed** — see §5 above |
| D7 — `ApiInstance` union / mock parity | **Fixed** — `FsCheckResponse` declared once, implemented identically in `client.ts` and `mock.ts`; mock's git heuristic lets the git-hint branch be tested in mock/demo mode |
| T1 — test plan | **Fixed** — see Verification & Testing below |

---

## Verification & Testing

**Daemon — `daemon/src/__tests__/fs.test.ts`** (17 tests, `GET /fs/check` + `GET /fs/complete`):
- missing / over-4096-char `path` → 400; null byte → 400; relative path → 400
- `~` and `~/subpath` expansion resolve against a mocked `homedir()`
- nonexistent path → 200 `{ exists: false, isDirectory: false, isGit: false, hasCommits: null }` (never 404/500)
- an existing **file** → `{ exists: true, isDirectory: false, isGit: false, hasCommits: null }`
- plain directory → `isGit: false`
- `git init`-ed directory with no commits → `isGit: true, hasCommits: false`
- `git init`-ed directory with a commit → `isGit: true, hasCommits: true`
- a **subdirectory** of a repo → `isGit: true` (locks in B7 as intentional)
- an unreadable ancestor directory never 500s (skipped when running as root, since root ignores permission bits)
- `/fs/complete`: null byte → 400; unreadable directory → empty list, never 500; sort-before-cap keeps the alphabetically-first 50 of 60 entries (`truncated: true`); `truncated: false` when under the cap

**Frontend — `web-ui/src/components/dialogs/NewAgentDialog.path-suggestions.test.tsx`** (7 tests):
- suggestions render between the add-path row and `USE EXISTING`
- **B1 regression**: ArrowDown ×3 then Enter selects the row the highlight is on (not an index-offset row)
- **B2**: picking a suggestion keeps the popup open, appends a trailing separator, and stays in search mode (the input stays a plain combobox, not a project chip)
- **B3**: a slower `fsComplete` response resolving *after* a newer one does not clobber the newer suggestions
- **B5**: the git-detected hint renders, then falls back to the generic copy when `checkFsPath` rejects
- **B5**: the non-git hint matches the honest "runs git init … makes an initial commit" copy
- Browse button opens `FolderChooserDialog`

**Frontend — `web-ui/src/components/dialogs/FolderChooserDialog.test.tsx`** (6 tests):
- lists the initial path's children on open
- double-click descends and lists the new directory's children
- keyboard: ArrowDown highlights, ArrowRight/Enter descends, Backspace goes up
- Up button is disabled (no-op) at the filesystem root
- "Select Folder" calls `onSelect` with the current path and closes
- **D4 regression**: Escape closes only the inner (chooser) dialog when nested inside a host `Dialog`, opened the same way `NewAgentDialog` does (host mounted open, chooser starts closed then flips open later)

**Full build:** `pnpm typecheck && pnpm lint && pnpm test` (`pnpm ci`) — see the session report for the actual pass/fail output; as of this writing all three are green for every file this feature touches (a handful of pre-existing, unrelated `pnpm lint` failures/warnings in `TerminalPane.tsx`, `LeftSidebar.tsx`, `useComposerDraft.ts`, `useStore.test.ts`, and `useWorkspaceUrlSync.ts` predate this branch and are out of scope here).

---

## Outcome (verified 2026-07-25)

**Automated:** `pnpm typecheck` clean. `pnpm test` green — cli 41 files / 444 tests,
web-ui 49 files / 263 tests (707 total). `pnpm lint` has 4 errors + 4 warnings, all
pre-existing on files this branch never touched (`TerminalPane.tsx` is byte-identical
to HEAD; the `FolderPlus` warning is in `LeftSidebar.tsx`).

One trap worth recording: the first cut of `fs.test.ts` used
`vi.mock("node:os", …)` to fake `homedir()`. Because that suite calls
`buildServer()`, re-evaluating the whole route graph under a mocked builtin left
`SUPPORTED_CLIS` undefined for other suites sharing the vitest worker —
`projects.test.ts` and `sessions.test.ts` failed to *collect* with a zod
"Cannot convert undefined or null to object" at `modes.ts:23`. Both pass in
isolation, so the full-suite run is the only place it shows. Fix: relocate `$HOME`
instead (POSIX `os.homedir()` reads it per call) and pass `git commit` an inline
`-c user.name/-c user.email`, since moving `$HOME` also hides the global gitconfig.
**Do not mock `node:os` in a suite that builds the server.**

**Live (dev sandbox, isolated volumes + port 5176):** `GET /fs/check` verified against
a real git repo (`isGit:true, hasCommits:true`), a subdirectory of that repo
(`isGit:true` — the documented B7 behavior), a plain non-git directory
(`isGit:false`), a nonexistent path (`exists:false`, HTTP 200 not 404), an existing
*file* (`exists:true, isDirectory:false`), a relative path (400), and an encoded null
byte (400). `GET /fs/complete` verified for child listing, `~` expansion, and the new
`truncated` flag.

Note: the Vite dev proxy only forwards `/api/*` and `/ws` — reach the daemon at
`http://localhost:<port>/api/fs/check`, not `/fs/check`.
