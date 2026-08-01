# Review — `existing-directory-improvements.md`

Reviewer: Claude Opus (vst agent, worktree `vs-26`)
Reviewed against: `NewAgentDialog.tsx`, `daemon/src/routes/fs.ts`, `daemon/src/routes/projects.ts`,
`daemon/src/services/git.ts`, `daemon/src/services/projectSetup.ts`, `daemon/src/assets/project-setup.sh`,
`web-ui/src/components/dialogs/Dialog.tsx`, `web-ui/src/api/{client,mock,types,index}.ts`.

---

## Verdict

**Approach is sound; approve the direction, but the plan is not implementation-ready as written.**

The three features (path autocomplete in the Project combobox, a Browse chooser, an async git-status
hint) are the right shape, correctly scoped, and land in the right layers. The new `/fs/check`
endpoint belongs exactly where the plan puts it.

However there are **four concrete bugs** that will ship if the plan is followed literally (B1, B2, B4,
D4 — one of which silently corrupts keyboard navigation, one of which loses the user's whole form on
`Escape`), **two design decisions that are unmade** (D3, D6), and **copy in §3C that is factually
wrong** about what the daemon actually does (B6). Fix those in the plan before writing code.

**AGENTS.md guidelines: all four are respected.** See [Guideline compliance](#guideline-compliance).
The real risk in this change is elsewhere.

---

## What the plan gets right

- **Layering.** `/fs/check` is a daemon concern; git detection reuses `isGitRepo` from
  `services/git.ts` rather than re-implementing a `.git` stat in the route. Correct.
- **Never 500 on a mid-typing path.** Returning `{ exists: false, … }` instead of a 404 matches the
  established posture of `/fs/complete` (`fs.ts:69-74`), which swallows `ENOENT`/`EACCES` and returns
  an empty list. Keep that.
- **Non-closing selection for suggestion rows** (§3B "Selection logic") is the right interaction —
  step-by-step path descent is exactly how the existing Directory combobox behaves
  (`selectDirEntry`, `NewAgentDialog.tsx:480-484`).
- **Registering the route inside `registerFsRoutes`** means it inherits the same auth gate as
  `/fs/complete` for free. Worth stating explicitly in the plan so nobody "helpfully" moves it.

---

## Blocking issues

### B1 — Row-index desync will break keyboard nav and Enter selection

`rows` (`NewAgentDialog.tsx:362-372`) is the **keyboard model**; the popup render
(`:900-977`) independently re-derives each option's index as:

```tsx
const idx = showLeadingRow ? i + 1 : i;   // :954
```

The plan (§3B "Row mapping" / "Row rendering") extends `rows` with `path-suggestion` entries but
**never mentions `:954`**. Insert three suggestions and every existing-project row's rendered `idx`
is 3 lower than its position in `rows` — so `activeIndex` highlights one row while <kbd>Enter</kbd>
(`:437`, `rows[activeIndex]`) selects a different one, and `aria-activedescendant` (`:884`) points at
the wrong `id`.

Fix: compute the offset once and use it in both places, e.g.

```tsx
const leadingCount = showLeadingRow ? 1 : 0;
const suggestionOffset = leadingCount;                       // suggestions start here
const projectOffset = leadingCount + pathSuggestions.length; // projects start here
```

Better still: render directly from `rows` instead of re-deriving indices from `filteredProjects` —
the duplication is what makes this class of bug possible at all.

The plan also doesn't state **where** in `rows` the suggestions go. The mockup puts them between the
add-path row and `USE EXISTING`. Say so explicitly; the order in `rows` must match render order exactly.

### B2 — `selectProjectRow` applies form side effects to a navigation-only row

`selectProjectRow` (`:378-399`) unconditionally runs `setError(null)`, `setBranch("feature")`,
`setUseWorktree(false)` and ends with `setPopupOpen(false)`. The plan only says "do not close the
popup" — but a `path-suggestion` click must **early-return before all of it**, otherwise clicking a
suggestion silently resets the user's branch name and worktree checkbox.

Also missing from §3B:
- `setActiveIndex(0)` after updating the query. The clamp effect at `:374-376` only prevents
  out-of-range; without an explicit reset the highlight lands on an arbitrary row of the *new* list.
- An explicit statement that `mode` stays `"search"` (don't route this through `handleQueryChange`,
  `:401-407`, which also force-opens the popup and would fight the "keep it open" intent in a
  confusing way — call `setQuery` directly).

### B4 — The git-status effect trigger is nearly dead as specified

§3C says the effect fires "when `mode === "add-path"` **and** the input `trimmedQuery` changes".
But once `mode` is `add-path`, any edit to the input goes through `handleQueryChange` (`:401-407`),
which snaps `mode` back to `"search"` (rule R5). **`trimmedQuery` cannot change while `mode` is
`add-path`** — the effect runs once per row commit and the "changes" clause is unreachable.

Pick one and write it down:

- **(a) Key on `showAddPathRow && trimmedQuery`** — the check runs while the row is still being
  *offered*, so the row's subtitle (`:920`, currently the flat `"not yet a vibe-station project"`)
  can say "git repo detected" too. Better UX, matches the mockup's intent — but now it fires on every
  keystroke and genuinely needs the debounce + request-id guard (see B3, D2).
- **(b) Keep it mode-gated** and drop the debounce entirely, accepting a one-shot check.

(a) is the better feature; (b) is the smaller change. Either is fine — silently shipping the
in-between state described in the plan is not.

### B6 — §3C's hint copy misstates what `setup: true` actually does

`submitAddPath` always sends `setup: true` (`:667`), which runs `runProjectSetup`
(`services/projectSetup.ts:32-44`) → `daemon/src/assets/project-setup.sh`. That script:

- writes `.gitignore` **only if absent** (`[ ! -f .gitignore ]`, line 76) — good, no clobber; but
- when `HEAD` doesn't resolve, it runs `git add -A && git commit` (line 95+), i.e. it makes an
  **initial commit of the user's entire directory contents**.

So:

- `isGitFolder === false` → the proposed *"Registers this directory and sets up git (init +
  .gitignore)"* omits the commit. Honest copy: "…runs `git init`, adds a `.gitignore`, and makes an
  initial commit of the directory's current contents."
