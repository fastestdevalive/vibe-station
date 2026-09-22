# Design: server-driven Quick Open file search

**Date:** 2026-09-18 · **Supersedes:** `2026-09-16-file-search-staleness-and-px0-comparison.md`, `2026-09-17-file-search-staleness-revalidation.md` (folded in, deleted) · **Scope:** `web-ui/src/components/dialogs/QuickOpen.tsx`, `web-ui/src/hooks/useWorktreeFiles.ts`, `web-ui/src/hooks/useSubscription.ts`, `rust/vst-ws/src/services/file_list.rs`, `rust/vst-ws/src/handlers/tree_watch.rs`, `rust/vst-routes/src/worktrees.rs`, `rust/vst-daemon/src/server.rs`, `/home/gb/code/fastestdevalive/px0/`

---

## Answer

- **Recommendation: build Option C** — a server-driven `GET /worktrees/:id/file-search?q=&limit=` endpoint backed by a per-worktree in-memory index, rebuilt from the existing `tree:changed` watcher, queried per-keystroke like PX0's palette and like this codebase's own content-search endpoint already does. This eliminates the staleness window structurally instead of patching around it.
- Client-side caching in `useWorktreeFiles.ts` is the root cause: the cache is keyed by worktree, survives across Quick Open close/reopen, and is only invalidated by a `tree:changed` WS event — but the watch behind that event is torn down every time Quick Open closes (`QuickOpen.tsx:39` passes `null` when `!open`). Files created by an agent while Quick Open is closed are invisible until an unrelated event forces a refetch.
- A content-search endpoint (`GET /worktrees/:id/search`, `rust/vst-routes/src/worktrees.rs:1254`) already proves per-keystroke server-side `rg` querying works well here (debounced 200ms in `SearchPanel.tsx:140`, `kill_on_drop` process cancellation, abort-on-supersede). The new filename-search endpoint reuses that exact wiring shape.
- The `:42` go-to-line prefix needs no new editor capability — `setActiveFilePathAtLine(worktreeId, path, line)` (`web-ui/src/hooks/useStore.ts:904`) and `pendingFileLine` (consumed in `web-ui/src/components/layout/FilePreviewPane.tsx:344`) already implement "jump to line in an already-open file," used today by `SearchPanel.tsx:165`. QuickOpen's `:42` handler just needs to call it with the *current* `activeFilePath`.

---

## Part 1 — How Quick Open works today

```
QuickOpen opens
  └─ useWorktreeFiles(api, worktreeId)         ← passed `null` when closed (QuickOpen.tsx:39)
       ├─ module-level cache hit? → serve immediately, no fetch (useWorktreeFiles.ts:25,86-97)
       ├─ cache stale?            → serve stale + 500ms debounced background refetch (useWorktreeFiles.ts:140-157)
       └─ cache miss?             → GET /worktrees/:id/file-list
                                        └─ Rust: `rg --files`, re-run fresh every request, no index (file_list.rs:88-130)
            ↕
       useTreeWatch(api, worktreeId)            ← ONLY active while Quick Open is open (useSubscription.ts:207-227)
            ↕ WS tree:changed
       Rust FileWatcher (notify crate, per-directory inotify, tracks new dirs only after registration)
  └─ QuickOpen.tsx:58-73 filters/scores the full in-memory list client-side (prefix=3, contains=2, path-contains=1)
```

