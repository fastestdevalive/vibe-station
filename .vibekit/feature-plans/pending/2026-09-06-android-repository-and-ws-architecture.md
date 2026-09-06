# Report: Android architecture for the Repository pattern + WS event handling

**Date:** 2026-09-06 · **Scope:** how `web-ui`'s new `SessionRepository`/`WorktreeRepository`/`ChatRepository` + WebSocket event handling would look ported to Android under the `android-coding` skill + `coding-agent-guardrails` · **Method:** discussion, no code written · **Follow-up to:** [`2026-09-05-android-arch-parallels-web-ui.md`](./2026-09-05-android-arch-parallels-web-ui.md) and the `repository-pattern` feature ([plan](../feature-plans/wip/repository-pattern/plan-repository-pattern.md))

## Answer

- The Repository half of the web-ui refactor ports almost verbatim — same 3 repositories, same domain split, same "thin wrapper, no logic" shape
- The WS half gets **simpler** in Kotlin: `SharingStarted.WhileSubscribed` replaces the hand-rolled ref-counting maps (`subRefs`/`chatSubs`) in `client.ts`
- `Result<T>` at the repository boundary forces a network-safety contract (`android-coding` §14) that `client.ts` handles more loosely (throw + catch at the call site)
- `useServerSync`'s job splits across two Android layers, not one hook — its per-screen refetch becomes ViewModel-owned; its cross-screen cache becomes a repository-owned `StateFlow`, since there's no single app-wide store like `useServerStore`
- Today's TS `chatRepo.on("session:message", ...)` is a raw, unfiltered pass-through (filtering by sessionId happens in `useChat.ts`) — that's an artifact of the PR's zero-new-logic constraint, not the target shape. A proper port pushes entity-id filtering **into the repository** (`observeChat(sessionId)`), not the ViewModel — see § below

---

## Layer mapping

| web-ui (this repo) | Android equivalent | Why |
|---|---|---|
| `client.ts`'s `ws`/`listeners` Map/`chatSubs`/`subRefs` closure | `WsConnectionManager` — `@Singleton` | App-wide connection state must outlive any one screen, same reason it's module-level in `client.ts`, not per-hook |
| `api.on(type, handler)` multiplexer | `SharedFlow<WsEvent>` on the manager | Kotlin's idiomatic multiplexed stream — one flow, consumers `filter`/`filterIsInstance` instead of a `Map<String, Set<Handler>>` |
| `SessionRepository`/`WorktreeRepository`/`ChatRepository` (TS) | Same names, `@Singleton` Kotlin classes | `android-coding` §3: "split by domain concern" — this is the one part of the report's parallel map that transfers almost unchanged |
| `subRefs`/`chatSubs` ref-counting | `SharingStarted.WhileSubscribed(...)` | Kotlin gives ref-counted subscribe/unsubscribe for free — the one place Android is actually *less* code than the TS |
| `useChat`/`useServerSync` hooks | `ChatViewModel`/per-screen ViewModels | `android-coding` §4: one VM per route, never shared down the tree |
| `ApiInstance` (real/mock union) | Repository behind an interface | `android-coding` §3's "isolate Android-specific APIs behind a small interface" — same fakeability motive as `mock.ts` |

---

## The WS layer

```kotlin
// core/network/WsConnectionManager.kt — @Singleton, survives every screen
class WsConnectionManager @Inject constructor(
    private val client: OkHttpClient,
    @IoDispatcher private val io: CoroutineDispatcher,
) {
    private val scope = CoroutineScope(SupervisorJob() + io)
    private val _events = MutableSharedFlow<WsEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<WsEvent> = _events.asSharedFlow()   // the "*" listener, always-on

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Offline)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    // Reconnect/backoff + resubscribe-on-open state — same shape as chatSubs/subRefs
    // in client.ts, because it's the same problem: daemon's per-connection state
    // (chat subs, watches) doesn't survive a socket drop.
    private val chatSubs = mutableMapOf<String, Long?>()  // sessionId -> sinceSeq cursor
    private var backoffMs = 1_000L

    fun send(payload: WsOutgoing) { /* ws?.send(json); no-op if not connected */ }

    private fun onOpen() {
        backoffMs = 1_000L
        _connectionState.value = ConnectionState.Online
        chatSubs.forEach { (sid, since) -> send(WsOutgoing.ChatOpen(sid, since)) }
        _events.tryEmit(WsEvent.WsOpen)   // same signal useServerSync's ws:open triggers off
    }

    private fun onClose(code: Int) {
        _connectionState.value = ConnectionState.Offline
        if (code == 4401) { _events.tryEmit(WsEvent.AuthExpired); return }  // no reconnect
        scope.launch { delay(nextBackoff()); ensureConnected() }
    }
}
```

