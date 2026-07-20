# Agent Chat-ID Capture

How the daemon learns each CLI's own conversation/session identifier
(`SessionRecord.agentChatId`) — the value that lets a session resume the
**same** underlying CLI conversation across a daemon restart, a terminal
`/resume`, or a JSON↔terminal channel toggle. Read this before touching
`provideChatId` / `captureChatId` / `refreshChatIdOnToggle` on any plugin
(`daemon/src/agent-plugins/*.ts`) or the spawn/toggle call sites
(`daemon/src/services/spawn.ts`, `daemon/src/routes/sessions.ts`).

`agentChatId` is the one piece of state that has to survive every transition
a session can go through — fresh spawn, resume, and a live channel toggle in
either direction — because it's the only thing that tells the CLI "continue
*this* conversation" instead of starting a new one. Get it wrong and the
failure is silent: the CLI happily resumes *some* conversation, just not the
right one (see [Historical note](#historical-note--the-agy-investigation)).

## Summary

| CLI | Pre-mint before spawn? | Terminal-start capture | JSON-turn self-report | Toggle self-heal (tty→json) | Resume/restore self-heal (→tty) |
|---|---|---|---|---|---|
| **claude** | No | `SessionStart` hook → session-scoped token file, single read | `session_init.agentChatId` every turn (adopted only if unset) | Not implemented — not needed | `captureChatId`, only if unset |
| **cursor** | **Yes** — `cursor-agent create-chat` | N/A — id already known before spawn | `session_init.agentChatId` every turn (adopted only if unset) | Not implemented — not needed | Not implemented — not needed |
| **opencode** | No | plugin hook (`session.created`) → session-scoped token file, polled 30s/500ms | `session_init.agentChatId` every turn (adopted only if unset) | Not implemented — not needed | `captureChatId`, only if unset |
| **agy** | No | none (no hook exists) at spawn; **`captureChatId` polls a per-session `--log-file`**, 30s/500ms | `session_init.agentChatId` every turn (adopted only if unset — see caveat) | **`refreshChatIdOnToggle`**, unconditional overwrite, single read of the same log | `captureChatId`, only if unset (same log-file poll) |

"Adopted only if unset" is the daemon-core rule in `handleEvent`
(`daemon/src/services/jsonAgent.ts:834-847`): a `session_init` event's
`agentChatId` is only written into the session record when
`!this.session.agentChatId` (or during an active `--fork-session`, R3.2).
This means agy's every-turn self-report is **not** an ongoing correction
mechanism — it only ever helps the very first JSON turn of a session that
had no id yet. If a wrong id is already on record, later turns' self-reports
do not fix it; they just keep confirming whatever conversation that
(possibly wrong) id points to.

## Why the mechanisms differ per CLI

Each plugin's method is CLI-specific by design (`daemon/src/agent-plugins/*.ts`
— never branch on CLI name in core code, per the plugin architecture rule).
What differs is **how much each CLI is willing to tell the daemon about its
own state**, which falls into three shapes:

1. **The daemon decides, the CLI is told** (cursor) — cleanest possible: no
   capture step exists because there's nothing to discover. The daemon mints
   the id itself before the CLI ever runs.
2. **The CLI proactively reports, via a purpose-built extension point**
   (claude, opencode) — a hook the CLI vendor built specifically so an
   external tool can learn "a new conversation was just created," fired the
   moment it happens, scoped to that one process (keyed by a spawn token /
   session id).
3. **The daemon has to infer it from the CLI's own output, because no hook
   exists** (agy) — the least reliable of the three, and worth being
   skeptical of by default. See the historical note below for what actually
   went wrong here.

## Per-CLI detail

### claude

- **Terminal spawn:** `setupWorkspaceHooks` (`claude.ts:278-331`) writes a
  `SessionStart` hook (`vibe-recorder.sh`) into the worktree's `.claude/`
  dir. The hook fires when claude's TUI starts a session and writes the
  chat id to `<worktree>/.vibe-station/agent-chat-ids/<session.id>` — keyed
  by our own session id, so it's inherently session-scoped, no cross-session
  ambiguity possible.
- **Capture:** `captureChatId` (`claude.ts:375-390`) does a **single,
  unretried** read of that file, then deletes it. If the hook hasn't fired
  yet, this fails safe: ENOENT → `null` (a session-scoped file that doesn't
  exist yet just doesn't exist — it can never resolve to someone *else's*
  id, unlike a shared/global file would).
- **JSON turns:** `runTurn` (`claude.ts` ~L410-430) passes `--resume
  <chatId>` when `ctx.chatId` is set. Every turn's `session_init` reports
  `agentChatId` from the harness's own `session_id` field.
- **Toggle / resume:** no `refreshChatIdOnToggle` (not needed — capture is
  already reliable). `/resume` and the json→tty restore path both call
  `captureChatId` as a **self-heal only** (guarded: `if
  (!session.agentChatId)`, `sessions.ts:842-850` / `:1445-1451`) — never
  overwrites an already-known id.

### cursor

- **Terminal spawn:** `provideChatId` (`cursor.ts:380-387`) calls
  `cursor-agent create-chat` and returns the minted id **before** the agent
  process even launches (`spawn.ts` Step 2.5, runs before Step 5 spawn).
  `getLaunchCommand` (`cursor.ts:234-245`) then passes `--resume <id>`
  immediately — the CLI is told which conversation to use, not asked to
  report one back.
- **Capture:** none — `captureChatId` isn't implemented for cursor at all.
  There's nothing to capture; the id was already known.
- **JSON turns:** `runTurn` (`cursor.ts:324`) passes `--resume <chatId>`.
  Every turn's `session_init` reports `agentChatId` too (same shape as the
  other CLIs), though in practice it's just confirming the id the daemon
  already minted.
