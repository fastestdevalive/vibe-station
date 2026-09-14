# Plan — Draft project select/clear ↔ sidebar sync

**Branch:** create-ui-db
**Worktree:** /home/gb/.vibe-station/projects/vibe-station/worktrees/vs-131

---

## Understanding of the issue

Two entry points into the draft composer, two different bugs:

1. **Global "+ New project" button** (`LeftSidebar.tsx:928` `handleGlobalNewAgent`) creates a
   **Tier 2** draft — local-only (`useGlobalDraftStore`), no `projectId`, no server session.
   Correctly shows "no project selected" (that part is expected). The bug: selecting a project
   in `ProjectCombobox` only sets local React state (`selectedProject`) — nothing is persisted,
   so the draft does **not** move under that project in the sidebar. It only becomes a real,
   project-scoped session (and thus shows under the project) once **Start** is clicked.
   `DraftComposer.tsx:314` already has a `handleSelectProject(p)` function that does the right
   thing — immediately calls `api.createDraftSession({ projectId: p.id, ... })` and navigates to
   the new Tier 1 draft — but it's **dead code**, never wired to `onSelectExisting` (line 552,
   which just does `setSelectedProject(p)` instead). A stale comment at line 492 even claims this
   upgrade already happens on select. It doesn't; it's confused with the real upgrade path
   (`startTier1ForProject`, only reachable from the Start button).

2. **Project-row "+" button** (`LeftSidebar.tsx:938` `handleNewWorktree` /
   `LeftSidebar.tsx:959` `handleNewDirectAgent`) creates a **Tier 1** draft directly, with
   `projectId` set — composer correctly shows the project chip. The chip's "✕" only renders
   when `entryPoint === "worktree"` (`DraftComposer.tsx:573`), and it doesn't clear the
   project at all — it flips `entryPoint` from `"worktree"` to `"direct"` while leaving
   `projectId` untouched (this was intentional in a prior round, for "un-bind from a fresh
   worktree, stay in the project"). That's the "weird" behavior: pressing ✕ never removes the
   project, so the draft never becomes a sidebar sibling — because there is currently no
   "clear project" action on a Tier 1 draft at all.

**Structural constraint that shapes the fix:** a Tier 1 (server-persisted) drafting session is
stored *inside* its project's record (`daemon/src/routes/sessions.ts` — `directSessions`/
worktree `sessions` arrays, keyed by `mutateProject(projectId, ...)`). There is no "project-less"
server-side drafting session — `projectId`/`worktreeId` is required at creation
(`sessions.ts:107`). So "remove the project" on a Tier 1 draft can't be a simple field patch; it
has to **demote back to a Tier 2 (local-only) draft** — mirroring the promote path in bug 1.
This is symmetric with the existing Tier2→Tier1 promote-on-select design, just running the other
direction.

---

## Fix

1. **Wire the dead promote path** (bug 1): `onSelectExisting` in `DraftComposer.tsx:552` should
   call `handleSelectProject(p)` (already correct) instead of just `setSelectedProject(p)`. This
   makes project selection on a Tier 2 draft immediately create the Tier 1 session, so
   `draftsByProject` (`LeftSidebar.tsx:1001`) picks it up and nests it under the project right
   away — no more waiting for Start.

2. **Add a real "clear project" action** (bug 2): give the Tier 1 project chip an unconditional
   ✕ (not gated on `entryPoint === "worktree"`) whose handler:
   - terminates the current Tier 1 session (`api.terminateSession(draftSessionId)` — same call
     `onDiscard` already uses, proven safe on `state: "drafting"`),
   - seeds `useGlobalDraftStore` with the current `prompt`/`currentConfig` (reset
     `entryPoint`/worktree-related fields to Tier 2 defaults),
   - navigates to `/draft/new`.

   This is the literal inverse of `handleSelectProject`, so name it `handleClearProject` and
   place it next to it. The existing "worktree binding" ✕ behavior (demote `worktree` →
   `direct`, keep project) is a **different, still-useful action** — keep it, but move it to a
   separate, clearly-labeled control (e.g. a small "detach worktree" affordance shown only when
   `entryPoint === "worktree"`) so it's not conflated with "remove project" anymore.

3. **Related correctness gap surfaced during investigation** (`ProjectCombobox.tsx:321`
   `clearSelection`): clearing the combobox's own in-progress selection resets
   `selectedProject`/`query`/`mode` but leaves `newProjectName`, `newProjectParentDir`,
   `newProjectAbsPath`, `useWorktree`, `branch`, `baseBranch` stale in the parent
   `DraftComposer`. Not the reported bug, but directly adjacent (same clear affordance,
   same file) and will bite the next person who clears mid-flow. Reset those fields in
   `DraftComposer`'s `onClear` handler (line 561) while we're in this code.

