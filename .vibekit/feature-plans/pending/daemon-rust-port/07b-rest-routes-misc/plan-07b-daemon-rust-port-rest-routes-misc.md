# Phase brief: 07b — rest-routes-misc

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `07b`, Entities & Modules
row(s) for `vst-routes`, System Boundaries rows on REST + `vst-types::rest`, the
`vst-types` ownership rule (no new `Serialize`/`Deserialize` types in `07b`).
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-routes
**Depends on (already `done`):** 00, 01, 05

## Measured LOC (arch doc's ~3.5k estimate is stale — verify your own numbers too, `07a`'s was off by ~2.5k)

```
  68 daemon/src/routes/settings.ts
  23 daemon/src/routes/skills.ts
 156 daemon/src/routes/fs.ts
 236 daemon/src/routes/attachments.ts
 103 daemon/src/routes/auth.ts
 349 daemon/src/routes/mobileAuth.ts
  13 daemon/src/routes/health.ts
  77 daemon/src/routes/tailscale.ts
  48 daemon/src/routes/orderedLists.ts
 156 daemon/src/auth.ts
 102 daemon/src/state/auth-state.ts
1331 total
```

Much smaller than `07a` — no single file exceeds ~350 lines. Pre-split into 2
dispatches below by risk profile, not by size (both are well under the ~800-1000
line/continuation budget on their own).

