# Browser / Mobile Notes

Quirks worth knowing before touching the web UI.

## Viewport height on mobile

Use `100dvh`, not `100vh`, for full-screen containers.

`100vh` on mobile is calculated from the *largest* possible viewport (URL bar collapsed).
When the URL bar is visible the actual window is shorter — the div overflows and the page scrolls.

`100dvh` (dynamic viewport height) tracks the real visible area and updates as the URL bar appears/disappears. The AppShell wrapper uses this.

## Terminal canvas and touch scrolling

xterm.js renders into a `<canvas>`. Browsers do not fire native scroll events on canvas elements, so touching the terminal on mobile does nothing by default.

Fix in `TerminalPane.tsx`:
- `touchstart` / `touchmove` listeners on the host div compute `deltaY` and call `term.scrollLines(n)`.
- `overscroll-behavior: none` on the terminal container prevents Chrome's pull-to-refresh from firing when the user drags past the top of the buffer.
- A scroll-to-bottom FAB (`⬇`) appears when `term.buffer.active.viewportY < buffer.length - term.rows` and snaps to live output on tap.

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
