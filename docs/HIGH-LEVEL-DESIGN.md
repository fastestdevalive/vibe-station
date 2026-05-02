# viberun-ide — High-Level Design

> v1 design covering persistence, plugins, tmux, lifecycle, and the finalized API contract. Patterns mirror agent-orchestrator (AO) where noted; AO file refs use `ao:` prefix.

## 1. System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                          BROWSER (SPA)                           │
│  React 19 + Vite + 100gb tokens                                  │
│  Layout (4 panes) · Dialogs · xterm.js · md/mermaid renderer     │
└────────────┬───────────────────────────┬─────────────────────────┘
             │ REST (localhost)          │ WebSocket (/ws)
             ↓                           ↓
┌──────────────────────────────────────────────────────────────────┐
│                          vrun DAEMON                             │
│  Fastify + ws · in-memory state ⇄ atomic JSON writes             │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐    │
│  │ tmux    │  │ worktree │  │ plugin   │  │ file/diff/git  │    │
│  │ adapter │  │ manager  │  │ registry │  │ services       │    │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └────────┬───────┘    │
└───────┼─────────────┼─────────────┼─────────────────┼────────────┘
        ↓             ↓             ↓                 ↓
    tmux server   git CLI    [claude|cursor|       local fs
                              opencode plugins]
        ↑
        │ user input via terminal
