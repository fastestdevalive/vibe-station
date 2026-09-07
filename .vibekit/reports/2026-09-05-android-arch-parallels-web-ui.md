# Report: Android architecture parallels in vibe-station web-ui — and the KMP fit

**Date:** 2026-09-05 · **Commit:** cd70e5c · **Scope:** `web-ui/src/` layer mapping vs. vib-3 Android architecture doc · **Method:** file read + structural analysis

## Answer

- The web-ui already has all four layers Android uses — they just don't have the same names or the same boundaries
- The biggest structural gap is that **hooks own everything**: fetching, state, layout logic — Android splits these into Repository / ViewModel / Composable with enforced one-way flow
- Reshaping to Android-style architecture is **low friction for the data layer** (extract repos) and **higher friction for state** (Zustand is global; Android VMs are per-route scoped)
- **KMP extraction target, if ever done, is Repositories only** — ViewModel-layer is React hooks, which cannot be KMP

---

## The parallel map

| Android layer | Role | vibe-station equivalent | File(s) |
|---|---|---|---|
| **Repository** | Owns data access — network, DB, cache. Single source of truth per entity. | `api/client.ts` + `useServerSync.ts` | `api/client.ts:1197 LOC`, `hooks/useServerSync.ts` |
| **ViewModel** | Owns screen state, survives config change, exposes `StateFlow`. Never knows about View. | Feature hooks: `useChat`, `useLayout`, `useStore` selectors | `hooks/useChat.ts`, `hooks/useLayout.ts`, `hooks/useStore.ts` |
| **StateFlow / `uiState`** | The single observable emitted by the ViewModel | Zustand store slices (`useWorkspaceStore`, `useServerStore`) | `hooks/useStore.ts:577`, `hooks/useServerStore.ts:43` |
| **Composable** | Reads ViewModel state, emits events up | TSX components in `components/` | `components/layout/`, `components/chat/`, etc. |
| **SharedStateController** | Cross-feature state owned by one feature, consumed by others | Global Zustand store (everything shares it) | `useWorkspaceStore` — the whole store is effectively global |
| **Mediator** | Pure dispatch, zero owned state | `lib/` utilities (`statusColor`, `tiling`, `worktreeStatus`, `sessionLabel`) | `lib/tiling.ts`, `lib/statusColor.ts` |
| **`vm/` collaborators** | Private helpers constructed inside a ViewModel | Inline closures / local state inside hooks | — (no file boundary, lives inside the hook) |

---

## Key differences

| Dimension | Android | vibe-station web-ui |
|---|---|---|
| **Layer boundary enforcement** | Compiler + lint: ViewModel cannot hold a `shared/`-root class. Repository never imports ViewModel. | None — hooks call `api/client` directly and write to the global store in the same function |
| **Scope of state** | ViewModel is per-`NavBackStackEntry` (per-route). State dies with the route. | Zustand store is global. Everything reads the same flat store. |
| **Lifecycle** | ViewModel survives orientation change. Survives UI pause. | Hook state dies when component unmounts (unless Zustand persists it) |
| **Observable contract** | `StateFlow` is a hot stream. Collector can start anytime and gets the current value. | Zustand subscription is similar (`useStore(selector)`) — this one is close |
| **Reactivity granularity** | Per-field `StateFlow` on `SharedStateController` to avoid over-invalidation (§5 of arch doc) | Zustand `selector` per-call site — same idea, different syntax |
| **Repository as single source** | Repository is the only writer to its slice of truth; ViewModel reads via `StateFlow` | `useServerSync` writes to `useServerStore`; `useChat` also mutates state directly — two writers |
| **VM-private collaborators** | `vm/` directory — named `…State`/`…Controller`/`…Mediator`, survive ViewModel's lifetime | No equivalent — logic lives inline in the hook body |
| **Route-scoped ViewModel sharing** | Flow pattern (§4): one VM shared across a multi-step sub-router | Not present — multi-step flows would share Zustand slice or prop-drill |

---

## Where the current web-ui drifts most from Android style

1. **`useChat.ts` is a 555-line monolith that is simultaneously Repository + ViewModel**
   - It fetches from `api/client.ts` (Repository job) AND owns message state AND drives UI-visible logic
   - Android equivalent would be `ChatRepository` (network) + `ChatViewModel` (per-route state)

2. **`useStore.ts` at 1351 lines is the whole app's global ViewModel**
   - Android splits this into per-feature ViewModels scoped to their route
   - The Workspace layout state, session selection state, canvas state, tool panel state all live together

