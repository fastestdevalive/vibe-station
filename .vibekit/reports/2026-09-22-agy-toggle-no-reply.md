<!--
RULES — read before writing this report:
1. This is a SMALL file — bugs, root cause, action items, optional diagrams. Nothing else.
2. FORMAT: tables, bullet points, mermaid diagrams ONLY — no prose paragraphs
3. An empty section is omitted entirely, never left as a stub heading
4. This file MUST be written to disk at the path below — never answer `/sdlc report` in chat only
-->

# SDLC report: agy-acp-openab — "agy Rich Chat gets no reply after tty→json toggle"

**Date:** 2026-09-22 · **Commit:** `35b5c00` (branch `acp-even-itnegration`) · **Sub-feature(s) covered:** `agy-acp-openab` (wip plan §6.1/6.9/6.10) · **Method:** live dev sandbox `vs-165-vst-dev-1` (daemon `127.0.0.1:7421`, agy `1.2.8`, real openab `agy-acp`), no mocks, no code changes

## Bugs

| # | Symptom | Where found | Severity |
|---|---------|-------------|----------|
| B1 | Any agy Rich Chat turn in which the model decides to call a tool (`RunCommand`, `ViewFile`, …) ends as `user → result` with **no `text`, no tool event, no error** — the user sees "no reply". Reproduces on the toggled session **and** on a never-toggled fresh json session; a no-tool prompt on the same toggled session replies fine → **the tty→json toggle is NOT the cause** | live sandbox, `POST /api/sessions/:id/chat` ×3 (evidence in Root cause) | high — every non-trivial agy Rich Chat turn is silently empty |
| B2 | The reason agy produced no answer (headless permission auto-deny) is printed by agy on stderr and forwarded by the adapter, but is discarded at three layers, so nothing reaches the transcript or daemon log | `rust/vendor/openab/agy-acp/src/main.rs:211-222`, `rust/vst-agents/src/acp_connection.rs:387-391` | medium — turns B1 from "diagnosable in 1 min" into a multi-hour hunt |
| B3 | agy Rich Chat runs in the **daemon's cwd** (`/app`), not the worktree: `--add-dir /app`, `current_dir(/app)` — the ACP `session/new` `cwd` is ignored by the adapter | `ps`: `agy-acp 4036 cwd=/app`; plan §6.11 argv `agy --add-dir /app …` | medium — wrong workspace trust/`--add-dir`; the attachment `read_file` in turn 3 was denied on a path outside `/app` |
| — | Task premise "agy genuinely produced 3 real replies" is **false**: the 3 `step_type=15` rows (idx 1/5/9) are reasoning/plan steps (`f20.f3` thought-summary + `f20.f7` blob, **no `f20.f1` text**); each is followed by a `step_type=132` tool step with `status` 6/7 and `error_details = "permission check failed … user denied permission"` — no final answer was ever generated | agy DB `6fd68e36….db` (python dump below) | n/a — corrects the investigation brief |

## Root cause

- **`headless permission deny`** → `rust/vst-agents/src/agy.rs:553-572` (ACP `AcpLaunchSpec`: `args: Vec::new()`, env only `AGY_BIN` + `AGY_ACP_STATE_DIR`) vs `agy.rs:349-352,393,528-530` (TTY launch/restore always pass `--dangerously-skip-permissions`) → the adapter spawns `agy --add-dir <wd> --print-timeout 60m [--conversation id] -p <prompt>` (`rust/vendor/openab/agy-acp/src/adapter.rs:367-382`) with **no permission flag**, so agy runs `toolPermission=request-review` and, in print mode, **soft-denies every tool confirmation and stops the stream** — the model never gets to write a final message.
  - agy log turn 1 `~/.gemini/antigravity-cli/log/cli-20260922_153349.log:49,122-126`: `CLI settings initialized: permissions=<nil>, toolPermission=request-review` … `Print mode: soft-denying tool confirmation "RunCommand" at step 2` … `approved=false` … `Stopping conversation stream`
  - turn 2 `cli-20260922_153402.log:173` `soft-denying … "RunCommand" at step 6`; turn 3 `cli-20260922_153416.log:161` `soft-denying … "ViewFile" at step 10`
  - agy DB `6fd68e36-a82f-4abb-9671-7760230253f2.db` (`python3` sqlite3 dump): `idx 2 type 132 status 6` (no err); `idx 6 type 132 status 7 err="permission check failed for unsandboxed \"git status\": user denied permission to run command"`; `idx 10 type 132 status 7 err="permission check failed for read_file \"…/uploads/…/always-on.jpeg\": user denied permission"`; the `type 15` rows at idx 1/5/9 have `f20` = `{f3: <thought summary>, f6: bot-id, f7: <blob>, f12}` — **no `f1`**
  - **Direct A/B, same prompt, agy only** (`docker exec … agy --add-dir /tmp/agyrepro --print-timeout 3m -p "Run the shell command git status … verbatim."`):
    - A (no flag): `exit=0`, `stdout bytes=0`, **stderr:** `jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json … Alternatively, re-run with --dangerously-skip-permissions`; DB `4ec8de05….db`: `0/14, 1/15 (no f1), 2/132 status 7 denied`
    - B (`--dangerously-skip-permissions`): `exit=0`, stdout = the answer; DB `95b4cd15….db`: `0/14, 1/15, 2/132 status 3, 3/15 f20.1="```\nOn branch master\nnothing to commit…"`
  - **Live discriminating experiment through the daemon** (`/tmp/turn.py` → `POST /api/sessions/:id/chat`, poll `/transcript`):
    - toggled repro session `luminary-docs-a-b79e3929`, prompt "Reply with exactly the word PONG. Do not run any tools" → `user → text 'PONG' → result` ✅ (agy log `cli-20260922_163317.log`: no soft-deny)
    - same toggled session, "Run the shell command git status …" → `user → result` ❌ (`cli-20260922_163323.log:161` `soft-denying "RunCommand" at step 17`)
    - fresh never-toggled json session `ldoc-2-a-f0239456` (conv `ee84ae6c…`), same tool prompt → `user → result` ❌ (`cli-20260922_163329.log:151` `soft-denying "RunCommand" at step 5`)
    - a third json session's conversation `b2ff9701….db` (its vst record since deleted) shows the identical first-turn failure `idx 2 type 132 status 7 "git status" denied`, then normal replies on tool-free turns — same mechanism, no toggle involved
