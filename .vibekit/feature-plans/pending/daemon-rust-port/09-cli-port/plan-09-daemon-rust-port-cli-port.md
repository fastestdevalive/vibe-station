# Phase brief: 09 — cli-port

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `09`, the `vst-types`
ownership rule (no new `Serialize`/`Deserialize` types — the CLI consumes `vst-types`'s
REST/WS shapes, it never defines its own wire types), F2 ("drop-in replacement — same
subcommands, same flags, same output format where scripted/parsed").
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-cli (bin)
**Depends on (per arch doc):** `00` for the frozen contract (unit tests can compile
against `vst-types` alone from `00` onward); **integration tests need `08` running**.
Per this feature's strict-serial dispatch order, `09` is still dispatched only after
`08` closes out — the arch doc's dependency table is necessary-condition, not
license to jump the queue.

## Measured LOC — 44 files, none individually large, good candidate for splitting by command group

```
2438 total across 44 files (excluding *.test.ts)
 201 cli/src/commands/doctor.ts        (largest single file)
 180 cli/src/lib/sendMessage.ts
 136 cli/src/commands/project/create.ts
 129 cli/src/commands/summary.ts
 128 cli/src/program.ts
 118 cli/src/commands/open.ts
 113 cli/src/commands/session/create.ts
 102 cli/src/commands/worktree/create.ts
  86 cli/src/lib/daemon-client.ts
  ... (remaining files all <70 lines each)
```

By directory:
```
473  cli/src/lib/*             (9 files: daemon-client, sendMessage, output,
                                 text-source, daemon-url, and others — the shared
                                 plumbing every command uses)
137  cli/src/*.ts               (program.ts — the commander.js entrypoint/registration)
570  cli/src/commands/session/* (13 files)
502  cli/src/commands/*.ts      (4 top-level: doctor.ts, summary.ts, open.ts, status.ts... wait status.ts is under daemon/, verify)
289  cli/src/commands/worktree/* (6 files)
284  cli/src/commands/project/*  (5 files)
117  cli/src/commands/mode/*     (3 files)
 23  cli/src/commands/file/*     (1 file: open.ts)
 43  cli/src/commands/daemon/*   (1 file: status.ts)
```

(Re-measure at actual dispatch time — arch doc estimated ~3.6k for this part;
measured is 2438, meaningfully lower. If the gap is from `.test.ts` files or a
subdirectory that's moved since this brief was written, re-verify rather than
trusting either number.)

Confirmed by direct check (not left as an open question): `commands/status.ts`
(top-level, 54 LOC) and `commands/daemon/status.ts` (43 LOC) are two genuinely
distinct commands, not a duplicate path — verify what each actually does
(`vst status` vs. `vst daemon status`) rather than assuming redundancy.

## Proposed dispatch split (verify against re-measured LOC before committing to this exact split)

| # | Scope | Approx LOC | Notes |
|---|---|---|---|
| 1 | Core plumbing: `cli/src/lib/*` (daemon-client, sendMessage, output, daemon-url, text-source, etc.) + `cli/src/program.ts` (commander.js entrypoint/registration) | ~610 | Everything else depends on this — dispatch first. `sendMessage.ts` (180 lines) is the biggest single file here; it's almost certainly the WS-client "steer a running turn" logic this feature's `vst session send` skill doc describes — read carefully, it's user-facing behavior other parts (this session's own orchestration!) actively depends on. |
| 2 | `commands/session/*` (13 files, 570 LOC) + `commands/mode/*` (3 files, 117 LOC) | ~687 | Session lifecycle commands (`create`, `reset`, `transcript`, `info`, etc.) — largest command group. |
| 3 | `commands/worktree/*` (6 files, 289) + `commands/project/*` (5 files, 284) + `commands/file/open.ts` (23) + `commands/daemon/status.ts` (43) | ~640 | |
| 4 | Top-level standalone commands: `commands/doctor.ts` (201, CLI-side checks — see note below on its relationship to `08`'s `services/doctor.ts`), `commands/summary.ts` (129), `commands/open.ts` (118, top-level `vst open` — distinct from `commands/file/open.ts` above, verify what each actually does before assuming redundancy), `commands/status.ts` (54, top-level `vst status` — distinct from `commands/daemon/status.ts` in dispatch #3, confirmed as two genuinely separate commands, not a path error) | ~500 | |

4 dispatches, none over ~700 LOC — well within a single continuation's budget each.
**This split is provisional** — re-verify the `status.ts` path ambiguity and the
exact per-directory counts against the actual tree before writing the real dispatch
prompts (this sizing pass was done ahead of time to save a step later, per the
user's request, not as a final locked plan).

## vst-types check before any amendment

`09` is forbidden from defining any new wire type — it's a pure consumer of
`vst-types::rest::*` and `vst-types::ws::*`. If a CLI command needs a shape that
doesn't exist, that's very likely a sign the corresponding REST/WS handler was
never actually wired to accept/return it — flag as a cross-part gap against the
relevant earlier part, don't invent a CLI-local type to paper over it.

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [ ] 0. Load rust-coding skill
- [ ] 1. Read the files for this dispatch's scope + re-verify LOC/split against
        the provisional table above
- [ ] 2. Write the behavior contract (bullets)
- [ ] 3. Write Rust tests first; `git commit -m "test(09-N): <scope> behavior contract"`
        (combined test+impl acceptable if tests need the full command tree to
        compile — the norm for every dispatch so far)
- [ ] 4. Implement (this crate only; vst-types amendment rule if needed — should
        rarely if ever apply here; never touch rust/Cargo.toml's [workspace]
        table, [profile.release], or the CI workflow — N6)
- [ ] 5. Run rust/scripts/rust-gate.sh vst-cli; save log to rust/.gate/09-N.log; commit
- [ ] 6. Report: what's ported, what's `#[ignore]`d + why (note: integration
        tests against a live daemon need `08`'s binary — these should be
        `#[ignore]`-gated behind an env var, not skipped silently), any
        cross-part gaps found — STOP
- [ ] Repeat 0-6 for each dispatch row above, in order, before closing out `09`

## Part-specific notes

- **F2's "same output format where scripted/parsed" is the load-bearing
  requirement here** — this feature's own orchestration process (this very
  document, `ORCHESTRATION-PROMPT.md`) parses `vst session info --json`,
  `vst mode ls --json`, `vst worktree info --json` output structurally (`jq`
  queries throughout). A Rust CLI port that changes JSON key names/shapes even
  slightly would silently break every future orchestration session's ability to
  drive `vst` itself — treat this feature's own usage patterns as a de facto
  compatibility test, not just the formal test suite.
- **Lesson from `07a`'s two real gate failures:** every command ported here
  needs real, `assert!()`-wrapped tests, self-checked for bare `matches!(`
  before committing.
- **`commands/doctor.ts` (this part) vs. `services/doctor.ts` (part `08`) are NOT
  a simple thin-wrapper split** — confirmed by direct read: `commands/doctor.ts`
  does its own client-side `execFile`/`execSync` checks (e.g. tailscale status via
  `getDaemonUrl`) rather than purely proxying to a daemon endpoint, while
  `services/doctor.ts` does server-side checks that need daemon-resident state
  (orphan tmux sessions cross-referenced against the project manifest, orphan
  worktree dirs). Read both files fully before porting either — don't assume one
  calls the other without checking, and don't duplicate the tmux-on-PATH /
  git-version checks if both files independently do them (verify which one is
  authoritative for shared checks, matching this feature's habit of flagging
  "same logic in two files" as a real risk signal, not assuming it's fine).

## Closed out — dispatches #1-3 complete; #4 remaining

- **#1** (core plumbing) — `2bd35fd`, clean, agy-medium.
- **#2** (session+mode commands) — `450244f`, clean, agy-medium (survived a
  workspace-wide-fmt false-positive from concurrent `08` work — verified
  crate-scoped instead of trusting the raw gate output).
- **#3** (worktree/project/file/daemon commands) — `f2c7bff`. Started on
  agy-medium, hit an account-wide quota exhaustion across the ENTIRE fallback
  chain (agy-medium → gpt-oss-120b-medium → claude-sonnet-4-6 →
  claude-opus-4-6-thinking, all same reset window) alongside `08` hitting the
  identical wall simultaneously. Per user direction, finished on `DeepSeek`
  instead — a fresh session picked up the already-complete, uncommitted work
  left on disk (never re-ported), reviewed it for real completeness, made one
  good independent call (deliberately did NOT commit `rust/Cargo.lock` since
  its diff belonged entirely to `08`'s in-progress, uncommitted work), and
  committed cleanly. Independently re-verified: crate-scoped fmt/clippy/test
  all clean, N6 clean, zero `matches!()` in the new tests (not just zero
  unwrapped), spot-read `worktree/create.rs` — real, complete port.
- **#4** (top-level standalone commands: doctor/summary/open/status,
  ~500 LOC) — `c96a202`, clean, DeepSeek. Confirmed `doctor.ts` is NOT a
  thin wrapper around `08`'s `services/doctor.ts` (has its own subprocess
  checks). `status.ts`'s `LifecycleState` idle/running/error mismatch
  documented in a doc comment as instructed.

# ============================================================
# 09-CLI-PORT — PART COMPLETE
# ============================================================

All 4 dispatches done and independently gated. **Zero code-quality gate
failures** across the whole part (unlike `07a`'s 2 and `07b`'s 0-but-close) —
the only real incident was dispatch #3 hitting agy's account-wide quota
exhaustion across its entire fallback chain, an infrastructure/availability
problem, not a code problem, resolved by a user-directed DeepSeek pickup of
the already-complete uncommitted work (no re-porting needed).

2,438 LOC across 44 TS files ported into `vst-cli`, 104 tests, no cross-part
gaps surfaced, no daemon-touching commands found in any dispatch's transcript.

**Next:** `10-parity-cutover` — the only remaining part of the whole feature.