3. **`useServerSync.ts` is a background process hook, not a Repository**
   - It drives WebSocket subscriptions AND writes to `useServerStore` directly
   - Android: this would be a `Repository` with a coroutine scope and `StateFlow` — the ViewModel would just collect

4. **No enforced one-way data flow**
   - Components can import and write to the Zustand store directly (`useWorkspaceStore.getState().set...`)
   - Android: only the ViewModel writes to state; components only emit events

---

## What "Android-style" would look like for web-ui

```
Current shape:
  Component → useChat() → api/client (fetch + mutate)
                        → useWorkspaceStore (read + write)

Android-shaped:
  Component → useChatViewModel()  ← read-only observables (Zustand selectors)
                    ↓ events only (callbacks, no direct store writes)
              ChatViewModel        ← orchestrates
                    ↓
              ChatRepository       ← only thing that calls api/client
                    ↓
              ServerSyncService    ← WS subscription, writes to store
```

Concrete refactor steps (if ever pursued):

| Step | What changes | Effort |
|---|---|---|
| **1. Extract Repositories** | `SessionRepository`, `WorktreeRepository`, `ChatRepository` — each wraps its slice of `api/client.ts`. Nothing else imports `api/client` directly. | Medium |
| **2. Split `useStore.ts`** | Per-route/per-feature Zustand slices instead of one monolith. `useLayoutStore`, `useChatStore`, `useCanvasStore`. | Medium |
| **3. ViewModel hooks** | `useWorkspaceViewModel()`, `useChatViewModel()` — thin hooks that read from store slices and dispatch events to repositories. No direct `api/client` calls. | Medium |
| **4. One-way event flow** | Components call `viewModel.onSendMessage()`, never `useWorkspaceStore.getState().set...` directly. | High — touches every call site |

---

## KMP fit in this architecture

| Layer | KMP-shareable? | Notes |
|---|---|---|
| **Repositories** | ✅ Best target | Same HTTP + WebSocket calls on Android and web. `ktor-client` is the KMP HTTP client. Share `SessionRepository`, `ChatRepository`. |
| **Domain/model types** | ✅ Easy | `Session`, `Worktree`, `SessionState` etc. are plain data. KMP `data class` → replaces `api/types.ts`. |
| **ViewModel logic** | ⚠️ Possible but awkward | Android: `ViewModel` + `StateFlow`. Web: React hook wrapping `StateFlow` via `kotlin-wrappers`. Adds build complexity. |
| **UI (composables/TSX)** | ❌ No | Compose ≠ React. Write both separately — this is expected. |
| **WebSocket sync service** | ⚠️ Partially | Protocol parsing and state update logic is shareable. Platform WS connection is not. |

**The pragmatic slice if KMP is ever adopted:**
- Share: model types + repositories + domain logic (validation, status resolution)
- Keep separate: React hooks (web ViewModel), Compose ViewModels (Android), all UI

---

## Verdict on "keep web-ui separate vs. converge architecture"

- **Keep web-ui TSX as-is for UI** — no argument for Kotlin here
- **Converge on Repository pattern** regardless of KMP — it makes the web-ui easier to reason about on its own, and happens to be the exact layer KMP would target later
- **Don't rush ViewModel split** — Android-style per-route scoping is more valuable in a native app (config changes, back stack) than in a SPA where navigation is cheap
- **The refactor pays for itself** even without KMP: `useChat.ts` at 555 lines and `useStore.ts` at 1351 lines are the two places where bugs are hardest to trace right now

## Not checked

- Whether `useLayout.ts` / `useSubscription.ts` / `useServerStore.ts` follow a cleaner pattern than `useChat` (may already be closer to a Repository shape)
- Kotlin/JS `StateFlow` → React integration ergonomics in 2026 (may have improved with newer `kotlin-wrappers`)
- Whether `ktor-client` WebSocket on Kotlin/Native supports the vibe-station daemon's WS protocol out of the box

## Follow-ups

| # | Question | Why it matters |
|---|----------|----------------|
| 1 | Extract `SessionRepository` from `api/client.ts` as a first step — does it reduce `useChat.ts` significantly? | Proves the split is worth it before committing to it fully |
| 2 | If Android app comes, does it talk to the same daemon REST/WS API? | Yes → shared Repository is a direct win. No (different backend) → reconsider |
| 3 | Would per-route Zustand slices cause prop-drilling pain in the current component tree? | Determines whether step 2 above is medium or high effort |