- **`why the toggle case looks 100% broken`** → `rust/vst-agents/src/acp_run_turn.rs:108` + `agy.rs:583-590` prepend the L1 system prompt (`rust/vst-agents/assets/agent-system-prompt.md:26,39`: "check for `AGENTS.md`…", "`git branch --show-current` to confirm") on the first turn of every new ACP connection (`promptLength=12792` in `cli-20260922_153349.log:46`) → the model reaches for `RunCommand` on even "Whats up?"; the tty phase had `--dangerously-skip-permissions` so the same behaviour *worked* there, and the fresh-json control ("Say PONG") never calls a tool → the correlation with the toggle is coincidental. The `session/load`→`session/new` fallback (`rust/vst-agents/src/json_agent_session/connection.rs:97-122`) and `Shared.session_id` routing (`acp_connection.rs:396-408`: sink is a single `active_update`, not keyed by session id) are **not** involved — notifications for the fresh session would have been routed correctly had the adapter emitted any.
- **`three silent layers (B2)`** → the denial is observable but dropped at each hop:
  1. adapter streaming: `rust/vendor/openab/agy-acp/src/streaming.rs:84-88` only extracts `f20.f1` (`protobuf.rs:3-8`), so a reasoning-only `type 15` row yields nothing (`continue`) — but still advances `last_step_idx` (`:84`, hence `last_step_idx: 9` in `~/.vibe-station/agy-acp/sessions.json`); `step_type 132` is not in `is_tool_step_type` (`protobuf.rs:61-64`) and the `error_details` column is never read → no `tool_call` update, `had_updates` stays `false` (`streaming.rs:166`)
  2. adapter turn result: `main.rs:150-151` prints agy's stderr (`[agy-acp] agy stderr: jetski: no output produced … auto-denied`) to the adapter's own stderr, then `decide_turn_error` (`main.rs:211-222`) ignores `stderr_text` whenever `status_success` is true; `detect_swallowed_agy_error` (`main.rs:303-393,444`) scans only `cli-*.log` for `agent executor error:` / `model unreachable:` / `RESOURCE_EXHAUSTED` — "soft-denying"/"auto-denied" are not anchors → `None` → `stopReason: "end_turn"` (`main.rs:144-146,188-193`)
  3. our client: `acp_connection.rs:387-391` builds `AcpAgent::new(AcpAgentConfig…)` without the crate's `with_debug` stderr callback (`~/.cargo/registry/src/*/agent-client-protocol-2.1.0/src/acp_agent.rs:221-236`; `grep with_debug rust/vst-agents` → none), and `acp_run_turn.rs:172-178` emits a bare `result` for `EndTurn` with zero updates (`emit_refusal_error: false`, `agy.rs:591`) — no daemon-side warning either (`docker logs vs-165-vst-dev-1 | grep agy-acp` → empty)
- **`cwd (B3)`** → `acp_connection.rs:26-29` (documented gap: child spawned in daemon cwd), `adapter.rs:48-50` (`working_dir = current_dir()`), `main.rs:565-574` (`session/new` handler never reads `params.cwd`) → `--add-dir /app` and `current_dir(/app)`; the tty session (spawned in the worktree via tmux) is what added `…/worktrees/ldoc-1` to `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`, not the ACP path.

## Action items

