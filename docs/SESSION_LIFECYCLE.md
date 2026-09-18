# Session Lifecycle

How a terminal/agent session opens, streams, switches, and tears down — across
the three main scenarios: **new session**, **tab switch within a worktree**, and
**worktree switch**.

---

## Key concepts

```
tmux session (always running)
  └─ TmuxOutputStream (one per open WS stream — the "client")
       └─ PTY (tmux attach-session process)
            └─ xterm.js in the browser
```

- **tmux session** — the long-lived process backing a session; survives daemon
  restarts and UI navigation. Never killed by normal UI operations.
- **TmuxOutputStream** — a Rust object that spawns `tmux attach-session` via
  a PTY and forwards bytes to the browser over WS. One per `(WsConnection,
  sessionId)` pair. Detaching it (SIGHUP) disconnects *this client* from tmux
  without touching the session itself.
- **PaneHostLayer** — a React component that keeps every live `TerminalPane`
  permanently mounted at a stable tree position. Panes are never unmounted
  for layout reasons; they portal into whichever visible `<PaneOutlet>` claims
  their key, or into an offscreen hidden holder when no outlet is active.
- **Lazy mount** — a pane's *first* mount is deferred until something claims
  its outlet (a tab click, a tile appearing). Once mounted it stays mounted
  until the session is removed from candidates (worktree switch).
- **Per-(conn, sessionId) lock** — `WsConnection::with_session_lock` serializes
  every `session:open`/`session:close` for the same connection+session pair.
  The lock spans the entire `stream.attach()` await point, preventing a
  rapid close→open from spawning two tmux clients.

---

## 1. Starting a new terminal agent

```
User action                      Browser (React)                   Daemon (Rust)
────────────────                 ───────────────                   ─────────────
POST /sessions ──────────────────────────────────────────────────► creates DB record
                                                                    spawns tmux session
                                                                    starts agent CLI inside tmux
                 store update: new paneKey added to candidates
                 PaneOutlet claims key (visible tab/tile)
                   → useLazyMountedPaneKeys adds it to mount set
                 TerminalPane mounts (stable position in PaneHostLayer)
                   mountTerminal()
                     → creates xterm.js + FitAddon, writes into DOM
                     → subscribes to session:output BEFORE openSession
                 ResizeObserver fires (stable container width)
                   → openSession(sessionId, cols, rows)
                 ──── WS: session:open ──────────────────────────►
                                                                    acquires per-(conn,session) lock
                                                                    no stale stream → proceeds
                                                                    creates TmuxOutputStream
                                                                    registers stream in open_streams
                                                                    spawns forwarding tasks
                                                                    stream.attach(cols, rows):
                                                                      tmux has-session (probe)
                                                                      tmux set-option utf8 on
                                                                      tmux resize-window -x cols -y rows
                                                                      PTY: tmux attach-session -t <name>
                 ◄─── WS: session:opened ───────────────────────
                 ◄─── WS: session:output (replay + live) ────────
                 xterm.js renders output
```

**Why subscribe before openSession:** the daemon can send the first replay
chunk before the listener is registered if the browser yields between the
two calls. Subscribing first closes this window.

**Why defer openSession to ResizeObserver:** the container has a transient
width during mount (CSS transitions, panel layout restoring). Waiting for the
first ResizeObserver callback ensures `cols` reflects the real rendered width,
not a zero or default value that would permanently mangle tmux scrollback.

---

## 2. Switching sessions within the same worktree (tab switch)

Both sessions already exist. Session A is visible; session B has never been
shown. The user clicks B's tab.

```
User action                      Browser (React)                   Daemon (Rust)
────────────────                 ───────────────                   ─────────────
Click tab B
                 PaneOutlet for A unmounts → claimedKeys loses agent:A
                 PaneOutlet for B mounts  → claimedKeys gains agent:B

                 PaneHostSlot for A:
                   outlet → null → portal target moves to offscreen holder
                   ⚠ React reconciler treats portal target change as remount
                   TerminalPane A unmounts
                     → session:close(A)
                 ──── WS: session:close (A) ───────────────────►
                                                                    acquires lock for (conn, A)
                                                                    detach(): SIGHUP kills
                                                                      tmux attach-session client
                                                                    unregisters stream
                                                                    tmux SESSION for A keeps running
                 PaneHostSlot for B:
                   first-ever claim → lazy mount fires
                   TerminalPane B mounts → mountTerminal()
                   ResizeObserver → openSession(B, cols, rows)
                 ──── WS: session:open (B) ───────────────────►
                                                                    acquires lock for (conn, B)
                                                                    no stale stream
                                                                    TmuxOutputStream for B
                                                                    stream.attach() → PTY → tmux
                 ◄─── WS: session:output (B replay + live) ───
```

**Switching back to A:**
```
                 PaneOutlet for B unmounts → PaneOutlet for A mounts
                 ⚠ portal target change → TerminalPane A remounts
                   → closeSession(B) then openSession(A)
                 ──── WS: session:close (B) / session:open (A) ►
                                                                    close B: SIGHUP detach
                                                                    open A: stale-teardown (if any)
                                                                      then fresh attach
                                                                    tmux replay for A → xterm
```

