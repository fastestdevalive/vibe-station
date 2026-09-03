<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Agent comms API cleanup

> Collapse `vst send`/`vst chat` into one channel-agnostic `vst session send`, fix `/transcript`'s off-channel lie, drop dead CLI surface (`session meta`, `--follow`), and correct the skill/docs' false claims about these routes.

**Issue:** agent-comms-api
**Branch:** `subagent-ux-v2`
**Status:** WIP
**PRD:** [`decisions-agent-comms-api.md`](./decisions-agent-comms-api.md) — decisions D1–D9 are FINAL, not re-litigated here

**Reference files:**
- Daemon routes: `daemon/src/routes/sessions.ts`
- Chat orchestration: `daemon/src/services/jsonAgentChat.ts`, `daemon/src/services/jsonAgent.ts`
- CLI commands: `cli/src/commands/send.ts`, `cli/src/commands/chat.ts`, `cli/src/commands/session/*.ts`
- CLI wiring: `cli/src/program.ts`
- Notifier: `daemon/src/services/subagentNotify.ts`

---

## Problem & Concept

- Two verbs (`send`/`chat`) do one job; only `send` works on tmux. Agent-facing commands are scattered (`send`, `chat` outside `session`).
- `GET /sessions/:id/transcript` answers off-channel (tmux) with a convincing empty `200 {events:[]}` instead of an error.
- `skill/SKILL.md` claims `GET /sessions/:id/output` doesn't exist (false since `sessions.ts:453`) and that `--follow` streams (it's a stub print).
- See [decisions doc](./decisions-agent-comms-api.md) for the full before/after and D1–D9.

## Out of Scope

- Everything in the decisions doc's "Out of scope" section: `/done`, `/resume`, `/reset`, `/handoff`, `/channel`, `/chat/fork`, `/chat/model`, `/chat/queue/:turnId`, `/attachments` route semantics.
- `POST /handoff`'s off-channel `200` and `session attach`'s wrong tmux-target error message (noted, deferred).
- Renaming `/transcript` → `/output/transcript` (previously proposed D8, dropped — see decisions doc).

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `vst chat <id> "msg"` removed; `vst chat stop` re-homed as `vst session stop` (D1) |
| 2 | `vst session meta` CLI command removed; `GET /sessions/:id/meta` route kept unchanged (D2) |
| 3 | `vst session output --follow` removed (D3) |
| 4 | `GET /sessions/:id/transcript` 404s off-channel (tmux/pty); `vst session output` vs `vst session transcript` descriptions made accurate (D4) |
| 5 | Attachments move to `vst session send --attach` (repeatable); errors (not silently drops) against a non-json target (D5) |
| 6 | `vst send` → `vst session send`, `vst send` kept as a hidden alias (D6) |
| 7 | `POST /sessions/:id/input` → `POST /sessions/:id/send`, `/input` kept as a route alias (D7) |
| 8 | `vst session send` steers a running Rich Chat turn by default; `--queue` opts out (D8) |
| 9 | `skill/SKILL.md` + `docs/API-CONTRACT.md` corrected for `/output`, `/transcript`, `--follow` (D9) |
| 10 | Uncommitted `subagentNotify.ts` fix (`vst chat` → `vst send`) folded in and updated to `vst session send` per D6 |
| 11 | Preserve subagent-ux-v2 invariants: subagent row, `subagentNotify`, `/input` json branch, `/output` json branch |
| 12 | One commit on top of current HEAD, no attribution trailers |

---

## Change Map

