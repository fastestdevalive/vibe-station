# Plan — Draft Agent UX Fix

**Feature:** draft-agent-ux-fix  
**Branch:** create-ui-db  
**Worktree:** /home/gb/.vibe-station/projects/vibe-station/worktrees/vs-131

---

## Requirements (non-negotiable)

1. **All entry points show the same form UI** — global `/draft/new`, project-level `/draft/:id`,
   worktree-level `/draft/:id`, and inline tab all use identical fields: project combobox, directory
   combobox, branch fields, mode, channel, `AttachmentPicker`. No entryPoint-conditional JSX branches.

2. **The form body is copied verbatim from `NewAgentDialog` (pre-feature commit `e7e1311`)** — every
   helper function, state variable, combobox row, effect, and validation. The only entry-point
   difference is Tier 1 shows a fixed project chip (project already chosen); Tier 2 shows the full
   editable combobox.

3. **Draft prompts survive a page refresh** — the SQLite INSERT at `project-store.ts:261-262` must
   write `draftPrompt` and `draftConfig`; they're already in the schema and mapper but missing from
   the column list.

4. **Multiple drafts per project work** — the mock 409 block at `mock.ts:605-610` must be deleted;
   the dead catch in `DraftComposer.tsx:310-319` must be deleted.

5. **Draft tabs show a "Draft" badge** — `TabsStrip.tsx` must detect `lifecycleState === "drafting"`
   and render the same `<span className="draft-chip">Draft</span>` as the sidebar does.