- **Toggle / resume:** no `refreshChatIdOnToggle`, no self-heal capture
  needed either — the id is authoritative from the moment of creation.

### opencode

- **Terminal spawn:** `setupWorkspaceHooks` (`opencode.ts:349-381`) writes a
  real plugin file (`@opencode-ai/plugin`) into `.opencode/plugins/`, hooking
  `session.created` — fires when the TUI's first chat is actually created,
  which can be **after** the ready sentinel (opencode's own comment: "may be
  after the ready sentinel"). Writes to the same
  `.vibe-station/agent-chat-ids/<session.id>` convention as claude.
- **Capture:** `captureChatId` (`opencode.ts:383-407`) **polls** that file
  for up to 30s at 500ms intervals (unlike claude's single read) — this is
  the shape agy's fix (below) was modeled on. Deletes the file on success.
  ENOENT during the poll just means "not yet," not "wrong" — same
  session-scoped safety property as claude.
- **JSON turns:** `runTurn` (`opencode.ts:296`) passes `--session <chatId>`.
  Every turn's `session_init` reports `agentChatId` (`opencode.ts:94`).
- **Toggle / resume:** no `refreshChatIdOnToggle` (not needed). `/resume`
  and json→tty restore both self-heal-only (`captureChatId`, guarded by
  `if (!session.agentChatId)`), same as claude.

### agy

agy is the odd one out: **no hook mechanism exists** for it (confirmed —
`setupWorkspaceHooks` isn't implemented in `agy.ts` at all), and it has no
`create-chat`-style pre-mint command either. Everything here is inferred
from agy's own output after the fact, which is why this is the CLI with the
most machinery and the most caveats.

- **Terminal spawn:** `getLaunchCommand` (`agy.ts`) appends `--log-file
  ~/.vibe-station/agy-logs/<session.id>.log` — a real agy CLI flag
  (`agy --help`: "Override CLI log file path"), pointed at a path unique to
  this session. This is agy's own general-purpose internal debug log
  (glog-style: timestamps + source file:line + message), **not** a
  purpose-built API — we're reading operational log lines that happen to
  mention the conversation id (`Created conversation <id>`, `Streaming
  conversation <id>`), not a documented, stable contract.
- **Capture:** `captureChatId` calls `pollLogForConversationId` (30s/500ms,
  same shape as opencode's poll) against that log file.
  `parseLastConversationIdFromLog` prefers the **last** `Streaming
  conversation <id>` line (fires on every turn, so it reflects the *current*
  conversation even after a resume) and falls back to the last `Created
  conversation <id>` line only when no `Streaming` line exists yet (i.e.
  very early in the conversation). Session-scoped by construction — the log
  path is keyed by our own session id, so any match found is unambiguously
  this session's own conversation, no baseline/diffing needed.
- **JSON turns:** `runTurn` (`agy.ts`) passes `--conversation <chatId>` when
  `ctx.chatId` is set. Unlike TTY mode, agy's `--print`/JSON mode reliably
  reports `conversation_id` directly in **every** turn's response envelope
  (verified live) — this is why agy's JSON channel is trustworthy on its own
  even though its TTY channel isn't.
- **Toggle:** `refreshChatIdOnToggle` — called on tty→json, **after** the
  terminal has been torn down. Does a single, unconditional read of the same
  per-session log file (no poll, no baseline) and **overwrites** even an
  already-set `agentChatId` — this is the one place agy intentionally
  behaves differently from the other three CLIs' resume-path guards, because
  the whole point is correcting a possibly-wrong value with the freshest
  truth. Only agy implements this method — see the block comment in
  `spawn.ts`'s `AgentPlugin.refreshChatIdOnToggle` for why the other three
  must NOT (opencode's own poll-based `captureChatId` would hang its full
  30s if re-invoked here, since its token file is already consumed at
  spawn time).
- **Resume / json→tty restore:** same self-heal-only guard as
  claude/opencode (`captureChatId`, only if unset).
- **Known gap, not fixed:** a brand-new (never-before-trusted) worktree
  shows an interactive "Do you trust this folder?" prompt in agy's TTY mode
  that `--dangerously-skip-permissions` does **not** bypass (verified live)
  — the task prompt never runs until something sends Enter. Degrades safely
  under this design (capture times out to `null`; toggle-time refresh
  self-heals once the user gets past the prompt and actually converses), but
  the prompt itself is unaddressed.

## Toggle walkthrough

```
json → terminal (fromJson)
  PATCH /sessions/:id/channel {channel:"tmux"}
    → idle-gate check (JSON turn queue must be empty)
    → spawnTtyForWorktreeAgent
        → plugin.getRestoreCommand({session, ...})   // builds --resume/--conversation <existing id>
        → spawn the TTY with that argv
        → plugin.captureChatId(...)                  // SELF-HEAL ONLY: skipped if agentChatId already set
    → session.channel = "tmux"

terminal → json (toJson)
  PATCH /sessions/:id/channel {channel:"json"}
    → killSession(tmuxName)   // or directPtyRegistry kill — NOT a graceful CLI exit
    → plugin.refreshChatIdOnToggle?.(...)             // agy ONLY: unconditional overwrite
    → session.channel = "json", tmuxName reset to the __direct__ placeholder
    → resolveJsonAgent → getOrCreateJsonAgentSession   // constructs the JSON session using session.agentChatId
    → (first JSON turn) session_init.agentChatId self-heals IF still unset
```

The asymmetry — a self-heal-only guard on json→tty, but an unconditional
overwrite on tty→json for agy specifically — is intentional, not an
oversight: going *into* a terminal, the daemon already has the best
available id (either genuinely known, or nothing); going *out* of a
terminal, agy's capture is the one case where the daemon's on-record id
could plausibly be wrong (see below), and the moment right after tearing
the terminal down is the most trustworthy point to re-check it.

## Historical note — the agy investigation

Two earlier fix attempts for agy's chat-id capture shipped and were found
wrong by live testing before the current (`--log-file`) design:

1. **Attempt 1 (wrong):** read `~/.gemini/antigravity-cli/cache/last_conversations.json`
   once, right after spawn. This file maps `cwd → latest conversation_id`
   — **no session identity at all**. In any reused worktree (the common
   case), a premature read doesn't fail, it silently returns a *different*,
   unrelated conversation's id.
2. **Attempt 2 (also wrong):** poll the same cache file, diffing against a
   pre-spawn baseline, on the theory that waiting long enough would surface
   the real value. Empirically false: **the cache file is only written on a
   graceful `agy` exit (`/quit`)** — verified live by spawning agy
   interactively, completing a full real exchange, and observing the cache
   file still had no entry for that cwd. vibe-station's teardown
   (`killSession`) sends SIGHUP, never a graceful quit, so the cache for a
   killed session's cwd never updates — any code trusting it, however
   carefully diffed, just ends up adopting whatever stale entry was already
   there from a prior, unrelated conversation in the same reused cwd. This
   reproduced the *exact* original bug through the new code path.
3. **Current design (`--log-file`, verified):** confirmed live that agy logs
   `Created conversation <id>` and `Streaming conversation <id>` as the
   conversation happens, **independent of how the process later exits** —
   unlike the cache file, this doesn't depend on a graceful shutdown that
   vibe-station never performs. Verified end-to-end against the real daemon
   and real agy binary: told a fresh terminal session a secret, toggled to
   JSON, and the JSON side correctly recalled it — with the captured id
   matching the log's own `Created`/`Streaming` lines, not the stale cache
   value (which, confirmed, never moved).

The lesson generalized: for any CLI without a purpose-built hook, prefer a
signal that's written **as a side effect of the conversation happening**
(a live log, a per-turn callback) over one that's only flushed **on exit**
— vibe-station controls spawn but only ever force-kills on teardown, so
"on exit" signals are not a safe assumption for TTY-mode sessions.
