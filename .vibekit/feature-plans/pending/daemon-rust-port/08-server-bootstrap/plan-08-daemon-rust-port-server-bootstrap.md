# Phase brief: 08 — server-bootstrap

**Read first:** arch-daemon-rust-port.md — Part Breakdown row `08`, the `AppState`/handle
convention (part `00`), System Boundaries rows for the daemon bin, the `vst-types`
ownership rule (no new `Serialize`/`Deserialize` types in `08` — reuse `00`'s shapes).
**Skill:** load `rust-coding` before touching any .rs file.
**Crate(s):** rust/vst-daemon (bin)
**Depends on (already `done` at time of writing; `07b` must be `done` before dispatch):** 06, 07a, 07b

## Measured LOC — small, but this is the highest-INTEGRATION-RISK part of the whole port, not a "small = easy" part

```
264 daemon/src/server.ts     (Fastify app assembly: CORS, cookies, static, ALL route
                               registration, auth middleware, WS endpoint mount)
295 daemon/src/main.ts       (entry point: lock acquisition, port binding, config,
                               token minting, cloudflared/tailscale, pollers, env setup)
151 daemon/src/services/doctor.ts
710 total (arch doc's "~0.6k LOC + wiring" estimate was close this time)
```

**Why "small LOC" is misleading here:** `main.ts` and `server.ts` are the two files
that wire together *every other part's* output — every route from `07a`/`07b`, the
WS server from `06`, the lifecycle/PR pollers from `05`, storage from `01`, git from
`03`. A wiring bug here doesn't show up as a compile error in an isolated crate; it
shows up as a route being unreachable, a poller never starting, or auth middleware
silently not running — at runtime, in the final assembled binary. Treat this as
**one dispatch, reviewed with the most care of any part so far**, not split further
(splitting the wiring logic itself across dispatches would be riskier than keeping
it in one reviewable unit).

## Files to port

| Scope | Source LOC | Notes |
|---|---|---|
| `server.ts` → axum app assembly | 264 | CORS, cookies, static file serving, mounts every `07a`/`07b` route module + `06`'s WS endpoint, auth middleware (cookie/token verify via `06`... no, via `07b`'s ported `auth.rs`) |
| `main.ts` → binary entry point | 295 | See "Untracked dependencies" below — several of its imports have no confirmed Rust home yet |
| `services/doctor.ts` → `vst doctor` backing logic | 151 | Checks tmux/git/claude-cli-on-PATH etc — see `vst` skill's `vst doctor` reference |

## ⚠️ Untracked dependencies in `main.ts` — verified findings, re-check at dispatch time (this was verified once, but time may have passed)

`main.ts` imports from several TS modules. The arch doc's part `00` row claims
`daemonPort.ts` and `tunnelPort.ts` as part `00`'s scope ("config/paths ...
`daemonPort.ts`, `tunnelPort.ts` ..."), so on paper these should already be
ported — **direct verification found otherwise for one of them**:

- **`services/tunnelPort.ts` (`resolveTunnelPort`) — GENUINE GAP, not just
  "check first."** `vst-store` does have a `tunnel.rs`, but direct read confirms
  it ports a *different* TS file (`daemon/src/state/tunnel-store.ts` — a
  persisted cloudflared-tunnel-state row), not `services/tunnelPort.ts`. This
  looks like a real part-`00` scope item that never got ported. Flag it plainly
  in your report rather than silently porting it as new `08` scope without
  saying so — the arch doc's amendment/gap-reporting norm applies here too even
  though it's a bin crate, not a shared library.
- **`services/daemonPort.ts` (`setDaemonPort` mutable global) — likely NOT
  missing, just redesigned.** Every place that would have read the TS global
  now receives `daemon_port: u16` as an explicit constructor/function parameter
  instead (confirmed via `grep -rn "daemon_port"` across `vst-agents` — it's
  threaded through as a plain argument, dependency-injection style, which is
  the idiomatic Rust replacement for a mutable global). `main.ts`'s call to
  `setDaemonPort` after binding the port most likely just needs `08`'s own
  `AppState`/wiring code to store the bound port and pass it down to whatever
  needs it — this is probably local `vst-daemon` wiring, not a missing crate.
  Confirm this understanding before treating it as a gap.
- `state/project-store.ts` (`loadAll`) — likely already covered functionally by
  `vst-store`'s own load-on-init path (part `01`); this TS module may be a thin
  wrapper with no direct Rust counterpart needed at all. Not independently
  re-verified for this brief — check at dispatch time.
