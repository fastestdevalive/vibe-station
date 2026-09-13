---
feature: file-tabs-open-api
PRD: docs/file-tabs-open-api.md
---

<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: File Tabs + Agent File-Open API

## Change Map

```
daemon/src/
  routes/worktrees.ts          + POST /worktrees/:id/open-file
                               + GET  /worktrees/:id/pending-file-opens
                               + DELETE /worktrees/:id/pending-file-opens
  ws/protocol.ts               + file:open S→C message
  broadcaster.ts               + broadcastWorktree() helper
  services/pendingFileOpens.ts NEW — in-memory queue

cli/src/commands/
  file/                        NEW directory
    open.ts                    NEW — vst file open <worktree-id> <path>
  index.ts                     + register file command

web-ui/src/
  hooks/useStore.ts            ~ activeFilePath → per-worktree tab arrays
  api/types.ts                 + file:open WS event
  api/client.ts                + handle file:open + replay on reconnect
  hooks/usePendingFileOpens.ts NEW — on worktree mount: fetch queue + ack
  components/tools/FilesPanel.tsx   ~ single chip → multi-tab strip
  components/dialogs/QuickOpen.tsx  ~ selectFile uses openFileTabNew logic
  components/layout/FileTreeSidebar.tsx ~ scroll-to/highlight on active tab change

daemon/src/assets/agent-system-prompt.md   + vst file open docs
skill/SKILL.md                             + vst file open docs
```

| File | Today | After |
|------|-------|-------|
| `daemon/src/services/pendingFileOpens.ts` | (absent) | In-memory `Map<worktreeId, string[]>` — append/dedup, read, clear |
| `daemon/src/routes/worktrees.ts` | file-list, tree, diff routes | + 3 open-file endpoints |
| `daemon/src/ws/protocol.ts` | no `file:open` S→C | + `file:open` Zod schema + union |
| `daemon/src/broadcaster.ts` | broadcastAll, notifySession | + `broadcastWorktree()` |
| `cli/src/commands/file/open.ts` | (absent) | `vst file open <wt> <path>` |
| `web-ui/src/hooks/useStore.ts` | `activeFilePath: string \| null` (global) | `openFileTabsByWorktree` + `activeFileTabIdxByWorktree` (per-worktree) |
| `web-ui/src/api/types.ts` | no `file:open` | + `FileOpenMessage` S→C type |
| `web-ui/src/api/client.ts` | handles WS events | + `file:open` handler + replay |
| `web-ui/src/hooks/usePendingFileOpens.ts` | (absent) | Fetches queue on mount, acks |
| `web-ui/src/components/tools/FilesPanel.tsx` | single chip, disabled + | multi-tab strip, working + |
| `web-ui/src/components/dialogs/QuickOpen.tsx` | `setActiveFile(path)` | `openFileTabNew` / switch-to-existing |
| `web-ui/src/components/layout/FileTreeSidebar.tsx` | no scroll-to-active-tab | scroll-to + highlight when tab changes |
| `daemon/src/assets/agent-system-prompt.md` | no file-open docs | + `vst file open` section |
| `skill/SKILL.md` | no file-open docs | + `vst file open` section |

---

## Research

- `activeFilePath: string | null` at `useStore.ts:165` is global — shared across all worktrees; `setActiveFile` derives the worktree key via `layoutKey(s)` (`activeWorktreeId ?? activeDirectContextId`) and updates `lastFileByWorktree` as a side-effect, but `activeFilePath` itself is one slot — opening a file in worktree A clobbers worktree B's active path.
- Per-worktree pattern already established: `diffScopeByWorktree`, `treeScopeByWorktree`, `lastFileByWorktree`, `vcsSelectedCommitByWorktree` — all `Record<string, T>` keyed by worktree id.
- `setActiveWorktree` at `useStore.ts:764` restores `activeFilePath` from `lastFileByWorktree[worktreeId]` on worktree switch — this restore logic must be updated to use the new per-worktree tab arrays.
- `FilesPanel.tsx:37` comment: "Only one file is open at a time today" — tab strip is a single chip with disabled "+".
- `QuickOpen.tsx:74–80`: `selectFile` calls `setActiveFile(path)` then `setToolPanelTab("files")`.
- `broadcaster.ts` has `forEachConnection` and `broadcastAll`; no per-worktree broadcast helper today.
- `treeWatches` key on `WSConnection` is `tree:${worktreeId}:${treePath}` (treeWatch.ts:19); public map — a connection watching a worktree has at least one key prefixed `tree:${worktreeId}:`.
- No `file:open` S→C message in `protocol.ts` today.
- CLI has `cli/src/commands/worktree/`, `session/`, `project/` dirs with per-command files; `cli/src/commands/open.ts` (the `vst open <path>` project-opener) is a flat file, not a directory — `file/` command must be a new directory.

