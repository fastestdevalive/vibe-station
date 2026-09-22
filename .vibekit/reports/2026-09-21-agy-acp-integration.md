<!--
RULES — read before writing this report:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. ANSWER FIRST: the finding goes at the top, before any evidence
3. EVERY CLAIM CITED: file:line, a command + its output, or a screenshot
4. READING TIME: optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Report: agy ACP — current state + options to adopt `openabdev/openab/agy-acp`

**Date:** 2026-09-21 · **Branch:** `acp-even-itnegration` · **Scope:** `rust/vst-agents` — no code changes · **Method:** local codebase inspection (`rust/vst-agents/src/agy.rs`, `acp_connection.rs`, `acp_run_turn.rs`, `native_chat_id.rs`) + remote inspection of `openabdev/openab/agy-acp` (Cargo.toml, main.rs, adapter.rs, db.rs, README)

## Answer

- **Yes — we DO have an ACP for agy today, and it is NOT the openab one.** Our agy plugin drives ACP through the `agent-client-protocol` crate (a Zed/MIT crate) against an npm adapter **`antigravity-acp@1.1.0`** spawned via `bunx` — see `rust/vst-agents/src/agy.rs:53,468-470`. This is a Node/TS JSON-RPC bridge, not openab's Rust binary.
- **The openab `agy-acp` is a fundamentally different artifact:** a standalone **Rust binary** (`agy-acp/src/main.rs`), its own `[workspace]` (deliberately NOT a member of the openab workspace), MIT-licensed, that spawns `agy --add-dir <wd> [-p prompt]` in `--print` mode and streams text by tailing agy's **SQLite conversation DB** (`~/.gemini/antigravity-cli/conversations/<conv>.db`, `steps` table) — see `agy-acp/Cargo.toml` (`[workspace]`), `agy-acp/src/adapter.rs:59-72` (state paths), `agy-acp/src/main.rs` (`execute_prompt`). It does **not** use agy's `--output-format stream-json` NDJSON that our current adapter consumes.
- **Because openab's adapter is a binary (no `lib` target) driven over stdio JSON-RPC, the clean integration point already exists in our code:** `AcpLaunchSpec { command, args }` (`rust/vst-agents/src/acp_connection.rs:69-83`) + `AcpConnection` already spawn *any* command and speak ACP JSON-RPC over stdio. Swapping agy's ACP is mostly **changing the launch spec** from `bunx antigravity-acp@1.1.0` to a compiled `agy-acp` binary path — the transport, normalize, and run-turn core are reused unchanged.
- **"Can `agent-client-protocol` drive agy directly?" — No (agy itself), but Yes (openab's `agy-acp` binary), and the latter is exactly what we already do.** The Zed crate is a generic ACP **client** (`rust/vst-agents/src/acp_connection.rs`): it spawns a subprocess and speaks ACP JSON-RPC (`initialize`→`session/new`→`session/prompt`→stream) over stdio, assuming the child IS an ACP server. agy the CLI is **not** an ACP server (plain `--print`/`stream-json` CLI, no `initialize`/`session/prompt` — that is why `antigravity-acp` and openab's `agy-acp` both exist as bridges), so `AcpAgent` cannot be pointed at `agy` itself. But openab's `agy-acp` **is** an ACP server on stdio (`agy-acp/src/main.rs`), so the crate drives it unchanged — the only change is the spawn spec. The crate and openab's adapter are complementary (client vs server), not competing — we keep the crate, swap the adapter.
- **Recommendation: submodule (Option 2) is the right call, with a mandatory "walled-garden" guardrail** — see Options table. Two strong reasons it is *safe* here where submodules are usually risky: (a) `agy-acp` is already an isolated crate in its own workspace upstream, so nothing about its layout invites cross-import; (b) our Rust workspace would link it only via a subprocess `AcpLaunchSpec`, never as a Cargo path dependency, so there is no `use openab::*` surface that could leak openab code into our crates.
- **Blocking compatibility gaps to resolve before adopting** (these decide the real effort, not the submodule mechanics):
  1. **Native-chat-id bridge path mismatch.** Our bridge reads `~/.agy-acp/sessions.json` (`native_chat_id.rs:119-121`, `read_agy_acp_session_conversation_id`) — written by the *current npm* adapter. openab's adapter writes **`~/.openab/agy-acp/sessions.json`** and keys differently (`adapter.rs:63,71-84`, `persist_session`). Either adapt our reader to openab's path/format, or fork/reconfigure the path via env.
  2. **`AGY_BIN` support is lost.** Our current adapter is passed the user's agy via `AGY_BIN` (`agy.rs:471,500-502`). openab's `Adapter::agy_bin()` **hardcodes `/usr/local/bin/agy`** (`adapter.rs:77-79`) and uses `augmented_path()` — no `AGY_BIN` env. This breaks our "resolve the user's own agy binary" escape hatch. Needs an upstream patch (add `AGY_BIN` read) or a small local fork.
  3. **Prompt semantics differ.** openab flattens prompt blocks to one text string and always appends `-p <prompt>` (`adapter.rs:prepare_prompt_state`); it drops the separate system-prompt-block handling our `run_turn_acp`'s `build_prompt_blocks` does. Verify system-prompt placement is preserved (our agy prepends system to first-turn message — `agy.rs:482-490`).
  4. **`--print-timeout` default is 20m** (`adapter.rs:13`) — much shorter than our `DEFAULT_PROMPT_TIMEOUT_MS = 60 min` idle window (`acp_connection.rs:91`). A genuinely slow agy turn could be killed by the adapter before our idle timeout. Expose it (AGY_EXTRA_ARGS is the upstream knob — `adapter.rs:18-24`).
  5. **No ACP `fs/*`/`terminal/*`/steering** methods — openab's adapter only implements `initialize`/`session/new`/`session/load`/`session/prompt`/`session/setConfigOption`/`session/cancel` (`main.rs` match arms). Our `AcpConnection` registers handlers for fs/terminal/steering (`acp_connection.rs:438-557,642-645`) but these fail gracefully as method-not-found, so no crash — just fewer capabilities. Confirm our Rich Chat relies on none of them for agy.

