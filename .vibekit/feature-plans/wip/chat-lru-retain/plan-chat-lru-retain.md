<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Instant rich-chat restore on worktree switch

**Feature:** `chat-lru-retain`
**Branch:** `loading-detaches-everytime`

---

## Problem

Switching worktrees unmounts panes → `useChat` resets to `[]` + shows spinner → `chat:open` → full tail replay → visible loading flash.
Within-worktree tab switching is already instant.

---

## Solution

### Part A — Client-side snapshot cache + sinceSeq delta

```
switch away  →  save snapshot  →  chat:close normally
switch back  →  setState(snapshot) immediately + setLoading(false)  →  chat:open { sinceSeq }  →  delta merges in
```

**Snapshot shape:**
```ts
interface ChatSnapshot {
  events: ChatEvent[];        // newest MAX_SNAPSHOT_EVENTS=200; oldestSeq recomputed after truncation
  oldestSeq: number | null;   // = truncated[0].logSeq ?? null after truncation
  hasMore: boolean;           // forced true if truncated
  userTurnIds: Set<string>;
  latestSeq: number | null;   // Math.max() of defined logSeqs; null/0 → skip sinceSeq
  savedAt: number;            // Date.now()
}
// module-level Map<sessionId, ChatSnapshot>, LRU cap 20
// excludes sessions where useChat is called with { cache: false }
```

**Restore sequence:**
```
1. useChat mounts
2. restore(sessionId)?
   NO  → setLoading(true); full tail (unchanged)
   YES → setState({ events, oldestSeq, hasMore, userTurnIds })
         setLoading(false)          ← suppresses spinner; events already visible
         setIsDeltaLoading(true); isDeltaLoadingRef.current = true
         sinceSeq = (latestSeq > 0 && savedAt within 60s) ? latestSeq : undefined
         api.openChat(sessionId, sinceSeq)
3. chat:replay arrives — discriminate via `e.hasMore === undefined` (matches useChat.ts:145):
   - sinceSeq path (`e.hasMore === undefined`): mergeEvents(); clear restoredLatestSeqRef
   - plain path (`e.hasMore !== undefined`):
     gap-check: if e.oldestSeq != null && restoredLatestSeqRef.current != null
                   && e.oldestSeq > restoredLatestSeqRef.current
                → drop restored events; setState(delta.events); update cursors from delta
                else mergeEvents() normally
     clear restoredLatestSeqRef in both cases
   clear isDeltaLoadingRef.current; setIsDeltaLoading(false); cancel failsafe
4. Failsafe: setIsDeltaLoading(false) after 5s — clears spinner state only;
   restoredLatestSeqRef cleared only when a replay is consumed (not by failsafe)
5. session:meta arrives → updates meta (never from snapshot; status bar may briefly be blank — known/acceptable)
6. Live session:message events flow normally
```

**Cold-start double-open fix:**
- `chatSubs`: `Map<sid, { refs: number; sinceSeq?: number }>` (was `Map<sid, number>`)
- `openChat(sid, sinceSeq?)` stores `sinceSeq` in the entry on 0→1 transition
- `socket.onopen` replay sends `{ type: "chat:open", sessionId, sinceSeq: entry.sinceSeq }` — no double-open with conflicting seqs

**Snapshot capture (ref-based, StrictMode-safe):**
- `eventsRef`, `oldestSeqRef`, `hasMoreRef`, `userTurnIdsRef`, `isDeltaLoadingRef`, `restoredLatestSeqRef`
- Synced with state on every render
- Cleanup guards: skip save if `eventsRef.current.length === 0` OR `isDeltaLoadingRef.current`
- Truncation: keep newest 200; recompute `oldestSeq = truncated[0].logSeq ?? null`; set `hasMore = hasMoreRef.current || truncated` (not unconditionally true — short sessions must not show a spurious "load earlier")