| # | Action | Owner sub-feature | Status |
|---|--------|--------------------|--------|
| A1 | **Fix B1 (one-line, no submodule change):** in `rust/vst-agents/src/agy.rs:563-569` add `("AGY_EXTRA_ARGS".to_string(), "--dangerously-skip-permissions".to_string())` to the `AcpLaunchSpec.env` — the adapter already splices `AGY_EXTRA_ARGS` into every `-p` invocation (`adapter.rs:15-28,370`), matching the TTY launch's existing flag (`agy.rs:352`). Verified equivalent by A/B run B above. Update `agy.rs:3` module doc and `docs/CLI-SUPPORT.md` agy row to state that ACP turns run with permissions skipped (same policy as tty) | `agy-acp-openab` (amend plan §6.1 / new §6.12) | open |
| A2 | **Surface the denial instead of `end_turn` (B2, adapter fork):** in `main.rs:decide_turn_error` (`:211-222`) treat `status_success && !had_updates && !stderr_text.is_empty()` as `-32603` with the stderr text; add `"auto-denied"` / `"soft-denying tool confirmation"` to `ANCHORS` (`main.rs:444`) so `detect_swallowed_agy_error` catches it even when stderr is empty; in `streaming.rs` read `error_details` for `status ∈ {6,7}` rows and emit a `tool_call_update {status:"failed", content: error_details}` (add `132` to `is_tool_step_type`, `protobuf.rs:61-64`). Lands as a fork commit + upstream PR per plan D4 | `agy-acp-openab` (new bundle `NN-agy-acp-surface-denials`) | open |
| A3 | **Log adapter stderr daemon-side (B2, ours):** register `AcpAgentConfig::with_debug` (or the config-level equivalent) in `acp_connection.rs:387-391` and route `LineDirection::Stderr` lines to `tracing::warn!` tagged with the session id — would have printed `[agy-acp] agy stderr: … auto-denied` in `docker logs` on the very first failing turn | `agy-acp-openab` (same bundle as A2) | open |
| A4 | **Fix B3:** pass the worktree cwd to the adapter — either honor `params.cwd` in `handle_session_new`/`handle_session_load` (`main.rs:565-585`, `adapter.rs:288-317`, store per-session `working_dir` and use it in `prepare_prompt_state` `:368-369` + `execute_prompt` `:45`), or set the child's cwd at spawn (`acp_connection.rs:26-29` gap — needs the crate's `AcpAgentConfig` cwd support or a wrapper). Re-check plan §6.11's `--add-dir /app` evidence afterwards | `agy-acp-openab` (new bundle) | open |
| A5 | **Regression test:** `rust/vst-agents/tests` — assert the agy `AcpLaunchSpec.env` carries `AGY_EXTRA_ARGS` containing `--dangerously-skip-permissions`; agy-acp contract test (`CI 10.4`) — feed a fixture DB with a `type 15 (no f1)` + `type 132 status 7 error_details` pair and assert the turn yields an error/tool-failed update, not `end_turn` | `agy-acp-openab` | open |
| A6 | **Docs/plan hygiene:** plan §6.10's "cross-session leakage" root cause should be re-examined with A3's stderr logging in place — the `b2ff9701` evidence shows an empty turn (`end_turn`, no text) is the *normal* denial outcome, so at least the "session A got no text" half of §6.10 is B1, not leakage; only the "B's text appeared in A" half needs separate investigation. Correct the task brief's "3 real replies" premise where it was copied (`.vibekit/feature-plans/wip/agy-acp-openab/plan-agy-acp-openab.md` verification section) | `agy-acp-openab` | open |
| A7 | Not the cause — leave as-is: `session/load`→`session/new` fallback + missing `NativeHistoryImporter` for agy (`rust/vst-agents/src/native_history_importer.rs`), and the single-sink `active_update` routing (`acp_connection.rs:125-126,396-408`) — both behaved correctly in every turn observed | — | no change |

## Diagrams

```mermaid
sequenceDiagram
    participant D as vst-daemon (acp_run_turn)
    participant A as agy-acp (openab, fork)
    participant G as agy -p (print mode)
    participant DB as ~/.gemini/…/conversations/<conv>.db
    D->>A: session/prompt (text)
    A->>G: agy --add-dir /app --print-timeout 60m -p … (NO --dangerously-skip-permissions)
    G->>DB: idx N   type 15  (reasoning: f20.f3/f7, no f20.f1)
    G->>DB: idx N+1 type 132 status 7, error_details="user denied permission"
    Note over G: toolPermission=request-review → "soft-denying tool confirmation" → stream stopped
    G-->>A: exit 0, stdout empty, stderr "jetski: no output produced … auto-denied"
    A->>DB: poll: type 15 has no f1 → skip; 132 not a tool type → skip; had_updates=false
    Note over A: main.rs:150 eprintln stderr → main.rs:211-222 ignores it (exit 0)
    A-->>D: session/prompt result {stopReason:"end_turn"} (zero session/update)
    Note over D: acp_connection.rs:387 no with_debug → stderr dropped
    D-->>D: transcript: user → result (no text, no error)
```
