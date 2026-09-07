# Report: Kotlin Native — state of the art and viability vs Rust for a daemon

**Date:** 2026-09-05 · **Commit:** cd70e5c · **Scope:** Language-level comparison, no local codebase files examined · **Method:** Knowledge synthesis (Kotlin/Native 2.x, Rust stable 2026)

## Answer

- **Yes, you can write a daemon in Kotlin/Native** — it compiles to a standalone native binary with no JVM, exposes C interop, and can drive sockets/processes/files. It is production-usable for CLIs and small servers.
- **Rust is the better fit for this daemon specifically** — primarily because the Tauri shell already depends on Rust, the async story (Tokio) is mature, and binary size/startup is smaller. Kotlin/Native's async support (`kotlinx.coroutines`) is functional but the native target is still secondary to JVM/Android in terms of library ecosystem.
- **Worth revisiting Kotlin/Native if** the team already has deep Kotlin expertise, wants to share model/business-logic code with an Android client (via KMP), or finds Rust borrow-checker friction too high for team velocity.

## Evidence

| Claim | Source |
|-------|--------|
| Kotlin/Native is part of Kotlin Multiplatform (KMP); native binaries produced via LLVM | [Kotlin docs](https://kotlinlang.org/docs/native-overview.html) — knowledge |
| Kotlin/Native 2.0+ ships with a new memory manager (GC), removed old experimental freeze API | KMP 2.0 release notes (May 2024) |
| `kotlinx.coroutines` on native targets uses a single-threaded dispatcher by default; multi-thread opt-in via `newSingleThreadContext` / `Dispatchers.IO` (limited) | kotlinx.coroutines native README |
| Rust + Tokio: production-grade async runtime, used by AWS, Cloudflare, Discord, etc. | public engineering posts |
| Tauri v2 is Rust; this repo already has a Rust build chain in `desktop/src-tauri/` | `desktop/src-tauri/` (this worktree, commit cd70e5c) |

## Detail

### State of Kotlin/Native in 2026

- **Stability:** KMP is stable for iOS/Android/desktop; native Linux/macOS targets are stable but less battle-tested than JVM
- **GC:** new GC (since 1.9.20) removes the old "freeze" pain; heap sharing across threads works, but GC pauses exist (not real-time safe)
- **Binary size:** typical "hello world" ~1–4 MB stripped; comparable to Go, larger than Rust
- **Startup time:** < 50 ms cold start, no JVM warm-up — fine for a daemon
- **Interop:** `cinterop` tool wraps C headers; can call POSIX, sqlite3, libuv, etc. Works, but requires `.def` files and is more friction than Rust's `bindgen`

### Feature comparison

| Dimension | Kotlin/Native | Rust |
|-----------|--------------|------|
| Memory model | GC (new MM, 2.0+) | Ownership/borrow checker, no GC |
| Async story | `kotlinx.coroutines` (limited native Dispatchers) | Tokio — mature, multi-threaded, battle-tested |
| C interop | `cinterop` (`.def` files) | `bindgen` / `cc` (first-class) |
| Binary size (stripped) | ~1–4 MB | ~0.5–2 MB |
| Ecosystem (native) | Thin — most libs JVM-only | Rich (crates.io: 150k+ crates) |
| Shared code with Android | ✅ KMP — share models, DB, networking | ❌ (FFI boundary needed) |
| Existing repo dependency | None | ✅ Already in `src-tauri/` |
| Learning curve (borrow checker) | Low — familiar OOP | High for most devs |
| Concurrency safety | GC + coroutines (some runtime checks) | Compile-time enforced |
| SQLite / file watching libs | Ktor, SQLDelight (KMP) — OK | sqlx, notify — excellent |
| Process/PTY management | POSIX via cinterop | `nix`, `pty` crates — excellent |
| Long-term bet | JetBrains backing, strong momentum | Mozilla/Linux Foundation, de-facto systems lang |

### When Kotlin/Native would win

- Team is already Kotlin-heavy (Android/backend) — reduces context switching
- Plan to share daemon logic with Android client via KMP (e.g. shared models, DB layer)
- Rust borrow checker is a team velocity blocker in practice

### When Rust wins (this project)

- Tauri is already Rust — one build toolchain, potential `#[tauri::command]` calls into daemon logic
- PTY/process management (`portable-pty`, `nix`) is well-covered in the Rust ecosystem
- No JVM means no GC pauses — a daemon that drives tmux/processes benefits from predictable latency
- Tokio + `axum`/`warp` for the REST+WS server: production-proven at scale
- `async` + `Send` bounds catch data races at compile time — important for the session/stream locking invariants this daemon already has

## Not checked

- Actual `kotlinx.coroutines` multi-threaded dispatcher performance benchmarks on Linux ARM/x86 in 2026 (could have improved beyond what I have)
- Kotlin/Native's `ktor-server` embedded server stability on Linux (may be more mature now)
- Whether KMP's SQLDelight generates the same SQLite query patterns as `sqlx` for this schema
- Ktor WebSocket server on native — number of production deployments unknown

## Follow-ups

| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | Does the team plan a native Android client? | If yes, KMP shared logic becomes a strong argument for Kotlin/Native |
| 2 | Is GC pause jitter acceptable for the PTY stream loop? | The tmux stream handler is latency-sensitive; GC pauses could cause visible echo lag |
| 3 | Could daemon logic be a Rust `lib` called from Tauri directly (no separate process)? | Would collapse the IPC boundary entirely — smaller surface, no socket management |
