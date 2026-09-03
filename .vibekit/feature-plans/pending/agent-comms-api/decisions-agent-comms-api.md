# Agent comms API — decisions

How one agent talks to another. Goal: clean up `skill/SKILL.md`, the scripts and the daemon, and streamline the API. Decisions only; not built yet.

---

## Before (today)

| Command | Route | tmux / PTY | Rich Chat |
|---|---|---|---|
| `vst send <id> "msg"` | `POST /sessions/:id/input` | writes to pane | enqueues a turn |
| `vst chat <id> "msg"` | `POST /sessions/:id/chat` | **400** | enqueues a turn |
| `vst chat stop <id>` | `POST /sessions/:id/chat/stop` | **400** | aborts the active turn |
| `vst session output <id>` | `GET /sessions/:id/output` | pane capture | assistant prose |
| `vst session transcript <id>` | `GET /sessions/:id/transcript` | **200 `{events:[]}`** | events |
| `vst session meta <id>` | `GET /sessions/:id/meta` | **200**, synthesized | turn state |
| `vst session output --follow` | — | **stub** | **stub** |

`vst session create` / `terminate` / `ls` / `info` / `reset` / `rename` / `restore` are already channel-agnostic.

**What's wrong:** two verbs for one intent (`send`/`chat`, only `send` works on tmux); `send` and `chat` are the only session-targeting commands not under `session`; `/transcript` answers off-channel with a convincing empty result instead of an error; `--follow` is advertised in the system prompt but prints `(--follow not yet implemented)`; and `skill/SKILL.md:148` tells agents `GET /sessions/:id/output` does not exist, which has been false since `sessions.ts:453`.

---

## After

| Command | Route | tmux / PTY | Rich Chat |
|---|---|---|---|
| `vst session send <id> "msg"` | `POST /sessions/:id/send` | writes to pane | steers or queues a turn |
| `vst session stop <id>` | `POST /sessions/:id/chat/stop` | **409** (no active turn) | aborts the active turn |
| `vst session output <id>` | `GET /sessions/:id/output` | pane capture | assistant prose |
| `vst session transcript <id>` | `GET /sessions/:id/transcript` | **404** | events |

Every agent-facing command lives under `session`. **No aliases kept** — `vst send`, `POST /sessions/:id/input` and `--source-agent` are all removed outright.

---

## Decisions

| # | Decision |
|---|---|
| D1 | **Remove `vst chat <id> "msg"`; re-home `vst chat stop` as `vst session stop`.** `chat` is a command *group* — `chat.ts:95` registers `stop`, the only caller of `POST /chat/stop`. Both routes stay (the composer uses `/chat`). |
| D2 | **Remove the `vst session meta` command only. KEEP `GET /sessions/:id/meta`.** |
| D3 | **Remove `vst session output --follow`.** |
| D4 | **Keep `vst session transcript`, and make the difference from `output` real.** Rewrite both descriptions; `/transcript` 404s off-channel. |
| D5 | **Attachments move to `vst session send --attach`** (repeatable), as part of D1. |
| D6 | **`vst send` → `vst session send`.** No alias — the old verb is removed. |
| D7 | **`POST /sessions/:id/input` → `POST /sessions/:id/send`.** No alias — `/input` is removed, along with web-ui's dead `sendInput`/`SendInputBody`. |
| D8 | **`vst session send` steers by default on Rich Chat; `--queue` opts out.** Preserves today's behaviour and gives the caller the choice `subagentNotify` takes for itself. |
| D10 | **Remove `--source-agent`** from `session create` / `worktree create`; `--parent` is the only name. |
| D9 | **Fix the skill's false claims about these routes** — see below. This is the actual "clean up the skill" work. |

*(A previous D8 renamed `/transcript` → `/output/transcript`. **Dropped**: cosmetic, and it lands in `web-ui/api/client.ts:999,1006,1019`, `useChat.ts:293,311`, `api/mock.ts` and ~12 daemon test call sites for no functional gain.)*

### Why D2 keeps the route

`GET /meta` is **not** only used by the CLI. Consumers: `web-ui/src/api/client.ts:1026` + `mock.ts:1415` (currently uncalled by any component — the UI reads meta over WS `chat:open`), **and 10 references across daemon tests**, including `jsonChannelToggle.test.ts:332`'s `waitForTurnState()` helper and `jsonChatRoutes.test.ts:486` ("GET /meta rebuilds usage from the transcript tail after a restart"), whose restart-rebuild path (`readSessionMeta`, `sessions.ts:2334`) is reachable only over HTTP. Removing the route would silently rewrite six tests.

### D9 — skill and contract corrections

| File | Line | Wrong today |
|---|---|---|
| `skill/SKILL.md` | 148 | "There is no REST endpoint for `GET /sessions/:id/output`" — it has existed since `sessions.ts:453` |
| `skill/SKILL.md` | 144-145 | documents `--follow` as "streams until Ctrl-C" — behaviour the stub never had |
| `docs/API-CONTRACT.md` | — | no `/sessions/:id/output` row at all |
| `docs/API-CONTRACT.md` | 39 | repeats the `--follow` claim |

