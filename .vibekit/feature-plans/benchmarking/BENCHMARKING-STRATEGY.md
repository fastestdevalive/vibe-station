# vibe-station Benchmarking Strategy

> **Status:** Harness built (`benchmarks/vstbench`, results in `benchmarks/results/*.json`); plan reviewed by Opus and corrected against the code. Branch: `benchmarks-checking-benchmarking`

## 1. Scope

| Part | Content | Role |
|------|---------|------|
| **A** | Total system footprint: daemon + one browser tab vs competitors | **The only published result — the headline** |
| B | File listing / search across real repos | Recorded in `docs/PERFORMANCE.md` only |
| C | API load (10 workers, time-based) | Recorded only |
| D | Store micro-benchmarks (criterion) | Recorded only |
| E | Memory trace | Feeds Part A's idle/peak numbers; also recorded |

B–E have no competitor data: no comparison, no CI, no baselines. Run manually, record once.

## 2. Measurement policy

We measure what is on the user's machine while they work. **Tauri is not tested and is called out explicitly** — it adds its own Chromium process and is a separate, optional deployment mode.

**Binary under test:** the shipped merged `vst` binary built with the web UI embedded — not a plain `vst-daemon` build, which serves a 404 for `/`.

```bash
pnpm install --frozen-lockfile && pnpm --filter @vibestation/web build
CARGO_TARGET_DIR=~/vstbench-data/target cargo build --release \
  --manifest-path rust/Cargo.toml -p vst-cli --features vst-daemon/embed-ui,insecure-no-auth
benchmarks/vstbench footprint --bin ~/vstbench-data/target/release/vst --repo <repo>
```

