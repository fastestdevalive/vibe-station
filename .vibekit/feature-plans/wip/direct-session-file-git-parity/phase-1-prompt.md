# Turn-implement: Phase 1 — File-watch project scope

You are a scoped implementer for ONE phase of a larger plan. You have no memory of any other
phase and will not exist when later phases run — write anything future phases need into the
plan file itself under `## Key Decisions` (it already exists) or a note near your checklist
items, not just in your own head.

**Before touching any file:** read the `coding-agent-guardrails` skill, then the `coding` skill.

**Plan file (read the whole file for context, but you only OWN Phase 1's checklist items below):**
`.vibekit/feature-plans/wip/direct-session-file-git-parity/plan-direct-session-file-git-parity.md`

Repo root for all commands: this worktree's top level (contains `rust/`, `web-ui/`,
`pnpm-workspace.yaml`).

## Relevant Key Decisions (read these in full from the plan file before starting)

- **Decision 1** (WS watch scope is a typed enum field, default `worktree`, on all 4 message
  variants) — `rust/vst-types/src/ws.rs:44-57` area.
- **Decision 2** (Resolver signature grows a scope parameter; `server.rs` builds ONE combined
  closure) — `rust/vst-ws/src/handlers/file_watch.rs`, `tree_watch.rs`, `rust/vst-daemon/src/server.rs:437-447`.

## Your checklist items — Phase 1

Mark each `[x]` in the plan file as you complete it. Items 1.1–1.7 are implementation;
1.T1–1.T8 are the verify block (the orchestrator will re-run these itself after you finish —
you do not need to trust your own run, but do run them to catch mistakes before handing off).

