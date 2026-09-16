# Phase brief: 10 — parity-cutover

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `10`, Functional
Requirements F1-F4 (byte-compatible protocol with the one deliberate fork-path
exception, CLI drop-in replacement, regression tests for every documented
concurrency bug, SQLite schema compatibility), N1/N2 (binary size, cold start —
baseline measured in THIS part), the Stop Conditions section at the bottom of
`ORCHESTRATION-PROMPT.md`.
**Skill:** load `rust-coding` before touching any .rs file (still applies —
harness/fixture code is still Rust).
**Crate(s):** none new — this part is verification + glue across everything built
so far, plus non-Rust build/tooling files.
**Depends on:** all of `00`-`09`.

## This is NOT a port — it's a task list, sized by task not by LOC

Arch doc: "Black-box parity harness (run both daemons against the same request
fixtures, diff responses); update `scripts/dev-sandbox.sh`, `docker-compose.dev.yml`,
root `package.json` build scripts; binary-size/cold-start measurement against
N1/N2; delete the old TS `daemon/`+`cli/` trees." No LOC estimate — "verification
+ glue, not a port" per the arch doc's own row.

## ⚠️ Hard stop condition — do not skip this

Per `ORCHESTRATION-PROMPT.md`'s Stop Conditions **and** explicit user direction
(2026-09-15g): **do NOT run this part's deletion of the old TS `daemon/`+`cli/`
trees at all as part of dispatch #1 or #2.** That step is destructive and
irreversible on this branch, and has been pulled out of this part's dispatch
plan entirely — it is its own separate, later action, dispatched only when the
human explicitly asks for it, not something either dispatch should even
attempt or ask about completing.

## Dispatch plan — 2 dispatches, deletion deferred entirely (user-directed, 2026-09-15g)

The 6-task list below is real, but doesn't need 6 dispatches. Grouped into 2 by
nature of the work (verification/correctness vs. measurement/tooling), with
task 6 (deletion) **pulled out entirely** — it is not part of either dispatch
and is not dispatched at all until the human explicitly asks for it, as its
own separate, later action.

| Dispatch | Tasks | Nature |
|---|---|---|
| **#1 — Correctness & parity** | 1 (parity harness), 2 (concurrency-bug regression tests), 3 (SQLite schema compat) | Rust-test-writing heavy — all three are "prove behavioral equivalence between the two daemons" work, cohesive together. |
| **#2 — Measurement & tooling** | 4 (N1/N2 baseline), 5 (dev-sandbox/docker-compose/package.json script updates) | Ops/tooling heavy — running commands, measuring, editing shell/YAML/JSON scripts rather than writing Rust tests. |
| *(deferred, not dispatched)* | 6 (delete old TS trees) | **Only proceeds on explicit human request, as its own separate action, at whatever point the user chooses.** Neither dispatch #1 nor #2 touches `daemon/` or `cli/`. |

## Task breakdown (detail, referenced by the dispatch plan above)

| # | Task | What "gate" means here |
|---|---|---|
| 1 | **Black-box parity harness**: run the old Node daemon and the new Rust daemon side-by-side against the same request fixtures (reuse `vst-testkit`'s fixtures from part `00` where possible), diff every response byte-for-byte except the one documented F1 exception (fork path). | A test suite that actually runs both binaries and asserts equality — not just "the Rust daemon's own tests pass," which every prior part already covers. This is the first point in the whole feature where the two implementations are compared directly against each other. |
| 2 | **Regression tests for every documented concurrency bug** (F3): double-echo (Terminal invariant, AGENTS.md), ghost PTY streams (`withSessionLock` serialization, part `06`), status-writer races (two-axis lifecycle/PR model, part `05`). Confirm each already has *some* test coverage from its owning part; if a genuine regression test for the exact historical bug is missing, add it here rather than assuming an ordinary unit test from that part covers the specific race. | Each of the 3 documented bug classes has a named, traceable regression test — not just "tests pass" in general. |
| 3 | **SQLite schema compatibility** (F4): verify the Rust daemon can open and correctly read a DB file written by the current Node daemon, without a migration step silently corrupting or dropping data. | A fixture DB captured from the real Node daemon, opened and read correctly by the Rust one. |
| 4 | **N1/N2 baseline measurement**: measure the current Node daemon's `@yao-pkg/pkg`-packaged binary size and cold-start time (the arch doc says this baseline is measured *in this part* — it doesn't exist yet), then measure the Rust binary's equivalents and confirm N1 (smaller)/N2 (faster cold start) actually hold. | Numbers in the report, not just "it feels faster." If either regresses, that's a real finding to surface, not to quietly pass over. |
| 5 | **Update `scripts/dev-sandbox.sh`, `docker-compose.dev.yml`, root `package.json` build scripts** to build/run the Rust binaries instead of (or alongside, during transition) the Node ones. Cross-reference the "Docker dev sandboxes" section of `AGENTS.md` — don't reintroduce the seed-mode-volume-corruption hazard documented there while touching these scripts. | The dev sandbox actually boots against the Rust daemon and behaves per the demo dataset expectations already documented in `AGENTS.md`. |
| 6 | **⚠️ DEFERRED — separate action, not part of dispatch #1 or #2.** Delete the old TS `daemon/`+`cli/` trees. The Rust binaries (`rust/vst-daemon`+`rust/vst-cli`) are unaffected by this deletion — confirm they build and run standalone (not accidentally depending on anything under the trees being deleted) before deleting, whenever this is eventually dispatched. | A human said "yes, delete it" — not an assumption inferred from "all tasks above passed," and not something either dispatch #1 or #2 should even ask about. |

