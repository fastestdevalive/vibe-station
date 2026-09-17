# Report: IDE-quality features for vibe-station — file speed, tool pane, project model

**Date:** 2026-09-16 · **Commit:** 93cc6cdd053dead86e5e5f9a53351638aa127b70  
**Scope:** px0 (`~/code/fastestdevalive/px0`) vs vibe-station Rust daemon (`rust/`) — file tree, search, git, tool pane, project creation  
**Method:** static code exploration of both repos (Rust code only for vibe-station)

---

## Answer

- **Three independent tracks**, each shippable on its own: (1) file I/O performance & content search, (2) tool pane IDE features, (3) project model decoupling from git
- **Biggest gaps today:** no content search at all, no file outline / code navigation, no git gutter in file preview, tree walk is sequential
- **Priority order (impact × LOE):** Project model > File outline + tabs > Content search > Git gutter > Parallel tree walk

---

## Evidence

| Claim | Source |
|-------|--------|
| Tree route uses sequential `tokio::fs::read_dir`, entries read one at a time | `rust/vst-routes/src/worktrees.rs:1186` |
| File list: ripgrep subprocess preferred, walkdir fallback (root `.gitignore` only) | `rust/vst-ws/src/services/file_list.rs:88,132` |
| File watch uses `notify::recommended_watcher` (inotify on Linux, FSEvents on macOS) | `rust/vst-ws/src/streams/file_watcher.rs:85,128` |
| Debounce is a fixed 200ms sleep per event — no coalescing/timer-reset | `rust/vst-ws/src/streams/file_watcher.rs:53,105,147` |
| `IgnoreMatcher` does full nested-gitignore traversal | `rust/vst-ws/src/services/ignore_filter.rs:59–78` |
| No content search route exists in `vst-routes` | `grep -i search rust/vst-routes/src/*.rs` → 0 hits |
| No file outline / symbols route | `rust/vst-routes/src/` — no `outline.rs`, no `/outline` endpoint |
| Worktree create hard-blocks non-git projects (400) | `rust/vst-routes/src/worktrees.rs` (ported from Node) |
| px0 parallel walk: semaphore `NumCPU×4` goroutines, root published before subtrees | `px0/index.go Build()` |
| px0 debounce: timer-reset per debounce window (not fixed sleep) | `px0/index.go` |
| px0 content search: N-CPU workers, `bytes.Contains` fast-reject, regex support | `px0/search.go` |
| px0 outline: per-language regex, upgrades to LSP async | `px0/symbols.go`, `px0/web/src/outline.js` |
| px0 git gutter: `gitHunks` → add/mod/del line arrays → in-viewer margin marks | `px0/git.go`, `px0/web/src/renderer.js` |
| px0 opens any folder, git entirely optional | `px0/main.go resolveTarget` |

---

## Detail

### Track 1 — File I/O speed

**Current state vs px0:**

| Feature | px0 | vibe-station Rust today | Gap |
|---------|-----|------------------------|-----|
| Tree walk concurrency | Parallel (`NumCPU×4` goroutines) | Sequential `tokio::fs::read_dir` per expanded dir | Medium — noticeable on large repos |
| Root-first render | Root children published before subtrees finish | N/A — lazy per-click, adequate for most dirs | Low |
| File list (Quick Open) | In-memory sorted index, sub-ms fuzzy | `rg --files` subprocess per open, fuzzy in browser | Low — rg is fast, acceptable |
| Watch debounce | Timer-reset per window (no duplicate callbacks) | Fixed 200ms sleep per event, no coalescing | Low — can produce redundant reloads on burst saves |
| Filesystem backend | Go `fsnotify` (inotify/kqueue) | `notify::recommended_watcher` (inotify/FSEvents) | **None** — already native, NOT chokidar |
| Content search | N-CPU workers, fast-reject, regex, glob filter | **None** | **High — entirely missing** |
| Git gutter in viewer | `gitHunks` → per-line add/mod/del marks | **None** | Medium |

**Proposed features (Track 1):**

