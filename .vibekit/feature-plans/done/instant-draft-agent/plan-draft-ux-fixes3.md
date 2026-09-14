# Plan — DraftComposer UX fixes (round 3)

**Branch:** create-ui-db  
**Worktree:** /home/gb/.vibe-station/projects/vibe-station/worktrees/vs-131

---

## Bugs (3)

1. **Name format wrong** — sidebar/tab shows `lorem ipsum dolor` (spaces) not `lorem-ipsum-dolor` (hyphens). Root cause: daemon draft PATCH derives name via `slugifyPrompt(...).replace(/-/g, " ")` which strips hyphens. Real agent names keep hyphens. Fix: remove the `.replace` call.

2. **New project draft still goes to existing** — race condition not fixed. Root cause: `handleNewDirectAgent/handleNewWorktree` navigates to `/draft/${new-id}` but the WS `session:created` event hasn't updated the store yet; the CUJ7 guard fires before the store update. Fix: call `useServerStore.getState().applySessionCreated(s)` immediately after `api.createDraftSession` returns, BEFORE navigating. This eliminates the race entirely.

3. **Worktree draft ✕ discards entire draft** — clicking ✕ on the project chip for a worktree-level draft calls `onDiscard()` which terminates the session and navigates home. User wants it to demote the draft to project-level (direct entry) and stay on screen. Fix: when `entryPoint === "worktree"`, patch the draftConfig to `entryPoint: "direct"` via `api.updateDraft` and reset `prefilledRef` to allow re-prefill, instead of calling `onDiscard()`.

---

## Phase 1 — Name format (daemon only) ✦ Bug 1

**File:** `daemon/src/routes/sessions.ts`

Find (around line 1144-1145):
```ts
const slug = slugifyPrompt(draftPrompt, 5);
derivedName = slug ? slug.replace(/-/g, " ") : null;
```

Change to:
```ts
const slug = slugifyPrompt(draftPrompt, 5);
derivedName = slug || null;
```

Remove the `.replace(/-/g, " ")` — the slug already uses hyphens (`lorem-ipsum-dolor`) which is the correct format used for real agent names.

---

## Phase 2 — Optimistic session creation (LeftSidebar.tsx) ✦ Bug 2

**File:** `web-ui/src/components/layout/LeftSidebar.tsx`

**Root cause:** After `api.createDraftSession` returns, `gotoDraft(s.id)` navigates to `/draft/${s.id}`. But `useServerStore.sessions` doesn't yet contain the new session (the WS `session:created` event hasn't arrived). The CUJ7 guard in `Workspace.tsx` fires immediately, sees the session missing, and redirects to "/".

**Fix:** Import `useServerStore` and call `applySessionCreated(s)` BEFORE navigating.

Find the import at the top of `LeftSidebar.tsx`:
```ts
import { useServerStore } from "@/hooks/useServerStore";
```
(Add this import if not already present.)

In `handleNewWorktree` (around line 944), change:
```ts
gotoDraft(s.id);
```
to:
```ts
useServerStore.getState().applySessionCreated(s);
gotoDraft(s.id);
```

In `handleNewDirectAgent` (around line 963), same change:
```ts
useServerStore.getState().applySessionCreated(s);
gotoDraft(s.id);
```

This ensures the session is in the store before navigation, so the CUJ7 guard finds it immediately. The subsequent real WS `session:created` event is idempotent (the store's `applySessionCreated` deduplicates by id, see `useServerStore.ts:100`).

---

## Phase 3 — Worktree draft ✕ demotes to direct (DraftComposer.tsx) ✦ Bug 3

**File:** `web-ui/src/components/draft/DraftComposer.tsx`

Find the project chip ✕ `onClick` (added in a previous phase). It currently calls `committedRef.current = true; onDiscard()` unconditionally.

Change the ✕ button onClick to:
```tsx
onClick={() => {
  if (entryPoint === "worktree" && draftSessionId) {
    // Demote to project-level (direct) draft — keep session, remove worktree binding.
    prefilledRef.current = false; // allow re-prefill when session:updated arrives
    setUseWorktree(false);        // immediate UI update
    void api.updateDraft(draftSessionId, {
      draftPrompt: prompt,
      draftConfig: { ...currentConfig, entryPoint: "direct", useWorktree: false },
    }).catch(() => {});
    // Stay on this screen — the WS session:updated event will re-prefill with
    // entryPoint:"direct" and the form will reflect the updated state.
  } else {
    committedRef.current = true;
    onDiscard();
  }
}}
```

When `entryPoint === "worktree"`: this patches the draftConfig on the server, resets `prefilledRef` to false so the next WS `session:updated` event triggers a re-prefill with the new `entryPoint: "direct"`, and immediately updates the checkbox UI. The draft moves from worktree-level to project-level in the sidebar, and the user stays on screen.

For all other entry points: the ✕ still calls `onDiscard()` as before.

---

## Commit strategy

All 3 phases amend into the 2 existing commits:
- Daemon changes (Phase 1) → amend `feat(daemon): drafting lifecycle state...` (5a7a1ca)
- UI changes (Phases 2, 3) → amend `fix(ui): worktree checkbox...` (25a5ee8)

After all phases: stage changes, `git add` daemon file + UI files, amend the appropriate commits.