┌──────────────────────────────────────────────────────────────────┐
│  vrun CLI (binary, same package as daemon)                       │
│  `vrun project add <path>`, `vrun worktree create`, …            │
└──────────────────────────────────────────────────────────────────┘
```

## 2. Persistence

- **JSON files only.** No SQLite for v1.
- **One file per project**: project metadata + all its worktrees + all their sessions live inline in a single `manifest.json`. We don't split by worktree or session.
- **CLIs own their transcripts** — we never write chat history ourselves. Each session record carries a `transcriptRef` pointing to the CLI's native storage (e.g. claude's jsonl, opencode's session id). Plugins read these directly.
- Layout:
  ```
  ~/.viberun/
    config.json                    # daemon port, defaults, version
    modes.json                     # all agent modes (≤10)
    projects/
      <project-id>/
        manifest.json              # project + worktrees[] + sessions[] (everything)
        worktrees/
          <worktree-id>/           # actual git worktree checkout — clean, cd-able, no metadata pollution
    logs/daemon.log
  ```
- `<project-id>` = slugified project name (e.g. `viberun-ide`). **No hash.** On name collision at add time, CLI errors and requires `--name=<override>`.
- `manifest.json` shape:
  ```json
  {
    "id": "viberun-ide",
    "absolutePath": "/home/gb/code/.../viberun-ide",
    "prefix": "vibe",
    "defaultBranch": "main",
    "createdAt": "...",
    "worktrees": [
      {
        "id": "wt-vibe-1",
        "branch": "fix-auth-bug",
        "baseBranch": "main",
        "baseSha": "a3f2b1c...",
        "createdAt": "...",
        "sessions": [
          {
            "id": "...",
            "slot": "m",
            "type": "agent",
            "modeId": "...",
            "tmuxName": "vr-vibe-1-m",
            "lifecycle": { "state": "working", "reason": "...", "lastTransitionAt": "..." },
            "transcriptRef": { "kind": "claude-jsonl", "path": "~/.claude/.../sess.jsonl" }
          }
        ]
      }
    ]
  }
  ```

## 3. Server State Strategy

- On daemon boot: read `projects/*/manifest.json` → load each into `Map<ProjectId, ProjectRecord>` in memory. Sessions accessed via `project → worktree → session` traversal.
- All reads from memory.
- All mutations: validate → mutate memory → atomic write of the affected project's `manifest.json` (`.tmp` + fsync + rename).
- One in-memory mutex per project — serializes writes within a project. Different projects mutate concurrently.
- High-frequency state-only updates (lifecycle polling) are debounced: in-memory updates immediate, disk flush at most every 500ms per project.
- No file watcher in v1 — daemon is sole writer.

### Metadata I/O timing & performance

A common AO complaint is intermittent slowness from disk thrash (per-session file storms, no debouncing). Our model is intentionally engineered to avoid those — here's the exact read/write cadence:

```
═══════════════════════════════════════════════════════════════════════
  PHASE                READ                  WRITE                FREQ
═══════════════════════════════════════════════════════════════════════

╭─ BOOT (one-time per daemon process) ────────────────────────────────╮
│                                                                      │
│   ~/.viberun/projects/                                               │
│     proj-a/manifest.json  ──read──→  store.set("proj-a", record)    │
│     proj-b/manifest.json  ──read──→  store.set("proj-b", record)    │
│     proj-c/manifest.json  ──read──→  store.set("proj-c", record)    │
│                                                                      │
│   N reads · N = number of projects · O(KB) each · ~5ms total          │
╰──────────────────────────────────────────────────────────────────────╯

╭─ STEADY STATE — READS (every API call, render, poll tick) ──────────╮
│                                                                      │
│   store.get("proj-a")  ─ pure memory read ─ no fs syscall            │
│                                                                      │
│   Disk reads:  ZERO  during normal operation                         │
╰──────────────────────────────────────────────────────────────────────╯

╭─ STEADY STATE — WRITES (two categories) ────────────────────────────╮
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │ 1. STRUCTURAL CHANGES — write IMMEDIATELY                    │  │
│   │                                                               │  │
│   │    POST   /worktrees           ──┐                            │  │
│   │    DELETE /worktrees/:id         │                            │  │
│   │    POST   /sessions              │  1 atomic write per call   │  │
│   │    DELETE /sessions/:id          │  (~5 ms)                   │  │
│   │    POST   /projects              │                            │  │
│   │    PUT/DELETE /modes/:id         ──┘                          │  │
│   │                                                               │  │
│   │    Frequency: USER-DRIVEN (low — clicks/CLI invocations)     │  │
│   └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │ 2. STATE-ONLY UPDATES — debounced per project                │  │
│   │                                                               │  │
│   │    lifecycle poller ─ 1 Hz per session                        │  │
│   │       │                                                        │  │
│   │       ↓ for each session:                                     │  │
│   │   capturePane → recordActivity → getActivityState             │  │
│   │       │                                                        │  │
│   │       ↓                                                        │  │
│   │   IF state actually changed:                                  │  │
│   │      mutate memory                                            │  │
│   │      mark project dirty                                       │  │
│   │   ELSE: NO-OP (no memory write, no disk write)                │  │
│   │                                                               │  │
│   │   Per-project debouncer:                                      │  │
│   │      coalesce dirty mark for 500 ms                           │  │
│   │      then write project's manifest once                       │  │
│   │                                                               │  │
│   │    Worst case: 1 disk write / project / 500 ms                │  │
│   │    even if 50 sessions in that project all polling            │  │
│   └──────────────────────────────────────────────────────────────┘  │
╰──────────────────────────────────────────────────────────────────────╯

╭─ ATOMIC WRITE SEQUENCE (used for both categories) ──────────────────╮
│                                                                      │
│   1. open  manifest.json.tmp  in same dir                            │
│   2. write JSON                                                      │
│   3. fsync                                                           │
│   4. rename → manifest.json   (atomic on POSIX)                      │
│                                                                      │
│   ~3-5 ms typical on local SSD · zero risk of partial-write          │
╰──────────────────────────────────────────────────────────────────────╯

╭─ CONCURRENCY ───────────────────────────────────────────────────────╮
│                                                                      │
│   Mutex granularity: ONE PER PROJECT (not global, not per-session)   │
│                                                                      │
│   project-a writes ─ serialized                                      │
│   project-b writes ─ serialized                                      │
│   project-a   vs   project-b ─ run in parallel                       │
│                                                                      │
│   No global lock = no AO-style write storm contention                │
╰──────────────────────────────────────────────────────────────────────╯

╭─ WORST-CASE LOAD MODEL ─────────────────────────────────────────────╮
│                                                                      │
│   10 projects × 5 worktrees/project × 5 sessions/worktree            │
│     = 250 sessions polling at 1 Hz                                   │
│     = 250 in-memory state checks/sec                                 │
│                                                                      │
│   ~5% transition rate (sessions are mostly stable)                   │
│     ≈ 12 actual state changes/sec                                    │
│                                                                      │
│   With 500ms debounce:                                               │
│     ≤ 20 disk writes/sec (1 per project per 500ms cap)               │
│     × ~10 KB per manifest                                            │
│     = ≤ 200 KB/sec sustained                                         │
│                                                                      │
│   On typical NVMe: 200 KB/sec is ~0.001% of write throughput.         │
│   Daemon CPU spent on JSON.stringify dwarfs disk cost.               │
╰──────────────────────────────────────────────────────────────────────╯
```

### Anti-patterns avoided (cf. AO slowness reports)

| AO problem | Cause | viberun-ide approach |
|---|---|---|
| Per-session JSON files (250+ on disk) inflate fs metadata cost | One file per session | One `manifest.json` per project (10 files, not 250) |
| Reads disk on every API call | No in-memory cache | Boot-time load → memory cache; reads never touch disk |
| State writes thrash on every poll tick | No debouncing | 500ms per-project debouncer; idempotent no-op when state unchanged |
| Global write lock serializes everything | Single mutex | Per-project mutex; cross-project parallelism preserved |
| Synchronous fs in hot path | `readFileSync` mid-handler | All fs is async; reads happen at boot only |
| Unbounded write queue under high transition rate | Naive write-on-change | Coalescing debouncer means writes can never exceed 2/sec/project |

## 4. Plugin Architecture

Mirrors `ao:packages/core/src/types.ts:448-543`.

```ts
interface AgentPlugin {
  readonly name: 'claude' | 'cursor' | 'opencode';
  readonly displayName: string;
  readonly promptDelivery: 'inline' | 'post-launch';

  getLaunchCommand(cfg: LaunchConfig): string;
  getEnvironment(cfg: LaunchConfig): Record<string, string>;

  // State detection — TWO paths because not every CLI has a queryable session API.
  // claude has a JSONL session file → uses getActivityState directly.
  // cursor/opencode have no native session API → daemon polls pty output via
  // recordActivity, plugin's detectActivity computes the state from accumulated text.
  getActivityState(session: SessionRecord, idleMs?: number):
    Promise<{ state: 'working' | 'idle' | 'done' | 'exited'; reason?: string }>;
  detectActivity?(terminalOutput: string):
    'active' | 'idle' | 'waiting_input' | 'unknown';
  recordActivity?(session: SessionRecord, terminalOutput: string): Promise<void>;
  isProcessRunning(handle: TmuxHandle): Promise<boolean>;

  // First-ready signal: how the daemon knows the agent has booted enough to receive
  // post-launch input (for the optional `prompt` and for `vrun send`). Either:
  //   - a substring sentinel the plugin expects in pty output, OR
  //   - a fallback wait time in ms (after which we assume ready).
  getReadySignal(): { sentinel?: string; fallbackMs: number };

  getRestoreCommand?(session: SessionRecord): Promise<string | null>;
  setupWorkspaceHooks?(workspacePath: string): Promise<void>;
  getSessionInfo?(session: SessionRecord):
    Promise<{ summary?: string; cost?: number; lastMessageAt?: string }>;
}
```

Per-plugin specifics:
- **claude** — read JSONL sessions at `~/.claude/projects/<encoded-path>/`. `getActivityState` queries the latest jsonl. Restore via `claude --resume <id>` (returned from `getRestoreCommand`). Hooks via `<wt>/.claude/settings.json` PostToolUse (mirrors `ao:packages/plugins/agent-claude-code/src/index.ts:34-212`). `getReadySignal: { sentinel: "Claude>", fallbackMs: 3000 }`.
- **cursor** — no native session API. `detectActivity`/`recordActivity` parse pty output (cf. `ao:packages/plugins/agent-cursor/src/index.ts:234-266, 312-317`). **`getRestoreCommand` returns `null`** — cursor doesn't support resume. Resume falls back to a fresh launch (see §6).
- **opencode** — `getActivityState` keys off `opencodeSessionId` if present; otherwise falls back to `detectActivity` from pty. `getRestoreCommand` returns the resume invocation if a session id was captured.

Registration: builtin loader at daemon boot (`packages/core/registry.ts`).

### Tracker plugins — v1.1 (deferred)

Issue-tracker integration (GitHub/Linear/GitLab) is moved to v1.1. v1 ships without trackers; the architecture has the plugin slot reserved (will be added alongside `AgentPlugin` later).

### Prompt builder (3-layer system prompt + task prompt)

Mirrors `ao:packages/core/src/prompt-builder.ts`. Lives at `packages/core/src/promptBuilder.ts`. Composes a layered prompt for every agent spawn:

```
{ systemPrompt, taskPrompt? } = buildPrompt({
  project, worktree, modeContext?, userPrompt?
})
```

| Layer | Content | Source |
|---|---|---|
| **L1 — base** | "You are a viberun-ide-managed agent. Available CLI: `vrun project/worktree/session/send/...`. `VR_*` env vars are pre-set. Git workflow rules. PR best practices." | `packages/skill/skill.md` |
| **L2 — context** | Project name + path + default branch; current worktree branch + baseBranch + baseSha; sibling sessions in this worktree; mode-specific context (from the agent mode's `context` field) | Composed from project + worktree + mode |
| **L3 — rules** | Project rules from `<project>/AGENTS.md` or `<project>/.viberun/rules.md` (read at spawn) | File on disk |

Output:
- `systemPrompt` — concatenation of L1 + L2 + L3
- `taskPrompt` — user's `prompt` field if provided, else `undefined`

Each AgentPlugin gets a new method to render this:

```ts
composeLaunchPrompt(prompt: { systemPrompt: string; taskPrompt?: string }):
  { launchArgs?: string[]; postLaunchInput?: string };
```

- claude: returns `{ launchArgs: ['--system-prompt-file', '<tmpfile>'], postLaunchInput: taskPrompt }`
- cursor / opencode: returns `{ postLaunchInput: systemPrompt + '\n\n' + taskPrompt }` (single blob via tmux send-keys after first-ready)

## 5. Tmux Strategy

- **One tmux session per tab** (not per worktree). Tabs are independent — kill/resume one without affecting siblings.
- Naming: `vr-{projectPrefix}-{worktreeNum}-{tabSlot}`
  - main: `vr-vibe-1-m`
  - agent N: `vr-vibe-1-a2`
  - terminal N: `vr-vibe-1-t1`
- `projectPrefix`: derived from project name (≤6 chars, lowercase alnum, AO rules from `ao:packages/core/src/paths.ts:64-87`).
- `worktreeNum`: monotonic per project.
- `tabSlot`: stable across daemon restarts: `m` (main; fixed), `a{n}`, `t{n}`. `n` is monotonic per worktree per type.
- **Prefix uniqueness** is enforced at project-add time. CLI computes the prefix from the project name; if it collides with an existing project's prefix, the CLI errors with: `Prefix 'ao' already used by project 'agent-orchestrator'. Pass --prefix=ao1 to override.`. **No hex disambiguator.**

### Worktree id + session num auto-assignment

Mirrors AO's `reserveNextSessionIdentity` (`ao:packages/core/src/session-manager.ts:790-828`):

- **Worktree id**: always machine-generated as `wt-{prefix}-{num}`. Never user-supplied. `num` is the smallest unused integer for that project.
  - Allocation: scan the project's `manifest.json` for existing worktree ids; pick `max(num) + 1`. Reservation is atomic via the in-memory project mutex.

### Session spawn ordering (canonical)

Pinned step order so `VR_*` env vars are populated before the agent process exists. Performed under the project's mutex:

1. **Reserve identity** — compute the next free worktree-id (or session slot for `POST /sessions`); mark reserved in memory.
2. **Persist record** — write `manifest.json` with the new worktree/session record at `lifecycle.state = "not_started"`.
3. **Setup hooks** — call plugin's `setupWorkspaceHooks?` if defined.
4. **Resolve env** — compute `VR_PROJECT`, `VR_WORKTREE`, `VR_SESSION`, `VR_DAEMON_URL`.
5. **Spawn tmux** — `tmux new-session -d -s <tmuxName> -e VR_SESSION=...` running the plugin's `getLaunchCommand`.
6. **Flip state** — `lifecycle.state = "working"` (or `not_started` until first ready signal observed; whichever the plugin prefers).

If step 5 fails after step 2 has written the manifest, the rollback in §"Worktree ↔ main-session invariant" runs.
- **Worktree name** (separate from id): optional user label. Defaults to the id if empty. Pure cosmetics — never used in paths, branches, or tmux names.
- **Session num** (per worktree, per type): same pattern. `n` in `a{n}` and `t{n}` is the smallest unused integer for that worktree+type. The `m` slot is fixed (one per worktree, allocated at worktree creation).

Implication for `POST /worktrees`: `name` and `branch` are optional fields in the request body.

### Branch name + creation (simple model)

A worktree always has exactly one branch. **The user always provides the branch name** at create time — no auto-generation, no slugification, no precedence chain.

| Input | Behavior |
|---|---|
| `branch` (required) | Validated against git's branch-safe regex (`^[a-zA-Z0-9][a-zA-Z0-9._/-]*$`, no `..`, ≤200 chars). Reject `400` with hint if invalid. |
| Specified name **already exists** in the repo | Reject with `409` — `Branch 'my-feature' already exists. Pick a different name.` |
| `baseBranch` omitted | Default to the project's default base. Detection chain at project-add: `git symbolic-ref refs/remotes/origin/HEAD` → `master` if exists locally → `main` if exists locally → first branch in `git branch --list` → reject `vrun project add` with `Could not detect default branch; pass --default-branch=<name>`. |
| `baseBranch` does not exist locally | Daemon fetches from origin if remote exists; otherwise rejects with `400`. |

**The branch name doubles as the worktree's display label** — it's what the sidebar and breadcrumb show. There is no separate `name` field.

**Git execution** (in this order):
1. `git fetch origin <baseBranch>` (best-effort; skipped if no remote)
2. `git worktree add -b <branch> <worktree-path> <baseBranch>`
3. The new branch is checked out in the worktree dir; HEAD == `<branch>` pointing to `<baseBranch>` HEAD.

**Stored in `manifest.json`** under the worktree record:
- `worktrees[i].branch` — the name of the branch checked out in this worktree (canonical, full-string).
- `worktrees[i].baseBranch` — the branch we forked from (used by file diff `scope=branch` to compute diffs against).
- `worktrees[i].baseSha` — **required in v1.** Snapshot of `<baseBranch>`'s SHA at fork time, captured via `git rev-parse <baseBranch>`. Used by `scope=branch` diff (`git diff <baseSha>...HEAD`) so the diff is stable even after the base branch advances. 40 bytes; one extra `git rev-parse` at create.

The branch name is **immutable for the worktree's lifetime** in v1 — to rename, delete the worktree and create a new one. (Renaming via `git branch -m` would be safe but adds API surface for a rare need.)

### Worktree ↔ main-session invariant

A worktree **always** has exactly one main session (slot `m`).

- **Creation is atomic**: `POST /worktrees` (and `vrun worktree create`) always provisions the git worktree AND spawns the main session in the same operation. There is no "worktree without sessions" state.
- The main session cannot be killed via `DELETE /sessions/:id` — that's rejected with `400`. The only way to end a main session is `DELETE /worktrees/:id`, which terminates all sessions including main and removes the checkout.
- After tmux death, the main session moves to `exited` state but the record persists; the worktree still has its main session, just paused. Resume re-spawns the tmux session in place.

**Rollback on creation failure** (atomicity guarantee):

If `git worktree add` succeeds but the main-session spawn fails (tmux unreachable, plugin's launch command fails, etc.), the daemon rolls back in this order:
1. Best-effort `tmux kill-session -t <tmuxName>` (in case partial spawn left a dead session).
2. `git worktree remove --force <worktree-path>` to delete the orphan checkout.
3. `git branch -D <branch>` if we created a fresh branch (skip if user passed an existing branch — though we currently reject existing-branch reuse with 409).
4. Remove the worktree record from `manifest.json`; release the reserved id back to the project's mutex.
5. Return `500` with `{ error, reason }` describing which step failed.

If rollback itself partially fails (e.g. `git worktree remove` errors), log the orphan path to `logs/daemon.log` and surface in `vrun doctor` for manual cleanup. Never leave the manifest pointing at a non-existent worktree.

### Initial prompt at creation

Both `POST /worktrees` and `POST /sessions` (when `type=agent`) accept an optional `prompt` field. The daemon delivers it to the new agent via the plugin's `promptDelivery` mode:

- `inline` — prompt is injected as a CLI flag in `getLaunchCommand` (e.g. `claude -p "..."`).
- `post-launch` — daemon waits for the agent to reach its first ready state, then writes the prompt via `tmux send-keys` to its pty.

The prompt is NOT stored on the session record after delivery — once sent, the agent's own transcript owns it.

## 6. Session Lifecycle

```
                 ┌───────────────┐
                 │  not_started  │
                 └──────┬────────┘
                        │ spawn
                        ↓
   user input     ┌───────────┐  no output for N ms
        ┌────────→│  working  │──────────────┐
        │         └─────┬─────┘              │
        │               │ explicit complete   │
        │               ↓                    ↓
        │         ┌───────────┐         ┌─────────┐
        │         │   done    │←────────│  idle   │
        │         └─────┬─────┘         └─────────┘
        │               │
        │  resume       │
        │               ↓
        │         ┌────────────┐
        └─────────│  exited    │ tmux session gone
                  └────────────┘
```

States: `not_started | working | idle | done | exited`.

Triggers:
- spawn → `not_started` → `working`
- PTY-output heuristic + plugin's `getActivityState` polled every ~1s → `working` ↔ `idle`
- per-plugin completion signal → `done`
- `tmux has-session` returns false → `exited` (= AO's `terminated + runtime_lost`)

Recovery on `exited`:
1. Daemon emits `session:exited` over WS.
2. UI shows banner with "Resume" button on the affected tab.
3. On click → daemon spawns a new tmux session.
4. Daemon calls plugin's `getRestoreCommand(session)`:
   - **Returns a string** (e.g. claude's `claude --resume <id>`) → daemon executes it via `tmux send-keys`. WS emits `session:resumed { restoredFromHistory: true }`. State → `working`.
   - **Returns `null`** (cursor; opencode without a captured session id) → daemon falls back to a fresh launch via `getLaunchCommand`. WS emits `session:resumed { restoredFromHistory: false }`. State → `working`. UI surfaces an inline note on the tab: `Chat history not restored — agent restarted fresh.`
5. The PRD goal "zero chat history loss" applies only when `restoredFromHistory: true` (claude, and opencode with captured id). For cursor, history loss on tmux death is a known v1 limitation.

### Worktree-level aggregate status (derived, not stored)

Sessions hold the authoritative state. The left-sidebar worktree row shows a single dot computed from its sessions on the fly:

```
worktree.status =
  "exited"  if any session.state === "exited"     // surface problems first
  "working" if any session.state === "working"    // active work next
  "done"    if all agent sessions are "done"      // wrapped up
  "idle"    otherwise
```

Notes:
- Terminal sessions have no agent state; they're skipped from the precedence except for the trailing `idle` fallback.
- Computed at render time from `worktree.sessions[]`. Nothing extra to persist.

## 7. Agent Context Injection

Two parallel mechanisms feed context to every agent spawn:

### 7a. Layered prompt (synchronous, one-shot)

The prompt builder (§4) composes `{ systemPrompt, taskPrompt }` from L1 (skill.md) + L2 (project/worktree/issue/mode context) + L3 (project AGENTS.md). Delivered via the plugin's `composeLaunchPrompt`:
- claude: `--system-prompt-file=<tmpfile>` for systemPrompt; taskPrompt sent post-launch.
- cursor/opencode: full systemPrompt+taskPrompt sent as one blob via tmux send-keys after `getReadySignal` fires.

### 7b. Skill file + hooks (filesystem, persistent across the session)

In addition to the inline prompt, the skill file is dropped on disk in the worktree so the agent can re-read it during long sessions:

- `packages/skill/skill.md` is copied (not symlinked, to survive worktree removal) to `<worktree>/.viberun/skill.md` at spawn time.
- Per-plugin hook setup runs once per spawn:
  - **claude**: write PostToolUse hook into `<wt>/.claude/settings.json` (mirrors `ao:packages/plugins/agent-claude-code/src/index.ts:34-212`).
  - **cursor**, **opencode**: equivalent install paths TBD per plugin.

### Env vars (set on every agent spawn)

| Var | Value |
|---|---|
| `VR_SESSION` | the agent's session id |
| `VR_WORKTREE` | worktree id |
| `VR_PROJECT` | project id |
| `VR_DATA_DIR` | `~/.viberun/projects/<project-id>` |
| `VR_DAEMON_URL` | `http://localhost:<port>` |

## 8. API Contract

The complete contract — CLI commands, REST endpoints, WebSocket events — lives in **`docs/API-CONTRACT.md`**. Single source of truth.

Summary of shape:
- **CLI** (noun-verb groups): `vrun project {add,rm,ls,info}`, `vrun worktree {create,rm,ls,info}`, `vrun session {create,ls,info,kill,attach,restore,output}`, `vrun send`, `vrun mode {ls,add,rm}`, `vrun daemon {start,stop,status,restart}`, `vrun open|status|doctor`. All `ls`/`info` accept `--json`. Agents inherit `VR_PROJECT`/`VR_WORKTREE`/`VR_SESSION`/`VR_DAEMON_URL` env vars; non-destructive commands default to those.
- **REST** (localhost, no auth in v1): CRUD for `/projects`, `/worktrees`, `/sessions`, `/modes`; file/diff/tree under `/worktrees/:id/...`; resume + full-message-send on `/sessions/:id/...`.
- **WebSocket** (`/ws`): three multiplexed channels — state subscription (`subscribe`), output stream (`session:open/input/resize/close`), file/tree watching (`file:watch`, `tree:watch`). Server pushes per-session lifecycle, output, file/tree mutations, and broadcast structural events.

## 9. File Preview & Diff

- Mirrors `ao-142/packages/web/src/components/workspace/DiffViewer.tsx`.
- Endpoint: `GET /sessions/:id/diff/*path?scope=local|branch`.
- `scope` is per-worktree state on client (default `local`); persisted to localStorage.
- `branch` target = base branch from worktree creation (stored on worktree). Not per-file selectable in v1.
- Size limits (VSCode defaults):
  - hard ceiling 50MB → 422
  - paginate >10MB
  - binary >1MB → 422 (no preview)
- Renderers: `marked` (markdown + GFM), `mermaid` (mermaid blocks), `shiki` (code highlight).

## 10. Modes

- Stored in `~/.viberun/modes.json` (single global file, max 10).
- Modal UI from `[⚙ Modes]` button — no dedicated route.
- Built-in presets baked into the web app:
  - `bug-fix-with-pr`: "You are fixing a bug. Open a PR when done. Run tests before committing."
  - `planning-no-pr`: "You are planning. Do not commit or open a PR. Output a written plan."
- Validation: name unique per user, ≤64 chars; context ≤10KB.

## 11. Project Lifecycle

- **Add**: `vrun project add <path> [--name=<id>] [--prefix=<prefix>]`. CLI calls daemon REST internally. Daemon validates:
  - `<path>` exists and is a git repo
  - project id (slugified name) is not already registered → 409 if duplicate
  - generated prefix does not collide with another project's prefix → 409 with the colliding project name
  - on 409, CLI surfaces the override hint (`--name=` or `--prefix=`).
- **Delete**: `vrun project rm <id>`. CLI prints confirmation prompt: `This will terminate N sessions and remove M worktrees. Type project name to confirm:`. Daemon then cascades: terminate sessions → remove worktree directories → delete `projects/<id>/`.
- No UI button in v1 — destructive ops on CLI surface only.

## 12. Folder Structure (Monorepo)

```
viberun-ide/
├── apps/
│   ├── web/                       # SPA (React + Vite)
│   └── cli/                       # `viberun` binary (incl. daemon subcommand)
├── packages/
│   ├── core/                      # types, plugin contracts, paths utils
│   ├── plugin-claude/
│   ├── plugin-cursor/
│   ├── plugin-opencode/
│   └── skill/                     # agent skill markdown + hook scripts
├── docs/
│   ├── HIGH-LEVEL-DESIGN.md       # this file
│   └── TECH-STACK.md
├── .feature-plans/
│   ├── viberun-ide-prd.md
│   ├── viberun-ide-ui-plan.md
│   └── scratch-design.md
├── package.json                   # workspace root
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

CLI + daemon share a package: `apps/cli` exposes both one-shot subcommands (`vrun project ...`, `vrun worktree ...`, `vrun session ...`, etc.) and the long-running daemon (`vrun daemon start`). Single Node binary.

## 13. Module Boundaries

- `apps/web` ⇄ `apps/cli` (daemon mode): REST + WS over localhost.
- `apps/cli` (one-shot mode) ⇄ `apps/cli` (daemon mode): REST. CLI auto-spawns daemon if not running.
- `apps/cli` uses `packages/core` types + `packages/plugin-*` for CLI adapters.
- `packages/skill` is data-only (markdown + bash scripts); read by plugins.

## 14. v1 Out of Scope (deferred to v1.1)

- Auth (browser ↔ daemon token handshake)
- Mobile app code
- Cloud sync for modes
- **Tracker plugins** (`tracker-github`, `-linear`, `-gitlab`) — issue lookup, branch-name derivation, issue context in L2 prompt
- **Auto-push branches to remote on worktree create** + draft PR creation
- **Agent-side metadata reporting** (e.g. AO's `ao acknowledge`, `ao report ...` commands and PostToolUse hook). Daemon polls `getActivityState` for state in v1.
- Git integrations beyond local worktree (PR open, branch UI, GitHub auth)
- Dedicated settings screen (font/mode persisted via localStorage; toggles live in top bar)
- File watcher / live tree updates (manual refresh on tab focus only)
- Tab reordering, keyboard shortcuts beyond browser defaults

## 15. Deferred for Module-Level Design

See `.feature-plans/scratch-design.md`. Specifically still unresolved (none block the UI build):
- per-plugin resume command for cursor / opencode
- per-plugin transcript discovery (where each CLI writes its session files)
- session output byte streaming format (utf8 vs base64 fallback rules) + chunk size cap
- terminal output replay/backpressure on browser reconnect (live-only? last-N-bytes scrollback?)
- daemon port collision handling (auto-pick free port + write to `config.json`)
- worktree branch creation semantics (create-if-missing vs reject)
- modes.json default seed (ship presets baked into web app vs daemon-side)
