<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: draft-lifecycle-sync

> After a draft session is promoted to a real agent session, the web-ui keeps showing the `DraftComposer` UI (and a stale "draft" badge on the tab) instead of the real agent pane, until the page is hard-reloaded.

**Issue:** draft-lifecycle-sync
**Branch:** `created-ui-draft` (current worktree branch)
**Status:** WIP — plan (rev 2, post opus review)
**PRD:** none — small, well-isolated fix

**Reference files:**
- `web-ui/src/routes/Workspace.tsx` (draft/real gate, draft-route redirect)
- `web-ui/src/components/layout/TabsStrip.tsx` (tab "is draft" badge/dialog)
- `web-ui/src/components/layout/AgentPaneSlot.tsx` (the file that already got this right — model to follow)
- `daemon/src/routes/sessions.ts` (`POST /sessions/:id/start` — draft promotion)

---

## Problem

- `Session` carries two parallel fields for the same underlying value: `state` and `lifecycleState` (`daemon/src/ws/protocol.ts:280-300` proves they're always set from the identical enum/source at snapshot time — never legitimately allowed to diverge).
- Only `state` is kept live over WS after the initial bundle fetch (`useServerSync.ts`'s `session:state`/`session:exited`/`session:resumed` handlers patch `state` only). `lifecycleState` is correct only right after the initial full-bundle fetch, then goes stale forever until a reload.
- `AgentPaneSlot.tsx:74-80` already discovered this and reads `.state` exclusively, with an explicit comment + regression test warning future code off `.lifecycleState`.
- Two call sites never got the memo and still read the stale field: `Workspace.tsx:68` (draft/real pane gate) and `:251` (draft-route redirect-away-from-draft effect). `TabsStrip.tsx:609,813,820,849` hedge with `s.lifecycleState === "drafting" || s.state === "drafting"` — harmless (OR is safe) but redundant, and worth cleaning up alongside the real fix.
- Separately, in `sessions.ts`'s "promote a tab-draft into an **existing** worktree" branch (`entryPoint === "tab"`/`existingWorktreeId`, ~line 1442-1500), only `session:state` is broadcast — unlike the "promote into a **brand-new** worktree" branch, which also broadcasts `session:updated { worktreeId }`. A tab-draft promoted into an existing worktree therefore never gets its `worktreeId` update pushed live to other clients either.

## Root Cause

- Two fixes, same family of bug, both "a live WS update doesn't carry a value the initial-fetch path provides":
  1. **Client:** `Workspace.tsx` reads the one field (`lifecycleState`) that WS never updates, instead of `state` (which it does).
  2. **Daemon:** the existing-worktree draft-promotion branch is missing a `session:updated { worktreeId }` broadcast that the new-worktree branch already has.
- Chosen fix direction: make `Workspace.tsx` match the established, already-tested convention in `AgentPaneSlot.tsx` (read `.state`) rather than teaching more WS handlers to keep two fields in lockstep forever — avoids the "two fields that can drift" trap called out in `protocol.ts:376-382`'s `name`/`sessionLabel` comment.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | After a draft session is promoted, the pane switches from `DraftComposer` to the real agent view live, without a page reload. |
| 2 | The `/draft/:id` route's redirect-away-once-promoted effect also reacts live (uses the same live-updated field as #1). |
| 3 | A tab-draft promoted into an **existing** worktree gets its `worktreeId` pushed to other connected clients live, matching the new-worktree promotion path. |
| 4 | No behavior change for any session whose state was already reflected correctly (regression-safe) — includes `TabsStrip`'s draft badge/terminate-dialog copy. |

## Architecture Diagram

Two small, independent call sites, no shared new abstraction — no diagram needed.

---

## Implementation Phases

### Phase 1 — Daemon: broadcast `worktreeId` on existing-worktree draft promotion

- [x] **1.1** `daemon/src/routes/sessions.ts` (`isDirect` block, existing-worktree promotion — around line 1500, right before/alongside the existing `broadcastAll({ type: "session:state", ... })`): when `existingWorktree` is set, also broadcast `broadcastAll({ type: "session:updated", sessionId: id, worktreeId: existingWorktree.id })`, mirroring the new-worktree branch (~line 1426).

**Verify phase 1:**
- [x] **1.T1** Integration — `daemon/src/__tests__/sessions.draftPromotion.test.ts` (new): `POST /sessions/:id/start` with `entryPoint: "worktree"/worktreeChoice: "existing"` targeting an existing worktree broadcasts `session:updated` with the correct `worktreeId`, in addition to `session:state`. (Deliberately not `entryPoint: "tab"` — see follow-up bug below.)
- [x] **1.T2** Regression — same suite: the new-worktree promotion path's existing broadcast assertions still pass unchanged.

**Follow-up (out of scope, filed not fixed):** while writing 1.T1, discovered that promoting a **tab draft** (`entryPoint: "tab"` — a draft that already lives inside a worktree's `sessions[]`) into that same worktree 500s with a SQLite UNIQUE-constraint error: the promotion path appends the updated session record without first removing the original draft from that worktree's `sessions[]`, producing a duplicate id. This is a separate, pre-existing bug, unrelated to the `lifecycleState`/`state` staleness bug this plan fixes — left unfixed here to keep this change small; worth its own plan.

---

### Phase 2 — Web-UI: read `.state`, not `.lifecycleState`, for the drafting check

- [x] **2.1** `web-ui/src/routes/Workspace.tsx:68`: `activeSession?.lifecycleState === "drafting"` → `activeSession?.state === "drafting"`.
- [x] **2.2** `web-ui/src/routes/Workspace.tsx:251`: `s.lifecycleState === "drafting"` → `s.state === "drafting"`.
- [x] **2.3** Add a one-line comment at both sites pointing to `AgentPaneSlot.tsx:74-80`'s explanation, so the next person doesn't revert it back to `.lifecycleState`.
- [x] **2.4** `web-ui/src/components/layout/TabsStrip.tsx:609,813,820,849`: drop the now-redundant `s.lifecycleState === "drafting" ||` / `terminateTarget?.lifecycleState === "drafting" ||` clauses, leaving just the `.state` check.

**Verify phase 2:**
- [x] **2.T1** Integration — `Workspace.test.tsx`: a session whose `state` has transitioned to `"not_started"` via a mocked `session:state` WS event (while `lifecycleState` is deliberately left stale at `"drafting"`, simulating the real bug) renders the real agent pane, not `DraftComposer`.
- [x] **2.T2** Regression — same suite: a session still genuinely drafting (`state: "drafting"`) still renders `DraftComposer`.
- [x] **2.T3** Regression — `TabsStrip.test.tsx`: a promoted session (`state` no longer `"drafting"`) no longer shows the draft badge/terminate-dialog copy, even with a stale `lifecycleState`.

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/routes/sessions.ts` | **Modified** | 1.1 | Existing-worktree draft promotion also broadcasts `session:updated { worktreeId }` |
| `daemon/src/__tests__/sessions.*.test.ts` (nearest match) | **Modified** | 1.T1, 1.T2 | New/extended broadcast assertions |
| `web-ui/src/routes/Workspace.tsx` | **Modified** | 2.1, 2.2, 2.3 | Draft gate + redirect effect read `.state` instead of `.lifecycleState` |
| `web-ui/src/components/layout/TabsStrip.tsx` | **Modified** | 2.4 | Drop redundant `.lifecycleState` OR-clauses |
| `web-ui/src/routes/Workspace.test.tsx` (nearest match) | **Modified** | 2.T1, 2.T2 | New/extended coverage |
| `web-ui/src/components/layout/TabsStrip.test.tsx` (nearest match) | **Modified** | 2.T3 | New/extended coverage |
