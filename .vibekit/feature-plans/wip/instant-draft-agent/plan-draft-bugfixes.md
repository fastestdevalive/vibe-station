# Draft Bug Fixes — Implementation Plan

## Overview
Three targeted bug fixes on top of the shipped Instant Draft Agent feature: sidebar draft rows that don't align with their sibling rows, a "New project" button that re-opens the existing global draft instead of starting a fresh one, and a 400 `"projectId or worktreeId is required for draft sessions"` caused by a zod union that strips `projectId`. No redesign — minimal, local changes only.

All paths below are relative to `/home/gb/.vibe-station/projects/vibe-station/worktrees/vs-131`. Line numbers are from the current `create-ui-db` HEAD; re-anchor by the quoted code if they drift.

---

## Bug 1: Sidebar draft row icon alignment

### Root cause
Both draft rows copy the *direct-session* row shape (`tree-row tree-row--direct-session` + `<span className="direct-session__icon"><Bot size={10}/></span>`), but:

- `web-ui/src/styles/workspace.css:930` — `.direct-session__icon` is a **12px** box; `Bot size={10}` under-fills it, so the icon is not on the same optical column as the 12px `StatusDot` of sibling rows.
- Real direct-session rows get their indent from their **wrapper** `.direct-sessions-group` (`workspace.css:902`: `margin-left: 12px; padding-left: var(--space-1)`), and worktree rows from `.tree-row.tree-row--worktree` (`workspace.css:1757`: `margin-left: 12px`). The Tier 1 draft rows are rendered **outside** `.direct-sessions-group` (LeftSidebar.tsx:1777-1816, a direct child of the project block) and carry no `margin-left` of their own → their icon and label start ~12-16px left of every sibling row. That is the misalignment the user sees.
- The Tier 2 (global) draft row (LeftSidebar.tsx:1511-1538) is a top-level sibling of **project** rows, whose icon is `Folder`/`FolderOpen` at `size={14}` inside a 14px box (`.tree-row__chevron.tree-row__project-chevron`, `workspace.css:643-652`, row gap `--space-2` via `.tree-row__project-expand`). A 12px `Bot` box there is both the wrong glyph and the wrong width.

### Files to change
- `web-ui/src/components/layout/LeftSidebar.tsx` (two render sites: 1511-1538 global draft row, 1777-1816 per-project draft rows)
- `web-ui/src/styles/workspace.css` (one new rule)

### Exact change

**1a. CSS** — add next to the other draft rules (after `.draft-row__label`, `workspace.css:954-962`):

```css
/* Draft rows live outside `.direct-sessions-group`, so they need that group's
   indent themselves to line up with sibling direct-session rows. */
.tree-row--direct-session.draft-row--nested {
  margin-left: 12px;
  padding-left: var(--space-1);
}
```

Do **not** change `.direct-session__icon`, `.wt-leading-slot`, or `.tree-row__project-chevron` — sibling rows depend on them.

