<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Rich chat — persistent last-message working indicator, reliable auto-scroll, growing composer

**Issue:** chat-working-indicator-scroll-grow
**Branch:** `option-windows-window` (continuing current worktree, separate commit)
**PRD:** none — small, skipped

**Reference files:**
- `web-ui/src/components/chat/StatusBar.tsx` — existing spinner+Stop indicator (keep as-is)
- `web-ui/src/components/chat/MessageList.tsx:245-249,388-390` — auto-scroll effect, message-list tail
- `web-ui/src/components/layout/ChatPane.tsx:183-257` — footer/body flex layout
- `web-ui/src/components/chat/Composer.tsx:107-120` — textarea, currently fixed `rows={2}`
- `web-ui/src/styles/chat.css:701-726,905-951,1045-1058` — thinking-hint dot pulse, composer, spinner CSS

---

## Problem

- The only "agent is working" affordance is a small spinner in the footer `StatusBar`, easy to miss when scrolled up or glancing at the message area
- `MessageList`'s auto-scroll (`scrollIntoView` on a bottom sentinel) only re-runs on `items.length`/`pending.length`/`thinking` changes — it does NOT re-run when the footer grows taller (e.g. composer auto-grow below), so the last message can end up hidden behind the footer
- The composer textarea has no auto-grow — fixed `rows={2}`, manual resize handle only

## Concept

- Add a second working indicator as the actual last item in the message feed: animated dots cycling 1→2→3→1, gated on the same busy/thinking signal `MessageList` already receives — additive, existing `StatusBar` spinner untouched
- Make auto-scroll footer-height-aware: observe the footer's height (`ResizeObserver`) and re-trigger `scrollIntoView` when it changes, so a growing composer/indicator never leaves the last message obscured
- Auto-grow the composer textarea on input up to a ~10-line cap, then let it scroll internally — replace the fixed `rows={2}`/manual-resize-only behavior with a JS height recalculation on each keystroke, capped

## Requirements

