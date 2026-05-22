# Plan: Fast file-name search

## Background

Quick Open is very slow today. The cause is in `web-ui/src/components/dialogs/QuickOpen.tsx:5-24`: `collectFiles()` walks the worktree client-side by issuing one `GET /worktrees/:id/tree?path=…` per directory, fully serialized. A 500-directory repo means 500 sequential HTTP round-trips before any matching can start. The current `/tree` route also re-reads and re-parses `.gitignore` on every request (`daemon/src/routes/worktrees.ts:464-470`), multiplying the cost. There is also no client-side cache: the entire walk re-runs every time Quick Open opens.

VS Code / code-server avoid all of this by shelling out to `ripgrep --files` once, getting every path back in a single multithreaded pass, and keeping the result in memory updated by a filesystem watcher. The plan below adopts the same model.

## Answering: what happens to `/tree`?

**The existing `/tree` endpoint stays — it is not a duplicate.** The two endpoints serve fundamentally different access patterns:

| Endpoint | Returns | Used by | Why it stays distinct |
|---|---|---|---|
| `GET /worktrees/:id/tree?path=…` | Direct children of *one* directory, with `{name, type, path}` per entry | `FileTreeSidebar.tsx` (lazy expand on chevron click), `FileTreeSidebar.test.tsx` | Sidebar is a tree UI — it must show folder/file distinction, sort folders first, expand on demand. Walking the whole tree just to render the root level would be wasteful, especially for large repos where the user only ever opens a few directories. |
| `GET /worktrees/:id/files` *(new)* | Flat array of **file paths only** across the whole worktree, one shot | `QuickOpen.tsx`, future content-search UI | Fuzzy search needs every file path in memory at once. It doesn't care about directories, sort order, or display metadata. Sending tree-shaped data would balloon the payload and force the client to flatten it again. |

The bug today is that `QuickOpen` was abusing `/tree` to do a job it wasn't designed for — N sequential HTTP round-trips to fake a flat listing. The fix is to give that use case its own purpose-built endpoint, not to overload `/tree`.

Cleanups that *are* part of this work:

- `collectFiles()` in `QuickOpen.tsx:5-24` (the recursive walker) is deleted.
- The `tree:changed` subscription stays useful for both endpoints — sidebar invalidates the opened-dir cache; QuickOpen invalidates the flat list.

---

## Phase 1 — Daemon endpoint: `GET /worktrees/:id/file-list`

> **Naming note (from review):** the obvious name `/files` collides with the existing `GET /worktrees/:id/files/*path` route (file content, `worktrees.ts:515`). The flat listing endpoint is therefore `/file-list`.

**File:** `daemon/src/routes/worktrees.ts` (new route near the existing `/tree` route at line 444)

**Contract:**

```
GET /worktrees/:id/file-list
→ 200 { files: string[], truncated: boolean, source: "ripgrep" | "node" }
→ 404 if worktree not found
```

- `files`: array of worktree-relative paths (forward slashes), files only.
- `truncated`: true if we hit a cap (e.g. 100k entries) — UI can show a hint.
- `source`: which backend was used; useful for debugging and telemetry.

**Backend selection:**

1. **Preferred: spawn `rg --files --hidden --glob '!.git'`** in the worktree path. ripgrep already respects `.gitignore`, is multithreaded, and is the same tool VS Code uses under the hood. Read stdout as a stream, split on `\n`, push into the array. Sub-100 ms for typical repos.
2. **Fallback: Node `readdir` recursive walk** when `rg` isn't on PATH. Load `.gitignore` **once** (not per directory like the current `/tree` does), build the `ignore()` matcher once, then walk with `readdir(..., { withFileTypes: true, recursive: true })` (Node 20+). Apply the matcher in one pass.

**Detection:** at module load, run `which rg` (or cache a `Promise<boolean>`); fall back if missing. Don't `which` on every request.

**Safety:**

- Cap at ~100k entries; on hit, set `truncated: true`, **SIGTERM the rg child**, and drain stdout to EOF. Stopping the reader without killing the child leaks the process. Prevents OOM on accidentally huge directories (`node_modules` un-gitignored).
- Reuse `resolveInsideWorktree` semantics by passing the worktree root directly — no user-supplied path on this endpoint, so no traversal risk.
- Reuse the worktree-id lookup pattern from `worktrees.ts:452-453` (`getAllProjects().find(...)`) for 404 consistency.
- 30-second hard timeout on the `rg` subprocess; on timeout, SIGTERM and return whatever was collected with `truncated: true`.
- **Node fallback per-entry error swallow:** `readdir(..., { recursive: true })` can throw if a single entry is a broken symlink or has a permission error. Wrap each entry's stat (if needed) in a try/catch; skip on error rather than failing the whole request.

**Known semantic gap (acceptable for v1):**

