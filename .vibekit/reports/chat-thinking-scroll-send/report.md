<!--
RULES — read before writing this report:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. ANSWER FIRST: the finding goes at the top, before any evidence
3. EVERY CLAIM CITED: file:line, a command + its output, or a screenshot
4. READING TIME: optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Report: chat-thinking-scroll-send — visual confirmation, final state

**Date:** 2026-08-24 · **Commit:** `13daa0042309ecadbb7a914b81dc7d2a2bb6e974` base + uncommitted working-tree diff (plan `plan-chat-thinking-scroll-send.md`, all 49 checklist items `[x]`, plus 4 follow-up fixes made after this report's first draft — see Changelog) · **Scope:** visual verification only — component behavior itself is covered by the full `web-ui` vitest suite (547/547 passing at time of writing), not re-derived here · **Method:** Docker dev sandbox (`scripts/dev-sandbox.sh up vs-55 5180`), Playwright headless Chromium at desktop width. Two capture passes: (1) the **real running app** — a demo worktree session switched to Rich Chat, a real message sent through the real Composer; (2) a throwaway fixture-preview page for the 2 states a live turn can't reach without CLI credentials (a *completed* thinking block, and the scrolled-away jump button)

## Changelog since the first draft of this report

- Footer `StatusBar` no longer duplicates the turn-state text next to `Stop` — it now shows JUST `[Stop]` while busy (was: `Thinking… [Stop]`)
- Busy-state labels dropped the trailing ellipsis: `"Thinking"` / `"Responding"` / `"Running tool"` (was: `"Thinking…"` etc.) — the animated `•••` dots next to the label already convey "in progress," the ellipsis was redundant with them
- The per-block `ThinkingBlock` no longer renders AT ALL while its thinking group is still open/live (was: showed a redundant `"Thinking…"` header identical to the trailing working indicator) — it now only appears once the group closes, showing `"Thought for Xs"`
- `QueuedTray` now renders above `StatusBar` in the footer (was: below it)
- Scroll-to-top now auto-loads older history with scroll position preserved (was: manual "Load earlier messages" button only) — server-side bounded pagination (tail-20 window) already existed and was verified unaffected

## Answer

- **Confirmed live, in the real running app:** sending a real message shows the in-feed indicator reading exactly `Thinking •••` (no ellipsis in the text, small dots, one line) — the footer directly below shows **only `[Stop]`**, no duplicate text. Typing a follow-up while that turn is still busy swaps the Composer's button to a dashed-border "will queue" Send, not `Stop`.
- **Confirmed via fixture** (states unreachable live without CLI credentials): a completed thinking block reads `▶ Thought for 6s` with no live "Thinking" duplicate ever having appeared for it; the jump-to-bottom button appears only when scrolled away from the live edge.
- All 8 asks tracked in this session (see the audit table below) are PASS as of the latest fix pass.

## Evidence

| Claim | Source | Real app or fixture? |
|-------|--------|:---:|
| Live busy turn: `Thinking •••` (no ellipsis), footer shows ONLY `Stop` — no duplicate text | `screenshots/01-live-busy-thinking-dots-stop.png` | **Real** |
| Composer shows dashed "will queue" Send — not `Stop` — while busy AND text is typed | `screenshots/02-live-composer-queue-send-busy.png` | **Real** |
| Completed turn: `▶ Thought for 6s`, no live thinking duplicate ever shown for it | `screenshots/03-fixture-completed-thought-for.png` | Fixture |
| Live turn, full pane view: single `Thinking •••` line, no per-block `ThinkingBlock` header duplicating it, footer has ONLY `Stop` | `screenshots/04-fixture-live-busy-full-pane.png` | Fixture |
| Jump-to-bottom (↓) button appears only once scrolled away from the live edge | `screenshots/05-fixture-jump-to-bottom.png` | Fixture |
| Composer: queue-styled (dashed border) Send while busy + text present | `screenshots/06-fixture-composer-queue.png` | Fixture |
| Composer: `Stop` shown only while busy AND box is empty | `screenshots/07-fixture-composer-stop-empty.png` | Fixture |
| No CLI credentials in the sandbox — every real turn errors before completing, hence sections 03/05 are fixture-driven | `$ docker exec vs-55-vst-dev-1 env \| grep -iE "anthropic\|claude\|openai"` → exit code 1, no output; live turn observed ending in `Not logged in · Please run /login` | — |
| Latest fix source, spot-checked in the running container | `$ docker exec vs-55-vst-dev-1 grep -n "Running tool" /app/web-ui/src/components/chat/StatusBar.tsx` → `38: return "Running tool";` (no ellipsis) | — |

## Live app screenshots

**Busy — real turn sent, `Thinking •••` (no ellipsis), footer shows ONLY `Stop`:**

![Real busy turn: no ellipsis, no duplicate footer text](./screenshots/01-live-busy-thinking-dots-stop.png)

**Busy + typing a follow-up — Composer shows dashed "will queue" Send, not Stop:**

![Real busy turn with text typed: queue-styled Send button](./screenshots/02-live-composer-queue-send-busy.png)

## Fixture screenshots (states unreachable without live CLI credentials)

**Completed turn — "Thought for 6s", never showed a live duplicate:**

![Completed thinking block](./screenshots/03-fixture-completed-thought-for.png)

**Live turn, full pane — single working line, no per-block duplicate, footer has only Stop:**

![Live busy turn full pane](./screenshots/04-fixture-live-busy-full-pane.png)

**Scrolled up — jump-to-bottom button:**

![Jump to bottom button](./screenshots/05-fixture-jump-to-bottom.png)

**Composer — queue-styled Send (busy + text):**

![Composer queue send](./screenshots/06-fixture-composer-queue.png)

**Composer — Stop (busy + empty):**

![Composer stop](./screenshots/07-fixture-composer-stop-empty.png)

## Full audit (all 8 asks tracked this session)

| # | Ask | Result | Evidence |
|---|---|---|---|
| 1 | One working affordance, no stacked "Thinking…" headers | PASS | `MessageList.tsx` `thinkingOpenByTurnId`/`closeOpenThinking`; `ThinkingHint` fully removed |
| 2 | "Thought for Xs" on completion, rendered below the block | PASS | `ThinkingBlock.tsx` `thinkingLabel()`, summary row after `__body` |
| 3 | No scroll-steal; jump-to-bottom button | PASS | `MessageList.tsx` `atBottomRef`-guarded layout effect; `screenshots/05` |
| 4 | Small dots | PASS | `chat.css` `.chat-working-indicator__dot` 4px / `__dots` gap 3px |
| 5 | No spinner AND no duplicate text near Stop; bottom-aligned dots | PASS | `StatusBar.tsx` label hidden while `busy`; `chat.css` `align-items: baseline` → `last baseline` cascade order correct; `screenshots/01` |
| 6 | Composer queue-Send vs. Stop | PASS | `Composer.tsx` `hasContent`/`canSend` split; `screenshots/02,06,07` |
| 7 | Queued tray above status bar | PASS | `ChatPane.tsx` `.chat-pane__footer` renders `QueuedTray` before `StatusBar` |
| 8 | Scroll-to-top auto-pagination, no jump | PASS | `MessageList.tsx` `NEAR_TOP_PX` trigger + height-delta `useLayoutEffect` restore |
| 9 | No ellipsis in busy labels (dots already convey continuation) | PASS | `StatusBar.tsx`/`ThinkingBlock.tsx` — `"Thinking"`/`"Responding"`/`"Running tool"`, no `…` |
| 10 | Live `ThinkingBlock` not shown until its group closes | PASS | `MessageList.tsx` `case "thinking"` renders `null` while `!item.endedTs && turnActive` |

**Decided, not implemented:** a single `"Thought for Xs"` label is used always — no separate `"Worked for Xs"` variant for thinking groups that had a tool call interleaved. Tracking that would need new state (whether any tool event fell inside a group's open lifetime) for unclear readability gain. Ask explicitly if you still want it.

## How the screenshots were produced
- Started an isolated docker dev sandbox for this worktree: `scripts/dev-sandbox.sh up vs-55 5180`
- **Live pass:** opened a real demo worktree session (`northstar-api` / `feat/auth-middleware`), already switched to Rich Chat from a prior capture pass (state persisted in the sandbox's data volume), typed a real message into the real `Composer`, pressed Enter — the client-side optimistic pending turn flips busy state immediately (before the daemon round-trip), so the busy UI is real even though the turn errors out ~1s later (no CLI credentials in this sandbox)
- **Fixture pass:** a temporary Vite entry (`web-ui/dev-preview.html` + `web-ui/src/dev-preview-main.tsx`, never committed, deleted before sandbox teardown) mounting `MessageList`/`Composer`/`StatusBar` directly with hand-built `NormalizedEvent[]` fixtures
- `web-ui/src` is bind-mounted with hot reload (`docker-compose.dev.yml`), so both passes ran the exact working-tree source, no rebuild needed
- Cleanup: temporary preview files + driver scripts deleted, sandbox torn down with `dev-sandbox.sh down vs-55` (data volumes intentionally left intact, never `down -v`)

## Not checked

- No screenshot of the **anti-flicker debounce** itself (temporal behavior, not a static visual) — covered by `ChatPane.test.tsx`'s fake-timer test instead
- No screenshot of a **full live-streamed LLM turn** reaching a *completed* state end-to-end — no CLI credentials in the sandbox; every real turn errors before finishing. Busy/mid-turn states ARE real; completed-thinking-block and jump-to-bottom states are fixture-driven
- No mobile/narrow-viewport screenshots — mobile responsiveness is tracked separately in `.vibekit/reports/2026-08-24-mobile-agent-tools-split-not-responsive/`, explicitly out of scope for this fix
- No cross-browser check — Chromium only; `align-items: last baseline` has a `baseline` fallback for browsers lacking support, not independently screenshotted in a non-supporting engine

## Follow-ups

| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | Want a `"Worked for Xs"` label variant for thinking groups that had a tool call interleaved? | Explicitly deferred (see audit table) — needs new tracking state |
| 2 | Should the temporary fixture-preview harness be turned into a permanent, checked-in dev route for future visual QA without live credentials? | Would make re-verifying chat UI changes visually reproducible without rebuilding this throwaway harness each time |
| 3 | Worth a Playwright visual-regression snapshot test for `WorkingIndicator`/`ThinkingBlock`/jump-to-bottom? | Baseline-alignment and label-text regressions (like the ellipsis/duplicate-text ones just fixed) wouldn't be caught by DOM-assertion unit tests alone, only by a human or a visual diff |