| # | Requirement |
|---|-------------|
| 1a | While the agent is busy (same signal driving `StatusBar`'s spinner), the message feed's last rendered item is a working indicator — 1, 2, 3 dots, cycling back to 1, looping while busy |
| 1b | The existing `StatusBar` spinner + Stop button near the input is unchanged |
| 1c | The new indicator disappears (not just stops animating) as soon as the agent is no longer busy |
| 2a | After the composer/footer grows (auto-grow textarea, or anything else changing footer height) while already scrolled to bottom, the last message stays fully visible above the footer — never partially hidden |
| 2b | Auto-scroll still fires correctly on new messages/pending/thinking changes as it does today (no regression) |
| 3a | Typing multi-line input grows the textarea to fit content, up to ~10 lines tall |
| 3b | Beyond ~10 lines, the textarea stops growing and scrolls internally instead |
| 3c | Textarea shrinks back down as content is deleted (not stuck at max height) |

## Out of Scope

- Redesigning `StatusBar` or removing the existing spinner
- Virtualizing/windowing the message list (unrelated to this change)

**Deviation during implementation:** the manual vertical-resize handle (`resize: vertical`) was
REMOVED rather than kept — a JS-driven auto-grow effect re-running on every keystroke would
otherwise fight/overwrite a user's manually-dragged height on the very next character typed.
Auto-grow-up-to-a-cap supersedes manual resize entirely (standard pattern for this kind of
composer, e.g. Slack/Discord/ChatGPT), which is a closer match to the actual ask ("grow it
automatically") than the original scope note assumed.

---

## Implementation Phases

### Phase 1 — persistent dot indicator in message feed

- [x] **1.1** `MessageList.tsx`: render a working-indicator element as the last child (after `pending.map`, before the `bottomRef` sentinel), gated on the same busy/thinking prop(s) already passed into `MessageList`
- [x] **1.2** CSS: new dot-cycle animation (1→2→3→1 dots), reusing `.chat-thinking-hint__dot`'s pulse approach as a starting reference but as a 3-dot sequence, not a single pulse
- [x] **1.3** Component/CSS test coverage for: indicator renders while busy, absent while idle, is the last DOM child of the list while present

**Verify phase 1:**
- [x] **1.T1** `pnpm --filter @vibestation/web exec vitest run src/components/chat/MessageList.test.tsx` (or nearest existing test file) passes
- [x] **1.T2** `pnpm typecheck` clean

### Phase 2 — footer-height-aware auto-scroll

- [x] **2.1** `MessageList.tsx` (or `ChatPane.tsx`, whichever owns the scroll container): observe footer height via `ResizeObserver` and re-run the bottom-scroll on change, in addition to the existing `items.length`/`pending.length`/`thinking` deps
- [x] **2.2** Only auto-re-scroll when the user was already at (or near) the bottom before the resize — don't yank the view down while the user has deliberately scrolled up to read history
- [x] **2.3** Test coverage: footer height change while at bottom triggers scroll; footer height change while scrolled up does NOT force-scroll

**Verify phase 2:**
- [x] **2.T1** Same test file(s) as phase 1 pass
- [x] **2.T2** `pnpm typecheck` clean

### Phase 3 — composer auto-grow

- [x] **3.1** `Composer.tsx`: on input, recalculate textarea height from `scrollHeight`, capped at a computed ~10-line max (derive from the textarea's actual `line-height`/padding, not a guessed pixel constant), shrink back down when content shrinks
- [x] **3.2** `chat.css`: adjust `.chat-composer__textarea`'s `max-height`/`resize` as needed to match the new JS-driven cap (keep manual vertical resize working underneath the auto-grow, per Out of Scope)
- [x] **3.3** Test coverage: height grows with multi-line input up to the cap, caps and scrolls beyond ~10 lines, shrinks back on delete

**Verify phase 3:**
- [x] **3.T1** `pnpm --filter @vibestation/web exec vitest run src/components/chat/Composer.test.tsx` (or nearest) passes
- [x] **3.T2** `pnpm typecheck` clean

### Phase 4 — review + verify

- [x] **4.1** Opus reviewer pass on the full diff (all 3 phases together — small enough for one pass)
- [x] **4.2** Address any CONFIRMED findings — 7 real findings, all fixed:
  1. Composer autosize ran in `useEffect` (passive, post-paint) with the CSS safety net removed
     (`overflow-y: hidden`) — could clip the just-typed line/caret for one frame per keystroke.
     Fixed: `useLayoutEffect`.
  2. `WorkingIndicator` and `ThinkingHint` could render simultaneously during the `thinking`
     sub-state (both `turnActive`) — two competing busy indicators. Fixed: gated
     `turnActive && !thinking`.
  3. The dot-cycle interval had no `prefers-reduced-motion` guard (existing `ThinkingHint` dot
     does, via CSS). Fixed: `matchMedia` check before starting the interval.
  4. `nearBottomRef` was only refreshed by `scroll` events; streaming tokens into an existing
     bubble grow content without moving `scrollTop`/firing `scroll`, so the flag could go
     stale-true and yank the view down later. Fixed: removed the cached flag + scroll listener
     entirely, compute distance-to-bottom fresh inside the `ResizeObserver` callback.
  5. The resize-triggered rescroll used `bottomRef.current.scrollIntoView(...)`, which walks
     every scrollable ancestor (including `overflow: hidden` boxes) — an unrelated resize
     elsewhere (canvas divider drag) could nudge ancestor scroll positions. Fixed:
     `container.scrollTop = container.scrollHeight` on just the one container.
  6. `autosizeComposerTextarea` read `el.scrollHeight` twice (two forced reflows, not
     guaranteed equal once `overflowY` flips). Fixed: cached in one variable.
  7. The textarea's `ref` was an inline arrow function, recreated every render — React
     detaches/reattaches (`null`) on every keystroke. Fixed: `useCallback`.
- [x] **4.3** Full `web-ui` vitest suite + repo-wide typecheck — re-ran after fixes, all green

**Verify phase 4:**
- [x] **4.T1** No unresolved CONFIRMED findings
- [x] **4.T2** Full `web-ui` test suite passes, typecheck clean

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/src/components/chat/MessageList.tsx` | Modified | 1, 2 | Dot indicator as last item; footer-resize-aware scroll |
| `web-ui/src/components/layout/ChatPane.tsx` | Possibly modified | 2 | Footer ref/height plumbing if needed |
| `web-ui/src/components/chat/Composer.tsx` | Modified | 3 | Auto-grow textarea logic |
| `web-ui/src/styles/chat.css` | Modified | 1, 3 | Dot-cycle animation, textarea max-height adjustment |
| Corresponding `*.test.tsx` files | Modified | 1, 2, 3 | New coverage |

---

## Verification Method

- Node/vitest: targeted component tests + repo-wide `pnpm typecheck`
- Reviewer: opus subagent, one pass on the complete diff
- No docker/browser verification planned (no browser tool available) — static + unit-test verification only, same as the prior sub-feature in this session
