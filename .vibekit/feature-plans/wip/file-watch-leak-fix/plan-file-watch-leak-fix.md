# Plan: fix the `file:watch` leak (same shape as the tree:watch leak, unfixed)

## 1. Problem (confirmed via code reading, mirrors the already-fixed tree:watch bugs)

`docs/FILE-SEARCH-LIFECYCLE.md` §1/§6 noted `file:watch` has "no global dedup
and no disconnect-release" as a known, deliberately-out-of-scope gap, on the
theory that it only affects *live* reload convenience, not correctness —
because `FilePreviewPane`'s content fetch is unconditional on every mount/
path change regardless of watch health. That reasoning is correct for the
*mount* case, but wrong for the *steady-state* case: while a file is already
open and the user does not navigate away, the ONLY thing that refreshes it
is a `file:changed` push, and that watcher can die silently with zero UI
signal. This is the actual root cause of a user-reported bug: "at times I
don't see the latest data for the opened file," intermittent, self-heals if
you switch files and come back (which is exactly what a mount-triggered
fresh fetch would do).

Three confirmed issues, same shapes as tree:watch's pre-fix bugs:

**Bug 1 — never released on disconnect (leak).**
`rust/vst-daemon/src/server.rs`'s socket teardown calls
`release_connection_tree_watches` but has no equivalent call for file
watches. `WsConnection::cleanup()` (`rust/vst-ws/src/connection.rs`) only
clears the connection's *local* `file_watches` map — it never touches the
shared `WatcherRegistry` or calls `.close()` on anything. `FileWatcher` has
no `Drop` impl (only an explicit `.close()` in `streams/file_watcher.rs`
actually releases the inotify fd — the watch loop's own spawned task holds a
strong `Arc` keeping it alive regardless of what the registry does). Result:
every disconnect that isn't a graceful `file:unwatch` (reload, crashed tab,
lost socket, sleep/wake) leaks one inotify instance, permanently, for the
daemon's uptime.

**Bug 2 — per-connection dedup gate, but a global unconditional registry
insert (cross-connection overwrite).**
`handle_file_watch` (`rust/vst-ws/src/handlers/file_watch.rs`) checks
`conn.retain_file_watcher(&key)` — local to the calling connection only —
then unconditionally does `registry.watchers.insert(key, SharedWatcher {
ref_count: 1, .. })` if that check misses, even if ANOTHER connection
already has a live watcher for the exact same key. This orphans the first
connection's watcher (same failure shape as tree:watch's pre-fix "cause B")
and additionally means `handle_file_unwatch`'s later
`registry.watchers.remove(&key)` + `.close()` can close a watcher a
DIFFERENT, still-active connection believes it owns.

**Bug 3 — client-side reconnect-replay isn't refcounted, and doesn't
catch up on the outage window.**
`web-ui/src/api/client.ts`'s WS reconnect handler already knows the daemon
loses per-connection state on a drop and replays `file:watch` (and
`tree:watch`) for whatever's in its local `fileWatches`/`treeWatches` Maps —
this exists specifically to counter the daemon-side state loss. Two gaps:
(a) those Maps are plain (not refcounted), so a `*:unwatch` from ANY one
consumer deletes the replay entry even if another mounted consumer still
needs it — low-risk for `file:watch` today (single consumer,
`FilePreviewPane`) but real for `tree:watch` (multiple simultaneous
consumers per `docs/FILE-SEARCH-LIFECYCLE.md` §5); (b) the replay only
resumes *live* updates going forward — it never triggers a one-time re-fetch
of currently-open content to catch anything that changed *during* the
disconnected window.

**Also:** `ServerMessage::SystemError` (what a failed `file:watch`/
`tree:watch` sends back, e.g. once accumulated leaks exhaust the OS's
`fs.inotify.max_user_instances`) is never subscribed to anywhere in the UI —
confirmed via grep, it exists only as a type definition
(`web-ui/src/api/types.ts`). A watch that fails to establish is currently
invisible to the user.

## 2. Fix design

Mirror the already-shipped `tree:watch` fix as closely as the code shape
allows — same `WatcherRegistry`/`SharedWatcher` types are already shared
between `file_watch.rs` and `tree_watch.rs` (`subscribers: HashMap<String,
WsConnection>` already exists on `SharedWatcher`, currently left empty for
file watchers per a comment noting it's unused there — this plan makes it
used).

1. **Global shared dedup + subscriber fan-out for `file:watch`.** In
   `handle_file_watch`: before spawning, check the shared registry (not just
   the per-connection map) for an existing entry for the key; if found,
   increment `ref_count`, insert this connection into `subscribers`, return
   — no new `FileWatcher`. The existing `on_changed`/`on_deleted`/`on_error`
   callbacks must look `subscribers` up fresh per event (same pattern
   `tree_watch.rs`'s `tree_watch_subscribers` helper already established —
   reuse or mirror it) instead of capturing one connection at creation time.
