# Direct-session live file watching (deferred Stage 3)

**Status:** pending. Split out of the "first-class agent context" PR (Stages 1+2) after review.

## Why this was deferred

The bug that PR fixed was a direct session's open file getting **cleared** (a client state bug — Stage 1) plus fabricated-worktree path bugs in the spawn/plugin layer (Stage 2). This is a *different, pre-existing* gap: a direct session's file tree and open file never **live-update** when files change on disk.

It was deferred because, on its own, it does **not** improve the architecture — it adds surface rather than removing it:

- It introduces a **third** encoding of "worktree | project" on the wire (`WsContextRef` `{kind,id}`), alongside the daemon's `AgentContextRef` (`{kind,projectId,worktreeId}`) and the client's pre-existing `FileScope` + overloaded `worktreeId` prop.
- It needs a dual-field back-compat shape (`context` + legacy `worktreeId`) on every watch message and event, and a more complex event matcher.

It becomes a genuine simplification only if done **together with the client unification** (the "Stage 4" below), where `FileScope` and the `worktreeId`-carrying-a-project-id props collapse into a single context model. Shipping the watch change alone would lock in the third encoding that Stage 4 then has to clean up.

## The gap (verified)

- `daemon/src/ws/protocol.ts` — `file:watch`/`tree:watch`/`file:changed`/`tree:changed` take `worktreeId: z.string()` (non-optional), so a direct session (no worktree) cannot express a watch.
- `daemon/src/ws/handlers/fileWatch.ts` / `treeWatch.ts` — resolve via `getAllProjects().find(p => p.worktrees.some(...))` + `worktreePath(...)`; a direct session's project id matches no worktree → `system:error: "Worktree '<id>' not found"`.
- `web-ui/src/hooks/useSubscription.ts` — `useFileWatch`/`useTreeWatch` early-return `if (scope === "project")` with a comment that the daemon has no project watcher. So `lastChanged` stays `0` forever and the preview/tree never refetch.
- REST file **reads** already work for direct sessions (`routes/projects.ts` `/projects/:id/tree|file-list|files/*`); only the **watch** subsystem is worktree-only.

## Prerequisite: this depends on the daemon context module

Stages 1+2 shipped `daemon/src/services/context.ts` with `AgentContextRef`, `ResolvedContext`, `resolvedContextOf`, and the `*For(ctx,…)` path helpers. Stage 3 will re-introduce two helpers that were removed from that module because nothing used them without Stage 3:

- `resolveContext(ref: AgentContextRef)` — resolve a ref against the store.
- `resolveWorktreeById(id)` — resolve a bare worktree id (the legacy wire shape has no projectId).

Add them back to `context.ts` as part of this work.

## Implementation sketch (from the original, verified-working diff)

Daemon:
- `protocol.ts`: add `WsContextRef = { kind: "worktree" | "project"; id }`. Make `context` optional on watch/unwatch messages and events; keep `worktreeId` as an optional legacy alias. Add `contextRefFromMessage(msg)` normaliser (prefers `context`, falls back to `worktreeId`).
- NEW `ws/handlers/watchContext.ts`: `resolveWatchContext(wireRef)` — `kind:"project"` → `resolveContext({kind:"project",projectId:id})`; `kind:"worktree"` → `resolveWorktreeById(id)`. Deliberately no worktree→project fallback (a dead worktree id must resolve to null, not a same-named project).
- `fileWatch.ts`/`treeWatch.ts`: resolve via `resolveWatchContext`, watch `ctx.cwd`, `watchKey = \`file:${kind}:${id}:${path}\``, emit `context` always plus legacy `worktreeId` only when `ctx.worktree`.
- `fileUnwatch.ts`/`treeUnwatch.ts`: rebuild the **byte-identical** key via the same normaliser (a mismatch leaks inotify handles).

Client:
- `useSubscription.ts`: delete the `scope === "project"` early-returns; `watchTarget(id, scope)` (sends `context`, plus `worktreeId` alias for worktree scope); `matchesContext(ev, id, scope)` (context events match kind+id; legacy events match worktree scope only).
- `api/client.ts`: re-key `fileWatches`/`treeWatches` maps by `${kind}:${id}` (not worktreeId) so **direct watches survive a reconnect**; `watchWire(ref)` for replay.
- `api/types.ts`: `WsContextRef` + `context` on events.

## Back-compat (both directions)

- Old client → new daemon: sends `worktreeId` only → normalised to a worktree ref; worktree events still carry `worktreeId`. ✔
- New client → old daemon: worktree scope works (old zod strips unknown `context`, `worktreeId` still present). Project scope fails parse on the old daemon (its `worktreeId` was required) → noisy `system:error`, functionally today's no-op. Acceptable during a mixed-version window.

## Tests to bring back

- `web-ui/src/hooks/useFileWatch.test.ts` / `useTreeWatch.test.ts`: project-scope watch sends `context` with no `worktreeId` alias; project-scope event bumps `lastChanged`; a worktree event with a colliding id does NOT match a project watcher; a legacy `worktreeId`-only event still matches.
- Daemon: a watch-then-unwatch with a legacy `worktreeId`-only message actually removes the watcher (proves key symmetry — currently only guaranteed by comments).
- Also update `docs/API-CONTRACT.md` for the `context` field (the source-of-truth doc the protocol cites).

## The larger prize — do this as part of "Stage 4"

The client still carries three names for one concept (`FileScope`, `WsContextRef`, and the overloaded `worktreeId` prop threaded through `ToolPanel`/`TabsStrip`/`QuickOpen`/`FilePreviewPane`). Collapsing the store's `activeWorktreeId`/`activeDirectContextId`/`activeProjectId` triple into a single `activeContext: AgentContextRef`, and replacing the `worktreeId` + `scope` prop pair with one `context` prop, is what makes the watch-protocol change a net simplification. Sequence Stage 3 *inside* that work, not before it.

The reference implementation for everything above is preserved in the branch history: commit `c327e40` ("feat(direct-sessions): live file/tree updates via context-aware watch"), verified live in Docker (a project-scoped `file:watch` fired `file:changed` + `tree:changed` on disk edits).