- `isGitFolder === true` → the proposed *"Registers this directory as a project (git repository
  detected)"* is **wrong for a repo with no commits**: the same commit-everything path runs there,
  and a `.gitignore` may still be written. Either soften the copy or have `/fs/check` also report
  whether `HEAD` resolves.

Since the entire point of §3C is making this hint accurate, getting it wrong in a new direction is
the one outcome worth avoiding.

*Adjacent pre-existing caveat (out of scope, worth knowing):* the no-`bash` fallback at
`projectSetup.ts:36-41` calls `createGitignore`, which **unconditionally overwrites** an existing
`.gitignore` (`git.ts:161-165`). The script path is safe; the fallback path is not.

---

## Correctness / design concerns

### B3 — No stale-response guard or timer cleanup for `pathSuggestions`

The existing Directory combobox does this correctly: a monotonic request id (`dirReqIdRef`, `:143`,
checked at `:461` and `:465`) plus `clearTimeout` on unmount (`:338-343`). §3B specifies only "a
debounced fetcher" — without the request-id guard, an out-of-order response overwrites newer
suggestions, which is very reachable when descending a slow NFS/large directory. Mirror
`fetchDirSuggestions` (`:457-468`) exactly. Same applies to the `checkFsPath` call in §3C.

### B5 — `isGitFolder` is never reset, and there is no error state

§3C lists four states but no rule for returning to `null`. Without an explicit reset at the start of
each check (and in `clearSelection`, `:409-415`), a stale `true` from the previous path renders
"(git repository detected)" against the *new* path. Also: a 4xx/network failure has no defined
behavior — say explicitly that it falls back to `null` (the generic copy).

### B7 — `isGitRepo` returns `true` for any *subdirectory* of a repo

`git.ts:22-32` resolves via `git -C <dir> rev-parse --git-dir`, which succeeds from any nested
subdirectory. So typing `~/projects/vibe-station/web-ui` reports "git repository detected", the user
is told nothing will be set up — and registering it produces a project whose worktrees branch off the
**parent** repo.

`routes/projects.ts:205` uses the same predicate, so `/fs/check` will at least be *consistent* with
the eventual outcome. Two requirements follow:

