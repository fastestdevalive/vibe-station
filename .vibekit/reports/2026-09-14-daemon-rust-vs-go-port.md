<!--
RULES — read before writing this report:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. ANSWER FIRST: the finding goes at the top, before any evidence
3. EVERY CLAIM CITED: file:line, a command + its output, or a screenshot
4. READING TIME: optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Report: Rust vs Go for the daemon+CLI port — decision record

**Date:** 2026-09-14 · **Commit:** 285334f2fa387d96dfeb12da2d7e349fd7978a95 · **Scope:** `daemon/src`, `cli/src`, `desktop/src-tauri`, root/cli `package.json` — no code changes · **Method:** local codebase inspection + crate/package ecosystem knowledge synthesis (verified where a local tool exists to check)

## Answer

- **New evidence not in the original discussion: the repo already has a live Rust toolchain** — `desktop/src-tauri/Cargo.toml` (Tauri v2, `rustc 1.98.1` present locally). This is a concrete, existing-infrastructure argument for Rust that the earlier in-chat analysis didn't weigh — see `2026-09-05-kotlin-native-vs-rust-daemon.md` Follow-up #3, which already flagged "daemon logic as a Rust lib called from Tauri directly" as worth asking.
- **Recommendation: Option B (polyglot) over Option A (single-language Rust)**, specifically: **Go for the daemon control plane, Rust for a separate indexing/LSP-driving service** — the size of the mechanical-port task (54k+3.6k LOC, executed by a cheap model) dominates the decision; the existing Tauri toolchain is a real point in Rust's favor but doesn't outweigh port-risk on a codebase this size with the concurrency patterns it has (`daemon/src/ws/connection.ts:245` `withSessionLock`, `daemon/src/agent-plugins/registry.ts`).
- **Two decisions from the prior conversation turn are treated as settled inputs here, not re-litigated:** Android is a thin WS/REST client (daemon language irrelevant to it), and LSP/indexing are new first-class requirements.
- **Open item this report does NOT resolve:** whether "Go for daemon, Rust for indexing" is worth the operational cost of two toolchains/two binaries vs. accepting more Rust porting friction to stay single-language — see Follow-ups.

## Evidence

| Claim | Source |
|-------|--------|
| daemon/src is real scale: 54,036 LOC across TS files | `$ find daemon/src -name "*.ts" \| xargs wc -l \| tail -1` → `54036 total` |
| cli/src is 3,580 LOC | `$ find cli/src -name "*.ts" \| xargs wc -l \| tail -1` → `3580 total` |
| Daemon deps requiring native-module or hand-port decisions | `cli/package.json:9-27` — `better-sqlite3`, `node-pty`, `fastify`, `@fastify/websocket`, `chokidar`, `ignore`, `zod`, `@agentclientprotocol/sdk` 1.4.0, `@agentclientprotocol/claude-agent-acp` 0.70.0 |
| Concurrency hot spot #1: per-(connection,sessionId) lock | `daemon/src/ws/connection.ts:245` `withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>` |
| Concurrency hot spot #2: plugin dispatched by interface, not branching (explicit repo invariant) | `AGENTS.md` § "Agent plugin — all CLI-specific logic lives in the plugin"; `daemon/src/agent-plugins/registry.ts` (32 lines) |
| Concurrency hot spot #3: two independent pollers writing two different fields, explicitly must never cross-write | `AGENTS.md` § "Status indicators"; `daemon/src/services/lifecycle.ts` (498 lines, 1s poll), `daemon/src/services/prPoller.ts` (276 lines, 30s poll) |
| Repo already has a working Rust toolchain (Tauri desktop shell) | `desktop/src-tauri/Cargo.toml:1-27` — `tauri = "2"`, `edition = "2021"`, `rust-version = "1.77.2"` |
| Rust toolchain is actually installed and current in this environment | `$ rustc --version` → `rustc 1.98.1 (48a229cea 2026-09-01)` |
| Go toolchain is also available in this environment | `$ go version` → `go1.26.1 linux/amd64` |
| Prior report already compared Kotlin/Native vs Rust and picked Rust for this daemon, citing the Tauri dependency | `.vibekit/reports/2026-09-05-kotlin-native-vs-rust-daemon.md:8,56` |
| That report's own follow-up asked exactly the question this report inherits | `.vibekit/reports/2026-09-05-kotlin-native-vs-rust-daemon.md:75` — "Could daemon logic be a Rust `lib` called from Tauri directly (no separate process)?" |
| CLI currently ships as a packaged Node binary | `cli/package.json:6-7` `"bin": {"vst": "./dist/main.js"}`, root `package.json:33` `"@yao-pkg/pkg": "^5.16.0"` |

## Detail

### Dependency-by-dependency mapping (Rust vs Go)

