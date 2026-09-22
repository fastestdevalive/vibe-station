# `rust/vendor` — external binaries vendored as submodules

This directory holds git submodules that are **build inputs only** (produce a
standalone binary), never Cargo dependencies. Nothing here is added to
`rust/Cargo.toml`'s `[workspace] members` — in fact `[workspace] exclude = ["vendor"]`
keeps Cargo from ever discovering it. The walled-garden rule: **only the named
binary subdirectory may be used; nothing else from the submodule's repo may be
imported, referenced, or linked.**

## `openab/` (only `agy-acp/` may be used)

- Pinned submodule → the openab fork at `https://github.com/fastestdevalive/openab`
  (branch `vs-agy-acp-patch`), which carries a small `agy-acp/` patch on top of
  upstream: `AGY_BIN` support, `AGY_ACP_STATE_DIR` support, and a 60m default
  `--print-timeout`. Upstream PR: `openabdev/openab#1543`.
- Build in isolation (never from the repo root):
  `cargo build --release --manifest-path rust/vendor/openab/agy-acp/Cargo.toml --target-dir rust/target/agy-acp`
  (`--target-dir` keeps the submodule working tree clean).
- The daemon spawns the resulting `agy-acp` binary as a subprocess over stdio
  ACP. It is **never** linked into the daemon's crate graph.
- The **entire** openab repo is present in the submodule, but **only `agy-acp/`
  is ever built or used**. Do not import, `use`, or add any other openab crate
  as a dependency.

## Guardrails (enforced in CI — `.github/workflows/rust-ci.yml`)

- No `openab` path under any `[dependencies]`/`[workspace.dependencies]`.
- No `use openab` / `extern crate openab` / `#[path = "...openab..."]` / `include!`
  of openab files in `rust/*/src/`.
- `cargo metadata --manifest-path rust/Cargo.toml` must contain no package named
  `agy-acp` and no manifest under `rust/vendor/`.