1. `/fs/check` **must** import the same `isGitRepo`, not a hand-rolled `.git` stat, or the hint and
   the behavior diverge.
2. Don't let the new copy imply the directory is a repo *root*. Optionally return the resolved repo
   root (`git rev-parse --show-toplevel`) so the UI can warn "this is a subdirectory of the repo at …"
   — that's a genuinely useful signal the current dialog lacks.

### D1 — `/fs/check` contract is under-specified vs. its sibling route

`/fs/complete` (`fs.ts:39-53`) rejects null bytes with a 400, expands `~` via the module-local
`expandTilde` (`:28-35`), and requires absolute-after-expansion. §1 mentions only abs + `~`. Spell out:
same null-byte rejection, same 400 shape, reuse `expandTilde` (already in the file), and never 500.

One contract fix: the plan returns `{ exists: false, isDirectory: false }` for a path that exists but
is a **file**. That's lossy. Return `{ exists: true, isDirectory: false }` so the UI can say "that's a
file, not a directory" — a better message than the daemon's later 400 from
`routes/projects.ts:180-186`.

Also be explicit that the trailing-`/` case is normalized **once** and both `stat` and `isGitRepo`
use the same normalized value — the combobox query will routinely be `/home/gb/projects/`.

### D2 — `/fs/check` shells out to `git`; per-keystroke if B4(a) is chosen

`isGitRepo` spawns up to two `git` processes per call. Combined with B4(a) that's a process spawn per
keystroke. The plan's `stat`-first-then-git ordering already short-circuits non-directories (good) —
add a debounce of ≥250 ms (rather than reusing `DIR_DEBOUNCE_MS = 150`, `:27`) and a small
in-component cache keyed by normalized path.

*Security posture:* this is the same exposure class as the already-shipped `/fs/complete` —
localhost-bound, auth-gated, read-only path probing — so no new category of risk. It does move from a
pure `stat` to *executing git inside a user-named directory* (git reads that directory's
`.git/config`). Fine for a local single-user daemon; the only hard requirement is that it stays
inside `registerFsRoutes` behind the same auth gate.

### D3 — Reusing `/fs/complete` for the Browse dialog silently truncates *(decision needed)*

`fs.ts:79-81` slices to `MAX_ENTRIES = 50` **before** sorting:

```ts
const candidates = dirents
  .filter((d) => prefix === "" || d.name.startsWith(prefix))
  .slice(0, MAX_ENTRIES);      // cap first…
// …
entries.sort(…);                // …sort after
```

For a type-ahead completion that's a deliberate, reasonable trade-off. For a **file browser** it is
actively misleading: a directory with >50 children returns an arbitrary readdir-order 50, *then*
alphabetized — so the folder the user is looking for may simply be absent, with no indication.
§3A ("Lists directories of the current path using `api.fsComplete(currentPath + "/")`") will produce a
chooser that is wrong on `/usr/lib`, `/nix/store`, any large `node_modules` parent, etc.

Pick one:
- add `truncated: boolean` to `FsCompleteResponse` and surface "showing 50 of N — keep typing", or
- add a dedicated listing endpoint with a higher cap and sort-before-cap.

Two smaller bugs in the same section:
- `currentPath + "/"` produces `//` when `currentPath` is `/` (reachable via Up-navigation). The
  daemon tolerates it on Linux, but normalize anyway. Define Up-at-root as a no-op.
- Dot-directories are included when the prefix is empty, so browsing `~` opens with `.cache`,
  `.config`, `.local`… Decide: filter hidden by default plus a "show hidden" toggle is the usual answer.

### D4 — Nested `Dialog`: <kbd>Escape</kbd> will close **both** dialogs

`Dialog.tsx:44-48` attaches its <kbd>Escape</kbd> handler to `document` and calls
`e.stopPropagation()`. Two `Dialog`s mounted simultaneously attach two listeners **to the same
target**, and `stopPropagation` does *not* suppress other listeners on the same element (that would
require `stopImmediatePropagation`). So <kbd>Escape</kbd> inside `FolderChooserDialog` fires both
handlers: the chooser closes **and so does New Agent**, losing the user's entire form.