**1b. Tier 2 (global) draft row — LeftSidebar.tsx:1511-1538.** Keep `className="tree-row tree-row--direct-session"` (its `gap: var(--space-2)` already matches the project row's gap) and no indent (it *is* top-level). Replace the icon span only:

```tsx
<span className="tree-row__chevron tree-row__project-chevron" aria-hidden>
  <Folder size={14} />
</span>
```

(`Folder` is already imported at LeftSidebar.tsx:1.) Drop the inline `style={{ opacity: 0.55 }}` — project rows don't dim their folder icon.

**1c. Tier 1 (per-project) draft rows — LeftSidebar.tsx:1778-1815.** Branch on `s.draftConfig?.entryPoint` inside the `.map((s) => …)`. Add at the top of the map callback:

```tsx
const isWorktreeDraft = s.draftConfig?.entryPoint === "worktree";
```

- **Worktree draft** (`isWorktreeDraft === true`) — mirror `.tree-row--worktree` exactly (LeftSidebar.tsx:1856-1896): row `className="tree-row tree-row--worktree"` (this supplies `margin-left: 12px` + `min-height: 28px`), and put the icon + label inside the same two wrappers a worktree row uses:

```tsx
<div className="wt-row__expand">
  <span className="wt-leading-slot">
    <Bot size={12} aria-hidden />
  </span>
  <span className="wt-row__label draft-row__label">{draftLabel(s.draftPrompt)}</span>
</div>
<div className="wt-row__trail draft-row__trail"> …chip + discard unchanged… </div>
```

  Note the hover/discard CSS is keyed on `.tree-row--direct-session` (`workspace.css:1000-1008`), so extend those two selectors to also match the draft class, e.g. change them to `.tree-row--direct-session:hover .draft-chip, .draft-row:hover .draft-chip { … }` and the same for `.draft-row__discard`, and add `draft-row` to **both** draft rows' class lists (worktree variant and nested variant). Keep it to those two selectors.

- **Direct / global draft** (`isWorktreeDraft === false`) — keep `className="tree-row tree-row--direct-session draft-row draft-row--nested"` and use the project glyph at the direct-session row's 12px box size:

```tsx
<span className="direct-session__icon">
  <Folder size={12} aria-hidden />
</span>
```

Keep `Link`, `draftLabel`, the `Draft` chip and the discard button byte-identical in both branches; only the row class, the icon slot, and (worktree case) the `wt-row__expand` wrapper differ.

Because the two Tier 1 branches now diverge structurally, extract a single local component in the same file rather than duplicating markup three times — e.g. `function DraftRow({ to, label, variant, active, onDiscard }: …)` placed just above the `return` in `LeftSidebar`, with `variant: "toplevel" | "nested" | "worktree"` selecting icon slot + row classes, then call it from all three sites (1511, and both Tier 1 branches). Keep the component under ~45 lines; do not move other row markup into it.

---

## Bug 2: New-draft-when-draft-exists always navigates to existing

### Root cause
Two different intents were wired to the same handler. `git show 9c5ea4db3` replaced `onClick={() => setAddProjectOpen(true)}` with `onClick={handleGlobalNewAgent}` at **both** LeftSidebar.tsx:1072 ("Create new agent" nav item) and LeftSidebar.tsx:1502 (the `FolderPlus` button titled **"New project"**). `handleGlobalNewAgent` (LeftSidebar.tsx:948-956) early-returns when a Tier 2 draft already exists:

```tsx
if (globalDraft) { navigate("/draft/new"); return; }
```

So once any global draft is in the store, "New project" (and "Create new agent") only *focuses* it — exactly the reported symptom. Compounding it, `DraftComposer` prefills from the store behind a one-shot `prefilledRef` guard (DraftComposer.tsx:90, 132-148) and `Workspace` renders it without a `key` (Workspace.tsx:686), so even after the store is reset the mounted composer keeps the old prompt.

The **project-level** 409 dedupe is *not* a bug: `daemon/src/routes/sessions.ts:576-586` scans a project's sessions for any `drafting` record and returns 409 — that is PRD journey 9 ("one draft per projectId regardless of type", `prd-instant-draft-agent.md:231`). Leave the daemon dedupe and `existingDraftId()`/`gotoDraft()` untouched.

### Files to investigate / change
- `web-ui/src/components/layout/LeftSidebar.tsx:946-956` (`handleGlobalNewAgent`)
- `web-ui/src/routes/Workspace.tsx:686` (`<DraftComposer …>` — needs a remount key)
- No daemon change. No change to `globalDraftStore.ts`.

### Exact change

**2a.** Make the global-new action always start a fresh draft. Replace `handleGlobalNewAgent` (LeftSidebar.tsx:946-956) with:

```tsx
  /** Global "+ Create new agent" / "New project" → a FRESH Tier 2 draft at
   *  /draft/new. There is exactly one Tier 2 slot, and Tier 2 drafts are
   *  intentionally not restored across reloads (PRD journey 12), so "new"
   *  resets the slot instead of re-focusing the previous draft. */
  function handleGlobalNewAgent() {
    if (isMobile) setMobileSidebarOpen(false);
    globalDraftSet({ draftPrompt: "", draftConfig: { entryPoint: "global" } });
    navigate("/draft/new");
  }
```

(`globalDraft` may become unused in this function — keep the store subscription at LeftSidebar.tsx:924, it is still read by the Tier 2 row render at 1511.)

**2b.** Force the composer to re-read the reset store when the user is already on `/draft/new`. In `web-ui/src/routes/Workspace.tsx`, at the `<DraftComposer` element (line 686) add a key derived from the navigation:

```tsx
<DraftComposer
  key={draftSessionId ?? `new:${location.key}`}
  …
```

`location` is already in scope (Workspace.tsx:30). A repeat `navigate("/draft/new")` pushes a new history entry with a new `location.key`, so the composer remounts and its `prefilledRef` prefill re-runs against the now-empty store.

**2c.** Verify manually (see verification steps) that: a second tap of "Create new agent" while a global draft exists yields an **empty** composer, and that the project `+` menu still lands on the existing project draft via the 409 path (unchanged behavior).

---

## Bug 3: 400 "projectId or worktreeId is required" on draft creation

### Root cause
`daemon/src/routes/sessions.ts:92-110` validates draft bodies with
`z.union([DraftDirectSessionBody, DraftWorktreeSessionBody])`, where `DraftDirectSessionBody` requires `target: z.literal("direct")` and only *it* declares `projectId`. No client call site sends `target` (`web-ui/src/api/client.ts:601-609` only adds `state: "drafting"`), so every body falls through to `DraftWorktreeSessionBody`, which has no `projectId` field — zod strips it. `derivedProjectId` is then undefined at sessions.ts:558-566 and the route 400s at line 568.

Affected (projectId-carrying) call sites, all currently broken:
`LeftSidebar.tsx:963` ("Agent in worktree"), `LeftSidebar.tsx:982` ("Agent in project dir"), `Workspace.tsx:125` (new-worktree shortcut), `DraftComposer.tsx:274` (global → select project). The `worktreeId` call sites (`TabsStrip.tsx:776`, `WorkspaceCanvas.tsx:170`, `Workspace.tsx:138`) happen to work.

### Files to change
- `daemon/src/routes/sessions.ts:92-110`
- `web-ui/src/api/types.ts:211-217`
- `web-ui/src/components/layout/LeftSidebar.tsx:958-994` (graceful failure path)

### Exact change

**3a. Daemon — collapse the union (this is the real fix; it kills the whole key-stripping class of bug).** Replace `DraftWorktreeSessionBody`, `DraftDirectSessionBody` and the union at sessions.ts:92-110 with one object schema:

```ts
// Body for POST /sessions with state:"drafting" — minimal payload, no modeId
// required. Deliberately ONE object (not a union): a union of two object
// schemas silently strips keys that only the non-matching arm declares, which
// is how `projectId` used to vanish and 400 the request. `target` is accepted
// but advisory — the project is derived from worktreeId/projectId below.
const CreateDraftSessionBody = z
  .object({
    target: z.enum(["worktree", "direct"]).optional(),
    projectId: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
    type: z.enum(["agent", "terminal"]),
    state: z.literal("drafting"),
    draftPrompt: z.string().optional(),
    draftConfig: z.any().optional(),
  })
  .refine((b) => b.projectId != null || b.worktreeId != null, {
    message: "projectId or worktreeId is required for draft sessions",
  });
```

The derive block at sessions.ts:557-568 keeps working unchanged (`"worktreeId" in draftData` is still true for the optional key when present); leave it, including the 400 at line 568 as a belt-and-braces guard.

**3b. Client call sites — send an explicit `target`** so intent is on the wire and the request is well-formed regardless of future schema shape:

- LeftSidebar.tsx:963-967 (`handleNewWorktree`, project-level draft whose worktree is created at Start — there is no `worktreeId` yet): add `target: "direct"` alongside `projectId: project.id`. Add a one-line comment: `// no worktree exists yet — the draft hangs off the project; the worktree is created on Start`.
- LeftSidebar.tsx:982-986 (`handleNewDirectAgent`): add `target: "direct"`.
- `Workspace.tsx:125-129`: add `target: "direct"`.
- `DraftComposer.tsx:274-278`: add `target: "direct"`.
- `TabsStrip.tsx:776-780`, `WorkspaceCanvas.tsx:170-174`, `Workspace.tsx:138-142` (all `worktreeId`): add `target: "worktree"`.

**3c. Types — make the missing-id case a compile error (cheap, do it).** Replace `web-ui/src/api/types.ts:211-217` with:

```ts
/** Body for `POST /sessions` with `state: "drafting"` (create a draft).
 *  Exactly one of `projectId` / `worktreeId` must be present — expressed as a
 *  union so TypeScript rejects a body with neither (the shape that used to be
 *  silently stripped by the daemon's zod union and 400'd at runtime). */
export type CreateDraftSessionBody = {
  type: "agent";
  draftPrompt?: string;
  draftConfig: DraftConfig;
} & (
  | { target?: "direct"; projectId: string; worktreeId?: never }
  | { target?: "worktree"; worktreeId: string; projectId?: never }
);
```

Then run `pnpm -C web-ui tsc --noEmit` and fix any call site the union now rejects (expected: none, after 3b). `client.ts:601` and `mock.ts:603` keep their `CreateDraftSessionBody` parameter type unchanged.

**3d. Graceful failure path (user requirement: "never show JS errors").** In LeftSidebar, replace the two `window.alert(… "Failed to create draft.")` calls (lines 972 and 991) with inline, dismissible state — there is no toast system in web-ui (see the comments at LeftSidebar.tsx:793 and TabsStrip.tsx:842), so add a tiny local one:

1. Near the other `useState` hooks, add `const [draftError, setDraftError] = useState<string | null>(null);`
2. In both catch blocks: `if (existingId) gotoDraft(existingId); else setDraftError(err instanceof Error ? err.message : "Couldn't start a new draft. Please try again.");`
3. Render it once, directly under the projects heading (just before the Tier 2 draft row at LeftSidebar.tsx:1509), guarded by `!collapsed && draftError`:

```tsx
{!collapsed && draftError ? (
  <div className="sidebar-inline-error" role="status">
    <span>{draftError}</span>
    <button type="button" className="icon-btn" aria-label="Dismiss error" onClick={() => setDraftError(null)}>×</button>
  </div>
) : null}
```

4. Add a minimal rule in `workspace.css` beside the draft rules:

```css
.sidebar-inline-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: var(--space-1) 0;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--fg-primary);
  background: var(--bg-hover);
  border: 1px solid var(--border-default);
}
```

5. Clear it on success: call `setDraftError(null)` at the top of both `handleNewWorktree` and `handleNewDirectAgent`.

Leave `handleDiscard`'s alert (line 1003) and the unrelated alerts at 795/821 alone — out of scope.

---

## TypeScript & verification steps

1. `pnpm -C daemon tsc --noEmit` — daemon schema change compiles.
2. `pnpm -C web-ui tsc --noEmit` — the new `CreateDraftSessionBody` union must produce **zero** errors; any error means a call site is still missing its id/`target`.
3. `pnpm -C daemon test` and `pnpm -C web-ui test` (or the repo's root `pnpm test`) — expect no failures; no test currently asserts on the old draft zod union or the `Bot`-icon markup, so no test updates are expected. If a snapshot covers the sidebar draft row, update it.
4. Lint the touched files (repo lint script) — the `Bot` import must stay used (worktree-draft variant); `Folder` was already imported.
5. Manual smoke (daemon + web-ui running, per `scripts/dev-sandbox.sh` with an explicit port):
   - Project `+` → **Agent in worktree**: a draft row appears under the project, right pane opens the composer, **no 400 / no alert** in console or network tab.
   - Project `+` → **Agent in project dir** on a project that already has a draft: lands on the existing draft (409 path intact, still no alert).
   - Bug 1: with one worktree draft and one direct draft under an expanded project, the draft rows' icons and label left edges line up with the worktree rows and direct-session rows above them; the top-level global draft row's folder icon lines up with project rows' folder icons.
   - Bug 2: tap "Create new agent", type a prompt, navigate Home, tap "Create new agent" again → composer is **empty**; repeat while already sitting on `/draft/new` → still resets.
   - Bug 3d: temporarily stop the daemon and tap "Agent in project dir" → inline dismissible sidebar error, no `window.alert`, no uncaught exception.
