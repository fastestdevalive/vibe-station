<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: adopt `openab/agy-acp` (Rust) as agy's ACP adapter; drop the bun/npm path

> Replace agy's current ACP (npm `antigravity-acp@1.1.0` via `bunx`) with the openab Rust
> `agy-acp` binary, vendored as a git submodule under `rust/vendor/openab`, with a
> "walled-garden" guardrail so nothing else from openab can ever be imported. Drop `bun`
> from the daemon runtime entirely. See report `.vibekit/reports/2026-09-21-agy-acp-integration.md`.

**Branch:** `acp-even-itnegration` · **Status:** Implemented (code/build/CI/docs); live-E2E verified in dev sandbox (sonnet run below) except 6.10, which FAILED and is a real bug · **Source report:** `.vibekit/reports/2026-09-21-agy-acp-integration.md`
**Reviewed:** vst subagent (claude opus) — findings incorporated below (marked `[REVIEW]`).

> **Live-E2E verification (6.1–6.3, 6.6–6.9, 6.11, 12.1–12.2) is now done** — see "Verification run (sonnet, dev sandbox)" at the bottom for evidence. **6.10 (multi-session concurrency) FAILED**: two simultaneous agy Rich Chat sessions cross-contaminate — session A's turn silently received session B's response text with no error surfaced. This is a real bug, not yet fixed — see the section below before shipping concurrent agy sessions.

