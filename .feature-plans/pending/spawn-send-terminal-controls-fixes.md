# `vst send` Enter / terminal font-controls — small fix plan

## The two issues

| # | Symptom | Root cause | File(s) |
|---|---------|-----------|---------|
| 1 | `vst send <id> "msg" --wait` (or the underlying `POST /sessions/:id/input` with `sendEnter: true`) doesn't submit the message in a tmux-backed session — it just pastes the text and leaves it sitting in the input box | For tmux sessions, `sendEnter` is implemented by appending `"\n"` **inside** the pasted buffer (`data + "\n"`) and sending it all through `pasteBuffer`, which wraps the payload in bracketed-paste markers. Bracketed paste tells the TUI "this is one paste, not keystrokes" — so the embedded `\n` is inserted as a literal newline in the input, not interpreted as pressing Enter. `pasteBuffer`'s own doc comment in `tmux.ts` says exactly this ("embedded newlines stay in the editor instead of being interpreted as Enter") but `sendEnter`'s tmux-path implementation ignores that and relies on the embedded newline anyway. | `daemon/src/routes/sessions.ts:1106-1111` (`POST /sessions/:id/input` tmux branch) |
| 2 | No terminal-zoom (`Aa −/+`) or fullscreen controls shown for a **direct session**'s own terminal (the `/session/:id` route's main agent pane) | The zoom/fullscreen buttons live *inside* `TabsStrip`, not as a standalone component. Direct-session agent panes intentionally skip `TabsStrip` ("single agent, no tabs" — `Workspace.tsx:196-205`), which throws away the always-bundled zoom/fullscreen row along with the (legitimately unneeded) tab list. The *secondary* terminal dock for a direct session (`directTerminalDock`, `Workspace.tsx:211-216`) does use `TabsStrip` and does show the controls — only the direct session's own primary terminal is missing them. | `web-ui/src/routes/Workspace.tsx:199-205` (`directAgentPane`), `web-ui/src/components/layout/TabsStrip.tsx:326-335` (`tabs-strip__tools` block bundles zoom+fullscreen together with tabs) |

## Fixes

### 1 — `POST /sessions/:id/input`: send Enter as a real keystroke, not embedded text

- In `sessions.ts`, stop appending `"\n"` to `data` before `pasteBuffer`. Instead: `await pasteBuffer(session.tmuxName, bufferId, data)`, then, if `sendEnter`, a separate `await sendKeys(session.tmuxName, "Enter")` (or `run(["send-keys", "-t", tmuxName, "Enter"])`) **after** the paste completes — mirrors how the direct-pty branch already does it correctly (`stream.write(data + "\r")` is a real keystroke, not a paste — that path is fine as-is).
- `tmux.ts` already exports `sendKeys(target, keys, enter)` — reuse it directly: `await sendKeys(session.tmuxName, "Enter")`.

### 2 — Give the direct-session terminal the same zoom/fullscreen controls

- Simplest fix matching existing conventions: render `TabsStrip` for the direct-session agent pane too, even though there's only ever one tab — `TabsStrip` already handles zero/near-empty tab lists elsewhere (`tabs-strip__empty` for terminals). For agent kind with a single session this just shows the zoom+fullscreen tools row with no visible tab switcher friction (or hide the tab-list portion specifically for a single-agent case if that's visually off, but keep `tabs-strip__tools`).
- Cleaner alternative (slightly larger, but decouples concerns correctly): pull `tabs-strip__zoom` + `tabs-strip__fs` out of `TabsStrip` into a small standalone `PaneTools` component that both `TabsStrip` and `directAgentPane` can mount independently of whether tabs are shown. Prefer this if the "no tabs, but still show tools" hack in option A reads awkwardly once tried.
- Either way: `directAgentPane` in `Workspace.tsx:199-205` needs to end up rendering the zoom/fullscreen controls above/around its `AgentPaneSlot`, same as the worktree `agentPane` does today via its `TabsStrip kind="agent"`.

## Phased checklist

- [x] **Phase 1 — `vst send` Enter fix** (fix 1)
  - [x] 1.1 Split paste + Enter into two tmux calls in `sessions.ts`
  - [ ] 1.T1 Verify: `vst send <tmux-session-id> "hello" --wait` actually submits (not just fills the input box) against a live Claude Code tmux session
- [x] **Phase 2 — direct-session terminal controls** (fix 2)
  - [x] 2.1 Went with option B: extracted `tabs-strip__tools` into a standalone `PaneTools` component (`web-ui/src/components/layout/PaneTools.tsx`), used by both `TabsStrip` and `directAgentPane` — avoids the "fake single-tab TabsStrip" UX risk noted below
  - [ ] 2.T1 Verify: open a `/session/:id` direct session, confirm `Aa −/+` and fullscreen buttons are visible and functional above its terminal, and that they still work correctly for the existing worktree agent/terminal panes (no regression)

## Risks

| Risk | Mitigation |
|------|-----------|
| Splitting paste+Enter into two tmux calls introduces a race if the target app reads input between the two | Same pattern already used successfully for direct-pty (`write` then separate `\r`); tmux `send-keys` after `paste-buffer` should be safe since both are serialized through the same tmux server, but verify under fast rapid `vst send` calls |
| Option A for fix 2 (reusing `TabsStrip` with a single fake tab) may look wrong tab-strip-with-no-tabs-list — fall back to option B if so | Try A first (smaller diff), visually inspect, swap to B if it reads oddly |

## Deferred (out of scope for this pass)

- The daemon spawn-silently-dies issue (`unl-40` ghost sessions when a launch command crashes right after start, due to no `remain-on-exit` on the tmux session) — explicitly skipped per user request. Revisit separately if it recurs.

## Opus review (post-implementation)

No blockers. Nits found and applied:
- `sessions.ts`: switched `sendKeys(name, "Enter")` → `sendKeys(name, "", true)` to match the existing paste-then-submit convention already used twice in `spawn.ts`.
- `Workspace.tsx` / `workspace.css`: replaced the inline `style={{ justifyContent: "flex-end" }}` with a `.tabs-strip--tools-only` modifier class, which also drops the now-stray `tabs-strip__tools` left border (there's no tab list to its left in this standalone usage). Comment wording fix (dangling "them").

Flagged but not acted on (real but out of scope / pre-existing):
- No per-session mutex on `POST /sessions/:id/input` — concurrent `vst send` calls to the same session can interleave (paste(A), paste(B), Enter(A), Enter(B)), and the fixed `bufferId` means a concurrent load-buffer could clobber a prior paste before it's read. Pre-existing before this fix, arguably worsened only marginally (was already racy via `bufferId`). Worth a follow-up if concurrent sends turn out to be a real use case.
- `role="toolbar"` (new direct-session tools wrapper) vs `role="tablist"` (`TabsStrip`) on the same `.tabs-strip` class is a minor pre-existing a11y inconsistency (a tablist containing non-tab buttons), not made worse here.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm --filter @vibestation/cli test` (481 passed), `pnpm --filter @vibestation/web test` (274 passed) all green after adjustments.