| Claim | Source |
|-------|--------|
| Watch disabled while closed: `open ? worktreeId : null` | `web-ui/src/components/dialogs/QuickOpen.tsx:37-41` |
| `useTreeWatch(api, null)` sends no `tree:watch`, adds no listener | `web-ui/src/hooks/useSubscription.ts:213-216` |
| Cache is module-level, keyed by `scope:worktreeId`, survives close/reopen | `web-ui/src/hooks/useWorktreeFiles.ts:25,63` |
| Refetch guard: `if (!existing.stale && refreshTick === 0) return` | `web-ui/src/hooks/useWorktreeFiles.ts:94-97` |
| Only invalidation path: `tree:changed` → 500ms debounce → `refreshTick++` | `web-ui/src/hooks/useWorktreeFiles.ts:140-157` |
| Rust watch only reports changes *after* registration — explicitly documented, no mechanism for pre-existing/pre-watch files | `rust/vst-ws/src/streams/file_watcher.rs:29-31` (doc comment) |
| `rg --files` re-run per HTTP request, no persistent index | `rust/vst-ws/src/services/file_list.rs:77-86` |
| Route wiring: `GET /worktrees/:id/file-list` → `WorktreeRoutes::file_list()` | `rust/vst-daemon/src/server.rs:404`, `rust/vst-routes/src/worktrees.rs:1241-1249` |
| Client-side 3-tier scoring (prefix/contains/path) capped at 50 results | `web-ui/src/components/dialogs/QuickOpen.tsx:58-73` |

**Staleness window:** Quick Open close → next Quick Open open. Nothing invalidates the cache in that window, and even a live watch can't retroactively report files that existed before it started — so reopening Quick Open alone doesn't fix it either.

**Why this is worth fixing now:** multi-worktree agents routinely create files in a worktree while the user's Quick Open focus is elsewhere (a different worktree, or just closed) — this is the single most common trigger of the bug in practice, not an edge case.

---

## Part 2 — What PX0 does differently

```
User types in palette
  └─ 40ms debounce
       └─ GET /api/find?q=<query>&limit=120
            └─ server: FuzzyFind(index.Files(), query) over in-memory []FileEntry
                 └─ index built by parallel os.ReadDir walk at startup + explicit POST /api/reindex
```

| PX0 property | Source |
|---|---|
| Client holds no file list — every keystroke queries the server | `/home/gb/code/fastestdevalive/px0/web/src/palette.js:108` |
| In-memory index, parallel walk | `/home/gb/code/fastestdevalive/px0/index.go:159-264` |
| Explicit re-index endpoint, no filesystem watch | `/home/gb/code/fastestdevalive/px0/server.go:660-664` |
| Fuzzy scoring parallelized across `NumCPU` workers | `/home/gb/code/fastestdevalive/px0/fuzzy.go:110-139` |

Zero client-side staleness risk, by construction — there's nothing cached to go stale. The tradeoff PX0 accepts is that its "invalidate" story is a manual button, not automatic; that's fine for a single-workspace local editor but wouldn't fit vibe-station's "agent edits files while I'm not looking" pattern.

---

## Part 3 — What's best for vibe-station

| PX0 assumption | vibe-station reality | Adaptation |
|---|---|---|
| Single workspace | N worktrees, independent checkouts | Index keyed by `worktree_id` in a `DashMap`/`HashMap` behind a mutex, not global state |
| Manual re-index button | `tree:changed` watcher already exists and fires on every fs change | Rebuild triggered from the watcher (`tree_watch.rs`), not user-initiated — matches vibe-station's "always fresh" bar better than PX0's model |
| Go in-process index + `fuzzy.go` | Rust `vst-ws`/`vst-routes`, no fuzzy crate yet | New `FileSearchIndex` service in `vst-ws/src/services/`; `nucleo` (or `fuzzy-matcher`) for scoring |
| Client sends keystroke → server responds | Content-search (`SearchPanel.tsx`) already does exactly this per-keystroke pattern for grep matches | Reuse the identical route/business-logic/service layering, debounce value, and abort-on-supersede pattern — this is a template, not a first-of-its-kind |

