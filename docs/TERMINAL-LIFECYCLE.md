# Terminal Mount / Unmount Lifecycle

How a vst terminal pane opens, streams output, handles layout changes, and tears down — and the bugs that were fixed along the way.

---

## 1. The two layers

```
Browser (TerminalPane.tsx)          Daemon (ws/handlers/ + ws/streams/)
─────────────────────────           ──────────────────────────────────
xterm.js instance                   TmuxOutputStream (one per open stream)
  ↕ WebSocket                         ↕ node-pty
FitAddon (cols×rows)                  tmux attach-session -t <name>
```

The browser renders a terminal emulator; the daemon owns a real PTY that forwards
to a live `tmux attach-session`. The two talk over the shared `/ws` WebSocket with
`session:open` / `session:input` / `session:resize` / `session:close` frames.

---

## 2. Mount sequence

When `TerminalPane` mounts (or remounts after a layout change):

1. **`mountTerminal()`** — creates an xterm.js `Terminal`, attaches `FitAddon`,
   writes it into the DOM div, then calls `fit.fit()` to size it to the container.
   This gives the initial `cols × rows`.

2. **Subscribe to output first** — `api.on("session:output", …)` is registered
   *before* the `openSession` call (`TerminalPane.tsx:184–200`). This prevents a
   race where the daemon sends the first replay chunk before the listener is wired.

3. **Defer `openSession` to stable width** — the first `openSession` is held until
   the `ResizeObserver`'s first callback fires (`:222`). The RO fires after the
   panel layout has settled (CSS transitions, saved-layout restore), so the cols
   value sent to the daemon reflects the real rendered width — not the transient
   default (33.4%) that existed during mount. Reconnect / resume opens use
   `termRef.current.cols`, which is already post-settle, so they need no deferral.

4. **Daemon `session:open` handler** (`sessionOpen.ts`) — tears down any stale
   stream registered for this `(conn, sessionId)` before creating a new one.
   Creates a `TmuxOutputStream`, issues `tmux resize-window` to pre-size the pane,
   then spawns `tmux attach-session -t <name>` via node-pty. PTY bytes flow back
   as `pane:output` frames.

---

## 3. Resize path

```
ResizeObserver fires → fit.fit() → api.resize(sessionId, cols, rows)
                                         ↓
                                  daemon sessionResize.ts
                                         ↓ (only if cols ≥ MIN_TMUX_COLS = 20)
                                  stream.resize() → pty.resize() + tmux resize-window
```

### Why MIN_TMUX_COLS = 20

tmux reflow is **lossy** — baking history at a narrow width permanently mangles
scrollback (Claude history compressed to ~2 cols is not recoverable). During a
worktree-switch or layout-toggle the terminal host briefly reports a transient
width (~2 cols). The 20-col floor is applied in two places:

- **`TmuxOutputStream.resize()` / `.attach()`** (`tmuxOutput.ts`) — guards every
  `tmux resize-window` call inside the stream.
- **`sessionResize` handler** (`sessionResize.ts`) — drops the entire resize frame
  at the daemon entry point if `cols < MIN_TMUX_COLS`, covering both the
  active-stream path and the no-stream resize-window path.

Client-side guards in `TerminalPane.tsx` add a belt-and-suspenders layer so the
narrow resize is never even sent over the wire.

---

## 4. Unmount / close sequence

When the pane unmounts (worktree switch, layout toggle, tab close):

1. **Browser** calls `api.closeSession(sessionId)` → sends `session:close` frame,
   then destroys the xterm.js instance.

2. **Daemon `session:close` handler** (`sessionClose.ts`) — looks up the
   `openStreams` entry for `(conn, sessionId)`, calls `stream.detach(subscriberId)`.

3. **`TmuxOutputStream.detach()`** (`tmuxOutput.ts:179`) — SIGHUP-kills the
   node-pty (`pty.kill()`), removes all listeners. SIGHUP is how tmux interprets a
   client going away: the tmux session itself keeps running; only this client
   detaches.

4. **`openStreams.delete(sessionId)`** on the `WSConnection` — the slot is cleared
   so a subsequent `session:open` starts clean.

On WebSocket disconnect (tab close, network drop) the `WSConnection` cleanup
(`connection.ts:151`) iterates all open streams and detaches them in the same way.

---

## 5. The attach-leak bug and its fix

**Symptom:** toggling layout caused each keypress to echo N times (f→ff→fff).
`tmux list-clients` showed 6 live clients instead of 1.

**Root cause:** `socket.on("message", async …)` in `server.ts` does not serialize
async handlers. A rapid open/close/open sequence (from React remounting on layout
change) let `open#2` start while `open#1` was parked at `await stream.attach()` —
after it had already wired the `pane:output` chunk listener. `open#2` then
overwrote the `openStreams` slot, orphaning `open#1`'s `TmuxOutputStream`. That
orphan's PTY kept its tmux-attach alive and kept emitting — hence N clients.

**Fix (`sessionOpen.ts`):** unconditional stale-teardown before every new attach.
Any stream already registered for `(conn, sessionId)` is detached synchronously
before the new `stream.attach()` call. This is safe because `detach()` is
idempotent (SIGHUP + removeAllListeners) and the `openStreams` slot comparison
prevents double-teardown.

---

## 6. Why the terminal remounts

`Layout.tsx` places `TerminalPane` in different positions in the React tree
depending on `terminalPosition` (`"left"` = side column, `"bottom"` = stacked row).
These are separate JSX subtrees, so React unmounts and remounts the component on
every toggle — even though the underlying tmux session is unchanged. This is the
shared trigger for issues #2–#4 in the one-page bug plan.

Fix C (keeping `TerminalPane` in a stable tree position via CSS/portal) would
eliminate the remount entirely and is tracked as a follow-up. The current fixes
(stable-width open, ≥20-col guard, stale-teardown) make remounts safe rather
than preventing them.

---

## 7. Reconnect and resume

| Trigger | Path |
|---------|------|
| WS reconnect (network drop, page reload) | `ws:open` event → `openSession` with current `termRef.current.cols × rows` (`:335`) |
| Session resume (user taps Resume after exit) | `POST /sessions/:id/resume` → daemon re-spawns agent → client `openSession` with current size (`:356`) |

Both paths skip the initial-mount deferral because the layout has already settled
by the time they fire.

---

## 8. Debug logging

Gate: `?debugInput=1` in the URL (or `localStorage` key `vst:debugInput`).

When enabled, `TerminalPane.tsx` logs every `openSession` and `resize` call with
the `cols × rows` values sent to the daemon. The daemon logs stream create and
detach events (with a live `TmuxOutputStream` count, not `openStreams.size` — the
latter can't see orphaned streams, which was the leak).

To count live tmux clients from the shell:
```bash
tmux list-clients -t <tmuxName>   # healthy = 1 client per open pane
```

---

*Reference commits: `7c8007b` (mobile input + resize doubling), `c3b85c2` (touch scroll).
Reference plans: `.feature-plans/pending/terminal-fixes-one-pager.md`,
`.feature-plans/pending/terminal-remount-and-tmux-leak-fixes.md`.*