---

## Phase 1 — Wire Tier 2 → Tier 1 promote on project select

**File:** `web-ui/src/components/draft/DraftComposer.tsx`

> Line numbers below are approximate (verified by an opus review pass to be off by ~5-8 from a
> fresh read) — grep for the function/callback names, don't seek by line number blindly.

**Reviewed and corrected `handleSelectProject`** (~line 318). The version already in the file is
missing `draftPrompt` (today it's dead code so nobody noticed — wiring it up as-is would silently
drop whatever the user typed) and never applies the optimistic store update the other two
creation call sites (`startTier1ForProject`, `LeftSidebar.handleNewWorktree/handleNewDirectAgent`)
all do, which is what stops `Workspace.tsx`'s CUJ-7 "session missing → redirect to /" timer from
firing on the remount. Fix in place:

```tsx
async function handleSelectProject(p: Project) {
  setSelectedProject(p);
  setComboMode("existing");
  setNewProjectName("");
  setError(null);
  try {
    const created = await api.createDraftSession({
      target: "direct",
      projectId: p.id,
      type: "agent",
      draftPrompt: prompt,
      draftConfig: { ...currentConfig, entryPoint: "global" },
    });
    useServerStore.getState().applySessionCreated(created);
    clearGlobalDraft();
    navigate(`/draft/${created.id}`);
  } catch (err) {
    setError(errorMessage(err, "Failed to create draft."));
  }
}
```

Drop the `if (p.isGit) setUseWorktree(true)` line — it mutates local state that has no effect on
`currentConfig` (already captured from the current render) and doesn't reach the request body;
it's misleading dead code, not a real default. Keep `setComboMode("existing")` — with it,
`handleStart`'s `comboMode === "existing" && selectedProject` branch stays reachable as the
documented fallback for when `createDraftSession` throws (the composer stays on `/draft/new` and
the user can hit Start manually), so `startTier1ForProject` is a real fallback, not dead code as
the old stale comment claimed.

**Guard against duplicate creates:** `ProjectCombobox` has an auto-adopt effect that can call
`onSelectExisting` from inside a `useEffect`. Wrap the call site so a re-entrant call while a
create is already in flight is a no-op:
```tsx
const selectingRef = useRef(false);
async function handleSelectProject(p: Project) {
  if (selectingRef.current) return;
  selectingRef.current = true;
  try {
    /* body above */
  } finally {
    selectingRef.current = false;
  }
}
```

Change `onSelectExisting` on the `ProjectCombobox` render (~line 560):
```tsx
onSelectExisting={(p) => { setSelectedProject(p); setComboMode("existing"); }}
```
to:
```tsx
onSelectExisting={(p) => { void handleSelectProject(p); }}
```

Also fix the stale comment above `startTier1ForProject` — it currently claims the function is
"effectively unreachable" as if the promote-on-select upgrade already happens; with this phase
landed that becomes true in the happy path, so just say plainly: "fallback path for when
`handleSelectProject`'s create fails — user can still hit Start manually."

Also update `DraftComposer.tsx`'s `onClear` (see Phase 3) while touching this block.

---

## Phase 2 — Real "clear project" action on Tier 1 chip

**File:** `web-ui/src/components/draft/DraftComposer.tsx`