```
cli/src/commands/
  chat.ts                    - deleted (D1)
  send.ts                    ~ becomes hidden alias, delegates to lib/sendMessage.ts
  lib/sendMessage.ts         + shared send/attach/wait/print-reply logic
  session/
    meta.ts                  - deleted (D2)
    output.ts                ~ remove --follow, tighten description (D3/D4)
    transcript.ts             ~ tighten description (D4)
    send.ts                  + `vst session send` (D1/D5/D6/D8)
    stop.ts                  + `vst session stop` (D1)
cli/src/
  program.ts                 ~ rewire registrations
daemon/src/routes/
  sessions.ts                ~ InputBody +attachmentIds/+queue, /send alias, /transcript 404 off-channel (D4/D5/D7/D8)
daemon/src/services/
  jsonAgentChat.ts           ~ enqueueChatTurn: steer:boolean option (D8)
  subagentNotify.ts          ~ "vst send" -> "vst session send" (D6, folds in uncommitted fix)
skill/SKILL.md               ~ fix --output/--follow claims (D9)
docs/API-CONTRACT.md         ~ rewrite CLI + REST tables (D3/D4/D6/D7/D9)
daemon/src/assets/agent-system-prompt.md  ~ drop --follow, rename to session send (D3/D6)
README.md                    ~ rename to session send, drop --follow (D3/D6)
docs/HIGH-LEVEL-DESIGN.md    ~ rename to session send (D6)
docs/AGENT-CONTEXT.md        ~ rename to session send (D6)
daemon/src/__tests__/jsonChatRoutes.test.ts  ~ add /send-route coverage + /transcript 404 off-channel test
```

| Today | After this plan |
|-------|-----------------|
| `vst chat <id> "msg"` + `vst send <id> "msg"` (only send works on tmux) | one verb: `vst session send` (`vst send` hidden alias) |
| `vst chat stop` | `vst session stop` |
| `vst session meta` CLI command exists | removed (route unaffected) |
| `vst session output --follow` prints a stub | flag removed |
| `GET /transcript` on a tmux session → `200 {events:[]}` | `404 { error }` |
| `POST /sessions/:id/input` only | `POST /sessions/:id/send` (primary), `/input` alias |
| `vst session send` always steers or always queues (implicit) | steers by default, `--queue` opts out |
| Attachments only via removed `vst chat --file` | `vst session send --attach <path>` (repeatable), errors on non-json target |
| `skill/SKILL.md` says `GET /sessions/:id/output` doesn't exist | corrected — endpoint documented |
| `skill/SKILL.md`/README say `--follow` streams | corrected — flag doesn't exist |

---

## Research

- `daemon/src/services/jsonAgentChat.ts:49-56` — `findJsonSessionContext` does **no channel check**; it's the reason `/transcript` today 200s on a tmux session (finds the record, then reads an empty json transcript store) — the 404 fix belongs in the `/transcript` route handler itself, not this shared finder (also used by `/meta`, `/chat`, `/chat/stop`).
- `daemon/src/services/jsonAgent.ts:433-476` — `agent.submit()` already steers-then-falls-back-to-`enqueue()`; `agent.enqueue()` (`:397-419`) is the pure-queue path used directly when steering must be skipped.
- `daemon/src/services/jsonAgentChat.ts:229-231` — `enqueueChatTurn` already calls `agent.submit()` unconditionally (steers by default) for both `POST /chat` and the existing `/input` json branch — D8's `--queue` is a new opt-out, not a behavior change for the default path.
- `daemon/src/services/subagentNotify.ts:106-107,460-467` (lifecycle.ts) — the notifier's own delivery path calls `agent.enqueue()` directly (never `submit()`), independent of `enqueueChatTurn` — D8 does not touch this path, only confirms the working-tree message-text fix.
- `daemon/src/routes/attachments.ts:138-186` — `POST /sessions/:id/attachments` already works for both channels (json injects into next turn; tmux/pty stages a `UserPromptSubmit`-hook reference) — D5's "errors on tmux" constraint is enforced at the **CLI** layer (`vst session send --attach`), not by changing this route.
- `cli/src/commands/chat.ts:34-56` — `uploadFile()` helper (multipart POST to `/attachments`) is the only existing attach-upload code; reused (not duplicated) via `cli/src/lib/sendMessage.ts`.
- `docs/API-CONTRACT.md:39,47-54,150` — the CLI table's `vst session output` row documents `--follow`; the "Chat" section documents removed `vst chat`; the REST table has no `/output` row and documents `/input` as primary.
- No existing test exercises `GET /transcript` on a **tmux** session — the 404 change has no existing assertion to break (confirmed via `daemon/src/__tests__/jsonChannelToggle.test.ts:647` and `sessions.parentSession.test.ts:223`, both operate on `json`-channel sessions).
- **Root cause:** the CLI's command tree accreted `chat`/`send` as separate top-level verbs and grew a metadata command (`meta`) and a half-implemented flag (`--follow`) without a channel-agnostic contract in mind; `/transcript`'s 200-on-empty is a side effect of a shared finder with no channel guard.