---

## Key Decisions

| # | Decision | Where | Rationale |
|---|----------|-------|-----------|
| D1 | State shape: `openFileTabsByWorktree: Record<string, string[]>` + `activeFileTabIdxByWorktree: Record<string, number>` replaces global `activeFilePath` | `useStore.ts` | Per-worktree keying fixes the latent cross-worktree clobber bug; matches existing `*ByWorktree` pattern |
| D2 | `setActiveFile(path)` kept as compat alias — `null` → `closeFileTab(wt, activeIdx)` (close active tab, no-op if none); non-null → `openFileTab(wt, path)`; derives `wt` from `layoutKey(s)` | `useStore.ts` | Preserves existing close-tab × button behavior; zero call-site changes for non-FilesPanel callers |
| D3 | Pending queue is in-memory `Map<worktreeId, string[]>` in `daemon/src/services/pendingFileOpens.ts` | daemon service | Daemon restart is a disruptive event users notice; queue survives the realistic gap between agent write and user arrival — see PRD |
| D4 | Fan-out scope: all WS connections with any `treeWatches` key prefixed `tree:${worktreeId}:` | `broadcaster.ts` | Reuses existing subscription signal; no new subscription type needed |
| D5 | Pending queue ack: client calls `DELETE /worktrees/:id/pending-file-opens` after consuming; both live (WS event) and late-join (HTTP fetch) paths ack | `worktrees.ts` route + client | Prevents double-open on reconnect without per-client tracking |
| D6 | `openFileTab(wt, path)` replaces active tab; `openFileTabNew(wt, path)` appends (or switches if already open); tree selection uses `openFileTab`; Ctrl+P and `file:open` use `openFileTabNew` | `useStore.ts` | Tree = "navigate this file"; Ctrl+P / agent = "open a new file" — different intent |
| D7 | Two commits: commit 1 = daemon + CLI + skill docs; commit 2 = UI | branch | Daemon-side is independently deployable and reviewable; UI commit is clean |
| D8 | Path validation: `POST /open-file` rejects paths outside `worktree.path` via `path.resolve` prefix check | route handler | Prevent path-traversal to files outside the worktree |
| D9 | `lastFileByWorktree` is updated by every tab action that changes the active path: `openFileTab`/`openFileTabNew`/`closeFileTab`/`setActiveFileTabIdx` all write `lastFileByWorktree[wt] = newActivePath` as a side-effect; `setActiveWorktree` restores from `openFileTabsByWorktree` (not `lastFileByWorktree`) | `useStore.ts` | Keeps `lastFileByWorktree` consistent (used by legacy code paths); single authoritative restore source |
| D10 | `clearWorkspaceSelection` drops the direct `activeFilePath: null` write; instead resets `activeFileTabIdxByWorktree[wt] = -1` (tabs remain, just deactivated) or clears tabs entirely — **choice: keep tabs, reset active index** | `useStore.ts` | Preserves tab list when user navigates away; clean re-enter restores last open files |
| D11 | `setActiveDirectContext` restores from `openFileTabsByWorktree[projectId]` (not `activeFilePath`) — same as `setActiveWorktree`; covers direct sessions keyed by project id | `useStore.ts` | Direct sessions use the same tab model; `activeDirectContextId` is the layout key for direct sessions |
| D12 | Persist migration: bump to `version: 17`; migrate old `activeFilePath` + `activeWorktreeId` → seed `openFileTabsByWorktree[activeWorktreeId] = [activeFilePath]` if both present | `useStore.ts` persist block | Prevents silent loss of the user's previously open file on first load after upgrade |
| D13 | CLI registration file is `cli/src/program.ts` (not `index.ts`) | `cli/src/program.ts` | `index.ts` does not exist in the CLI package |

---

## API Contracts

### REST: Open a file

```
POST /worktrees/:worktreeId/open-file
Authorization: Bearer <token>
Body: { "path": string }   // absolute or relative to worktree root; resolved server-side

200 { "ok": true }
400 { "error": "path required" }
404 { "error": "worktree not found" }
422 { "error": "path outside worktree root" }

Side-effects:
  1. Append path (absolute, dedup) to pendingFileOpens[worktreeId]
  2. Broadcast file:open WS event to all connections watching this worktree
```

