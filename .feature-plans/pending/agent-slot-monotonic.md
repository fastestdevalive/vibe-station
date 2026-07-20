# Mini-Design: Monotonic agent slots (stop reusing `a{n}` / session id)

> Deleting an agent in a worktree and creating a new one currently reuses the freed slot (`a1`) and its session id (`vs-23-a1`). Make agent slots monotonic per worktree so ids never recur.

**Issue:** agent-slot-monotonic
**Branch:** `agent-ids-in-a-worktree`
**Status:** Implemented
**Parent design:** `.feature-plans/worktree-id-monotonic.md` _(same pattern, one level down: worktree ids there, in-worktree slots here)_

> **IMPLEMENTER: this plan is fully prescriptive.** All design decisions are made (see Decisions Locked). Apply the exact BEFORE/AFTER edits in "Exact Edits", add the tests verbatim, run the commands in "Build & Test Commands". Make NO other changes. Work only in this worktree (`vs-23`); never touch the base repo path.

---

## Decisions Locked (do NOT deviate)

1. **Agents only.** Do NOT touch terminal (`t{n}`) or direct (`d{n}`) slots. Leave `reserveNextTerminalSlot` and `reserveNextDirectSlot` exactly as they are.
2. **Reservation is pre-lock** (same shape terminals already use). No two-phase locking, no `withProjectLock`.
3. **No frontend / UI changes.** Gaps like `a1, a3, a8` are intended and fine.
4. **No manifest migration.** Legacy worktrees lazily seed from existing agent slots.

## Problem

- `reserveNextAgentSlot` (`daemon/src/services/sessionId.ts:46-56`) picks the **lowest free** `a{n}`, scanning only *current* `worktree.sessions`.
- Delete fully removes the session record (`daemon/src/routes/sessions.ts:556-567`), freeing the number.
- Result: delete `a1` → next agent is `a1` again → same id `vs-23-a1`, same tmux name, same `session-data/<wtId>/vs-23-a1/` path.

## Concept

- Add a per-worktree monotonic high-water counter `agentSeq` (mirrors the existing `terminalSeq`).
- Next agent is always `a{agentSeq+1}`; deleted numbers never return.

---

## Root Cause

- Slot allocation is gap-filling, not monotonic; deletion frees the number and the next reservation reclaims it. Session id, tmux name, and session-data path all derive from the slot, so all three recur.

## Architecture

```
POST /sessions (agent)
  → reserveNextAgentSlot(worktree)          [sessionId.ts]  n = (worktree.agentSeq ?? maxExistingA) + 1
  → slot = `a${n}` → id `${wtId}-a${n}` → tmuxName   [sessions.ts]
  → mutateProject: append session + write agentSeq = n     [project-store → manifest.json]
```

---

## Exact Edits

### Edit 1 — `daemon/src/types.ts` (add field to `WorktreeRecord`)

Find (ends around line 67):

```ts
  /**
   * Monotonic counter for default terminal names ("Terminal N"). Only ever
   * increments — numbers are never reused even after a terminal is deleted, so
   * names stay stable/unambiguous across a worktree's lifetime.
   */
  terminalSeq?: number;
  sessions: SessionRecord[];
}
```

Replace with (insert the `agentSeq` block before `sessions`):

```ts
  /**
   * Monotonic counter for default terminal names ("Terminal N"). Only ever
   * increments — numbers are never reused even after a terminal is deleted, so
   * names stay stable/unambiguous across a worktree's lifetime.
   */
  terminalSeq?: number;
  /**
   * Monotonic high-water counter for agent slots (a{n}). Only ever increments —
   * a deleted agent's number is never reused, so agent session ids
   * (`<worktree>-a{n}`) never recur across the worktree's lifetime.
   */
  agentSeq?: number;
  sessions: SessionRecord[];
}
```

### Edit 2 — `daemon/src/services/sessionId.ts` (make reservation monotonic)

Replace the WHOLE `reserveNextAgentSlot` function (lines 43-56) with:

```ts
/**
 * Reserve the next agent slot (a{n}) for a worktree — monotonic, never reused.
 *
 * Uses the persisted high-water counter `worktree.agentSeq`. Legacy worktrees
 * (no counter yet) lazily seed from `max(existing agent slot nums)`. The
 * `Number.isFinite` filter is REQUIRED so a non-numeric slot can't poison the
 * counter to NaN. A deleted agent's number is never recycled.
 *
 * Pure: the caller MUST persist the returned number as `agentSeq` in the same
 * `mutateProject` update that appends the session record.
 */
export function reserveNextAgentSlot(worktree: WorktreeRecord): `a${number}` {
  const existing = worktree.sessions
    .filter((s) => typeof s.slot === "string" && (s.slot as string).startsWith("a"))
    .map((s) => parseInt((s.slot as string).slice(1), 10))
    .filter(Number.isFinite);
  const seed = Math.max(0, ...existing);
  const n = (worktree.agentSeq ?? seed) + 1;
  return `a${n}`;
}
```

> Do NOT change `reserveNextTerminalSlot` or `reserveNextDirectSlot`.

### Edit 3 — `daemon/src/routes/sessions.ts` (compute + persist `agentSeq`)