The one genuinely nicer thing versus the TS version: `client.ts` hand-rolls ref-counting (`subRefs.get(id) ?? 0`, increment/decrement, "0→1 sends subscribe, 1→0 sends unsubscribe" — `web-ui/src/api/client.ts:856-884`, `:1071-1099`). In Kotlin that behavior comes from the `Flow` machinery itself:

```kotlin
// ChatRepository.kt
fun observeChat(sessionId: String): Flow<ChatEvent> =
    wsManager.events
        .filterIsInstance<ChatEvent>()
        .filter { it.sessionId == sessionId }
        .onStart { wsManager.send(WsOutgoing.ChatOpen(sessionId)) }        // first collector → chat:open
        .onCompletion { wsManager.send(WsOutgoing.ChatClose(sessionId)) } // last collector leaves → chat:close
        .shareIn(scope, SharingStarted.WhileSubscribed(stopTimeoutMillis = 5_000), replay = 0)
```

`WhileSubscribed` counts active collectors and only runs `onStart`/`onCompletion` on the 0→1 / 1→0 transitions — exactly the `chatSubs.get(sessionId)?.refs` bookkeeping in `client.ts:856-884`, just built into the flow operator instead of a hand-maintained `Map`. The `stopTimeoutMillis` grace period also solves the same problem the TS `subRefs` map was reasoning about ("two components tiling the same session shouldn't have one's unmount close the other's subscription") — a screen rotation or a brief re-navigation doesn't tear down the subscription immediately.

---

## Where does `chatRepo.on("session:message", ...)`-style filtering go — manager or repository?

Two different things are easy to conflate here, and today's TS code and this Android sketch actually make **different** choices about the second one:

| Responsibility | Lives in | Why |
|---|---|---|
| Raw dispatch — "a WS message arrived, fan it out to whoever's listening" | `WsConnectionManager` (`events: SharedFlow<WsEvent>`) | Exactly one WebSocket connection app-wide → exactly one place owns "message arrived." Direct equivalent of `client.ts`'s `listeners` Map + `emit()` |
| Filtering by event type **and** by entity id (e.g. "only `session:message` events for *this* `sessionId`") | **Repository**, not ViewModel — in this sketch | See below |

**Today's TS `ChatRepository.on` is a pure identity forward — `on: api.on` — with *zero* filtering.** All of the filtering happens one layer up, in `useChat.ts` itself (`if (e.type !== "session:message" || e.sessionId !== sessionId) return;`, `web-ui/src/api/client.ts`-consumer side). That was a deliberate constraint of the `repository-pattern` PR — Decision 1 there says "pure pass-through, no new logic," because the whole point of that change was to be behavior-identical. A **literal** 1:1 port of that shape would look like:

```kotlin
// literal port of today's TS shape — filtering stays in the ViewModel, same as useChat.ts today
fun on(type: WsEventType): Flow<WsEvent> = wsManager.events.filter { it.type == type }
// ChatViewModel then filters by sessionId itself, exactly like useChat.ts's `if (e.sessionId !== sessionId) return`
```

**But the sketch above (`observeChat(sessionId)`) does NOT do that — it puts the sessionId filter inside the repository, on purpose:**

```kotlin
fun observeChat(sessionId: String): Flow<ChatEvent> =
    wsManager.events
        .filterIsInstance<ChatEvent>()
        .filter { it.sessionId == sessionId }   // ← filtering lives HERE, not in the ViewModel
        .onStart { wsManager.send(WsOutgoing.ChatOpen(sessionId)) }
        .onCompletion { wsManager.send(WsOutgoing.ChatClose(sessionId)) }
        .shareIn(scope, SharingStarted.WhileSubscribed(stopTimeoutMillis = 5_000), replay = 0)
```

