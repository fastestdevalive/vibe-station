# Phase brief: 00 — foundation

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `00-foundation`, Entities & Modules row(s) for `vst-types`, `vst-testkit`, Gotchas #7, #10, #11, #12, #14, System Boundaries row(s) `Client (web-ui/desktop/CLI) ↔ vst-daemon`, `Wire-compat drift detector`.
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-types, rust/vst-testkit (plus all 12 workspace crates scaffolded as empty-but-compiling skeletons: vst-types, vst-testkit, vst-store, vst-proc, vst-git, vst-rpc, vst-agents, vst-lifecycle, vst-ws, vst-routes, vst-daemon, vst-cli)
**Depends on (already `done`):** none

## Files to port
Everything below, so no later part ever touches build/CI setup: full Cargo workspace with all 12 crates scaffolded as empty-but-compiling skeletons (rust/Cargo.toml's members list is written once, complete, and final — every crate directory + its own Cargo.toml + a stub src/lib.rs/src/main.rs exists from day one, each with its #![forbid(unsafe_code)] or documented #![deny(unsafe_code)], [lints] workspace = true, and dependency stanza pre-wired to [workspace.dependencies] — later parts fill in a crate's body, they never create a crate or edit the workspace member list); [profile.release] tuned for N1 (lto = true, strip = true, panic = "abort" on the two bins, codegen-units = 1); .github/workflows/rust-ci.yml running rust/scripts/rust-gate.sh --workspace on every push/PR touching rust/** (the repo's CI today only has desktop-build.yml — this is new, not an extension); rust/Cargo.lock committed; .gitignore entry for rust/target/; vst-types (mirrors types.ts 561L + protocol.ts 615L + every routes/*.ts zod schema/response shape + events::{ServerEvent, Broadcaster}); vst-testkit; config/paths (lib/*.ts, services/paths.ts, config.ts, daemonPort.ts, tunnelPort.ts, debugLog.ts); file-map.tsv + rust/scripts/check-file-map.sh; rust/vst-types/tests/fixtures/wire/* + capture script; rust-toolchain.toml, deny.toml, [workspace.dependencies] pins; rust/scripts/rust-gate.sh; the AppState/handle convention doc

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [x] 0. Load rust-coding skill
- [x] 1. Read the files above + the named AGENTS.md sections + Gotchas rows
- [x] 2. Write the behavior contract (bullets)
- [x] 3. Write Rust tests first; `git commit -m "test(00): behavior contract"`
- [x] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [x] 5. Run rust/scripts/rust-gate.sh; save log to rust/.gate/00.log; commit
- [x] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments — STOP

## Part-specific notes
- Part 00 scaffolds the workspace and all 12 crates (vst-types, vst-testkit, vst-store, vst-proc, vst-git, vst-rpc, vst-agents, vst-lifecycle, vst-ws, vst-routes, vst-daemon, vst-cli) so every crate compiles under `cargo build --workspace`.
- Generates daemon-rust-port/file-map.tsv covering all daemon/src and cli/src files with rust/scripts/check-file-map.sh.
- Generates wire fixtures at rust/vst-types/tests/fixtures/wire/ via capture script scripts/capture-wire-fixtures.ts (or direct extraction from TypeScript schemas/test suites/sandboxes).
- Ships AppState/handle convention doc and ensures all crates follow `pub struct XHandle(Arc<Inner>)`, `#[derive(Clone)]`.
