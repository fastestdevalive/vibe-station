# Report: why do ghost/stale agent sessions survive a reconnect, and is refetch-on-reconnect scalable?

**Date:** 2026-09-21 · **Commit:** 99223e70b304fc8b8da38406f24ed263ae567395 · **Scope:** web-ui reconnect/resync path (`useServerSync`, `useStore` canvas/tile state, `TabsStrip`, `AgentPaneSlot`) · **Method:** static read of the sync hooks + grep for `ws:open`/tile-pruning call sites

## Answer
- Reconnect **does** already do a full REST refetch of projects/worktrees/sessions (`useServerSync.ts:91-156`, fires on mount and on every `ws:open`) — so the premise "a new connection should fetch latest state" is already implemented at the data layer. That part is fine and is O(1) per reconnect, not a scaling problem.
- The bug is that **two other pieces of client state are not reconciled against that fresh list**, so they go stale even though the source-of-truth store (`useServerStore.sessions`) is correct:
  1. **Canvas/tab tile geometry** (`layoutByWorktree`, `workspaceDocs` — persisted client-side via zustand `persist`) is only pruned by the live `session:deleted` WS event handler (`useServerSync.ts:271-291` → `removeTilesForSession`). The reconnect refresh path never calls it, so a tile for a subagent deleted while offline just sits there forever pointing at a dead id.
  2. **`TabsStrip.tsx`'s own `localSessions` copy** has no `ws:open` listener at all — its fetch effect only re-runs when `worktreeId`/`kind` changes (`TabsStrip.tsx:376-420`). It depends entirely on incremental `session:created/state/exited/resumed` events to stay current, all of which were missed while disconnected.
- Net effect: tapping a ghost tab/tile sets `activeSessionId` to an id that no longer exists in `useServerStore.sessions`. `AgentPaneSlot` receives `session={undefined}` for it, which makes both `isJson` and `isTerminal` false, so neither `ChatPane` nor a live `TerminalPane` renders — an inert pane, i.e. "tapping does nothing."
- This is not a new bug pattern for this repo — `AGENTS.md`'s own "Session status in a pane" section already documents `TabsStrip.tsx`'s `localSessions` as a component with its own fetched copy needing its own WS reconciliation, but that note only covers `.state` staleness (a stuck "Draft" badge), not full add/remove staleness after a reconnect gap. This report extends the same pattern to the reconnect case.

## Evidence
| Claim | Source |
|-------|--------|
| Reconnect already refetches projects/worktrees/sessions on every `ws:open` | `web-ui/src/hooks/useServerSync.ts:91-156` |
| `syncSessionsFromApi` only upserts `sessionStates` entries present in the fresh list; never deletes stale ones for sessions no longer returned | `web-ui/src/hooks/useStore.ts:1043-1050` |
| `removeTilesForSession` (the only tile-pruning function) is called from exactly one place: the live `session:deleted` WS handler | `web-ui/src/hooks/useServerSync.ts:271-291` (grep confirms no other call site in `useServerSync.ts`/`useStore.ts`) |
| `layoutByWorktree` (canvas tile geometry) is `persist`-backed client state, independent of `useServerStore` | `web-ui/src/hooks/useStore.ts:646` (`persist(...)`), `:152` (`layoutByWorktree` field) |
| `TabsStrip.tsx` has no `ws:open` listener anywhere in the file | `$ grep -n "ws:open" web-ui/src/components/layout/TabsStrip.tsx` → no output |
| `TabsStrip.tsx`'s session refetch effect only re-runs on `worktreeId`/`kind`/`isProject` change, not on reconnect | `web-ui/src/components/layout/TabsStrip.tsx:376-421` |
| `TabsStrip.tsx` otherwise relies solely on incremental `session:created/state/exited/resumed` handlers | `web-ui/src/components/layout/TabsStrip.tsx:535-544` |
| `AgentPaneSlot` derives `isJson`/`isTerminal` from `session?.channel`/`session!.state`, both `false`/crash-guarded when `session` is `undefined` | `web-ui/src/components/layout/AgentPaneSlot.tsx:54-73` |
| AGENTS.md already flags `TabsStrip`'s `localSessions` as needing its own WS reconciliation, scoped to `.state` only | Prompt-injected `AGENTS.md`, "Session status in a pane" section, bullet 2 |