---

## Architecture Diagram

- Single-module change on the CLI side (command tree) plus one daemon route file; no new module boundary — omitted.

---

## Design Details

### System Boundaries

| Boundary | Fields + types | Errors | Source of truth |
|----------|----------------|--------|------------------|
| CLI ↔ Daemon: `POST /sessions/:id/send` (alias: `/input`) | `data: string, sendEnter?: boolean, attachmentIds?: string[], queue?: boolean` | `400` validation / archived / attachment not on json; `404` unknown session; `409` direct-pty not running | daemon (`InputBody` schema, `sessions.ts`) |
| CLI ↔ Daemon: `GET /sessions/:id/transcript` | query unchanged | `404` when session channel ≠ `json` (NEW) | daemon |
| CLI ↔ Daemon: `POST /sessions/:id/chat/stop` (unchanged route, new CLI verb `session stop`) | — | `404` unknown session, `409` no active turn | daemon |

### Critical User Journeys (CUJs)

#### CUJ 1 — Parent messages a Rich Chat child and reads the reply

```
Parent agent: vst session send <childId> "status?" --wait
  → POST /sessions/:childId/send { data: "status?", sendEnter: true }
  → daemon: sessionChannel === "json" → enqueueChatTurn(steer: true) → agent.submit()
  → CLI polls GET /sessions/:childId until idle | waiting_for_human
  → CLI GET /sessions/:childId/transcript?limit=5 → prints latest assistant text
```

- **Error path:** child archived → daemon 400 "Session is archived — start a new session instead"; CLI `die()`s with that message.
- **Edge case:** child is a tmux session → `--wait` reply-print falls back to `GET /output` (pane text), not transcript.

#### CUJ 2 — Attaching a file to a tmux target (error path)

```
User: vst session send <tmuxId> "review this" --attach ./notes.md
  → CLI: GET /sessions/:tmuxId → channel !== "json"
  → CLI dies BEFORE uploading: "Attachments require a Rich Chat (json) session — --attach is not supported on tmux/pty targets"
```

### API Contracts

```
POST /sessions/:id/send   (alias: POST /sessions/:id/input, kept one release — D7)
  Request:  { data: string (min 1 unless attachmentIds non-empty), sendEnter?: boolean,
              attachmentIds?: string[], queue?: boolean }
  Response: 200 { ok: true }
  Errors:   400 VALIDATION_ERROR | archived session | attachmentIds on non-json channel
            404 session not found
            409 direct-pty session not running
  Notes: json channel → enqueueChatTurn(steer: !queue); tmux/pty → paste-buffer write (unchanged)

GET /sessions/:id/transcript
  Request:  ?beforeSeq | ?since | ?all=1 | (default tail) — unchanged query contract
  Response: 200 { events: NormalizedEvent[] } (+ oldestSeq/hasMore on tail/page)
  Errors:   404 session not found OR session channel !== "json"  (NEW — was 200 {events:[]})

POST /sessions/:id/chat/stop   (route unchanged; new CLI verb `vst session stop`)
  Request:  —
  Response: 200 { ok: true }
  Errors:   404 session not found, 409 no active turn
```

### Key Decisions

#### Decision 1: `/send` and `/input` share one handler, registered twice — *shape is the decision*

- **Decision:** extract the existing `/input` handler body into a named `const sendHandler = async (req, reply) => {...}` and register it under both paths.
- **Rationale:** D7 requires zero behavior drift between alias and primary; a shared function makes drift structurally impossible.
- **Where:** `daemon/src/routes/sessions.ts` (currently `app.post("/sessions/:id/input", ...)` at the "POST /sessions/:id/input" comment, ~line 1636)

