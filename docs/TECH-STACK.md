# vibe-station — Tech Stack Analysis

## Context Reminder
- Bottleneck: tmux/pty I/O + WebSocket streaming.
- Compute is light; concurrency + I/O matter.
- Implementor: Claude (AI). Ecosystem maturity matters.
- Future mobile app shares the repo.
- Design system is Vite + React (TS/JS).

---

## Option 1: Node.js Server + TypeScript CLI

### Pros
- Same language across web, server, CLI, mobile (RN).
- Massive ecosystem: `node-pty`, `ws`, `tmux.js`, `simple-git`.
- Best AI training data coverage by far.
- Trivial monorepo with pnpm/turbo/nx.
- Shared types between browser and server out of the box.
- Hot reload + dev DX is best-in-class.

### Cons
- Single-threaded; many ptys can stall event loop.
- Memory heavier than Rust/Go for many sessions.
- Native module pain (`node-pty` build issues on some hosts).
- Less elegant for a long-running daemon CLI.

### Scores
- AI-implementability: 5/5
- Dev speed: 5/5
- Runtime perf for this use case: 4/5 (pty I/O is async-friendly)

---

## Option 2: Rust Server + CLI

### Pros
- Best raw performance; ideal for many concurrent ptys.
- Strong types, memory safety, predictable runtime.
- `tokio` + `portable-pty` + `axum` + `tokio-tungstenite` are excellent.
- Single static binary for CLI distribution.

### Cons
- AI training data narrower than JS/Go; more footguns (lifetimes, async traits).
- Slower to iterate; compile times hurt loop speed.
- No language sharing with web/mobile -> duplicated types.
- Monorepo with web app needs cargo + pnpm side-by-side.
- Higher chance of AI generating subtly wrong async/borrow code.

### Scores
- AI-implementability: 3/5
- Dev speed: 2/5
- Runtime perf for this use case: 5/5 (overkill)

---

## Option 3: Go Server + CLI

### Pros
- Excellent concurrency model (goroutines) for pty fanout.
- Fast compiles, simple deployment, single binary.
- Good libs: `creack/pty`, `gorilla/websocket`, `go-git`.
- Strong AI training data; idiomatic Go is easy to generate.
- Lower footgun rate than Rust.

### Cons
- No language sharing with web/mobile.
- Generics/typing less expressive than TS for API contracts.
- Monorepo tooling split (go modules + pnpm).
- Less rich ecosystem for design-system / UI tooling.

### Scores
- AI-implementability: 4/5
- Dev speed: 4/5
- Runtime perf for this use case: 5/5

---

## Comparison Table

| Dimension              | Node/TS | Rust | Go |
|------------------------|---------|------|----|
| AI implementability    | 5       | 3    | 4  |
| Dev speed              | 5       | 2    | 4  |
| Runtime perf (this app)| 4       | 5    | 5  |
| Lang share w/ web      | 5       | 1    | 1  |
| Lang share w/ mobile   | 5       | 1    | 1  |
| Monorepo simplicity    | 5       | 2    | 3  |
| Distribution (CLI)     | 3       | 5    | 5  |

---

## Recommendation

**Choose Node.js + TypeScript across the board.**

### Rationale
- Bottleneck is async I/O, not CPU — Node handles this well.
- AI implementor performs best with TS/Node; fewer subtle bugs.
- One language for web, server, CLI, and future mobile (RN/Expo).
- Shared types eliminate API drift — huge win for AI-driven dev.
- Design system is already Vite/React; zero impedance mismatch.
- Distribution downside (Node CLI install) is mitigated by `bun` or `pkg`.
- Rust/Go gains in raw perf are not needed at expected scale.

### Escape Hatches
- If pty fanout becomes a bottleneck, extract CLI into a Rust/Go binary later. The local-daemon boundary is already an interface — swap in place.
- Keep the CLI bridge protocol language-neutral (JSON over local socket).

---

## Final Recommendation

### Chosen Stack
- **Language:** TypeScript everywhere.
- **Runtime:** Bun (server + CLI) for speed; Node fallback supported.
- **Frontend:** Vite + React + 100gb design system.
- **Server:** Hono (fast, edge-ready) or Fastify (mature).
- **WebSocket:** `ws` or Bun's native WebSocket.
- **PTY:** `node-pty` (Node) / Bun's `Bun.spawn` with pty support.
- **Tmux control:** shell out to `tmux` CLI; parse `-F` formatted output.
- **Git:** `simple-git` + raw `git worktree` calls.
- **State store:** SQLite via `better-sqlite3` (local CLI) + Postgres (server, optional).
- **Auth:** GitHub OAuth + short-lived JWTs for CLI.

### Mobile (Future)
- Expo + React Native; reuse `packages/shared-types` and `packages/agent-modes`.

### Monorepo Tool
- **pnpm workspaces + Turborepo.**
  - pnpm: efficient disk + strict deps.
  - Turborepo: fast incremental builds, remote cache, simple config.
  - Alternative: Nx (heavier, more features) — overkill for this scope.

### Repo Layout (recap)
```
apps/{web,server,cli,mobile}
packages/{design-system,shared-types,agent-modes}
```
