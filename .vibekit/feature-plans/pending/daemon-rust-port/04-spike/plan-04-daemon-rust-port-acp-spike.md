# Phase brief: 04-spike — ACP transport spike

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `04-spike`, Entities & Modules row for `vst-agents`, System Boundaries row `vst-agents ↔ external agent CLIs`, Gotcha #5.
**Owner:** the orchestrating agent itself — **never dispatched to DeepSeek**, per the arch doc's explicit instruction (this is the one part not following the usual phase recipe).
**Crate(s):** rust/vst-agents
**Depends on (already `done`):** 00-foundation, 02-process-pty

## Deliverables (per the arch doc's Part Breakdown row, verbatim)
1. Pin an exact `agent-client-protocol` crate version.
2. A compiling `examples/acp_hello.rs` doing `initialize → session/new → prompt → stream` against `claude-agent-acp`'s ACP surface.
3. Freeze the `AcpTransport` trait signature that `04b` will implement against.

## What was done

- **Pinned `agent-client-protocol = "=2.1.0"`** (exact pin, `vst-agents/Cargo.toml`) — current stable-v1 release on crates.io at the time of this spike. Bumping this later is a deliberate, reviewed amendment, not a routine `cargo update`.
- **`rust/vst-agents/examples/acp_hello.rs`** — compiles and **actually runs** a full live round trip against the real adapter: `AcpAgent::from_args(["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.70.0"])` (pinned to the exact adapter version `daemon/package.json` already depends on, not `AcpAgent::claude_agent()`'s floating `@latest`) → `InitializeRequest` → `NewSessionRequest` → `PromptRequest` with a one-word prompt, streaming every `session/update` notification via `on_receive_notification`, ending in `stop_reason=EndTurn` with the streamed `AgentMessageChunk` containing the expected reply. Run twice, reproducibly green both times (see `rust/.gate/04-spike.log`'s companion terminal output, not captured in the log itself since it's a live network-touching run, not part of `cargo test`).
- **`rust/vst-agents/src/acp_transport.rs`** — the frozen `AcpTransport` trait. Mirrors the existing TS `AcpConnection` class's contract (`daemon/src/services/acp/acpTransport.ts`) — one persistent connection per session, `initialize` once, one ACP session per connection, `session/prompt` served per turn over that same connection, the prompt response's own resolution (not child-process exit) is the turn-done signal — with two deliberate simplifications documented inline: no `AbortSignal` parameter (callers call `cancel_active_prompt()` directly instead), and the trait streams the raw ACP `SessionUpdate` schema type rather than `vst_types::NormalizedEvent` (normalization is `04b`'s `normalize.rs`'s job, keeping this trait free of any `vst-types` coupling). Uses `&self` throughout per the part-00 handle convention (Gotcha #14), matching `StoreHandle`/`PtyHandle`.

## Verification

- `cargo build -p vst-agents --all-targets` — clean.
- `rust/scripts/rust-gate.sh vst-agents` — green; log at `rust/.gate/04-spike.log`. Zero warnings scoped to `vst-agents/src` or `vst-agents/examples` (the log's other warnings are pre-existing pedantic noise in `vst-store`/`vst-types`, out of this part's scope).
- The example was actually executed against the live `claude-agent-acp` adapter (not just type-checked) — see the transcript excerpt below.

```
spawning: npx -y @agentclientprotocol/claude-agent-acp@0.70.0
-> initialize
<- initialized: agent_info=Some(Implementation { name: "@agentclientprotocol/claude-agent-acp", ... version: "0.70.0", ... })
-> session/new
<- session created: SessionId("7612584a-...")
-> session/prompt: "Reply with exactly one word: hello"
session/update: AgentMessageChunk(ContentChunk { content: Text(TextContent { text: "hello", ... }), ... })
<- prompt complete: stop_reason=EndTurn
acp_hello: initialize -> session/new -> session/prompt -> stream: all OK
```

## vst-types amendments

**None.** `AcpTransport` deliberately does not depend on `vst-types` (see the trait's doc comment) — it streams the ACP crate's own `SessionUpdate` type; normalization to `vst_types::NormalizedEvent` is `04b`'s job.

## N6

`rust/Cargo.toml`'s `[workspace]` table and `.github/workflows/rust-ci.yml` are untouched — only `rust/vst-agents/Cargo.toml` (crate-local deps) and `rust/Cargo.lock` (dependency resolution) changed.

## For `04a`/`04b`/`04c`

- `04b`'s plan should cite `rust/vst-agents/src/acp_transport.rs` directly and implement `AcpTransport` for a concrete `AcpConnection`-equivalent struct — **do not redesign the trait signature**, per this part's "frozen" mandate.
- `examples/acp_hello.rs` is a standing regression check that the pinned crate version + pinned adapter version still round-trip — worth re-running (`cargo run -p vst-agents --example acp_hello`) if `04b` ever needs to bump the `agent-client-protocol` pin.
