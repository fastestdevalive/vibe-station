# Post-SQLite daemon latency regressions (PR #39 fallout)

Three user-reported regressions after `sqlite-agent-naming` (PR #39) merged:

1. Web-UI terminal pane accepts **no** input — not keyboard, not touch, not scroll.
2. Switching between agent tabs in a worktree is slow (used to be instant).
3. The agent tab bar takes seconds to appear; sometimes a second agent session
   never renders in the strip.

All three share ONE root cause plus one independent crash bug.

---

## Evidence

### Route latency, pre-merge vs post-merge (same machine, same data)

Median response time, from `~/.vibe-station/logs/daemon.log` (pre-merge,
41,499 `/tree` samples across 59 daemon runs) vs `/tmp/vst-daemon.log`
(post-merge):

| route | PRE p50 | POST p50 | ratio |
|---|---|---|---|
| `/worktrees/:id/tree` | 1.33 ms | 2260.72 ms | **1694×** |
| `/worktrees/:id/files/*` | 1.15 ms | 1095.99 ms | **956×** |
| `/sessions/:id` | 0.16 ms | 4.23 ms | 26× |
| `/projects` | 0.20 ms | 4.46 ms | 22× |
| `/sessions?worktree=` | 0.22 ms | 4.09 ms | 19× |
| `/worktrees/:id/changed-paths` | 8.91 ms | 13.46 ms | 1.5× |

Bucketing the pre-merge log **by date** (2026-05-03 → 2026-08-07) shows p50
flat at ~1.2 ms the whole time — so this is not gradual data growth, it is a
step change at the merge.

### CPU profile of the daemon (`--cpu-prof`, 45 s, isolated instance seeded with the real DB)

```
  self ms      %  function
  24925.1   50.8  spawn  @node:internal/child_process:355
  20833.1   42.5  (idle)
   1282.7    2.6  run  @daemon/services/tmux.js:9
     108.5    0.2  prepare @better-sqlite3/lib/methods/wrappers.js
      86.4    0.2  (anonymous) @daemon/state/project-store.js:34
      22.3    0.0  assembleProject @daemon/state/project-store.js:29
```

**50.8% of the daemon's main thread is `child_process.spawn`**, in ~1 s
contiguous blocks. SQLite query time itself is a rounding error (~0.5%).

### Where the spawns come from

`services/lifecycle.ts` `pollAll()` runs at 1 Hz and calls
`hasSession(session.tmuxName)` — one `execFile("tmux", ["has-session", ...])`
per session per tick. The live DB has 237 sessions, 230 of them tmux-backed,
so that is **230 process spawns per second**. Crucially it spawns for
`done` (140) and `exited` (35) sessions too — `pollSession` awaits
`hasSession` *before* checking those terminal states, so 169 of the 230
spawns per tick are pure waste.

Measured standalone against the live tmux server: one tick of 230
`has-session` calls = 350 ms wall, **327 ms of contiguous event-loop lag**.

### Why a pre-existing poller only became fatal now

`uv_spawn` uses `fork()`, whose cost is proportional to the parent's mapped
memory (page-table copy). Measured directly (`/tmp/vstbench/forkcost.mjs`):

```
rss= 44MB   1.36 ms/spawn (synchronous, main thread)
rss=359MB   9.43 ms/spawn      -> 7x more expensive
```

PR #39 replaced the in-memory project store with uncached SQLite reads.
`getAllProjects()` now assembles a **fresh object graph of 11 projects /
129 worktrees / 237 sessions on every call** (`state/project-store.ts`
`assembleProject`, N+1 queries, a fresh `db.prepare()` each time). It is
called from:

- every HTTP route that resolves a worktree/session (`findWorktreeContext`,
  `routes/worktrees.ts:800`, `routes/sessions.ts:143`),
- **every WS frame** — `ws/handlers/sessionLookup.ts` `findSessionRecord()`
  is called by `session:open`, `session:resize` and `session:input`, i.e.
  **once per keystroke**, and it linearly scans every project's every
  worktree's every session,
- `pollAll()` every second,
- `tree:watch` / `file:watch` handlers.

Measured cost: 3.5 ms of synchronous, event-loop-blocking work per call
(`/tmp/vstbench/bench.mjs`). Pre-PR the same call was
`Array.from(store.values())` on an in-memory `Map`.

The resulting allocation churn drives daemon RSS to ~327 MB (measured on the
isolated instance with no agents attached), which multiplies the pre-existing
poller's per-spawn cost ~7×, tipping it from ~7% of the main loop to >50%.

**Causal chain:** uncached SQLite reads → allocation churn → large RSS →
`fork()` per `tmux has-session` becomes ~9 ms of main-thread time → 230/s →
main loop blocked ~50% of the time in ~1 s chunks → every WS frame and HTTP
request queues behind it.

Note the WAL was ruled out explicitly: growing the WAL from 0 → 4 MB does not
change read latency (`/tmp/vstbench/walbench.mjs`, 3.7 ms → 3.5 ms).

### The crash (symptom 1's proximate cause)

`/tmp/vst-daemon.log` ends with:

```
node:events:486
      throw er; // Unhandled 'error' event
Error: read ECONNRESET
    at Pipe.onStreamRead (node:internal/stream_base_commons:216:20)
Emitted 'error' event on Socket instance
```

The daemon **died** after ~7 minutes. The `vst-control` tmux transcript shows
the user asking for a daemon restart four separate times. A dead daemon
explains symptom 1 exactly, including the detail that touch and scroll are
dead too: xterm is mounted and shows old scrollback, but every interaction
path — keystrokes, `attachTouchScroll` (which sends tmux copy-mode keys), and
the jump-to-latest button — is a WS round-trip to the daemon.

The unhandled `error` is on a **child-process stdio pipe**. `child.on("error")`
does not catch stream errors on `child.stdout`; several places consume a
child's stdout with no `error` listener:
`services/fileList.ts:131` (`rg --files`), and the readline consumers in
`agent-plugins/claude.ts:499`, `agy.ts:443`, `cursor.ts:343`,
`opencode.ts:307`. This is pre-existing (one occurrence in the historical
log), but it is firing constantly now, and the >50% main-loop saturation
makes abrupt child teardown far more likely.

### Symptom-by-symptom attribution

| symptom | cause |
|---|---|
| 1 — terminal totally dead (keys/touch/scroll) | daemon crashes on unhandled child-pipe `ECONNRESET`; while it *is* alive, WS frames queue behind ~1 s main-loop blocks, and every keystroke additionally pays a full-store scan in `findSessionRecord` |
| 2 — slow agent-tab switch | a tab switch is `session:close` + `session:open` over WS; both go through `findSessionRecord` (full store assemble) and both land in the middle of the poller's main-loop blocks |
| 3 — tab bar slow / second session missing | tab strip renders off `GET /sessions?worktree=` (19× slower) and the `session:created` WS broadcast; both queue behind the same blocks. The "missing second session" is the strip rendering before the delayed response/broadcast arrives |

---

## Review feedback incorporated (fable reviewer)

- **Accepted:** `capture-pane` also spawns per tick and survives F2 (~61 spawns/s
  remain). Target relaxed from "<2%" to "measure and report"; the overlap guard
  is promoted from afterthought to load-bearing.
- **Accepted:** symptom 3 has a real client-side lost-update race, not just
  latency → new **F6**.
- **Accepted:** write amplification (full project rewrite per lifecycle flip)
  → new **F5**.
- **Accepted:** the RSS narrative rested on an unmeasured pre-merge baseline.
  Native `db.prepare()` churn (better-sqlite3 `Statement`s are native objects
  finalized only on GC, invisible to V8 heap pressure) is the likelier RSS
  driver than V8 allocation churn. F1's statement caching fixes that variant
  too, so the fix is robust either way — but RSS is now measured before/after
  rather than asserted.
- **Accepted:** `listSessions()` swallows all errors and returns `[]`, so one
  transient tmux failure would mass-mark every session exited. F2 must
  distinguish "no server running" from an unexpected error and skip the tick.
- **Accepted:** blanket `uncaughtException` "keep running" is wrong. F4 now
  allowlists only `EPIPE`/`ECONNRESET` on pipe streams; anything else logs and
  exits.
- **Accepted:** verification must exercise the reported symptoms (WS keystroke
  round-trip, tab-switch), not only daemon-internal counters.
- **Noted, not changed:** `has-session -t` does prefix/target matching while a
  `Set.has()` is exact. Verified against live data that all 61 alive sessions
  match tmux `list-sessions` output exactly, and generated names contain no
  `.`/`:` that tmux would rewrite, so exact matching is correct here.
- **Rejected (scope):** a separate id→session index for F3. With F1 in place
  `findSessionRecord` scans ~366 in-memory objects (microseconds); an extra
  index is redundant state to keep in sync for no measurable gain.
- **Verified, not assumed:** nothing outside the daemon opens
  `vibe-station.db` — the `vst` CLI is HTTP-only (`cli/src/lib/daemon-client.ts`)
  and has no `better-sqlite3` usage; the daemon holds an exclusive lockfile.
  Single-writer holds, so a process-local cache is safe.

## Fixes

### F1 — `state/project-store.ts`: cache reads in memory again (primary)

SQLite stays the durable source of truth; add a process-local cache in front
of it. The daemon holds `~/.vibe-station/.daemon.lock`, so it is the only
writer — a process-local cache cannot go stale from outside.

- Load all projects into a `Map<string, ProjectRecord>` lazily on first read.
- `getProject` / `getAllProjects` serve from the map (no clone — this is the
  hot path).
- `mutateProject` passes a **clone** to `fn` and installs the result into the
  cache only after the transaction commits, so a throwing `writeProjectFull`
  cannot leave a mutation in the cache that never reached the DB.
- Under vitest (`NODE_ENV === "test"`) deep-freeze cached records, so any
  caller that mutates a returned record in place fails loudly in tests instead
  of silently corrupting the cache in production.
- Cache the prepared statements per `Database` handle instead of calling
  `db.prepare()` on every query (also removes the native-`Statement` churn
  that is the likeliest RSS driver).
- Tie the cache to the `Database` handle identity, so `getDb()` reopening a
  different path (per-test temp DBs) drops it automatically; also cleared by
  `_clearStoreForTest()` and after `loadAll()`'s migration writes rows directly.

**Verify:** `getAllProjects()` drops from 3.5 ms to <0.01 ms; daemon RSS
measured before/after; existing `project-store.test.ts` still passes.

### F2 — `services/lifecycle.ts`: kill the spawn storm (primary)

- **One** `tmux list-sessions -F '#{session_name}'` per tick, into a `Set`;
  `pollSession` tests membership instead of spawning `has-session` per
  session. 230 spawns/tick → 1.
- The liveness probe must distinguish **"no server running"** (authoritative:
  every session really is gone) from **any other tmux failure** (transient).
  On an unexpected failure, skip the tick entirely — otherwise one hiccup
  mass-marks 200+ sessions exited, each with a broadcast and a project rewrite.
- Return early for `done` / `exited` sessions **before** the liveness check.
  Traced and confirmed behaviour-neutral: today those states fall through to
  no-ops after the check either way.
- Guard against overlapping ticks (load-bearing — `setInterval` + async
  `pollAll` is what lets a slow tick compound into multi-second blocks).

**Verify:** re-profile. `capture-pane` still spawns once per tick per
`working`/`idle` agent session (~61/s) and is NOT removed here, so the target
is "spawn self-time down from 50.8% to under ~10%", with the residual
attributed to `capture-pane` and reported honestly.

### F3 — session lookup

`findSessionRecord` stays a scan, but with F1 it scans in-memory objects
(~366 iterations) instead of re-querying SQLite. No separate index.

### F4 — crash containment

- Attach `error` handlers to every child-process stdio stream the daemon
  consumes: `services/fileList.ts` (`rg --files` stdout) and the four agent
  plugins' `createInterface(child.stdout)` consumers (`claude.ts`, `agy.ts`,
  `cursor.ts`, `opencode.ts`), plus their `stderr`/`stdin`.
