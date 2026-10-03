# Agent plugins

> Split out of the old `HIGH-LEVEL-DESIGN.md` §4 "Plugin Architecture" as
> part of the docs consolidation (see `docs/ARCHITECTURE.md`) — plugins are
> a distinct, evergreen concept worth their own page, and the old section
> described a TypeScript interface that no longer exists (the daemon is
> Rust-only as of `7bfa386c`). This page reflects the current
> `rust/vst-agents` implementation.

## The invariant

Every behaviour that differs between `claude`, `cursor`, `opencode`, and
`agy` is a method on the `AgentPlugin` trait (`rust/vst-agents/src/plugin.rs`)
— never an `if/else` or `match` on a CLI id anywhere else in the codebase.
Calling code resolves a plugin once via
[`resolve_plugin`](../rust/vst-agents/src/registry.rs) and then calls trait
methods; it never inspects the CLI name again after that point.

```rust
// ✅ correct — resolve once, call the trait
let plugin = resolve_plugin(cli);
let launch = plugin.get_launch_command(&cfg);

// ❌ wrong — CLI-specific knowledge leaking into calling code
match cli {
    CliId::Claude => { ... }
    CliId::Opencode => { ... }
    ...
}
```

## Where the plugins live

One file per CLI in `rust/vst-agents/src/`:

| File | CLI |
|---|---|
| `claude.rs` | Claude Code |
| `cursor.rs` | Cursor |
| `opencode.rs` | OpenCode |
| `agy.rs` | agy |

`registry.rs` holds `SUPPORTED_CLIS` and `resolve_plugin(cli) -> Box<dyn AgentPlugin>`
— the single place that maps a `CliId` to a concrete plugin.

## The trait

Required on every plugin:

- `get_launch_command` — build the spawn command line.
- `get_environment` — extra env vars for the spawned process.
- `get_ready_signal` — either a sentinel string to watch for in pane output,
  or a fallback delay (`ReadySignal { sentinel, fallback_ms }`), so the
  daemon knows when a freshly-spawned agent is ready to receive input.
- `compose_launch_prompt` — how the system/task prompt is delivered:
  `PromptDelivery::Inline` (via CLI flags/launch config) or
  `PromptDelivery::PostLaunch` (sent to stdin after launch).

Optional, with a documented default when a plugin doesn't implement it:
restore/resume support, workspace hook setup, session info (cost, last
message time), native chat-id capture, and ACP (ACP) support for Rich Chat —
`supports_acp()` marks whether a plugin drives a persistent ACP connection
for structured, per-turn output instead of a one-shot terminal spawn per
turn.

## Adding a new CLI

1. Add the CLI to `CliId` (`rust/vst-types`).
2. Add `<cli>.rs` to `rust/vst-agents/src/` implementing `AgentPlugin`.
3. Register it in `registry.rs` (`SUPPORTED_CLIS` + `resolve_plugin`).
4. Never add a new `match cli { ... }` branch outside the plugin file and the
   registry — that's the invariant this whole design exists to protect.

## Prompt composition

Every agent spawn gets a layered prompt, composed once and handed to the
plugin via `compose_launch_prompt`:

| Layer | Content |
|---|---|
| **L1 — base** | vst's own system prompt: available `vst` CLI surface, pre-set `VST_*` env vars, git workflow rules. |
| **L2 — context** | Project name/path/default branch; current worktree branch + base branch/SHA; sibling sessions in the same worktree; mode-specific context. |
| **L3 — rules** | Project rules from `<project>/AGENTS.md` or `<project>/.vibe-station/rules.md`, read at spawn time. |

## Onboarding checklist

Adding a new CLI terminal should not mean rediscovering the launch/resume bugs
documented in `docs/CLI-LAUNCH-PITFALLS.md`. When you implement `<cli>.rs`,
answer each of these against a real first launch on a clean host — not only
your own machine:

- **Where does the CLI install?** (nvm/npm global, cargo, brew, `~/.local/bin`, …)
  Does that dir survive the daemon's PATH? The daemon captures the user's
  interactive-shell PATH once at startup (`context::effective_path`, cached)
  and launches agents with `sh -c "exec <line>"` — no login shell, so a
  binary installed anywhere the user's shell sees should resolve. But verify:
  on a host where the daemon started outside a configured shell, `PATH` is the
  daemon's own — a CLI only on the user's `.bashrc` PATH won't be found.
- **Does it need a ready signal or a timeout fallback?** `get_ready_signal`
  returns a sentinel string to watch for in pane output, or a fallback delay.
  If the CLI prints nothing recognizable on launch, rely on `fallback_ms`.
- **When does it first persist a conversation?** Note the on-disk store
  (e.g. pi writes a session file header at startup, before any message).
  Existence of a file/id is **not** proof a conversation started.
- **What does resume do on an empty conversation?** `get_restore_command`
  MUST return `None` when the session has no stored id and no conversation of
  its own; SHOULD verify ≥ 1 user turn before resuming (see the contract on
  the trait). If a `--resume` on an unstarted conversation would skip the
  initial prompt, gate it the way pi/codex do.
- **Verify on a clean host:** `command -v <cli>` from a fresh non-login shell,
  then create + resume an agent end-to-end. Confirm the binary resolves, the
  first launch doesn't exit 127, and Resume re-sends the initial prompt when
  the conversation never started.

## Tracker plugins

Issue-tracker integration (GitHub/Linear/GitLab) is not implemented yet. The
plugin pattern reserves the slot for it, the same way it reserves one per AI
CLI — it isn't wired into the current `AgentPlugin` trait.
