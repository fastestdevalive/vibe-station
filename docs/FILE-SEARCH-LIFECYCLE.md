# File Search Lifecycle

**Living doc.** This tracks how the server-driven file-search mechanism actually
works today — the index, the watchers that keep it fresh, and the two closely
related but distinct watch types. Update it whenever this area changes; it is
meant to stay the map, not a point-in-time design note (see
`docs/FILE-SEARCH-PLAN.md` for the original `/file-list` planning doc, and
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

`rust/vst-ws/src/services/file_search.rs`. One in-memory `HashMap<worktree_id,
HashSet<relative_path>>`, held for the daemon process's lifetime.

- **Lazily populated.** `search()` calls `populate()` first, which does a full
  disk walk (via `FileList`) *only* if the worktree has no entry yet
  (`!idx.contains_key(worktree_id)`). Once populated, it is **never re-walked**
  — freshness after that point comes entirely from `insert`/`remove`/
  `merge_subtree` calls driven by `tree:watch` events (§3).
- **`insert`/`remove` are no-ops on an unpopulated worktree** — by design, so a
  stray event for a worktree nobody has queried yet can't create a partial,
  wrong index.
- **`evict(worktree_id)`** removes the entry *entirely* (not just clears its
  contents) — see §4 for when this fires and why that distinction matters.

## 3. How `tree:watch` keeps the index fresh (and how it's kept correct)

```
CONNECTION A: tree:watch("wt1", "")
    │
    ▼
  registry.watchers["tree:wt1:"] absent → SPAWN
    │
    ├─ build callbacks (on_changed / on_deleted) that, when they fire, look
    │  up registry.watchers[key].subscribers FRESH each time — not a
    │  snapshot taken at spawn time
    ├─ FileWatcher::new(callbacks) — one inotify instance, walks the tree
    │  once to register per-directory watches, then just listens
    └─ registry.watchers["tree:wt1:"] = SharedWatcher {
           watcher, ref_count: 1, subscribers: { A }
       }
       registry.worktree_counts["wt1"] += 1

CONNECTION B: tree:watch("wt1", "")   (same key, watcher already hot)
    │
    ▼
  registry.watchers["tree:wt1:"] found → JOIN, don't spawn
    │
    ├─ ref_count += 1                          → 2
    └─ subscribers.insert(B)                   → { A, B }
       (no new FileWatcher, no new inotify fd)

FILESYSTEM EVENT (any file under wt1 changes)
    │
    ├─ apply_tree_change() → FileSearchIndex.insert/remove/merge_subtree
    │  (unconditional — happens once per event, regardless of subscriber count)
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
       entry, decrement worktree_counts["wt1"]
           │
           └─ worktree_counts["wt1"] == 0 (the LAST watcher for this
              worktree — root or any subdir key) → FileSearchIndex.evict("wt1")
```

**Why the registry is keyed globally, not per-connection:** the earlier
version deduped per-connection only, so a second connection watching an
already-watched worktree spawned and orphaned a *duplicate* `FileWatcher` —
its background task kept its own inotify fd alive forever with no reachable
handle to close it. Confirmed live via `/proc/<pid>/fdinfo`: a single
worktree accumulated 9 leaked fds under normal use. See
`.vibekit/feature-plans/wip/tree-watch-leak-fix/plan-tree-watch-leak-fix.md`
for the full root-cause writeup.

**Why the subscriber set matters, not just the refcount:** without it, the
shared watcher's callbacks would only ever push to whichever connection
happened to create it — every *other* connection sharing the watcher would
have its `FileSearchIndex` correctly kept fresh (that part doesn't depend on
subscribers, see above) but would never get its own `tree:changed` push, so
its file-tree sidebar / open-file live-reload would silently stop updating.

**Why release must drop exactly one ref per connection, not one per local
subscriber:** `handle_tree_watch` only ever takes ONE global ref per
connection per key (a second local caller on the same connection
short-circuits at the connection's own local refcount and never touches the
shared registry). A release path that decremented once per local subscriber
instead would over-release whenever a connection had more than one local
subscriber on the same key — a second, unrelated connection's still-live
watcher would get wrongly closed and its index evicted out from under it.

## 4. The eviction trick — how staleness is avoided without a resync

The index is **never actively resynced**. There is no "diff against disk and
patch the index" logic anywhere. Instead:

> The index only exists while at least one `tree:watch` is holding it live.
> The moment the last one closes, the entry is deleted outright
> (`evict`, not `clear`).

So the very next `search()` call for that worktree — whether that's a fresh
`tree:watch` remounting, or just a Quick Open query — finds no entry
(`!idx.contains_key`) and re-triggers `populate()`'s full disk walk, exactly
as if the worktree had never been seen before. Any file created, edited, or
deleted while nobody was watching is picked up for free, because the walk
reads current disk state, not anything cached.

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
- No TTL / idle eviction for a worktree that's watched continuously for a
  very long time without ever going to zero watchers — not a correctness
  issue today, just noted here since it's the kind of thing this doc should
  track as the mechanism grows.
