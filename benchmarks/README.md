# benchmarks

`vstbench` measures the release `vst` daemon (web UI embedded) and writes JSON to `results/`.
The website reads those files; see the plan in
`.vibekit/feature-plans/benchmarking/BENCHMARKING-STRATEGY.md` for methodology.

```bash
pnpm install --frozen-lockfile && pnpm --filter @vibestation/web build
CARGO_TARGET_DIR=~/vstbench-data/target cargo build --release \
  --manifest-path rust/Cargo.toml -p vst-cli --features vst-daemon/embed-ui,insecure-no-auth

benchmarks/vstbench fetch                       # shallow-clone the search corpus (needs network)
benchmarks/vstbench footprint --bin ~/vstbench-data/target/release/vst \
  --repo <repo> --competitors                   # Part A  -> results/footprint.json
benchmarks/vstbench startup --bin NEW --baseline OLD  # exec -> /health 200, alternating -> results/startup.json
benchmarks/vstbench trace  --bin ...            # Part E  -> results/trace.json
benchmarks/vstbench load   --bin ...            # Part C  -> results/load.json
benchmarks/vstbench corpus --bin ... --dir <repos>   # Part B -> results/corpus.json
```

Run on a quiet machine. The harness isolates the daemon (own `$HOME`, private tmux, loopback-only
network namespace) and refuses to run above `--max-load` unless `--force`.

## Result files

`results/<name>.json`, overwritten per run; git history is the history. Every file carries
`schema_version`, `timestamp`, `commit`, `dirty`, `binary_sha256`, `machine`, and **`preliminary`**.

- **The website must only show files where `preliminary` is `false`.**
- The committed runs are all `preliminary: true` (loaded machine, swap full, `powersave` governor); the final run replaces them.
- Part A (`footprint.json`) is the headline; B/C/D/E are recorded only.
- Memory: PSS is the primary figure, RSS the cross-check (see plan §2.1).

## Website preview — tables as they will appear (PRELIMINARY numbers)

> Generated from `results/*.json` (run on `main` @ `aac3f71e`, including the async-startup change): loaded machine (load average 5–13, swap full, CPU governor `powersave`). **These are placeholders for layout and review, not publishable.** Final values replace them after the quiet-machine re-run.

### Hero cards

| Server ready | Daemon memory | Total vs VS Code | Peak under load |
|:--|:--|:--|:--|
| **11 ms** | **16.7 MB** PSS | **2.3× less** | **19.6 MB** RSS |
| `/health` 200, median of 30 | 19.0 MB RSS | PSS, daemon + whole browser instance | 10 workers, 15 s burst |

### Startup

Cold start of the release binary, exec → `/health` 200 measured from outside, empty `$HOME`, 30 runs per build, builds alternated run by run. Before = `main` just before the async-startup change (bind before cloudflared sweep, Tailscale check and skill-catalog init); after = current `main`.

| | Median | p90 | Min | Max |
|:--|--:|--:|--:|--:|
| Before: ready to serve | **66.0 ms** | 70.3 ms | 61.3 ms | 76.7 ms |
| After: ready to serve | **11.1 ms** | 13.0 ms | 9.7 ms | 29.1 ms |
| Before: in-process, start → listening | 62.2 ms | 66.1 ms | 57.8 ms | 70.2 ms |
| After: in-process, start → listening | 7.0 ms | 8.5 ms | 6.5 ms | 13.3 ms |
| Before: process up (exec → first log line) | 2.0 ms | 3.2 ms | 1.6 ms | 7.4 ms |
| After: process up (exec → first log line) | 2.1 ms | 3.3 ms | 1.5 ms | 14.9 ms |

Ready-to-serve is **6.0× faster** than before. An empty `$HOME` excludes the migration and boot-recovery cost of a populated store, which is not yet measured.

### Total memory — vibe-station vs the alternatives

Median of 5 runs (min–max). Same machine, same repo (django), clean profile, no extensions.

| Tool | Architecture | Server PSS | Client PSS | **Total PSS** | Total RSS | Server ready |
|:--|:--|--:|--:|--:|--:|--:|
| **vibe-station** | 1 Rust process + 1 Chrome instance | 16.7 MB | 382.2 MB | **398.9 MB** | 1,216.0 MB | 11 ms (10–13) |
| VS Code Desktop 1.140.0 | Electron, 15 processes | — | 901.6 MB (856–1,004) | **901.6 MB** | 1,886.9 MB (1,868–1,903) | not measured |
| code-server 4.140.0 + Chrome | Node server + 1 Chrome instance | n/r | n/r | **1,270.7 MB** (1,233–1,293) | 2,336.5 MB (2,152–2,349) | 250 ms |
| Cursor | — | not measured | not measured | not measured | not measured | not measured |
| Zed | — | not measured | not measured | not measured | not measured | not measured |

