<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: File tree — always-show overrides + visible ignored folders

> The file tree stops hiding gitignored folders (shown dimmed, lazy) and honors a small always-show list (default `*.png`); search and file-list stay gitignore-strict.

**Branch:** `message-pr-ci` (new commit, PR #246)
**Status:** WIP

**Reference files:**
- Core logic: `rust/vst-ws/src/services/ignore_filter.rs`
- Routes: `rust/vst-routes/src/worktrees.rs` (`tree`), `rust/vst-routes/src/projects.rs` (`tree`)
- Wire type: `rust/vst-types/src/rest/projects.rs` (`TreeEntry`), `web-ui/src/api/types.ts`
- UI: `web-ui/src/components/layout/FileTreeSidebar.tsx`, `web-ui/src/styles/workspace.css`

---

## Problem & Concept

- Gitignored entries vanish from the tree: `dist/`, `build/`, `.next/` cannot be browsed, and ignored `*.png` assets disappear
- Wanted: ignored **folders** visible (dimmed) but never crawled by search / file-list; a config list that force-shows matching entries (e.g. `*.png`)

## Out of Scope

- Search, file-list, quick-open, LSP (stay gitignore-strict, via `rg`)
- Live updates inside an ignored folder (tree watch keeps pruning ignored subtrees)
- Showing `node_modules` / `.git` (stay hard-hidden)
- A settings UI for the override list; per-project override files

## Requirements

| # | Requirement |
|---|-------------|
| 1 | Gitignored **directories** appear in the tree, flagged `ignored: true`, dimmed in the UI |
| 2 | Listing inside an ignored directory shows its entries (all flagged `ignored`) |
| 3 | Gitignored **files** stay hidden unless an always-show pattern matches |
| 4 | Always-show patterns (gitignore syntax) force an entry visible; it is still flagged `ignored` (dimmed; a git-status class wins over dimming); default `["*.png"]` |
| 5 | `node_modules` and `.git` are never shown, whatever the overrides say |
| 6 | Config: `<vst_home>/file-tree.json` → `{"alwaysShow": [..]}`; missing/invalid file → default; `[]` is honored |
| 7 | Search, `file-list`, and tree watch behavior unchanged (no recursion into ignored dirs) — so creating/deleting ignored dirs or always-shown files does NOT live-update the tree (re-expand/refresh) |
| 9 | One shared listing helper (`list_tree_dir`) used by both routes; root canonicalized once; matcher gets root-relative paths only |
| 10 | Ignored symlinked dirs whose target leaves the canonical root are hidden |
| 11 | Listings inside an ignored dir are capped (2000 entries); the UI does not re-fetch expanded ignored dirs on `tree:changed` |
| 12 | `file-tree.json`: regular file, ≤ 64 KiB, async read; ≤ 64 patterns × 256 chars; wrong shape → default |
| 8 | Wire change is additive: `TreeEntry.ignored` optional, mirrored in `api/types.ts` |

---

## Change Map

```
rust/vst-ws/src/services/
  ignore_filter.rs       ~ TreeVisibility + overrides
rust/vst-routes/src/
  worktrees.rs           ~ tree() uses visibility
  projects.rs            ~ tree() uses visibility
rust/vst-types/src/rest/
  projects.rs            ~ TreeEntry.ignored
web-ui/src/
  api/types.ts           ~ TreeEntry.ignored
  components/layout/FileTreeSidebar.tsx   ~ ignored row class
  styles/workspace.css   ~ dim ignored rows
```

| Today | After this plan |
|-------|-----------------|
| Ignored dirs/files are dropped from `/tree` | Ignored dirs listed + flagged; ignored files listed only when always-show matches |
| No override mechanism | `file-tree.json` `alwaysShow` list |

---

## Research

- `rust/vst-ws/src/services/ignore_filter.rs:34` — `ignores()` = hard-hide (`node_modules`/`.git`) + nested `.gitignore` walk; also used by the file watcher (`streams/file_watcher.rs`) so its semantics must not change
- `rust/vst-routes/src/worktrees.rs:1345` / `projects.rs:1472` — both `tree()` drop entries when `ignores()` is true; duplicated loops
- `rust/vst-ws/src/services/file_list.rs:77` — file-list uses `rg --files` / `WalkBuilder` (gitignore-strict) — untouched
- **Root cause:** one boolean (`ignores`) serves watchers, tree and search, so "hide from search" and "hide from tree" cannot differ

---

## Design Details

### System Boundaries

| Boundary | Fields + types | Errors | Source of truth |
|----------|----------------|--------|-----------------|
| `GET /worktrees/:id/tree`, `GET /projects/:id/tree` | `TreeEntry { name, type, path, ignored?: bool }` | unchanged | `vst-types` |
| Daemon ↔ `<vst_home>/file-tree.json` | `{ alwaysShow: string[] }` | unreadable/invalid → default, `tracing::warn` | `ignore_filter` |

### Key Decisions

#### Decision 1: Add a second verdict, don't change `ignores()`

- **Decision:** new `IgnoreMatcher::tree_visibility(abs, is_dir, parent_ignored) -> TreeVisibility { Show, ShowIgnored, Hide }`; `ignores()` untouched
- **Rationale:** watchers/search keep strict semantics; only the two tree routes opt in — see Research § root cause
- **Where:** `ignore_filter.rs`

```rust
// Order matters: hard-hide first (overrides can never reveal node_modules/.git),
// then gitignore, then always-show, then the dir/parent rules.
fn tree_visibility(&mut self, abs: &str, is_dir: bool, parent_ignored: bool) -> TreeVisibility {
    if self.hard_hidden(abs) { return Hide; }
    if !self.gitignored(abs, is_dir) { return Show; }
    // always-show / ignored dir / inside ignored dir → listed, but FLAGGED (ShowIgnored)
    if self.always_show_matches(rel, is_dir) || is_dir || parent_ignored { return ShowIgnored; }
    Hide
}
```

#### Decision 2: Overrides = gitignore-syntax list in a JSON file under `vst_home`

- **Decision:** `file-tree.json` with `alwaysShow`; default `["*.png"]`; loaded per `/tree` request (tiny file, no cache, no restart needed)
- **Rationale:** no `/settings` wire/PATCH/UI work; user-editable; validated and capped (≤ 64 patterns, ≤ 256 chars each, bad lines skipped)
- **Where:** `ignore_filter.rs` (`load_always_show(vst_home)`), routes pass `self.paths.vst_home()`

#### Decision 3: Matching rules for always-show

- **Decision:** patterns compile with `GitignoreBuilder` rooted at the worktree root; matched with `matched_path_or_any_parents` so `*.png` matches at any depth and `assets/` matches a dir
- **Rationale:** same syntax users already know; no new glob dialect
- **Where:** `ignore_filter.rs`

#### Decision 4: `ignored` flag on the wire, dimmed in the UI

- **Decision:** `TreeEntry.ignored: Option<bool>` (`skip_serializing_if` none, serde default); row gets `tree-row--ignored`
- **Rationale:** additive, backward-compatible; one source (the daemon) decides
- **Where:** `vst-types/.../projects.rs`, `types.ts`, `FileTreeSidebar.tsx`, `workspace.css`

---

## Files & Phase Impact

| File | Change | Phase |
|------|--------|-------|
| `rust/vst-ws/src/services/ignore_filter.rs` | `TreeVisibility`, overrides loader, `tree_visibility` | 1 |
| `rust/vst-ws/tests/ignore_filter.rs` | unit tests | 1 |
| `rust/vst-types/src/rest/projects.rs` | `TreeEntry.ignored` | 2 |
| `rust/vst-routes/src/worktrees.rs`, `projects.rs` | use visibility; flag | 2 |
| `rust/vst-routes/tests/*` | tree route tests | 2 |
| `web-ui/src/api/types.ts`, `FileTreeSidebar.tsx`, `workspace.css` (+ test) | mirror + dim | 3 |

---

## Implementation Phases

### Phase 1 — Matcher

- [x] 1.1 `TreeVisibility` + `tree_visibility()`; keep `ignores()` byte-for-byte behavior
- [x] 1.2 `load_always_show(vst_home)` (default, `[]`, caps, invalid → default)
- [x] 1.3 Tests: png override, ignored dir shown, ignored file hidden, nested `.gitignore`, negation, `node_modules`/`.git` never shown, `[]` honored, corrupt file → default

### Phase 2 — Routes + wire (shared helper `list_tree_dir`)

- [x] 2.1 `TreeEntry.ignored`
- [x] 2.2 `worktrees.rs` / `projects.rs` `tree()`: compute `parent_ignored` once per listing; skip `Hide`; set flag on `ShowIgnored`
- [x] 2.3 Behavior tests live at the shared helper (`rust/vst-ws/tests/tree_list.rs`), which both routes call; route-level tests unchanged and green

### Phase 3 — UI

- [x] 3.1 Mirror type; `tree-row--ignored` class + dim style + tooltip
- [x] 3.2 Component test

### Verify

- [ ] V.1 `pnpm run ci` + `cargo fmt` + clippy + workspace tests green
- [ ] V.2 Manual: sandbox tree shows `dist/` dimmed, ignored `*.png` listed (dimmed), `node_modules` absent

---

## Risks / Edge Cases

| Case | Handling |
|------|----------|
| Symlinked dir pointing outside worktree | review found `resolve_inside_*` is lexical only; ignored symlinked dirs resolving outside the canonical root are `Hide` (Req 10); non-ignored behavior unchanged |
| macOS `/var` vs `/private/var` root | root canonicalized once in the shared helper (Req 9) |
| Tracked files matching ignore patterns | known limitation: matcher ignores the git index, such rows show dimmed |
| Nested `.gitignore` precedence / no re-include under excluded parent | known divergence from git (first ancestor match wins); unchanged, now visible as dimming |
| Secrets (`.env`, `*.pem`) inside ignored dirs | listed + previewable by design (`get_file` has no ignore check today); ignored *files* outside ignored dirs stay hidden |
| `rg` also honors `.ignore`/`info/exclude`/global excludes | tree flag ≠ search exclusion set; documented |
| Huge ignored dir (`target/`) | listed lazily, one level per request; never walked recursively |
| Ignored dir containing `node_modules` | child hard-hidden |
| Override pattern `*` / `**` | allowed but capped; can show everything except hard-hidden — user's choice |
| Pattern with `..` or absolute path | gitignore matcher is rooted; cannot match outside root (paths outside root never reach it) |
| Negated patterns (`!x`) in `alwaysShow` | treated as gitignore negation inside the override set (documented, harmless) |
| Direct `?path=` into a symlink that leaves the root | pre-existing (`resolve_inside_*` is lexical); not changed here — a candidate hardening (404 when the resolved target is outside the canonical root) |
| Truncated ignored-dir listing | sorted by name then capped at 2000 (deterministic); logs a warning; no wire flag yet |
| Concurrent edits of `file-tree.json` | read per request; torn read → parse error → default for that request |