### REST: Fetch pending opens

```
GET /worktrees/:worktreeId/pending-file-opens
Authorization: Bearer <token>

200 { "paths": string[] }   // ordered, absolute paths; empty array if none
404 worktree not found
```

### REST: Ack (clear) pending opens

```
DELETE /worktrees/:worktreeId/pending-file-opens
Authorization: Bearer <token>

200 { "ok": true }
404 worktree not found
```

### WS: file:open (S→C)

```ts
{ type: "file:open", worktreeId: string, path: string }
// path is absolute
```

### In-process: pendingFileOpens service

```ts
// daemon/src/services/pendingFileOpens.ts
append(worktreeId: string, path: string): void   // dedup
get(worktreeId: string): string[]                // ordered insertion
clear(worktreeId: string): void
```

---

## System Boundaries

### Daemon route ↔ pending queue service

| | |
|---|---|
| Interface | `append(wt, path)` / `get(wt)` / `clear(wt)` |
| Ownership | `pendingFileOpens.ts` owns the map; route is caller |
| On failure | append is synchronous, no failure path |

### Daemon route ↔ WS broadcaster

| | |
|---|---|
| Interface | `broadcastWorktree(worktreeId, msg)` |
| Ownership | broadcaster sends to all matching connections; route is caller |
| On failure | per-connection `conn.send` is best-effort; no retry |

### UI WS client ↔ store

| | |
|---|---|
| Interface | `openFileTabNew(worktreeId, path)` + `setToolPanelTab("files")` |
| Ownership | store owns tab arrays; WS client is caller |
| On failure | if worktreeId doesn't match active worktree, event is dropped silently |

---

## Phase 1 — Daemon: pending queue + REST API + WS event

- [x] 1.1 Create `daemon/src/services/pendingFileOpens.ts` — module-level `Map<string, string[]>`; export `append`, `get`, `clear`
- [x] 1.2 Add `broadcastWorktree(worktreeId: string, msg: ServerMessage): void` to `daemon/src/broadcaster.ts` — iterates `forEachConnection`, sends to connections whose `treeWatches` has any key starting with `tree:${worktreeId}:`
- [x] 1.3 Add `FileOpenMessage` to `daemon/src/ws/protocol.ts` S→C Zod schema: `{ type: "file:open", worktreeId: string, path: string }`; add to `ServerMessage` union
- [x] 1.4 Add `POST /worktrees/:id/open-file` in `daemon/src/routes/worktrees.ts`:
  - Resolve path relative to worktree root; reject with 422 if outside
  - Call `pendingFileOpens.append(id, absPath)` and `broadcastWorktree(id, { type:"file:open", ... })`
- [x] 1.5 Add `GET /worktrees/:id/pending-file-opens` — returns `{ paths: pendingFileOpens.get(id) }`
- [x] 1.6 Add `DELETE /worktrees/:id/pending-file-opens` — calls `pendingFileOpens.clear(id)`, returns `{ ok: true }`

**Verify phase 1:**
- V1.1 `curl -X POST .../worktrees/<wt>/open-file -d '{"path":"./README.md"}'` → 200 `{ ok: true }` and subsequent GET returns the absolute path
- V1.2 Path outside worktree root → 422
- V1.3 `DELETE .../pending-file-opens` → GET returns `{ paths: [] }`
- V1.4 WS client connected with `tree:watch` receives `file:open` event when POST fires

---

## Phase 2 — CLI: `vst file open`

- [x] 2.1 Create `cli/src/commands/file/` directory
- [x] 2.2 Create `cli/src/commands/file/open.ts` — Commander subcommand `file open <worktreeId> <path>`; resolves relative path to absolute before POST; exits 0 on success, non-zero with message on error
- [x] 2.3 Register `file` command in `cli/src/program.ts` — follow the `registerWorktree*`, `registerSession*`, etc. import pattern at the top of that file (see D13; `cli/src/index.ts` does not exist)

**Verify phase 2:**
- V2.1 `vst file open <wt-id> ./README.md` exits 0 and shows `{ ok: true }`
- V2.2 Bad worktree id → non-zero exit + error message
- V2.3 `vst --help` lists `file` command

---

## Phase 3 — Skill & agent system prompt docs

- [x] 3.1 Add `vst file open` to `skill/SKILL.md` under the CLI reference section (pattern: follow how `vst session send` is documented)
- [x] 3.2 Add `vst file open` to `daemon/src/assets/agent-system-prompt.md` with example using `$VST_WORKTREE` and `$VST_DAEMON_URL`

