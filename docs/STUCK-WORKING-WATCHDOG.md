# Rich Chat "stuck at working" — root cause and fix

## The bug

A Rich Chat (json-channel) session could stay pinned at lifecycle `working`
in the UI forever (or for up to an hour) even though the agent had visibly
finished producing output. Diagnosed on `vs-176`, session
`vs-176-a-ee013df3`: the model streamed its last `text` chunk, then nothing
— no `result`, no `error`, no further `session/update` — ever arrived.

## Why the state got stuck: only one place ever clears `working`

For a json-channel session, **`drain_loop`'s finally block is the only
code path that writes `LifecycleState::WaitingForHuman`**
(`rust/vst-agents/src/json_agent_session/drain.rs:126-129`). The regular
1s lifecycle poller explicitly skips json sessions
(`rust/vst-lifecycle/src/lifecycle.rs:60`), so there is no independent
watchdog correcting a stuck value from outside the turn itself.

That finally block only runs after the outer `loop` in `drain_loop` exits,
which only happens once every queued turn's `run_one_turn().await`
(`drain.rs:71`) has returned. `run_one_turn` bottoms out in
`run_turn_acp`'s `turn.result.await`
(`rust/vst-agents/src/acp_run_turn.rs`) — a `oneshot::Receiver` that only
resolves when the ACP adapter answers the outstanding `session/prompt`
JSON-RPC request.

**If the adapter never answers, `run_turn_acp` never returns, `drain_loop`
never reaches the finally block, and `WaitingForHuman` is never written —
the session is structurally stuck at whatever state was written before the
turn started (`Working`).**

This is exactly what a vendored `claude-agent-acp` bug can trigger: after
two mid-turn steering injections into the same turn, an "owed trailing
idle" debt-counting bug can swallow the one SDK `idle` event that would
have settled the turn, so the adapter abandons the prompt — no more
updates, no result, no error, forever (confirmed against the adapter's own
source and against `vs-176`'s actual event log, including the adapter's
own `cancel floor elapsed without the SDK yielding; forcing "cancelled"`
log line once the user manually pressed Stop).

```
User "please continue"                                     UI still shows
        |                                                    "● working"
        v
run_one_turn ──▶ run_turn_acp ──▶ conn.send_prompt("session/prompt")
                        |
                        |  adapter streams updates normally...
                        |  ...then silently stops. No result. No error.
                        v
                 turn.result.await   ⟵ never resolves
                        |
              run_turn_acp never returns
                        |
              run_one_turn never returns
                        |
              drain_loop's outer `loop` never exits
                        |
              "Finally block" (the ONLY writer of WaitingForHuman)
              is NEVER REACHED
                        |
              session.lifecycle.state stays `Working` — forever,
              or until do_send_prompt's own 60-minute silent-idle
              timeout eventually fires.
```

## The fix: a narrower watchdog inside `run_turn_acp`

`do_send_prompt` already had a safety net — a 60-minute *silent* idle
timeout (`DEFAULT_PROMPT_TIMEOUT_MS` in `acp_connection.rs`), deliberately
generous because a turn can legitimately go quiet for a long time while a
background tool call is outstanding. That net is real, but an hour is a
bad user experience for the much more common shape of this bug: the model
is done, no tool is running, and the adapter just forgot to say so.

`run_turn_acp`'s update-drain loop now tracks two things while it waits:

- **Open tool calls** — a `ToolUse` whose matching `ToolResult` has not
  yet arrived with a terminal status (`Completed`/`Failed`; an
  in-progress `rawInput` refinement update does **not** count as done).
- **Time since the last `session/update`.**

If there are **no open tool calls** and **10 minutes** pass with no
update, the daemon:

1. Sends `session/cancel` itself (`conn.cancel_active_prompt()`) — the
   standard ACP client→agent cancellation notification. Per the protocol
   spec, the agent SHOULD answer the outstanding `session/prompt` with
   `StopReason::Cancelled` after this.
2. Waits up to **45 seconds** (longer than the Claude adapter's own
   30-second forced-cancel floor) for that reply.
3. Either way, proceeds to emit a terminal `result` event — which lets
   `run_one_turn` return, which lets `drain_loop` reach its finally block
   and correctly write `WaitingForHuman`.

```
                    session/update stream                turn.result
                    (text / tool_use / tool_result)       (oneshot)
                           |                                  |
   run_turn_acp   ┌────────┴─────────┐                        |
   drain loop     │  tokio::select!  │◀── loop while updates   |
                  │                  │    keep resetting       |
                  │  update arrives ─┼──▶ deadline += 10min    |
                  │                  │    track open_tool_ids  |
                  │                  │    (Pending/InProgress  |
                  │                  │     stays "open")       |
                  │                  │                         |
                  │  10min silent AND│                         |
                  │  no open tool ───┼──▶ conn.cancel_active_   |
                  │                  │    prompt()              |
                  └────────┬─────────┘    (sends session/cancel)|
                           │                                    |
                           ▼                                    |
              wait ≤45s for turn.result ───────────────────────▶|
                           │                                    |
              ┌────────────┴─────────────┐                      |
              │ adapter answered in time?│                      |
              └──────┬─────────────┬─────┘                      |
                  yes│             │no                           
                     ▼             ▼
            use its StopReason   synthesize StopReason::Cancelled
                     │             │
                     └──────┬──────┘
                            ▼
                  emit terminal `result` event
                            │
                            ▼
                 run_turn_acp / run_one_turn return
                            │
                            ▼
              drain_loop reaches "Finally block"
                            │
                            ▼
        persist_lifecycle(LifecycleState::WaitingForHuman)
                            │
                            ▼
              UI flips "● working" → "waiting for you"
                (within minutes, not up to an hour)
```

A turn with a genuinely open tool call (e.g. a long-running background
`Monitor` invocation) is left completely alone — the watchdog's
`tokio::select!` branch is gated on `open_tool_ids.is_empty()`, so silence
there never trips it, and the existing 60-minute idle timeout remains the
backstop for that case.

## Second fix: don't let the abandoned turn clobber the next one

Giving up on `turn.result` early (step 2/3 above) means the original
`do_send_prompt` future is still running in the background when the
watchdog moves on. If the user starts a *new* turn before that old one
finally finishes, the old completion handler used to clear
`active_update` (the notification-routing sink) **unconditionally** —
which could wipe out the *new* turn's sink and silently drop its streamed
updates. `Command::SendPrompt` now carries its own sink handle, and the
completion handler only clears `active_update` if it still points at
*that* turn's sink (`Sender::same_channel`), never a newer one.

## What this does *not* fix

- **The adapter bug itself.** This is a defensive daemon-side recovery,
  not a fix to `claude-agent-acp`'s steering/idle-accounting bug. The
  concrete trigger (two mid-turn steers into one turn) is still worth
  reporting upstream or disabling (`supports_mid_turn_steering` for
  claude) if it recurs often — that's a product tradeoff, not folded into
  this change.
- **A daemon restart mid-turn.** That path is already handled separately:
  `recover_json_session` (`rust/vst-git/src/recover.rs:50`), wired into
  boot recovery at `rust/vst-daemon/src/main.rs:260`, reconciles any json
  session left at `working` after an unclean restart back to `idle`.

## Files changed

- `rust/vst-agents/src/acp_run_turn.rs` — the watchdog itself.
- `rust/vst-agents/src/acp_connection.rs` — `notif_handler` only resets
  the idle-timeout clock while a sink is attached; `Command::SendPrompt`
  sink-identity check to prevent the clobber race above.
