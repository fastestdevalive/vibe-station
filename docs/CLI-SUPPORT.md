# CLI Mid-Turn Support Matrix

Source of truth for mid-turn message injection capability and context window exposure
across all CLI agent integrations. Update this file when a CLI ships a new ACP version
or the daemon wires a new capability.

## Mid-turn message injection

"Mid-turn injection" means the user sends a message while the agent is already running a
turn, and the message reaches the agent **without cancelling the active turn**. The
alternative is cancel-and-resend (the agent stops, the message is queued, a new turn
starts).

The daemon gates injection via `JsonAgentSession.submit()` (`daemon/src/services/jsonAgent.ts`).
When ALL conditions are met — turn is running, abort signal not yet fired, queue empty,
no attachments, not first-turn-pending, connection alive, `supportsSteering` true, AND
`plugin.supportsMidTurnSteering?.() === true` — it calls `AcpConnection.steer()`
(`daemon/src/services/acp/acpTransport.ts`) which sends a `_session/steering` JSON-RPC
request over the ACP stdio channel. On any failure or when the gate fails, it falls back
silently to `enqueue()`.

**Two gates, not one.** `supportsSteering` is what the CLI *claims* — read from its ACP
`initialize` handshake response (`result._meta.steering.supported === true`).
`AgentPlugin.supportsMidTurnSteering()` (`daemon/src/services/spawn.ts`) is what we have
*verified*, and it is opt-in: a plugin that omits the method never steers. Both must be
true. The second gate exists because the first one proved untrustworthy — opencode
advertises steering and answers `_session/steering` with `outcome: "injected"`, but the
injected text never reaches the model, so the user's message is silently swallowed.
Queueing is lossless, so it is the correct default. Adding the flag to a new CLI's
`initialize` response is therefore NOT sufficient: verify steering end-to-end (send a
mid-turn message, confirm the running turn actually acts on it), then implement
`supportsMidTurnSteering(): boolean { return true; }` on that plugin.

| CLI | Mid-turn injection? | Mechanism | Notes |
|-----|---------------------|-----------|-------|
| **Claude** | Available; verified end-to-end | `_session/steering` ACP extension — daemon sends `{ sessionId, prompt: PromptBlock[], _meta: { steering: { idleBehavior: "promptRequired" } } }` | Added in `claude-agent-acp` v0.70.0 (PR #919). Claude reports `_meta.steering.supported: true` in its ACP `initialize` response, which flips `supportsSteering` in the daemon. The only plugin implementing `supportsMidTurnSteering()`. |
| **Opencode** | **Not supported — deliberately disabled** | Advertises `_session/steering` and replies `outcome: "injected"`, but the injected message never reaches the model | Empirically verified broken: the steer is acknowledged and then silently dropped, so the user watches their message vanish. Opencode does NOT implement `supportsMidTurnSteering()`, so `submit()` always falls through to `enqueue()` (lossless). Re-enable only after a fixed opencode version is verified end-to-end. |
| **Agy** | Not supported | `antigravity-acp` v1.1.0 exposes `session/prompt` + `session/cancel` only; no `_session/steering` method | Cancel-and-resend is the ceiling. `supportsSteering` will be `false` from the handshake; `submit()` falls through to `enqueue()`. |
| **Cursor** | Not supported | `cursor-agent` ACP is a closed binary; no steering surface; also reports `supportsChannelResume: false` | Cancelling a turn starts a fresh conversation, not a continuation. No workaround available without a cursor-agent update. |

## Context window

"Context window" here means the maximum token budget for a single agent turn, and
whether vibe-station can influence it.

| CLI | Context window | Knob exposed? | Notes |
|-----|---------------|---------------|-------|
| **Claude** | Up to 1 M tokens via `betas: ["context-1m-2025-08-07"]` | Not currently passed | Beta available for Sonnet 4 / 4.5 only. Fix tracked in worktree `vs-65`. Without the beta header the default ceiling applies. |
| **Opencode** | CLI-managed | None | Opencode controls its own context budget internally. No ACP field exposes it. |
| **Cursor** | CLI-managed | None | Same as opencode — cursor-agent manages context internally. |
| **Agy** | CLI-managed | None | Same as opencode. |

## How `submit()` decides steer vs enqueue

```
JsonAgentSession.submit(input)
  ├─ canAttemptSteer gate (all must be true):
  │   ├─ this.running                          — turn is active
  │   ├─ this.activeAbort !== null             — abort controller exists
  │   ├─ !this.activeAbort.signal.aborted      — not yet cancelled
  │   ├─ this.queue.length === 0               — nothing already queued (preserve FIFO)
  │   ├─ !attachments.length                   — attachments never inject (runOneTurn path)
  │   ├─ !this.isFirstTurnPending              — session has had at least one turn
  │   ├─ this.connection?.isAlive()            — ACP process is alive
  │   ├─ this.connection.supportsSteering      — CLI CLAIMS support in initialize()
  │   └─ plugin.supportsMidTurnSteering?.()    — we VERIFIED it works (claude only)
  │
  ├─ YES → AcpConnection.steer(blocks)
  │         ├─ "injected"      → emitUserEvent(newTurnId) once; return { delivery: "steered" }
  │         ├─ "promptRequired"→ fall through to enqueue()
  │         └─ "unsupported"   → fall through to enqueue()
  │
  └─ NO  → this.enqueue(input) → return { delivery: "queued" }
```

The `delivery` field is surfaced in the `POST /sessions/:id/chat` 202 response body
and forwarded to the web-ui pending bubble (`useChat.ts`). The Composer's `aria-label`
on the send button changes to "Interrupts and steers the running turn" when
`meta.canSteer` is true (set in `getMeta()`, polled via the session WS stream).