**Note:** `routes/open.ts` appears in this feature's top-level checklist bullet
(line 30 of `ORCHESTRATION-PROMPT.md`'s sibling doc) but the authoritative Part
Breakdown table row for `07b` does NOT list it — `open.ts` was already ported and
gated as part of `07a` (dispatch #8, commit `306b6a0`). Don't re-port it; the
checklist bullet's mention is stale.

## Files to port — dispatch order

| # | Scope | Source LOC | Risk | Notes |
|---|---|---|---|---|
| 1 | Low-risk utility routes: `settings.ts`, `skills.ts`, `fs.ts`, `attachments.ts`, `orderedLists.ts`, `health.ts` | 544 | Low | Straightforward CRUD/read routes, no auth/crypto surface. |
| 2 | **Auth-critical:** `routes/auth.ts`, `routes/mobileAuth.ts`, `routes/tailscale.ts`, `daemon/src/auth.ts` (token mint/verify), `daemon/src/state/auth-state.ts` | 787 | **High — security-sensitive** | See below. |

## ⚠️ Dispatch #2 is security-sensitive — read `daemon/src/auth.ts` before writing any Rust

- **`daemon/src/auth.ts` implements HMAC-SHA256 token mint/verify with `timingSafeEqual`
  for the signature comparison.** This is a genuine timing-attack mitigation, not
  incidental code — a naive Rust port that compares the computed vs. provided HMAC
  digest with `==` (which short-circuits on the first mismatched byte) **reintroduces
  a real timing side-channel vulnerability**, even though the port would still pass
  every functional test. Use a constant-time comparison in Rust (e.g. the `subtle`
  crate's `ConstantTimeEq`, or `ring`'s HMAC verify which is constant-time by
  construction — do not roll your own byte-loop "constant time" compare, that's a
  well-known way to get it subtly wrong). No crypto crate is in the workspace yet —
  adding one is a `vst-routes`-local `Cargo.toml` dependency, not a workspace-level
  change (N6 is about `[workspace.dependencies]`/`[profile.release]`/CI, not
  crate-local deps — see `04c`'s `tokio-util` N6 correction for the exact boundary).
- **Token format is `<base64url(JSON(payload))>.<HMAC-SHA256-hex>`.** Preserve this
  exact wire format — CLI/Tauri/browser clients all parse it, and `09-cli-port`
  will need to produce/consume the identical format.
- **Three token flavors, different lifetimes:** CLI and Tauri tokens have no expiry
  and no epoch; browser tokens carry `exp` (7-day TTL) and `epoch` (a revocation
  counter) — get the conditional serialization right (check `vst-types::rest::auth`
  and `::mobile_auth` for what's already scaffolded by part 00; if a shape is
  genuinely missing, use the `vst-types` amendment rule, don't define locally).
- **`mobileAuth.ts`'s rate limiter** (max 20 attempts/minute per `CF-Connecting-IP`)
  and its `setInterval`-based stale-code janitor (60s cleanup of one-time codes
  older than 60s) are in-process background bookkeeping, not an external-event
  poll loop — port the janitor as a `tokio::spawn` + `tokio::time::interval` task,
  not as a `rust-coding` skill §9 bounded-retry pattern (that section is about
  waiting *for* an external event with a timeout; this is a periodic housekeeping
  task with no caller waiting on it).
- **Never log or include a token/HMAC digest in an error message or panic.**

## vst-types check before any amendment

`07b` is forbidden from defining any `#[derive(Serialize, Deserialize)]` type per
the arch doc's `vst-types` ownership rule. `vst-types::rest::auth` and `::mobile_auth`
already exist (scaffolded by part `00`) — check there first. If a shape is genuinely
missing, follow the amendment rule (add to `vst-types`, never define locally in
`vst-routes`) — dispatch `07a-6` set a clean precedent for this (`FileListResult`,
a correctly-placed 9-line addition).

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [ ] 0. Load rust-coding skill
- [ ] 1. Read the files above + Gotchas rows + `daemon/src/auth.ts` in full for dispatch #2
- [ ] 2. Write the behavior contract (bullets) — per dispatch row above
- [ ] 3. Write Rust tests first; `git commit -m "test(07b-N): <scope> behavior contract"`
        where N is the dispatch # from the table (a combined test+impl commit is
        acceptable if tests need the full API to compile — this has been the norm
        for every `07a` dispatch, disclose either way)
- [ ] 4. Implement (this crate only; vst-types amendment rule if needed; never touch
        rust/Cargo.toml's [workspace] table, [profile.release], or the CI workflow — N6)
- [ ] 5. Run rust/scripts/rust-gate.sh vst-routes; save log to rust/.gate/07b-N.log; commit
- [ ] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments,
        and for dispatch #2 SPECIFICALLY confirm in the report which constant-time
        comparison primitive was used and where — STOP
- [ ] Repeat 0-6 for both dispatch rows above, in order, before closing out `07b`

## Part-specific notes

- **Lesson from `07a`'s two real gate failures (both caught only by directly reading
  test code, not by "gate green" alone):** dispatch `07a-6` shipped with zero test
  coverage on its flagged highest-risk handler; dispatch `07a-7` had 17 `matches!(err,
  Variant)` checks silently missing their `assert!()` wrapper (the boolean result was
  discarded, so the checks were no-ops that clippy couldn't catch). **Every dispatch
  in this part must include real, `assert!()`-wrapped tests for every route it ports**,
  and should self-grep its own new test file(s) for bare `matches!(` before committing.
  For dispatch #2 specifically, a real test should verify that a tampered/wrong-signature
  token is rejected — not just that a correct one is accepted.
- **`tailscale.ts` (routes) is distinct from `tailscaleServe.ts` (already ported in
  part `05`, done)** — the route file here likely calls into part 05's already-ported
  service layer rather than reimplementing tailscale logic. Confirm this via a quick
  read before assuming route-layer-only scope; if real business logic is found that
  duplicates part 05's work, flag it as a cross-part gap (same treatment `07a`'s
  dispatches gave several `vst-agents`/`vst-lifecycle` gaps) rather than reimplementing.

## Closed out — dispatch #1 (low-risk utility routes) complete (2026-09-15)

- Commit `e735d36` (`feat(07b-1)`) — clean first try, no gate failure.
- Explicitly briefed on `07a`'s two failure modes upfront; correctly self-checked —
  all `matches!()` occurrences confirmed `assert!()`-wrapped on direct read (an
  automated line-scan flagged 14 false positives from same-line `assert!(matches!(...))`
  calls; manually verified each is genuinely correct).
- Gate re-verified independently. N6 clean. No `vst-types` amendments.
- 6 route files ported (health, ordered_lists, settings, skills, fs, attachments,
  1016 LOC), one real test function per file, 101 assertions total.

## Closed out — dispatch #2 (auth-critical) complete (2026-09-15)

**Most rigorously reviewed dispatch of the whole feature so far.**

- Commit `c615154` (`feat(07b-2)`) — clean first try, no gate failure.
- The constant-time HMAC comparison claim was independently verified, not taken
  on the report's word: directly read `auth.rs:196-233` — `verify_token`
  recomputes the HMAC via `ring::hmac::sign`, hex-decodes both signatures into
  fixed-length byte buffers, compares with `subtle::ConstantTimeEq::ct_eq()`.
  Genuinely constant-time.
- Directly read `test_token_constant_time_rejects_tampered_signature` — mints a
  real valid token, flips one signature byte, confirms rejection; also tests
  truncated and non-hex signatures.
- `mobile_auth`'s stale-code janitor correctly uses `tokio::spawn` +
  `tokio::time::interval(60s)`, per the brief's explicit instruction.
- Gate re-verified independently, green. N6 clean — `ring`/`subtle`/`base64`
  added crate-locally only. Zero bare `matches!()`. No `vst-types` amendments.
- Full transcript audited for daemon-touching commands — none found.

# ============================================================
# 07B-REST-ROUTES-MISC — PART COMPLETE
# ============================================================

Both dispatches clean first try, 0 gate failures, 0 escalations:

| # | Scope | Result |
|---|---|---|
| 1 | Low-risk utility routes (1016 LOC) | clean first try |
| 2 | Auth-critical (787 LOC, HMAC token mint/verify) | clean first try — most rigorous review |

**1,803 LOC ported total, both on `agy-medium`.** No cross-part gaps surfaced
this part (unlike `07a`'s several). Real security property verified by direct
code read: constant-time HMAC comparison, confirmed correct.

**Next:** `08-server-bootstrap` — its phase brief is already pre-written and
flags it as the highest integration-risk part so far. `09-cli-port` dispatch #1
is running in parallel per the user-directed one-off exception.
