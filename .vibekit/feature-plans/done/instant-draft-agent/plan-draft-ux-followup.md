# Plan — DraftComposer UX follow-up fixes

**Branch:** create-ui-db  
**Worktree:** /home/gb/.vibe-station/projects/vibe-station/worktrees/vs-131

---

## Bugs (4)

1. **No worktree checkbox** — `direct` and `global` entry points show no "Use worktree" checkbox; branch fields never appear for those entries. `showWorktreeFields` only covers `worktree` entry.
2. **Can't change project once selected** — `onSelectExisting` immediately calls `handleSelectProject` which navigates away; the chip's ✕ button never has a chance to be clicked.
3. **Rich Chat not default visually** — Terminal radio renders first; despite `channel` state defaulting to `"json"`, Terminal appears to be selected first in visual order.
4. **Agent name doesn't update / slug unclear** — 2000ms debounce is too slow; also the name shows hyphens in the tab because the `.replace(/-/g, " ")` fix needs a sandbox rebuild to take effect (daemon wasn't hot-reloaded).

---

## Phase 1 — Worktree checkbox + project clear `[ ]`

All changes in `web-ui/src/components/draft/DraftComposer.tsx` and `web-ui/src/components/draft/ProjectCombobox.tsx`.

### 1.1 — Add `useWorktree` checkbox to form body

Insert a checkbox field after the project field for `direct` and `global` entry points.
Find the closing `)}` of the `{!isTier1 ? ... : ...}` project block (around line ~554) and add:

```tsx
{/* Use worktree checkbox — global (Tier 2 create flow) and direct (Tier 1 project-level) */}
{(entryPoint === "global" || entryPoint === "direct") ? (
  <div className="draft-composer__field">
    <label className="draft-composer__checkbox">
      <input
        type="checkbox"
        checked={useWorktree}
        onChange={(e) => setUseWorktree(e.target.checked)}
      />
      Use worktree (isolated branch)
    </label>
  </div>
) : null}
```

### 1.2 — Fix `showWorktreeFields`

Current (`DraftComposer.tsx:502-503`):
```ts
const showWorktreeFields =
  entryPoint === "worktree" || (entryPoint === "global" && useWorktree && !!selectedProject?.isGit);
```

Replace with isGit guard per entry point:
```ts
const sessionProject = isTier1
  ? (projects.find((p) => p.id === session?.projectId) ?? null)
  : selectedProject;

const showWorktreeFields =
  (entryPoint === "worktree") ||
  (entryPoint === "direct" && useWorktree && (sessionProject?.isGit ?? true)) ||
  (entryPoint === "global" && useWorktree && (sessionProject?.isGit ?? true));
```

`isGit ?? true` defaults to showing branch fields when git status is unknown (the daemon will reject non-git later).

### 1.3 — Fix `currentConfig` for `direct` entry

In the `currentConfig` useMemo (around `DraftComposer.tsx:212-236`), there is no `else if (entryPoint === "direct")` branch — it falls through with no `useWorktree`/branch fields. Add:

```ts
} else if (entryPoint === "direct") {
  base.useWorktree = useWorktree;
  if (useWorktree) {
    if (branch.trim()) base.branch = branch.trim();
    if (baseBranch.trim()) base.baseBranch = baseBranch.trim();
  }
  base.useTmux = useTmux;
}
```

### 1.4 — Fix branches load effect for `direct`

At `DraftComposer.tsx:182`, change:
```ts
if (entryPoint === "worktree" || (entryPoint === "global" && useWorktree)) {
```
to:
```ts
if (entryPoint === "worktree" || (entryPoint === "direct" && useWorktree) || (entryPoint === "global" && useWorktree)) {
```
Guard with `&& useWorktree` on `direct` to skip the fetch when the checkbox is unchecked.

### 1.5 — Defer navigation to Start click; fix `handleStart` routing

**Step A** — Remove immediate `handleSelectProject` call from `onSelectExisting` (`DraftComposer.tsx:536-539`):
```tsx
onSelectExisting={(p) => {
  setSelectedProject(p);
  setComboMode("existing");
  // do NOT call handleSelectProject here — deferred to Start click
}}
```

