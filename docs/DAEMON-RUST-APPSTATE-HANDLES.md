# Daemon Rust Port — AppState / handle convention

Part `00` ships the one convention every crate follows so the eight-plus later
parts don't each choose a different way to expose a handle (arch Gotcha #14).
Every later part's plan copies this verbatim rather than restating or
reinventing it.

## The rule

> Every crate's public handle is **`pub struct XHandle(Arc<Inner>)`**,
> `#[derive(Clone)]`, constructed by taking its own dependencies as
> **already-constructed handles**. No crate reaches for a global
> `static`/`OnceLock` to get a dependency.

- **`Inner` is private** to the crate. `XHandle` is the only public entry
  point; it derefs or exposes methods over `Inner`. This mirrors the TS
  module-level singleton pattern but makes ownership explicit and injectable.
- **`#[derive(Clone)]`** on the handle so it can be cheaply passed around and
  shared across `tokio::spawn` boundaries (the `Arc` makes it `Send + Sync`).
- **Dependencies are constructor arguments.** `XHandle::new(dep_handle: &DepHandle, ...)`.
  Nothing is reached for globally. The only crate that *wires* handles together
  is `vst-daemon`'s `main` (part `08`), via `AppState`.

### Why not a global / `OnceLock`?

The TS daemon used module-level singletons (`directPtyRegistry`,
`broadcastAll`, etc.). In Rust a `static`/`OnceLock` recreates hidden global
state that is impossible to test in isolation, impossible to share across the
`vst-ws`/`vst-routes`/`vst-lifecycle` boundary without an `Arc`, and hostile to
the `rust-coding` skill's §3 (no `unsafe impl Send`; explicit sharing). Passing
handles as constructor args makes every dependency visible and testable.

## `AppState`

`vst-routes`' `fn router(state: AppState) -> Router` receives an `AppState`
that holds the already-constructed handles it needs:

```rust
#[derive(Clone)]
pub struct AppState {
    pub store: vst_store::StoreHandle,
    pub git: vst_git::GitHandles,        // e.g. WorktreeServiceHandle + ProjectServiceHandle
    pub agents: vst_agents::AgentRegistryHandle,
    pub lifecycle: vst_lifecycle::LifecycleHandle,
    pub ws: vst_ws::WsHandle,
    pub broadcaster: vst_types::Broadcaster,
}
```

`vst-daemon::main` (part `08`) constructs every handle in dependency order and
fills `AppState`. Crate modules never import `resolvePlugin`/`resolveJsonAgent`
by themselves — the resolved plugin is passed in as a handle (arch System
Boundaries: "services never import `resolvePlugin`").

## Per-crate handle names (filled in by later parts)

| Crate | Handle (typical) | Notes |
|-------|------------------|-------|
| `vst-store` | `StoreHandle` | owns the single SQLite writer thread (part `01`) |
| `vst-proc` | `PtyHandle` | behind `PtyBackend` trait (part `02`) |
| `vst-git` | `WorktreeServiceHandle`, `ProjectServiceHandle` | part `03` |
| `vst-agents` | `AgentRegistryHandle` | part `04a` |
| `vst-lifecycle` | `LifecycleHandle` | takes a `Broadcaster` (part `05`) |
| `vst-ws` | `WsHandle` | owns the broadcaster receiver side (part `06`) |
| `vst-routes` | `AppState` (above) | axum `Router` (part `07`) |
| `vst-daemon` | `main()` | wires all handles (part `08`) |

> The names above are guidance, not a contract — each part's own plan fixes
> the exact handle type name. The *convention* (newtype over `Arc<Inner>`,
> `Clone`, dependency-injected, no globals) is the contract.

## Checklist for a new handle

- [ ] `pub struct XHandle(Arc<Inner>);`
- [ ] `#[derive(Clone)]`
- [ ] `Inner` is private; `XHandle` exposes public methods over it
- [ ] Constructor takes dependencies as already-built handles (never builds
      them from a global)
- [ ] `XHandle` is `Send + Sync` (satisfied automatically by `Arc<Inner>` when
      `Inner: Send + Sync`)
- [ ] No `unsafe impl Send`/`Sync`, no `static`/`OnceLock` dependency access
