# DraftComposer UI Unification Plan

## Root cause

`DraftComposer.tsx` already has `entryPoint`-based branches (lines 478, 544, 609) that render
**completely different JSX blocks** for global vs worktree vs tab vs direct — different
components, different layout, different styling. That is why the UIs look different.

---

## Requirements (non-negotiable)

1. **Delete all `entryPoint`-conditional JSX branches** — remove the three `if (entryPoint ===
   …)` render blocks and replace with the single unified form body from `NewAgentDialog` on
   `main`.

2. **Copy the entire form body from `NewAgentDialog` (main branch) verbatim** — every state
   variable, every helper function, every combobox row, every effect, every validation. No
   simplifications, no substitutions.

3. **Layout: form body sits between the title and the bottom composer bar** — SkillEditor and
   Start button stay pinned at the bottom. Everything else — project combobox, directory
   combobox, worktree/branch fields, mode, channel, attachments — lives in the scrollable
   body above. The only entry-point difference is: Tier 1 shows a fixed project chip (project
   already chosen); Tier 2 shows the full editable combobox.

4. **Attachments use `AttachmentPicker` as a form field in the body** — remove the raw
   `<input type="file">` + 📎 emoji button from the bottom bar entirely.

---

## Layout (before → after)

```
BEFORE (today)                     AFTER
──────────────────────────────     ──────────────────────────────
[hero / title]                     ┌─ scrollable body ──────────┐
[mode field]                       │ [hero / title]             │
[channel field]                    │ [project combobox]         │  ← copied verbatim
[branch fields]                    │ [directory combobox]       │    from NewAgentDialog
── bottom bar ────────────────     │ [worktree / branch fields] │    (main branch)
[SkillEditor] [📎 raw input] [▶]   │ [mode field]               │
                                   │ [channel field]             │
                                   │ [AttachmentPicker field]   │  ← same as NewAgentDialog
                                   └────────────────────────────┘
                                   ── bottom bar (fixed) ────────
                                   [SkillEditor]            [▶]
```

---

## What to copy

Reference file: `web-ui/src/components/dialogs/NewAgentDialog.tsx` on `main` branch.

Copy **everything** — mechanically, unchanged:
- All imports (`useDirSuggestions`, `FolderChooserDialog`, `AttachmentPicker`, `useId`,
  `Fragment`, `Settings`, helper types `ProjectRow`, `Mode_`)
- All helper functions (`isAbsoluteQuery`, `expandHome`, `normalizePath`, `matchesQuery`,
  `validateProjectName`, `validateBranchName`, `uniqueBranchName`, `errorMessage`)
- All state variables and refs for the combobox, directory combobox, git check, branches
- All effects (settings load, branches load, git check, outside-click, autofocus, etc.)
- All event handlers (`handleQueryChange`, `adoptPath`, `selectProjectRow`,
  `handleProjectKeyDown`, `handleParentDirChange`, `selectDirEntry`, `handleDirKeyDown`,
  `clearSelection`)
- All derived values (`rows`, `filteredProjects`, `canSubmit`, `primaryLabel`,
  `addPathGitCopy`, `showConfig`, `createNameValid`, `showBranchFields`, etc.)
- The entire JSX form body (project field, directory field, divider, agent config section
  with worktree checkbox, branch fields, mode, prompt shell, attachments, channel)
- Submit handlers: `submitCreate`, `submitAddPath`, `submitExisting`, and dispatch in
  `handleStart`

## What stays different (DraftComposer-specific)

- **Bottom bar**: SkillEditor + Start button pinned at bottom (prompt is NOT a form field
  inside the body — it stays in the bottom bar)
- **Tier 1 save loop**: debounced `api.updateDraft`, `committedRef`, `latestSaveDataRef`
  unmount flush — these are unique to DraftComposer and must be kept
- **Tier 1 project display**: when `draftSessionId` is non-null, replace the editable
  combobox with a fixed chip (project already chosen — same chip style as NewAgentDialog's
  `mode === "existing" && selectedProject` chip, but without a clear button)
- **`startTier1`**: promotes the server-persisted draft via `api.startDraft` (already
  implemented, keep as-is including `skipAutoTurn` + `sendJsonFirstTurn`)
- **Discard button**: the ✕ in the top-right corner (Tier 1 only), already present

---

## Bug fixes to include

### Bug 1 — "New draft always opens the existing draft"

**Root cause:** The mock API (`web-ui/src/api/mock.ts:604-610`) throws a 409 when any
`drafting` session already exists for a project. `DraftComposer.tsx:310-319` catches it and
silently redirects to the existing draft. The real daemon has no such limit, but the mock
drives the gallery and sandbox previews.

**Fix (two lines, no new behaviour needed):**
- `web-ui/src/api/mock.ts:604-610` — delete the 409 block; multiple drafts per project are
  already supported by the sidebar (`LeftSidebar.tsx:1004-1013` renders a list).
- `web-ui/src/components/draft/DraftComposer.tsx:310-319` — delete the dead 409 catch +
  redirect block in `handleSelectProject`.

### Bug 2 — "Page refresh wipes all draft prompts"

**Root cause:** The SQLite INSERT in `daemon/src/state/project-store.ts:261-262` omits
`draftPrompt` and `draftConfig` from the column list. The mapper supplies them and the
columns exist in the schema — they just aren't written. On every `mutateProject` call
(including after `PATCH /sessions/:id/draft`) the project is re-read from SQLite, clobbering
the in-memory values with `NULL` immediately.

**Daemon fix (one line):** Add `draftPrompt, draftConfig` to the INSERT column list and
`@draftPrompt, @draftConfig` to the VALUES list at `project-store.ts:261-262`.

**UI fix (guard, one line):** In `DraftComposer.tsx` unmount flush (lines 268-285), add
`if (!prefilledRef.current) return;` before flushing — prevents PATCHing `draftPrompt: ""`
over a stored value when the component unmounts before the session bundle has loaded.

---

## Files to edit

| File | Change |
|---|---|
| `web-ui/src/components/draft/DraftComposer.tsx` | UI unification + 409 catch removal + unmount flush guard |
| `web-ui/src/api/mock.ts` | Delete 409 block (line 604-610) |
| `daemon/src/state/project-store.ts` | Add draftPrompt/draftConfig to INSERT (line 261-262) |

**Why only one file?** The four old dialog files (`NewAgentDialog.tsx`, `NewAgentTabDialog.tsx`,
`NewAgentDirectDialog.tsx`, `NewAgentSessionDialog.tsx`) were already deleted. Every entry
point — global `/draft/new`, project-level `/draft/:id`, worktree-level `/draft/:id`, and
inline worktree tab — now renders the single `DraftComposer` component (verified: two render
sites in `Workspace.tsx` at lines 539 and 709, both pointing to the same component). Fixing
`DraftComposer.tsx` fixes the UI for all four entry points simultaneously.