This is trivially reachable and the plan doesn't mention it. Options, cheapest first:
1. Render the chooser as an inline panel inside the New Agent dialog rather than a second `Dialog`.
2. Add a small "topmost dialog wins" stack in `Dialog.tsx` (a module-level array of open dialog ids;
   only the last one handles `Escape`). Benefits every future nested dialog.
3. Switch the handler to `stopImmediatePropagation` with deliberate registration ordering — fragile,
   not recommended.

Second-order items in the same area:
- The outer `Dialog`'s Tab trap (`:49-65`) queries only its own `cardRef`, and the inner dialog is
  portalled to `document.body` — so it won't capture inner focus. But the outer handler still runs on
  every Tab; verify Tab cycling inside the chooser actually behaves.
- `Dialog` auto-focus (`:79-91`) is keyed on `open` only, so opening the chooser won't steal focus
  from the outer form. On **close**, though, focus is not restored — explicitly return it to the
  Browse button or the Project input.
- Confirm the inner overlay's z-index sits above the outer card.

### D5 — This makes three (soon four) copies of "list directories"

`NewAgentDialog` already owns a complete directory-completion combobox: `parentDir` / `dirEntries` /
`scheduleDirFetch` / `fetchDirSuggestions` / `handleDirKeyDown` / `selectDirEntry`
(`:135-144`, `:450-518`, `:994-1045`). The plan adds a second copy for `pathSuggestions` and a third
inside `FolderChooserDialog`.

Extract one `useDirSuggestions(api)` hook (debounce + request-id + entries + reset) and use it at all
three sites. Otherwise the stale-response guard, the tilde handling, and the R4 trailing-separator
rule *will* drift apart — B3 above is already an instance of that drift appearing in the plan itself.
It also makes it cheap to put the Browse button next to the **Directory** field in create mode, which
the mockup omits but which wants it for exactly the same reason.

### D6 — Browse-dialog interaction model is under-specified *(decision needed)*

> "double-clicking a directory changes the current path, clicking selects it"

`onDoubleClick` fires *after* two `onClick`s, so the selection highlight flickers before navigation.
It's also undiscoverable and unusable on touch. More importantly, **the plan specifies no keyboard
interaction at all** for a new full-screen chooser — that falls below the bar the existing comboboxes
set (`role="combobox"` + `aria-expanded` + `aria-controls` + `aria-activedescendant`, `:881-884`,
`:1002-1005`).

Match the house style: `role="listbox"` / `role="option"` / `aria-selected` /
`aria-activedescendant`; single click selects; <kbd>Enter</kbd> / <kbd>→</kbd> / an explicit chevron
button enters; <kbd>Backspace</kbd> / <kbd>←</kbd> goes up; keep double-click as an accelerator.

### D7 — `ApiInstance` is a union type

`web-ui/src/api/index.ts:8`:

```ts
export type ApiInstance = ReturnType<typeof createMockApi> | ReturnType<typeof createClientApi>;
```

`checkFsPath` must land in **both** `client.ts` and `mock.ts` with *structurally identical*
signatures, or the call site fails to typecheck on the union's call signatures. §2 does say both —
good. Add: declare `FsCheckResponse` once in `web-ui/src/api/types.ts` beside `FsCompleteResponse`
(`:531-536`) and import it in both.

The mock also needs to mirror the daemon's semantics against `MOCK_FS_TREE` — **including** the
`MOCK_HOME` tilde expansion `mock.ts` already does for `fsComplete` — and needs some way to mark mock
directories as git repos. Without that, the git-hint branch is untestable in mock/demo mode, which is
where the a11y and dialog tests run.

---

## Guideline compliance

| AGENTS.md invariant | Status | Notes |
|---|---|---|
| **1. Never unmount `TerminalPane`** | ✅ Not touched | `FolderChooserDialog` is portalled via `Dialog` and lives inside `NewAgentDialog` — nowhere near `Layout.tsx`'s terminal render site. No `key` derivation or conditional tree-branch change reaches `TerminalPane`. **One thing to keep true:** do *not* "solve" D4 by conditionally rendering `NewAgentDialog`'s children in a different tree branch while the chooser is open. Nothing streaming is involved here, but that's precisely the pattern the guideline warns about, and the habit is the point. |
| **2. CLI-specific logic lives in the plugin** | ✅ Respected | `/fs/check` is CLI-agnostic; git detection stays in `services/git.ts`, where the plan puts it. No new `if (cli === …)` branch is introduced anywhere. |
| **3. Serialize `session:open` / `session:close`** | ✅ Not touched | No `stream.attach`/`detach` in scope; no new WS handler. |
| **4. "Rich Chat" in UI, `"json"` in code** | ✅ Not touched | No chat-channel copy in scope. The dialog does render a channel toggle (`channel` state, `:156`) — the plan correctly leaves it alone. If any new copy ends up near it, keep the split: "Rich Chat" in JSX, `"json"` in identifiers. |