PSS counts shared pages once; RSS double-counts them across Chromium/Electron processes, so it is shown only as a cross-check. n/r = not recorded (server RSS was 801.4 MB, client RSS 1,533.4 MB). Server ready is time to `/health` (`/healthz`) 200, not window-ready. Tauri desktop build not tested.

### Two ways to count the browser

| | Daemon PSS | Browser PSS | **Total PSS** | Total RSS |
|:--|--:|--:|--:|--:|
| Fresh browser instance (nothing else open) | 16.7 MB | 382.2 MB | **398.9 MB** | 1,216.0 MB |
| Browser already open (extra tab only) | 16.7 MB | +39.3 MB | **56.0 MB** | 102.6 MB |

### Ratios

| Compared with vibe-station | PSS | RSS |
|:--|--:|--:|
| VS Code Desktop — vibe-station with a whole browser instance | 2.3× | 1.6× |
| code-server + Chrome — vibe-station with a whole browser instance | 3.2× | 1.9× |
| VS Code Desktop — vibe-station with a browser already open | 16.1× | 18.4× |
| code-server + Chrome — vibe-station with a browser already open | 22.7× | 22.8× |

Idle CPU: 0.3% · benchmark binary 31.0 MB with the web UI embedded, built with the test-only `insecure-no-auth` feature (tmux, `rg`, git and the agent adapters are separate).

### Memory profile

| Phase | RSS | PSS |
|:--|--:|--:|
| fresh | 18.2 MB | 16.0 MB |
| after 200 reqs | 18.4 MB | 16.2 MB |
| peak during 10-worker burst | 19.6 MB | — |
| idle 30s after burst | 19.6 MB | 17.4 MB |

### API throughput & latency

10 closed-loop workers, 15 s per run after warm-up, median of 3 runs. Reads are served from an in-memory cache.

| Endpoint | req/s | p50 | p95 | p99 | Errors |
|:--|--:|--:|--:|--:|--:|
| `GET /health` | 9,000 | 1.01 ms | 1.99 ms | 2.6 ms | 0 |
| `GET /api/projects` | 9,143 | 1.0 ms | 1.96 ms | 2.56 ms | 0 |
| `GET /api/modes` | 9,210 | 0.99 ms | 1.95 ms | 2.53 ms | 0 |

### Search across real repositories

Shallow clones (`--depth 1`), release daemon, median of 5. File list uses `rg --files`. "Common term" stops at 50 hits; "rare term" must scan everything.

| Repo | Language | Source | Files | File list (cold) | File list (warm) | Search: common term | Search: rare term | Daemon RSS |
|:--|:--|--:|--:|--:|--:|--:|--:|--:|
| flask | Python | 3 MB | 236 | 8.2 ms | 8.3 ms | 3.7 ms | 7.9 ms | 19.4 MB |
| ripgrep | Rust | 4 MB | 237 | 9.6 ms | 8.7 ms | 6.2 ms | 6.9 ms | 19.3 MB |
| django | Python | 73 MB | 7,084 | 31.8 ms | 14.0 ms | 3.2 ms | 16.9 ms | 20.6 MB |
| react | JavaScript | 63 MB | 7,252 | 18.4 ms | 14.5 ms | 4.7 ms | 15.2 ms | 21.0 MB |
| kubernetes | Go | 372 MB | 31,356 | 62.6 ms | 24.3 ms | 4.1 ms | 40.8 ms | 26.9 MB |
| linux | C | 1,809 MB | 96,053 | 78.4 ms | 37.0 ms | 4.7 ms | 97.9 ms | 21.6 MB |

No file list was truncated. Fuzzy file search is not yet measured.

### Not yet available (shown on the site only once measured)

| Section | Status |
|:--|:--|
| Per-process memory breakdown | harness does not collect `processes[]` yet |
| Overhead vs live sessions (0 / 14 / 50) | `vstbench scale` failing: no modes in the isolated `$HOME` |
| Memory-over-time chart | needs a 1 Hz `timeline[]` in `trace` |
| Store micro-benchmarks | criterion benches written, not yet run |
| Cursor, Zed | not installed; shown as "not measured" |

### Method & hardware

| | |
|:--|:--|
| CPU | AMD Ryzen 9 9955HX 16-Core Processor (32 threads) |
| Memory | 60.5 GB |
| Kernel | Linux 6.12.86+deb13-amd64 |
| Browser | Google Chrome 154.0.8037.57, fresh profile, no extensions |
| Tools | VS Code 1.140.0 · code-server 4.140.0 |
| Protocol | 15 s settle, then 15 samples at 1 Hz, median; 5 runs, median and range |
| Isolation | own `$HOME`, private tmux, loopback-only network namespace |
| Machine state (this preliminary run) | load average 5.1, 19 other vst daemons running |