`rg --files` and the Node fallback are **not equivalent** w.r.t. gitignore. `rg` honors nested `.gitignore` files, `.git/info/exclude`, and global excludes; the Node fallback reads only the root `.gitignore`. Users without `rg` installed get a less-strict ignore — same as today's `/tree` behavior, so no regression. Document but do not fix.

**Hidden files default:** confirmed from source — `/tree` shows dotfiles by default (`worktrees.ts:473`, `hideDotfiles = showHidden === "false"`) and hard-hides `.git` (`worktrees.ts:487`). New endpoint matches: include dotfiles, hard-hide `.git` via `--glob '!.git'` (rg) or directory-name check (Node).

---

## Phase 2 — Client API + cache

**File:** `web-ui/src/api/client.ts`

Add `api.files(worktreeId)` next to `api.tree` (around line 341). Returns `Promise<{ files: string[]; truncated: boolean }>`.

**Cache strategy (recommended: in-memory per worktree, hook-owned):**

Create `web-ui/src/hooks/useWorktreeFiles.ts`:

```
useWorktreeFiles(worktreeId): { files, loading, error, refresh }
```

Behavior:

- Module-level `Map<worktreeId, { files, ts, status }>` so the cache survives QuickOpen close/reopen.
- On mount: return cached entry immediately if present; otherwise fetch.
- **The hook calls `useTreeWatch(api, worktreeId)` itself** — `tree:watch` is per-WS-connection state (`daemon/src/ws/handlers/treeWatch.ts:11`), not auto-emitted. QuickOpen can be triggered without the sidebar mounted (`Workspace.tsx:119`), so we cannot assume any other component has registered a watch. The daemon's watcher debounces internally (`fileWatcher.ts:77-97`).
- On any `tree:changed` event for this worktree: **mark stale** but don't refetch immediately — refetch lazily when QuickOpen next opens, or debounced after 2s of quiet. Avoids thrashing on bulk file operations.
- **Stale-while-revalidate:** if the cache is stale when QuickOpen opens, return the stale list immediately and trigger a background refetch. Never block the UI on a refresh of an existing list.
- Expose `refresh()` for an explicit reload (future "Refresh file list" button).

**Open question:**

- Could persist the list to `sessionStorage` keyed by worktreeId for instant cold-open. Probably overkill for v1 — fetching from localhost is already fast once the endpoint exists. Defer.

---

## Phase 3 — Wire QuickOpen to the new endpoint

**File:** `web-ui/src/components/dialogs/QuickOpen.tsx`

- Delete `collectFiles()` (lines 5-24).
- Replace the `useEffect` at lines 45-71 with `const { files, loading, error } = useWorktreeFiles(open ? worktreeId : null);`
- Change `allFiles: { path, name }[]` to derive `name` lazily inside the matcher (one `lastIndexOf("/")` per match — negligible). Keeps the cached payload smaller.
- Filtering loop (lines 88-101) stays for now — fine for v1. Phase 5 below replaces the matcher.

---

## Phase 3b — Update API contract doc

**File:** `docs/API-CONTRACT.md`

Add a row for `GET /worktrees/:id/file-list` next to the existing `/tree` and `/files/*path` rows. Describe shape, source field, truncated semantics, and that gitignore handling varies by backend.

---

## Phase 4 — Tests

- **Daemon:** add `daemon/src/routes/__tests__/files.test.ts` (mirroring the tree route tests if they exist). Cover:
  - returns array for a small fixture worktree
  - respects `.gitignore`
  - 404 for unknown worktree
  - `truncated: true` when cap is hit (use a small cap via env override for the test)
  - falls back when `rg` is not on PATH (mock the detection)
- **Web UI:** update `QuickOpen` test (if it exists) and add a `useWorktreeFiles` test for cache hit, invalidation on `tree:changed`, and error path.

---

## Phase 5 — Optional follow-ups (not in this PR)

Listed so we don't lose them:

- **Real fuzzy matcher** — swap `indexOf` scoring for a subsequence matcher with path-separator/case-boundary bonuses. Options: `fzf-for-js`, `fzy.js`, or ~80 lines hand-rolled. Big perceptual win.
- **Streaming results** — for repos where even the `rg --files` payload is large, stream NDJSON and let QuickOpen show partial matches as they arrive.
- **Content search endpoint** — `GET /worktrees/:id/grep?q=…` backed by `rg --json`. Same architecture: separate endpoint for a separate access pattern.

---

## Risk / rollback

New endpoint is additive — no behavior change to existing `/tree` consumers (sidebar). If `rg` misbehaves on some environment, the Node fallback is the same algorithm as today, just consolidated into one walk instead of N requests. Safe to revert by reverting `QuickOpen.tsx` and removing the route; no schema migrations, no protocol changes.

---

## Recommended order to ship

1. Phase 1 + 2 + 3 + 3b together in one PR — Phase 1 is dead code until Phase 3 wires it in.
2. Phase 4 tests alongside.
3. Phase 5 deferred to a follow-up PR.
