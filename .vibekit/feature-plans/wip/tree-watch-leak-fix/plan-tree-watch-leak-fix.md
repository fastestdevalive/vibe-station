# Plan: fix leaked tree-watchers, and re-freshen the file-search index on reopen

## 1. Problem (confirmed, not hypothesized)

Verified live via `/proc/<daemon-pid>/fdinfo`: a single daemon process had **9
separate inotify file descriptors** all watching the same worktree
(`fsd-1`) simultaneously, after normal navigate-away / reconnect / restart
cycles — no code path ever closes them.

Two distinct root causes, both in `rust/vst-ws/src/handlers/tree_watch.rs`:

**Cause A — no watcher is ever released when a connection dies.**
`rust/vst-ws/src/server.rs`'s WS loop has no on-disconnect handler that
iterates a closing connection's held tree watches and releases them. The
*only* release path is an explicit `tree:unwatch` client message. A page
reload, a crashed tab, a lost network connection, or (in dev) a daemon
container restart all skip that message — the watcher just leaks forever.

**Cause B — the watcher registry is deduped per-connection, not globally.**
`handle_tree_watch`'s reuse check (`conn.retain_tree_watcher(&watch_key)`)
only consults the CALLING connection's own bookkeeping map. A second,
unrelated connection watching the *same* worktree doesn't find or retain the
first connection's watcher — it spawns a brand new `FileWatcher` and
overwrites the shared `registry`'s entry for that key. The first watcher's
background task (`FileWatcher::spawn`'s `tokio::spawn` loop) holds its own
`Arc` clone of its internals, so overwriting the registry slot does not stop
it — it keeps running, feeding `FileSearchIndex` forever, with no reachable
handle left to close it. Every reconnect to an already-watched worktree
leaks one more of these.

**Consequence for freshness:** because leaked watchers never stop, the
*current* (buggy) system happens to keep `FileSearchIndex` fresh by
accident — this is why Quick Open never actually showed stale results in
testing. Fixing the leak removes that accidental safety net: once a
worktree's watcher is *correctly* closed when nobody is subscribed, a file
created during that gap won't be seen by `insert()`/`merge_subtree()`
(nothing is listening), and `FileSearchIndex::populate()` never re-walks a
worktree it already has an entry for (see `rust/vst-ws/src/services/file_search.rs`).
So the leak fix and the "stay fresh on reopen" fix are one change, not two —
see Phase 3.

## 2. Fix design

1. **Make the registry itself refcounted and shared**, instead of a
   per-connection dedup gate. `WatcherRegistry` (currently
   `Mutex<HashMap<watch_key, Arc<FileWatcher>>>` in
   `rust/vst-ws/src/handlers/file_watch.rs`) gains a count alongside the
   `Arc<FileWatcher>`. `handle_tree_watch` checks the *global* registry
   first: an existing live entry just increments the shared count and
   returns (no new `FileWatcher`, no new inotify fd); only a genuinely new
   key spawns one. `conn`'s own per-connection map still exists (needed to
   know what to release when *this* connection goes away) but the
   authoritative refcount and the `Arc<FileWatcher>` move to the shared
   registry.
2. **Release on disconnect, not just on explicit unwatch.** Add a
   connection-teardown step (wherever `vst-ws/src/server.rs`'s WS loop
   detects the socket closed) that iterates every `watch_key` the closing
   connection was still holding and runs the exact same release path
   `handle_tree_unwatch` uses — decrement the shared count, and on
   reaching zero, `spawn_blocking` the `watcher.close()` + remove from the
   registry, exactly as today's explicit-unwatch path does.
