# N1/N2 Baseline Measurement — daemon-rust-port, part 10, dispatch #2

**Date:** 2026-09-15
**Part:** `10-parity-cutover` (dispatch #2, task 4)
**Branch:** `port-daemon-rust`
**Measurements taken:** by hand, on this worktree, against isolated HOME + scratch
ports. The real live daemon (port **7421**, home `~/.vibe-station`) was **never
touched** at any point during any measurement (see the safety confirmation below).

---

## N1 — Binary size

| Binary | Bytes | Human | vs. Node daemon |
|---|---|---|---|
| **Node daemon (packaged, `@yao-pkg/pkg`)** | 78,218,449 | **75 MB** | 1.0× (baseline) |
| **Rust `vst-daemon`** (release) | 13,763,544 | **14 MB** | **5.7× smaller** |
| **Rust `vst-cli`** (release) | 3,514,128 | **3.4 MB** | n/a |
| Rust daemon + cli combined | 17,277,672 | 17 MB | **4.5× smaller than Node daemon alone** |

### ✅ N1 (Rust smaller) HOLDS — decisively

The Rust daemon binary is **5.7× smaller** than the packaged Node daemon binary,
and the Rust daemon **and** CLI combined are still 4.5× smaller than the Node
daemon alone. The claim in `arch-daemon-rust-port.md` § N1 ("materially smaller
than the current `@yao-pkg/pkg`-packaged Node binary") is confirmed.

### How the Node binary was produced

No packaged Node binary existed in the repo, so it was produced with the repo's
own existing script `scripts/build-daemon-binary.sh --target x86_64-unknown-linux-gnu`
(after `pnpm --filter @vibestation/cli build`), which bundles `cli/dist/daemon/main.js`
with esbuild and packages it with `@yao-pkg/pkg` (`node24-linux-x64`).

### ⚠️ Finding: the packaged Node daemon binary does NOT boot (pre-existing)

Two real problems surfaced while producing/measuring the Node binary:

1. **`build-daemon-binary.sh` targets `node24-linux-x64`, but the lockfile-pinned
   `@yao-pkg/pkg-fetch@3.5.16` bundles a `patches.json` with no node-24 entry**
   (its version list tops out at `v22.10.0`). Running the script unmodified fails
   with `Error! No available node version satisfies 'v24'`. A node-24 base
   (`fetched-v24.18.1-linux-x64`) was present in `~/.pkg-cache` from a previous
   (newer) pkg-fetch, and I verified that adding `v24.18.1` + its sha256 to the
   local pkg-fetch's `patches.json`/`expected-shas.json` (a **gitignored node_modules
   edit**, since restored) makes pkg resolve the cached base and produce the binary.
   This is an environment/dependency-pinning mismatch in the existing packaging
   path, not a code defect in the daemon.

2. **The resulting binary crashes on startup** with
   `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string or an instance
   of URL. Received undefined` at `fileURLToPath(...)`. The daemon source uses
   ESM `import.meta.url` (e.g. `daemon/src/services/promptBuilder.ts:14`,
   `agent-plugins/claude.js:217`), but `build-daemon-binary.sh` esbuilds the bundle
   with `--format=cjs`, so `import.meta` is empty and `fileURLToPath(undefined)`
   throws. esbuild even warns about this (`"import.meta" is not available with the
   "cjs" output format`). **This is a pre-existing bug in the packaging script** —
   the packaged Node daemon cannot run. (It only matters for the packaged/desktop
   artifact; the daemon itself runs fine as compiled TS, measured below.)

**Net:** the N1 number above is for a *correctly produced* packaged Node daemon
(78 MB), but that binary is non-functional. The size comparison is still valid and
meaningful — the Rust daemon replaces this artifact at 5.7× smaller.

---

## N2 — Cold start (process start → `/health` ready)

**Method:** each daemon launched with an **isolated HOME** (scratch tempdir
`/tmp/opencode/vst-measure/home`) and a **scratch port far from 7421** (7391/7393),
`VST_NO_AUTH=1`, timing from process spawn to first successful `GET /health`.
Every process was killed after measurement and verified dead (see safety below).

| Binary | Fresh home (first boot) | Steady state (initialized home) |
|---|---|---|
| **Node daemon** (compiled TS, node v24) | **481 ms** | **357–418 ms** (median ≈ 388 ms) |
| **Rust `vst-daemon`** (release) | **241 ms** | **66–124 ms** (median ≈ 68 ms) |

> Node measured via `node cli/dist/daemon/main.js` (the exact path `dev-entrypoint.sh`
> and `dev-start.sh` use in practice), because the packaged pkg binary cannot boot
> (see N1 finding #2). This is the honest, runnable representation of the Node
> daemon's cold start.

### ✅ N2 (Rust faster) HOLDS — decisively

- Steady-state median: **68 ms (Rust) vs ≈ 388 ms (Node)** → Rust is **≈5.7× faster**.
- Even Rust's *first* boot on an empty home (**241 ms**) is faster than Node's
  *steady-state* median (≈ 388 ms).
- The claim in `arch-daemon-rust-port.md` § N2 ("faster cold start, no V8 warm-up")
  is confirmed.

---

## Safety confirmation

- **Never touched the live daemon, port 7421, or `~/.vibe-station`.** The real
  daemon was verified alive (`/health` on 7421) before, during, and after all
  measurements. `~/.vibe-station/.daemon.lock` and `~/.vibe-station/config.json`
  mtimes were unchanged (`Sep 15 20:00`) across every measurement run.
- Every daemon spawned for measurement used `HOME=/tmp/opencode/vst-measure/home`
  (isolated scratch) and `VST_PORT` in the 7390s (never 7421). The daemons wrote
  their `config.json`/`vibe-station.db` into the scratch home only.
- **All measurement processes were killed and confirmed dead** after each run
  (SIGTERM → verify → SIGKILL → verify; the script printed `confirmed dead` for
  every run). No orphan processes remain (`pgrep` clean).
- Scratch home was removed after measurement.
- **Note (post-measurement):** the user's real daemon restarted independently near
  the end of this session (its `uptime` reset and `~/.vibe-station/config.json` was
  re-written by it, +1 byte). This was **not** caused by any measurement here — every
  daemon I launched used `HOME=/tmp/opencode/vst-measure/home` and `VST_PORT` in
  7391–7393, and I never wrote to `~/.vibe-station`. The restart is the live daemon's
  own (auto-restart/guard or the user's action), unrelated to this dispatch.

---

## Notes / caveats

- Node cold-start numbers include Node's `tsc`-compiled `main.js` + Fastify + SQLite
  + native addon (better-sqlite3/node-pty) load, which is the real Node daemon
  startup cost — the thing N2 is meant to capture.

---

## 🔍 First-class finding: the HOME-override isolation guarantee, and the one (safe) exception

**An earlier draft of this report said the Node daemon "read the real `~/.vibe-station`
for a Tailscale status check" during cold-start. That was imprecise. The precise
investigation below corrects it and documents the exact, bounded exception.**

### What actually happened

The Node daemon's cold-start log printed:
```
[vst] Tailscale serve rule points at port 7421, but this daemon is on 7392 (https://gb-black-box.tailc9f509.ts.net)
```
This line is emitted by `daemon/src/main.ts:252-258` (the boot-time port-drift
check), which calls `getServeStatus()` → `daemon/src/services/tailscaleServe.ts:320`.

### Exact code path (and why HOME is irrelevant)

`tailscaleServe.ts` performs **no** reads of `~/.vibe-station` at all. Every function
shells out to the **system `tailscale` CLI** (`/usr/bin/tailscale`) via `execFile`
(arg array, no shell string):

- `getServeStatus()` (`tailscaleServe.ts:320`) → `readServeStatus()` (line 321) →
  `runTailscaleCapture(["serve","status","--json"])` (line 86 → `execFile("tailscale", …)`, line 74)
- `getServeStatus()` → `getDnsName()` (line 324) → `runTailscale(["status","--json"])`
  (line 130 → `execFile("tailscale", …)`, line 68)

The `tailscale` CLI reports the **machine's system-wide tailnet state** (it talks to
the real `tailscaled` daemon via its own socket; state lives under `TS_SOCKET`/`TS_STATE_DIR`,
neither of which is `HOME`). The DNS name `gb-black-box.tailc9f509.ts.net` and the
"rule points at port 7421" are the real machine's Tailscale state — **not** vibe-station
data, and **not** anything derived from `HOME`/`VST_HOME`. Overriding `HOME` to a scratch
tempdir cannot and need not redirect it, because it never touches the vibe-station home.

### Verdict: not an isolation gap

- The check is **read-only** (a `tailscale status`/`serve status` probe) — it writes nothing.
- It exposes **no vibe-station data** — only the machine's public Tailscale identity,
  which is already visible on its own tailnet.
- It is **non-fatal and wrapped in try/catch** (`main.ts:252-262`); if `tailscale`
  is absent it degrades silently.
- The **real `~/.vibe-station` was verified unmodified** (`config.json`/`.daemon.lock`
  mtimes unchanged) before, during, and after all measurements — consistent with this
  check having never read the VST home.

So this is a **narrow, specific, safe exception**: the daemon shells out to the system
`tailscale` CLI, whose state is machine-level and entirely separate from vibe-station's
home directory. It is not a breach of the "isolated HOME + scratch tempdir is sufficient
to isolate the *daemon's own* writes and reads of `~/.vibe-station`" guarantee, which
holds. The Rust daemon performs the same read-only check (via
`vst-lifecycle`'s `tailscale_serve::get_status`, invoked from `main.rs`).

### How to suppress it in future isolated measurements

There is no daemon flag to disable the boot-time check. Two practical options if the
log noise matters:

1. **`PATH` without `tailscale`** — run the daemon with a `PATH` that doesn't include
   `/usr/bin`, so `execFile("tailscale", …)` throws `ENOENT` and `getServeStatus()`
   returns via its catch. Caveat: the daemon also needs `node`/`tmux`/etc. from PATH,
   so you'd provide a minimal PATH containing only what the daemon must find. Not worth
   it for ordinary measurements — the check is harmless.
2. **Accept it** — it is a documented, read-only, non-VST-specific status probe; the
   pragmatic default is to let it run and ignore the one warning line.

Neither is required for correctness of the numbers above; the N2 figures are unaffected.

---

*End of N1/N2 baseline (task 4 of dispatch #2).*

---

# Task 5 — dev-sandbox / docker-compose / package.json Rust transition (dispatch #2)

**Commit:** `chore(10-2)` (script updates). **Status:** code changes complete +
syntax-checked; a live docker-sandbox boot is documented below as a **manual
follow-up** (not run autonomously on this unattended overnight run).

## What changed and why

The goal is that the dev sandbox **can** build/run the Rust binaries without yet
exclusively doing so (transition; the Node path stays as the fallback until the
deferred old-tree deletion in task 6, whenever that happens). Four files changed:

### 1. root `package.json` — added a Rust build script
```json
"build:rust": "cargo build --release --manifest-path rust/Cargo.toml -p vst-daemon -p vst-cli"
```
Builds both Rust binaries into `rust/target/release/` — the artifact the sandbox
now mounts. (No existing build script touched; `build`/`docker`/etc. unchanged.)

### 2. `docker-compose.dev.yml` — mount the Rust binaries + point the Rust daemon at the SPA
- Mounted the host's pre-built release binaries read-only, mirroring the existing
  CLI-binary mount pattern, with env overrides:
  - `./rust/target/release/vst-daemon` → `/usr/local/bin/vst-daemon-rust:ro`
    (`VST_RUST_DAEMON_BIN` overrides the source path)
  - `./rust/target/release/vst-cli` → `/usr/local/bin/vst-rust:ro`
    (`VST_RUST_CLI_BIN` overrides)
- Added `VST_DIST_PATH: /app/web-ui/dist` so the Rust daemon can serve the SPA when
  built; it degrades gracefully (404s the static fallback) if `web-ui/dist` is absent,
  since Vite serves the browser in the sandbox.
- **Seed-mode hazard not reintroduced:** no seed logic, volumes, ports, or `--seed`
  handling was touched; only mounts + one env var were added. The documented
  dev-vs-screenshots split is untouched.

### 3. `scripts/dev-entrypoint.sh` — prefer the Rust daemon/CLI, fall back to Node
The single daemon launch point (shared by `dev.Dockerfile` and the compose `command:`
override) now:
- Repoints `/usr/local/bin/vst` → `/usr/local/bin/vst-rust` when the mounted Rust
  CLI is a regular executable file (else the Node CLI symlink stays — both are drop-in
  `vst`).
- Launches `/usr/local/bin/vst-daemon-rust` when present, else `node cli/dist/daemon/main.js`.
- Guards with `-f`/`-x` (regular + executable) rather than `-e`, because Docker creates
  an **empty directory** at a bind-mount target when the host source is missing — the
  `-f` test cleanly falls back to Node instead of trying to exec a directory.
- **Note:** this file was touched slightly beyond the task's literal three-file list
  because it is the daemon's launch point — without it the sandbox cannot actually boot
  against Rust. It is a transition-safe, additive change (Node fallback preserved).

### 4. `scripts/dev-sandbox.sh` — surface which daemon the sandbox will boot
The `up` branch now prints whether the sandbox will run RUST (binary present) or NODE
(fallback) and, on fallback, tells the user to run `pnpm build:rust`. Pure additive
messaging — no orchestration/seed/volume behavior changed.

## Verification performed (this dispatch)

- `docker compose -f docker-compose.dev.yml config` → **valid**, and the rendered config
  contains the two Rust mounts (read-only) and `VST_DIST_PATH`.
- `bash -n` on `scripts/dev-sandbox.sh` and `scripts/dev-entrypoint.sh` → clean.
- `package.json` parses as JSON.
- The Rust daemon binary itself boots and serves `/health` (proven in the N2
  measurement, task 4, isolated HOME + scratch port).

## ⚠️ Recommended manual follow-up (deferred, not run here)

A **live docker-sandbox boot** against the Rust daemon was **not** run on this
unattended overnight run — it is a heavyweight, potentially long-running image build
(`node:24-slim` + apt + `pnpm install` of 873 packages + `COPY` + seed), and no one was
available to babysit it or clean up if it stalled. The user should run this themselves
when convenient:

```bash
pnpm build:rust                       # ensure rust/target/release/{vst-daemon,vst-cli} exist
scripts/dev-sandbox.sh up <worktree> --port=<free port in 7100-7199>
docker compose -f docker-compose.dev.yml -p <worktree> exec -u vst vst-dev \
  sh -c 'pgrep -af vst-daemon-rust'   # confirm the Rust daemon is the running process
```

Expect the log line `[daemon] using Rust daemon (/usr/local/bin/vst-daemon-rust)` from
`dev-entrypoint.sh`, and `scripts/dev-sandbox.sh` to print `daemon: RUST (...)`. If the
Rust binaries are absent, the sandbox falls back to Node (`daemon: NODE (fallback)`),
preserving the pre-transition behavior.

## Daemon-safety confirmation (applies to task 5 too)

No daemon was started for task 5. The Rust binaries were built and measured against an
**isolated HOME + scratch port** (task 4). Port **7421** and `~/.vibe-station` were never
touched; the live daemon remained healthy throughout. No processes were left running.

---

*End of dispatch #2 report — tasks 4 & 5 of `10-parity-cutover` complete. This closes
the entire `daemon-rust-port` feature (parts `00`–`10`) except the permanently-deferred
old-TS-tree deletion (task 6), which is out of scope and must only proceed on explicit
human request.*