### Files each decision touches

| Decision | Files |
|---|---|
| D1 | `cli/src/commands/chat.ts` (delete msg cmd, move `stop`), `cli/src/program.ts:115` |
| D3 | `cli/src/commands/session/output.ts:16,30-33`; `daemon/src/assets/agent-system-prompt.md:72-73`; `skill/SKILL.md:144-145`; `README.md:224`; `docs/API-CONTRACT.md:39` |
| D4 | `cli/src/commands/session/output.ts:14`, `transcript.ts:22` (descriptions); `daemon/src/routes/sessions.ts:2296` (404 — **in the route**, not in `findJsonSessionContext`, which does no channel check and is shared with `/meta` and the chat paths) |
| D5 | `cli/src/commands/send.ts`; `daemon/src/routes/sessions.ts` `InputBody` + json branch; upload via `POST /sessions/:id/attachments` (`attachments.ts:138`) |
| D6 | `cli/src/program.ts:112`; `skill/SKILL.md:116,119`; `agent-system-prompt.md:126,129`; `README.md:204,207,210,424`; `docs/API-CONTRACT.md:54`; `docs/HIGH-LEVEL-DESIGN.md:467`; `docs/AGENT-CONTEXT.md:59`; `daemon/src/services/subagentNotify.ts:189` |
| D7 | `daemon/src/routes/sessions.ts:1636`; `skill/SKILL.md:121-134,242-247`; `docs/API-CONTRACT.md:150`; `web-ui/src/api/client.ts:540-551` (`sendInput` — **no component callers**, compile surface only); `web-ui/src/api/mock.ts:742`; `daemon/src/__tests__/jsonChatRoutes.test.ts:270,303` |

### Notes that matter when implementing

- **D5's flag cannot be `--file`.** `chat --file` attaches (repeatable, `chat.ts:109`); `send --file` reads the message text from a file (single, `send.ts:15`). `--attach` must stay repeatable; `--file` keeps its meaning. Attachments are Rich Chat only — `--attach` against tmux must error, not drop the file.
- **No aliases, deliberately.** A rename lands for new sessions at once but leaves sessions started before the change holding a verb that no longer exists — accepted: a clear `unknown command` beats a shim that silently becomes permanent. All agent-facing docs are updated in the same commit.
- **D1 rider:** `vst session send` needs a `--wait` that *prints* the reply. `chat --wait` streams the answer; `send --wait` only waits for the session to settle. Without this, "ask and read the answer" leaves the CLI.
- **Uncommitted:** the `subagentNotify` fix (said `vst chat`, now `vst send`) is a working-tree edit on this branch, not a commit. Don't lose it.

---

## Rejected: merging `output` and `transcript`

Considered making `output` return events for Rich Chat and absorb transcript's params. Rejected:

1. **Agents already know only one read verb.** `vst session transcript` appears in zero agent-facing docs; `agent-system-prompt.md`, `skill/SKILL.md` and `README.md` teach `output` only. The duplication is in the command tree, not in anything an agent experiences.
2. **The notifier path would regress 16–134×.** Measured on two real sessions: `/output` 3,312 B vs `/transcript?all=1` 56,203 B (16×), and 690 B vs 93,020 B (134×). Assistant prose is ~5% of a transcript by bytes; the largest single item is `commands_update`, a dump of every installed skill. `subagentNotify` tells a woken parent to read its child with `vst session output` — a merge hands it a JSON firehose. *(Those sessions have since been deleted; re-measure on any live pair.)*
3. **Return-type polymorphism breaks scripts.** `skill/SKILL.md:304` does `OUTPUT=$(vst session output …)` and interpolates it as text. A verb whose return *type* depends on the target's channel forces every caller to fetch `GET /sessions/:id` first to learn what shape to expect. `{output: string}` is the only genuinely channel-agnostic read in the system.

Also: tmux has no events, so a merge must fabricate them (with cursors that can never advance), stay a string (the polymorphism, hidden), or error on event-shaped params.

**Corollary:** don't import `beforeSeq`/`since` into `output` either — those are cursors into the event log, and prose is a projection with no seq coordinates. A `--lines` tail is what a parent reading a child needs.

---

## Out of scope

Routes under `/sessions/:id/*` an agent could call that these decisions deliberately do not touch: `/done`, `/resume`, `/reset`, `/handoff`, `/channel`, `/chat/fork`, `/chat/model`, `/chat/queue/:turnId`, `/attachments`.

Two have the same off-channel wart as D4 fixes, noted for a later pass, not this one:

- `POST /handoff` returns **200 `{ok:true, handoffSummary:null}`** on a json session — `handoff.ts:53` short-circuits. A convincing empty result.
- `vst session attach` fails with "Session does not have a tmux target" for a **pty** session, which is honest but names the wrong reason.
