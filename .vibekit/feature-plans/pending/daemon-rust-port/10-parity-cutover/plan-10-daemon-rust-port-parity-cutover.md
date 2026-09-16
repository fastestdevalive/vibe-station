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

Per `ORCHESTRATION-PROMPT.md`'s Stop Conditions: **do NOT run this part's deletion
of the old TS `daemon/`+`cli/` trees without explicit human confirmation first.**
That step is destructive and irreversible on this branch. Every other task below
can proceed through the normal dispatch/gate loop; the deletion step is the one
exception that must pause for an explicit go-ahead, dispatched separately from
everything else in this part if needed.

## Task breakdown (dispatch order — each is independently gateable)

| # | Task | What "gate" means here |
|---|---|---|
| 1 | **Black-box parity harness**: run the old Node daemon and the new Rust daemon side-by-side against the same request fixtures (reuse `vst-testkit`'s fixtures from part `00` where possible), diff every response byte-for-byte except the one documented F1 exception (fork path). | A test suite that actually runs both binaries and asserts equality — not just "the Rust daemon's own tests pass," which every prior part already covers. This is the first point in the whole feature where the two implementations are compared directly against each other. |
| 2 | **Regression tests for every documented concurrency bug** (F3): double-echo (Terminal invariant, AGENTS.md), ghost PTY streams (`withSessionLock` serialization, part `06`), status-writer races (two-axis lifecycle/PR model, part `05`). Confirm each already has *some* test coverage from its owning part; if a genuine regression test for the exact historical bug is missing, add it here rather than assuming an ordinary unit test from that part covers the specific race. | Each of the 3 documented bug classes has a named, traceable regression test — not just "tests pass" in general. |
| 3 | **SQLite schema compatibility** (F4): verify the Rust daemon can open and correctly read a DB file written by the current Node daemon, without a migration step silently corrupting or dropping data. | A fixture DB captured from the real Node daemon, opened and read correctly by the Rust one. |
| 4 | **N1/N2 baseline measurement**: measure the current Node daemon's `@yao-pkg/pkg`-packaged binary size and cold-start time (the arch doc says this baseline is measured *in this part* — it doesn't exist yet), then measure the Rust binary's equivalents and confirm N1 (smaller)/N2 (faster cold start) actually hold. | Numbers in the report, not just "it feels faster." If either regresses, that's a real finding to surface, not to quietly pass over. |
| 5 | **Update `scripts/dev-sandbox.sh`, `docker-compose.dev.yml`, root `package.json` build scripts** to build/run the Rust binaries instead of (or alongside, during transition) the Node ones. Cross-reference the "Docker dev sandboxes" section of `AGENTS.md` — don't reintroduce the seed-mode-volume-corruption hazard documented there while touching these scripts. | The dev sandbox actually boots against the Rust daemon and behaves per the demo dataset expectations already documented in `AGENTS.md`. |
| 6 | **⚠️ STOP — do not proceed without explicit human confirmation.** Delete the old TS `daemon/`+`cli/` trees. The Rust binaries (`rust/vst-daemon`+`rust/vst-cli`) are unaffected by this deletion — confirm they build and run standalone (not accidentally depending on anything under the trees being deleted) before deleting. | A human said "yes, delete it" — not an assumption inferred from "all tasks above passed." |

## Checklist (Phase recipe steps 0-6 in the arch doc don't map cleanly onto this part — adapted below)
- [ ] 0. Load rust-coding skill (for harness/fixture code)
- [ ] 1. Read F1-F4, N1-N2, and AGENTS.md's documented concurrency-bug sections in full
- [ ] 2. Write the behavior contract for the parity harness specifically (what
        counts as "byte-compatible," what the one deliberate exception covers)
- [ ] 3. Build the parity harness + regression tests first, against BOTH binaries
        actually running — `git commit -m "test(10): parity harness + regression suite"`
- [ ] 4. Implement any glue/script changes (task 5); N6 still applies if anything
        under `rust/` is touched, though most of this part's work is outside `rust/`
- [ ] 5. Run the full harness; save results (parity diffs, N1/N2 numbers, regression
        test results) to a report file, not just a pass/fail; commit
- [ ] 6. Report: parity results, N1/N2 numbers, any real divergence found (including
        the expected fork-path one) — STOP before task #6's deletion, always

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