**Decisions (from follow-ups):**
- **D1 — submodule path:** `rust/vendor/openab`, pinned to an upstream commit (not floating `main`).
- **D2 — upstream patch needed:** YES. Patch `agy-acp` for `AGY_BIN` + configurable state path + `--print-timeout`.
- **D3 — guardrails:** G1–G8 (never a Cargo path dep, never a workspace member, isolated build via `--manifest-path`, import-pattern greps, absolute spawn path). Confirmed.
- **D4 — [REVIEW] fork, not in-submodule commits:** a submodule cannot hold local commits; fork `openabdev/openab` on GitHub and point `.gitmodules` `url` at the fork if the patch isn't merged. Phase 1 assumes the fork so it is not blocked on upstream.
- **D5 — [REVIEW] state path we own:** use `~/.vibe-station/agy-acp/` (NOT the legacy `~/.agy-acp` or openab's `~/.openab/agy-acp`); one Rust resolver feeds both the adapter's state-dir env and `agy_acp_sessions_path()` so they can't drift.

**Scope:** drop the bun/npm adapter + `bun` runtime requirement entirely. claude/node is **out of scope** (separate work).

---

## Concept

- Keep the Zed `agent-client-protocol` crate as the single ACP **client** (`AcpConnection`).
- Swap agy's ACP **server** from `bunx antigravity-acp@1.1.0` → the compiled openab `agy-acp` binary.
- The openab binary IS an ACP server on stdio (`agy-acp/src/main.rs`); `AcpLaunchSpec` (`agy.rs:467-470`) is the only transport change. `AcpConnection`, `normalize`, `run_turn_acp` reused unchanged.
- Walled-garden: openab is a build input (produce a binary), never a source dependency.
- **Build model:** agy-acp is ALWAYS compiled from the submodule source as part of the vibe-station build — never a downloaded/prebuilt "dropped-in" binary. But it is compiled in ISOLATION (its own `[workspace]`, own `--manifest-path`, `--target-dir rust/target/agy-acp`) into a standalone binary the daemon spawns as a subprocess over stdio ACP. It is never a member of `rust/Cargo.toml` and never linked into the daemon's crate graph — that separation IS the walled-garden mechanism. Mirrors the existing `prep-sidecar.sh` sidecar pattern.

```
vst-agents ──agent-client-protocol──► AcpConnection ──spawn──► agy-acp (openab, stdio ACP, compiled standalone)
                                                                    │
                                                                    └──spawns──► agy -p
```

## Out of Scope

- claude's node-based adapter (`claude.rs`) — separate work.
- Changing the `agent-client-protocol` crate/pin.
- opencode/cursor ACP paths — untouched.

---

## Phase 1 — Adopt openab `agy-acp` via submodule + wire it in

Goal: agy Rich Chat works through openab's `agy-acp` (cutover to the openab binary; bun checks replaced here).

### 1. Submodule + guardrails
- [x] 1.1 `git submodule add https://github.com/openabdev/openab rust/vendor/openab` (creates `.gitmodules` — repo's first)
- [x] 1.2 Pin `rust/vendor/openab` to a specific upstream commit (record the rev in `.gitmodules` + this plan); `shallow = true` to bound clone size `[REVIEW]`
- [x] 1.3 `[REVIEW]` Put the "submodule-only, only `agy-acp/` may be used" note at `rust/vendor/README.md` (a file at `rust/vendor/openab/README.md` would belong to the submodule's own repo, not ours)
- [x] 1.4 Do NOT add `rust/vendor/openab` to `rust/Cargo.toml` `[workspace] members`; instead add `exclude = ["vendor"]` to `[workspace]` so Cargo itself enforces G4 `[REVIEW]`

### 2. Upstream patch (D2) — on the fork (D4)
- [x] 2.1 Patch `agy-acp` `adapter.rs:agy_bin()` to honor `AGY_BIN` env (fallback to current resolution)
- [x] 2.2 Patch state dir to read `AGY_ACP_STATE_DIR` env, defaulting to `~/.vibe-station/agy-acp/` (D5) — `adapter.rs:63,71-84`
- [x] 2.3 Raise `--print-timeout` default to ≥ our 60m idle window (`adapter.rs:13`); keep `AGY_EXTRA_ARGS` override
- [x] 2.4 `[REVIEW]` Fork `openabdev/openab` → point `.gitmodules` `url` at the fork; open PR; keep the fork as the committed submodule target (Phase 1 works regardless of upstream merge)

### 3. Build wiring
- [x] 3.1 Build step compiles `agy-acp` from submodule source in isolation: `cargo build --release --manifest-path rust/vendor/openab/agy-acp/Cargo.toml --target-dir rust/target/agy-acp` (target-dir keeps the submodule working tree clean) `[REVIEW]`
- [x] 3.2 Mirror `prep-sidecar.sh` sidecar pattern (`scripts/prep-sidecar.sh:79,93`): build → copy to `desktop/src-tauri/binaries/agy-acp-<triple>` + add `externalBin` entry in `desktop/src-tauri/tauri.conf.json`; note the universal-macOS lipo caveat applies `[REVIEW]`
- [x] 3.3 `[REVIEW]` Runtime binary resolution order: `AGY_ACP_BIN` env → file next to `current_exe()` (Tauri sidecar location) → clear error. Put the resolver in a shared place both `vst-daemon` doctor and `vst-cli` doctor use, so they can't disagree.
- [x] 3.4 `agy.rs` `AcpLaunchSpec`: `command: <AGY_ACP_BIN>`, `args: []` — replace `bunx antigravity-acp@1.1.0` (`agy.rs:467-470`)
- [x] 3.5 Keep `agy-acp` OUT of `rust/Cargo.toml` `[workspace] members` (enforced by `exclude = ["vendor"]`, 1.4)

### 4. Native-chat-id bridge
- [x] 4.1 `native_chat_id.rs:119-134` (`read_agy_acp_session_conversation_id`) → read openab's store at `~/.vibe-station/agy-acp/sessions.json`, via the D5 shared resolver
- [x] 4.2 Confirm openab's persisted shape (`adapter.rs:persist_session`: `sessions[session_id].{conversationId,last_step_idx,model_id}`) maps to the bridge's expectations

### 5. Doctor checks (cutover — bun replaced here)
- [x] 5.1 `vst-daemon/src/doctor.rs:224-235`: replace `bun` check with an `agy-acp` binary present check (via the 3.3 resolver); update module doc line 8
- [x] 5.2 `vst-cli/src/commands/doctor.rs:257-265`: same — replace `bun` check

### 6. Verify (Phase 1) — gates before Phase 2
- [x] 6.1 Build `agy-acp` + wire launch spec; agy Rich Chat round-trips (spawn → prompt → stream → result)
- [x] 6.2 Session resume across turns (conversation_id persists + reloads)
- [x] 6.3 Native chat-id restore path works (`get_restore_command` / `capture_native_chat_id`)
- [x] 6.4 `cargo test -p vst-agents` green (agy tests: `agy.rs`, `native_chat_id.rs`, `run_turn_bridge.rs`); rewrite the `~/.agy-acp` test fixture for openab's format/path `[REVIEW]`
- [x] 6.5 `cargo build --workspace` does NOT include openab (G7 check) `[REVIEW]` — assert no package named `agy-acp` and no `manifest_path` under `rust/vendor/`
- [x] 6.6 System prompt placement still works (openab flattens blocks into `-p`) — `agy.rs:482-490` `[REVIEW]` (report gap #3)
- [x] 6.7 Model selection still works via `session/setConfigOption` `[REVIEW]` (report gap #4)
- [x] 6.8 fs/terminal/steering not required by agy Rich Chat `[REVIEW]` (report gap #5)
- [x] 6.9 `session/load` for npm-era sessions falls back to `session/new` cleanly `[REVIEW]`
- [ ] 6.10 **FAILED (real bug, unfixed)** — streaming UX parity is fine, but two simultaneous agy sessions DO cross-contaminate: session A received session B's response text with no error. `[REVIEW]` — see verification section below.
- [x] 6.11 Turn > 20m not killed (print-timeout applied) `[REVIEW]` — verified via spawned argv, not a real 20m wait (see below)

---

## Phase 2 — Get rid of everything else (bun + npm adapter, completely)

Goal: remove the bun/npm adapter and ALL its residue — `bunx` invocation, `ANTIGRAVITY_ACP_PACKAGE`, the legacy `~/.agy-acp` state path, `bun` runtime requirement, docker installs, and every doc reference.

### 7. Remove npm adapter completely (build setup + references)
- [x] 7.1 Delete `ANTIGRAVITY_ACP_PACKAGE` const + `bunx` usage from `agy.rs:52-53,467-470`
- [x] 7.2 `[REVIEW]` KEEP `resolve_agy_binary` — pass its result to the patched adapter via `AGY_BIN` env (`agy.rs:471` already does); do NOT remove it
- [x] 7.3 No `antigravity-acp` npm dep exists in `package.json`/`pnpm-lock.yaml` (verified — `bunx` fetches at runtime); confirm none added
- [x] 7.4 Remove bun install from `dev.Dockerfile:86-91` (the `RUN curl ... bun.sh` + comment) `[REVIEW]`
- [x] 7.5 `[REVIEW]` `docker-compose.dev.yml`: remove bun references; add a mount + `AGY_ACP_BIN` for the built adapter so the dev sandbox has it (see 8.x)
- [x] 7.6 Update docs that describe the npm adapter:
  - `docs/JSON-CHAT-ARCHITECTURE.md:107,115-117` — rewrite the whole anti-bun/anti-npm paragraph for openab `agy-acp`
  - `docs/CLI-SUPPORT.md:38` — rewrite steering/capabilities from what openab's `initialize` actually advertises (not just rename)
  - `docs/AGENT-CHAT-ID-CAPTURE.md:46` — agy bridge row reads openab's state store
- [x] 7.7 Grep whole `rust/` for `bun`/`bunx`/`antigravity-acp` — remove remaining runtime refs; fix `home.rs:5` + `native_chat_id.rs:118,123-124` doc comments `[REVIEW]`

### 8. Docker/dev-sandbox integration
- [x] 8.1 `[REVIEW]` Remove bun from `dev.Dockerfile` (86-91)
- [x] 8.2 `[REVIEW]` `docker-compose.dev.yml`: add `AGY_ACP_BIN` + a read-only mount of the built `agy-acp` binary (mirror the `vst-daemon`/`vst-cli` mounts at `docker-compose.dev.yml:146`)
- [x] 8.3 Grep whole `rust/` + `docs/` for `bun`/`bunx`/`antigravity-acp` — remove remaining refs not covered in 7.x

### 9. Legacy state cleanup
- [x] 9.1 `[REVIEW]` `capture_native_chat_id` returns early when `agent_chat_id` is saved, else falls back to cwd lookup — so the legacy `~/.agy-acp` reader can be dropped in Phase 2 without auditing old sessions. Drop `agy_acp_sessions_path`/old bridge if unused after 4.x.

### 10. CI guardrails (G1–G8) — enforce "nothing else from openab"
- [x] 10.1 CI: grep `rust/*/Cargo.toml` for `openab` under `[dependencies]`/`[workspace.dependencies]` → fail if found (G1)
- [x] 10.2 `[REVIEW]` CI: grep for import patterns `use openab` / `extern crate openab` / `#[path` / `include!` (NOT plain word "openab", which legitimately appears in our `native_chat_id.rs`/`agy.rs`) → fail if found (G2)
- [x] 10.3 `[REVIEW]` CI: assert `cargo metadata --manifest-path rust/Cargo.toml` has no package named `agy-acp` and no `manifest_path` under `rust/vendor/` (G3/G4/G7)
- [x] 10.4 CI: build agy-acp (`--manifest-path` + `--target-dir`) and contract-test its ACP `initialize` round-trips (G7)
- [x] 10.5 `[REVIEW]` Drop 10.5 (old "gitignore tracking" step was nonsense — submodules are commit pointers, not gitignore'd). Instead: CI must `actions/checkout@v4` with `submodules: true` in both `rust-ci.yml` and `desktop-build.yml`
- [x] 10.6 `[REVIEW]` Add agy-acp build + contract test to CI (today CI only runs `rust-gate.sh --workspace`, which never builds agy-acp)
- [x] 10.7 `[REVIEW]` License check: `cargo deny check licenses --manifest-path rust/vendor/openab/agy-acp/Cargo.toml` (our `cargo deny` only covers `rust/Cargo.toml`); ship openab's MIT license with the bundle
- [x] 10.8 `[REVIEW]` Submodule bump process: documented "how to bump" note (like the `agent-client-protocol = "=2.1.0"` pin review) — G5

### 11. Docs
- [x] 11.1 `[REVIEW]` `AGENTS.md` — grep finds no `antigravity`/`bun` there; reword step to "verify only" (no change expected)
- [x] 11.2 Update README install docs (`README.md:69,503` bun install/doctor text) for the new `AGY_ACP_BIN` requirement (drop bun install instructions) `[REVIEW]`

### 12. Verify (Phase 2)
- [x] 12.1 Full agy Rich Chat E2E with no bun on PATH (bun removed) — proves runtime independence
- [x] 12.2 `vst doctor` clean without bun (reports `agy-acp` binary present instead)
- [x] 12.3 `cargo test --workspace` green
- [x] 12.4 `cargo clippy --workspace` + lint clean — agy-touched crates (`vst-agents`, `vst-agy-acp`) are clean at deny-level; 3 pre-existing deny-level errors remain in unrelated `vst-routes` files (`settings.rs`, `worktrees.rs`, last touched 2026-09-17, before this feature's commits) — see verification section

---

## Reference files

| Item | Path |
|------|------|
| Current adapter launch | `rust/vst-agents/src/agy.rs:467-470` (`AcpLaunchSpec`), `:52-53` (`ANTIGRAVITY_ACP_PACKAGE`), `:500-502` (`resolve_agy_binary`), `:471` (`AGY_BIN` env) |
| Transport (unchanged) | `rust/vst-agents/src/acp_connection.rs` (`AcpLaunchSpec:69-83`, `AcpConnection`), `acp_run_turn.rs`, `acp_transport.rs` |
| Native-chat-id bridge | `rust/vst-agents/src/native_chat_id.rs:118-134` |
| Doctor bun checks | `rust/vst-daemon/src/doctor.rs:8,224-235`, `rust/vst-cli/src/commands/doctor.rs:257-265` |
| Workspace members/exclude | `rust/Cargo.toml:3-16` |
| Frozen protocol dep (keep) | `rust/vst-agents/Cargo.toml:27-29` (`agent-client-protocol = "=2.1.0"`) |
| Upstream adapter source | `rust/vendor/openab/agy-acp/` — `main.rs`, `adapter.rs`, `db.rs` (pinned rev) |
| Docker/dev bun install | `dev.Dockerfile:86-91`, `docker-compose.dev.yml:146` |
| CI workflows | `.github/workflows/rust-ci.yml`, `.github/workflows/desktop-build.yml` (need `submodules: true`) |
| Tauri sidecar bundle | `scripts/prep-sidecar.sh`, `desktop/src-tauri/tauri.conf.json` |
| Source report | `.vibekit/reports/2026-09-21-agy-acp-integration.md` (options, gaps, guardrail table) |

## Notes / risks

- **Fork divergence (D4):** the submodule points at a fork; upstream merges require re-pointing `.gitmodules` + a bump review (10.8). Mitigate by keeping the patch minimal (adapter.rs only) and re-basing on update.
- **`-p` print model vs stream-json:** openab tails agy's SQLite DB, not our stream-json NDJSON — confirm Rich Chat streaming/UX parity in 6.10 before finishing Phase 2.
- **Multi-session concurrency:** openab's shared-log error detection has a documented cross-session race — verify in 6.10.
- **`--print-timeout` 20m default** is below our 60m idle window — raised in 2.3, verified in 6.11.
- **Build isolation:** must use `--target-dir rust/target/agy-acp` so the submodule working tree stays clean (3.1) — otherwise builds write into the submodule.
- **[NEW, confirmed 2026-09-22] Multi-session cross-contamination is a real data-integrity bug, not just an "error misattribution" risk.** Two concurrent agy Rich Chat sessions can receive each other's assistant text with **no error surfaced at all** — see verification run below. Must be fixed (or concurrent agy sessions blocked/serialized) before this ships to real users running >1 agy session at once.

---

## Verification run (sonnet, dev sandbox)

**Date:** 2026-09-22 · **Method:** live dev sandbox (`scripts/dev-sandbox.sh`, worktree `vs-165`, port 7165), real `agy` 1.2.7 (authenticated, host `~/.local/bin/agy`, mounted read-only per `docker-compose.dev.yml` default), real openab `agy-acp` binary built from the vendored submodule. No mocks.

### Build (isolation)
- `cargo build --release --manifest-path rust/vendor/openab/agy-acp/Cargo.toml --target-dir rust/target/agy-acp` — succeeds in ~2.4s (warm cache), produces `rust/target/agy-acp/release/agy-acp`, an ELF PIE binary. 3 harmless dead-code warnings, no errors.
- Confirms Phase 1 §3.1 and the `rust/vendor/README.md` build command are correct as documented.
- **Gotcha (not a plan bug, an environment one):** the host's system Rust (1.98) links against a newer glibc (`GLIBC_2.39`) than the dev-sandbox's `node:24-slim` base image (Debian bookworm, glibc 2.36) ships. A host-built `agy-acp` (or `vst-daemon`/`vst-cli`) fails with `GLIBC_2.39' not found` inside the container. Fix: build all three binaries (`vst-daemon`, `vst`, `agy-acp`) inside a `rust:1-bookworm` container (matches the sandbox's glibc) with `--target-dir` pointed at `rust/target-docker` / a docker-only target dir, then pass `VST_AGY_ACP_BIN`/rely on `dev-sandbox.sh`'s `target-docker` auto-detection. This is purely a local-dev-sandbox build concern (CI likely already builds in a container) — no code change needed, just documenting so the next verifier doesn't lose time on it.
- Raw ACP `initialize` over stdio confirmed working directly (no daemon) both on a host-glibc build and the container-glibc build: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | agy-acp` → `{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{"loadSession":true,"streaming":true},"agentInfo":{"name":"agy","version":"0.1.0"},"protocolVersion":1}}`.

### 6.1 — Rich Chat round-trip
- Created an `agy`-cli mode via `POST /api/modes`, then `POST /api/worktrees` with `channel:"json"` and a prompt on project `forge-cli`.
- Session went `working` → `waiting_for_human`; `GET /sessions/:id/transcript` shows `user` → `text` (assistant, exact requested string) → `result`. Confirmed end-to-end: spawn → prompt → stream → result.

### 6.2 / 6.3 — Resume + native chat-id capture
- `POST /sessions/:id/chat` with a follow-up ("what did I just ask you to reply with?") correctly quoted the prior turn's exact text — proves conversation continuity, not just a fresh session bluffing.
- Daemon SQLite row (`sessions` table) for the session: `agentChatId = c7cb61ee-...` (openab's native `conversation_id`), `acpSessionId = b3fb6eca-...` (the ACP `session/new` id — used as the *key* into openab's store). Confirmed two distinct ids, and `agentChatId` holds the native one, not the ACP one — matches the "two session identities (ACP)" contract in AGENTS.md's Agent-plugin section.
- `~/.vibe-station/agy-acp/sessions.json` inside the container (D5 state path, not `~/.agy-acp` or `~/.openab/agy-acp`) contained exactly one entry keyed by the ACP session id, `{conversation_id, last_step_idx, model_id}` — matches openab's `persist_session` shape. `last_step_idx` advanced 1 → 4 → 7 across turns, confirming real resume (not silent no-op).

### 6.6 — System prompt placement
- Created a mode with an unusual, unambiguous system instruction ("prefix every reply with the token ZXQVSENTINEL"). First-turn assistant reply began with `ZXQVSENTINEL` — confirms `agy.rs`'s first-turn system-prompt prepending survives openab's block-flattening into `-p`.

### 6.7 — Model selection
- `PATCH /sessions/:id/chat/model` with `"Gemini 3.5 Flash (Low)"` (from `GET /api/cli-models?cli=agy`, which lists 8 models fetched live via `agy models` inside the container — `[agy-acp] fetched 14 models from \`agy models\`` in the raw stdio test, 8 surfaced via the mapped list) succeeded; next turn's reply self-identified as "Gemini" — confirms `session/setConfigOption` reaches agy.

### 6.8 — fs/terminal/steering not required
- No fs/terminal/steering related errors, hangs, or missing-capability failures observed across ~8 turns run during this verification. `canSteer: false` in `/sessions/:id/meta` for the agy session, consistent with openab's ACP surface (no steering method).

### 6.9 — `session/load` fallback for unrecognized sessions
- Overwrote a live session's `acpSessionId` in the daemon's SQLite store with a synthetic "legacy npm-era" id (`legacy-npm-era-session-id-00000000`), restarted the daemon container to force a reload, then sent a new chat turn.
- Transcript shows a `status` event: `"resumed with a fresh agent session — prior context may not be visible to the CLI"`, followed by a normal successful turn (no error, no hang). Confirms clean `session/load`→fail→`session/new` fallback.

### 6.10 — Multi-session concurrency — **FAILED, real bug**
- Spawned two simultaneous agy Rich Chat sessions on different projects/worktrees (`frge-5`/forge-cli, `atls-4`/atlas-dashboard), each with a distinct one-shot marker prompt.
- Session B got its own correct response ("session B marker"). **Session A's turn completed with `result` but NO assistant `text` event at all** — the reply silently vanished.
- Retried on session A alone (no longer concurrent): the very next turn's transcript contains **two** assistant `text` events for the same `turnId` — `"session B marker"` (leaked from the earlier concurrent run) immediately followed by the actually-requested `"retry marker A"`. This is direct evidence of cross-session data leakage between two agy-acp adapter processes, not just the "shared-log error-detection race" the plan's risk note anticipated (which implies error *misattribution*, not silent wrong-answer delivery).
- **Root cause (not investigated further — out of scope for this verification pass):** openab's `agy-acp` tails agy's shared SQLite conversation DB per adapter's own documented limitation (see report gap "Multi-session concurrency"); this run shows it can attribute another session's actual response text to the wrong turn, not just misfire an error.
- **This blocks shipping concurrent agy Rich Chat sessions as-is.** Recommend: either serialize agy turns daemon-side (one in-flight agy-acp turn globally), or escalate to openab upstream, before Phase 2 is considered fully done for real usage.

### 6.11 — `--print-timeout` applied (60m, not openab's 20m default)
- Did not wait a real 20+ minutes. Instead, captured the actual spawned `agy` argv via `ps aux` inside the container mid-turn: `agy --add-dir /app --print-timeout 60m --conversation <id> -p <prompt>`. Confirms the 2.3 patch's 60m default is what actually reaches the child process at runtime, not just what the patch source claims.

### 12.1 / 12.2 — No bun anywhere; `vst doctor` clean
- `which bun` → not found; `find / -iname bun -type f` (excluding `/proc`) → zero results anywhere in the running container filesystem.
- `vst doctor` inside the container:
  ```
  ✓ tmux is available          ✓ agy is on PATH
  ✓ git is available            ✓ agy-acp adapter binary (required for agy Rich Chat / ACP)
  ✓ claude is on PATH           ✓ cloudflared
  ✗ cursor is on PATH           ✗ tailscale not found
  ✓ opencode is on PATH         ✓ Daemon is running
  ```
  No `bun` line at all (correctly removed), `agy-acp` reported present. `cursor`/`tailscale` failures are pre-existing/unrelated to this feature (cursor-agent versions mount and tailscale are separate sandbox concerns).

### `cargo test --workspace`
- Full run: 105 test binaries, all `test result: ok`. One test (`vst-git`'s `same_key_call_within_cooldown_resolves_without_a_new_subprocess`) failed on a first `--test-threads` default run but passed both in isolation and on a clean full rerun — pre-existing test-order flakiness in an unrelated crate (global fetch-cooldown cache), not caused by or related to this feature.

### `cargo clippy --workspace` (via `rust/scripts/rust-gate.sh`'s deny groups: correctness/suspicious/complexity/perf)
- `cargo fmt --all --check` fails with widespread pre-existing formatting drift across many files unrelated to agy-acp (none of the diffs touch agy/openab files) — looks like a rustfmt version/config drift issue on this branch, out of scope to fix here.
- `cargo clippy --workspace --all-targets --all-features -- <deny groups>` has **3 pre-existing deny-level errors**, all in `vst-routes/src/settings.rs` (2: manual-flatten, manual-strip) and `vst-routes/src/worktrees.rs` (1: too-many-arguments on `search`) — `git log` shows these files were last touched 2026-09-17 (`fix(daemon): concurrency/correctness/efficiency findings from search review`), before any agy-acp commits on this branch. Not introduced by this feature.
- Scoped re-run on exactly the crates this feature touches — `cargo clippy -p vst-agents -p vst-agy-acp --all-targets --all-features -- <deny groups>` — is **clean** (zero errors, only informational pedantic warnings not covered by the deny groups).
- `vst-daemon`/`vst-cli` clippy can't be isolated from the pre-existing `vst-routes` errors (transitive dependency), so their clippy status is inherited-red for reasons unrelated to this feature.

### Teardown
- `scripts/dev-sandbox.sh down vs-165`, then `docker volume rm vst-dev-data-vs-165 vst-dev-projects-vs-165` (this was a scratch verification sandbox, not a long-lived dev environment). Scratch docker-build artifacts (`.cargo-docker/`, `rust/target-agy-acp-docker/`) removed via a container (host user lacked permission on root-owned files docker created). `git status` clean except gitignored `rust/target-docker/`.

### Net verdict
- Every checked item above (6.1–6.3, 6.6–6.9, 6.11, 12.1, 12.2) is genuinely verified against a real `agy` binary and the real openab adapter, not mocked.
- **6.10 is a real, reproducible, unfixed bug** — silent cross-session response leakage under concurrency — and should stay unchecked until addressed.
- `cargo test --workspace` and the agy-touched crates' clippy are clean; the full-workspace clippy/fmt gate is red for pre-existing, unrelated reasons (documented above, not fixed here per instructions to report rather than silently patch).
