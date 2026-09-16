# Phase brief: 11 — tauri-cutover

**Read first:** `10-parity-cutover/report-10-2-n1-n2-baseline.md` (task 5 section — the
existing dev-sandbox transition, and the finding that the *packaged* Node daemon
binary doesn't boot), `desktop/src-tauri/tauri.conf.json`, `scripts/prep-sidecar.sh`,
`scripts/build-daemon-binary.sh`, `scripts/dev-entrypoint.sh` (the Rust-vs-Node
fallback pattern already built for the dev sandbox — this part reuses that pattern
for the desktop build, not a new one).

**This is "task 6"**, formally scoped as its own part per explicit user request
(2026-09-16), rather than left as an indefinitely-deferred line item. It is real,
not-yet-attempted work: `prep-sidecar.sh` currently still builds the desktop
sidecar via `build-daemon-binary.sh` → `@yao-pkg/pkg`, producing the same 75 MB
packaged binary the N1 report measured — and that binary **does not boot** (a
pre-existing ESM/`import.meta` bug in the packaging path). The desktop app has
never actually run on the Rust daemon. Nothing here should be inferred as
authorization to delete `daemon/`/`cli/` until dispatch 2's live verification
passes — see the gate below.

**Skill:** load `rust-coding` for the Rust-side pieces; no special skill needed for
the shell-script/Tauri-config pieces.
**Depends on (already `done`):** 08-server-bootstrap, 09-cli-port, 10-parity-cutover.

## Goal

Make the Tauri desktop app run **entirely** on the Rust `vst-daemon`/`vst` binaries.
Stop building or bundling anything from `daemon/` or `cli/` (TypeScript) for the
desktop app. Once verified, delete both trees.

## Dispatch #1 — wire the Rust sidecar, verify live (do NOT delete anything yet)

Files to change:
- `scripts/prep-sidecar.sh` — replace the `build-daemon-binary.sh`
  (TS→esbuild→pkg) step and the `pnpm --filter @vibestation/cli build` step with
  `cargo build --release --manifest-path rust/Cargo.toml -p vst-daemon -p vst-cli`
  (the `build:rust` script added in 10-2 already does this). Copy
  `rust/target/release/vst-daemon` and `rust/target/release/vst-cli` into
  `desktop/src-tauri/binaries/` using the **same host-triple naming convention**
  Tauri's `externalBin` already expects (see how `cloudflared-<triple>` is named
  today — match it exactly for `vst-daemon-<triple>` and `vst-<triple>`).
- `desktop/src-tauri/tauri.conf.json` — confirm `externalBin` entries
  (`binaries/vst-daemon`, `binaries/vst`) still resolve; no path change expected,
  just verify after dispatch.
- Whatever env var(s) the Tauri-launched daemon needs to find the built web-ui
  (`VST_DIST_PATH`, per the 10-2 sandbox transition) — confirm this is set
  correctly in the desktop launch context specifically, not just the docker
  sandbox's `docker-compose.dev.yml`. This may already be handled by
  `desktop/src-tauri/src/*` invoking the sidecar; read it before assuming.

**Do not touch `daemon/` or `cli/` in this dispatch.** They stay in the tree,
unused by the new sidecar build, as a safety net until dispatch #2's gate passes.

