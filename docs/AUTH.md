# Authentication

vibe-station uses a single shared secret (the *daemon token*). **Every request authenticates, from every client, including the same machine** — there is no loopback trust and no "attended vs. headless" mode. The desktop app and the `vst` CLI carry a pre-minted token; remote devices authenticate via a one-time QR code.

---

## Local clients (same machine)

| Client | Credential |
|--------|------------|
| Tauri desktop window | `tauriToken` from `~/.vibe-station/config.json`, injected as `window.__VST_TOKEN__` before page scripts; sent as `Authorization: Bearer` (REST) and `?token=` (WebSocket) |
| `vst` CLI / spawned agents | `cliToken` from `~/.vibe-station/config.json` (or `VST_CLI_TOKEN`) |
| Plain browser (e.g. Vite dev) | Redeem a one-time link: `POST /api/auth/continue/mint` with the `cliToken`, then open `/continue?code=<code>` (the CLI does this for you when it launches the daemon). The daemon never prints or logs its signing key |

- Exempt routes: `GET /health`, `GET /ws` (authenticates in its own handler; a bad token closes the socket with 4401), `GET /mobile-auth`, `GET /continue`, `POST /api/auth/logout`, and static UI `GET`/`HEAD`
- `Origin`, when present, must be **same-origin with the request's `Host`** (scheme-less, port included) and that host must be loopback, a private/CGNAT IP, `*.ts.net` or `*.trycloudflare.com` — so a page on `http://localhost:<other-port>` is refused (`SameSite` cannot tell localhost ports apart; this check does). Exact extras: `tauri://localhost`, `http(s)://tauri.localhost`, plus `VST_ALLOWED_ORIGINS` (comma-separated), e.g. `VST_ALLOWED_ORIGINS=http://localhost:5173` when using the Vite dev server (needed when the page is not served through a proxy that preserves `Host`, e.g. Tauri dev). Applies to REST, CORS, the WebSocket upgrade and exempt POSTs like logout. `VST_NO_AUTH` sandbox builds use a looser host-only test on REST and the WebSocket (any port on an allowed host — loopback, private/tailnet IPs, `*.ts.net`; a plain hostname such as `mybox.local` needs `VST_ALLOWED_ORIGINS`), never other websites
- **CSRF header:** non-GET/HEAD/OPTIONS requests authenticated by the session cookie (no `Authorization: Bearer`) must carry `X-VST-CSRF` (the web UI's `apiFetch` adds it); cookie requests of any method are refused when the browser reports `Sec-Fetch-Site: same-site`/`cross-site` (covers no-`Origin` GETs from another localhost port). Bearer callers (desktop, CLI) are exempt
- **Listen address / network access:** `127.0.0.1` by default. Toggle it live in **Settings → Remote access → Same network** — it persists `"allowNetworkAccess"` in `~/.vibe-station/config.json` and swaps the listener (`127.0.0.1` ↔ `0.0.0.0`) with **no restart needed**. Enabling also lets `POST /auth/local-qr` pair a phone over a LAN/Tailscale IP (without it that route returns 409); disabling cuts non-loopback HTTP and WebSockets immediately. `VST_ALLOW_NETWORK=1` overrides a persisted `false` at next boot. Remote (tunnel/mobile) sessions cannot toggle it — local-only. Cloudflare tunnels and `tailscale serve` dial loopback and work unchanged. `VST_NO_AUTH` builds ignore the toggle
- **Desktop token is local-only:** a `Tauri`-scope token is refused (403 on REST, 4401 close on the WebSocket) when the request carries `cf-connecting-ip`, `x-forwarded-for` or `x-forwarded-host` or comes from a non-loopback peer. The Tauri CSP has no `'unsafe-inline'` for scripts
- **Served content is sandboxed:** raw repo files (a worktree's `.svg`, `.md`, etc. served from `/api/worktrees/<id>/files/…`) are served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'…`, so an opened `.svg` cannot run script on the daemon origin; every daemon-served SPA response also carries a CSP (`script-src 'self' 'wasm-unsafe-eval'`, no inline scripts)
- Token lookup order: `Authorization` header, then `?token=` (WebSocket only), then the session cookie
- **`VST_NO_AUTH` only exists in binaries built with the `insecure-no-auth` cargo feature** (off by default; release builds are guarded in CI and `scripts/prep-sidecar.sh`). Such a build binds `127.0.0.1` unless `VST_NO_AUTH_BIND_ALL=1`. The Docker dev sandbox is the intended user


### Origin / CORS decision matrix

"Network off" = default loopback listener; "on" = Settings toggle enabled. Network on/off never changes the **origin decision** — only whether the daemon is reachable at all. Every "Allowed" still needs a valid token.

| # | Page origin → daemon `Host` | Network off | Network on | Why |
|---|---|---|---|---|
| 1 | `http://localhost:7421` → `localhost:7421` (also `127.0.0.1`) | Allowed | Allowed | Same-origin, loopback host |
| 2 | Another page on a different port/host, e.g. `http://localhost:3000` or a LAN device's page → daemon | 403 | 403 | Not same-origin (port or host differs). A refused CORS preflight gets no `Access-Control-Allow-Origin` header instead of a 403 |
| 3 | Same machine, different spelling (`localhost` page → `127.0.0.1` host) | 403 | 403 | Different origin |
| 4 | Vite `http://localhost:5173` through the proxy | Allowed | Allowed | The proxy keeps `Host`, so it's same-origin. Without the proxy: `VST_ALLOWED_ORIGINS` |
| 5 | `tauri://localhost` (desktop) | Allowed | Allowed | Exact extra origin; Bearer token is the credential |
| 6 | `http://0.0.0.0:7421` | App shell loads; writes + WebSocket 403 | Same | `0.0.0.0` is a listen address, not an allowed host. Origin-less GETs fall through to the token check. Use `localhost`/`127.0.0.1` |
| 7 | Phone/tailnet IP direct, e.g. `http://192.168.1.5:7421`, `http://100.x.y.z:7421` | Can't connect (open connections: 403 / WebSocket close 4403) | Allowed | Off: nothing listens off-loopback. On: same-origin, private/CGNAT host |
| 8 | `tailscale serve` `https://box.tail1.ts.net` | Allowed | Allowed | Dials `127.0.0.1`, so the peer gate passes even when off; relies on `tailscale serve` keeping the public `Host`; `*.ts.net` host |
| 9 | Cloudflare `https://abc.trycloudflare.com` | Allowed | Allowed | Dials `127.0.0.1`, so the peer gate passes even when off; relies on `cloudflared` keeping the public `Host`; `*.trycloudflare.com` host |
| 10 | Any website, e.g. `https://evil.com` | 403 | 403 | Not same-origin. Applies even with a Bearer token |
| 11 | DNS rebinding (`evil.com` resolving to `127.0.0.1`) | Writes/WebSocket 403; origin-less GETs 401 | Same | `Host: evil.com` is not an allowed host. GETs without `Origin` reach the token check, and the localhost cookie is never sent to `evil.com` |
| 12 | Custom tunnel domain, e.g. `https://my.example.com` | 403 | 403 | Host not in the allowlist, unless that exact origin is in `VST_ALLOWED_ORIGINS` |
| 13 | `Origin: null` | 403 | 403 | Rejected as malformed |
| 14 | No `Origin` (curl, `vst` CLI, same-origin GET) | Not origin-checked | Same | Needs a token. Cookie requests marked `Sec-Fetch-Site: same-site`/`cross-site`, and cookie writes without `X-VST-CSRF`, get 403; Bearer callers are exempt from both |

- The 403 applies to requests that carry `Origin`: every write and every WebSocket upgrade, and CORS requests. Page loads (non-`/api` GET/HEAD) and the exempt GETs (`/health`, `/mobile-auth`, `/continue`) are never origin-checked
- `[::1]` and IPv6 ULA origins pass the policy, but both listeners are IPv4-only, so a browser can't connect to them
- LAN names not on the host allowlist (`mybox.local`, a MagicDNS short name, a public IP) get 403 for requests with `Origin`; use the IP or the `*.ts.net` name
- `VST_NO_AUTH` sandbox builds apply a looser host-only test (any port on an allowed host) to REST and the WebSocket, and skip the peer gate

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

`daemonToken` is the master secret — a 32-byte hex string generated at every daemon startup and held in memory only — it is never written to disk. It never leaves the server.

`POST /auth/login` does **not** issue a new bearer token. It uses `daemonToken` as the HMAC signing key:

```
cookie value = issuedAt + "." + randomNonce + "." + HMAC-SHA256(issuedAt + "." + nonce, daemonToken)
```

The cookie is self-validating: on every request the daemon recomputes the HMAC from the cookie's own `issuedAt` and `nonce` fields. No database read is needed to authenticate — SQLite is consulted only to check revocation (is this nonce still live?).

If `daemonToken` rotates (daemon restart with a new config), all existing cookies immediately become invalid because the HMAC key changed.

**Tauri desktop shell flow:**
1. Daemon reads `daemonToken` from `config.json` on startup.
2. Rust `setup()` injects `window.__VST_TOKEN__ = '<daemonToken>'` via `win.eval()` before page JS runs.
3. `apiFetch` (`web-ui/src/api/client.ts`) reads `__VST_TOKEN__` and sends it as `Authorization: Bearer` (REST) / `?token=` (WebSocket); `useAuth.ts` calls `api.checkAuthStatus()` on mount.
4. From that point on the browser holds the HMAC-signed cookie — `__VST_TOKEN__` is no longer needed.

- `useAuth` is tri-state (`loading | authed | unauthenticated | unreachable`): only 401/403 from `/auth/check` shows the login screen; network errors, 5xx/530 and non-JSON 200s show "Can't reach vibe-station — retrying…". While not authed it re-checks on `visibilitychange`/`focus`/`online`/`pageshow` plus a timer (2s→15s backoff when unreachable, 5s when unauthenticated), so an installed PWA self-heals. A login completed in another app (e.g. a QR scanned in the browser) is picked up where the cookie jar is shared with the PWA (Android Chrome); an iOS home-screen PWA has its own jar and must sign in itself.

---

## Future directions

- **Electron/Tauri:** store token in OS keychain (`safeStorage` / `tauri-plugin-stronghold`); open webview to `http://localhost:<port>/?launch_token=<short-lived-token>` and exchange on first load
- **Tailscale auto-detect:** surface Tailscale IP in the QR label; no extra config needed beyond installing Tailscale on both devices
- **Re-auth for destructive actions:** revoke-all, tunnel disable could require a password re-entry even with a valid session cookie