**Why Option C over lighter fixes (both prior reports' "Option A" refetch-on-open / "Option B" always-on watch):** those only shrink the staleness window; they don't remove it, and Option B doubles inotify handle usage per worktree indefinitely just to keep a client cache warm. Given vibe-station already has the exact wiring pattern proven out by content-search, and the watcher already fires the right event, building the real fix costs little more than the workarounds and removes the whole class of bug.

**Why an in-memory index instead of re-running `rg --files` per keystroke:** `rg --files` on this repo runs ~50-150ms per invocation (per the prior report, unmeasured but consistent with content-search's need for a debounce); running it on every keystroke would be redundant work and latency PX0 avoids by indexing once and querying in-memory. The existing content-search endpoint gets away with a fresh `rg` process per query because it's not on the interactive-typing hot path in the same way (200ms debounce, and grep necessarily re-scans content, which an index can't shortcut) — filename search should not carry that cost when an index makes it a memory scan.

---

## Part 4 — Action items (implementation, in order)

1. **`rust/vst-ws/src/services/file_search.rs` (new file)** — `FileSearchIndex` service: `HashMap<String /* worktree_id */, HashSet<String> /* posix paths */>` behind a `tokio::sync::RwLock` (read-heavy: many queries, few writes). Expose:
   - `rebuild(&self, worktree_id: &str, files: Vec<String>)` — replace the entire entry (used only for the initial/lazy full populate, and for the scoped-subtree-merge case below — NOT on every fs event; see item 2).
   - `insert(&self, worktree_id: &str, rel_path: &str)` / `remove(&self, worktree_id: &str, rel_path: &str)` — O(1) incremental update for a single file.
   - `merge_subtree(&self, worktree_id: &str, prefix: &str, files: Vec<String>)` — replace all entries currently under `prefix` with a freshly-walked set (used for the "new non-empty directory" case, item 2).
   - `search(&self, worktree_id: &str, query: &str, limit: usize) -> Vec<String>` — fuzzy-match + score using `nucleo` (add to `Cargo.toml` workspace deps; no fuzzy crate exists yet, confirmed via `grep nucleo\|fuzzy-matcher rust/*/Cargo.toml` → empty). Match precedence to preserve/improve on today's client-side scoring: filename exact prefix > filename fuzzy > path fuzzy.
   - If `worktree_id` has no entry yet (first query before any rebuild), lazily call `FileList::list_files` synchronously so the first Quick Open keystroke after a fresh daemon start isn't empty.

2. **Incremental updates from the existing watcher — not a full rebuild.** `rust/vst-ws/src/streams/file_watcher.rs`'s `WatcherCallbacks` (`on_changed`/`on_deleted`: `Arc<dyn Fn(String)>`) already deliver the **specific absolute path** that changed, already debounced per-path at 200ms inside `file_watcher.rs` itself (`schedule_debounced`). `rust/vst-ws/src/handlers/tree_watch.rs:50-78` currently discards that argument (closures bind it to `_`) and only forwards the coarse watched-root path to the browser via `TreeChanged`. Capture it instead:
   - In the `on_changed`/`on_deleted` closures built in `handle_tree_watch` (tree_watch.rs:50-64), also convert the absolute path to a worktree-relative POSIX path (reuse `file_list.rs`'s `to_posix` logic) and call `FileSearchIndex::insert`/`remove` for that single path — O(1), no extra debounce layer needed since the 200ms is already applied per-path upstream.
   - **Gap to handle:** a directory created with files already inside it in one shot (`mkdir dir && cp -r stuff dir/`) fires exactly one `on_changed` for the directory path — files inside it never get their own individual fs event (same "watch only sees future/registered events" limitation documented in `file_watcher.rs`'s own header comment). Detect this case (the changed path is a directory, not a file — `std::fs::metadata` check) and call `FileSearchIndex::merge_subtree` with a walk scoped to just that directory (reuse `FileList`'s walker, restricted to the subtree path) instead of a full-worktree rebuild — O(subtree size), not O(repo size).
   - On `on_deleted` for a path that was a directory, remove every indexed entry with that prefix (`merge_subtree(prefix, vec![])` or an equivalent bulk-remove).
   - This avoids the wasted-work pattern a periodic full `rg --files` re-walk would have: a full rebuild is O(repo size) work to reflect an O(1) change, and under sustained agent activity (edits arriving faster than a rebuild debounce window) would mean repeated full walks proportional to total repo size rather than to the actual delta.

3. **`rust/vst-routes/src/worktrees.rs`** — add `pub async fn file_search(&self, wt_id: &str, q: &str, limit: Option<usize>) -> Result<FileSearchResult, WorktreeRouteError>` next to `file_list`/`search` (~worktrees.rs:1241-1254), following the same `find_project_for_worktree` → resolve path → call service shape. Reuse `FileListResult`-style response struct (`FileSearchResult { files: Vec<String>, truncated: bool }`) in `vst-types`.

4. **`rust/vst-daemon/src/server.rs`** — register `.route("/worktrees/:id/file-search", get(handle_worktree_file_search))` next to the existing `/file-list` and `/search` routes (server.rs:404-405), and add the handler next to `handle_worktree_search` (~server.rs:1469-1489), same `Query<FileSearchQuery { q, limit }>` extraction pattern.

5. **`web-ui/src/api/client.ts`** — add `fileSearch(worktreeId, q, signal?, scope?, limit?)` next to `fileList`/`search` (client.ts:827-848), same shape as `search()`.

6. **`web-ui/src/hooks/useWorktreeFiles.ts`** — replace with a `useFileSearch(api, worktreeId, query, scope)` hook (or repurpose the existing file) that debounces ~40-100ms (matching PX0's 40ms; this codebase's content-search uses 200ms but that's grep, not an in-memory index lookup — file search should feel closer to instant) and calls `api.fileSearch()` per query change, with abort-on-supersede exactly like `SearchPanel.tsx:75-134`. Drop the module-level `cache` Map, the `tree:watch` subscription, and the `REFRESH_DEBOUNCE_MS` staleness machinery entirely — the server owns freshness now. Keep a `loading`/`error` state for the UI.

7. **`web-ui/src/components/dialogs/QuickOpen.tsx`** — switch from `useWorktreeFiles` + client-side `filtered` scoring (`QuickOpen.tsx:58-73`) to the new `useFileSearch` hook, passing `query` through. Remove the local scoring `useMemo` — the server now returns pre-scored, pre-limited results. Keep the empty-query behavior (show recent/all files, capped) by calling the endpoint with `q=""` or by keeping a tiny "show open tabs first" fallback client-side — server-side empty-query should just return the first N index entries.

8. **`:line` and `>` prefix handling in `QuickOpen.tsx`** — before scheduling any server query, branch on the input:
   - `/^:\d+$/` → do NOT call file-search. Read `activeFilePath` from `useWorkspaceStore` for the current worktree and call `setActiveFilePathAtLine(wt, activeFilePath, Number(query.slice(1)))` on Enter (reuses `useStore.ts:904-925`, already consumed by `FilePreviewPane.tsx:344-364`); if there's no active file, show an inline "no file open" placeholder instead of an empty list. Close the dialog on successful jump, same as `selectFile`.
   - `/^>/` → do NOT call file-search. Render a static "No commands yet" placeholder row (no-op), reserving the prefix for a future command palette per PX0's convention. No command execution logic is implemented.
   - Anything else → existing filename-search path (now server-driven, per item 6-7).

9. **Tests** — `rust/vst-ws`: unit tests for `FileSearchIndex::search` (prefix/fuzzy/empty-query/unknown-worktree) and a rebuild-debounce test; `rust/vst-routes`/`vst-daemon`: an integration test hitting `GET /worktrees/:id/file-search` end-to-end (mirroring existing `file_list`/`search` route tests). `web-ui`: update/replace `useWorktreeFiles`'s existing tests for the new hook (debounce, abort-on-supersede, empty state), and `QuickOpen.test.tsx` (if present) for the `:digit` and `>` prefixes.

10. **Cleanup** — once `useFileSearch` is live and Quick Open no longer needs a standing `tree:watch`, confirm no other consumer still depends on `useWorktreeFiles`'s cache (`grep -rn useWorktreeFiles web-ui/src`) before deleting the old file; if the sidebar or another component shares it, keep it only for that use and don't let Quick Open regress back onto it.

**Open decision, made here rather than asked:** debounce value for the new per-keystroke file-search call is set to **60ms** (between PX0's 40ms and content-search's 200ms) — fast enough to feel instant against an in-memory index, slow enough to avoid a request per keystroke on fast typists. Revisit if profiling shows otherwise.