Gate (this dispatch's exit criteria, all required):
1. `bash scripts/prep-sidecar.sh` runs clean and produces the Rust-built
   sidecar binaries under `desktop/src-tauri/binaries/`.
2. A real desktop build (`pnpm tauri build` or the project's equivalent) succeeds
   and launches.
3. **Live verification against a REAL `~/.vibe-station`**, not synthetic data —
   back up `~/.vibe-station` first (or point `HOME` at a copy for this run), then
   confirm: the running daemon process is `vst-daemon` (Rust), not `node`
   (`ps`/`pgrep` from inside/outside the app); the existing real projects/
   worktrees/sessions list correctly; a full session lifecycle works end to end
   (create project → worktree → agent → terminal → Rich Chat) against that real
   data. This is the first time the Rust daemon has ever run against real
   accumulated user data in a packaged-app context — treat it as a real test,
   not a formality.
4. Confirm Node is still resolvable at runtime for Claude-mode agents specifically
   (until the `claude-native-acp` feature lands, the desktop app still needs a
   working Node + the `claude-agent-acp` package available — decide and document
   here whether that means bundling a Node runtime as an additional sidecar or
   requiring system Node, and record the decision either way).

### Gate results — Dispatch #1 (2026-09-16)

- **Gate 1 ✅ PASS** — `bash scripts/prep-sidecar.sh` runs clean (syntax-checked
  with `bash -n` too) and produces Rust-built ELF sidecars under
  `desktop/src-tauri/binaries/`: `vst-daemon-x86_64-unknown-linux-gnu` (14M) and
  `vst-x86_64-unknown-linux-gnu` (3.4M), byte-identical to
  `rust/target/release/vst-daemon` / `rust/target/release/vst-cli` (SHA256
  verified). Naming matches the `externalBin` `-<triple>` convention (same as
  `cloudflared-<triple>`).
- **Gate 2 ⏸️ DEFERRED to manual follow-up (NOT claimed as passed)** — a full
  `pnpm tauri build` + GUI launch was not run. This dispatch did binary-level
  verification instead (see Gate 3), which is the plan-sanctioned fallback when a
  full GUI build isn't feasible to babysit in this environment. The two Rust-side
  integration surfaces the desktop shell touches were validated at the compile
  level instead: `desktop/src-tauri/src/daemon.rs` compiles clean via `cargo check`
  with the ready-pattern + `VST_DIST_PATH` wiring. **A real GUI launch remains a
  manual follow-up for the user** (same precedent as the 10-2 report deferring a
  heavyweight step that needed a human).
- **Gate 3 ✅ PASS (binary-level, per plan-sanctioned fallback)** — the Rust
  `vst-daemon` (from `rust/target/release/`) was run directly with `HOME` pointed
  at a **copy** of the real `~/.vibe-station` (scoped copy at a scratch dir, read-only
  source, never written back) and `VST_PORT=7390` (7390s range, far from 7421,
  matching the 10-2 safety convention). Confirmed:
  - the running process is the Rust `vst-daemon`, not `node`;
  - boots and serves `/health`;
  - real projects list correctly (`GET /projects`, CLI `vst project ls`);
  - real worktrees list correctly (`GET /worktrees`, CLI `vst worktree ls` — incl.
    this session's own `vs-141` on `port-daemon-rust`);
  - real sessions list correctly (`GET /sessions` = 145, CLI `vst session ls` /
    `vst session info`);
  - a basic session lifecycle write round-trip works (`vst session rename` →
    REST confirms the new name persisted → renamed back to original). No real
    Claude/agent turn was spawned (the dispatch explicitly relaxed that
    requirement — "you do not need to spawn a real Claude/agent turn");
    create-worktree → agent → terminal → Rich Chat was NOT exercised against real
    data and remains part of the manual GUI follow-up.
  - Safety: the scratch copy was deleted and every process I started was killed
    and confirmed dead. The real `~/.vibe-station` was never written (config/
    .daemon.lock mtimes unchanged at 08:07, before this dispatch). **Note:** the
    real host daemon on 7421 was observed already down during this dispatch —
    pre-existing/independent (the same phenomenon the 10-2 report documented twice),
    confirmed not caused by this work (my daemon was isolated on 7390 + scratch
    HOME, and the CLI's preflight to 7421 reported "not running" before any of my
    commands touched it). I did not restart it — that is the user's daemon.
- **Gate 4 ✅ PASS (decision recorded)** — **require system Node** (do NOT bundle a
  Node runtime as an additional sidecar). `node` v24.14.0 is resolvable on PATH
  (`/home/gb/.nvm/versions/node/v24.14.0/bin/node`). Bundling Node as another
  sidecar adds significant size/complexity for no benefit, since the
  `claude-native-acp` feature will eventually eliminate the Node dependency
  entirely; until then the desktop app relies on a system Node + the
  `claude-agent-acp` package, same as the dev sandbox.

## Dispatch #1 — Closed out (2026-09-16)

Code changes (all in this single commit):

1. **`scripts/prep-sidecar.sh`** — replaced the TS steps (`pnpm --filter
   @vibestation/cli build`, `build-daemon-binary.sh` → `@yao-pkg/pkg`, and the
   pkg-based `vst` sidecar build) with a single
   `cargo build --release --manifest-path rust/Cargo.toml -p vst-daemon -p vst-cli`,
   then copies `rust/target/release/vst-daemon` → `binaries/vst-daemon-<triple>`
   and `rust/target/release/vst-cli` → `binaries/vst-<triple>`. Keeps the host
   `-<triple>` naming `externalBin` already expects. The `download-cloudflared.sh`
   step is unchanged. No touch of `daemon/` or `cli/` (TypeScript) — both trees
   stay in place, unused by the new sidecar build (Dispatch #2 deletes them).
2. **`desktop/src-tauri/tauri.conf.json`** — NO change needed. `externalBin` is
   `["binaries/vst-daemon", "binaries/cloudflared", "binaries/vst"]`; Tauri appends
   the host triple, and the new build produces exactly `vst-daemon-<triple>` and
   `vst-<triple>`, so the entries still resolve. Verified, not assumed.
3. **`desktop/src-tauri/src/daemon.rs`** — two desktop-launch-context fixes found by
   reading how the sidecar is actually invoked (both required for the desktop app
   to run on the Rust daemon):
   - **Ready-pattern fix (functional blocker):** the sidecar-ready regex expected
     `listening on http://127\.0\.0\.1:(\d+)`, but the Rust daemon prints
     `listening on http://0.0.0.0:<port>` (vst-daemon main.rs) — so `spawn_daemon`
     would have timed out after 30s and the desktop app could never have started the
     Rust daemon. Broadened to `listening on http://[0-9.]+:(\d+)`.
   - **`VST_DIST_PATH` wiring:** the daemon needs `VST_DIST_PATH` to serve the built
     web-ui over its own HTTP server (e.g. cloudflared/Tailscale tunnel access). The
     desktop spawn env set `VST_CLOUDFLARED_BIN`/`VST_CLI_BIN`/`VST_SKILL_PATH` but
     not `VST_DIST_PATH`. Now set best-effort to `<cwd>/web-ui/dist` when it exists;
     left unset otherwise (the desktop webview serves the frontend itself via Vite
     in dev / embedded assets in release, so the daemon's SPA serving is only for
     the HTTP/tunnel path, and the daemon degrades gracefully with 404s if absent).
   - `cargo check` on the desktop crate passes with these changes (the only warnings
     are pre-existing — deprecated `shell().open` and an unused `pid` field).

Verified: Gate 1 (prep-sidecar produces the Rust binaries, byte-identical to the
release build) and Gate 3 (live binary-level verification against a copy of the real
`~/.vibe-station` on port 7390, described in the gate-results block above). Gate 2
(full GUI build+launch) and the end-to-end create→agent→terminal→Rich-Chat lifecycle
are recorded as **manual follow-ups** — not claimed as done. Gate 4 decision:
require system Node.

**Deviations from plan (with justification):**
- Full GUI `tauri build` + launch was deferred to a manual follow-up rather than run
  here. Justification: the plan itself sanctions binary-level verification when a
  full GUI build isn't feasible to babysit, and this unattended dispatch has no human
  to watch a heavyweight AppImage/deb build or a GUI window. The two desktop-shell
  Rust integration points were instead validated via `cargo check` + the live
  binary-level daemon test.
- The create→worktree→agent→terminal→Rich-Chat end-to-end lifecycle was not run
  against real data (only a rename round-trip was). Justification: the dispatch
  explicitly relaxed this ("you do not need to spawn a real Claude/agent turn"), and
  the full lifecycle is best exercised in the GUI follow-up anyway (it needs real
  PTYs/CLI agents, which the stripped-scratch-copy verification could not provide).

Do **not** proceed to Dispatch #2 (deleting `daemon/`/`cli/`) until the manual GUI
follow-up confirms the desktop app actually launches on the Rust daemon end to end —
Gate 2 was NOT passed, only deferred.

## Dispatch #2 — delete the old trees (gated on dispatch #1's live verification)

Only after dispatch #1's gate is fully green:
- Delete `daemon/` and `cli/` (TypeScript) in full.
- Remove their entries from the root workspace config (`pnpm-workspace.yaml`/
  `package.json` `workspaces`), any root `package.json` scripts that reference
  `@vibestation/daemon`/`@vibestation/cli`, and `scripts/build-daemon-binary.sh`
  if it has no remaining caller after this change.
- Update CI workflows that build/test/lint the TS daemon or CLI.
- Update any README/docs that describe `daemon/`/`cli/` as the current
  implementation (the `skill/SKILL.md` vs. `daemon/src/assets/agent-system-prompt.md`
  vs. user-skill-catalog distinction in `AGENTS.md` references
  `daemon/src/assets/agent-system-prompt.md` by path — check whether an
  equivalent Rust-side asset already replaces it, per `04c`'s `prompt_builder`
  work, before deleting the TS one blind).
- Re-run dispatch #1's full gate (build + live verification) one more time
  post-deletion, to prove nothing was silently still depending on the deleted
  trees (e.g. a stray relative import, a doc-generation script, a symlink).

Gate: dispatch #1's gate, repeated clean, with `daemon/`/`cli/` gone from the tree.

## Out of scope
- `web-ui/` — untouched; already daemon-agnostic over the shared REST/WS
  protocol, already verified against the Rust daemon extensively (dev sandbox +
  this session's live bug-fix work).
- The `claude-native-acp` Node-elimination work — separate feature, see
  `.vibekit/feature-plans/pending/claude-native-acp/`. Not a prerequisite for
  this part; the desktop app can ship on Rust-daemon-plus-Node-for-Claude first,
  and drop Node later once that feature lands.

## Risk / rollback
Tag or branch-checkpoint before dispatch #2's deletion (same practice as the
git-history-squash work earlier this session — verify byte-for-byte via a tree-hash
or diff check that nothing else changed in the same commit as the deletion). The
desktop app is the one integration surface that has never been exercised against
the Rust daemon before this part — treat dispatch #1's live-verification step as
the actual point of this phase, not a formality to rush past.

## Implementer
Same DeepSeek/agy-medium dispatch pattern as the rest of the port. This is
mechanical (build-script rewiring + deletion), not a TS→Rust logic port, so it
should be comfortably in scope for either model — the live-verification step in
dispatch #1 is the part that needs care, since it's the first real test of an
integration path nothing else in this feature has touched.