- `services/userSkillCatalog.ts` (`setSkillPaths`) — see AGENTS.md's "Three
  unrelated things named skill" section; this is the *user*-skill-directory
  scanner (distinct from the L1 system prompt asset and the `vst` repo skill).
  No Rust home found in a name-based search — may be a genuine unassigned
  file-map gap; not independently re-verified for this brief.
- `lib/resolveVstPaths.ts` (`setupVstEnvironment`, `patchShellConfigs`) — env/PATH
  and shell-rc setup at daemon startup. No Rust home found in a name-based
  search; not independently re-verified for this brief.
- `lib/harnessSkillDirs.ts` (`installHarnessSkillDirs`) — same as above, not
  independently re-verified for this brief.

**If any of these are genuinely unported:** port them as small satellite modules
inside `vst-daemon` (the bin crate) rather than inventing a new shared library
crate for a handful of small, single-consumer helpers — unless one of them turns
out to have meaningful logic other crates would also want, in which case flag it
as a real cross-part gap (same treatment `07a` gave several `vst-agents`/
`vst-lifecycle` findings) rather than silently absorbing it into `vst-daemon`.

## Checklist (Phase recipe steps 0-6 live in the arch doc — cite, do not restate them)
- [ ] 0. Load rust-coding skill
- [ ] 1. Read `server.ts`, `main.ts`, `services/doctor.ts` in full, plus every
        "untracked dependency" TS file above to determine if it's already ported
- [ ] 2. Write the behavior contract (bullets) — separately for server assembly
        vs. main entry point vs. doctor
- [ ] 3. Write Rust tests first; `git commit -m "test(08): behavior contract"`
        (a combined test+impl commit is acceptable if tests need the full
        binary/AppState to compile — the norm for every dispatch so far)
- [ ] 4. Implement (this crate only; vst-types amendment rule if needed; never
        touch rust/Cargo.toml's [workspace] table, [profile.release], or the CI
        workflow — N6)
- [ ] 5. Run rust/scripts/rust-gate.sh vst-daemon; save log to rust/.gate/08.log; commit
- [ ] 6. Report: what's ported, what's `#[ignore]`d + why, any vst-types amendments,
        AND explicitly list which "untracked dependency" files from the section
        above were found already-ported vs. genuinely ported fresh here vs.
        flagged as a gap — STOP

## Part-specific notes

- **Lesson from `07a`'s two real gate failures (both caught only by directly
  reading test code, not by "gate green" alone):** one dispatch shipped zero
  coverage on a flagged handler, another had `matches!(err, Variant)` checks
  silently missing their `assert!()` wrapper. Every route/handler ported here
  needs real, `assert!()`-wrapped tests — self-grep your own new test file(s)
  for bare `matches!(` before committing.
- **Auth middleware wiring is security-sensitive** (same class of risk as
  `07b`'s HMAC comparison) — `server.ts`'s cookie/token verification on every
  request must actually run before route handlers, not be bypassable. Write a
  test proving an unauthenticated/tampered-token request is rejected by the
  assembled app, not just that `verify_token()` itself works in isolation.
- **Port binding retry** (`findFreePort`, tries `start` to `start+99`) is a
  bounded loop already (100 iterations max) — port it as a bounded loop in Rust
  too, don't accidentally make it unbounded.
- **Lock file handling** (`acquireLock`) checks whether a PID inside an existing
  lock file is still alive — get the process-liveness check right for Rust
  (`vst-proc`, part `02`, may already have a helper for this; check before
  reimplementing).
- **⚠️ NEVER run the built `vst-daemon` binary bare against the real
  `~/.vibe-station` home while testing this part** — that's the user's own live
  daemon's home (shared across every worktree, not per-branch). There is
  currently no home-directory override in the TS original (`VST_HOME` is
  hardcoded; only `VST_PORT` is overridable) — if this part's own testing needs
  one, design and add it explicitly as part of this part's scope, don't assume
  it exists. Prefer the sanctioned isolated path (`scripts/dev-sandbox.sh` /
  `docker-compose.dev.yml`, see `AGENTS.md`'s "Docker dev sandboxes" section)
  for any real "run the binary" verification. If a bare-host run against the
  real home ever happens by accident, the daemon's own PID-liveness check in
  `acquireLock()` will fail loud ("Daemon is already running...") rather than
  corrupting or replacing the live one — that error is the correct, safe
  outcome, not something to work around by force.