## How the numbers appear on the website

The site renders `results/*.json` directly (fetched from the repo, no hand-copied numbers) on one
`/benchmarks` page, with a short stat strip on the landing page. Only files with
`"preliminary": false` are shown. A tool or metric missing from a file is rendered as
"not measured" — never as `0` or an estimate. Comparisons exist **only** for Part A; B–E are shown
as our own numbers with no competitor column.

Page order (landing strip first, then `/benchmarks` top to bottom):

| # | Section | Source (`results/…`) | What is shown |
|---|---------|----------------------|---------------|
| 0 | **Landing stat strip** (4 cards, each with a one-line condition footnote and a link to `/benchmarks`) | `footprint.json`, `corpus.json` | daemon memory (PSS, RSS in the footnote) · server ready time · memory vs VS Code ratio · search latency on the largest repo |
| 1 | **Hero cards** (3–4) | `footprint.json`, `trace.json` | server-ready ms · daemon PSS/RSS · total vs VS Code (PSS) · peak RSS under load |
| 2 | **Footprint comparison table** | `footprint.json` | one row per tool: Tool + version · Process architecture · Server PSS · Client PSS · **Total PSS** · Total RSS · Server ready · Runs (median, min–max) |
| 3 | **Two ways to count the browser** | `footprint.json` | vst with a whole fresh browser instance vs vst when a browser is already open (tab delta); stated side by side so neither framing can be accused of hiding the other |
| 4 | **Memory breakdown** (per-process tree for vst and for VS Code / code-server) | `footprint.json` → `processes[]` ⚠ not collected yet | largest processes by PSS with a role label (daemon, tmux, browser GPU/renderer, extension host, …) |
| 5 | **Scaling with live sessions** (line chart, orchestrator overhead only) | `scale.json` ⚠ broken, see below | daemon RSS + CPU at 0 / 14 / 50 sessions; caption "stub agents, agent processes excluded" |
| 6 | **Memory over a session** (timeline chart) | `trace.json` → `timeline[]` ⚠ not collected yet | RSS vs time through fresh → requests → burst → idle, with phase labels and "Δ after idle" |
| 7 | **API latency & throughput** | `load.json` | per endpoint: req/s · p50 · p95 · p99 · errors; note that reads are served from an in-memory cache |
| 8 | **Real-repo search table** (no competitors) | `corpus.json` | per repo: language · size · files · file-list cold/warm · content search · idle RSS · `truncated` flag; sorted by file count, footnotes define each column |
| 9 | **Store micro-benchmarks** (no competitors) | `store.json` ⚠ benches not run yet | whole-project rewrite, lifecycle update, cached reads, by corpus size; labelled "cache reads, not SQLite" |
| 10 | **Method & hardware** | every file's `machine`, `commit`, `binary_sha256`, `timestamp` | CPU · cores · RAM · kernel · browser · tool versions · commit SHA · run protocol (settle, samples, runs, median) · isolation (own `$HOME`, private tmux, loopback-only network namespace) |
| 11 | **Reproduce** | this README | the exact `vstbench` commands, copy-paste |
| 12 | **FAQ / caveats** | static copy | Tauri not tested · why PSS is primary · RSS cross-check · "ready" is server-ready, not window-ready · Cursor/Zed not measured · what is and isn't in the binary (UI embedded; tmux, `rg`, git and the agent adapters are separate) |

Presentation rules:
- Every number shows its condition next to it (repo and file count, run count, "median of 5").
- Memory is PSS first, RSS as the cross-check; the page explains the difference once.
- Ratios ("× less than VS Code") are computed from the JSON at render time and show both the PSS and the RSS version.
- Charts use the shared dataviz palette; no bare hexes, light and dark mode both checked.
- A "Last measured" stamp and commit SHA appear on every section.

### Data the harness does not produce yet (needed before the page can match the layout above)

| Needed for | Missing | Work |
|------------|---------|------|
| Section 4 | per-process breakdown with role labels | add `processes[]` to `footprint` for every tool |
| Section 5 | `scale.json` | `vstbench scale` fails: the isolated `$HOME` has no modes; create one through the API first |
| Section 6 | RSS timeline | add 1 Hz `timeline[]` with phase markers to `trace` |
| Section 9 | `store.json` | compile and run the `vst-store` criterion benches, export to JSON |
| Section 2 | server-ready for VS Code / "time to interactive" | scriptable window-ready marker (CDP) or leave as "not measured" |
| Section 8 | language and source size per repo | add to `corpus` output |
| Section 10 | CPU governor, swap, browser version | add to the `machine` block |
| Section 2 | Cursor and Zed rows | need install and a display; otherwise "not measured" |