**Child session opt-out:**
- `useChat(api, sessionId, enabled, { cache?: boolean })` — new 4th arg, default `true`
- Destructure to `const cacheEnabled = opts?.cache !== false` immediately; use primitive in effect deps, not the opts object (avoids infinite open/close loop from unstable inline object reference)
- `ToolRunSummary.tsx` passes `{ cache: false }` — prevents subagent churn on LRU-20
- `chatSnapshotCache.save()` no-ops when `cacheEnabled === false`

**Invalidation:**
- `session:fork` → `evict(sessionId)` — placed before the existing `dropped.size === 0` early-return in the fork handler
- `session:error` → `evict(sessionId)` + clear `isDeltaLoading` + clear `loading` (NOT `events` — `session:error` also fires for transient TTY errors)
- `auth:expired` → `cache.clear()` — listener registered in `useChat` via the passed `api` (not in `chatSnapshotCache.ts` itself, which can't receive the injected api cleanly)

**Restore set copy:**
- Restore `userTurnIds` as `new Set(snapshot.userTurnIds)` — not by reference, or the live ref mutates the cached snapshot
- On gap-drop path: also reset `userTurnIdsRef` alongside the dropped events

**Pre-existing pending leak fix:**
- `useChat` active-branch reset currently clears `events/meta/hasMore` but not `pending`
- Add `setPending([])` to the active branch

### Part B — Reduce `TAIL_TURNS` 20 → 15 (independent, revert separately if needed)

- `daemon/src/ws/handlers/chatOpen.ts:33`
- Check `transcriptStore.test.ts` for assertions keyed to 20-turn window

---

## Files & Changes

| File | Change |
|------|--------|
| `web-ui/src/hooks/chatSnapshotCache.ts` (new) | `save`/`restore`/`evict`/`clear`; LRU 20; truncation + `oldestSeq` recompute; `auth:expired` listener |
| `web-ui/src/hooks/useChat.ts` | 4th arg `{ cache? }`; refs; save on cleanup (guarded); restore on mount (`setLoading(false)`); `isDeltaLoading` + `restoredLatestSeqRef` + 5s failsafe; gap-check on plain replay path only; `session:error`/`session:fork` listeners (fork before early-return); pending leak fix |
| `web-ui/src/components/chat/ToolRunSummary.tsx` | Pass `{ cache: false }` to `useChat` for child sessions |
| `web-ui/src/api/client.ts` | `chatSubs` shape; `openChat(sid, sinceSeq?)`; `onopen` uses stored `sinceSeq` |
| `daemon/src/ws/handlers/chatOpen.ts` | `TAIL_TURNS` 20 → 15 |

---

## Edge Cases

| Case | Handling |
|------|---------|
| First visit / no cache | Full tail + spinner; unchanged |
| Agent idle since switch | Delta empty; snapshot current; no change |
| Agent mid-stream when left | Delta completes partial turn via merge |
| Daemon restart | `logSeq` durable across restarts; sinceSeq just works |
| Snapshot > 60s + gap | Plain `chat:open`; gap-check drops stale events; fresh delta rendered |
| Snapshot > 60s + no gap | Plain `chat:open`; mergeEvents; history intact |
| sinceSeq null/0 | Plain `chat:open`; avoids unbounded `readSessionSince` |
| WS reconnect | `onopen` uses stored `sinceSeq`; no double-open |
| Child session | `cache: false`; full tail as today; LRU unaffected |
| Session deleted | `session:error` → evict + clear loading |
| Session forked (live) | `session:fork` → evict (before early-return guard) |
| Fork-while-detached | Known gap; stale turns until next eviction |
| Auth expiry | `cache.clear()` |
| StrictMode remount | `isDeltaLoadingRef` guard prevents mid-hydration save |
| `isDeltaLoading` stuck | 5s failsafe (gap detection remains armed separately) |
| `loadEarlier` after restore | `oldestSeq` correct post-truncation; no hole |
| `loadAll` before switch | Capped at 200; `hasMore=true`; `oldestSeq` recomputed |
| Status bar blank briefly | `meta` not restored from snapshot; fills on `session:meta` — acceptable |
| Long-lived WS reconnect | Stored `sinceSeq` may be old → large delta; perf risk, correctness intact |

---

## Checklist

### Part A — Snapshot cache

- [x] **A.1** Create `chatSnapshotCache.ts`: `Map<sid, ChatSnapshot>`; `save`/`restore`/`evict`/`clear`; LRU evict oldest at >20; `save` keeps newest 200, recomputes `oldestSeq = events[0].logSeq ?? null`, sets `hasMore = hasMoreRef.current || truncated` (not unconditionally true); no `auth:expired` subscription here
- [x] **A.2** `api/client.ts`: `chatSubs` → `Map<string, { refs: number; sinceSeq?: number }>`; `openChat(sid, sinceSeq?)` stores `sinceSeq` on 0→1; `onopen` sends `{ type:"chat:open", sessionId, sinceSeq: entry.sinceSeq }` per sid
- [x] **A.3** `useChat`: add 4th arg `opts: { cache?: boolean } = {}`; thread `cache !== false` into `save`/`restore` calls
- [x] **A.4** `useChat`: add `eventsRef`, `oldestSeqRef`, `hasMoreRef`, `userTurnIdsRef`, `isDeltaLoadingRef`, `restoredLatestSeqRef` — synced on every render
- [x] **A.5** `useChat` cleanup: `chatSnapshotCache.save(sid, { ...refs, latestSeq: computeLatestSeq(eventsRef.current), savedAt })` — skip if `eventsRef.current.length === 0` OR `isDeltaLoadingRef.current` OR `opts.cache === false`
- [x] **A.6** `useChat` mount (cache hit): `setState({ events, oldestSeq, hasMore, userTurnIds: new Set(snapshot.userTurnIds) })`; `setLoading(false)`; `setIsDeltaLoading(true)` + `isDeltaLoadingRef.current = true`; set `restoredLatestSeqRef.current = snapshot.latestSeq`; call `api.openChat(sid, sinceSeq)`; set 5s failsafe timeout (clears `isDeltaLoading` only); register `auth:expired` listener → `chatSnapshotCache.clear()`
- [x] **A.7** `useChat` `chat:replay` handler: discriminate via `e.hasMore === undefined` (sinceSeq path → `mergeEvents()` + clear `restoredLatestSeqRef`; plain path → gap-check: if `e.oldestSeq != null && restoredLatestSeqRef.current != null && e.oldestSeq > restoredLatestSeqRef.current` → drop restored events + reset `userTurnIdsRef.current = new Set()` + `setState(delta.events)` + update cursors; else `mergeEvents()`; clear `restoredLatestSeqRef` either way); always: clear `isDeltaLoadingRef`/`setIsDeltaLoading(false)`/cancel failsafe
- [x] **A.8** `useChat` `session:error` listener: `evict(sid)` + `setIsDeltaLoading(false)` + `setLoading(false)`
- [x] **A.9** `useChat` `session:fork` listener: `evict(sid)` — placed before `dropped.size === 0` early-return
- [x] **A.10** `useChat` active-branch mount reset: add `setPending([])` (pending leak fix)
- [x] **A.11** `ToolRunSummary.tsx`: pass `{ cache: false }` as 4th arg to `useChat` for child session
- [x] **A.12** Helper `computeLatestSeq(events)`: `const seqs = events.flatMap(e => (e.logSeq != null ? [e.logSeq] : [])); const v = seqs.length ? Math.max(...seqs) : 0; return v > 0 ? v : null`

- [x] **A.0** `useChat.test.ts`: add `beforeEach(() => chatSnapshotCache.clear())` to prevent snapshot bleed between tests; fix line-49 `toHaveBeenCalledWith("s1")` assertion → `toHaveBeenCalledWith("s1", undefined)` (or use `toHaveBeenCalledWith(expect.stringMatching("s1"), expect.anything())`); add tests for: (a) restore from cache (no spinner, events visible immediately), (b) gap-drop path, (c) stale (>60s) path

- [ ] **A.T1** Switch away and back within 60s → no spinner, no empty flash; WS inspector: `chat:open` with `sinceSeq`
- [ ] **A.T2** Switch away >60s, agent was busy → snapshot dropped; fresh delta rendered; no content hole
- [ ] **A.T3** Switch away >60s, agent idle → snapshot merges with empty delta; history intact; no spinner
- [ ] **A.T4** Send message immediately after switch-back → optimistic bubble at bottom; deduped after delta
- [ ] **A.T5** First visit → spinner + full tail; `isDeltaLoading` never set
- [ ] **A.T6** WS drop+reconnect → single `chat:open` with stored `sinceSeq`; history intact
- [ ] **A.T7** `loadEarlier` on restored session → correct cursor; no duplicate or skipped events
- [ ] **A.T8** `loadAll` then switch → snapshot capped; `hasMore=true`; `loadEarlier` works on return
- [ ] **A.T9** Busy subagent turn (multiple child sessions expand/collapse) → LRU-20 not churned by child sessions

### Part B — Reduce TAIL_TURNS

- [x] **B.1** `chatOpen.ts:33`: `TAIL_TURNS` 20 → 15
- [x] **B.2** Check `transcriptStore.test.ts` for assertions tied to 20; update if needed (uses `store.tail(20)` directly as a call argument — not the constant — so no update needed)

- [ ] **B.T1** Fresh session open shows 15 turns; load-earlier fetches older

### Phase V — Verification (docker dev sandbox)

Boot the dev sandbox from the worktree root and exercise the feature manually:

```bash
scripts/dev-sandbox.sh up   # seeds 3 projects / 9 worktrees / 14 sessions, hot-reload on
```

- [ ] **V.1** Open browser at `http://localhost:<port>`; open browser DevTools → Network → WS tab
- [ ] **V.2** Navigate to a worktree with a rich-chat session that has history → confirm `chat:open` sent with `sinceSeq` absent (first visit) and history loads normally with spinner
- [ ] **V.3** Switch to a different worktree, then switch back within 60s → confirm: no spinner, history visible instantly, `chat:open` carries `sinceSeq`, `chat:replay` contains only delta events (not 15-turn tail)
- [ ] **V.4** Switch away, wait >60s, switch back → confirm: history visible immediately (snapshot), fresh tail merges in, no content hole, no spinner on return
- [ ] **V.5** While on a restored session, type and send a message before the delta arrives (throttle WS in DevTools if needed) → confirm optimistic bubble stays at bottom; deduped correctly after replay
- [ ] **V.6** Drop and reconnect the WS (disable network briefly in DevTools) → confirm no duplicate events, no ghost turns; `chat:open` re-sent with stored `sinceSeq`
- [ ] **V.7** Expand a subagent task entry (`ToolRunSummary`) → switch worktrees → switch back → confirm LRU-20 not churned by child session mounts; main sessions' snapshots still present
- [ ] **V.8** Run unit tests: `cd web-ui && bun test --filter useChat` → all pass; `cd daemon && bun test --filter transcript` → all pass (TAIL_TURNS=15 assertions)
- [ ] **V.9** Bring sandbox down: `scripts/dev-sandbox.sh down`

---

## Out of scope

- Terminal session caching
- Server-side delta cap on `readSessionSince` (unbounded for busy sessions; correctness intact, perf risk noted)
- Stored `sinceSeq` in `chatSubs` aging on long-lived reconnects (perf only, not correctness)
- `localStorage` persistence
- Fork-while-detached invalidation
- Configurable thresholds / cache size