**Step B** — `startTier1ForProject` at line ~487 is a stub (just shows an error). Replace it with the actual create+navigate logic that mirrors `handleSelectProject`:
```ts
async function startTier1ForProject(p: Project) {
  setSubmitting(true);
  setError(null);
  try {
    const sess = await api.createDraftSession({
      projectId: p.id,
      draftPrompt: prompt,
      draftConfig: { ...currentConfig, entryPoint: "global" },
    });
    committedRef.current = true;
    navigate(`/draft/${sess.id}`);
  } catch (e) {
    setError(errorMessage(e, "Failed to create draft."));
  } finally {
    setSubmitting(false);
  }
}
```

**Step C** — In `handleStart` (around line ~474), route `comboMode === "existing"` to `startTier1ForProject`:
```ts
if (comboMode === "existing" && selectedProject) return void startTier1ForProject(selectedProject);
```
(Replace the old `startTier1ForProject(selectedProject)` stub call if it exists, or add this branch before the existing Tier 2 path.)

### 1.6 — Add `onClear` prop to `ProjectCombobox`

In `ProjectCombobox.tsx`, add `onClear?: () => void` to the props interface (line ~21), and in `clearSelection` (line ~319), call it:
```ts
function clearSelection() {
  setSelectedProject(null);
  setQuery("");
  setMode("search");
  props.onClear?.();
}
```

In `DraftComposer.tsx`, pass the callback:
```tsx
<ProjectCombobox
  ...
  onClear={() => { setSelectedProject(null); setComboMode("search"); }}
/>
```

- `[ ]` **1.T1** TypeScript clean: `pnpm --filter web-ui typecheck` — zero errors.
- `[ ]` **1.T2** Open `/draft/new` — combobox shows; select a project; chip appears with ✕; clicking ✕ returns to search; user can pick a different project; clicking Start navigates to Tier 1.
- `[ ]` **1.T3** Open a direct-entry draft (`entryPoint === "direct"`) — "Use worktree" checkbox visible, checked by default; unchecking it hides branch fields; re-checking shows branch fields.
- `[ ]` **1.T4** Open a worktree-entry draft — worktree radio shown as before (unaffected).

---

## Phase 2 — Rich Chat first + name debounce `[ ]`

### 2.1 — Swap channel radio order

In `DraftComposer.tsx`, in the channel `role="radiogroup"` (around line ~646), move the Rich Chat label before Terminal:

```tsx
{/* Rich Chat first — it is the recommended default */}
<label className="draft-composer__radio-label" style={{ opacity: jsonSupported ? 1 : 0.5, cursor: jsonSupported ? "pointer" : "not-allowed" }}>
  <input type="radio" name="draft-channel" checked={channel === "json"} disabled={!jsonSupported} onChange={() => setChannel("json")} />
  💬 Rich Chat
</label>
<label className="draft-composer__radio-label">
  <input type="radio" name="draft-channel" checked={channel === "terminal"} onChange={() => setChannel("terminal")} />
  ⌨ Terminal
</label>
```

### 2.2 — Reduce save debounce to 1200ms

Current (`DraftComposer.tsx:~259`): `setTimeout(flushSave, 2000)`.
Change to `1200` — still relaxed enough to avoid per-keystroke PATCHes, fast enough to feel responsive for tab label updates.

- `[ ]` **2.T1** Open any draft — Rich Chat radio is the first radio and visually appears selected by default.
- `[ ]` **2.T2** Type a prompt and pause ~1.5s — tab/sidebar label updates to a slug of the prompt.

---

## Files touched

| File | Phase | Change |
|------|-------|--------|
| `web-ui/src/components/draft/DraftComposer.tsx` | 1, 2 | Checkbox JSX, showWorktreeFields, currentConfig direct, branches effect, onSelectExisting, onClear pass, radio order, debounce |
| `web-ui/src/components/draft/ProjectCombobox.tsx` | 1 | onClear prop + clearSelection call |