**Verify phase 3:**
- V3.1 `grep "vst file open" skill/SKILL.md` → matches
- V3.2 `grep "vst file open" daemon/src/assets/agent-system-prompt.md` → matches

> **Commit 1 after phase 3** — daemon + CLI + skill docs

---

## Phase 4 — UI: per-worktree tab state in store

- [ ] 4.1 Add `openFileTabsByWorktree: Record<string, string[]>` and `activeFileTabIdxByWorktree: Record<string, number>` to `WorkspaceState` in `useStore.ts:150`; initialise both to `{}`
- [ ] 4.2 Add actions `openFileTab(worktreeId, path)`, `openFileTabNew(worktreeId, path)`, `closeFileTab(worktreeId, idx)`, `setActiveFileTabIdx(worktreeId, idx)` — see D6; each action also writes `lastFileByWorktree[wt] = newActivePath` as a side-effect (see D9)
- [ ] 4.3 Update `setActiveFile(path)` at `useStore.ts:800`: null → `closeFileTab(wt, activeFileTabIdxByWorktree[wt])` if a tab is active, else no-op; non-null → `openFileTab(wt, path)` — see D2
- [ ] 4.4 Update `setActiveWorktree` at `useStore.ts:764` — restore from `openFileTabsByWorktree[worktreeId]` (array + active index) instead of `activeFilePath`; keep `activeFilePath` as a derived selector (see 4.5) — see D9
- [ ] 4.5 Keep `activeFilePath` in the store as a synced derived field: every action that mutates the active tab also updates `activeFilePath = openFileTabsByWorktree[wt][newIdx] ?? null` within the same `set()` call (avoids selector complexity with persist middleware)
- [ ] 4.6 Update `clearWorkspaceSelection` at `useStore.ts:866` — drop the direct `activeFilePath: null` write; instead set `activeFileTabIdxByWorktree[wt] = -1` (deactivate without clearing tabs) — see D10
- [ ] 4.7 Update `setActiveDirectContext` at `useStore.ts:771` — restore from `openFileTabsByWorktree[projectId]` instead of `activeFilePath` — see D11
- [ ] 4.8 Bump persist `version` to 17 in `useStore.ts`; add `migrate` entry for v16→v17: read `old.activeFilePath` + `old.activeWorktreeId`, seed `openFileTabsByWorktree[activeWorktreeId] = [activeFilePath]` and `activeFileTabIdxByWorktree[activeWorktreeId] = 0` if both present — see D12
- [ ] 4.9 Add `openFileTabsByWorktree` and `activeFileTabIdxByWorktree` to the `partialize` whitelist; keep `activeFilePath` in partialize as a derived field (it will be re-derived from the arrays on load)

**Verify phase 4:**
- V4.1 TypeScript compiles with no errors: `cd web-ui && npm run typecheck`
- V4.2 Switching worktrees restores each worktree's own tab list independently
- V4.3 After `setActiveFile(null)` the active tab closes and adjacent tab activates
- V4.4 After upgrading from v16 (simulate by writing a v16 persist payload to localStorage): the previously open file appears as a tab

---

## Phase 5 — UI: multi-tab strip in FilesPanel

- [ ] 5.1 In `FilesPanel.tsx`: replace the single-chip render with a `map` over `openFileTabsByWorktree[wt] ?? []`; each chip shows `baseName(path)`, close ×, `data-active` on the active index
- [ ] 5.2 Enable the "+" button — clicking opens Ctrl+P (emit a `openQuickOpen` callback prop or reuse existing pattern)
- [ ] 5.3 Wire chip click to `setActiveFileTabIdx(wt, idx)` and × to `closeFileTab(wt, idx)`
- [ ] 5.4 Add `role="tablist"` / `role="tab"` ARIA attributes to the strip

**Verify phase 5:**
- V5.1 Three files open: correct basenames shown, active one has `data-active`
- V5.2 Clicking × on a tab removes it; adjacent tab becomes active
- V5.3 "+" button opens Ctrl+P

---

## Phase 6 — UI: Ctrl+P uses new-tab logic

- [ ] 6.1 In `QuickOpen.tsx:74`, read `openFileTabsByWorktree[worktreeId ?? ""] ?? []` from store
- [ ] 6.2 Replace `setActiveFile(path)` call with: if path already in open tabs → `setActiveFileTabIdx(wt, existingIdx)`, else → `openFileTabNew(wt, path)`
- [ ] 6.3 Optionally show "(already open)" badge on results that are already in an open tab