## Checklist — dispatch #1 (correctness & parity: tasks 1-3)
- [ ] 0. Load rust-coding skill (for harness/fixture code)
- [ ] 1. Read F1, F3, F4, and AGENTS.md's documented concurrency-bug sections in full
- [ ] 2. Write the behavior contract for the parity harness specifically (what
        counts as "byte-compatible," what the one deliberate fork-path exception covers)
- [ ] 3. Build the parity harness + regression tests + SQLite compat check first,
        against BOTH binaries actually running —
        `git commit -m "test(10-1): parity harness + regression suite + SQLite compat"`
- [ ] 4. Implement (N6 still applies if anything under `rust/` is touched)
- [ ] 5. Run everything; save results (parity diffs, regression outcomes, SQLite
        compat result) to a report file, not just pass/fail; commit
- [ ] 6. Report: parity results, any real divergence found (including the expected
        fork-path one), regression test outcomes, SQLite compat result — STOP.
        Do not touch task 4/5 (dispatch #2's scope) or task 6 (deletion, deferred
        indefinitely, not this dispatch's concern at all)

## Checklist — dispatch #2 (measurement & tooling: tasks 4-5)
- [ ] 0. Load rust-coding skill (in case any `rust/` code needs touching, though
        this dispatch is mostly outside `rust/`)
- [ ] 1. Read N1, N2, and AGENTS.md's "Docker dev sandboxes" section in full
- [ ] 2. Measure the CURRENT Node daemon's binary size + cold-start time first —
        this baseline doesn't exist yet anywhere in the repo
- [ ] 3. Measure the Rust binary's equivalents; commit the baseline + comparison
        numbers to a report file — `git commit -m "chore(10-2): N1/N2 baseline measurement"`
- [ ] 4. Update `scripts/dev-sandbox.sh`, `docker-compose.dev.yml`, root
        `package.json` build scripts; N6 applies if `rust/` is touched
- [ ] 5. Verify the dev sandbox actually boots against the Rust daemon
- [ ] 6. Report: N1/N2 numbers (flag clearly if either regressed, don't bury it),
        script changes made — STOP. Do not touch task 6 (deletion) at all

## ⚠️ The parity harness (task #1) literally runs BOTH daemons — this is the highest daemon-safety risk in the whole feature

This part's core task requires running the old Node daemon AND the new Rust daemon
side by side, which is exactly the operation `ORCHESTRATION-PROMPT.md`'s
"Never touch the user's LIVE `vst` daemon" section warns about. Concretely:

- **Never point either harness instance at the real `~/.vibe-station` home or the
  default port `7421`.** Both instances need isolated homes/ports — the old Node
  daemon already supports `VST_PORT` for port override but has NO home-dir
  override (confirmed by reading `main.ts` — `VST_HOME` is hardcoded); if this
  part's harness needs the Node side isolated too, it may need a small, disclosed
  TS change (a `VST_HOME`-style env var) or must run the Node side inside the
  existing `docker-compose.dev.yml` sandbox instead of bare on the host.
- **If the Rust daemon (part `08`'s output) needs a home-dir override for this
  harness to work, that override should already exist from `08`'s own testing
  needs** — if it doesn't, that's a real gap to close here, not to work around
  with a bare-host run against the real home.
- **A failed lock-acquire ("Daemon is already running...") from either binary
  during this harness's setup is a signal something is misconfigured** (the
  harness pointed at the real home instead of an isolated one) — treat it as a
  setup bug to fix, not a flake to retry past.

## Part-specific notes

- **This part is where the whole feature either proves itself or doesn't.** Every
  cross-part gap surfaced across `07a`/`07b`/`08`/`09` (missing `ServerEvent`
  variants, the `run_handoff_turn` timeout drift, the `DirectPtyRegistry` gap,
  etc. — see each part's `.sdlc-state.yaml` `process_note` for the full list)
  should be re-checked here: does the parity harness actually surface any of them
  as a real behavioral difference, or were they truly inert? Don't just re-read
  the list — run the harness and see.
- **The fork-path removal (resolved earlier this session, commit `d151c71` in
  `07a`) is F1's one deliberate, documented exception** — the parity harness
  should assert this route is genuinely gone (404 or 405, not silently present),
  not just skip testing it.
- **Lesson from `07a`'s two real gate failures:** the parity harness's own
  assertions need to be real comparisons, not `matches!()`-style checks that
  silently pass regardless of the actual diff. If the harness ever "passes" by
  discarding a comparison result instead of asserting on it, that's the same
  class of bug, just in test-infrastructure code instead of application tests.
