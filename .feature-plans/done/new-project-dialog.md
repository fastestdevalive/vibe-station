# Mini-Design: New Project Dialog Redesign (single combobox)

> Replace the tabbed New Project dialog with one smart "Project" combobox: type a
> new name (free text) or pick an existing project (chip). Add live filesystem
> directory autocomplete for the create-new "Directory" field.

**Branch:** `revisit-projects` (amend the single squashed commit)
**Status:** Pending
**Mockup:** `.feature-plans/wip/new-project-dialog-mockup.md` (approved)

---

## ⚠️ REVISIONS (post Opus review — these are BINDING and supersede anything below)

- **R1 (was C1) — Keep "add existing directory from disk."** The combobox's "Use
  existing" list only shows *already-registered* projects, so we must not lose the
  ability to register an arbitrary on-disk dir. **Add a third popup affordance:** when
  the typed text is an **absolute path** (`/…` or `~/…`) that is **not** an already-
  registered project, show a row **`＋ Add existing directory "<path>"`** that routes to
  `api.addProject({ path })`. Non-path free text → only Create-new + existing matches.
- **R2 (was I2) — Esc/Enter vs the Dialog.** `Dialog.tsx:37-40` has a **native**
  `document` keydown listener that closes on Escape. When the popup is open, the
  combobox's Esc (close popup only) and Enter (select row, don't submit) must call
  `e.nativeEvent.stopImmediatePropagation()` — React `stopPropagation()` is not enough.
- **R3 (was I3) — `/fs/complete` hardening.** zod: `path` string, `.max(4096)`, reject
  null bytes. Drop "symlink escape" framing (no root to escape). Use
  `readdir(dir,{withFileTypes:true})` + `dirent.isDirectory()`; apply the **cap of 50
  before** statting; only `stat()` symlink dirents (broken symlink → skip). Never read
  files. `readdir` ENOENT/EACCES → `200 { base, entries: [] }`.
- **R4 (was I4) — Dir completion rule (no mid-type flip):** list children **only when
  `path` ends with the path separator**; otherwise prefix-match entries within
  `dirname(path)` by `basename(path)`. (Do NOT auto-descend when the text merely equals
  an existing dir name.)
- **R5 (was I5) — create mode is not a trap:** editing the Project field while in
  `create` mode returns to `search` mode (reopens the popup) so the user can switch to
  an existing project or the add-path row without cancelling.
- **R6 (was I6) — git init is UNCONDITIONAL for create-new.** `POST /projects/create`
  always runs `gitInit` + `createGitignore` regardless of the worktree checkbox
  (`projects.ts:341-343`). So the "creates a git repo — runs `git init`" note must show
  in **create mode generally** (near the Directory field), NOT gated on the worktree
  checkbox. Keep it especially visible when worktree is checked, but the wording must not
  imply git-init only happens with worktree. Do NOT change the daemon's unconditional init.
