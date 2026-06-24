# Browser / Mobile Notes

Quirks worth knowing before touching the web UI.

## Viewport height on mobile

Use `100dvh`, not `100vh`, for full-screen containers.

`100vh` on mobile is calculated from the *largest* possible viewport (URL bar collapsed).
When the URL bar is visible the actual window is shorter — the div overflows and the page scrolls.

`100dvh` (dynamic viewport height) tracks the real visible area and updates as the URL bar appears/disappears. The AppShell wrapper uses this.

## Terminal touch scrolling (mobile swipe)

xterm.js renders into a `<canvas>`. Browsers do not fire native scroll events on
canvas elements, so a finger swipe on the terminal does nothing by default. We
translate vertical swipes into the right input ourselves in
`web-ui/src/lib/terminal-touch-scroll.ts` (`attachTouchScroll`), wired up in
`TerminalPane.tsx`.

### The key insight: there is no single "scroll the terminal" action

What a swipe should *do* depends entirely on what the running program is doing
with the terminal, because the content you want to scroll lives in different
places:

| Program | Terminal state | Where its content lives | What scrolls it |
|---------|----------------|-------------------------|-----------------|
| Shell, Cursor agent, plain output | **normal** buffer | the terminal **scrollback** | scroll the scrollback |
| Claude fullscreen, vim, htop, less | **alternate** buffer | **inside the app's own viewport** | send the app the input it listens for |

The alternate screen buffer has **no scrollback** — the app paints the whole
viewport itself and repaints on change. So tmux copy-mode and `term.scrollLines()`
have nothing to move there; they sit at `[0,0]`. The app is the only thing that
can scroll its content.

### The three tiers (decided per-swipe, live)

`attachTouchScroll` inspects the terminal at swipe time and picks one:

1. **Normal buffer** → `term.scrollLines(-n)`. Scrolls xterm's scrollback. This is
   the shell / Cursor case — their history is in the scrollback.
2. **Alternate buffer + app has mouse tracking on**
   (`term.modes.mouseTrackingMode !== 'none'`) → emit **SGR mouse-wheel events**
   (`ESC[<64;col;rowM` = wheel up, `ESC[<65…M` = wheel down) at the swipe's cell.
   tmux forwards these to the app because it requested mouse reporting, and the
   app scrolls its own viewport. **This is how Claude's fullscreen scrolls** — it
   is identical to what a desktop mouse wheel sends, which is why it feels native.
3. **Alternate buffer + no mouse tracking** → fall back to tmux copy-mode
   (`Ctrl-b [` then arrow keys). Only meaningful when a tmux layer is present
   (`enableCopyModeScroll`, set false for direct-pty sessions). Note this is the
   path that sits at `[0,0]` for a fullscreen app that *doesn't* enable mouse
   mode — there is genuinely nothing to scroll in that case except the app's own
   keybindings.

So Claude and Cursor behaving differently on the same swipe is **correct**, not a
bug: each gets the mechanism that matches where its content lives.

### Why direction / amount are what they are

- Natural direction: swipe finger **down** (`lineDelta > 0`) reveals **older**
  content. Normal buffer negates `scrollLines`; wheel tier maps it to wheel-up
  (btn 64); copy-mode maps it to arrow-up.
- Wheel tier uses the **raw** (un-boosted) line delta as the tick count — each
  wheel tick already scrolls several lines in most apps, so boosting would
  over-scroll.
- SGR (1006) encoding is assumed for the wheel tier. It is universal in modern
  TUIs. If an app ever uses a legacy mouse encoding and scrolls erratically, the
  fix is to dispatch a synthetic `WheelEvent` through xterm's own encoder
  (protocol-agnostic) instead of hand-emitting SGR.

### Other touch details

- `touch-action: none` on the terminal host (and `.xterm-viewport`) stops the
  browser hijacking the gesture as a native pan mid-swipe. Without it, xterm@5's
  canvas overlay makes `pointermove` stop firing after the first event ("scrolls
  once per swipe" bug).
- A dead zone + vertical-dominance ratio distinguishes a scroll gesture from a
  horizontal swipe before committing.
- A scroll-to-bottom FAB (`⬇`) appears when the user scrolls away from the live
  tail and snaps back on tap. In the alternate buffer the xterm viewport never
  moves, so `onScrollAway` is the only signal that fires — that's why the handler
  reports direction explicitly rather than relying on `term.onScroll`.

## Auth cookie flow

```
browser (localhost:5173)
  │  POST /api/auth/login  { token }      [credentials: "include"]
  │  ← Set-Cookie: vst-session=<hmac>; HttpOnly; SameSite=Strict
  │
Vite proxy (/api → 127.0.0.1:7421)
  │
daemon  validates HMAC token → issues session cookie
```

All `apiFetch` calls pass `credentials: "include"` so the session cookie is sent even in dev (Vite dev server and daemon are different origins). Raw `fetch()` calls skip this — always use `apiFetch` for authenticated endpoints.

WebSocket auth works the same way: the browser sends the cookie on the WS upgrade request; Vite proxies it to the daemon which validates it before accepting the connection. A WS close with code `4401` means the session cookie was missing or expired — the client treats this as `auth:expired` and shows the login screen.

## CORS

The daemon registers `fastify-cors` with `origin: true` (reflect request origin). This is intentional — CSRF protection lives at the cookie layer (`SameSite=Strict` + HMAC), so the origin allowlist would block legitimate LAN / Tailscale access without adding real security.
