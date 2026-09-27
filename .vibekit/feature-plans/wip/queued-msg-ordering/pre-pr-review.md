# Pre-PR review — fix/queued-msg-ordering

Scope: squash hygiene, commit-message accuracy, scrutiny of the unreviewed dev-sandbox commit, and whether
the code builds and passes tests. Base `2fbcec1d`, commits `b717d1b2` (daemon), `cabde97b` (web-ui),
`8d437c9b` (dev-sandbox). I did not re-review the design.

## 1. Squash hygiene: clean

- `b717d1b2` touches only `rust/**` (vst-agents, vst-routes, vst-types) and
  `.vibekit/feature-plans/wip/queued-msg-ordering/**`.
- `cabde97b` touches only `web-ui/**` (4 files).
- `8d437c9b` touches only `scripts/dev-sandbox.sh`.
- No file appears in more than one commit.
- No conflict markers. `git diff --check 2fbcec1d..HEAD` is clean.
- All the dropped call sites line up with where the code moved to:
  - `enqueue` early-emit → `drain_loop`
  - `resubmit` superseding emit → removed
  - `release` → `cancel_all_pending_turns`
- The new `queued_turns` field is set at all 4 `SessionMeta` construction sites: `mod.rs`, `meta.rs`, and
  both sites in `sessions.rs`.
- The workspace builds, so no field is missing anywhere.
- The only untracked item is `.vibekit/reports/2026-09-27-queued-msg-ordering-verification/`. It was not
  committed; see S4.

## 2. Commit-message accuracy

- **`cabde97b` (web-ui): accurate.**
  - Covers the `queuedTurns` type, the `queuedTurnsMeta → transcript → optimistic` chain for both queued
    and held rows, the `MessageList.tsx` comment update, and the 2 new tests.
- **`b717d1b2` (daemon): accurate on behaviour.** Two small overstatements (S3):
  - It says "27 new/updated Rust tests across `vst-agents`/`vst-routes`".
    - The diff adds 14 test fns: 6 in `mod.rs`, 1 in `json_agent_meta.rs`, 7 in
      `json_agent_session_queue.rs`.
    - It also updates a few existing tests (`json_agent_stream.rs`, `json_agent_meta.rs`,
      `test_active_turn_id_lifecycle_and_notice_turn`).
    - vst-routes gets no test changes at all, only the `queued_turns: vec![]` field.
    - I could not reach 27.
  - It commits `.sdlc-state.yaml` and the plan and review docs. The message only mentions the plan. This is
    harmless, but see S4.
- **`8d437c9b` (dev-sandbox): one claim is false and one is overstated.**
  - It says the build writes "straight into `rust/target-docker/`". It doesn't. The container mounts
    `rust/` at `/work` with no `CARGO_TARGET_DIR`, so cargo writes into the host's **`rust/target/release/`**.
    The script then `cp`s the two binaries into `target-docker/release/`. See B1.
  - It says "this bug class can't recur regardless of host distro". But `agy-acp`, which is mounted into
    the same bookworm container, is still built on the host by `scripts/build-agy-acp.sh`. See S2.

## 3. dev-sandbox.sh (`8d437c9b`)

- `bash -n` passes. `set -euo pipefail` is on, so a failed `docker run` aborts cleanly.
- Quoting is fine.
- The `sed` extraction of `channel = "1.98.1"` from `rust-toolchain.toml` is correct, and it has an
  empty-value guard.
- The image tag `rust:1.98.1-bookworm` matches the `node:24-slim` (bookworm) base in `dev.Dockerfile`.
- The shared cargo-registry named volume is reasonable.
- Preferring release over debug is fine.

### BLOCKING