**Why the repository is the right home, not a mechanical detail:** "give me the events relevant to entity X" is exactly what a Repository's query surface is for — Android's Repository is defined as "single source of truth per entity," and `observeChat(sessionId)` *is* that entity-scoped query, the same conceptual shape as `observeSession(sessionId): Flow<Session>` would be for a REST-backed entity. Pushing that filter back into the ViewModel (the literal-port version) recreates the exact problem that makes `useChat.ts` feel like a grab-bag today — the consumer doing its own `if (e.sessionId !== sessionId) return` inline is Repository-shaped logic leaking into the ViewModel layer.

**Bottom line:** if the goal is a genuinely thin ViewModel (as opposed to a mechanical, behavior-preserving TS→Kotlin translation), give the Repository a real `observeChat(sessionId)`-shaped method — filtering included — instead of a raw `on(type, handler)` pass-through. The current TS `chatRepo.on = api.on` shape should **not** be carried forward as-is if the web-ui code is ever reoriented this way; it's an artifact of that PR's zero-new-logic constraint, not the target shape.

---

## Repository layer (`android-coding` §14, network safety)

```kotlin
// data/repository/SessionRepository.kt — @Singleton
class SessionRepository @Inject constructor(
    private val api: DaemonApi,          // Retrofit interface — REST
    private val wsManager: WsConnectionManager,
) {
    val sessionEvents: Flow<SessionEvent> = wsManager.events.filterIsInstance()

    suspend fun listSessions(worktreeId: String?): Result<List<Session>> = withContext(Dispatchers.IO) {
        try {
            Result.success(api.listSessions(worktreeId))
        } catch (e: IOException) {
            Timber.w(e, "listSessions failed"); Result.failure(e)
        }
    }
}
```

Every repository method returns `Result<T>` and never throws past the boundary (§14) — a stricter contract than the TS `ApiError`-throwing style, since `useChat.ts`'s callers get to `try/catch` at the call site but a Kotlin `ViewModel` calling a repo that could crash a coroutine scope is a real production crash, not a caught promise rejection.

---

## ViewModel / Screen (per-route, §4-5)

```kotlin
// feature/chat/ChatViewModel.kt
@HiltViewModel
class ChatViewModel @Inject constructor(
    private val chatRepo: ChatRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val sessionId: String = savedStateHandle["sessionId"]!!
    private val _uiState = MutableStateFlow<ChatUiState>(ChatUiState.Loading)
    val uiState: StateFlow<ChatUiState> = _uiState.asStateFlow()

    init {
        chatRepo.observeChat(sessionId)
            .onEach { event -> /* fold into _uiState, same reducers useChat.ts's api.on handlers do */ }
            .launchIn(viewModelScope)
    }
}
```

```kotlin
// feature/chat/ChatScreen.kt
@Composable
fun ChatScreen(sessionId: String) {
    val viewModel: ChatViewModel = hiltViewModel()
    val state by viewModel.uiState.collectAsStateWithLifecycle()   // never collectAsState()
    // ...
}
```

---

## Where this diverges from the current web-ui shape

- **`useServerSync`'s job splits across two Android layers, not one hook.** Its "refetch bundle on mount + on ws:open" half becomes each screen's ViewModel calling its own repository on `init`; its "incremental WS reducers write to a shared store" half doesn't really have a home in `viewModelScope`-per-route Android — there's no single app-wide Zustand-equivalent store to patch. A cross-screen "worktree list is always fresh" cache (what `useServerStore` gives the web app for free) becomes a repository-owned `StateFlow` that outlives any one ViewModel (a `SharedFlow` with `replay = 1`, or a small in-memory cache in the repository itself) — which is actually closer to Android orthodoxy than the web app's global store is.
- **File placement:** repositories + `WsConnectionManager` live in a shared `data/`/`core/network/` module (they're app-wide singletons), not inside any `feature/<name>/` directory — mirrors how `api/repositories/` sits outside any component tree in the web-ui refactor.
- **No 4th-repository temptation.** Same Decision-4 boundary as the web-ui plan would apply — `ProjectRepository`/auth/connection-state stuff stays separate from Session/Worktree/Chat, for the same "don't invent scope" reason.

---

## Not checked

- Whether Hilt or Koin is the project's actual DI framework (`android-coding` §6 — "use whichever the project already uses, never migrate without an explicit request") — this doc used Hilt annotations as illustration only
- Concrete `WsEvent`/`WsOutgoing` sealed-class shapes — would need to mirror `WSEvent` in `web-ui/src/api/types.ts` field-for-field
- Whether `stopTimeoutMillis` tuning (5s used above) matches the web app's actual multi-tile-same-session dwell time in practice