**Verify phase 6:**
- V6.1 Ctrl+P select a file not open → new tab added
- V6.2 Ctrl+P select a file already open → switches to existing tab, no duplicate

---

## Phase 7 — UI: tree scroll-to-active-tab + WS file:open handler

- [ ] 7.1 In `FileTreeSidebar.tsx`: add a `useEffect` watching `activeFilePath` (derived from active tab) — expand ancestors and scroll-to the matching node when it changes
- [ ] 7.2 Add `file:open` to `web-ui/src/api/types.ts` S→C message union
- [ ] 7.3 In `web-ui/src/api/client.ts`: handle `file:open` message — call `openFileTabNew(msg.worktreeId, msg.path)` and `setToolPanelTab("files")` when `msg.worktreeId === activeWorktreeId`
- [ ] 7.4 Confirm existing reconnect logic in `client.ts` re-registers `tree:watch` subscriptions after reconnect (already the case per `useSubscription.ts`); no additional replay logic needed — Phase 8's HTTP fetch handles the late-join/missed-event path

**Verify phase 7:**
- V7.1 Navigate to a file via tab switch → tree scrolls to and highlights that file
- V7.2 `vst file open $VST_WORKTREE <path>` from a terminal in the sandbox → new tab appears in the UI with the file open

---

## Phase 8 — UI: pending queue fetch on worktree mount

- [ ] 8.1 Create `web-ui/src/hooks/usePendingFileOpens.ts` — takes `(api, worktreeId: string | null)`: on mount (when `worktreeId` is set), calls `GET /worktrees/:id/pending-file-opens`; for each path calls `openFileTabNew(worktreeId, path)` + `setToolPanelTab("files")`; then calls `DELETE /worktrees/:id/pending-file-opens`
- [ ] 8.2 Call `usePendingFileOpens(api, worktreeId)` in `FilesPanel.tsx` (or the worktree route component)

**Verify phase 8:**
- V8.1 `vst file open <wt> <path>` fired while user is on a different page → navigate to that worktree → file tab opens automatically

---

## Phase 9 — Verification in Docker isolation

- [ ] 9.1 Start dev sandbox: `scripts/dev-sandbox.sh up` (default demo seed)
- [ ] 9.2 Verify Req 1: open 3 files via file tree → 3 tabs, tree focus follows each tab switch
- [ ] 9.3 Verify Req 2: Ctrl+P → open already-open file → no duplicate tab; open new file → new tab
- [ ] 9.4 Verify Req 3: `vst file open <wt-id> <path>` from a terminal → tab opens in browser
- [ ] 9.5 Verify late-join: fire `vst file open`, navigate away, navigate back → file opens
- [ ] 9.6 Run `cd web-ui && npm run typecheck && npm run lint` — clean
- [ ] 9.7 Run `cd daemon && npm run typecheck` — clean

---

## Phase 10 — PR

- [ ] 10.1 Open PR with title `feat(files): multi-tab viewer + agent file-open API`
- [ ] 10.2 PR body references this plan and lists all 3 requirements with verification steps

---

## Files & Phase Impact

| File | Phase | Change |
|------|-------|--------|
| `daemon/src/services/pendingFileOpens.ts` | 1 | NEW |
| `daemon/src/broadcaster.ts` | 1 | + `broadcastWorktree` |
| `daemon/src/ws/protocol.ts` | 1 | + `file:open` S→C |
| `daemon/src/routes/worktrees.ts` | 1 | + 3 endpoints |
| `cli/src/commands/file/open.ts` | 2 | NEW |
| `cli/src/index.ts` | 2 | register `file` |
| `skill/SKILL.md` | 3 | + `vst file open` docs |
| `daemon/src/assets/agent-system-prompt.md` | 3 | + `vst file open` docs |
| `web-ui/src/hooks/useStore.ts` | 4 | state shape + actions |
| `web-ui/src/components/tools/FilesPanel.tsx` | 5 | multi-tab strip |
| `web-ui/src/components/dialogs/QuickOpen.tsx` | 6 | new-tab logic |
| `web-ui/src/components/layout/FileTreeSidebar.tsx` | 7 | scroll-to-active |
| `web-ui/src/api/types.ts` | 7 | + `file:open` event |
| `web-ui/src/api/client.ts` | 7 | handle `file:open` |
| `web-ui/src/hooks/usePendingFileOpens.ts` | 8 | NEW |