| Need | Rust | Go | Edge |
|---|---|---|---|
| HTTP/WS server | `axum` + `tokio-tungstenite` | `net/http` + `gorilla/websocket` / `nhooyr.io/websocket` | Tie — both mature, both production-proven at scale |
| SQLite (sync, embedded) | `rusqlite` w/ `bundled` feature — statically links sqlite3, no cgo, static binary | `mattn/go-sqlite3` (cgo, breaks trivial cross-compile) **or** `modernc.org/sqlite` (pure Go, transpiled sqlite, no cgo) | Rust slightly ahead; Go's pure-Go option closes most of the gap |
| PTY spawn (backs tmux sessions) | `portable-pty` (WezTerm's crate, cross-platform) | `creack/pty` (solid on Linux/macOS, no native Windows PTY without extra work) | Tie for this repo's actual targets (Linux/macOS daemon host) |
| Filesystem watch | `notify` | `fsnotify` | Tie — both are the de-facto standard in their ecosystem |
| Gitignore-aware file walking | `ignore` crate — **is** ripgrep's own crate, reused not reimplemented | community gitignore libs, less polished, none is "the" canonical one | Rust — concrete reuse, not just an equivalent |
| ACP (agent protocol) | `agent-client-protocol` crate — first-party, maintained by Zed (ACP's origin project) | No official SDK; protocol is newline-delimited JSON-RPC over stdio — hand-rollable, not a large lift, but self-maintained | Rust ahead on SDK maturity; Go gap is real but small given protocol simplicity |
| LSP client (driving gopls/rust-analyzer/tsserver/pyright as subprocesses) | `lsp-types` (rust-analyzer team's own wire types) + hand-written JSON-RPC dispatch | No first-party equivalent; hand-write structs + JSON-RPC dispatch | Slight Rust edge (saves boilerplate), not a hard blocker either way — this is dispatch/framing, not a hot path |
| Code indexing (symbol extraction + fast full-text search, if built in-house rather than shelling out to `rg`/ctags) | `tree-sitter` (reference host embedding is the Rust crate — Helix/Zed use it), `tantivy` (mature pure-Rust Lucene-equivalent, embeddable) | `bleve` (legitimate pure-Go full-text search, mature) for search; tree-sitter Go bindings are cgo-based and less first-class | Real structural Rust edge — this is the one place "reuse the actual best-in-class tool's language" applies |

### Binary size

- Rust: stripped + LTO + `panic = "abort"` + `rusqlite` bundled → typically low single-digit MB for a daemon this shape.
- Go: runtime + DWARF data means even `-ldflags="-s -w"` stripped binaries commonly land 5-8MB+ for comparable functionality; any cgo dependency (`mattn/go-sqlite3`) makes cross-compilation non-trivial and binaries larger/less portable.
- Go mitigation: `modernc.org/sqlite` (pure Go) avoids cgo entirely, keeps `GOOS=/GOARCH=` cross-compiles trivial, and meaningfully narrows the size gap vs Rust — this is the configuration to use if Go is chosen, not `mattn/go-sqlite3`.
- Either choice is a large win over the current Node+`@yao-pkg/pkg` packaged binary (`cli/package.json:6-7`) on both size and cold-start.

### Performance

- Workload is I/O-bound: network (WS/REST), PTY read/write, SQLite reads/writes — not compute-bound. Both languages are a large upgrade over Node here regardless of which is picked.
- Rust: no GC → more predictable tail latency under many concurrent PTY/WS streams (matters most if session count scales into the hundreds+).
- Go: GC pauses are unlikely to be visible at vibe-station's actual current scale (dozens of concurrent sessions per the dashboard/status model in `AGENTS.md`).

### Ease of AI-assisted mechanical porting (cheap model does the bulk work)

- This is the single largest differentiator for a 54k+3.6k LOC port executed mostly by a weaker/cheaper model ("DeepSeek" in this project's plan), Sonnet doing high-level planning only.
- Go's goroutines + channels + plain `sync.Mutex` map closely onto the current TS `async`/`await` + closure + lock-map style already in the code (`withSessionLock` at `daemon/src/ws/connection.ts:245` is a promise-chain lock — its Go translation is a near-literal `sync.Mutex`-per-key pattern).
- Rust requires threading `Arc<Mutex/RwLock<...>>` + `Send`/`Sync` bounds through every `tokio::spawn` boundary. This is exactly where a weaker model tends to thrash (long compile-error iteration loops), and — worse than just being slow — a common failure mode is the model "fixing" borrow-checker errors by adding defensive `.clone()`s or extra locking that silently reintroduces the exact single-writer-per-field races `AGENTS.md`'s Status Indicators section explicitly protects against (`daemon/src/services/lifecycle.ts` vs `daemon/src/services/prPoller.ts` writing disjoint fields only).
- This risk scales with codebase size: it is a much smaller concern for a bounded, freshly-designed indexing service than for a 54k-LOC mechanical translation of code that wasn't written with Rust's ownership model in mind.

### Two strategies (both were left open in the prior conversation turn)

**Option A — single-language Rust**
- Pro: one toolchain end-to-end, best fit for ACP SDK / LSP types / indexing crates, smallest binaries, and now — new to this report — reuses the toolchain already present via Tauri (`desktop/src-tauri/Cargo.toml`), and per the 2026-09-05 report's own follow-up, could in principle let daemon logic be linked as a Rust lib called directly from Tauri, collapsing an IPC boundary.
- Con: full 54k-LOC daemon port, including its hardest concurrency invariants, done mostly by a cheap model — highest risk of subtle concurrency regressions that are hard to catch by code review alone.

**Option B — polyglot (Go daemon + Rust indexing/LSP service)**
- Pro: the large, easier-to-mechanically-translate 54k LOC (WS/REST, session/PTY orchestration, sqlite) goes to the language that's the better mechanical-translation target for a cheap model; Rust is reserved for the smaller, greenfield module (indexing + LSP driving) where its ecosystem edge is real and the "translate existing complex concurrent code" risk doesn't apply (it's new code, not a port).
- Con: two toolchains, two binaries, an IPC boundary between the Go daemon and the Rust indexing service (a local socket or HTTP call — the daemon already spawns/talks to child processes for tmux and agent CLIs, so this isn't a new architectural pattern, but it is more moving parts than Option A) — the Tauri-toolchain-reuse argument for Option A does not carry over to Option B's daemon half since that part becomes Go.

### Additional risks/considerations for a port this size (not previously covered)

- **Behavioral parity validation:** the existing daemon has substantial existing test coverage (`daemon/src/__tests__/`) — the port should treat these as an executable spec: either port the test suite alongside the implementation module-by-module, or run both daemons against a shared black-box test harness (WS/REST contract tests) during the transition, rather than trusting the ported code's own new tests to catch drift.
- **Incremental vs big-bang:** given the size, a big-bang rewrite risks a long unshippable period; an incremental path (e.g., stand up the new daemon's HTTP/WS surface first behind the same protocol contract, cut clients over per-worktree or behind a flag) needs the protocol (`daemon/src/ws/protocol.ts`, `daemon/src/types.ts`) to be the source of truth either way — this is also exactly the artifact the thin-client Android app will need, so specifying it precisely pays for itself twice.
- **Coexistence period:** if incremental, decide whether the Node and new-language daemons can run side-by-side against the same on-disk state (SQLite file, worktree directories) — schema/locking compatibility between `better-sqlite3` and whichever Rust/Go sqlite library is chosen needs an explicit check (WAL mode, busy-timeout behavior, connection lifecycle) before any coexistence is attempted.
- **`node-pty`/tmux behavioral edge cases:** the existing "Terminal" and "WebSocket" guidance in `AGENTS.md` documents subtle, previously-shipped bugs (double-echo from concurrent `session:open`/`session:close`, ghost PTY streams). A port must treat these as regression tests, not just prose — whichever language is chosen, port the *fix* (the locking discipline), not just the feature.

## Not checked

- No benchmark was run in this environment for `rusqlite` vs `modernc.org/sqlite` vs `mattn/go-sqlite3` on this project's actual query patterns — the sizing/perf claims above are ecosystem-knowledge, not measured against this repo's schema.
- Did not build a spike/prototype of either an Axum+tokio-tungstenite or a Go net/http+websocket server reproducing `daemon/src/ws/connection.ts`'s lock semantics — the "which is easier to mechanically port" claim is based on reading the existing code's shape, not on having attempted the translation.
- Did not investigate whether Tauri v2 can host/link a daemon-as-library directly (the follow-up inherited from the 2026-09-05 report) — flagged below, not answered.
- Did not survey `daemon/src/__tests__/` contents in detail to size the "port tests alongside implementation" effort.

## Follow-ups

| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | Is the Tauri-toolchain-reuse point (Option A) strong enough to accept more porting risk on the 54k-LOC core, or does port-risk still dominate? | Directly decides Option A vs B — this report surfaces the fact but doesn't resolve the tradeoff |
| 2 | Could the daemon be linked into Tauri as a Rust library (no separate process/socket) if Option A is chosen? | Inherited from `2026-09-05-kotlin-native-vs-rust-daemon.md:75`, still open |
| 3 | If Option B: what's the IPC shape between the Go daemon and the Rust indexing/LSP service — local Unix socket, HTTP, or in-process via cgo/FFI? | Needed before any implementation plan can be written for Option B |
| 4 | Incremental cutover or big-bang? | Determines whether a shared-state coexistence period needs to be designed at all |
| 5 | Does the team have more existing Rust or Go familiarity/preference beyond the Tauri toolchain fact? | A qualitative factor this report can't source from the codebase alone |