## Options (integration approaches)

| # | Approach | What it is | Effort | Guardrail needed | Verdict |
|---|----------|-----------|--------|------------------|---------|
| 1 | **Vendor the source** (copy `agy-acp/` into our tree) | `git subtree` or manual copy of the 6 files into e.g. `rust/vst-agents/agy-acp/` | Low (files are small) | License header must stay; we own all future merges manually; update-in-place drift | Rejected — the user explicitly wants a submodule to pull upstream updates |
| 2 | **Git submodule** pinned to openab `main`, then **build the binary at build time** and spawn via `AcpLaunchSpec` | `git submodule add https://github.com/openabdev/openab rust/openab`; compile `agy-acp` (own workspace) with `cargo build`; spawn `target/release/agy-acp` | Low–Med | **Walled garden** (below) — the whole point of the ask | **Recommended** |
| 3 | **Submodule + Cargo path dependency** (link openab crates as a library) | add `agy-acp` (or its modules) as a `[dependencies] path = ...` member | Med | Requires upstream to expose a `lib` target — it currently has none; would pull ALL openab crate deps into our workspace graph | Rejected — violates "nothing else from openab, ever" |
| 4 | **Publish/vendor a prebuilt `agy-acp` binary** (download release artifact, no submodule) | fetch a released `agy-acp` binary into a known path at daemon setup | Low | No source control of the adapter; supply-chain trust on a binary; no pinning to a source rev | Rejected — submodule gives source-level pinning |
| 5 | **No submodule: keep npm adapter but self-host it** (own the package) | leave `bunx antigravity-acp@1.1.0` / fork into our own registry | — | Not what the user asked (move OFF the current ACP to openab's) | Out of scope |

**Submodule mechanics (Option 2 detail):**
- Repo already has NO `.gitmodules` today (`cat .gitmodules` → `no .gitmodules`) — this would be the first submodule.
- Pin to a specific upstream commit (not floating `main`), e.g. a tagged release once openab publishes one; `agy-acp` is `version = "0.1.0"` (`Cargo.toml`).
- Because `agy-acp` declares its own `[workspace]`, building it does NOT join our `rust/Cargo.toml` workspace (`[workspace] members = [...]` — see `rust/Cargo.toml:3-16`) — no member-list collision. Build it separately: `cargo build --release --manifest-path rust/openab/agy-acp/Cargo.toml`.
- Wire into agy: change `AcpLaunchSpec` command/args (`agy.rs:467-470`) to the built binary's path. Optionally resolve the binary path via the existing daemon config/env rather than hardcoding.

## Walled-garden guardrails (the core of the ask)

Goal: **only `agy-acp` may ever be used; nothing else from `openab` may be imported, even accidentally.**

| # | Guardrail | Enforcement point |
|---|-----------|-------------------|
| G1 | **Never a Cargo path dependency.** Add openab crates ONLY as a spawned subprocess, never as `path = "rust/openab/..."` in any `Cargo.toml`. No crate in our workspace may reference the submodule path. | `rust/*/Cargo.toml` — CI grep for `openab` under any `[dependencies]`/`[workspace.dependencies]` |
| G2 | **No `use`/`mod` from the submodule in our source.** The submodule is a build input (produce a binary), not a source input. | CI `grep -rn "openab" rust/*/src/` must return zero matches |
| G3 | **Build the adapter in isolation.** Build via `--manifest-path` inside `agy-acp/` (its own workspace), never `cargo build` from the repo root with the submodule on the path. Prevents accidental workspace inclusion. | Build script + CI job use `--manifest-path` |
| G4 | **Don't add the submodule to our workspace members list** (`rust/Cargo.toml`). Its own `[workspace]` already isolates it; adding it would be the accidental-import vector. | `rust/Cargo.toml` — keep `members` as-is |
| G5 | **Pin the submodule to a commit**, and gate updates behind a deliberate review (like the frozen `agent-client-protocol = "=2.1.0"` pin at `vst-agents/Cargo.toml:27-29`). | `.gitmodules` commit pin + a documented bump process |
| G6 | **Restrict the submodule directory.** Put it at `rust/openab/` (or `vendor/openab/`) so path-based greps are unambiguous; add a `README`/`.gitignore` note that the dir is submodule-only. | repo layout + docs |
| G7 | **CI contract test.** A CI job asserts the built `agy-acp` binary exists, its `--version`/initialize round-trips, and that `cargo build --workspace` from root does NOT include `openab` (e.g. `cargo metadata` contains no `openab` package). | CI |
| G8 | **No accidental runtime PATH pickup.** The spawned binary path must be explicit (absolute or daemon-config-resolved), never rely on `bunx`/`node_modules`/global npm resolution that could surface other openab packages. | `AcpLaunchSpec.args` is an absolute path |

**Why accidental import is already structurally unlikely (but guardrails still required):**
- openab's `agy-acp` is an isolated crate with its own workspace — no `lib.rs`, only `main.rs`/modules, so it cannot even be linked as a library without upstream changes.
- Our integration surface is subprocess argv only, so there is no Rust `use` statement that could touch openab.
- The realistic accident vector is a future dev adding a `path` dependency or a workspace member — which G1/G3/G4/G6 block at CI/review time.

## Evidence

| Claim | Source |
|-------|--------|
| Our agy ACP today = `antigravity-acp@1.1.0` npm package via `bunx` | `rust/vst-agents/src/agy.rs:53` (`ANTIGRAVITY_ACP_PACKAGE`), `:468-470` (`command: "bunx"`, `args: [package]`) |
| Our ACP transport is generic — spawns any command + speaks JSON-RPC over stdio | `rust/vst-agents/src/acp_connection.rs:384-388` (`AcpAgent::new(spec.command).args(spec.args)`), `:69-83` (`AcpLaunchSpec`) |
| agy CLI is not an ACP server — only a plain `--print`/`stream-json` CLI (why bridges exist) | `rust/vst-agents/src/agy.rs:128` (`parse_agy_stream_line` consumes agy NDJSON, not ACP); openab `agy-acp/src/main.rs` implements the ACP JSON-RPC server that wraps `agy -p` |
| Our ACP run-turn core is CLI-agnostic; plugin supplies launch spec | `rust/vst-agents/src/acp_run_turn.rs:77-188` (`run_turn_acp`, `RunTurnAcpParams`) |
| Native-chat-id bridge reads `~/.agy-acp/sessions.json` (current npm adapter's file) | `rust/vst-agents/src/native_chat_id.rs:119-121,126-134` |
| openab `agy-acp` is a standalone Rust binary, own `[workspace]`, MIT | `agy-acp/Cargo.toml` — `name = "agy-acp"`, `version = "0.1.0"`, `license = "MIT"`, `[workspace]` comment "intentionally not a member of the root openab workspace" |
| openab spawns `agy` in `--print` mode, not stream-json | `agy-acp/src/adapter.rs:prepare_prompt_state` (`args.push("-p")`, `--add-dir`, `--conversation`, `--model`); `agy-acp/src/main.rs:execute_prompt` |
| openab reads agy's SQLite conversation DB for text | `agy-acp/src/db.rs` (`read_response_from_db`, `steps` table, `step_type = 15`); `agy-acp/src/adapter.rs:32` (`conversations_dir = ~/.gemini/antigravity-cli/conversations`) |
| openab state file is `~/.openab/agy-acp/sessions.json`, NOT `~/.agy-acp/sessions.json` | `agy-acp/src/adapter.rs:63` (`state_dir = ~/.openab/agy-acp`), `:71-84` (`state_file`, `persist_session`) |
| openab hardcodes `/usr/local/bin/agy`, no `AGY_BIN` | `agy-acp/src/adapter.rs:77-79` (`agy_bin`), `:81-89` (`augmented_path`) |
| Our current adapter honors `AGY_BIN` | `rust/vst-agents/src/agy.rs:471,500-502` (`resolve_agy_binary`, env `AGY_BIN`) |
| openab default print timeout is 20m | `agy-acp/src/adapter.rs:13` (`DEFAULT_PRINT_TIMEOUT = "20m"`), `:18-24` (`AGY_EXTRA_ARGS`) |
| openab adapter methods: init/new/load/prompt/setConfigOption/cancel only | `agy-acp/src/main.rs` `match req.method` arms |
| Our ACP supports fs/terminal/steering handlers (graceful no-op for agy-acp) | `rust/vst-agents/src/acp_connection.rs:438-557,642-645` |
| Our workspace member list — submodule would be added separately if not guarded | `rust/Cargo.toml:3-16` (`[workspace] members = [...]`) |
| Repo currently has no submodules | `cat .gitmodules` → `no .gitmodules` |
| Frozen-dep precedent for pinning a protocol crate | `rust/vst-agents/Cargo.toml:27-29` (`agent-client-protocol = "=2.1.0"`) |

## Open questions

- **Do we accept the openab `--print`-mode prompt/streaming model, or do we need it to also expose `--output-format stream-json`?** Our current UI gets per-step `text_delta`/tool streaming from the npm adapter's stream-json. openab's DB-tailing approach emits text in chunks too (`poll_streaming_delta`, `streaming.rs`) but tool-call granularity differs. Verify the Rich Chat UX parity before cutover.
- **Where does the built `agy-acp` binary live at runtime** — daemon data dir, `target/`, or resolved from `AGY_ACP_BIN` env? (Recommend env/daemon-config, defaulting to a build output.)
- **Should we patch openab upstream** (add `AGY_BIN`, make state path configurable, expose print timeout) **or maintain a tiny local fork of `agy-acp`** in the submodule until upstream merges? A 1-file patch is cheaper than a fork but forks diverge from a submodule's pull model.
- **Multi-session concurrency:** openab's `execute_prompt` has a documented shared-log race when >1 `agy-acp` session runs concurrently (`main.rs` `detect_swallowed_agy_error` doc). Our daemon runs one ACP connection per session — confirm two simultaneous agy sessions don't misattribute errors (openab's own known limitation).

## Follow-ups

- [ ] Decide submodule path (`rust/openab/` vs `vendor/openab/`) and commit pin.
- [ ] Patch/branch `agy-acp` for `AGY_BIN` + configurable state path + print timeout (or fork).
- [ ] Update `native_chat_id.rs` bridge to read openab's state file/path (or point openab at the legacy `~/.agy-acp/sessions.json` path for continuity).
- [ ] Add the G1–G8 CI guardrails + contract test.
- [ ] Verify Rich Chat streaming/UX parity (openab DB-tailing vs current stream-json).
- [ ] Remove `ANTIGRAVITY_ACP_PACKAGE`/`bunx` usage from `agy.rs` after cutover; remove the `~/.agy-acp` legacy path only after confirming no persisted sessions depend on it.
