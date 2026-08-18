<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: session-terminate

> Standardize the session-ending verb to "terminate" across CLI/UI/docs, and fix the agent
> system prompt so a direct (worktree-less) agent can discover and use its own session id to
> end itself.

**Issue:** session-terminate
**Branch:** `api-somewhere-terminate` (already checked out)
**Status:** WIP
**PRD:** none — scoped technical fix, no new user-facing behavior

**Reference files:**
- CLI command: `cli/src/commands/session/kill.ts` (renamed to `terminate.ts`)
- Daemon route (unchanged contract): `daemon/src/routes/sessions.ts:798` (`DELETE /sessions/:id`)
- Agent prompt: `daemon/src/assets/agent-system-prompt.md`
- UI entrypoints: `web-ui/src/api/client.ts`, `web-ui/src/components/layout/{LeftSidebar,WorkspaceCanvas,TabsStrip}.tsx`

---

## Problem

- The same daemon action (`DELETE /sessions/:id` — kill the process, delete the record + data dir) is spelled three different ways: "dismiss" (`LeftSidebar.tsx`, doc table), "terminate" (`WorkspaceCanvas.tsx` state var, but its dialog copy says "Close agent"), and "kill" (CLI: `vst session kill`). `docs/SESSION-EXECUTION.md:122` even mislabels the session-level version "Dismiss (**keep files**)" while its own next column says the data dir IS removed — the copy is actively wrong, not just inconsistent.
- No agent-facing doc documents `DELETE /sessions/:id` (or `POST /sessions/:id/done`) as something an agent can call on itself. `daemon/src/assets/agent-system-prompt.md:31,126` only says "your process exits → the UI shows `done`" — false: process exit sets lifecycle `exited` (`markSessionExited`), never `done` (only the explicit `POST /sessions/:id/done` sets that).
- `agent-system-prompt.md` is injected verbatim into **both** worktree-spawned agents and "direct" (no-worktree) agents (`daemon/src/services/promptBuilder.ts:67-114` vs `:120-161`), but its L1 body unconditionally claims "You run inside an isolated git worktree" (`agent-system-prompt.md:4`) and "Your branch was already created for you" (`:18`) — both false for a direct session. A user asking a direct agent to "finish itself" got told it has no session id to act on, even though direct sessions DO receive `$VST_SESSION` and `$VST_DAEMON_URL` (`daemon/src/services/spawn.ts:566-570`) — the gap is undocumented capability, not missing capability.

## Out of Scope

- `cli/src/commands/worktree/rm.ts` and `DELETE /worktrees/:id` — a distinct concept (removes a git worktree; killing its sessions is a cascade side effect), explicitly excluded by the task.
- `dismissWorktree`/`deleteWorktree` (`web-ui/src/api/client.ts:295,308`) and their UI ("Dismiss (keep files)" vs "Delete worktree…" on `DashboardPanel.tsx`/`LeftSidebar.tsx`) — these are two **legitimately distinct** worktree-level operations (soft remove-from-tracking vs full purge) with no competing "kill"/"terminate" spelling anywhere; renaming either would blur a real distinction, not fix a fake one.
- `POST /sessions/:id/done` and its "Mark as done" UI — a separate, already-consistently-named concept (pause/resumable). Not touched.
- `ModesSetting.tsx:129` "Dismiss" button — dismisses a generic notice banner, unrelated to sessions.
- Full conditional-prompt templating (splitting `agent-system-prompt.md` into worktree/direct variants) — too large for this fix; instead the shared L1 body is made non-committal about worktree presence and defers to the L2 context block (which is already accurate per-path).
- Internal/process-level naming (`tmux.ts` `killSession`, `directPtyRegistry.kill()`, `fileList.ts` cap-hit "terminate the child") — implementation detail, not user-facing terminology.

## Concept

- One user-facing verb, "Terminate", for the CLI (`vst session terminate`), and every UI surface that ends a session (tab "×", sidebar per-session menu, canvas tile menu).
- `vst session terminate [id]` — `id` becomes optional; omitted defaults to `$VST_SESSION`, so any agent (worktree or direct) can end itself with no arguments and no prior lookup.
- `agent-system-prompt.md` gets a new "Ending your session" section documenting this, and its existing claims are hedged so they don't misinform direct sessions.

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `vst session terminate` replaces `vst session kill` as the CLI command name (clean rename, no alias — confirmed no other code/doc depends on the `kill` spelling as a stable API name beyond what this plan updates). |
| 2 | `vst session terminate` with no `<id>` argument defaults to `$VST_SESSION`; with neither an argument nor `$VST_SESSION` set, it fails with a clear error instead of calling the daemon with `undefined`. |
| 3 | Every UI dialog/label ending a session (sidebar, tab strip, canvas tile) reads "Terminate", not "Dismiss"/"Close"/"Kill". |
| 4 | `agent-system-prompt.md` never asserts a direct session has a git worktree or a pre-created branch. |
| 5 | `agent-system-prompt.md` documents the actual mechanics of ending a session (process exit → `exited`, `vst session terminate` → record deleted) instead of the current false "exit → shows `done`" claim. |
| 6 | Docs (`API-CONTRACT.md`, `SESSION-EXECUTION.md`, `HIGH-LEVEL-DESIGN.md`, `skill/SKILL.md`, `README.md`) use "terminate" wherever they currently say "kill"/"dismiss" for this same action. |
| 7 | No behavior change to the `DELETE /sessions/:id` route itself (path, method, response shape, the `isMain` 400 guard) — this is a naming/documentation fix, not a semantics change. |