## Detail
- **Why this isn't a "refetch everything is unscalable" problem in practice:** the refetch is 3 REST calls per reconnect (`listProjects`, `listWorktrees`, `listSessions`), already deduped by the module-level `inFlightRefresh` guard (`useServerSync.ts:26,92-118`) so bursts of `ws:open`/mount collapse into one round trip. This scales the same way the initial page load already does — it is not proportional to how long the client was offline, only to current server-side counts. The actual gap is reconciliation of *derived* client state, not the fetch itself.
- **Subagent-specific angle:** a subagent created while offline *does* show up correctly in any list that reads live off `useServerStore.sessions` (e.g. `SubagentRow.tsx` imports `useServerStore` directly) because `replaceAll` fully replaces the array — no diffing needed there. The staleness is confined to state that lives *outside* `useServerStore`: tile geometry and `TabsStrip`'s shadow copy.
- **Why the symptom looks like "4 stale agents, unresponsive taps"** rather than an error: nothing throws. The tile/tab renders using cached props (name, last known status), and only the pane's *content* silently goes blank because `session` resolves to `undefined` at render time — there's no error boundary or empty-state that would tell the user the session is gone.

```
ws:open
  └─ useServerSync.refresh()
       ├─ replaceAll({projects, worktrees, sessions})   ✅ useServerStore now correct
       ├─ syncSessionsFromApi(sessions)                  ✅ sessionStates upserted (not pruned)
       └─ resolveSupersededChains(...)                   ✅ handles reset chains

  MISSING reconciliation:
       ├─ layoutByWorktree / workspaceDocs tiles for sessions no longer in `sessions`
       └─ TabsStrip.localSessions (no ws:open listener at all)
```

## Not checked
- Mobile client specifics (native app / PWA reconnect lifecycle, whether backgrounding tears down the WS differently than a desktop tab) — this report only traced the shared `web-ui` React code, not any mobile-wrapper-specific reconnect logic (if one exists outside `web-ui/`).
- Server/daemon side: whether the daemon ever explicitly pushes a "you missed N events" signal on reconnect (e.g. a WS resume-from-cursor mechanism) as an alternative to blind full refetch — not found in the files examined, but the daemon WS handshake code itself wasn't read in this pass.
- Did not runtime-verify (no browser/daemon session was driven) — this is a static-read trace of the call graph; recommend confirming with the dev state simulator (Ctrl+Shift+D per AGENTS.md) or a live disconnect/reconnect repro before implementing a fix.

## Follow-ups
| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | Should `useServerSync.refresh()` diff old vs. new `sessions` and call `removeTilesForSession` for every id present before but absent after? | This is the most direct, minimal fix for the canvas/tile half of the bug — reuses the exact same pruning function the live path already uses. |
| 2 | Should `TabsStrip.tsx` subscribe to `api.on("ws:open", ...)` and re-run its `listSessions(worktreeId)` effect, unioning with `arrivedDuringFetch` the same way it already does for `session:created` races? | Closes the other half of the bug; matches the existing in-file comment acknowledging `localSessions` needs its own reconciliation. |
| 3 | Should `syncSessionsFromApi` also delete `sessionStates` entries for ids missing from the fresh list, to stop `sessionStates` accumulating unbounded ghost entries across a long-lived client session? | Smaller/leak-shaped, not user-visible today, but same root cause (upsert-only, no prune) and cheap to fix alongside #1. |
| 4 | Is there a general pattern worth extracting — e.g. a single `reconcileClientStateWithSessions(freshSessions)` called from `refresh()` that all three (`tiles`, `TabsStrip`, `sessionStates`) hook into — instead of three independent ad hoc fixes? | Given AGENTS.md already documents this class of bug recurring 3x in one feature, a shared reconciliation entry point would stop it recurring a 4th/5th time in new panes. |