6. **Agent names come from `slugifyPrompt`** — `sessions.ts:1141-1151` must call
   `slugifyPrompt(draftPrompt)` instead of the hand-rolled 5-word splitter; `nameSource:"user"` must
   be respected (don't overwrite manual renames).

---

## Change Map

```
web-ui/src/
  api/mock.ts                          Phase 1 — delete 409 block
  components/draft/
    DraftComposer.tsx                  Phase 1 (409 catch) + Phase 2 (UI) + Phase 4 (debounce) + Phase 5 (guards)
    ProjectCombobox.tsx                Phase 2 — NEW: extracted project combobox component
    draftComposerHelpers.ts            Phase 2 — NEW: helper functions + types
  components/layout/
    TabsStrip.tsx                      Phase 3 — draft-chip badge
    LeftSidebar.tsx                    Phase 3 — replace private draftLabel with import
  lib/
    sessionLabel.ts                    Phase 3 — extract draftLabel() from LeftSidebar
daemon/src/
  state/project-store.ts               Phase 1 — INSERT bug
  routes/sessions.ts                   Phase 4 — slugifyPrompt, nameSource guard
  services/naming.ts                   (no change — already has slugifyPrompt)
```

### Today vs After

| File | Today | After |
|------|-------|-------|
| `mock.ts:605-610` | Throws 409 when any drafting session exists | Block deleted |
| `DraftComposer.tsx:310-319` | Dead 409 catch → redirect | Block deleted |
| `DraftComposer.tsx:478-636` | 3 entryPoint-conditional branches (Select, Radio, raw input) | Single unified form body from NewAgentDialog |
| `project-store.ts:261-262` | INSERT omits `draftPrompt`, `draftConfig` | Both columns added |
| `TabsStrip.tsx:609-636` | No lifecycleState check, no draft badge | `isDraft` derived, Draft chip rendered |
| `sessionLabel.ts` | Has `sessionLabel()` only | + exported `draftLabel()` |
| `sessions.ts:1141-1151` | 5-word hand-rolled heuristic, overwrites user renames | `slugifyPrompt()`, skips when `nameSource === "user"` |

---

## System Boundaries

| Contract | Side A | Side B |
|----------|--------|--------|
| `PATCH /sessions/:id/draft` body | client `api.updateDraft` (`client.ts:613-624`) | daemon `sessions.ts:1124` — accepts `{ draftPrompt?, draftConfig? }` |
| `session:updated` WS event | daemon broadcasts `name` after every PATCH draft | `TabsStrip.tsx:462-468`, `useServerSync.ts:284` pick up the name |
| `lifecycleState` field | daemon `serializeSession` (`sessions.ts:414-415`) | `Session.lifecycleState` in `types.ts:156` |
| Sessions INSERT | `project-store.ts:261-262` | `sqliteRowMappers.ts:154-155` provides `draftPrompt`, `draftConfig` |

---

## Prefill fields per entry point

| Field | `global` (Tier 2, `/draft/new`) | `direct` (Tier 1, project-level `/draft/:id`) | `worktree` (Tier 1, worktree-level `/draft/:id`) | `tab` (Tier 1, inline tab) |
|---|---|---|---|---|
| Project | Full editable combobox (search / create / add-path / existing rows) | Fixed chip — `session.projectId` resolved at server | Fixed chip — `session.projectId` from `activeWorktree.projectId` | Fixed chip — same as `worktree` |
| Directory | Shown only when `selectedMode === "create"` or `"add-path"` (new project path) | Hidden | Hidden | Hidden |
| Worktree choice | `useWorktree` checkbox | N/A | Radio: new / existing | N/A (always new) |
| Branch / base branch | Shown when `useWorktree === true` | Shown always | Shown when `worktreeChoice === "new"` | Hidden |
| Mode | Shown | Shown | Shown | Shown |
| Channel | Shown | Shown | Shown | Shown |
| AttachmentPicker | Shown | Shown | Shown | Shown |

**Tier 1 prefill source:** `session.draftPrompt`, `session.draftConfig` (loaded once via `prefilledRef`, `DraftComposer.tsx:121-137`).  
**Tier 2 prefill source:** `globalDraftStore` (loaded once via `prefilledRef`, `DraftComposer.tsx:139-156`).

**Tier 2 → Tier 1 auto-upgrade:** When the user selects an existing project in the Tier 2 combobox,
`handleSelectProject` (`DraftComposer.tsx:295-310`) calls `api.createDraftSession` and navigates to
`/draft/:id`, becoming a Tier 1 session. The combobox is therefore transient — it only shows for
`/draft/new` before a project is chosen. This behavior is preserved as-is.

---

## Phase 1 — Bug fixes (daemon + mock) `[ ]`

- `[ ]` **1.1** `daemon/src/state/project-store.ts:261-262` — add `draftPrompt, draftConfig` to
  the INSERT column list; add `@draftPrompt, @draftConfig` to the VALUES list.
  ```sql
  INSERT INTO sessions (id, ..., prBranch, draftPrompt, draftConfig)
  VALUES (@id, ..., @prBranch, @draftPrompt, @draftConfig)
  ```

- `[ ]` **1.2** `web-ui/src/api/mock.ts:605-610` — delete the 5-line 409 block (`if (existingDraft)`
  check + throw); leave line 604 (`const projectId = ...`) intact.

- `[ ]` **1.3** `web-ui/src/components/draft/DraftComposer.tsx:310-319` — delete the dead
  `catch (e)` block that calls `navigate(\`/draft/${existingId}\`)`.

- `[ ]` **1.T1** Verify: in the sandbox at `http://localhost:7131`, create two draft agents for
  the same project — both should open without being redirected to the first.

- `[ ]` **1.T2** Verify: type a prompt in a draft, reload the page — the prompt text must still
  be present (requires the daemon to be rebuilt in the sandbox).

---

## Phase 2 — DraftComposer UI unification `[ ]`

### Source reference

All code to copy lives in `e7e1311:web-ui/src/components/dialogs/NewAgentDialog.tsx` (1623 lines).
Retrieve it with:
```bash
git show e7e1311:web-ui/src/components/dialogs/NewAgentDialog.tsx
```

### 2a. Extract helpers and combobox into shared files (mandatory — file-size guardrail)

NewAgentDialog is 1623 lines; DraftComposer is currently 747 lines. Inline copy would create a
~1500-line file. Extract into two new files before merging:

- `[ ]` **2.1** Create `web-ui/src/components/draft/draftComposerHelpers.ts` — copy these
  exactly from `e7e1311` `NewAgentDialog.tsx` lines 1-140:
  - Types: `Mode_` (line 25), `ProjectRow` (lines 27-32)
  - Functions: `isAbsoluteQuery` (33), `expandHome` (38), `normalizePath` (50),
    `matchesQuery` (54), `validateProjectName` (81), `validateBranchName` (108),
    `uniqueBranchName` (126), `errorMessage` (135)
  - Export all of them.

- `[ ]` **2.1b** Create `web-ui/src/components/draft/ProjectCombobox.tsx` with this interface:
  ```tsx
  interface ProjectComboboxProps {
    api: ApiInstance;
    projects: Project[];
    settings: Settings | null;
    onSelectExisting: (p: Project) => void;   // user picked an existing project
    onNewName: (name: string, parentDir: string) => void;  // user typed a new project name
    onAddPath: (path: string) => void;        // user typed an absolute path (add-path flow)
  }
  ```
  Move INTO `ProjectCombobox.tsx` from NewAgentDialog:
  - All project combobox state (lines 153-168): `mode`, `query`, `selectedProject`,
    `popupOpen`, `activeIndex`, `projectWrapperRef`, `pathSuggs` (useDirSuggestions),
    `dirChooserOpen`
  - All directory combobox state (lines 170-177): `parentDir`, `defaultProjectsDir`,
    `homeDir`, `parentDirSuggs`, `dirPopupOpen`, `dirActiveIndex`, `dirWrapperRef`
  - Git check state (lines 179-187): `isGitFolder`, `hasCommits`, `checkingGit`,
    `checkGitReqIdRef`, `checkGitDebounceRef`
  - Settings load + default dirs effect (lines 218-255): loads `api.listProjects()`,
    `api.listModes()`, `api.getSettings()` — **keep only** projects + settings; modes are
    already loaded in DraftComposer
  - Outside-click effect for project popup (lines 382-392)
  - Outside-click effect for dir popup (lines 393-403)
  - Git check effect (lines 445-486): calls `api.checkFsPath(expandedPath)` (NOT checkGit)
  - Derived values: `trimmedQuery` (412), `findRegisteredProject` (419), `alreadyRegistered`
    (427), `showAddPathRow` (431), `showLeadingRow` (435), `filteredProjects` (487),
    `rows` useMemo (491-509)
  - Handlers: `adoptPath` (522), `selectProjectRow` (564), `handleQueryChange` (596),
    `handleProjectKeyDown` (618), `handleParentDirChange` (651), `selectDirEntry` (664),
    `handleDirKeyDown` (671)
  - Derived: `dirDisplay`, `willCreatePath`, `createNameValid`, `showConfig` (lines 703-714)
  - The entire project + directory combobox JSX (read from `e7e1311` lines ~880-1100)
  - `FolderChooserDialog` (already imported in NewAgentDialog)
  - Call the appropriate callback (`onSelectExisting`, `onNewName`, `onAddPath`) at the
    point where NewAgentDialog called `setMode("existing")` / transitioned out

### 2b. Add imports to DraftComposer.tsx

- `[ ]` **2.2** Add to `DraftComposer.tsx`:
  ```tsx
  import { useId } from "react";
  import type { Settings } from "@/api/types";
  import { AttachmentPicker } from "../chat/AttachmentPicker";
  import { ProjectCombobox } from "./ProjectCombobox";
  import type { Mode_ } from "./draftComposerHelpers";
  ```
  Remove: `attachInputRef` ref, `import { Select }` (keep it — still used for mode/channel),
  the old raw `<input type="file">`.

### 2c. Add state for new-project info in DraftComposer (Tier 2 only)

- `[ ]` **2.3** Add — these receive the output from `ProjectCombobox` callbacks:
  ```tsx
  // Tier 2: tracks what the combobox has resolved
  const [comboMode, setComboMode] = useState<Mode_>("search");  // "create"|"add-path"|"existing"
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectParentDir, setNewProjectParentDir] = useState("");
  const [newProjectAbsPath, setNewProjectAbsPath] = useState(""); // for add-path flow
  const [settings, setSettings] = useState<Settings | null>(null);
  ```
  Load settings on mount (needed for Tier 2 project chip display):
  ```tsx
  useEffect(() => { void api.getSettings().then(setSettings).catch(() => {}); }, [api]);
  ```

### 2d. Update `startTier2NewProject` (DraftComposer.tsx)

- `[ ]` **2.4** The existing `startTier2NewProject` function (around line 390-430 in current
  DraftComposer) receives `selectedProject`/`newProjectName`/`parentDir`. Update its signature
  to also receive `addPath: string | null` for the add-path flow:
  ```tsx
  async function startTier2NewProject(opts: {
    selectedProject: Project | null;
    newProjectName: string;
    parentDir: string;
    addPath: string | null;
  })
  ```
  Handle the three submit flows inside (mirrors `submitCreate`, `submitAddPath`,
  `submitExisting` from NewAgentDialog lines 775-873):
  - `opts.selectedProject` → `submitExisting` path (api.createDraftSession → navigate)
  - `opts.addPath` → `submitAddPath` path (api.createProject with existing path)
  - else → `submitCreate` path (api.createProject with name + parentDir)

### 2e. Replace the JSX form body

- `[ ]` **2.5** Delete the three `entryPoint`-conditional branches at `DraftComposer.tsx:478`,
  `544`, `609`.

- `[ ]` **2.6** Replace with unified form body inside `<div className="draft-composer__fields">`:

  ```tsx
  {/* ── Project field ─────────────────────────────────────────────── */}
  {!isTier1 ? (
    <ProjectCombobox
      api={api}
      projects={projects}
      settings={settings}
      onSelectExisting={(p) => { setSelectedProject(p); setComboMode("existing"); void handleSelectProject(p); }}
      onNewName={(name, dir) => { setNewProjectName(name); setNewProjectParentDir(dir); setComboMode("create"); }}
      onAddPath={(path) => { setNewProjectAbsPath(path); setComboMode("add-path"); }}
    />
  ) : (
    <div className="draft-composer__field">
      <div className="draft-composer__field-label">Project</div>
      <div className="draft-composer__project-chip">
        {/* session.name is the prompt-derived agent name — use the project name instead */}
        <span>{projects.find(p => p.id === session?.projectId)?.name ?? "…"}</span>
      </div>
    </div>
  )}

  {/* ── Worktree / branch fields (worktree entry point) ────────────── */}
  {entryPoint === "worktree" ? (
    <div className="draft-composer__field">
      <div className="draft-composer__field-label">Worktree</div>
      <Radio name="wt-choice" label="New worktree" checked={worktreeChoice === "new"} onChange={() => setWorktreeChoice("new")} />
      <Radio name="wt-choice" label="Existing worktree" checked={worktreeChoice === "existing"} onChange={() => setWorktreeChoice("existing")} />
      {worktreeChoice === "existing" ? (
        <Select value={existingWorktreeId} onChange={e => setExistingWorktreeId(e.target.value)}>
          {worktrees.map(w => <option key={w.id} value={w.id}>{w.branch}</option>)}
        </Select>
      ) : null}
    </div>
  ) : null}

  {/* ── Branch fields ──────────────────────────────────────────────── */}
  {showWorktreeFields && worktreeChoice === "new" ? (
    <div className="draft-composer__field">
      <div className="draft-composer__field-label">Branch <span>(optional)</span></div>
      <Input aria-label="Branch" placeholder="auto-generated from your prompt if left blank" value={branch} onChange={e => setBranch(e.target.value)} />
      <div className="draft-composer__field-label">Base branch</div>
      {branches.length > 0
        ? <Select value={baseBranch} onChange={e => setBaseBranch(e.target.value)}>{branches.map(b => <option key={b}>{b}</option>)}</Select>
        : <Input aria-label="Base branch" placeholder="main" value={baseBranch} onChange={e => setBaseBranch(e.target.value)} />}
    </div>
  ) : null}

  {/* ── Mode ───────────────────────────────────────────────────────── */}
  <div className="draft-composer__field">
    <div className="draft-composer__field-label">Mode</div>
    <div className="draft-composer__mode-row">
      <Select aria-label="Mode" value={modeId} onChange={e => setModeId(e.target.value)}>
        {modes.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </Select>
      <button type="button" className="draft-composer__new-mode" onClick={() => setNewModeOpen(true)}>+ New mode</button>
    </div>
  </div>

  {/* ── Channel ────────────────────────────────────────────────────── */}
  {/* (keep existing channel radio group verbatim — no change needed) */}

  {/* ── Attachments — replaces raw <input type="file"> in bottom bar ─ */}
  <div className="draft-composer__field">
    <div className="draft-composer__field-label">Attachments</div>
    <AttachmentPicker files={files} onChange={setFiles} />
  </div>
  ```

- `[ ]` **2.7** Remove from the bottom bar: `attachInputRef`, raw `<input type="file" multiple>`,
  and the `📎` emoji button.

- `[ ]` **2.8** Update the `handleStart` function — when Tier 2 and `comboMode !== "existing"`,
  call `startTier2NewProject({ selectedProject, newProjectName, newProjectParentDir, addPath: comboMode === "add-path" ? newProjectAbsPath : null })`.

- `[ ]` **2.T1** TypeScript clean: `pnpm -C web-ui tsc --noEmit` — zero errors.
- `[ ]` **2.T2** Open `/draft/new` in sandbox — `ProjectCombobox` renders; type a project name,
  popup shows create/add-path/existing rows; type an absolute path, see add-path row.
- `[ ]` **2.T3** Open a Tier 1 draft (worktree or project entry point) — fixed project chip shows
  the *project* name (not the agent name); all other fields (worktree, branch, mode, channel,
  attachments) render identically regardless of entry point.
- `[ ]` **2.T4** Attach a file via `AttachmentPicker` in the form body — chip appears; no 📎 emoji
  button visible in the bottom bar. Start the agent — file is delivered as the first turn.

---

## Phase 3 — Draft tab badge `[ ]`

- `[ ]` **3.1** `web-ui/src/lib/sessionLabel.ts` — add and export `draftLabel`:
  ```ts
  /** Sidebar/tab label for a draft: first 5 words of prompt, or a placeholder. */
  export function draftLabel(prompt?: string | null): string {
    if (!prompt || !prompt.trim()) return "New agent…";
    return prompt.trim().split(/\s+/).slice(0, 5).join(" ");
  }
  ```

- `[ ]` **3.2** `web-ui/src/components/layout/LeftSidebar.tsx:150-153` — replace the private
  `draftLabel` function with an import from `sessionLabel.ts`.

- `[ ]` **3.3** `web-ui/src/components/layout/TabsStrip.tsx:609` — derive `isDraft`:
  ```tsx
  const isDraft = s.lifecycleState === "drafting" || s.state === "drafting";
  const label = isDraft ? draftLabel(s.draftPrompt) : sessionLabel(s);
  ```

- `[ ]` **3.4** Add `data-draft={isDraft ? "true" : undefined}` to the tab `<button>` (alongside
  `data-active`, `data-archived` near line `:624`).

- `[ ]` **3.5** Render the draft badge inside the tab label span next to the archived badge
  (`:741` neighborhood):
  ```tsx
  {isDraft ? <span className="draft-chip">Draft</span> : null}
  ```

- `[ ]` **3.T1** Verify: open a worktree, click "+" to create a draft tab — the tab renders
  "New agent…" label with a "Draft" chip matching the sidebar pill style.
- `[ ]` **3.T2** Type a prompt and pause — the tab label updates to the first 5 words (via
  `session:updated` WS after the 2000ms debounced PATCH, once Phase 4 is applied).

---

## Phase 4 — Slugified name heuristic `[ ]`

- `[ ]` **4.1** `daemon/src/routes/sessions.ts` — add import at top:
  ```ts
  import { slugifyPrompt } from "../services/naming.js";
  ```

- `[ ]` **4.2** `sessions.ts:1141-1151` — replace the 5-word heuristic. `slugifyPrompt` returns
  a **hyphen-joined branch slug** (`"implement-login-screen"`); convert to a display name with
  spaces:
  ```ts
  // Before
  const words = draftPrompt.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length > 0) derivedName = words.join(" ");

  // After
  const slug = slugifyPrompt(draftPrompt, 5);  // maxWords=5, maxLen=60
  derivedName = slug ? slug.replace(/-/g, " ") : null;
  ```

- `[ ]` **4.3** Guard against overwriting user-renamed sessions — compute `shouldRename` **before**
  `mutateProject`, then gate the DB write, the broadcast, **and** the reply:
  ```ts
  const shouldRename = !!derivedName && ctx.session.nameSource !== "user";
  // In mutateProject — both worktree and direct branches:
  ...(shouldRename ? { name: derivedName!, nameSource: "auto" as const } : {}),
  // In broadcastAll / reply:
  ...(shouldRename ? { name: derivedName } : {}),
  ```
  Note: the existing code uses `s` (not `existing`) as the session variable inside `mutateProject` —
  match the local variable name in context.

- `[ ]` **4.4** `DraftComposer.tsx` — change the save debounce from 300ms to 2000ms so the tab
  name isn't updating on every single keystroke. The existing 300ms `scheduleSave` drives the
  `draftPrompt` persistence; use the same timer but only let it update the name after a 2s gap:
  ```ts
  // Change scheduleSave's timeout:
  saveTimerRef.current = setTimeout(flushSave, 2000);
  ```
  > Note: 2000ms means prompt saves are also 2s delayed — this is acceptable for draft data.
  > If immediate save is required, a second dedicated name timer can be added instead.

- `[ ]` **4.T1** Type a prompt in a draft tab — tab name updates after 2s of no typing.
- `[ ]` **4.T2** Manually rename the draft tab (session rename) — subsequent typing must NOT
  overwrite the user-set name.
- `[ ]` **4.T3** Type "please can you implement the login screen" — expected display name is
  something like "implement login screen" (stopwords filtered by `slugifyPrompt`, hyphens converted
  to spaces), not "please can you implement the".

---

## Phase 5 — Unmount flush guard `[ ]`

- `[ ]` **5.1** `DraftComposer.tsx:270-285` — add `prefilledRef.current` gate to the unmount
  flush to prevent PATCHing `draftPrompt: ""` over a stored value when the component unmounts
  before the session bundle loads:
  ```ts
  return () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (!committedRef.current && latestSaveDataRef.current && prefilledRef.current) {
      const { prompt: p, currentConfig: c } = latestSaveDataRef.current;
      if (c) { /* ... */ }
    }
  };
  ```

- `[ ]` **5.2** Also gate `scheduleSave` itself (not just the unmount flush) — a pre-load
  keystroke can PATCH `draftPrompt: ""` over stored data without unmounting. Add to
  `handlePromptChange` and the config-change effect:
  ```ts
  function handlePromptChange(text: string) {
    setPrompt(text);
    if (prefilledRef.current) scheduleSave();  // skip if session hasn't loaded yet
  }
  // config effect:
  useEffect(() => {
    if (!prefilledRef.current) return;
    scheduleSave();
  }, [currentConfig, scheduleSave]);
  ```
  (The config effect already has `if (!prefilledRef.current) return` at line 262 — just add the
  same guard to `handlePromptChange`.)

- `[ ]` **5.T1** Navigate to a Tier 1 draft, immediately navigate away before the session bundle
  loads — the draft prompt in the sidebar must still show the stored value on the next visit.

---

## Files & Phase Impact

| File | Phase | Lines touched |
|------|-------|---------------|
| `daemon/src/state/project-store.ts` | 1 | 261-262 |
| `web-ui/src/api/mock.ts` | 1 | 604-610 |
| `web-ui/src/components/draft/DraftComposer.tsx` | 1, 2, 4, 5 | 310-319, 478-636, save timer, unmount, scheduleSave |
| `web-ui/src/components/draft/ProjectCombobox.tsx` | 2 | new file — extracted combobox |
| `web-ui/src/components/draft/draftComposerHelpers.ts` | 2 | new file — helpers + types |
| `web-ui/src/lib/sessionLabel.ts` | 3 | +`draftLabel` export |
| `web-ui/src/components/layout/LeftSidebar.tsx` | 3 | 150-153 |
| `web-ui/src/components/layout/TabsStrip.tsx` | 3 | 609-636, 624, 741 |
| `daemon/src/routes/sessions.ts` | 4 | 1141-1151, + import |

---

## Edge cases

- **Empty prompt on unmount (Phase 5):** `prefilledRef.current` gate ensures only post-load unmounts flush.
- **All-stopword prompt (Phase 4):** `slugifyPrompt` has a loose fallback pass; returns `""` if everything is noise — daemon leaves name as-is.
- **User-renamed draft (Phase 4):** `nameSource === "user"` check prevents auto-slug from clobbering the rename.
- **Tier 2 has no session (Phase 4):** no PATCH fires for `/draft/new`; the sidebar already uses `draftLabel(globalDraft.draftPrompt)` — no change needed.
- **Multiple drafts same project (Phase 1):** after mock fix, both `api.createDraftSession` and the real daemon allow concurrent drafts; sidebar renders them as a list (`LeftSidebar.tsx:1004-1013`).
- **Draft tab channel icon (Phase 3):** `session.channel` may be `null` while state is `"drafting"` (session created idle) — the channel icon render at `TabsStrip.tsx:732-740` should guard against null.