---

## Research

### CLI command surface

- **File:** `cli/src/commands/session/kill.ts:1-21` — `registerSessionKill`, `session.command("kill <id>")` (required arg), calls `daemonDelete<void>(\`/sessions/${id}\`)`, prints `Session killed: ${id}`.
- **File:** `cli/src/program.ts:25,101` — imports `registerSessionKill` from `./commands/session/kill.js`, calls it in the session subcommand group.
- **File:** `cli/src/lib/env.ts:9-11` — `getVSTSession()` reads `process.env.VST_SESSION`; already used elsewhere for self-defaulting (`cli/src/commands/worktree/create.ts:67`, `cli/src/commands/session/create.ts:59` — pattern: `opts.sourceAgent ?? process.env.VST_SESSION ?? undefined`).
- **File:** `cli/src/commands/session/reset.ts:33-41` — precedent for a self-targeting guard with a clear `die(...)` message when the CLI is invoked from inside the session it's targeting.
- No existing `*.test.ts` covers `kill.ts` today (`find cli -iname '*kill*.test.ts'` — none); a new `cli/src/__tests__/session-terminate.test.ts` is additive, not a migration.
- **Risk:** LOW — route/response shape unchanged, only the CLI command name + arg cardinality change.

### Daemon route (unchanged, confirmed no code change needed here)

- **File:** `daemon/src/routes/sessions.ts:798-843` — `DELETE /sessions/:id`: 404 if `findSessionContext` misses, 400 if `session.isMain` ("Cannot delete the main session. Use DELETE /worktrees/:id instead."), otherwise releases runtime + deletes the record + data dir (`cleanupSessionDataDir` for worktree sessions, `cleanupDirectSessionDataDir` for direct sessions) and broadcasts `session:deleted`.
- **File:** `daemon/src/services/dbSchema.ts:56` — `isMain INTEGER ... CHECK (isMain = 0 OR worktreeId IS NOT NULL)` — a direct session can never be `isMain`, so a direct agent's self-terminate call never hits the 400 guard. A **worktree main-slot** agent calling `vst session terminate` on itself still correctly 400s (existing behavior, surfaced verbatim by `die(result.error, ...)` in the CLI) — must be called out in the prompt doc so agents don't treat it as a bug.
- **File:** `daemon/src/services/spawn.ts:566-570` — direct sessions receive `VST_SESSION` and `VST_DAEMON_URL`; `VST_WORKTREE` is intentionally absent for direct sessions (confirmed, no change needed).

### Prompt builder (L1/L2 layering — confirms the minimal-risk fix path)

- **File:** `daemon/src/services/promptBuilder.ts:67-114` (`buildPrompt`, worktree path) — L2 correctly states `**Working directory (worktree):**`, branch, base branch.
- **File:** `daemon/src/services/promptBuilder.ts:120-161` (`buildDirectPrompt`) — L2 correctly states `> This is a direct session running in the project directory (no worktree isolation).`
- Both paths prepend the **same** L1 (`agent-system-prompt.md`, cached via `loadSkillMd()` at `:28-39`) verbatim before L2 — so L1's opening lines ("You run inside an isolated git worktree", "Your branch was already created for you") contradict the correct L2 context a direct agent receives immediately after. Fix: soften L1's opening claims to be conditional/deferring to the Context section, not a second prompt-builder branch (out of scope, see Out of Scope).

### UI terminology inventory (session-ending verb only — worktree-level "Dismiss" excluded per Out of Scope)

| Surface | File:line | Current copy | Calls |
|---|---|---|---|
| Tab strip "×" (agent + terminal) | `web-ui/src/components/layout/TabsStrip.tsx:683-693,730-741` | aria `Close ${label}`, dialog "Close agent"/"Close terminal", confirm "Close" | `api.deleteSession` |
| Canvas tile menu | `web-ui/src/components/layout/WorkspaceCanvas.tsx:194-200,1373-1414` | menu item "Terminate" (already correct) but dialog title "Close agent", message "Close this agent session?", confirmLabel "Close" | `api.deleteSession` |
| Sidebar per-session menu | `web-ui/src/components/layout/LeftSidebar.tsx:566,735-750,1830-1839,2026-2030` | dialog title "Dismiss agent?", confirmLabel "Dismiss", menu item "Dismiss" | `api.deleteSession` |
| API client | `web-ui/src/api/client.ts:481-487` | method name `deleteSession` | `DELETE /sessions/${id}` |
| Mock API | `web-ui/src/api/mock.ts:558` | method name `deleteSession` (mirrors client) | in-memory |

- No test file references `deleteSession`/`closeTarget`/`pendingDismissSession`/`confirmDismissSession` (`grep -rln` across `web-ui/src/**/*.test.tsx` — zero hits), so the rename has no test-mock churn beyond the plan's own new assertions.
- `web-ui/src/api/client.ts` exports no separate `ApiClient` interface — `createClientApi()`'s return type is inferred (confirmed: `grep -n "^export" client.ts` shows no `interface`/`type Api`), so renaming the object key is the only type-level change needed; `tsc` will catch every call site.

### Docs inventory