- Last-resort `process.on("uncaughtException")` in `main.ts` that **only**
  swallows `EPIPE`/`ECONNRESET` (the diagnosed child-pipe class) and logs the
  code + stack. Any other uncaught exception is logged and then re-thrown /
  exits, because resuming from arbitrary corrupted state is unsafe. Add
  `unhandledRejection` logging too — the process currently has neither.
- The crash attribution is **plausible but unproven** (one occurrence in the
  556 MB historical log, one in the 7-minute post-merge run). The added
  logging is how it gets confirmed, not optional polish.

### F5 — `services/lifecycle.ts` + `project-store.ts`: stop rewriting the world per state flip

`persistLifecycleState` → `mutateProject` → `writeProjectFull` deletes and
re-inserts **every** worktree and session row of a project to flip one
session's `state`. Add a targeted `updateSessionLifecycle(projectId,
sessionId, lifecycle)` doing a single `UPDATE sessions SET state = ?, reason =
?, lastTransitionAt = ? WHERE id = ?` plus an in-place cache patch; keep
`mutateProject`'s full replace for structural changes.

### F6 — `web-ui/TabsStrip.tsx`: fix the lost-update race (symptom 3's "missing session")

`TabsStrip`'s effect calls `api.listSessions(worktreeId)` and, on resolve,
**replaces** the list with `setSessions(ss)`. The `session:created` WS handler
appends to the same list. If the broadcast lands while the fetch is in flight
and the fetch's server snapshot predates the insert, the resolve overwrites
the list *without* the new session — and nothing invalidates it, so the tab
stays missing until the next refetch. Multi-second latency blows the window
wide open, but the race exists at any latency and none of F1–F5 fix it.

Fix: track sessions that arrived via `session:created` while a fetch was in
flight and union them into the fetch result instead of blind-replacing.

---

## Verification RESULTS

A/B on an identical harness: isolated daemon (`HOME=/tmp/vstfake`) seeded with a
copy of the real `vibe-station.db` (11 projects / 129 worktrees / 237 sessions),
real worktree dirs symlinked in, polling the real tmux server. Same machine,
same data, only the build differs.

### CPU profile (`--cpu-prof`, 45 s)

| | before | after |
|---|---|---|
| `child_process.spawn` self-time | **50.8%** (24.9 s) | **5.0%** (2.4 s) |
| idle | 42.5% | **93.4%** |
| `project-store` / `assembleProject` / `better-sqlite3 prepare` | present | gone from the profile |

The residual 5% is `capture-pane`, which F2 deliberately does NOT remove (it
still runs once per tick per `working`/`idle` agent session, ~61/s). Reviewer
was right that it survives; it is now the largest remaining item and a
reasonable follow-up.

### WS frame round-trip — the keystroke / tab-switch path

200 pings over 20 s under live poller load:

| | before | after |
|---|---|---|
| p50 | 0.6 ms | 0.6 ms |
| **p90** | **50.6 ms** | **0.8 ms** |
| p99 | 91.3 ms | 36.2 ms |
| frames actually serviced in 20 s | **127 / 200** | **200 / 200** |

The dropped/delayed 73 frames are the measurable form of "typing feels dead"
and "switching tabs is slow": frames sat behind the poller's main-loop blocks.

### Routes

| route | before | after |
|---|---|---|
| `/worktrees/:id/tree` | 5.0–20.3 ms | 0.9–1.8 ms |
| `/sessions?worktree=` | 3.9–6.1 ms | 0.6–1.6 ms |
| `/sessions` (all) | 5.3–6.5 ms | 1.2–2.3 ms |

Note the sandbox is much lighter than the user's live daemon (no attached
terminals, no live agents), so the *before* column here understates production,
where `/tree` p50 was 2260 ms. Direction and magnitude match.

### Memory

RSS after 60 s idle: **300 MB → 151 MB**; during the probe **266 MB → 141 MB**.
This is the link in the chain the reviewer challenged, now measured rather than
asserted — and it confirms native prepared-statement churn was a major driver,
since statement caching is most of what changed here.

### Suites

- `cd cli && npx vitest run` — 62 files, **589 passed**. (One "unhandled
  rejection" is reported; verified by stashing the change that it is
  **pre-existing on `main`**, in `sessions.test.ts`'s deliberate spawn-failure
  test.)
- `cd web-ui && npx vitest run` — 56 files, **321 passed**.
- `npx tsc -b --noEmit` clean in both packages.

The F6 regression test was verified to FAIL against the unfixed component
before being kept.

## Verification plan (as designed)

- **Repro/measure:** isolated daemon (`HOME=/tmp/vstfake`) seeded with a copy
  of the real `vibe-station.db` (11 projects / 129 worktrees / 237 sessions)
  and the real worktree dirs symlinked in. Confirmed it reproduces ~1 s
  main-loop blocks (`tree` and `changed-paths` both spiking to ~0.98 s in the
  same sample). Re-run `--cpu-prof` after the fix.
- **Targets:** `spawn` self-time <2% (from 50.8%); `/tree` p50 back to
  single-digit ms; `/sessions?worktree=` back to <1 ms.
- **Regression tests:**
  - `project-store`: repeated `getAllProjects()` issues no additional SQL
    after the first call, and a `mutateProject` write is reflected in the
    next read (cache invalidation).
  - `lifecycle`: one poll tick issues exactly one tmux liveness call
    regardless of session count; `done`/`exited` sessions are never probed.
  - `sessionLookup`: resolves worktree AND direct sessions (guard the
    documented direct-session trap) without a full scan.
  - `fileList`: a child stdout `error` does not reject/throw out of the
    promise.
- **Suites:** `cd cli && npx vitest run`, `cd web-ui && npx vitest run`,
  `npx tsc -b --noEmit`.

---

## Explicitly NOT fixed here (found, but out of scope / not the reported bugs)

- ~123 orphaned `vst-repo-*-t-*` tmux sessions on the host, created in bursts
  of 3 between Aug 7 and now. They match the daemon test suite's project
  fixture (`repo`), i.e. the tests leak real tmux sessions. Test-hygiene bug,
  worth a follow-up.
- The UI polls `GET /sessions/ipo-1-a1` every ~9 s and gets a 404 every time,
  both pre- and post-merge — a stale persisted `activeSessionId` that is
  never cleared. Cosmetic, pre-existing.