**Known gap (Fix C):** the portal-target change (outlet ↔ offscreen holder)
currently triggers a React remount, firing a fresh `session:open`/`session:close`
on every tab switch. The per-session lock and stale-teardown in `session_open.rs`
make this safe and correct, but it adds a round-trip per switch. Eliminating the
remount by keeping panes in a completely stable tree position (via CSS show/hide
instead of portal target change) is tracked as Fix C.

---

## 3. Switching worktrees

Worktree A is active (sessions A1, A2). User navigates to worktree B (session B1).

```
User action                      Browser (React)                   Daemon (Rust)
────────────────                 ───────────────                   ─────────────
Click worktree B
                 paneKeys passed to PaneHostLayer changes:
                   [agent:A1, terminal:A2, tools:wt-A]
                   → [agent:B1, tools:wt-B]

                 useLazyMountedPaneKeys:
                   A1, A2, tools:wt-A pruned from sticky set
                     (no longer in candidates)
                   B1, tools:wt-B new candidates

                 React removes A1, A2 panes from render output
                 TerminalPane A1 unmounts → closeSession(A1)
                 TerminalPane A2 unmounts → closeSession(A2)
                 ──── WS: session:close (A1) ─────────────────►
                 ──── WS: session:close (A2) ─────────────────►
                                                                    detach A1 tmux client (SIGHUP)
                                                                    detach A2 tmux client (SIGHUP)
                                                                    tmux SESSIONS for A1, A2 keep running

                 PaneOutlet for B1 claimed (visible tab)
                   lazy mount triggers for B1
                 TerminalPane B1 mounts → mountTerminal()
                 ResizeObserver → openSession(B1, cols, rows)
                 ──── WS: session:open (B1) ─────────────────►
                                                                    TmuxOutputStream for B1
                                                                    stream.attach() → PTY → tmux
                 ◄─── WS: session:output (B1 replay + live) ─
```

**Switching back to worktree A:**
```
                 paneKeys reverts to [agent:A1, terminal:A2, tools:wt-A]
                 A1/A2 were pruned from sticky → mount fresh
                 Visible tab's PaneOutlet claims agent:A1
                   → lazy mount → TerminalPane A1 mounts
                   → openSession(A1)
                 ──── WS: session:open (A1) ─────────────────►
                                                                    TmuxOutputStream for A1
                                                                    tmux session was never killed:
                                                                      full scrollback replayed
                 ◄─── WS: session:output (A1 replay) ────────
```

**Why sticky is pruned on worktree switch:** we don't want all worktrees'
tmux clients attached simultaneously. Pruning on worktree switch ensures
returning to a worktree always pays a fresh attach (and gets a scrollback
replay), but idle worktrees consume no tmux clients.

---

## 4. Stale-stream teardown (the safety net)

Every `session:open` unconditionally tears down any existing stream for
`(conn, sessionId)` before attaching a new one (`session_open.rs:open_session_locked`).
This is safe because `TmuxOutputStream::detach()` is idempotent (SIGHUP +
clear state), and the lock ensures close+open can't interleave.

Without this: a rapid close→open (e.g. from the Fix C remount) that races
the async `stream.attach()` park point could leave an orphaned
`TmuxOutputStream` with a live tmux client still forwarding output — the
"echoing keystrokes" bug (s → ss → sss on repeated switches).

The close-listener task in `session_open.rs` uses `Arc::ptr_eq` on the
stream (not just the subscriber_id string) to guard unregistration — a
stale close event from a previous stream generation cannot unregister the
current live entry.

---

## 5. Resize path

```
ResizeObserver fires
  → fit.fit() → new cols × rows
  → api.resize(sessionId, cols, rows)
  ──── WS: session:resize ─────────────────────────────────────────►
                                                                      guard: cols < 20 → drop
                                                                      stream.resize(cols, rows)
                                                                        → pty.resize()
                                                                        → tmux resize-window
```

**Why 20-col floor:** tmux reflow is lossy — scrollback baked at a narrow
width is permanently mangled. During layout transitions the container briefly
reports ~2 cols. The floor is enforced at the daemon entry point
(`session_resize.rs`), inside `TmuxOutputStream::attach()`, and
client-side in `TerminalPane.tsx` (belt-and-suspenders so the narrow resize
is never sent at all).

---

## 6. WS disconnect cleanup

On WebSocket disconnect (tab close, network drop), `WsConnection::drop` /
the disconnect handler iterates all `open_streams` and calls `detach()` on
each. This ensures no tmux clients are left attached when the browser is gone.
The tmux sessions themselves keep running; the next `session:open` from a
reconnect will attach fresh.

---

## 7. tmux client count invariant

At any moment:

```
live tmux clients = number of currently open WS streams
```

Healthy: one client per visible terminal pane, per browser tab.
Leaked: >1 client per pane → duplicate output forwarding → echo multiplication.

Check from shell:
```bash
tmux list-clients           # list all clients across all sessions
tmux list-clients -t <name> # clients for one session (healthy = 1)
```

---

*Related: `docs/TERMINAL-LIFECYCLE.md` (Node-era reference + bug history),
`rust/vst-ws/src/handlers/session_open.rs`, `session_close.rs`,
`rust/vst-ws/src/streams/tmux_output.rs`,
`web-ui/src/components/layout/PaneHostLayer.tsx`, `paneOutlets.tsx`.*
