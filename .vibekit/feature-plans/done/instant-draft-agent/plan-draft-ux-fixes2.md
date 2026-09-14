# Plan — DraftComposer UX fixes (round 2)

**Branch:** create-ui-db  
**Worktree:** /home/gb/.vibe-station/projects/vibe-station/worktrees/vs-131

---

## Bugs (7)

1. **Sidebar/tab slug not shown** — `draftLabel` recomputes from first 5 words of prompt text, ignoring the server-set `session.name` (which uses `slugifyPrompt`). Fix: use `s.name` when non-empty.
2. **New project draft redirects to existing** — race condition: `gotoDraft(id)` navigates before WS `session:created` arrives; CUJ7 guard in `Workspace.tsx` sees session not found → redirects to "/". Fix: 600ms grace period before redirecting.
3. **Different titles under icon** — `entryPoint === "direct"` returns "New direct agent", `"tab"` returns "New agent tab". Fix: always return "New agent".
4. **Project chip has no remove button** — Tier 1 renders `draft-composer__project-chip` without ✕. Fix: render `project-chip` / `project-chip__remove` (same as ProjectCombobox selected chip) with ✕ → calls `onDiscard()`.
5. **Worktree checkbox behaviour wrong** — `worktree` entry skips checkbox and shows New/Existing radio directly; `direct` entry shows checkbox but toggling shows branch fields, not New/Existing radio. Fix: all non-tab entries show "Use worktree" checkbox; when checked → show New/Existing worktree radio; `worktree` entry pre-checked, `direct` entry pre-unchecked.
6. **Terminal selected by default** — prefill at lines 138 & 158: `cfg.channel === "json" ? "json" : "terminal"` defaults to "terminal" when `cfg.channel` is undefined. Fix: default to "json".
7. **Prompt not restored on refresh** — Tier 2 prompt may not reach localStorage before hard refresh if 1200ms debounce hasn't fired. Fix: write to `globalDraft` synchronously on every Tier 2 prompt keystroke.

---

## Phase 1 — CUJ7 race fix (Workspace.tsx only) ✦ Bug 2

**File:** `web-ui/src/routes/Workspace.tsx`

Find the CUJ7 effect (around line 226-240):
```ts
useEffect(() => {
  if (!isDraft || !draftSessionId || !bundleLoaded) return;
  const s = sessions.find((x) => x.id === draftSessionId);
  if (!s) {
    navigate("/", { replace: true });
    return;
  }
  if (s.lifecycleState === "drafting") return;
  ...
}, [isDraft, draftSessionId, bundleLoaded, sessions, navigate]);
```

**Replace** the `!s` branch to add a 600ms grace period instead of immediately redirecting:

```ts
// Outside the component add ref (use useRef):
const notFoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

// In the effect:
useEffect(() => {
  if (!isDraft || !draftSessionId || !bundleLoaded) {
    if (notFoundTimerRef.current) { clearTimeout(notFoundTimerRef.current); notFoundTimerRef.current = null; }
    return;
  }
  const s = sessions.find((x) => x.id === draftSessionId);
  if (!s) {
    // Grace period: WS session:created event may arrive within ~200ms of the
    // HTTP response that triggered this navigation — don't redirect immediately.
    if (!notFoundTimerRef.current) {
      notFoundTimerRef.current = setTimeout(() => {
        notFoundTimerRef.current = null;
        navigate("/", { replace: true });
      }, 600);
    }
    return;
  }
  if (notFoundTimerRef.current) { clearTimeout(notFoundTimerRef.current); notFoundTimerRef.current = null; }
  if (s.lifecycleState === "drafting") return;
  if (s.worktreeId) navigate(`/worktree/${s.worktreeId}`, { replace: true });
  else if (s.projectId) navigate(`/session/${s.id}`, { replace: true });
  else navigate("/", { replace: true });
}, [isDraft, draftSessionId, bundleLoaded, sessions, navigate]);
```

Also add cleanup to a separate `useEffect(() => () => { if (notFoundTimerRef.current) clearTimeout(notFoundTimerRef.current); }, [])` for unmount.

---

## Phase 2 — Title + channel default (DraftComposer.tsx + LeftSidebar.tsx) ✦ Bugs 3, 6

**File A: `web-ui/src/components/draft/DraftComposer.tsx`**

**A1 — Title fix** (lines ~513-521):
```ts
const title = "New agent";
```
(Replace the whole IIFE with just this constant.)

**A2 — Channel prefill default** (lines ~138, ~158):
Change `cfg.channel === "json" ? "json" : "terminal"` to `cfg.channel === "terminal" ? "terminal" : "json"` in BOTH prefill effects (Tier 1 and Tier 2).

**File B: `web-ui/src/components/layout/LeftSidebar.tsx`**

**B1 — Add `channel: "json"` to new draft draftConfigs** — `handleNewWorktree` and `handleNewDirectAgent` both create sessions without specifying `channel`. When prefill runs, undefined channel defaults to terminal. Fix:

In `handleNewWorktree` (line ~948):
```ts
draftConfig: { entryPoint: "worktree", worktreeChoice: "new", channel: "json" },
```

In `handleNewDirectAgent` (line ~967):
```ts
draftConfig: { entryPoint: "direct", channel: "json", useWorktree: false },
```
(Also setting `useWorktree: false` so the checkbox prefills unchecked for direct entries — needed for Phase 3.)

---

## Phase 3 — Project chip + worktree UI (DraftComposer.tsx) ✦ Bugs 4, 5

**File: `web-ui/src/components/draft/DraftComposer.tsx`**

**A — Project chip for Tier 1** (lines ~578-585): Replace the existing Tier 1 project display with the same `project-chip` structure as ProjectCombobox:
```tsx
) : (
  <div className="draft-composer__field">
    <div className="draft-composer__field-label">Project</div>
    <div className="project-chip">
      <span className="project-chip__icon" aria-hidden>◧</span>
      <span className="project-chip__name">
        {projects.find((p) => p.id === session?.projectId)?.name ?? "…"}
      </span>
      <button
        type="button"
        className="project-chip__remove"
        aria-label="Discard and change project"
        onClick={() => { committedRef.current = true; onDiscard(); }}
      >
        ✕
      </button>
    </div>
  </div>
)}
```

**B — Worktree checkbox restructure** — Replace the current two blocks:
1. `{(entryPoint === "global" || entryPoint === "direct") ? <checkbox> : null}` 
2. `{entryPoint === "worktree" ? <New/Existing radio> : null}`

With a unified structure:

```tsx
{/* Use worktree checkbox — all non-tab entries */}
{entryPoint !== "tab" ? (
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

{/* New / Existing worktree radio — shown when Use worktree is checked */}
{entryPoint !== "tab" && useWorktree ? (
  <div className="draft-composer__field">
    <div className="draft-composer__field-label">Worktree</div>
    <Radio
      name="wt-choice"
      label="New worktree"
      checked={worktreeChoice === "new"}
      onChange={() => setWorktreeChoice("new")}
    />
    <Radio
      name="wt-choice"
      label="Existing worktree"
      checked={worktreeChoice === "existing"}
      onChange={() => setWorktreeChoice("existing")}
    />
    {worktreeChoice === "existing" ? (
      <Select
        value={existingWorktreeId}
        onChange={(e) => setExistingWorktreeId(e.target.value)}
        style={{ marginTop: "var(--space-2)" }}
      >
        {worktrees.map((w) => (
          <option key={w.id} value={w.id}>{w.branch}</option>
        ))}
      </Select>
    ) : null}
  </div>
) : null}
```

Also update `showWorktreeFields`:
```ts
const showWorktreeFields = entryPoint !== "tab" && useWorktree && (sessionProject?.isGit ?? true);
```

And fix the branch fields conditional (currently `showWorktreeFields && worktreeChoice === "new"`) — keep as-is since `showWorktreeFields` now captures all cases.

Also update `entryPoint === "worktree"` in `currentConfig` useMemo to not special-case worktree (it already uses `useWorktree`; confirm it does). If there's a separate `if (entryPoint === "worktree") { base.useWorktree = true }` block, remove it and rely on the shared `useWorktree` state.

---

## Phase 4 — Slug labels + prompt persistence ✦ Bugs 1, 7

**File A: `web-ui/src/components/layout/TabsStrip.tsx`**

Line ~610: change `draftLabel(s.draftPrompt)` to `s.name?.trim() || draftLabel(s.draftPrompt)`.

**File B: `web-ui/src/components/layout/LeftSidebar.tsx`**

Lines ~1773, ~1786: change `draftLabel(s.draftPrompt)` to `s.name?.trim() || draftLabel(s.draftPrompt)` for Tier 1 draft rows.
(The global draft row at ~1509 uses `draftLabel(globalDraft.draftPrompt)` — no `name` field on globalDraft, keep as-is.)

**File C: `web-ui/src/components/draft/DraftComposer.tsx`**

In `handlePromptChange`, write to globalDraft synchronously for Tier 2 so a hard refresh doesn't lose unsaved content:
```ts
const handlePromptChange = useCallback(
  (text: string) => {
    setPrompt(text);
    if (!isTier1) {
      // Sync write to localStorage so a hard refresh doesn't lose content
      setGlobalDraft({ draftPrompt: text, draftConfig: currentConfig ?? { entryPoint: "global" } });
    }
    if (prefilledRef.current) scheduleSave();
  },
  [isTier1, currentConfig, setGlobalDraft, scheduleSave],
);
```

---

## Commit strategy

All 4 phases fold into the 2 existing commits:
- Daemon commit: `feat(daemon): drafting lifecycle state, draft session APIs, and bug fixes` (5a7a1ca)
- UI commit: amend `fix(ui): worktree checkbox, project clear, rich chat default, name debounce` (1f2ab48)

After all phases: `git add` the changed files, `git commit --amend --no-edit` on HEAD.