2. **Release on disconnect.** Add `release_connection_file_watches`,
   mirroring `release_connection_tree_watches` exactly (including its
   "release the connection's entire local hold on a key in one step, not
   once per local subscriber" fix — re-derive the same reasoning for file
   watches, don't reintroduce the tree:watch over-release bug in the new
   code). Wire it into `vst-daemon/src/server.rs`'s socket teardown,
   alongside (before, same ordering rationale) the existing
   `release_connection_tree_watches` call.
3. **Client-side: refcount `fileWatches`/`treeWatches` in `client.ts`.**
   Track a count per key, not just presence; only delete the replay-map
   entry when a key's count reaches zero. (Small, but do it for both maps
   while touching this file, since `tree:watch` already has multiple
   legitimate concurrent consumers today and is exposed to the same
   class of bug.)
4. **Reconnect catch-up fetch.** When `FilePreviewPane`'s `useFileWatch`
   (re)establishes its subscription — including specifically right after a
   WS reconnect, not just on mount — trigger one fresh fetch, so content
   that changed during a disconnected window isn't left stale until the
   next live edit or a manual navigation. Reuse the EXISTING connection-
   state API — `api.getConnectionState()` / `api.subscribeConnection(handler)`
   (`web-ui/src/api/client.ts`, `ConnectionState = "online" | "connecting" |
   "offline"`) — do not invent a parallel signal. `FilePreviewPane`'s
   content-fetch effect already has `lastChanged`/`treeLastChanged` in its
   dependency array as precedent for "external signal triggers a refetch
   while mounted"; add a piece of state that flips on an "offline" →
   "online" transition (via `subscribeConnection`) as an additional
   dependency the same way — don't restructure the effect, don't refetch on
   every "online" (e.g. the initial mount's own first "online"), only on an
   actual offline→online transition while already mounted.
5. **Surface `system:error` somewhere.** At minimum, a console warning so a
   dead/failed watch isn't completely invisible — this repo's other error
   handling patterns (check how other `SystemError`-adjacent daemon
   messages are surfaced, if any are) should guide the exact shape; don't
   over-build a toast/notification system for this if nothing like that
   exists yet for comparable messages.

## 3. Phases

- [ ] **Phase 0 — regression tests proving bugs 1 and 2, before fixing.**
  Mirror `tree_watch.rs`'s own Phase-0-style tests
  (`two_connections_watching_same_tree_share_one_watcher`,
  `disconnecting_connection_with_two_local_subscribers_does_not_over_release_shared_ref`)
  but for `file:watch`. Confirm they fail against current code.
- [ ] **Phase 1 — shared dedup + subscriber fan-out** (fix design point 1).
- [ ] **Phase 2 — disconnect release** (fix design point 2), correctly
  avoiding the over-release shape the tree:watch fix had to correct.
- [ ] **Phase 3 — client-side refcounting** (fix design point 3).
- [ ] **Phase 4 — reconnect catch-up fetch** (fix design point 4).
- [ ] **Phase 5 — surface `system:error`** (fix design point 5).
- [ ] **Phase 6 — verification.**
  - Rust: full `vst-ws`/`vst-daemon`/`vst-routes` test suite + clippy, via
    Docker (`rust:1.98.1-bookworm` — host glibc is too new for a direct
    build): `docker run --rm -v "$PWD":/w -w /w -v cargo-registry-cache:/usr/local/cargo/registry -e CARGO_TARGET_DIR=/w/target-docker rust:1.98.1-bookworm cargo test -p vst-ws -p vst-daemon -p vst-routes` (swap `test` for `build` / add `clippy` as needed) from `rust/`.
  - UI: `tsc`, `eslint`, and the relevant vitest suites for
    `FilePreviewPane.tsx`, `useSubscription.ts` (`useFileWatch`), and
    `client.ts`'s reconnect-replay logic.
  - Manual/live sanity in the dev sandbox: reproduce the leak the same way
    the tree:watch fix was verified (`/proc/<pid>/fdinfo`, watch a file,
    disconnect without `file:unwatch`, confirm the fd count returns to 0
    instead of accumulating across repeated cycles); confirm two
    connections/tabs watching the same file both receive live updates.

## 4. Explicitly in scope vs. out

- **In scope:** everything above — this is the direct sibling of the already
  -shipped `tree:watch` fix, same registry, same failure shapes.
- **Out of scope:** don't touch `tree:watch` itself again (already fixed and
  reviewed); don't build a general-purpose toast/notification system for
  Phase 5 beyond what's proportionate; don't change `FilePreviewPane`'s
  content-fetch-on-mount logic (already correct — see
  `docs/FILE-SEARCH-LIFECYCLE.md` §6, verified independently twice).
