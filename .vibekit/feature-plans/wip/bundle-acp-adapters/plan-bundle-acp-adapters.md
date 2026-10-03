<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Bundle agy-acp + Claude ACP adapters in the curl-installed `vst`

> Ship both adapters as self-contained executables in the `vst-<target>.tar.gz` CLI release; no bun/node needed at runtime.

**Issue:** bundle-acp-adapters
**Branch:** `bundle-acp-adapters-curl-install`
**Status:** Done (CI run pending)

**Reference files:**
- Claude launch + resolver: `rust/vst-agents/src/claude.rs` (`claude_acp_spec`, `claude_acp_bin`)
- agy resolver: `rust/vst-agy-acp/src/lib.rs` (`agy_acp_bin`, beside-exe `agy-acp`)
- Release packaging: `.github/workflows/release.yml` (build-cli job)
- Installer: `scripts/install.sh` (`install_cli`)

---

## Problem & Concept

- Only the Tauri app bundles the adapters; curl installs get neither, so claude Rich Chat fails (agy Rich Chat is disabled on main for now, so `agy-acp` ships dormant)
- agy: ship the existing `agy-acp` binary beside `vst` — resolver already looks there
- claude: compile the pinned adapter with `bun build --compile` into `claude-acp` beside `vst`; add one resolver (`claude_acp_bin`) in front of the existing bun path

## Out of Scope

- Tauri desktop packaging (keeps `bun <entry.js>` + vendor resources); cursor/opencode (spawn the user's own CLI)
- Windows; Intel macOS (not published)

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Tarball contains `vst`, `agy-acp`, `claude-acp` (flat executables) |
| 2 | `install.sh` installs all three beside each other; `claude-acp` skipped on musl |
| 3 | `agy_acp_bin()` / `claude_acp_bin()` resolve from the install dir with no env vars |
| 4 | A real Claude turn runs through the installed `claude-acp` with bun absent from PATH |
| 5 | `VST_CLAUDE_ACP_ENTRY` (dev/desktop) still wins over a beside-exe `claude-acp` |

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Claude adapter form | `bun build --compile` single binary | User decision (gold standard); re-tested: the old "fails at session/new" note no longer reproduces on bun 1.4.2 + adapter 0.70.0 |
| Linux variant | glibc bun build, even inside the musl tarball | Musl-linked bun can't run on glibc and needs libstdc++ on Alpine; the one Linux tarball serves both libcs |
| musl systems | Installer skips `claude-acp` + warns | glibc binary cannot exec there; daemon falls back to the bun path |
| bun version | Pinned `1.4.2` in release.yml | The runtime is embedded in the binary — reproducible builds |
| Cross-compile | `--target` maps Rust triple → bun target | Any host can build any target |
| Resolver | New `claude_acp_bin()`; entry-env override wins | Small addition; existing bun path stays as dev/desktop fallback |

## Change Map

```
scripts/
  build-claude-acp.sh        + bun compile per target
  package-cli-tarball.sh     + vst + agy-acp + claude-acp
  build-agy-acp.sh           ~ optional --target
  install.sh                 ~ skip claude-acp on musl
  install-claude-acp-vendor.sh ~ frozen mode
rust/
  vst-agents/src/claude.rs   ~ claude_acp_bin + spec
  vst-daemon/src/doctor.rs   ~ bun check aware of bundle
  vst-cli/src/commands/doctor.rs ~ bun label
.github/workflows/release.yml ~ build adapters, checks
```

## Implementation Phases

- [x] 1 — `build-agy-acp.sh --target`; `build-claude-acp.sh`; `package-cli-tarball.sh` (3 binaries)
- [x] 2 — `claude_acp_bin()` + launch spec + unit test; doctor bun check aware of the bundle
- [x] 3 — `install.sh` skips `claude-acp` on musl; release workflow builds/checks/packages
- [x] 4 — Local proof: install from mirror, resolvers, real turn, Alpine skip; mac proof on the macbook

## Review outcome (Opus, on the earlier vendor-dir design)

- Carried over: frozen CI vendor install, Alpine exec check for `agy-acp`, `COPYFILE_DISABLE`, daemon-restart note
- Obsolete with the single-binary design: vendor-dir swap atomicity, `~/.bun/bin` check, loop fragility
- Still open: doctor has no check that `agy-acp`/`claude-acp` exist (deliberately — they ship in the tarball)
- Flagged: `@anthropic-ai/claude-agent-sdk` license is all-rights-reserved; compiled binary embeds it

## Risks

- Tarball ~50MB gz on Linux (bun runtime embedded: `claude-acp` ~37MB gz); macOS ~26MB for the adapter
- Musl/Alpine users get no bundled Claude Rich Chat adapter
- CI job unrun; the new debian-bullseye initialize check is CI-only