3. **Evict the `FileSearchIndex` entry when a worktree's last watcher
   closes.** In the same "count reached zero, watcher closed" branch from
   (2), also call a new `FileSearchIndex::evict(worktree_id)` (removes the
   `HashMap` entry entirely — not just clears it, so `populate()`'s
   `!idx.contains_key(...)` check is true again). No new reconciliation
   logic needed: this makes the *existing*, already-tested
   "unpopulated worktree → full lazy disk walk on first query" path in
   `populate()` fire again automatically, the next time anyone queries or
   reopens that worktree. That's the direct answer to "how do I make sure
   I can search for new files when I open it again" — the index doesn't
   try to reconcile stale state, it just forgets it existed and re-derives
   it from disk, the same way a never-before-seen worktree already works
   today (covered by `unknown_worktree_lazily_fills_from_disk` in
   `file_search.rs`'s existing tests).
4. **Scope the eviction correctly.** A worktree can have more than one
   `tree:watch` registration (root tree + individually-watched
   subdirectories all feed the same `FileSearchIndex` entry via
   `apply_tree_change`). Evict only when the count of *all* live watchers
   for that `worktree_id` (across every `tree_path`) reaches zero — not
   when one particular `(worktree_id, tree_path)` key's count reaches zero.
   This likely means tracking a small `HashMap<worktree_id, usize>`
   side-counter (increment/decrement alongside the per-`watch_key` registry
   entries), separate from the existing per-key refcount, so a subdir watch
   closing doesn't evict an index that the root watch is still feeding.

## 3. Phases

- [ ] **Phase 0 — regression test proving the leak, before touching fix code.**
  Add a `vst-ws` test that: opens two separate `WsConnection`s, both send
  `tree:watch` for the same `worktree_id`/root path, both then disconnect
  (or send `tree:unwatch`). Assert the registry ends up with **zero** live
  watchers and the `FileSearchIndex` entry for that worktree is gone. This
  test must FAIL against current `main` (proving it reproduces cause B) —
  confirm that before writing the fix.
- [ ] **Phase 1 — fix cause B: global, shared refcount in `WatcherRegistry`.**
  `rust/vst-ws/src/handlers/file_watch.rs` (shared type) +
  `rust/vst-ws/src/handlers/tree_watch.rs` (`handle_tree_watch`,
  `handle_tree_unwatch`). Existing per-connection `retain_tree_watcher` /
  `release_tree_watcher` bookkeeping in `connection.rs` stays (still needed
  to know what a given connection is holding) but no longer gates whether a
  new `FileWatcher` gets spawned.
- [ ] **Phase 2 — fix cause A: release on disconnect.**
  `rust/vst-ws/src/server.rs`'s connection loop: on socket close, iterate
  `conn.tree_watch_keys()` (mirrors the existing `file_watch_keys()`
  pattern) and release each through the same shared-refcount path from
  Phase 1.
- [ ] **Phase 3 — evict `FileSearchIndex` on last-watcher-close.**
  `rust/vst-ws/src/services/file_search.rs`: add `evict(worktree_id)`.
  Wire it into the "shared count hit zero" branch from Phases 1–2, scoped
  per-`worktree_id` per point 4 above.
- [ ] **Phase 4 — verification.**
  - Unit/integration tests: Phase 0's test now passes; add one for the
    subdirectory-watch-shouldn't-evict-while-root-watch-is-live case (point
    4); add one for "evicted worktree's next search() does a fresh walk and
    finds a file added during the gap" (extends the existing
    `unknown_worktree_lazily_fills_from_disk` pattern).
  - Manual QA in the dev sandbox, repeating this session's own `/proc/<pid>/fdinfo`
    check: watch a worktree, navigate away, confirm (after Phase 2) the
    inotify fd count for that worktree's inodes drops to zero; create a
    file while at zero; reopen; confirm Quick Open finds it and exactly one
    fresh inotify fd reappears (not a growing pile).

## 4. Explicitly out of scope

- `file_watch.rs`'s single-file watcher (`watch_file`, used for the open
  file preview's live-reload) may have the same per-connection-vs-global
  dedup issue — not touched here; file it separately if this pattern
  confirms it.
- No client/UI changes — this is entirely `rust/vst-ws` + `rust/vst-routes`
  wiring; `useFileSearch.ts`/Quick Open behavior is unaffected and needs no
  changes.