- **B1: the container build leaves root-owned files in the host's `rust/target/release/`.**
  - Confirmed in this worktree: `rust/target/release` and `rust/target/release/vst-daemon` are
    `root:root` (timestamp 01:22, from the verification run).
  - Consequences:
    - A later host `cargo build --release` (or `cargo clean`) in that checkout fails with permission
      denied, and fixing it needs `sudo`.
    - Host and container builds overwrite each other's fingerprints in the same target dir, so each side
      rebuilds after the other has run.
    - Bookworm binaries silently replace the host's own `target/release` output.
  - The commit message also describes this wrongly (see §2).
  - Minimal fix: give the container build its own target dir and give ownership back to the host user.
    Only the target dir needs the `chown`, because the registry volume is a docker named volume. For
    example:

    ```bash
    docker run --rm \
      -v "$(pwd)/rust:/work" -w /work \
      -e CARGO_TARGET_DIR=/work/target-docker/build \
      -v vst-dev-sandbox-cargo-registry:/usr/local/cargo/registry \
      "rust:${RUST_TOOLCHAIN_CHANNEL}-bookworm" \
      sh -c "cargo build --release -p vst-daemon -p vst-cli && chown -R $(id -u):$(id -g) /work/target-docker"
    mkdir -p ./rust/target-docker/release
    cp ./rust/target-docker/build/release/vst-daemon ./rust/target-docker/build/release/vst ./rust/target-docker/release/
    ```

    `rust/target-docker/` is already gitignored.
  - After fixing, run `sudo chown -R "$USER" rust/target` locally to recover this worktree.

### SUGGESTION

- **S1: stale binaries are never rebuilt, but the user is told they will be.**
  - The script only builds when no binary exists. Once `target-docker/release/vst-daemon` exists, it is
    reused forever, even after the Rust workspace changes.
  - Yet the echo says "one-time cost per host *until the Rust workspace changes*", which implies an
    automatic rebuild.
  - The old code behaved the same way, so this isn't a regression. Either fix the message or add a
    `--rebuild` flag / mtime check.
- **S2: `agy-acp` still has the same GLIBC problem.**
  - `scripts/build-agy-acp.sh` runs a host `cargo build`, and the output is bind-mounted into the same
    bookworm container.
  - On an Ubuntu 24.04 host, agy Rich Chat inside the sandbox will likely hit the same `GLIBC_2.39 not
    found` error.
  - Either route it through the same container build, or soften the commit message's "can't recur" claim.
- **S3: the script comment cites a memory note that isn't in the repo.**
  - It refers to a "dev-sandbox-glibc" project memory note, which lives outside the repo.
  - `BLOCKED.md` is a pre-existing, unrelated file from `54d55b04`.
  - Consider linking something a reviewer can actually open.

## 4. Build and test results (after the squash, at HEAD `8d437c9b`)

| Command | Result |
|---|---|
| `cargo build --workspace` | PASS |
| `cargo test -p vst-agents --lib` | PASS (11) |
| `cargo test -p vst-agents --test json_agent_session_queue` | PASS (18) |
| `cargo test -p vst-agents --test json_agent_meta` | PASS (9) |
| `cargo test -p vst-agents --test json_agent_stream` | PASS (3) |
| `cargo test -p vst-routes` | PASS on rerun (see note) |
| `web-ui: npx tsc --noEmit` | PASS |
| `web-ui: npx vitest run src/components/layout/ChatPane.test.tsx` | PASS (22) |

About the vst-routes result:

- On the first run, `tests/projects.rs::test_git_init_makes_project_usable_for_worktree_creation` failed
  once at `projects.rs:393`.
  - That run happened while other cargo test binaries and vitest were running at the same time.
  - Cargo stopped at that failure, so the later vst-routes test binaries did not run.
- It then passed alone, and in 2 full `--no-fail-fast` reruns: 0 failures, 219 passed, 5 ignored.
- Neither this test nor its file is touched by the branch.
- It is a flake unrelated to this change, not a squash regression. Worth a follow-up ticket, but it
  doesn't block this PR.

## Other suggestions (non-blocking)

- **S4:** The committed `.sdlc-state.yaml` contains an absolute worktree path
  (`/home/gb/.vibe-station/...`). Check that this matches repo convention for other features.
  Separately, `.vibekit/reports/2026-09-27-queued-msg-ordering-verification/` is still untracked. Either
  commit it with the plan docs or leave it out on purpose.
- **S5:** Fix the test count in the `b717d1b2` message ("27 … across vst-agents/vst-routes"). A reword is
  enough.

## VERDICT: NEEDS CHANGES

- The daemon and web-ui commits are clean, accurately described, and green. They are ready.
- The dev-sandbox commit needs one fix before the PR: B1, which leaves root-owned files in `rust/target`
  and is described wrongly in its commit message.
- Also correct its message on the `target-docker` claim, and ideally on the `agy-acp` "can't recur"
  claim (S2).
- Alternatively, drop `8d437c9b` from this PR and send it separately after the fix. It is unrelated to
  queued-message ordering.
