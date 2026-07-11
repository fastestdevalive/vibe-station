# Monotonic worktree IDs (never reuse)

## Problem

Worktree IDs are reused. `reserveNextWorktreeNum` (`daemon/src/services/sessionId.ts:17-34`)
returns the smallest integer not in the manifest **and** whose directory doesn't exist on
disk. So after a **purge** delete (UI always purges; CLI with `--purge`), a deleted worktree
`vs-2` is recreated with the **same id** → same path, same session id `vs-2-m`, same tmux
name `vr-vs-2-m`.

Reuse produces three clashes:

1. **tmux clash** — delete kills tmux best-effort (`daemon/src/routes/worktrees.ts:506-510`).
   If the kill fails, the session survives. Spawn calls `newSession()`
   (`daemon/src/services/tmux.ts:43-59`) with no `hasSession()` guard → `tmux new-session`
   errors `session already exists` → spawn fails hard.
2. **Claude/Cursor conversation bleed** — transcripts live at `~/.claude/projects/<slug>/<uuid>.jsonl`,
   slug derived purely from the absolute worktree **path** (`daemon/src/agent-plugins/claudeRestore.ts:24-31`).
   vibe-station never deletes this dir, even on purge. `getRestoreCommand` falls back to
   `findLatestChatUuid(path)` when `session.agentChatId` is absent
   (`daemon/src/agent-plugins/claude.ts:174-176`). A reused-path worktree can resume the
   **deleted** worktree's conversation. Cursor has the same pattern (`cursorRestore.ts`).
3. **session-data leftovers** (low severity) — `session-data/<wtId>/<sessionId>/` cleanup is
   best-effort (`worktrees.ts:513`, `paths.ts:61-67`).

## Decision

Make worktree numbers **monotonic** — a removed `vs-2` is never recycled; next create is
always `vs-3`. An id permanently means one piece of work. This dissolves all three clashes at
the source (path / session id / tmux name are never reused), rather than patching each.

## Plan

### 1. Data model — add a high-water counter

`daemon/src/types.ts`, `ProjectRecord`:

```ts
nextWorktreeNum?: number; // monotonic high-water mark; optional for back-compat
```

Persisted in `manifest.json` like the rest of the record.

### 2. Reservation — monotonic + race-safe

`daemon/src/services/sessionId.ts` — change `reserveNextWorktreeNum` from "smallest free" to
"next from counter":

```ts
// seed for legacy manifests with no counter yet.
// Number.isFinite filter is REQUIRED: any worktree id whose last segment isn't
// numeric yields NaN, and Math.max(0, NaN) === NaN would produce id `vs-NaN` and
// permanently poison the counter. (Today's smallest-free loop is immune because
// NaN in a Set never matches — the monotonic rewrite is not.)
const nums = project.worktrees.map(numOf).filter(Number.isFinite);
const seed = Math.max(0, ...nums) + 1;
let n = project.nextWorktreeNum ?? seed;
// paranoia guard: never land on a stray on-disk dir (old non-purge orphans)
while (existsSync(worktreePath(project.id, `${project.prefix}-${n}`))) n++;
return n;
```

Keep the `existsSync` guard as a safety net (mostly moot now, but cheap). The guard runs
*before* the counter is persisted (see below), so any orphan-dir skips are also recorded in
`nextWorktreeNum`.

`daemon/src/routes/worktrees.ts` create handler — bump-then-build:

- Replace the bare `reserveNextWorktreeNum` call (line 269) with a `mutateProject` that
  **reserves `n` (running the seed + existsSync guard) and writes back
  `nextWorktreeNum = n + 1` atomically**, returning `n`. This both persists the counter and
  closes the pre-lock race (`mutateProject` serializes via `withProjectLock`; the current
  reserve runs before any lock).
- Then `worktreeAdd(... n ...)`, then the existing `mutateProject` appends the record.
- **Burn-on-failure is intentional:** if git add fails after the bump, the number is consumed
  and never reused — exactly what "monotonic" means. No rollback of the counter.

> **Locking footgun — do NOT wrap the create flow in an outer `withProjectLock`.**
> `withProjectLock` (`daemon/src/services/mutex.ts:9-31`) is a plain boolean+queue and is
> **not reentrant** — a nested acquire on the same project id deadlocks forever. The design
> relies on **two sequential, non-nested** `mutateProject` calls (reserve, then append), each
> acquiring and releasing independently. Never hoist an outer lock around them while still
> calling `mutateProject` inside.

Also fix two stale comments while here: the misleading `// ... under mutex` comment at
`worktrees.ts:267`, and the `reserveNextWorktreeNum` JSDoc ("MUST be called under the project
mutex") — it now genuinely runs inside a `mutateProject` callback.

### 3. Back-compat / migration

No explicit migration. Existing manifests have `nextWorktreeNum: undefined` → first create
lazily seeds from `max(existing worktree nums) + 1`. Existing worktrees keep their ids. The
`existsSync` guard absorbs any leftover orphan dirs from past non-purge deletes.

### 4. Tests

- `sessionId` test: delete-highest-then-create yields `N+1`, not the freed number.
- Counter persists across a manifest reload.
- Legacy manifest (no `nextWorktreeNum`) seeds correctly from existing worktrees.
- Legacy manifest with a non-numeric-suffixed worktree id does **not** yield `NaN`
  (regression guard for the `Number.isFinite` filter).
- Two-phase window: a reserve/bump with **no** subsequent append (crash-simulated) still
  advances the counter — the next create skips the burned number.

## What this dissolves from earlier fix ideas

- **Claude/Cursor chat cleanup: dropped** — path/slug is never reused, so no transcript to
  bleed. Moot under monotonic.
- **session-data leftovers (clash #3): moot** — `session-data/<wtId>/...` paths never recur.
- **tmux idempotency (clash #1): optional** — tmux names (`vr-vs-N-m`) never recycle either,
  so the clash can't arise from ID reuse. Out of scope for this change. A 1-line
  defense-in-depth (`await killSession(opts.name)` atop `newSession`) is available if
  belt-and-suspenders is ever wanted, but it's not needed here.

## Scope / trade-offs

- Small: one optional field, one rewritten function (~10 lines), one tightened call site, tests.
- Cost: numbers grow over time and can look gappy (`vs-2`, `vs-3`, `vs-7`…). That's the
  intended signal — gaps mean deleted work; ids never lie.
