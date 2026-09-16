# claude-native-acp — architecture note (quick plan, not a full arch doc)

## Why this exists

The user's original question: "we wrote the Claude ACP integration entirely in
Rust, right, and it calls into the Claude Agent SDK?" — answer investigated and
found to be **no**. Confirmed by reading the actual installed packages:

- `vst-agents/src/claude.rs` spawns `node <resolved-path>/claude-agent-acp/dist/index.js`
  as a child process and drives it via the `agent-client-protocol` Rust crate as
  an ACP **client**. This is a faithful 1:1 port of what `daemon/src/agent-plugins/claude.ts`
  already did — the Rust port never tried to reimplement Claude's own agent logic,
  by design.
- `@agentclientprotocol/claude-agent-acp` (the Node package) is genuinely small
  (~9.7k lines of *compiled* JS across its dist, so meaningfully less in source) —
  it's an ACP-protocol-to-SDK-calls bridge, nothing more.
- It depends on `@anthropic-ai/claude-agent-sdk`, whose real job is: extract a
  **309 MB precompiled, closed-source `claude` binary** (bundled per-platform,
  e.g. `@anthropic-ai/claude-agent-sdk-linux-x64`) from Bun's virtual filesystem
  to a real temp dir, spawn it, and speak an **undocumented** JSON protocol to it
  over stdin/stdout — `--input-format`/`--output-format stream-json` plus an
  apparent bidirectional `control_request`/`control_response` channel (used for
  things like permission prompts and mid-turn steering). Confirmed: running that
  bundled binary with `--version` reports `"Claude Code"` — it IS the same `claude`
  CLI already on everyone's PATH, not a different engine.

**Consequence for the user's original idea** ("fork `claude-agent-acp`, add a
rust-impl folder"): forking `claude-agent-acp` alone does **not** eliminate Node,
because the actual protocol-to-the-binary work lives one layer deeper, in
`@anthropic-ai/claude-agent-sdk`'s `bridge.mjs`/`sdk.mjs` (a ~1.3 MB minified
bundle, not clean readable source). To genuinely drop Node for Claude support,
Rust needs to talk to the `claude` binary **directly**, which means
reverse-engineering that inner, undocumented protocol — a materially different
(and riskier) kind of work than the rest of this daemon-rust-port effort, which
had a clean, readable TypeScript source of truth to port line-for-line. This has
no source of truth; it's protocol archaeology against a vendor's private wire
format with no compatibility guarantee across `claude` CLI versions.

## What DOES help: `agent-client-protocol` (the official Rust ACP SDK)

Investigated `github.com/agentclientprotocol/rust-sdk` directly (via a research
subagent, not assumed): it's the **same** project as the `agent-client-protocol`
crate we already depend on (v2.1.0, already in `Cargo.lock`) — not a separate or
newer thing. It has a real `Agent` **builder** API for the server/agent side
(`Agent.builder().on_receive_request(...).connect_to(Stdio::new())`) and working
examples (`examples/simple_agent.rs`). This means phase 01 below does **not**
need to hand-roll ACP's own JSON-RPC framing, request/response correlation, or
protocol-version negotiation — that part is a real, official, already-available
building block. It provides **zero** help with the actual hard part: its own
`AcpAgent::claude_agent()` convenience constructor just shells out to
`npx @agentclientprotocol/claude-agent-acp` — the exact thing we're replacing.
No mention anywhere in that repo of `stream-json` or the control-channel
protocol.

## Real risks to weigh before investing implementer time

1. **No compatibility guarantee.** The `claude` binary's stdin/stdout protocol
   is not a published spec (unlike ACP itself). Anthropic could change it in any
   `claude` CLI release with no notice, silently breaking this integration where
   it would never break the official Node path (which always ships against a
   pinned, tested combination via `claude-agent-sdk`).
2. **No source of truth to port from.** Every other part of this daemon-rust-port
   feature had a working TypeScript implementation to read and port line-for-line,
   with a test suite to match against. This has neither — phase 00 exists
   specifically to manufacture a "ground truth" by capturing real traffic.
3. **Terms-of-service consideration** — reverse-engineering and reimplementing a
   vendor's private control protocol for their own CLI product is worth a sanity
   check against Anthropic's terms before shipping this broadly, independent of
   the technical work. Flagging this explicitly rather than assuming it away;
   this is a business/legal call, not a technical one, and outside what I can
   authoritatively assess.
4. Given (1)-(3), consider phase 00 specifically as a **spike with a real
   go/no-go decision point** at the end, not a foregone conclusion that phases
   01-02 will happen.

## Scope: 3 phases

- **00-protocol-spike** — capture ground truth, prove a minimal turn round-trip
  works talking to `claude` directly, no integration yet. Go/no-go gate.
- **01-native-driver** — real `vst-agents` driver built on the official
  `agent-client-protocol` `Agent` builder for the outer ACP-facing shape, with
  the phase-00-derived protocol underneath talking to `claude` directly.
- **02-cutover** — swap the `claude` plugin's `run_turn` over to it, remove the
  Node/`claude-agent-acp` spawn path, update docs, verify live (ideally against
  the part-11 Tauri build too, since removing Node matters most for a shippable
  desktop app).

## Implementer note (per user direction)

Same DeepSeek/agy-medium pattern as the rest of the port, **with one caveat**:
phase 00 is fundamentally reverse-engineering/protocol-archaeology, not
line-for-line porting of readable source — a different skill shape than what
these implementers have done well throughout this feature so far. Worth
considering a stronger model (sonnet/opus) for phase 00 specifically, or at
minimum planning for tighter orchestrator review of its findings before
greenlighting phase 01, since a wrong protocol assumption there would silently
propagate into everything downstream.