- [ ] **1.1** In `rust/vst-types/src/ws.rs`, add the `WatchScope` enum (Decision 1's snippet) near
  `TreeChangeKind` (currently `:270-277`). Add `#[serde(default)] pub scope: WatchScope` as a NEW
  field to `ClientMessage::FileWatch`, `FileUnwatch`, `TreeWatch`, `TreeUnwatch` (currently
  `ws.rs:44-57`) — keep the existing `worktree_id`/`path` fields unchanged, this is purely additive.
- [ ] **1.2** In `rust/vst-ws/src/handlers/file_watch.rs:14`, change `WorktreePathResolver` to
  `Arc<dyn Fn(&str, vst_types::ws::WatchScope) -> Option<PathBuf> + Send + Sync>`. Update
  `handle_file_watch` (`:69-77`) to destructure `scope` out of `msg` and pass it through
  `resolve_root(...)`. `handle_file_unwatch`/`release_shared_file_watcher` (`:192-203`) do NOT call
  `resolve_root` at all — they only need `scope` added to their `ClientMessage::FileWatch { .. }`
  destructuring pattern (`let ClientMessage::FileUnwatch { worktree_id, path, .. } = msg`), no
  resolver call to update. The `watch_key` format string stays `format!("file:{worktree_id}:{path}")`
  UNCHANGED (Decision 1 — no wire/key format change, only resolver behavior).
- [ ] **1.3** Same shape in `rust/vst-ws/src/handlers/tree_watch.rs:72-81` (`handle_tree_watch`
  destructures `scope` and passes it to `resolve_root(...)`) and `:248-262`
  (`handle_tree_unwatch`/`release_shared_tree_watcher` — no `resolve_root` call there either, just
  add `..` to the destructuring pattern), `watch_key` format unchanged.
- [ ] **1.4** Update EVERY `#[cfg(test)] mod tests` closure/literal in both files that currently
  builds `ClientMessage::FileWatch { worktree_id, path }` / `TreeWatch { worktree_id, path }` (no
  `scope` field) — add `scope: vst_types::ws::WatchScope::Worktree` to each literal. In
  `file_watch.rs`, there IS a single `resolve_root(root: PathBuf) -> WorktreePathResolver` helper
  **function** (`:277`, currently `Arc::new(move |_| Some(root.clone()))`) — update its signature to
  `Arc::new(move |_id: &str, _scope: vst_types::ws::WatchScope| Some(root.clone()))`. `tree_watch.rs`
  has NO such helper function — its tests build the resolver as inline `let resolve_root:
  WorktreePathResolver = { ... Arc::new(move |_| ...) }` blocks at roughly `:467, 531, 597, 663, 715`
  — update the closure signature at each of those 5 inline sites individually.
- [ ] **1.5** In `rust/vst-daemon/src/server.rs:437-447`, replace `worktree_path_resolver`'s body
  with Decision 2's snippet (branches on `WatchScope::Project` vs `WatchScope::Worktree`); add `use
  vst_types::ws::WatchScope;` to this file's imports. `DispatchContext` (`rust/vst-ws/src/server.rs:35,43`
  — NOT in the daemon crate) already declares `resolve_worktree_root` typed as the
  `WorktreePathResolver` alias, so its field type updates automatically once the alias itself changes
  shape (1.2) — no separate edit needed there. The dispatcher (`vst-ws/src/server.rs:76-94`) already
  passes the WHOLE `msg` into `handle_file_watch`/`handle_tree_watch`, which internally
  destructure/match on it — no change needed to the dispatch call sites either.
- [ ] **1.6** In `web-ui/src/hooks/useSubscription.ts`, remove the `if (scope === "project") return
  undefined;` early-return in `useFileWatch` (`:106`) and `useTreeWatch` (`:215`). Update both
  hooks' `api.send(...)` calls to include `scope` ONLY when the hook's `FileScope` param is
  `"project"` — e.g. `api.send({ type: "file:watch", worktreeId, path, ...(hookScope === "project" ?
  { scope: "project" as const } : {}) })`. Omitting the field for worktree scope (rather than sending
  `scope: "worktree"` explicitly) means the daemon's `#[serde(default)]` resolves it identically AND
  every existing worktree-scope exact-object assertion in `useFileWatch.test.ts`/`useTreeWatch.test.ts`/
  `QuickOpen.test.tsx` (which assert the message literal with no `scope` key at all) keeps passing
  unmodified.
- [ ] **1.7** In `web-ui/src/api/client.ts:1077-1116` (`send()`), widen the message parameter type
  to accept an optional `scope?: "worktree" | "project"`, thread it into `fileWatches`/`treeWatches`
  map entries (currently `{ worktreeId: string; path: string }` — add `scope?: "worktree" |
  "project"`), and into the reconnect-replay block (`:342-353`) so a reconnect re-sends the SAME
  message shape it watched with originally (including `scope` if and only if it was present the first
  time) — not a default-omitted (and thus daemon-defaulted-to-worktree) one for what was actually a
  project-scope watch.

**Verify phase 1 (run these yourself before finishing, orchestrator re-verifies independently):**
- [ ] **1.T1** Unit — `rust/vst-ws/src/handlers/file_watch.rs`: a `ClientMessage::FileWatch { scope:
  WatchScope::Project, worktree_id: "proj1", path }` resolves against a resolver that returns a
  path ONLY for `(id, WatchScope::Project)`, not `(id, WatchScope::Worktree)` — add a new test
  mirroring `two_connections_watching_same_file_share_one_watcher` but asserting the PROJECT branch
  of a resolver that distinguishes scopes (assert `SystemError` is NOT sent, i.e. the watcher
  registers successfully).
- [ ] **1.T2** Unit — `rust/vst-ws/src/handlers/tree_watch.rs`: same as 1.T1 for `TreeWatch` —
  project-scope resolution succeeds against a project-only resolver.
- [ ] **1.T3** Regression — every EXISTING test in both `file_watch.rs` and `tree_watch.rs` still
  passes unmodified in assertions — only their `ClientMessage`/resolver literals change shape (1.4).
- [ ] **1.T4** Unit — `web-ui/src/hooks/useFileWatch.test.ts`: add a new case —
  `useFileWatch(api, "proj1", path, "project")` calls `api.send({ type: "file:watch", worktreeId:
  "proj1", path, scope: "project" })` (was previously a no-op under project scope — assert the call
  now happens, with the `scope` field present). The file's EXISTING test (`:12,16` — worktree scope,
  no `scope` field in the asserted object) is left unmodified, per 1.6's "send scope only when
  project" choice.
- [ ] **1.T5** Unit — `web-ui/src/hooks/useTreeWatch.test.ts`: add a new case —
  `useTreeWatch(api, "proj1", "project")` sends `{ type: "tree:watch", worktreeId: "proj1", scope:
  "project" }`. The file's EXISTING test (`:11,13` — worktree scope) is left unmodified, same reason
  as 1.T4.
