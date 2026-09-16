# Phase brief: 02 — cutover

**Read first:** `../arch-claude-native-acp.md`, `01-native-driver`'s close-out
report **in full**, especially its parity-check results and any disclosed
feature gaps (permissions/steering).

**Skill:** load `rust-coding`.
**Crate(s):** `vst-agents` (the `claude.rs` plugin itself), `vst-daemon` (doctor
checks), `docs/`, `AGENTS.md`.
**Depends on:** `01-native-driver` closed out with a clean parity check (or an
explicitly accepted, documented gap — this phase does not itself decide whether
a gap is acceptable, that call belongs to whoever reviews 01's close-out).

## Goal

Switch the `claude` plugin over to the native driver by default, remove the
Node/ACP/`claude-agent-acp` spawn path for Claude entirely, and verify live.

## Changes

- `vst-agents/src/claude.rs`: `run_turn` now calls the new native driver from
  `01-native-driver` instead of `run_turn_acp`. Remove `claude_acp_command()`,
  `claude_acp_adapter_entry()`, `resolve_claude_acp_adapter_entry_via_node()`,
  and the `node -e "require.resolve(...)"` resolution logic entirely — nothing
  in the Claude plugin should reference `node` or `VST_CLAUDE_ACP_NODE`/
  `VST_CLAUDE_ACP_ADAPTER` after this change.
- `supports_mid_turn_steering()` / permission handling: set to whatever
  `01-native-driver`'s close-out actually delivered — do not leave this
  returning `true` if the native path can't back it.
- `vst-daemon`'s doctor checks (`doctor.rs`, per `AGENTS.md`'s reference to "bun
  on PATH, required for agy ACP adapter") — audit for any Claude-specific
  Node/bun check and remove it. **Do not touch opencode's bun requirement** —
  that's unrelated and stays.
- `docs/AGENT-CHAT-ID-CAPTURE.md` and the plugin-methods table in `AGENTS.md`
  ("Agent plugin — all CLI-specific logic lives in the plugin, nowhere else"
  section) — update if the native path changes anything about Claude's
  two-session-identity classification (see `01-native-driver`'s note on this;
  most likely no change, but verify and update the doc either way so it stays
  accurate).
- Confirm `opencode.rs`/`cursor.rs` are completely unaffected — they never
  depended on Node, this phase should produce zero diff in either file.

## Verification

- Full existing test suite green.
- Live parity pass against a running sandbox (the `:7141`-style Docker sandbox
  this session used throughout, or its successor) — real prompts, real tool
  use, compare against pre-cutover behavior one more time post-integration
  (not just phase 01's isolated parity check, since integration can introduce
  its own bugs).
- **If `11-tauri-cutover` (daemon-rust-port) has landed by this point**, also
  verify against the Tauri desktop app specifically — removing the Node
  dependency for Claude matters most for a shippable, Node-less desktop bundle,
  so this is the one place where "it works in the dev sandbox" isn't sufficient
  evidence on its own.
- Confirm no runtime process spawn of `node` occurs anywhere in a Claude-mode
  agent's lifecycle (a live `ps`/`pgrep` check during a real turn is sufficient
  evidence, not just a code-review claim).

## Exit criteria

- `claude` plugin has zero runtime dependency on Node.
- All tests green, live parity pass documented.
- A close-out doc recording exactly what was/wasn't achieved relative to the
  original ACP/Node path (esp. permission/steering fidelity, carried forward
  from phase 00/01's findings) — this is the feature's final state and should
  be honest about any accepted gaps, not silently gloss over them.

## Report back

What changed, confirmation Node is no longer touched anywhere in the Claude
path, the live verification results (sandbox + Tauri if applicable), and the
final gap list (if any) relative to the pre-cutover ACP/Node behavior.
