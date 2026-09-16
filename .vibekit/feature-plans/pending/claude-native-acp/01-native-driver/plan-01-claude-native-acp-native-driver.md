# Phase brief: 01 — native-driver

**Read first:** `../arch-claude-native-acp.md`, and `00-protocol-spike`'s
`protocol-notes.md` + spike report **in full** — this phase does not re-derive
the protocol, it builds on phase 00's findings. If phase 00 ended in "no-go" or
"reduced-scope", this phase's actual boundaries come from that report, not from
this brief's assumptions.

**Skill:** load `rust-coding`.
**Crate(s):** `vst-agents` (new module, e.g. `claude_native.rs` /
`claude_native/` submodule — do not touch `claude.rs`'s existing ACP-based path
yet, this phase builds the replacement alongside it, phase 02 does the swap).
**Depends on:** `00-protocol-spike` (must have reached "go" or a documented
reduced scope).

## Goal

A real, testable `vst-agents` driver that talks to the `claude` binary directly
(no Node, no ACP hop, no `claude-agent-acp`/`claude-agent-sdk`) and produces the
SAME `NormalizedEvent` stream the rest of the codebase already consumes — so
`run_turn`, transcript storage, WS broadcasting, and everything downstream of
`NormalizedEvent` needs **zero changes**. Only the turn-driving internals inside
the Claude plugin change.

## Use the official `agent-client-protocol` crate for the outer shape

Per the arch note's research: `agent-client-protocol` (already a dependency,
v2.1.0, confirmed to be the same project as `github.com/agentclientprotocol/rust-sdk`)
has a real `Agent` builder API for standing up the AGENT/server side of ACP
(`Agent.builder().on_receive_request(...).connect_to(...)`, see its
`examples/simple_agent.rs`). Use this for whatever ACP-facing surface still
makes sense in the new design — it saves hand-rolling JSON-RPC framing and
protocol-version negotiation. It does NOT help with the inner
claude-binary-specific protocol; that part is entirely phase 00's findings,
implemented fresh here.

**Design decision to make explicitly (don't skip past it):** does the new driver
need to expose an actual ACP server interface at all (since nothing else in this
codebase is an ACP client TO OUR code — we ARE the client today, driving
external ACP agents), or can it just be a direct `NormalizedEvent`-producing
driver with no ACP framing in the loop at all, matching how `opencode.rs`/
`cursor.rs` already work (their own native protocols, no ACP)? Answer this
before writing code — it changes the shape of everything else in this phase.
The likely right answer, given `NormalizedEvent` is the only real downstream
contract: skip the ACP-agent-server framing entirely and write a direct driver,
same shape as the other two plugins. Only reach for the `Agent` builder if
there's a concrete reason to keep an ACP-shaped interface (there may not be).

## Scope — feature parity target

Required (the common path):
- Spawn `claude` directly with the phase-00-determined flags, in the correct
  cwd, with the correct env (mirrors `claude.rs`'s existing `AcpLaunchSpec`
  construction for cwd/env conventions).
- Stream text + thinking deltas into `NormalizedEvent`s, matching what
  `run_turn_acp`'s existing event mapping produces today (same `NormalizedEventKind`
  variants, same shape) — a side-by-side diff against the existing ACP path's
  output for the same prompts is the right verification method, not a fresh
  design.
- Tool use + tool result events, including the diff-synthesis behavior
  `vst-agents::normalize` already has for write-tool calls (`tool_diffs_from_input`,
  `WRITE_TOOL_NAMES`) — reuse that existing code, don't reimplement it.
- Turn completion / usage reporting.
- Model selection (same model list, same flag mapping as the existing plugin).
- Session resume — native chat id capture. This MUST fit the existing
  documented "two session identities" model in `spawn.rs`/
  `docs/AGENT-CHAT-ID-CAPTURE.md`: Claude is currently an `identical`-strategy
  plugin (ACP session id == native resume id, implements neither
  `capture_native_chat_id` nor the `unavailable`-strategy method). Determine
  whether the native path preserves that (most likely: yes, since the native
  path IS driving Claude's real resume mechanism directly now, arguably more
  directly than before) — and if the answer changes plugin classification,
  document why explicitly rather than silently reclassifying.

Best-effort / explicitly gapped if phase 00 flagged the control channel as
unresolved:
- Permission prompts — if unavailable, document the fallback behavior (e.g.
  matching how terminal-mode already handles permissions today) as a known,
  tested gap, not a silent regression.
- Mid-turn steering (`supports_mid_turn_steering()` currently returns `true` for
  Claude) — if the native path can't support it, this method must return
  `false` for the native path and the gap must be called out explicitly in the
  close-out report.

## Testing

Follow the same behavior-contract pattern as every other part of this feature —
write tests against `NormalizedEvent` output for a representative set of
captured/replayed protocol exchanges (use phase 00's captured traffic as fixture
data where possible, so tests don't require a live `claude` process to run in
CI). Additionally: a **side-by-side parity check** (can be a manual/scripted
comparison, not necessarily an automated CI test) running the SAME batch of real
prompts (text-only, tool-use, multi-turn, permission-triggering if available)
through both the existing ACP/Node path and the new native path, diffing the
resulting `NormalizedEvent` streams. Document any intentional divergence found;
treat any unintentional divergence as a bug to fix before this phase closes.

## Exit criteria

- New driver passes its own behavior-contract tests.
- Parity check completed and documented (matches/diverges list, with reasoning
  for every divergence).
- Old ACP/Node path (`claude.rs`'s existing `run_turn`) is UNTOUCHED and still
  the active path — this phase does not cut anything over yet, that's phase 02.

## Report back

What's implemented, what's gapped (permissions/steering, if applicable) and
why, the parity-check results, and confirmation the existing path is unmodified
and still default.