- [ ] **1.T6** Regression — `useFileWatch.test.ts`'s and `useTreeWatch.test.ts`'s existing
  worktree-scope cases still pass byte-for-byte unmodified (no `scope` key sent, matching today's
  exact-object assertions) — this is the direct payoff of 1.6's approach.
- [ ] **1.T7** Unit — `web-ui/src/components/dialogs/QuickOpen.test.tsx`: invert `:305-314`'s
  `"5.T7b: project scope never sends tree:watch"` test — under project scope it now DOES send
  `tree:watch`/`tree:unwatch` with `scope: "project"` (mirroring `:296,301`'s worktree-scope
  assertions, which stay unmodified per 1.6). Rename the test to reflect the new behavior (e.g.
  `"5.T7b: project scope sends tree:watch with scope=project"`).
- [ ] **1.T8** Unit — `web-ui/src/api/client.test.ts`'s existing `describe("file:watch / tree:watch
  reconnect-replay refcounting")` block (`:227`) is the correct home for this test — `useFileWatch.test.ts`
  uses `createMockApi()` and cannot simulate a reconnect. Add a case there: a project-scope watch
  registered before a disconnect is replayed WITH `scope: "project"` on reconnect, not silently
  dropped to worktree-scope (this exercises 1.7's replay-path edit directly).

**Run (do this yourself, then report the results — orchestrator re-runs independently after you exit):**
```
cd rust && cargo test -p vst-types -p vst-ws -p vst-daemon
pnpm --filter @vibestation/web test -- src/hooks/useFileWatch.test.ts src/hooks/useTreeWatch.test.ts src/components/dialogs/QuickOpen.test.tsx src/api/client.test.ts
pnpm --filter @vibestation/web typecheck
```

## Files you will touch (Files & Phase Impact table, Phase 1 rows only)

| File | Phase | Description / Contract Change |
|------|-------|-------------------------------|
| `rust/vst-types/src/ws.rs` | 1.1 | Add `WatchScope` enum + `scope: WatchScope` (`#[serde(default)]`) field to 4 `ClientMessage` variants |
| `rust/vst-ws/src/handlers/file_watch.rs` | 1.2, 1.4 | `WorktreePathResolver` contract: `Fn(&str, WatchScope) -> Option<PathBuf>`; test literals/helpers updated |
| `rust/vst-ws/src/handlers/tree_watch.rs` | 1.3, 1.4 | Same resolver contract change; test literals/helpers updated |
| `rust/vst-daemon/src/server.rs` | 1.5 | `worktree_path_resolver` branches on scope (do NOT touch the `/projects/:id/...` route registrations here — that's Phase 2, not yours) |
| `web-ui/src/hooks/useSubscription.ts` | 1.6 | `useFileWatch`/`useTreeWatch` drop project-scope early-return, send `scope` field only when `"project"` |
| `web-ui/src/hooks/useFileWatch.test.ts` | 1.T4, 1.T6 | New project-scope assertion; existing worktree-scope assertion (`:12,16`) unchanged |
| `web-ui/src/hooks/useTreeWatch.test.ts` | 1.T5, 1.T6 | New project-scope assertion; existing worktree-scope assertion (`:11,13`) unchanged |
| `web-ui/src/api/client.ts` | 1.7 | `send()` threads `scope` through watch maps + reconnect-replay (do NOT touch `listChangedPaths`/`listCommits`/`getDiff` here — that's Phases 2/3, not yours) |
| `web-ui/src/components/dialogs/QuickOpen.test.tsx` | 1.T7 | `:305-314` inverted (project scope now sends `tree:watch`) |
| `web-ui/src/api/client.test.ts` | 1.T8 | New reconnect-replay-preserves-scope test |

## When done

1. Ensure all 1.1–1.7 and 1.T1–1.T8 are marked `[x]` in the plan file.
2. If you deviated from the plan's exact wording anywhere (e.g. a line number had drifted, or a
   detail was wrong), record it as a short note in the plan file near the affected checklist item —
   the orchestrator and later phases have no other way to learn about it.
3. Do NOT commit. Do NOT touch `.sdlc-state.yaml`. Do NOT start Phase 2 or Phase 3.
4. Report: which items are done, the actual test/typecheck output (paste it, don't summarize as
   "passed"), and any deviation notes.
