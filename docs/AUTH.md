# Authentication

vibe-station uses a single shared secret (the *daemon token*). **Every request authenticates, from every client, including the same machine** — there is no loopback trust and no "attended vs. headless" mode. The desktop app and the `vst` CLI carry a pre-minted token; remote devices authenticate via a one-time QR code.

---

## Local clients (same machine)

| Client | Credential |
|--------|------------|
| Tauri desktop window | `tauriToken` from `~/.vibe-station/config.json`, injected as `window.__VST_TOKEN__` before page scripts; sent as `Authorization: Bearer` (REST) and `?token=` (WebSocket) |
| `vst` CLI / spawned agents | `cliToken` from `~/.vibe-station/config.json` (or `VST_CLI_TOKEN`) |
| Plain browser (e.g. Vite dev) | Sign in with the "Browser login password" printed at daemon startup, or redeem a one-time link: `POST /api/auth/continue/mint` with the `cliToken`, then open `/continue?code=<code>` |

- Exempt routes: `GET /health`, `GET /ws` (authenticates in its own handler; a bad token closes the socket with 4401), `GET /mobile-auth`, `GET /continue`, `POST /api/auth/logout`, and static UI `GET`/`HEAD`
- `Origin`, when present, must be **same-origin with the request's `Host`** (scheme-less, port included) and that host must be loopback, a private/CGNAT IP, `*.ts.net` or `*.trycloudflare.com` — so a page on `http://localhost:<other-port>` is refused (`SameSite` cannot tell localhost ports apart; this check does). Exact extras: `tauri://localhost`, `http(s)://tauri.localhost`, plus `VST_ALLOWED_ORIGINS` (comma-separated), e.g. `VST_ALLOWED_ORIGINS=http://localhost:5173` when using the Vite dev server (needed when the page is not served through a proxy that preserves `Host`, e.g. Tauri dev). Applies to REST, CORS, the WebSocket upgrade and exempt POSTs like logout. `VST_NO_AUTH` sandbox builds use a looser host-only test on the WebSocket (any port on loopback/LAN/tailnet/tunnel hosts, never other websites) and skip it on REST
- **CSRF header:** non-GET/HEAD/OPTIONS requests authenticated by the session cookie (no `Authorization: Bearer`) must carry `X-VST-CSRF` (the web UI's `apiFetch` adds it); cookie requests of any method are refused when the browser reports `Sec-Fetch-Site: same-site`/`cross-site` (covers no-`Origin` GETs from another localhost port). Bearer callers (desktop, CLI) are exempt
- **Listen address:** `127.0.0.1` by default. Cloudflare tunnels and `tailscale serve` dial loopback and work unchanged. Pairing a phone directly over a LAN/Tailscale IP (`POST /auth/local-qr`) needs `VST_ALLOW_NETWORK=1` or `"allowNetworkAccess": true` in `~/.vibe-station/config.json`; without it that route returns 409
- Token lookup order: `Authorization` header, then `?token=` (WebSocket only), then the session cookie
- **`VST_NO_AUTH` only exists in binaries built with the `insecure-no-auth` cargo feature** (off by default; release builds are guarded in CI and `scripts/prep-sidecar.sh`). Such a build binds `127.0.0.1` unless `VST_NO_AUTH_BIND_ALL=1`. The Docker dev sandbox is the intended user

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
- Cookie: `HttpOnly; Secure; SameSite=Strict`

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
- Cookie: `HttpOnly; SameSite=Strict` — **no `Secure`**: the origin is plain `http://<ip>:<port>` and browsers silently drop `Secure` cookies on insecure origins

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

## Token lifecycle (how POST /auth/login works)

`daemonToken` is the master secret — a 32-byte hex string generated once at daemon startup and persisted in `~/.vibe-station/config.json` (mode 0600). It never leaves the server.

`POST /auth/login` does **not** issue a new bearer token. It uses `daemonToken` as the HMAC signing key:

```
cookie value = issuedAt + "." + randomNonce + "." + HMAC-SHA256(issuedAt + "." + nonce, daemonToken)
```

The cookie is self-validating: on every request the daemon recomputes the HMAC from the cookie's own `issuedAt` and `nonce` fields. No database read is needed to authenticate — SQLite is consulted only to check revocation (is this nonce still live?).

If `daemonToken` rotates (daemon restart with a new config), all existing cookies immediately become invalid because the HMAC key changed.

**Tauri desktop shell flow:**
1. Daemon reads `daemonToken` from `config.json` on startup.
2. Rust `setup()` injects `window.__VST_TOKEN__ = '<daemonToken>'` via `win.eval()` before page JS runs.
3. `useAuth.ts` reads `__VST_TOKEN__`, calls `api.checkAuth()` first; if no valid session, calls `api.login(token)` to exchange the injected token for a session cookie.
4. From that point on the browser holds the HMAC-signed cookie — `__VST_TOKEN__` is no longer needed.

---

## Future directions

- **Electron/Tauri:** store token in OS keychain (`safeStorage` / `tauri-plugin-stronghold`); open webview to `http://localhost:<port>/?launch_token=<short-lived-token>` and exchange on first load
- **Tailscale auto-detect:** surface Tailscale IP in the QR label; no extra config needed beyond installing Tailscale on both devices
- **Re-auth for destructive actions:** revoke-all, tunnel disable could require a password re-entry even with a valid session cookie