- `docs/API-CONTRACT.md:36` — `| \`vst session kill\` | \`<session-id>\` | Terminate session. Rejected for \`m\` slot. |`
- `docs/API-CONTRACT.md:94-97` (env-var default table) — row `` | `VST_SESSION` | the agent's own session id | (informational; not used as a default to avoid self-targeting bugs) | `` directly contradicts Decision 2 (`terminate` intentionally self-targets via `$VST_SESSION`) and must be updated, not just the `kill`→`terminate` rename below it.
- `docs/API-CONTRACT.md:100` — `` **Destructive commands** (`project rm`, `worktree rm`, `session kill`, `mode rm`) **require explicit ids** — no env-var defaults — to prevent agents accidentally nuking their own context. `` — states the *opposite* of what `session terminate` will do post-Decision-2; a bare word-swap to `session terminate` here would leave the doc asserting a false invariant about the very command the plan is changing.
- `docs/API-CONTRACT.md:170` — `` 409 if any session currently references this mode. Caller must kill those sessions first. ``
- `docs/SESSION-EXECUTION.md:117-131` — the authoritative retire/delete matrix; row 122 mislabels session-level delete "Dismiss (keep files)" though its own "Record kept?" column says "no — record + data dir removed" — this row's **label** is simply wrong today, independent of the terminology-standardization goal.
- `docs/HIGH-LEVEL-DESIGN.md:351` — `` The main session cannot be killed via \`DELETE /sessions/:id\`... The only way to end a main session is \`DELETE /worktrees/:id\`... ``
- `docs/HIGH-LEVEL-DESIGN.md:465` — `` \`vst session {create,ls,info,kill,attach,restore,output}\` `` — same sentence also says "non-destructive commands default to those [env vars]," which Decision 2 makes inaccurate for `terminate` specifically.
- `skill/SKILL.md:398-419` (`## 11. Tear down`) — comment `# Kill a specific session (non-main only)` at `:400`, `vst session kill <sessionId>` at `:411`.
- `skill/SKILL.md:404,418,426` — prose "kills all sessions", "all sessions killed", "only kill sessions or worktrees" — generic prose describing the same action, in scope per Requirement 6.
- `skill/SKILL.md:12,432` — cross-references calling this "rename, teardown" patterns; no verb change needed there, just context.
- `README.md:178,377,422` — `vst session kill <session-id>  # any session except the main slot`; prose `kill session`; CLI reference table `create | kill | ls | info | attach | restore | output`.
- `~/.claude/skills/vst/SKILL.md` — a byte-identical installed copy of `skill/SKILL.md` (confirmed via `diff -q`, not a symlink) that agents read directly; will go stale re-teaching the removed `kill` spelling unless re-synced after `skill/SKILL.md` is edited.
- `.feature-plans/done/**` — historical/archival, explicitly NOT touched (would rewrite settled history for no reader benefit).

## Root Cause

- Three unrelated authors/PRs each picked a different verb for the same daemon call, with no single doc treating "end a session" as one concept — `SESSION-EXECUTION.md`'s own retire matrix is the closest thing to a source of truth and even it has a stale label.
- The agent system prompt was written worktree-first and reused unmodified for direct sessions when that spawn path was added — L1 never got a second look once L2 started correctly branching.

---

## Architecture Diagram