```ts
// Both routes MUST resolve to the exact same handler — /input is a
// one-release compatibility alias (D7), not a second implementation.
app.post("/sessions/:id/send", sendHandler);
app.post("/sessions/:id/input", sendHandler);
```

#### Decision 2: `enqueueChatTurn` grows a `steer` flag, default `true` — *no snippet needed*

- **Decision:** add `steer?: boolean` to `enqueueChatTurn`'s options; `true`/undefined calls `agent.submit()` (existing behavior, unchanged for `/chat` and default `/send`), `false` calls `agent.enqueue()` directly and reports `delivery: "queued"`.
- **Rationale:** preserves today's default (steer) for every existing caller — see Research § `jsonAgentChat.ts:229-231` — while giving `--queue` a real opt-out (D8).
- **Where:** `daemon/src/services/jsonAgentChat.ts` — `enqueueChatTurn` (~line 209)

#### Decision 3: `/transcript` 404 check lives in the route, not the shared finder — *no snippet needed*

- **Decision:** after `findJsonSessionContext(id)` returns a context, additionally check `sessionChannel(ctx.session) !== "json"` and 404 if so.
- **Rationale:** `findJsonSessionContext` is shared with `/meta`, `/chat`, `/chat/stop`, `/chat/queue/*` — none of which should gain a channel check (D2 explicitly keeps `/meta`'s tty synthesis) — see Research § `jsonAgentChat.ts:49-56`.
- **Where:** `daemon/src/routes/sessions.ts` — `GET /sessions/:id/transcript` handler (~line 2296)

#### Decision 4: shared `runSend()` used by both `session send` and the hidden `send` alias — *shape is the decision*

- **Decision:** one `cli/src/lib/sendMessage.ts` module exports `runSend(sessionId, messageParts, opts)`; `cli/src/commands/session/send.ts` and `cli/src/commands/send.ts` both parse the identical option set and call it.
- **Rationale:** D6's alias must behave identically to the renamed command — a second hand-written implementation would drift on the next change.
- **Where:** `cli/src/lib/sendMessage.ts` (new), `cli/src/commands/session/send.ts` (new), `cli/src/commands/send.ts` (rewritten to a thin hidden wrapper)

```ts
// cli/src/commands/send.ts — hidden alias, D6. Commander v12 supports
// { hidden: true } directly on .command() — no separate "deprecated" path.
program
  .command("send <sessionId> [message...]", { hidden: true })
  .description("Alias for `vst session send`")
  // ...identical options to session/send.ts...
  .action(async (sessionId, message, opts) => {
    await preflight();
    await runSend(sessionId, message, opts);
  });
```

#### Decision 5: `--wait` prints the reply (D1 rider) — *shape is the decision*

- **Decision:** after the poll loop observes `idle` / `waiting_for_human`, fetch and print the reply: json channel → `GET /transcript?limit=5`, print the last `kind:"text", role:"assistant"` event's text; tmux/pty → `GET /output?lines=50`, print pane text.
- **Rationale:** decisions doc note — "`send --wait` only waits for the session to settle [today]... without this, 'ask and read the answer' leaves the CLI."
- **Where:** `cli/src/lib/sendMessage.ts` — new `printReply()` helper called at the end of the wait loop, before `runSend` returns.

#### Decision 6: `--attach` channel-checks via `GET /sessions/:id` before uploading — *no snippet needed*

- **Decision:** `runSend` calls `GET /sessions/:id` first when `opts.attach.length > 0`; if `channel !== "json"`, `die()` before any upload happens.
- **Rationale:** decisions doc note — "`--attach` against tmux must error, not drop the file" — the daemon's `/attachments` route itself accepts tmux uploads (stages a hook reference, Research § `attachments.ts:138-186`), so the guard must be client-side to actually refuse the flag's use on that target, not silently accept a file the send route then can't apply.
- **Where:** `cli/src/lib/sendMessage.ts` — top of `runSend`

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does the daemon need to reject `attachmentIds` on a non-json channel too, not just the CLI?** | Yes — belt-and-suspenders for direct HTTP callers bypassing the CLI guard (skill/curl users). Added as an explicit 400 in the shared send handler. |
| 2 | **Empty message + `--attach` only — allowed?** | Not supported this pass (unlike `/chat`'s files-only turn) — `InputBody`'s `data` stays `min(1)` for `/send`; out of scope per decisions doc (D5 only asks attachments move to `send --attach`, not that empty-message sends become legal). CLI requires message OR `--file` OR `--attach`, but `data` sent is never empty (falls back to a single space is wrong — CLI dies instead, see Phase 3). |

---

## Implementation Phases

### Phase 1 — Daemon: `/send` alias, steer flag, `/transcript` 404

- [x] **1.1** `daemon/src/routes/sessions.ts`: extend `InputBody` with `attachmentIds?: z.array(z.string()).optional()` and `queue?: z.boolean().optional()`.
- [x] **1.2** `daemon/src/routes/sessions.ts`: extract the `/input` handler body into `const sendHandler = async (req, reply) => {...}`; register `app.post("/sessions/:id/send", sendHandler)` and `app.post("/sessions/:id/input", sendHandler)` (Decision 1).
- [x] **1.3** In `sendHandler`'s json branch: resolve `attachmentIds` → `Attachment[]` via `getAttachment` (mirror the `/chat` route's loop, 400 on unknown id); pass `attachments` + `steer: !queue` to `enqueueChatTurn`.
- [x] **1.4** In `sendHandler`'s non-json branch: if `attachmentIds` non-empty, `400 { error: "Attachments require a Rich Chat (json) session" }` before the tmux/direct-pty write (Risk 1).
- [x] **1.5** `daemon/src/services/jsonAgentChat.ts`: add `steer?: boolean` to `enqueueChatTurn`'s options (Decision 2); `steer !== false` → `agent.submit()` (existing path); `steer === false` → `agent.enqueue()` wrapped as `{ ...result, delivery: "queued" }`.
- [x] **1.6** `daemon/src/routes/sessions.ts`: `GET /sessions/:id/transcript` — after resolving `ctx`, add `if (sessionChannel(ctx.session) !== "json") return reply.status(404).send({ error: \`Session '${id}' not found\` })` (Decision 3).
- [x] **1.7** `daemon/src/services/subagentNotify.ts`: change the working-tree `vst send` phrase to `vst session send` (D6/D10) — update the comment above it too.

**Verify phase 1:**
- [x] **1.T1** `cd daemon && npx vitest run src/__tests__/jsonChatRoutes.test.ts` — existing `/input` tests (lines ~261,288) still pass unchanged (alias behavior identical).
- [x] **1.T2** New test in `jsonChatRoutes.test.ts`: `POST /sessions/:id/send` on a json session reaches the agent identically to `/input` (mirrors the existing "vst send — POST /input reaches a json session" test, same assertions, `/send` URL).
- [x] **1.T3** New test: `POST /sessions/:id/send` with `queue: true` while a turn is running does NOT steer (assert `delivery`/queue position behavior via a queued-turn scenario, or directly unit-test `enqueueChatTurn({ steer: false })` returns `delivery: "queued"` without invoking `connection.steer`).
- [x] **1.T4** New test: `GET /sessions/:id/transcript` on a **tmux**-channel session → `404`.
- [x] **1.T5** `daemon: npx vitest run` — full suite green, no new unhandled errors beyond the documented pre-existing one in `sessions.test.ts`.

---

### Phase 2 — CLI: command tree rewire (D1, D2, D3, D6)

- [x] **2.1** Delete `cli/src/commands/chat.ts`.
- [x] **2.2** Delete `cli/src/commands/session/meta.ts`.
- [x] **2.3** New `cli/src/commands/session/stop.ts`: `session.command("stop <id>")` → `POST /sessions/:id/chat/stop` (same body/error handling `chat.ts`'s `stop` subcommand had).
- [x] **2.4** `cli/src/commands/session/output.ts`: remove `--follow` option and the `if (opts.follow)` stub block.
- [x] **2.5** `cli/src/program.ts`: remove `registerSessionMeta`/`registerChat` imports + calls; add `registerSessionStop`, `registerSessionSend` imports + calls (session group); keep `registerSend` (now hidden alias) registered after the session group.

**Verify phase 2:**
- [x] **2.T1** `cd cli && npx vitest run` — no references to removed `chat.ts`/`meta.ts` break the build.
- [x] **2.T2** `pnpm --filter cli exec vst --help` (or build + run) shows no `chat`/`session meta` commands, shows `session stop`, and `session output --help` has no `--follow`.

---

### Phase 3 — CLI: `vst session send` + hidden `vst send` alias (D1, D5, D6, D8, D1-rider)

- [x] **3.1** New `cli/src/lib/sendMessage.ts`: `uploadFile()` (ported from `chat.ts:34-56`), `printReply()` (Decision 5), `runSend(sessionId, messageParts, opts)` (Decision 6 attach-channel-check, message/file/attach validation, POST to `/send`, wait+print loop).
- [x] **3.2** New `cli/src/commands/session/send.ts`: `session.command("send <id> [message...]")` with `--file <path>`, `--attach <path>` (repeatable), `--queue`, `--wait` (default true, matches existing `send.ts` default), `--timeout <ms>`; delegates to `runSend`.
- [x] **3.3** Rewrite `cli/src/commands/send.ts`: `program.command("send <sessionId> [message...]", { hidden: true })`, identical options, delegates to `runSend` (Decision 4).
- [x] **3.4** `cli/src/program.ts`: register `registerSessionSend(session)`.

**Verify phase 3:**
- [x] **3.T1** `cd cli && npx vitest run` — green.
- [x] **3.T2** Manual: `vst session send <id> "hi"` and `vst send <id> "hi"` produce identical daemon calls (verified in Docker phase, not unit tests — no daemon in cli unit tests).
- [x] **3.T3** Manual: `vst session send <tmuxId> "x" --attach ./f.txt` dies client-side with the D5 error message, no upload attempted.

---

### Phase 4 — CLI: transcript/output description accuracy (D4)

- [x] **4.1** `cli/src/commands/session/output.ts`: update `.description(...)` to state it returns pane text (tmux/pty) or assistant prose (json) — no event data.
- [x] **4.2** `cli/src/commands/session/transcript.ts`: update `.description(...)` to state it's Rich Chat only, 404s off-channel, returns raw events (not prose).

**Verify phase 4:**
- [x] **4.T1** `cd cli && npx vitest run` — green (description-only change, no behavior test expected to break).

---

### Phase 5 — Docs: skill, README, API contract, prompts (D3, D6, D7, D9)

- [x] **5.1** `skill/SKILL.md`: rewrite §5 "Send a message and wait" to `vst session send` + `POST /sessions/:id/send` (mention `/input` alias in one line); rewrite §6 "Read session output" — remove `--follow` line, replace the "TODO(api): There is no REST endpoint..." line with the real endpoint description; add `/sessions/:id/output` to §7's HTTP API reference; update the `POST /sessions/:id/input` §7 entry to `/send` (alias noted).
- [x] **5.2** `daemon/src/assets/agent-system-prompt.md`: remove the `--follow` line (~L72-73); rename `vst send` → `vst session send` at ~L126,129 (keep one line noting `vst send` still works).
- [x] **5.3** `README.md`: replace `vst send` examples (L204,207,210,424) with `vst session send`; remove the `--follow` line (L224); update the CLI reference block (L415-430) to list `session {..., send, stop, output, transcript}` and drop the standalone `vst send` line (or note it's a hidden alias).
- [x] **5.4** `docs/API-CONTRACT.md`: rewrite the "Sessions" CLI table rows (output, transcript, remove meta) per D3/D4; delete the "Chat" section's `vst chat`/`vst chat stop` rows, replace the "Send" section with a `vst session send` row (mention `--attach`, `--queue`, hidden `vst send` alias); rewrite the `POST /sessions/:id/input` REST row → `POST /sessions/:id/send` (alias noted); add a `GET /sessions/:id/output` REST row (currently missing entirely — D9); update the `GET /sessions/:id/transcript` REST row to note the off-channel `404`.
- [x] **5.5** `docs/HIGH-LEVEL-DESIGN.md`: update the CLI summary line (~L467) `vst send` → `vst session send` (mention alias briefly if space allows).
- [x] **5.6** `docs/AGENT-CONTEXT.md`: update ~L59 `vst send` → `vst session send`.

**Verify phase 5:**
- [x] **5.T1** `grep -rn "vst chat\b\|session meta\|--follow" skill/ docs/ README.md daemon/src/assets/agent-system-prompt.md` — no remaining hits (except historical/changelog text if any — none expected).
- [x] **5.T2** `grep -n "There is no REST endpoint for .GET /sessions/:id/output" skill/SKILL.md` — no hit (false claim removed).

---

### Phase 6 — Full verification

- [x] **6.1** `pnpm typecheck` — 0 errors.
- [x] **6.2** `pnpm lint` — 0 errors.
- [x] **6.3** `cd cli && npx vitest run` — 906+ passed (baseline 906), 0 new failures.
- [x] **6.4** `cd web-ui && npx vitest run` — 624 passed (baseline), 0 new failures.
- [x] **6.5** `cd daemon && npx vitest run` — passes, only the documented pre-existing `sessions.test.ts` unhandled error, no growth.
- [x] **6.6** Opus review of the full diff against the decisions doc — apply findings, repeat once if HIGH findings surface.
- [x] **6.7** Docker: `scripts/dev-sandbox.sh up vs-67 5196` rebuild, then exercise every command in the task's Verification list against a tmux session AND a Rich Chat session.
- [x] **6.8** Single commit on top of current HEAD (amend as needed), no attribution trailers.

**Verify phase 6:**
- [x] **6.T1** All commands from the task's Docker checklist run and return the expected status/behavior — transcript captured in the final report.

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `daemon/src/routes/sessions.ts` | **Modified** | 1.1-1.4, 1.6 | `InputBody` +2 fields; `/send` + `/input` share `sendHandler`; `/transcript` 404s off-channel |
| `daemon/src/services/jsonAgentChat.ts` | **Modified** | 1.5 | `enqueueChatTurn` contract: `+steer?: boolean` |
| `daemon/src/services/subagentNotify.ts` | **Modified** | 1.7 | Wording fix only, folds in uncommitted working-tree edit |
| `daemon/src/__tests__/jsonChatRoutes.test.ts` | **Modified** | 1.T2-1.T4 | New tests for `/send`, `queue`, `/transcript` 404 |
| `cli/src/commands/chat.ts` | **Deleted** | 2.1 | Superseded by `session/send.ts` + `session/stop.ts` |
| `cli/src/commands/session/meta.ts` | **Deleted** | 2.2 | D2 — route stays, CLI command removed |
| `cli/src/commands/session/stop.ts` | **New** | 2.3 | `session stop <id>` → `POST /chat/stop` |
| `cli/src/commands/session/output.ts` | **Modified** | 2.4, 4.1 | `-follow`; description accuracy |
| `cli/src/commands/session/transcript.ts` | **Modified** | 4.2 | Description accuracy |
| `cli/src/lib/sendMessage.ts` | **New** | 3.1 | Contract: `runSend(sessionId, string[], SendOptions): Promise<void>` |
| `cli/src/commands/session/send.ts` | **New** | 3.2 | `session send <id> [message...]` |
| `cli/src/commands/send.ts` | **Modified** | 3.3 | Hidden alias, delegates to `runSend` |
| `cli/src/program.ts` | **Modified** | 2.5, 3.4 | Rewire registrations |
| `skill/SKILL.md` | **Modified** | 5.1 | D9 corrections + D6/D7 renames |
| `daemon/src/assets/agent-system-prompt.md` | **Modified** | 5.2 | D3/D6 |
| `README.md` | **Modified** | 5.3 | D3/D6 |
| `docs/API-CONTRACT.md` | **Modified** | 5.4 | Full CLI+REST table rewrite for this surface |
| `docs/HIGH-LEVEL-DESIGN.md` | **Modified** | 5.5 | D6 |
| `docs/AGENT-CONTEXT.md` | **Modified** | 5.6 | D6 |
