# File Search Lifecycle

**Living doc.** This tracks how the server-driven file-search mechanism actually
works today — the index, the watchers that keep it fresh, and the two closely
related but distinct watch types. Update it whenever this area changes; it is
meant to stay the map, not a point-in-time design note (see
`.vibekit/feature-plans/wip/` for the phased implementation plans this doc is
distilled from).

---

## 1. The two watch types — don't conflate them

| | `tree:watch` | `file:watch` |
|---|---|---|
| Scope | A whole worktree (or a subdirectory of one) | One exact file path |
| Consumers | `FileTreeSidebar`, `FilePreviewPane` (both, whenever mounted), `QuickOpen` (while open) | `FilePreviewPane`, for whichever file is currently the *active* tab |
| Feeds | `FileSearchIndex` (server-side filename index) + `tree:changed` push (sidebar/preview live refresh) | `file:changed`/`file:deleted` push only (live-reload the file you're looking at) |
| Registry | `rust/vst-ws/src/handlers/file_watch.rs`'s `WatcherRegistry` — **globally shared and refcounted** across connections (fixed; see §3) | Same `WatcherRegistry` type, and **now also globally deduped and refcounted** — a `file:watch` for a path another connection already watches reuses that watcher and adds a subscriber instead of spawning a fresh `FileWatcher`/inotify fd (mirrors the tree:watch cause-B fix; see §3, `.vibekit/feature-plans/wip/file-watch-leak-fix/`) |
| Released on disconnect? | Yes (`release_connection_tree_watches`, wired into the daemon's socket teardown) | **Yes** — `release_connection_file_watches`, wired into the daemon's socket teardown right before the tree-watch release. A dead connection no longer leaks its file watcher(s); previously only an explicit `file:unwatch` released one. |
| Correctness if it leaks/is stale | **Matters.** `FileSearchIndex` is a server-side cache — see §2, §4. | **Doesn't matter for correctness on mount.** `GET /worktrees/:id/files/*path` (`vst-routes/src/worktrees.rs::get_file`) is a plain stateless disk read on every call, no server-side cache in front of it, so remount/navigation always shows current content. But it **does** matter in the steady state: while a file stays open and the user doesn't navigate away, the only thing that refreshes it is a `file:changed` push — so a silently-dead watcher (or a WS disconnect with no catch-up fetch) left it stale until the next edit or manual navigation. That's fixed: no more leak, and the client refetches on an offline→online reconnect (§6). |

The rest of this doc is mostly about `tree:watch`, since that's the one whose
correctness the whole design depends on.

---

## 2. `FileSearchIndex` — what it is

`rust/vst-ws/src/services/file_search.rs`. One in-memory service mapping scope keys
(`wt:<id>` or `proj:<id>`) to `Entry` structs, held for the daemon process's lifetime.

- **Index shape:** `Entry` stores `files: HashMap<String, i64>` (relative POSIX path to created ms since epoch),
  `walked_at: Instant`, `stale: bool`, `pending: Option<Vec<Op>>` (journal), `gen: u64` (from a global atomic generation counter),
  `retry_after: Instant`, `loaded: bool` (a walk has produced data, even an empty listing) and `last_queried`
  (idle eviction).
- **Scope keys:** Both worktree and project routes share the same index via `index_key(WatchScope, id)` (`wt:<id>` or `proj:<id>`).
- **Birth time + mtime fallback:** `created_ms` stats via `symlink_metadata` and uses birth time (`created()`),
  falling back to modification time (`modified()`) or `0` if both fail. Eager stat runs off-lock in `spawn_blocking`,
  reusing prior stats across re-walks. Modifications do not overwrite creation time.
- **Age-bucket recency:** Ranked candidates sort by `(match_bucket desc, age_bucket asc, score desc, path asc)` where
  `age_bucket = max(0, now_ms - created_ms) / 3_600_000` (hour granularity). Recent files outrank older files within the same
  match bucket without near-simultaneous files overpowering fuzzy score relevance.
- **Freshness & 30s TTL:** An entry is fresh if `!stale && (watched_keys.contains(key) || walked_at.elapsed() < 30s)`.
  Unwatched callers are kept fresh by the 30s TTL. If `now < retry_after`, the entry is also treated as fresh (backoff).
- **Walk lock & bounded, cancellable walk:** Walking is guarded by a per-key `Arc<tokio::sync::Mutex<()>>` walk lock.
  Walks run under a 10s timeout (`with_walk_timeout`). If timed out, a shared `CancellationToken` terminates the
  underlying ripgrep or walkdir traversal and stat loop, returning `None`, retaining previous files, clearing the journal,
  leaving `stale = true`, and backing off with `retry_after = now + 30s`.
- **rg cancellation:** `FileList::list_files_cancellable` takes a `tokio_util::sync::CancellationToken`. The ripgrep
  backend is a `tokio::process::Command` (`kill_on_drop`) read line-by-line in a `select!` against
  `cancel.cancelled()` — no polling task; cancelling (or dropping the future) kills the child immediately. The
  walkdir fallback checks `token.is_cancelled()` per entry. 100k cap and `source` field unchanged.
- **Serve stale, refresh in the background:** once an entry has data (`loaded`), an expired/stale entry never blocks
  a query: `search` returns the old snapshot immediately and starts ONE background walk for the key
  (`in_flight` single-flight registry; N concurrent expired queries => one walk). The walk uses the same timeout,
  cancel, backoff, journal and generation guard as any other, so incremental updates arriving during the refresh are
  replayed, not lost. The next query after it finishes sees the new data.
- **First walk and `indexing`:** the FIRST query for a key has no snapshot to serve, so it waits up to
  `first_walk_wait` (1.5s, `with_first_walk_wait`) for the walk. If it has not finished it returns
  `{files: [], truncated: false, indexing: true}` promptly while the walk continues in the background
  (single-flight). `indexing` is also `true` while a key has no data and is in listing-timeout backoff, and is
  always `false` once data exists (an empty-but-walked tree is `indexing: false`). Wire field:
  `FileSearchResult.indexing` (`#[serde(default)]`); clients should show "indexing" and re-query.
- **Idle eviction:** each entry records `last_queried`. A lazy sweep piggybacked on `search` (at most once per 60s, no
  timer task, no poll loop) drops UNWATCHED entries not queried for `idle_timeout` (10 min,
  `with_idle_timeout`), freeing up to 100k paths per key. Watched entries are never idle-evicted; the key being
  queried is never swept. The sweep is purely lazy: it only runs when some `search` call triggers it, so with no
  searches at all nothing is swept (idle entries stay in memory until the next query of any key).
- **Evict on delete:** deleting a worktree (`WorktreeRoutes::delete_worktree`) or project
  (`ProjectRoutes::delete_project`, which also evicts every worktree of the project) calls
  `FileSearchIndex::evict_scope` / `evict_project_tree`, which drop the entry, `watched_keys` membership, walk lock
  and in-flight registration, **cancel the key's running walk** (its `CancellationToken` is stored in the in-flight
  registration, so a doomed `rg` is killed rather than running out its 10s budget), and bump a per-key **eviction
  epoch** (held with the in-flight registry under one lock, and bumped while holding the index write lock).
  Every `search` captures the epoch when it begins; `first_walk` and the stale-serve `kick` refuse to start a walk if
  it has moved, and a walk cancelled before `begin_walk` never inserts an entry. A request that was in flight across
  an eviction therefore returns an empty, non-`indexing` result and does NOT resurrect the entry; only a request
  that begins after the evict starts a fresh walk. The generation guard still discards a walk that finished anyway.
- **Watch armed mid-walk:** if `watch_started` runs while a walk is in flight (`pending.is_some()`), the entry gets
  `rewalk_after`. The completing walk then leaves `stale = true` (the listing may predate the watcher, so a file
  created in that gap would otherwise never be indexed and a watched key would never TTL-expire); the next query
  serves it stale and runs one more walk, after which the key is fresh for as long as it is watched.
- **Journal & Generation guard:** While a walk is in progress, `pending` is armed (`Some(vec![])`). Incremental edits (`insert`,
  `remove`, `merge_subtree`) update current files and push an `Op` into the journal. Upon walk completion, the journal is replayed
  in order onto the walk results. If an eviction occurred during the walk (`e.gen != gen0`), the walk results are discarded.

## 3. How `tree:watch` keeps the index fresh (and how it's kept correct)

```
CONNECTION A: tree:watch("wt1", "")
    │
    ▼
  registry.watchers["tree:wt:wt1:"] absent → SPAWN
    │
    ├─ build callbacks (on_changed / on_deleted) that, when they fire, look
    │  up registry.watchers[key].subscribers FRESH each time — not a
    │  snapshot taken at spawn time
    ├─ FileWatcher::new(callbacks) — one inotify instance, walks the tree
    │  once to register per-directory watches, then just listens
    └─ registry.watchers["tree:wt:wt1:"] = SharedWatcher {
           watcher, ref_count: 1, subscribers: { A }
       }
       registry.index_watch_counts["wt:wt1"] += 1
       if tree_path.is_empty() { file_search.watch_started("wt:wt1") }

CONNECTION B: tree:watch("wt1", "")   (same key, watcher already hot)
    │
    ▼
  registry.watchers["tree:wt:wt1:"] found → JOIN, don't spawn
    │
    ├─ ref_count += 1                          → 2
    └─ subscribers.insert(B)                   → { A, B }
       (no new FileWatcher, no new inotify fd)

FILESYSTEM EVENT (any file under wt1 changes)
    │
    ├─ apply_tree_change() → FileSearchIndex.insert/remove/merge_subtree
    │  (unconditional — happens once per event, regardless of subscriber count;
    │   applies to files and journals Op if walk is in flight)
    │
    └─ for c in subscribers.values(): c.send(TreeChanged{...})
       (both A and B get the live-refresh push)

RELEASE (graceful tree:unwatch, OR connection disconnects)
    │
    ├─ decrement ref_count by exactly ONE per (connection, key) — regardless
    │  of how many LOCAL subscribers that connection had on the same key
    │  (e.g. FileTreeSidebar + FilePreviewPane both watching the same
    │  worktree from one tab is still only one shared ref)
    ├─ remove that connection from `subscribers`
    │
    └─ ref_count == 0 → close the FileWatcher (spawn_blocking; tearing down
       thousands of inotify watches is blocking work), remove the registry
       entry, decrement index_watch_counts["wt:wt1"]
           │
           └─ index_watch_counts["wt:wt1"] == 0 (the LAST watcher for this
              index key — root or any subdir key):
                 · UNDER the registry lock: FileSearchIndex.unwatch("wt:wt1")
                 · after the lock: FileSearchIndex.evict_if_unwatched("wt:wt1")
```

**evict vs `watch_started` race (fixed):** the eviction used to run after the registry lock was dropped, so a
`tree:watch` landing in between registered `watch_started` and the late `evict` then removed the key from
`watched_keys` while its watcher was live (index silently degraded to TTL-only). Now the "last watcher gone" decision and
the `watched_keys` removal happen together under the registry lock, and `evict_if_unwatched` re-checks `watched_keys`
under the index write lock (`watch_started` inserts before it takes that lock), so a watcher that started in between
is never undone. Test seam: `release_registry_ref` / `finish_release` in `tree_watch.rs`.

**New watch-key format:** Watch keys are scoped globally as `tree:{index_key}:{path}` (e.g. `tree:wt:wt1:`, `tree:proj:p1:src`).
Counts in `reg.index_watch_counts` are keyed by `index_key`.

**`watch_started` on root watches:** When a root watch (`tree_path.is_empty()`) is spawned, `watch_started(index_key)` is called.
This marks the key in `watched_keys` and sets `stale = true` on any existing entry so that subsequent queries re-verify freshness
and remain continuously fresh without being subject to TTL expiry while watched.

**Journal replay:** Changes occurring while an initial or re-triggered walk is in progress are buffered in `Entry.pending` and
replayed on top of the completed walk before publishing.

**The root-closed-while-subdir-open hole:** If a client closes its root watch while a subdirectory watch remains open, `index_watch_counts > 0`
so `evict` does not fire, but `watched_keys` remains set. Root-level file changes outside the watched subdirectory would not be seen until
the last watcher closes and evicts the index. In practice, all client watches (Quick Open, file tree) are root watches.

## 4. The eviction trick — how staleness is avoided without a resync

The index is **never actively resynced**. There is no "diff against disk and
patch the index" logic anywhere. Instead:

> The index only exists while at least one `tree:watch` is holding it live, or until it has been idle for 10 minutes
> (unwatched). An expired (>30s) unwatched snapshot is served once while it refreshes in the background.
> When the last watcher closes, `tree_watch` calls `unwatch(index_key)` (drops it from `watched_keys`) while still
> holding the watcher-registry lock, then `evict_if_unwatched(index_key)`, which re-checks `watched_keys` under the
> index write lock and, if no watcher was re-armed, deletes the entry, removes its walk lock, cancels any running
> walk and bumps the eviction epoch. Idle eviction (unwatched, 10 min) is separate and only runs lazily when a
> `search` triggers the sweep.

Both worktree and project routes (`GET /api/worktrees/:id/file-search` and `GET /api/projects/:id/file-search`)
route to this shared service. So the very next `search()` call for that scope — whether that's a fresh
`tree:watch` remounting, or an unwatched caller querying via REST — finds no entry or an expired TTL and re-triggers
a full disk walk, picking up any files created, edited, or deleted while nobody was watching. If the root directory does not
exist (worktree checkout or project path missing), the route returns 404 instead of an empty result, and no index
entry is created.

This is why: *"if I disconnect, and the agent creates a file, will I find it
when I reconnect?"* is always **yes** — regardless of how long the gap was —
as long as the index actually got evicted when the last watcher closed. That
in turn requires the leak fix (§3) to be correct: a leaked watcher that never
closes means the index also never gets evicted, and would (accidentally)
stay live-updated forever instead — which is a resource leak, not a
correctness bug, but it means the "does staleness ever get fixed" question
depends on the eviction path being reachable at all.

## 5. Quick Open's own watch lifecycle

`QuickOpen.tsx` is reachable from the top bar (Ctrl/Cmd+P) regardless of
which tool-panel tab is currently active. `FileTreeSidebar`/`FilePreviewPane`
— the *other* things that hold a `tree:watch` — are only mounted while the
Files tab specifically is selected (`ToolPanel.tsx` renders tabs via a plain
`{tab === "x" ? <X/> : null}` conditional — switching tabs genuinely
unmounts the inactive ones, it does not just hide them).

So without Quick Open holding its own watch, browsing to e.g. the VCS tab
while staying on the same worktree the whole time could let the index go
stale or get evicted (§4) purely because nothing was watching — a gap
distinct from, and easy to miss alongside, the disconnect/reconnect case in
§4. `QuickOpen.tsx` therefore calls `useTreeWatch(api, open ? worktreeId :
null, scope)` unconditionally (rules of hooks — the `null` when closed is
what lets the hook's own cleanup send `tree:unwatch`), so opening the dialog
is itself enough to guarantee a live watch for the duration it's open,
independent of anything else in the workspace.

`useFileSearch.ts` (the hook backing Quick Open's actual search requests)
deliberately does **not** call `useTreeWatch` itself — that responsibility
lives in `QuickOpen.tsx` one level up, since `useFileSearch` doesn't know
about "is the dialog open," only "what's the current query."

## 6. Per-file live reload (`file:watch`)

Opening several tabs in `FilePreviewPane` does **not** hold several live
`file:watch` subscriptions. `useFileWatch(api, worktreeId, path, scope)` is
called with the *currently active* tab's path only, and its effect's
dependency array includes `path` — switching the active tab sends
`file:unwatch` for the old path and `file:watch` for the new one. Tabs that
are open-but-not-active have no live watch at all.

`file:watch` correctness splits cleanly into two cases:

- **On mount / navigation.** Unlike `FileSearchIndex`, there is no server-side
  cache of file *contents* for the watcher to keep fresh. `FilePreviewPane`'s
  content-fetch effect reruns on every mount/path/worktree change, always
  issuing a fresh `GET /worktrees/:id/files/*path`, which is a stateless disk
  read (`vst-routes/src/worktrees.rs::get_file`) with nothing cached in front
  of it server-side. So a stale/dead watcher can never cause stale *mounted*
  content — navigating away and back (or remounting) always re-fetches from
  disk. The client-side `contentCacheRef` (last ~10 file bodies) only avoids a
  loading-flash while that fresh fetch is in flight — it never substitutes for
  the fetch.
- **Steady state (file already open, no navigation).** Here the only thing that
  refreshes the open file is a `file:changed` push — which is why the
  file-watch leak fix matters beyond just resource hygiene: a watcher that died
  (leaked away, or lost to a WS disconnect) left the open file silently stale
  until the next live edit or manual navigation. That's closed by the fix —
  watchers no longer leak on disconnect, and the client triggers a one-shot
  catch-up re-fetch on a reconnect (`FilePreviewPane` listens for `ws:open`,
  `client.ts`'s "a fresh handshake landed" event — the same one
  `useServerSync.ts`/`modesStore.ts` already use for the same purpose), so
  content that changed *during* a disconnected window is pulled the moment
  the socket comes back rather than waiting for the next edit. `ws:open` is
  used deliberately instead of subscribing to the raw connection-state
  transition: `client.ts` emits `ws:open` only *after* it has already
  replayed `file:watch`/`tree:watch` for the reconnected socket, so the
  catch-up fetch can't race ahead of the watch actually being re-established
  (a state-transition-based first version of this fix had exactly that race:
  an edit landing between "online" and the replay being sent was missed by
  both the fetch and the not-yet-live watch). `ws:open` also fires on the
  very first connect, not just reconnects — the effect skips that one
  (a one-shot `seenFirstOpen` flag), since the mount-time fetch already
  covers it. The replay itself is refcounted per key (`fileWatchCounts`/
  `treeWatchCounts` in `client.ts`) and resends a key as many times as it has
  local subscribers, not once per key — matching that
  `retain_file_watcher`/`retain_tree_watcher` only ever take one *global* ref
  per (connection, key) no matter how many local subscribers share it, so
  under-replaying a key with 2+ local subscribers would rebuild the
  connection's post-reconnect local refcount too low, letting the first of
  those subscribers to unwatch close the watcher out from under the other.

---

## Open items / known gaps (update as these get addressed)

- `file:watch` is now globally deduped/refcounted and released on disconnect,
  mirroring `tree:watch` (fixed in
  `.vibekit/feature-plans/wip/file-watch-leak-fix/`). One residual edge: a
  watch that fails to *establish* (e.g. once the OS's
  `fs.inotify.max_user_instances` is exhausted) surfaces only as a
  `system:error` frame, which the UI logs to the console rather than showing a
  user-facing banner — visible to a developer, not to an end user.
- `FileSearchIndex.search()`'s empty-query path (used by Quick Open's
  changed-files-first listing to fill out the rest of the list) iterates a
  `HashSet`, so its ordering is arbitrary and can change between queries.
- A worktree that is watched continuously for a very long time without ever going to zero watchers is never
  idle-evicted (watched entries are exempt by design; they stay live via the watcher).
- Deleting a project/worktree evicts its index but does not tear down any `tree:watch` watcher a client still
  holds for it; those are released when the client unwatches or disconnects.