Add `handleClearProject`, next to `handleSelectProject`. **Corrected per opus review:**
navigate/update local state *first*, fire the terminate call *without awaiting it* (mirrors
`LeftSidebar`'s own discard handler, which never awaits before navigating) — awaiting first
leaves a window where the `session:deleted` WS event can land while still on `/draft/:id` and
arm Workspace's CUJ-7 redirect-to-`/` timer. Also strip project-scoped fields out of the
preserved config instead of spreading `currentConfig` wholesale — `existingWorktreeId`,
`worktreeChoice`, `branch`, `baseBranch` are meaningless (or actively wrong, e.g. a `baseBranch`
that doesn't exist in whatever project comes next) once the project is gone, and `useWorktree`
should default to `true` (the file's own default), not `false` — clearing the project doesn't
mean the user no longer wants a worktree:

```tsx
// ── Tier 1, has a project: demote back to a Tier 2 (project-less) draft. ──
function handleClearProject() {
  if (!draftSessionId) return;
  const { existingWorktreeId, worktreeChoice, branch, baseBranch, ...rest } = currentConfig ?? {};
  const preserved = {
    draftPrompt: prompt,
    draftConfig: { ...rest, entryPoint: "global" as const, useWorktree: true },
  };
  committedRef.current = true;
  useServerStore.getState().applySessionDeleted(draftSessionId); // optimistic: drop from sidebar now
  setGlobalDraft(preserved);
  navigate("/draft/new", { replace: true });
  void api.terminateSession(draftSessionId).catch(() => {});
}
```
(Match whatever the real `setGlobalDraft`/`useGlobalDraftStore` setter signature is, and the
real name of the store's optimistic-delete action if `applySessionDeleted` isn't it — check
`useServerStore.ts` for the actual method used elsewhere on session termination.)

Replace the project-chip block (`DraftComposer.tsx:566-603`) so the ✕ that clears the project is
unconditional, and the existing worktree-unbind control becomes a separate affordance:

```tsx
<div className="project-chip">
  <span className="project-chip__icon" aria-hidden>◧</span>
  <span className="project-chip__name">
    {projects.find((p) => p.id === session?.projectId)?.name ?? "…"}
  </span>
  <button
    type="button"
    className="project-chip__remove"
    aria-label="Remove project"
    onClick={() => void handleClearProject()}
  >
    ✕
  </button>
</div>
{entryPoint === "worktree" ? (
  <button
    type="button"
    className="draft-composer__detach-worktree"
    aria-label="Use existing project folder instead of a new worktree"
    onClick={() => {
      if (!draftSessionId) return;
      const newConfig = { ...currentConfig, entryPoint: "direct" as const, useWorktree: false };
      useServerStore.getState().applySessionUpdated(draftSessionId, { draftConfig: newConfig });
      void api.updateDraft(draftSessionId, { draftPrompt: prompt, draftConfig: newConfig }).catch(() => {
        if (currentConfig) {
          useServerStore.getState().applySessionUpdated(draftSessionId, { draftConfig: currentConfig });
        }
      });
    }}
  >
    Use project folder instead
  </button>
) : null}
```

Give `.draft-composer__detach-worktree` a small text-link/secondary-button style near the
worktree checkbox fields (not inline in the chip) — exact placement/copy is a small UI call,
adjust to fit the existing field layout in this component.

---

## Phase 3 — Reset stale fields on project clear

**File:** `web-ui/src/components/draft/DraftComposer.tsx`

**Low priority / failure-path hygiene only:** once Phase 1 lands, a successful project selection
navigates away immediately, so this combobox `onClear` path is only reachable when the user opens
the combobox, picks a project, then explicitly clears it again *before* the create resolves (or
after a create failure). Worth doing since it's the same file/area, but don't over-invest — it's
not part of either reported bug.

**Corrected per opus review:** the plan's original snippet doesn't compile as written —
`newProjectParentDir`/`newProjectAbsPath` are initialized as `useState("")` (strings), not
`useState(null)`, so resetting them to `null` is a type error; reset to `""` instead. Also
`useWorktree` should reset to `true` (the file's own default), matching the Phase 2 correction —
`false` was wrong there for the same reason. Also missed: `worktreeChoice`, `existingWorktreeId`,
`worktrees`, `branches` are the fields that actually cause visibly stale UI (a worktree/branch
picker still showing the previous project's options) and were omitted from the original snippet.

Change the Tier 2 combobox `onClear` to also reset every field that only makes sense with a
project selected:
```tsx
onClear={() => {
  setSelectedProject(null);
  setComboMode("search");
  setNewProjectName("");
  setNewProjectParentDir("");
  setNewProjectAbsPath("");
  setUseWorktree(true);
  setBranch("");
  setBaseBranch("");
  // Plus whatever this file actually calls its worktree/branch-choice state —
  // grep for `worktreeChoice`, `existingWorktreeId`, `worktrees`, `branches` in
  // this component and reset each to its own initial useState value.
}}
```
(Verify every setter name/default against this file's actual `useState` calls before writing —
the names above are a best guess from context, not a confirmed read of every field.)

---

## Verification

- Global "+ New project" → composer shows no project → select an existing project → composer
  immediately shows the project chip AND the draft appears nested under that project in the
  left sidebar (no need to click Start first).
- Project-row "+" (worktree variant) → composer shows project chip + "Use project folder
  instead" link → clicking ✕ removes the project entirely; draft becomes a top-level sidebar
  sibling (`/draft/new`), prompt/config preserved.
- Project-row "+" (direct variant) → composer shows project chip with only ✕ (no worktree
  link) → ✕ removes the project, same sibling behavior.
- Clicking "Use project folder instead" (worktree variant only) still just demotes
  `entryPoint: worktree → direct`, project stays, same as before this plan.
- Clear a Tier 2 in-progress project selection (before Start) → reopen the project combobox →
  no stale branch/worktree values leak in from the previous selection.

---

## Commit strategy

Single commit on top of the existing drafting-lifecycle work: `web-ui/src/components/draft/DraftComposer.tsx` only (no daemon changes needed — `api.terminateSession` and `api.createDraftSession` already exist and are reused as-is).