`VST_NO_AUTH=1` only takes effect in a binary built with the `insecure-no-auth` cargo feature (compile-time gated on `main`), so the benchmark build enables it; `vstbench` sets the env var. The shipped release does not include the feature, so the published binary size is noted as measured on the benchmark build (differs from the shipped one by the feature's marker only — verify before publishing).

### 2.1 Memory accounting

- **PSS is the primary number** (`/proc/<pid>/smaps_rollup`, summed over the process tree). Chromium/Electron processes share large amounts of memory, so a summed **RSS** double-counts them (measured: a blank Chrome instance sums to ~1.2 GB RSS but ~0.39 GB PSS). RSS is reported as the cross-check, never alone.
- **Two browser figures, both labelled:** the *whole dedicated browser instance* (what a user pays if the browser isn't already open) and the *tab delta* (instance with the UI loaded minus the same instance on `about:blank`; what it costs if a browser is already open). Competitors are measured as their whole process tree.
- Sampling: settle 15 s, then 15 samples at 1 Hz, median; 5 runs, median and range.
- Include the tmux server whenever sessions exist; count CPU as utime+stime+cutime+cstime (the lifecycle poller forks `tmux` every second).

### 2.2 Isolation — benchmarks run on a developer machine alongside the Tauri dev app

Verified against the code; all enforced by `vstbench`:

| Hazard (found in code) | Mitigation |
|------------------------|-----------|
| Data dir is `$HOME/.vibe-station`; `VST_DATA_DIR` does nothing for the daemon. Lock, config, shell-rc patching, skills all live there | Daemon runs with its own temp `$HOME` |
| Daemon binds `0.0.0.0`; `VST_NO_AUTH=1` = unauthenticated shell reachable from the LAN | Whole run executes in a private **network namespace** (loopback only, same uid) |
| tmux uses the default socket (shared with the dev daemon) | Private `TMUX_TMPDIR` per run |
| Boot-time `cloudflared::sweep_orphans()` kills **every** `cloudflared` on the machine | Refuses to run if a `cloudflared` process exists |
| Fresh `$HOME` shows the onboarding wizard | `oobe.json` seeded complete; a project is registered so the tab shows a workspace |
| Timing is load-sensitive | Records load average, other daemons, machine spec; refuses above `--max-load` (flagged noisy under `--force`) |

Final Part A timing capture still wants a quiet machine: close Tauri, dev sandboxes and Vite servers. Also record CPU governor and swap use.

### 2.3 Competitor protocol

Same machine, same session, same repo, vst with 0 agents. Clean profile and no extensions for every tool. The workload is defined, not "opened": repo open, file tree visible, no terminal, no AI features; built-in git/TS indexing in VS Code is recorded rather than hidden.

| Tool | Status |
|------|--------|
| vst (daemon + 1 Chrome tab) | measured |
| VS Code Desktop | measured (installed locally) |
| code-server + 1 Chrome tab | measured (release tarball, no install) |
| Cursor, Zed | **not measured** unless installed with a display; never estimated |

Report versions of every tool and the commit SHA. Warm starts only (one discarded warm-up run); no cold-cache claims.

## 3. Part A — Total system footprint (published)

Rows are filled from `vstbench footprint` output only; no estimated competitor figures.

| Tool | Server PSS | Client PSS | **Total PSS** | Total RSS (cross-check) | Ready |
|------|-----------:|-----------:|--------------:|------------------------:|-------|
| vst — whole browser instance | | | | | |
| vst — tab delta (browser already open) | | | | | |
| VS Code Desktop | — | | | | |
| code-server + 1 tab | | | | | |

**Ready** is reported as *server ready* (see Startup below) (exec → `/health` 200) for server tools, labelled as such; it is not comparable to a desktop app's launch → first window. After PR #208 (bind before cloudflared sweep / Tailscale check / skill-catalog init) the measured median is ~12 ms, down from ~71 ms; do not claim a sub-ms start. `vstbench startup` alternates before/after binaries and reports exec→`/health` 200 (external), process-up, and in-process time to listen separately, on an empty `$HOME` (a populated store adds migration/recovery cost).

**Callouts** (each must be reproducible from the JSON output):

| Stat | Source |
|------|--------|
| Memory ratio vs VS Code (PSS and RSS both shown) | footprint |
| Server-ready time | footprint |
| Idle / peak daemon RSS | `trace` |
| Shipped binary size (UI embedded); still needs tmux, `rg`, git at runtime — "no Node/Electron", not "zero dependencies" | `stat` |
| Orchestrator overhead vs live sessions (0/14/50), **agent processes excluded**; stub agents; RSS + CPU | `scale` |
| Idle CPU % over a window | footprint |

The site must state: Tauri not tested; competitor numbers measured by us on the stated machine; the exact reproduce command; commit SHA, versions, kernel, CPU, RAM, browser.

## 4. Parts B–E — record only

- **B:** per repo — file-list cold/warm (`/api/projects/:id/file-list`, which spawns `rg --files` and truncates at 100,000 entries; record `truncated`/`source`), content search (`/api/projects/:id/search`), idle RSS. Fuzzy (`file-search`) is worktree-scoped and built lazily on first query — record first-query vs steady state; needs a worktree, not yet covered. Corpus: ripgrep, flask, django, react, kubernetes, linux (shallow clones; `vstbench fetch`).
- **C:** `/health`, `/api/projects`, `/api/modes`; 10 closed-loop workers, 15 s per run after warm-up (time-based so p99 has real samples). Reads hit the in-memory cache, not SQLite — say so. Write-path load and WS fan-out: not yet covered.
- **D:** criterion on the real `vst-store` API: whole-project rewrite via `mutate_project`/`add_project` (`write_project_full`), `update_session_lifecycle` (the 1 s poller hot path), cached reads (in-memory — not a SQLite benchmark). Not yet written.
- **E:** `vstbench trace` — fresh, after 200 requests, peak under burst, idle after burst.

## 5. Keeping this our own

| Area | Prior art | Ours |
|------|-----------|------|
| Tool | `benchmark.sh --flags` | `vstbench <subcommand>` |
| Doc | `BENCHMARKS.md` | `docs/PERFORMANCE.md` |
| Headline | Lightweight editor vs editors | Agent orchestrator: overhead per live session |
| Competitors | Vim, Neovim, Sublime, Zed, VS Code | Tools a vst user would substitute |
| Run policy | Fastest of 5 | Median + range, PSS primary |
| Search/LSP | Compared, incl. LSP | Recorded only; no LSP |

All copy, tables and code written from scratch; no mention of or numbers from other projects.

## 6. Checklist

- [x] Release `vst` with UI embedded builds into an isolated target dir
- [x] `vstbench`: `footprint`, `scale`, `trace`, `load`, `corpus`, `fetch`
- [ ] Capture on a quiet machine; fill §3
- [ ] criterion benches for `vst-store` (§4 D)
- [ ] Write `docs/PERFORMANCE.md`