- **F1.1 — Content search endpoint + UI**
  - New `GET /worktrees/:id/search?q=&re=&case=&word=&glob=` route in `vst-routes/src/worktrees.rs`
  - Backend: `rg --json` subprocess (respects gitignore, binary skip, fast); line-by-line fallback only if rg absent
  - UI: new `search` tab in ToolPanel, debounced 200ms, grouped-by-file results, highlighted `pre/match/post` snippets
  - **Architecture note:** content search must be server-driven (can't ship file contents to the browser). Filename/fuzzy-find stays client-side — fetch file list once on open, all keystroke filtering in the browser. Do NOT adopt px0's per-keystroke `/api/find` model for filename search.
  - Scope: text search only; no semantic/LSP search in this track

- **F1.2 — Parallel tree walk (Rayon)**
  - `tree` route spawns `tokio::task::spawn_blocking` with Rayon parallel iterator over `std::fs::read_dir`
  - Root children returned first (progressive JSON or two-phase response); subdirs filled async
  - Wins most on repos with 10k+ files (JS monorepos, large Rust workspaces)

- **F1.3 — Git gutter in file preview**
  - New `GET /worktrees/:id/gutter/*path` → `{ added: [u32], deleted: [u32], modified: [u32] }`
  - Backend in `vst-git`: `git diff HEAD -- <path>`, parse unified diff hunk headers to 1-based line arrays
  - UI: `FilePreviewPane` renders a 4px left margin with colored marks per line

- **F1.4 — Watch debounce coalescing**
  - Replace fixed-sleep-per-event with a timer-reset pattern: first event starts a 150ms timer; subsequent events within the window reset it; only one callback fires per burst
  - In `rust/vst-ws/src/streams/file_watcher.rs` — small, self-contained change

### Track 2 — Tool pane IDE features

**Current FilesPanel:** tree sidebar + single file preview + open-file tab strip (`+` → Quick Open).

**Proposed features (Track 2):**

- **F2.1 — File outline panel**
  - New `GET /worktrees/:id/outline/*path` → `{ symbols: [{name, kind, line, indent}] }`
  - Backend in `vst-routes`: per-language regex patterns (same approach as px0 `symbols.go`); no LSP required
  - Languages priority: TS/JS, Python, Rust, Go, Markdown headings (covers >90% of user repos)
  - UI: `OutlinePanel` sub-panel inside FilesPanel, filterable, click-to-jump in `FilePreviewPane`

- **F2.2 — Multi-tab polish**
  - Tab strip + `+` button already exists in `FilesPanel`
  - Missing: per-tab scroll/cursor position not preserved on switch, no recently-closed tab restore, no reorder
  - Proposed: store `{ scrollTop, selectedLine }` per tab in component state; restore on switch; Alt+Shift+T reopen

- **F2.3 — Code navigation (go-to-definition, find-refs)**
  - Lightweight: reuse F2.1 outline index + whole-file symbol search for go-to-def with declaration scoring (same as px0 `/api/def`)
  - Full: optional LSP client per language — separate follow-on, not part of this track

- **F2.4 — Collapse stub Devices + Artifacts tabs**
  - Both panels are confirmed stubs; move behind a "More" overflow to free space for `search` + `outline` tabs

### Track 3 — Project model decoupling from git

**Current behavior:**
1. `POST /projects/create`: always git-inits (ported behavior)
2. Adding a non-git folder from `DraftComposer`: also git-inits silently
3. Worktree create hard-blocks non-git projects (400 from `vst-routes/src/worktrees.rs`)

**Proposed features (Track 3):**

- **F3.1 — Open any folder as a project (no auto git-init)**
  - `POST /projects/create`: accept `git?: bool`, default `false`; only run git init when explicitly requested
  - Adding existing folder: detect `isGit` and show a UI choice instead of silently git-initing
  - Non-git projects: full tree + preview + search works; VCS tab hides git-specific panels

- **F3.2 — Defer git init to worktree agent creation**
  - When starting a worktree agent on a non-git project: one-time prompt "This will initialize a git repo — continue?"
  - On confirm: git init + initial commit → `project.isGit = true` → proceed to worktree creation
  - On decline: fall back to direct session

- **F3.3 — Direct session as first-class mode**
  - Make "open folder → direct session" the default for new non-git projects; "new agent branch" is the git-init trigger
  - Remove `showWorktreeFields: sessionProject?.isGit ?? true` default that shows worktree fields before git status is known

---

## Not checked

- **LSP server lifecycle** — how to spawn/kill per-project language servers; relevant for F2.3 full path
- **`FilePreviewPane` line rendering internals** — virtualization depth, gutter injection point for F1.3
- **Rayon availability in vst-routes** — whether it's already a dep or needs adding for F1.2
- **Mobile UI impact** — new ToolPanel tabs on mobile layout not assessed
- **Search result streaming** — whether frontend handles streamed JSON lines vs buffered response

---

## Follow-ups

| # | Question | Why it matters |
|---|----------|----------------|
| 1 | Is `rg` always available in the daemon's PATH in prod, or do we need to bundle it? | F1.1 — `rg --json` vs pure-Rust line scanner fallback |
| 2 | Should the outline panel live inside FilesPanel or as its own ToolPanel tab? | UX decision before F2.1 |
| 3 | Are there existing projects with `isGit: false` in the SQLite store that need migration for F3.1? | Safety of changing `POST /projects/create` default |
| 4 | Should `FileScope` be replaced with a capability flags struct (`{ git, search, outline }`)? | Cleaner model for F3.1–3.3 vs scattered `isGit` checks |
| 5 | Do we want F1.4 (debounce coalescing) as a quick fix before the bigger tracks, or bundle it with F1.1? | Sequencing |