- Pure rename/documentation change across three existing modules (`cli`, `daemon`'s static prompt asset, `web-ui`) — no new component, no new edge, no change to which module talks to which. No diagram.

## Data Model

- N/A — no persisted schema changes. `DELETE /sessions/:id`'s effect on `SessionRecord`/`ProjectRecord` (record + data-dir removal) is pre-existing behavior, unchanged by this plan.

## Design Details

### System Boundaries

- `DELETE /sessions/:id` contract is unchanged (path, method, request/response shape, error codes) — this plan is a caller-side rename, not a contract change. One line per `FORMAT.md`: existing contract, not modified.

### Critical User Journeys (CUJs)

#### CUJ 1 — Direct agent ends itself mid-conversation

```
User (in a direct/no-worktree chat session) tells the agent "finish yourself"
  → Agent reads its own system prompt's "Ending your session" section
  → Agent runs `vst session terminate` (no id argument) in a shell tool call
  → CLI resolves id from $VST_SESSION (already set — direct sessions get it)
  → CLI calls DELETE /sessions/$VST_SESSION
  → Daemon: not isMain (direct sessions never are) → releases runtime, deletes record + data dir
  → Session disappears from the UI; the shell command itself is the agent's last action
```

- **Error path:** `$VST_SESSION` unset (e.g. CLI run from a plain terminal, not inside an agent) and no `<id>` given → CLI `die()`s with "No session id given and $VST_SESSION is not set — pass an id explicitly." before making any HTTP call.
- **Edge case:** a worktree **main-slot** agent runs `vst session terminate` on itself → daemon 400s ("Cannot delete the main session. Use DELETE /worktrees/:id instead.") → CLI surfaces that verbatim via existing `die(result.error, ...)`; documented in the prompt so this reads as expected behavior, not a bug.

### API Contracts

- No new/changed endpoint. `DELETE /sessions/:id` behavior stays exactly as implemented at `daemon/src/routes/sessions.ts:798`.

### Key Decisions

#### Decision 1: Clean rename (`kill` → `terminate`), no backward-compat alias

- **Decision:** `cli/src/commands/session/kill.ts` is renamed to `terminate.ts`; the `kill` command name is removed, not aliased.
- **Rationale:** `vst` is an actively-developed local dev tool with no external/published CLI contract to preserve (confirmed: no `CHANGELOG`/versioned release process referencing `session kill` as a stable public API — the only consumers are this repo's own docs/prompts, all updated in this same commit). An alias would re-introduce the exact multi-spelling problem this plan removes.
- **Where:** `cli/src/commands/session/kill.ts` → `cli/src/commands/session/terminate.ts`; `cli/src/program.ts:25,101`.

#### Decision 2: Self-default via `$VST_SESSION`, not a new `--self` flag

- **Decision:** `id` becomes an optional positional arg (`terminate [id]`); when omitted, resolve to `getVSTSession()`.
- **Rationale:** matches the existing self-defaulting convention already used by `worktree create --source-agent` and `session create --source-agent` (`cli/src/commands/worktree/create.ts:67`) — one pattern, not a new one.
- **Overrides a documented invariant — call this out, don't just silently contradict it:** `docs/API-CONTRACT.md:100` currently states destructive commands (incl. `session kill`) "require explicit ids — no env-var defaults — to prevent agents accidentally nuking their own context." `terminate`'s self-default is a deliberate, narrower exception: self-targeting is exactly the capability this plan adds (Problem, CUJ 1), and the `isMain` guard (Research → Daemon route) already blocks the one genuinely dangerous case (a worktree's main agent nuking itself) at the daemon layer, independent of what the CLI defaults to. Phase 3 must reword `API-CONTRACT.md:94-100` and `HIGH-LEVEL-DESIGN.md:465` to carve out this exception explicitly, not just swap the word `kill`→`terminate` inside a sentence that still says defaults are forbidden.
- **Where:** `cli/src/commands/session/terminate.ts`.

```ts
// cli/src/commands/session/terminate.ts — resolution order: explicit arg, then $VST_SESSION
const targetId = id ?? getVSTSession();
if (!targetId) {
  die("No session id given and $VST_SESSION is not set — pass an id explicitly.");
}
```

#### Decision 3: Hedge L1's worktree claims instead of branching `agent-system-prompt.md`

- **Decision:** Reword the opening lines and the "Git rules"/"Signal done" sections to be accurate for both spawn paths (e.g. "If you were spawned into a worktree (see Context below for your working directory) ...") rather than adding a second templated prompt file.
- **Rationale:** `promptBuilder.ts`'s L2 context block already correctly distinguishes the two paths (`buildPrompt` vs `buildDirectPrompt`); duplicating that distinction into L1 as a second full prompt variant is the "too large" refactor the task explicitly said to avoid unless needed — a few conditional sentences suffice since L1 already gets L2 appended immediately after it.
- **Where:** `daemon/src/assets/agent-system-prompt.md` (whole-file edit, no `promptBuilder.ts` change).

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Does anything outside this repo depend on `vst session kill` as a stable CLI name? | No external consumers found (local dev tool, no publish/changelog process) — treated as safe to rename cleanly per Decision 1. |
| 2 | Should `TabsStrip.tsx`'s terminal "×" also say "Terminate" (not just agent tabs)? | Yes — `deleteSession`/`DELETE /sessions/:id` is the same call for terminal and agent sessions; keeping "Terminate" uniform avoids reintroducing a second word for one action. |

---

## Implementation Phases

### Phase 1 — CLI: rename `kill` → `terminate`, add self-default

- [x] **1.1** Rename `cli/src/commands/session/kill.ts` → `cli/src/commands/session/terminate.ts`:
  - Export `registerSessionTerminate` (was `registerSessionKill`).
  - `.command("terminate [id]")` (was `"kill <id>"` — arg now optional).
  - `.description("Terminate a session (defaults to your own session, $VST_SESSION, if no id is given)")`.
  - Action resolves `const targetId = id ?? getVSTSession();` (import `getVSTSession` from `../../lib/env.js`); `if (!targetId) die("No session id given and $VST_SESSION is not set — pass an id explicitly.");` before calling `daemonDelete`.
  - Success message: `` success(`Session terminated: ${targetId}`); ``.
- [x] **1.2** `cli/src/program.ts:25` — `import { registerSessionTerminate } from "./commands/session/terminate.js";` (was `registerSessionKill` from `./kill.js`); `cli/src/program.ts:101` — `registerSessionTerminate(session);`.
- [x] **1.3** New `cli/src/__tests__/session-terminate.test.ts` (mirror the mocking style of `cli/src/__tests__/session-reset.test.ts:1-30` — mock `daemon-client.js`'s `daemonDelete`, mock `preflight`, spy on `process.exit`/console via `output.ts`).

**Verify phase 1:**
- [x] **1.T1** Unit — `session-terminate.test.ts`: explicit `<id>` arg present → `daemonDelete` called with `/sessions/<id>`, regardless of `$VST_SESSION`.
- [x] **1.T2** Unit — `session-terminate.test.ts`: no arg, `$VST_SESSION=sess-1` set → `daemonDelete` called with `/sessions/sess-1`.
- [x] **1.T3** Unit — `session-terminate.test.ts`: no arg, `$VST_SESSION` unset → `daemonDelete` is never called; process exits non-zero with the "No session id given..." message.
- [x] **1.T4** Unit — `session-terminate.test.ts`: daemon 400 (main-slot rejection) surfaces via `die(result.error, ...)` unchanged.
- [x] **1.T5** Regression — `pnpm --filter @vibestation/cli typecheck` passes (no remaining `registerSessionKill`/`kill.js` references).

### Phase 2 — Agent-facing prompt: fix direct-session accuracy + document self-terminate

- [x] **2.1** `daemon/src/assets/agent-system-prompt.md:4` — reword the intro so it doesn't assert a worktree unconditionally, e.g.: "You are managed by vibe-station (`vst`). Depending on how you were spawned, you are either working in an isolated git worktree on your own branch, or directly in the project directory (a "direct session") — check the **Context** section injected below this file for which one you are."
- [x] **2.2** `daemon/src/assets/agent-system-prompt.md:8-18` (Environment table + the paragraph after it) — annotate `VST_WORKTREE` as "worktree sessions only — absent for direct sessions"; reword "Your working directory is the worktree checkout... Your branch was already created for you — do not switch branches." to lead with "If you have a `$VST_WORKTREE` (see Context below), your working directory is that worktree checkout and your branch was already created for you — do not switch branches. If you don't, you're a direct session working in the project directory itself, on whatever branch is already checked out."
- [x] **2.3** `daemon/src/assets/agent-system-prompt.md:22-33` (Standard workflow, step 6) — replace "**Signal done** — when complete, your process exits. The UI will show your session as `done`." with an accurate statement: exiting your process marks the session `exited` in the UI (not `done` — `done` is a separate explicit action, see "Ending your session" below); for a worktree agent whose task is fully finished, letting the process exit naturally is still the normal way to stop.
- [x] **2.4** `daemon/src/assets/agent-system-prompt.md:37-43` (Git rules) — prefix with "(worktree sessions only — skip this section if you're a direct session)".
- [x] **2.5** Add a new `## Ending your session` section (after "What 'done' looks like", before "Things you must NOT do") documenting:
  - `vst session terminate` — ends **this** session (defaults to `$VST_SESSION` when no id is given); deletes the session record and its data dir; use this when asked to end/finish/stop yourself, or when you (an agent) spawned a sibling/child session that's no longer needed.
  - Caveat: if you are a worktree's **main** agent, this is rejected (400) — the daemon requires `vst worktree rm` for that case instead (out of scope for a mid-task agent to run unprompted; surface the 400 to the user rather than escalating to a worktree removal).
- [x] **2.6** `daemon/src/assets/agent-system-prompt.md:137` — "Run `vst worktree rm` or `vst session kill` on sessions you did not create." → "...or `vst session terminate`...".
- [x] **2.7** Remaining lines that still assert an unconditional worktree, found by re-reading the file top to bottom after 2.1-2.6 (line numbers below are pre-edit; re-locate by content after earlier edits shift them):
  - `:28` "**Make changes** — edit files in the worktree." → generalize to "edit files in your working directory (the worktree checkout, or the project directory for a direct session)".
  - `:55`,`:58` — `vst worktree info $VST_WORKTREE --json` / `vst session ls --worktree=$VST_WORKTREE --json` under "Inspect" — prefix the "Inspect" subsection with "(worktree sessions only, unless noted)" the same way 2.4 hedges "Git rules", since `$VST_WORKTREE` is unset for direct sessions (`spawn.ts:566-570`) and these commands would fail silently/confusingly if a direct agent copy-pastes them.
  - `:92`,`:95` (Case B "Spawn more work") — same hedge: prefix "Case B" with "(worktree sessions only)". Confirmed via `cli/src/commands/session/create.ts:15` (`.command("create <worktreeId>")`, required positional arg) that the CLI has no way today to create a direct sibling session — the daemon route (`daemon/src/routes/sessions.ts:469`, infers `target: "direct"` when `worktreeId` is absent from the body) supports it, but the CLI never omits `worktreeId`. State this plainly in the prompt: "Direct sessions cannot spawn sibling sessions via the CLI today."
  - `:124` "Changes are committed on your branch." (under "What 'done' looks like") — hedge with "(worktree sessions — a direct session edits the project's checked-out branch directly, there is no separate branch to commit to)".
  - `:128` "write a `BLOCKED.md` file in the worktree root" — reword to "in your working directory root (worktree checkout, or the project directory for a direct session)".
  - `:134` "Modify files outside your worktree directory." (under "Things you must NOT do") — reword to "Modify files outside your working directory (the worktree checkout, or the project directory for a direct session)" so the rule parses for both spawn paths.

**Verify phase 2:**
- [x] **2.T1** Regression — `daemon/src/__tests__/promptBuilder.test.ts` still passes; it does use `toContain` in several places (`:52,53,54,63,72,93,100,123`), but every asserted substring comes from L2/L3 (project id, branch, task prompt, mode instructions, project rules) — never from `agent-system-prompt.md` (L1) — so 2.1-2.7's rewording cannot break it. Run `pnpm --filter @vibestation/cli test -- promptBuilder` (daemon tests run under the `cli` package per `cli/vitest.config.ts` include glob — confirmed via `cli/src/daemon -> ../../daemon/src` symlink) to be sure.
- [x] **2.T2** Manual read-through — the file no longer contains an unconditional "You run inside an isolated git worktree" claim anywhere (intro, Environment, Standard workflow, Git rules, Inspect, Case B, "What done looks like", "Things you must NOT do"); grep confirms zero remaining `vst session kill` occurrences in this file.

### Phase 3 — Docs: propagate "terminate" wording

- [x] **3.1** `docs/API-CONTRACT.md:36` — `` `vst session kill` `` → `` `vst session terminate` ``, and `` `<session-id>` `` → `` `[session-id]` `` (row text "Terminate session..." already correct, only the command-name/arg cells change) — `docs/API-CONTRACT.md:34` already uses `[--worktree=<id>]` bracket notation for an optional arg in this same table, so match that convention rather than leaving it ambiguous.
- [x] **3.2** `docs/API-CONTRACT.md:97` — `` | `VST_SESSION` | the agent's own session id | (informational; not used as a default to avoid self-targeting bugs) | `` → reword the third column to reflect Decision 2, e.g. "(informational; `session terminate` defaults its target id to this — the one deliberate self-targeting exception, see below)".
- [x] **3.3** `docs/API-CONTRACT.md:100` — `` **Destructive commands** (`project rm`, `worktree rm`, `session kill`, `mode rm`) **require explicit ids** — no env-var defaults — to prevent agents accidentally nuking their own context. `` → carve out the exception explicitly, e.g.: "**Destructive commands** (`project rm`, `worktree rm`, `mode rm`) **require explicit ids** — no env-var defaults — to prevent agents accidentally nuking their own context. `session terminate` is the one deliberate exception: it defaults to `$VST_SESSION` so an agent can end itself; the daemon's `isMain` guard (`DELETE /sessions/:id`) still rejects a worktree's main-slot session regardless of how the id was supplied." Do not just swap the word `kill`→`terminate` inside the old sentence — that would leave the doc asserting the opposite of Decision 2.
- [x] **3.4** `docs/API-CONTRACT.md:170` — "Caller must kill those sessions first." → "Caller must terminate those sessions first."
- [x] **3.6** `docs/SESSION-EXECUTION.md:122` — row label "Dismiss (keep files)" → "Terminate" (and drop the now-doubly-wrong "(keep files)" qualifier — the column to its right already correctly says "no — record + data dir removed").
- [x] **3.7** `docs/SESSION-EXECUTION.md:126` — row label for the terminal-tab "×" stays `DELETE /sessions/:id` but rename the "User action" cell to "Terminal tab **×** (Terminate)" for consistency with 3.6.
- [x] **3.8** `docs/SESSION-EXECUTION.md:129` — "'Dismiss' is never client-side — both variants are real daemon deletes." → "'Terminate'/'Dismiss' are never client-side — every variant is a real daemon delete." (keeps the still-valid worktree-level "Dismiss" name from Out of Scope, adds "Terminate" for the session-level one this plan introduces).
- [x] **3.9** `docs/HIGH-LEVEL-DESIGN.md:351` — "cannot be killed via" → "cannot be terminated via".
- [x] **3.10** `docs/HIGH-LEVEL-DESIGN.md:465` — `{create,ls,info,kill,attach,restore,output}` → `{create,ls,info,terminate,attach,restore,output}`; the same sentence's "non-destructive commands default to those [env vars]" also needs the Decision-2 carve-out — reword to "non-destructive commands default to those; `session terminate` is the one destructive exception, defaulting to `$VST_SESSION`."
- [x] **3.11** `skill/SKILL.md:398-401` — `## 11. Tear down` block: comment `# Kill a specific session (non-main only)` (at `:401`) → `# Terminate a specific session (non-main only; omit the id to terminate the caller's own session via $VST_SESSION)`; CLI equivalents block `vst session kill <sessionId>` (at `:411`) → `vst session terminate [sessionId]`.
- [x] **3.12** `skill/SKILL.md:404,418,426` — prose "kills all sessions" / "all sessions killed" / "only kill sessions or worktrees" → "terminates all sessions" / "all sessions terminated" / "only terminate sessions or worktrees" (verify exact line numbers at edit time — the "Tear down" section header/body may have shifted after 3.11).
- [x] **3.12a** `skill/SKILL.md:209` — `` **Kill a non-main session.** `` (the `### DELETE /sessions/:id` REST reference entry) → `` **Terminate a non-main session.** ``
- [x] **3.12b** `docs/HIGH-LEVEL-DESIGN.md:287` — "Tabs are independent — kill/resume one without affecting siblings." → "Tabs are independent — terminate/resume one without affecting siblings."
- [x] **3.13** Re-sync the installed copy: `cp skill/SKILL.md ~/.claude/skills/vst/SKILL.md` (confirmed byte-identical today, not a symlink — this copy is what agents actually read via the `vst` skill and would otherwise keep teaching the removed `kill` spelling).
- [x] **3.14** `README.md:178` — `vst session kill <session-id>       # any session except the main slot` → `vst session terminate [session-id]  # defaults to your own session ($VST_SESSION); any session except the main slot`.
- [x] **3.15** `README.md:377` — "...send message, kill session)..." → "...send message, terminate session)...".
- [x] **3.16** `README.md:422` — `create | kill | ls | info | attach | restore | output` → `create | terminate | ls | info | attach | restore | output`.

**Verify phase 3:**
- [x] **3.T1** Regression — `grep -rniE "session kill|vst session kill" docs/ skill/SKILL.md ~/.claude/skills/vst/SKILL.md README.md` returns zero hits after edits.
- [x] **3.T2** Regression — `grep -rniE "\bkill" docs/API-CONTRACT.md docs/HIGH-LEVEL-DESIGN.md skill/SKILL.md README.md` — every remaining hit is either internal (`killSession`, `tmux kill-session`) or explicitly Out of Scope (`worktree rm` cascade prose "kills all sessions" is IN scope per 3.12 — confirm it was actually caught, not skipped).
- [x] **3.T3** Manual read-through — `docs/SESSION-EXECUTION.md`'s retire-path table no longer has a row whose two columns contradict each other; `docs/API-CONTRACT.md:94-100` no longer says `session terminate` requires an explicit id with no env-var default.

### Phase 4 — Web UI: unify session-ending copy and identifiers on "Terminate"

- [x] **4.1** `web-ui/src/api/client.ts:481` — rename `deleteSession` → `terminateSession` (keep body/route identical: `DELETE /sessions/${encodeURIComponent(id)}`).
- [x] **4.2** `web-ui/src/api/mock.ts:558` — same rename, mirrors client.ts.
- [x] **4.3** `web-ui/src/components/layout/WorkspaceCanvas.tsx:1405-1416` — `ConfirmDialog` for `terminateTarget`: `title="Close agent"` → `title="Terminate agent?"`, `message="Close this agent session?"` → `message="Terminate this agent session?"`, `confirmLabel="Close"` → `confirmLabel="Terminate"`; update the `api.deleteSession(...)` call at `:1414` → `api.terminateSession(...)`; update the stale doc-comment at `:1401-1403` referencing `deleteSession` → `terminateSession`.
- [x] **4.4** `web-ui/src/components/layout/TabsStrip.tsx` — rename `closeTarget`/`setCloseTarget` → `terminateTarget`/`setTerminateTarget` (declaration `:137`; `setCloseTarget` calls incl. `:686`; comment references at `:140` and `:796`, both currently say `` Mirrors `closeTarget`'s... `` — update to `terminateTarget`); `:684` aria-label `` `Close ${label}` `` → `` `Terminate ${label}` `` — **except** `PaneTools.tsx`'s "Close terminal dock" button (a dock-visibility toggle, not a session delete — confirmed by `TabsStrip.test.tsx:136,147` which target it separately; do not touch); `:733-736` dialog `open={!!closeTarget}` → `open={!!terminateTarget}`, `title={isAgent ? "Close agent" : "Close terminal"}` → `title={isAgent ? "Terminate agent?" : "Terminate terminal?"}`, message `` "Close this agent session?" : "Close this terminal?" `` → `` "Terminate this agent session?" : "Terminate this terminal?" ``, `confirmLabel="Close"` → `confirmLabel="Terminate"`; `:739` `api.deleteSession(closeTarget.id)` → `api.terminateSession(terminateTarget.id)`.
- [x] **4.5** `web-ui/src/components/layout/TabsStrip.test.tsx` — update assertions that target the renamed aria-label AND the renamed `confirmLabel`: `:100,111,112` `/Close agent-2/i` → `/Terminate agent-2/i`; `:234` `/Close Terminal 1/i` → `/Terminate Terminal 1/i`; `:236` — the dialog's confirm button, matched via `within(screen.getByRole("dialog")).getByRole("button", { name: /^Close$/i })` (its accessible name IS `confirmLabel`, per `ConfirmDialog.tsx:39-45`) — `/^Close$/i` → `/^Terminate$/i`; `:453` `toHaveAttribute("aria-label", "Close agent-2")` → `toHaveAttribute("aria-label", "Terminate agent-2")`; `:90` `querySelector('[aria-label^="Close"]')` → `querySelector('[aria-label^="Terminate"]')` (still passes unchanged today, but only vacuously — would silently stop catching a regression otherwise). Do **not** touch `:136,147` (`/Close terminal dock/i`) — that's the unrelated `PaneTools.tsx` dock toggle from 4.4.
- [x] **4.6** `web-ui/src/components/layout/LeftSidebar.tsx` — rename `pendingDismissSession`/`setPendingDismissSession` → `pendingTerminateSession`/`setPendingTerminateSession` (`:566,736-738,1830,1833-1839,2026`); rename `confirmDismissSession` → `confirmTerminateSession` (`:735`); `:747` `api.deleteSession(sess.id)` → `api.terminateSession(sess.id)`; `:1831` title `"Dismiss agent?"` → `"Terminate agent?"`; `:1834` message `` `Remove "${sessionLabel(pendingDismissSession)}" from vst? The agent process is stopped. Your project files are NOT touched.` `` → `` `Terminate "${sessionLabel(pendingTerminateSession)}"? The agent process is stopped. Your project files are NOT touched.` ``; `:1837` `confirmLabel="Dismiss"` → `confirmLabel="Terminate"`; `:2030` menu item text `Dismiss` → `Terminate`. Do **not** touch `pendingDismiss`/`confirmDismissWorktree`/`dismissWorktree` (worktree-level, Out of Scope).
- [x] **4.7** Grep-verify no stray reference remains anywhere in `web-ui/src` (comments included): `grep -rnE "deleteSession|closeTarget|pendingDismissSession|confirmDismissSession" web-ui/src` — zero hits (plain `-n` without `-E` treats `|` as a literal character and would always report zero hits regardless of whether any were actually missed — must use `-E` or `-e` per-term).

**Verify phase 4:**
- [x] **4.T1** Regression — `pnpm --filter @vibestation/web typecheck` passes (renamed method flows through every call site via the inferred `createClientApi()` return type — a stray `api.deleteSession` call would now be a type error).
- [x] **4.T2** Regression — `pnpm --filter @vibestation/web test` passes after 4.5's assertion updates (the identifier rename alone has no test impact per Research, but the aria-label copy change does — this was missed in the first plan draft and is why 4.5 exists).
- [ ] **4.T3** Manual — start the dev sandbox (or existing `pnpm --filter @vibestation/web dev`), open a worktree with ≥2 sessions, confirm: tab "×" dialog says "Terminate agent?"/"Terminate terminal?"; sidebar per-session menu item says "Terminate" and its dialog says "Terminate agent?"; canvas tile menu's "Terminate" item's dialog says "Terminate agent?" (not "Close agent"); worktree-level "Dismiss (keep files)" wording is untouched; the terminal-dock collapse button still says "Close terminal dock" (unrelated toggle, confirms 4.4's exclusion held). **NOT performed** — skipped in favor of the automated coverage in 4.T2 (`TabsStrip.test.tsx`/`LeftSidebar.test.tsx` assert the exact same copy strings via `getByRole`/`toHaveAttribute`, which is equivalent verification for a pure-text-change PR); flag if a human reviewer wants an actual screenshot pass before merge.

### Phase 5 — Full verification + PR

- [x] **5.1** `pnpm typecheck && pnpm lint && pnpm test` (repo root `ci` script) — all green.
- [x] **5.2** `grep -rniE "kill" cli/src/commands/session/ daemon/src/assets/agent-system-prompt.md skill/SKILL.md docs/API-CONTRACT.md docs/HIGH-LEVEL-DESIGN.md docs/SESSION-EXECUTION.md README.md` (note: `\bkill\b` misses `killSession`/`killed`/`kills` — use the plain substring match instead) — confirm every remaining hit is either internal (`killSession`, `tmux kill-session`, `directPtyRegistry.kill()`) or explicitly Out of Scope (`worktree rm` cascade prose "kills N sessions" describing the `worktree rm` command itself, not `session terminate`), not a user-facing "kill" describing the session-terminate action.
- [ ] **5.3** Single commit, all phases' changes together (per SDLC "one logical commit per sub-feature").
- [ ] **5.4** Open PR against `main` from `api-somewhere-terminate`.

**Verify phase 5:**
- [x] **5.T1** CI-equivalent (`pnpm ci`) green locally before opening the PR.
- [ ] **5.T2** PR description explicitly calls out the Decision 1 clean-rename (no `kill` alias) and Out-of-Scope items, so reviewers don't flag them as missed spots.

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `cli/src/commands/session/terminate.ts` | **New** (renamed from `kill.ts`) | 1.1 | Contract: `registerSessionTerminate(session: Command): void` — `terminate [id]`, defaults `id` to `$VST_SESSION` |
| `cli/src/commands/session/kill.ts` | **Removed** | 1.1 | Superseded by `terminate.ts` |
| `cli/src/program.ts` | Modified | 1.2 | Import/registration swap only |
| `cli/src/__tests__/session-terminate.test.ts` | **New** | 1.T1-1.T4 | Unit tests for arg/env resolution + error/400 paths |
| `daemon/src/assets/agent-system-prompt.md` | Modified | 2.1-2.7 | Prose-only: hedge worktree claims throughout (not just the intro), fix done/exit wording, add "Ending your session", `kill`→`terminate` |
| `docs/API-CONTRACT.md` | Modified | 3.1-3.4 | Prose-only; carves out the `session terminate`/`$VST_SESSION` exception from the "no env-var defaults for destructive commands" rule (Decision 2) |
| `docs/SESSION-EXECUTION.md` | Modified | 3.6-3.8 | Prose-only; fixes a factually-wrong row label |
| `docs/HIGH-LEVEL-DESIGN.md` | Modified | 3.9,3.10,3.12b | Prose-only; same env-var-default carve-out as API-CONTRACT.md |
| `skill/SKILL.md` | Modified | 3.11,3.12,3.12a | Prose-only |
| `~/.claude/skills/vst/SKILL.md` | Modified | 3.13 | Re-synced copy (not part of the repo/git diff — a local file outside the worktree, done as a side effect, not committed) |
| `README.md` | Modified | 3.14-3.16 | Prose-only |
| `web-ui/src/api/client.ts` | Modified | 4.1 | Contract: `deleteSession` → `terminateSession(id: string): Promise<{ok:true}>` — same route |
| `web-ui/src/api/mock.ts` | Modified | 4.2 | Mirrors client.ts rename |
| `web-ui/src/components/layout/WorkspaceCanvas.tsx` | Modified | 4.3 | Copy + call-site rename only |
| `web-ui/src/components/layout/TabsStrip.tsx` | Modified | 4.4 | Identifier rename (`closeTarget`→`terminateTarget`) + copy + call-site rename |
| `web-ui/src/components/layout/TabsStrip.test.tsx` | Modified | 4.5 | Aria-label assertion updates for the 4.4 copy change |
| `web-ui/src/components/layout/LeftSidebar.tsx` | Modified | 4.6 | Identifier rename (session-scoped only) + copy + call-site rename |

---

## Self-Containment Check

- No pronouns without antecedent — every file reference above carries a path (+ line number where the plan cites specific text).
- Boundary contract (`DELETE /sessions/:id`) explicitly stated as unchanged, so the implementer never has to guess a shape.
- Verification steps are runnable commands (`pnpm --filter ... test`, `grep -rn ...`) or a concrete manual click-path, not "run the tests."
- No dependency on chat history — Problem/Root Cause sections restate why each file is touched.
