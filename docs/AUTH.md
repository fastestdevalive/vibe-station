# Authentication

vibe-station uses a single shared secret (the *daemon token*) with two session tiers: the local desktop user is trusted implicitly; remote devices authenticate via a one-time QR code.

---

## Local desktop (same machine)

Requests arriving from `127.0.0.1` / `::1` bypass the auth guard entirely — **unless** they carry a `CF-Connecting-IP` header. `cloudflared` dials the daemon at `http://127.0.0.1:<port>`, so every tunnel request also arrives from loopback; without that exception the bypass would grant anyone holding the public tunnel URL unauthenticated access to every route.

```
Browser on localhost ──► daemon :7421
                         req.ip === 127.0.0.1 → trusted, no cookie check
```

- No login screen, no password prompt
- Applies to both the browser (`http://localhost:7421`) and the `vst` CLI (`Authorization: Bearer <token>`)
- **Assumption:** loopback reachability = physical machine access. Acceptable for a personal workstation; not appropriate for a shared server

> **Electron / Tauri (future):** the webview opens `http://localhost:<port>` by definition, so this trust model carries over unchanged. For additional hardening, generate a per-launch token, embed it in the webview URL as a query param, and exchange it for a cookie on first load — no user interaction required.

---

## Remote sessions (phone / other device)

Remote devices authenticate via a one-time code embedded in a QR URL. Two delivery paths:

### Path A — Cloudflare tunnel

Requires no network configuration. The desktop enables a temporary public HTTPS URL.

```
Desktop                  Cloudflare edge           Mobile
  │                           │                       │
  ├─ POST /auth/tunnel/enable ─────────────────────►  │
  │  cloudflared dials out                            │
  │◄─ tunnelUrl ──────────────┤                       │
  │                           │                       │
  ├─ POST /auth/mobile-qr ──► │ (one-time code, 30s)  │
  │◄─ qrUrl ──────────────────┤                       │
  │                           │                       │
  │  [QR shown on desktop]    │                       │
  │                           │◄─ GET /mobile-auth?code= (phone scans)
  │                           │  CF-Connecting-IP added│
  │◄──────────────────────────┤                       │
  │  validate code + issue cookie                     │
  │──────────────────────────────────────────────────►│
  │                      200 + Set-Cookie             │
```

- Tunnel URL is ephemeral (`*.trycloudflare.com`) — rotates on each enable
- `CF-Connecting-IP` header identifies the path; absent = not a tunnel request
- Cookie: `HttpOnly; Secure; SameSite=Lax` (Lax because cross-origin tunnel)

### Path B — Local network / Tailscale

No external service. Phone must share the same network (LAN or Tailscale overlay).

```
Desktop                                              Mobile
  │                                                    │
  ├─ POST /auth/local-qr ──────────────────────────►   │
  │  os.networkInterfaces()                            │
  │  → prefer 100.64.x.x (Tailscale) else LAN IP      │
  │◄─ qrUrl: http://192.168.x.x:7421/mobile-auth?code= │
  │                                                    │
  │  [QR shown on desktop]                             │
  │                                                    │
  │◄──────────────── GET /mobile-auth?code= ──────────┤
  │  (direct TCP, no CF header)                        │
  │  validate code + issue cookie                      │
  │─────────────────────────────────────────────────► │
  │                    200 + Set-Cookie               │
```

- Works on same WiFi, wired LAN, or Tailscale (mesh VPN)
- Rate-limited by `req.ip` (the phone's actual LAN/Tailscale address)
- Cookie: `HttpOnly; SameSite=Lax` — **no `Secure`**: the origin is plain `http://<ip>:<port>` and browsers silently drop `Secure` cookies on insecure origins

---

## Session model

All sessions (local QR, tunnel QR, and password — legacy) share the same store.

| Field | Value |
|-------|-------|
| Storage | SQLite + in-memory LRU cache (`auth-session-store.ts`) |
| Cookie | HMAC-signed nonce — `COOKIE_NAME=<base64(nonce.hmac)>` |
| Expiry | 7 days sliding — reset on each authenticated request |
| Revocation | Hard-delete from store; open WebSocket connections closed immediately |
| `createdVia` | `"qr"` (mobile) or `"password"` (desktop legacy) |

### One-time codes

| Property | Value |
|----------|-------|
| Length | 64 hex chars (32 random bytes) |
| Lifetime | 30 seconds |
| Single-use | Marked `consumed` before cookie is issued (prevents double-scan race) |
| Storage | In-memory `Map` — tunnel-minted codes cleared on tunnel disable (local codes survive); pruned every 60 s |
| Transport-bound | A code records its `origin` (`tunnel` \| `local`) and is only redeemable on that transport — a LAN code cannot be replayed through the public tunnel |

---

## Desktop-only routes

Requests arriving via the Cloudflare tunnel (`CF-Connecting-IP` header present) are blocked from mutating tunnel state or minting new codes. Returns `403 TUNNEL_ONLY_BLOCKED`.

| Route | Desktop only |
|-------|:------------:|
| `POST /auth/tunnel/enable` | ✅ |
| `POST /auth/tunnel/disable` | ✅ |
| `POST /auth/mobile-qr` | ✅ |
| `POST /auth/local-qr` | ✅ |
| `GET /auth/sessions` | ✅ |
| `DELETE /auth/sessions/:nonce` | ✅ |
| `GET /auth/tunnel/status` | ❌ (readable by any authenticated device; **not** auth-exempt — it returns the public tunnel URL) |
| `GET /mobile-auth` | ❌ (exempt — the auth handshake itself) |

---

## Future directions

- **Electron/Tauri:** store token in OS keychain (`safeStorage` / `tauri-plugin-stronghold`); open webview to `http://localhost:<port>/?launch_token=<short-lived-token>` and exchange on first load
- **Tailscale auto-detect:** surface Tailscale IP in the QR label; no extra config needed beyond installing Tailscale on both devices
- **Re-auth for destructive actions:** revoke-all, tunnel disable could require a password re-entry even with a valid session cookie