**3a.** After the terminal-naming block (ends ~line 451, right before `const sessionRecord: SessionRecord = {`), insert:

```ts
    // Agent slots are monotonic (never reused). Persist the high-water number.
    let nextAgentSeq: number | undefined;
    if (type === "agent") {
      nextAgentSeq = parseInt(slot.slice(1), 10);
    }
```

**3b.** In the persist `mutateProject` (lines ~498-509), add the `agentSeq` spread next to the existing `terminalSeq` spread. Find:

```ts
          ? {
              ...w,
              ...(nextTerminalSeq != null ? { terminalSeq: nextTerminalSeq } : {}),
              sessions: [...w.sessions, sessionRecord],
            }
```

Replace with:

```ts
          ? {
              ...w,
              ...(nextTerminalSeq != null ? { terminalSeq: nextTerminalSeq } : {}),
              ...(nextAgentSeq != null ? { agentSeq: nextAgentSeq } : {}),
              sessions: [...w.sessions, sessionRecord],
            }
```

> Leave the delete handler (`sessions.ts:531-580`) and the slot-reservation call site (`sessions.ts:436-438`) unchanged.

---

## Files to Modify

| File | Change |
|------|--------|
| `daemon/src/types.ts` | Add `agentSeq?: number` to `WorktreeRecord` (Edit 1) |
| `daemon/src/services/sessionId.ts` | Monotonic `reserveNextAgentSlot` (Edit 2) |
| `daemon/src/routes/sessions.ts` | Compute + persist `agentSeq` (Edit 3a, 3b) |
| `daemon/src/__tests__/sessionId.test.ts` | Add `reserveNextAgentSlot` unit tests (Phase 2) |
| `daemon/src/__tests__/sessions.test.ts` | Add no-reuse integration test (Phase 2) |

## Risks / Notes

| # | Note |
|---|------|
| 1 | Existing tests `sessions.test.ts` "creates a new agent session (a1)" and "assigns sequential slots" still pass: a fresh worktree seeds to 0 → first agent `a1`, second `a2`. Do not modify them. |
| 2 | Pre-lock reservation has the same theoretical race terminals already have — accepted, out of scope. |

---

## Build & Test Commands

Run from the worktree root `/home/gb/.vibe-station/projects/vibe-station/worktrees/vs-23`.

```
# 1. Install deps ONCE (node_modules is not present in this fresh worktree):
pnpm install

# 2. Typecheck (must pass, no errors):
cd cli && pnpm typecheck && cd ..

# 3. Run the two affected daemon test files (fast):
cd cli && pnpm exec vitest run src/daemon/__tests__/sessionId.test.ts src/daemon/__tests__/sessions.test.ts && cd ..

# 4. Full cli+daemon suite before committing:
cd cli && pnpm test && cd ..
```

> Note: the daemon has no package.json — its tests live under `daemon/src/__tests__/` and are run through the `cli/src/daemon` symlink by cli's vitest, so paths are `src/daemon/__tests__/...` when invoked from `cli/`.

---

## Implementation Phases

### Phase 1 — Code changes

- [x] **1.1** Edit 1 — add `agentSeq?: number` to `WorktreeRecord`
- [x] **1.2** Edit 2 — monotonic `reserveNextAgentSlot`
- [x] **1.3** Edit 3a + 3b — compute `nextAgentSeq`, persist in append `mutateProject`

**Verify phase 1:**
- [x] **1.T1** `cd cli && pnpm typecheck` passes with no errors

### Phase 2 — Tests

- [x] **2.1** In `daemon/src/__tests__/sessionId.test.ts`, add this describe block (uses the existing `makeWorktree` helper at the top of the file):

... (unchanged code block) ...

- [x] **2.2** In `daemon/src/__tests__/sessions.test.ts`, add this test inside the `describe("Session routes", …)` block (after the "assigns sequential slots for multiple sessions" test):

... (unchanged code block) ...

**Verify phase 2:**
- [x] **2.T1** Unit — `reserveNextAgentSlot`: all four new cases pass
- [x] **2.T2** Integration — Session routes: delete-then-create yields a new slot/id, not the freed one
- [x] **2.T3** Regression — existing `sessions.test.ts` / `sessionId.test.ts` still pass
- [x] Run: `cd cli && pnpm exec vitest run src/daemon/__tests__/sessionId.test.ts src/daemon/__tests__/sessions.test.ts` → all green
- [x] Run full suite: `cd cli && pnpm test` → all green

### Phase 3 — Commit

- [x] **3.1** Commit on branch `agent-ids-in-a-worktree` only. Suggested message:
  `fix(sessions): monotonic agent slots so deleted agent ids are never reused`
- [x] Do NOT open a PR unless asked. Do NOT push to main.

---

## Files Summary

| File | Phase | Change |
|------|-------|--------|
| `daemon/src/types.ts` | 1.1 | Add `agentSeq?: number` |
| `daemon/src/services/sessionId.ts` | 1.2 | Monotonic `reserveNextAgentSlot` |
| `daemon/src/routes/sessions.ts` | 1.3 | Compute + persist `agentSeq` |
| `daemon/src/__tests__/sessionId.test.ts` | 2.1 | Unit tests |
| `daemon/src/__tests__/sessions.test.ts` | 2.2 | Integration test |