- **R7 (minor bundle):**
  - Clearing the chip (✕) also nulls `selectedProject` (not just `query`/`mode`).
  - Seed `parentDir` from `defaultProjectsDir` **when settings resolve** (async) and on
    entering create mode — not only at init (avoids empty-dir race).
  - Display `defaultProjectsDir` with `homedir()` collapsed to `~` for the field/preview
    (settings stores an absolute path); send the expanded/real path to the API.
  - Preserve inline name guards (`/`, `\`, leading `.`, `..`) for fast feedback
    (mirror `projects.ts:264-278`), not only the 400.
  - Full combobox ARIA on **both** Project and Directory fields: input
    `role="combobox"` + `aria-expanded`/`aria-controls`/`aria-activedescendant`; popup
    `role="listbox"`, rows `role="option"` + `aria-selected`; "USE EXISTING" is a
    group label, not an option.
  - Existing-mode submit with no agent: `onCreated(project)` is effectively a close
    (project already in sidebar) — acceptable; just close cleanly.

**Reference files:**
- Dialog today (tabbed): `web-ui/src/components/dialogs/AddProjectDialog.tsx`
- Client: `web-ui/src/api/client.ts` (`createProject` :563, `addProject` :213, `getSettings` :545, `listProjects` :207)
- Settings service: `daemon/src/services/config.ts` (`defaultProjectsDir`)
- Project routes: `daemon/src/routes/projects.ts`
- Server registration: `daemon/src/server.ts:132-136`

---

## Problem

- Current dialog uses **tabs** ("Create new" | "Add existing"). User wants **no tabs** —
  a single field where typing suggests existing projects and offers "create new".
- No directory autocomplete; user types the parent dir blind.
- Copy: "Start an agent after creating" too long; worktree note should mention `git init`.

## Out of Scope

- Fuzzy ranking beyond simple substring match on existing projects.
- Remembering recently-used directories (autocomplete is live-fs only).

---

## Concept

- **One combobox "Project" field** with a popup:
  1. `✦ Create new project "<typed>"` — always first row.
  2. `USE EXISTING` — all projects, substring-filtered by typed text.
- **Pick existing → chip** (`◧ name ✕`) in the field. ✕ clears → back to empty text.
- **Commit free text (Enter on Create-new) → create-new mode:** field stays plain text,
  a **Directory** combobox appears (prefilled with `defaultProjectsDir`) + `Will create:` preview.
- **Directory combobox = live filesystem autocomplete** via new `GET /fs/complete`.
- **"Start an agent"** (renamed). Worktree toggle:
  - create-new → FYI `creates a git repo — runs \`git init\` in the project directory`.
  - existing non-git → checkbox **disabled** + note `not a git repo — direct agent only`.

---

## Design Details

### Backend — new filesystem autocomplete endpoint

`GET /fs/complete?path=<partial>` in a new `daemon/src/routes/fs.ts`, registered in `server.ts`.

- **Behavior:** given a partial absolute path, return immediate **child directories** to
  complete against.
  - Resolve leading `~` → `homedir()`.
  - If `path` ends with `/` (or is a dir) → list children of that dir.
  - Else → list children of `dirname(path)` whose name starts with `basename(path)`.
  - Return `{ base: string, entries: { name: string; path: string }[] }` (dirs only,
    absolute `path` per entry), sorted, **capped at 50**.
- **Guards:**
  - Reject non-absolute (after `~` resolution) → `400`.
  - Never return files, never read file contents.
  - `readdir` failures (ENOENT/EACCES) → `200` with empty `entries` (graceful — user is mid-typing).
  - Skip entries that throw on `stat` (broken symlinks).
- **Rationale:** browsing the host FS is inherently sensitive; daemon binds to
  127.0.0.1 and is auth-gated, but keep it read-only + dirs-only + capped.

### Frontend — client method

`web-ui/src/api/client.ts`:
```
fsComplete(path: string): Promise<{ base: string; entries: { name: string; path: string }[] }>
```
Mirror in `web-ui/src/api/mock.ts` (return a small fixed dir list filtered by prefix).
Type in `web-ui/src/api/types.ts`: `FsCompleteResponse`.

### Frontend — dialog rewrite

Rewrite `AddProjectDialog.tsx` (keep the component name + `onCreated` contract so callers
don't change). Remove tabs entirely.

**State model:**
```
mode: "search"            // typing in the Project field, popup open
     | "create"           // committed free-text new name
     | "existing"         // an existing project chosen (chip)
query: string             // Project field text (search + create name)
selectedProject: Project | null
parentDir: string         // create mode; init = defaultProjectsDir
dirSuggest: { open, entries, base }
startAgent, useWorktree, modeId, prompt   // as today
```

**Project field:**
- `mode==="existing"` → render chip (`◧ {name} ✕`); ✕ → clear to `mode:"search"`, `query:""`.
- else → text input; `onChange` sets `query` + opens popup.
- Popup: row 0 = Create-new (`✦ Create new project "{query}"`, subtitle `Creates {defaultProjectsDir}/{query}`);
  section = existing projects filtered `p.name/p.id includes query` (case-insensitive).
- Keyboard: ↑/↓ move highlight across [create-new, ...existing], Enter selects, Esc closes popup.
- Select create-new → `mode:"create"` (keep `query` as the name). Select existing → `mode:"existing"`, `selectedProject`.

**Directory field (mode==="create" only):**
- Combobox: value = `parentDir` (init `defaultProjectsDir`); typing calls `fsComplete(parentDir)`
  (debounced ~150ms) → suggestion list; click fills `parentDir`.
- Hint: `Will create: {parentDir}/{query}`.

**Agent section (both modes):**
- Checkbox label **"Start an agent"**.
- Worktree row:
  - create mode → enabled + FYI: `ⓘ creates a git repo — runs \`git init\` in the project directory`.
  - existing + `selectedProject.isGit === false` → disabled + `not a git repo — direct agent only`.
  - existing + git → enabled, no git-init FYI.

**Submit:**
- create mode → `api.createProject({ name: query, dir: parentDir || undefined, startAgent? })`.
- existing mode → `api.addProject({ path: selectedProject.path })` — but the project already
  exists, so instead **skip add** and directly `onCreated(selectedProject, startAgent?)`
  (existing project needs no re-registration). *(Decision: see Q1.)*
- Button label: create → `Create` / `Create & Start`; existing → `Open` / `Start`.

---

## Files to Modify

| File | Change |
|------|--------|
| `daemon/src/routes/fs.ts` | NEW — `GET /fs/complete` |
| `daemon/src/server.ts` | Register fs routes |
| `web-ui/src/api/types.ts` | `FsCompleteResponse` type |
| `web-ui/src/api/client.ts` | `fsComplete()` |
| `web-ui/src/api/mock.ts` | mock `fsComplete()` |
| `web-ui/src/components/dialogs/AddProjectDialog.tsx` | Full rewrite: single combobox, dir autocomplete, copy |
| `web-ui/src/styles/workspace.css` (or dialog css) | chip + combobox popup styles |

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | FS endpoint exposes host dirs | Read-only, dirs-only, capped, auth-gated, localhost-only |
| 2 | Popup remount / focus loss while typing | Keep field mounted; popup is sibling, not conditional parent |
| 3 | Existing-project "add" that's already registered | Existing selection = already a Project → call onCreated directly, no re-add |
| 4 | Debounce races (stale suggestions) | Track latest request id; drop out-of-order responses |

## Open Questions

1. **Existing selection submit** — since an existing project is already registered,
   selecting it should just open it (and optionally start an agent), NOT call
   `POST /projects`. Confirm we skip re-add. *(Assumed yes.)*
2. **Create-new when name equals an existing project id** — daemon already 409s;
   surface inline. OK.

---

## Implementation Phases

### Phase 1 — Backend: `/fs/complete`
- [ ] **1.1** `daemon/src/routes/fs.ts` — implement per spec (resolve `~`, dirs-only, cap 50, graceful errors)
- [ ] **1.2** Register in `server.ts`
- [ ] **1.3** Client `fsComplete()` + type + mock

**Verify:** `pnpm --filter @vibestation/cli typecheck`; curl `/fs/complete?path=~/` returns dirs.

### Phase 2 — Frontend: dialog rewrite
- [ ] **2.1** Replace tabbed UI with single combobox (create-new + existing sections)
- [ ] **2.2** Chip for existing selection (✕ clears)
- [ ] **2.3** Directory combobox with live `fsComplete` autocomplete (create mode), prefilled `defaultProjectsDir`
- [ ] **2.4** "Start an agent" copy; worktree git-init FYI; non-git-existing disabled note
- [ ] **2.5** Keyboard nav (↑/↓/Enter/Esc); submit routing (create vs existing)
- [ ] **2.6** Chip + popup CSS

**Verify:** `npx tsc --noEmit && npx vitest run`; manual: type→suggestions, pick existing→chip, create-new→dir autocomplete + git-init FYI.