The four documented hazards are all clear. The risk in this change is concentrated in B1 (index
desync), B4 (dead effect trigger), D4 (nested-dialog Escape), and D3 (silent truncation).

---

## Testing — §Verifying is too thin

`pnpm lint` / `typecheck` / `test` is necessary but nowhere near sufficient, and
"Add tests in `NewAgentDialog.create-json.test.tsx` or similar if appropriate, **or keep it mocked**"
is not a test plan. Concretely:

**Daemon.** `daemon/src/__tests__/` holds 36 route/service tests but **none for `fs.ts`** — the
completion route shipped untested. Adding an endpoint is the right moment to add
`daemon/src/__tests__/fs.test.ts`:

- missing / over-4096 `path` → 400; null byte → 400; relative path → 400
- `~` expansion resolves to `homedir()`
- nonexistent path → 200 `{ exists: false }` (**not** a 404/500)
- an existing *file* → `{ exists: true, isDirectory: false }` (locks in D1)
- plain directory → `isGit: false`
- `git init`-ed directory → `isGit: true`
- **a subdirectory of a repo → `isGit: true`** (locks in B7 as intentional, not accidental)
- unreadable directory → no 500

**Frontend.** `NewAgentDialog.create-json.test.tsx` is about the JSON channel — don't bolt this on.
Add `NewAgentDialog.path-suggestions.test.tsx`:

- suggestions render between the add-path row and `USE EXISTING`
- **ArrowDown ×N then Enter selects the row the highlight is on** — the direct regression test for B1
- picking a suggestion keeps the popup open, appends a trailing `/`, and leaves `branch` /
  `useWorktree` untouched (B2)
- all four git-hint states render the right copy, plus the failure→`null` fallback (B5)
- a slow `checkFsPath` / `fsComplete` response resolving *after* a newer one does not overwrite it (B3)

**Chooser.** `FolderChooserDialog.test.tsx`, including <kbd>Escape</kbd> closing only the inner
dialog (D4) and keyboard navigation (D6).

---

## Suggested plan edits (minimum bar before implementing)

1. **§3B** — add an explicit index-offset rule covering the render site at `NewAgentDialog.tsx:954`,
   and state where suggestion rows sit in `rows`. *(B1)*
2. **§3B** — state that `path-suggestion` early-returns from `selectProjectRow` before the
   error/branch/worktree resets, and calls `setActiveIndex(0)`. *(B2)*
3. **§3B/§3C** — require a request-id stale guard and unmount timer cleanup, mirroring
   `fetchDirSuggestions`. *(B3)*
4. **§3C** — choose trigger (a) `showAddPathRow`-keyed or (b) one-shot mode-gated, and say which. *(B4)*
5. **§3C** — define the reset-to-`null` rule and the request-failure fallback. *(B5)*
6. **§3C** — rewrite both hint strings to match what `project-setup.sh` actually does, including the
   initial commit. *(B6)*
7. **§1** — full validation contract (null bytes, `expandTilde` reuse, never-500) and
   `{ exists: true, isDirectory: false }` for files. *(D1, B7)*
8. **§3A** — decide the truncation story for the Browse dialog, normalize `//`, define Up-at-root,
   decide hidden-directory handling. *(D3)*
9. **§3A** — specify the full keyboard/ARIA model for the chooser. *(D6)*
10. **New section** — how nested `Dialog` + <kbd>Escape</kbd> is handled, and focus restore on close. *(D4)*
11. **§Verifying** — replace with the concrete test list above. *(T1)*

Optional but recommended: extract `useDirSuggestions` before adding the second and third copy. *(D5)*
