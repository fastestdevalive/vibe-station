# Security: Browser Endpoint Protection

## Context

Vibe-station's daemon exposes 20+ REST endpoints and a WebSocket on `http://127.0.0.1:<port>` with **zero authentication**. Today the only protection is that the daemon binds to `127.0.0.1` (localhost-only), which blocks remote attackers. But any process on the same machine — a malicious npm script, a rogue terminal command, or a developer who knows port 7421 — can freely call every endpoint: spawn agents, inject keystrokes, read files, delete worktrees.

The CLI is fine as-is (it's a trusted local process). The browser endpoint is the concern.

### Threat model

We defend against: **malicious local processes that do not have read access to `~/.vibe-station/config.json`** (e.g. a rogue npm script, a malicious binary, a browser-based CSRF attempt from `evil.com`).

We do **not** defend against: processes running as the same OS user with full filesystem access; malicious browser extensions with `cookies` permission; physical access to the machine. If an attacker can read `config.json` or the browser's cookie store, they have as much access as the user — that is outside the threat model for a single-user local dev tool.

---

## Chosen Approach: Token Login → httpOnly Session Cookie

### How it works

1. **Daemon generates a secret token** at startup — `crypto.randomBytes(32).toString('hex')` (64-char hex).
2. **Token written to `~/.vibe-station/config.json`** with mode `0o600` (owner-read/write only) alongside `port` and `pid`. Printed to stdout on start:
   ```
   vst daemon listening on http://127.0.0.1:7421
   Browser token: a3f9...c1d2  (full token in ~/.vibe-station/config.json)
   ```
3. **`vst open`** opens `http://localhost:5173` — **no token in the URL, never passed via argv**.
4. **App loads → calls `GET /api/auth/check`** → daemon returns 401 → app shows **"Login to Vibe Station"** screen.
5. **User pastes the token** from the terminal → clicks "Login".
6. **`POST /api/auth/login` with `{ token }`** → daemon validates → responds with:
   ```
   Set-Cookie: vst-session=<issuedAt>.<nonce>.<hmac>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000
   ```
   Note: `Secure` flag is **intentionally omitted** — the UI runs over plain HTTP on localhost. Adding `Secure` would silently prevent the browser from sending the cookie and manifest as "login succeeds but every subsequent request is 401" — a very confusing bug.
7. **Browser stores the cookie automatically** — user never sees it again.
8. **All subsequent REST calls carry the cookie automatically** (browser behaviour — no manual header threading).
9. **WebSocket upgrade also carries the cookie** (browser sends cookies on WS handshakes to the same origin).
10. **CLI** reads the token directly from `config.json` and sends `Authorization: Bearer <token>` — bypasses the cookie flow entirely. No cookie complexity for the CLI.

### Why this is better than URL-param tokens

| | URL token | Cookie session (this approach) |
|---|---|---|
| Token in browser history | ✅ Yes | ❌ Never |
| Token in server logs | ✅ Yes | ❌ Never |
| Need to thread through React Router | ✅ Yes | ❌ No |
| Works across page refreshes | Manual (sessionStorage) | ✅ Automatic |
| XSS can steal it | Via sessionStorage | ❌ HttpOnly |
| CSRF risk | ❌ None | Low (SameSite=Strict) |

---

## Technical Deep-Dive

### 1. Session Token Storage on the Daemon

**There is no server-side storage.** Session tokens are self-validating via HMAC. The daemon only needs to hold the daemon token (already in memory from startup) to verify any session cookie.

#### What is HMAC and what does "self-validating" mean?

**HMAC** (Hash-based Message Authentication Code) is a way to produce a tamper-proof fingerprint of some data, using a secret key. The key property: only someone who knows the secret key can produce or verify the fingerprint. Anyone who doesn't know the key cannot forge a valid one — even if they can see the fingerprint itself.

Concretely, when the daemon issues a session cookie it computes:

```
fingerprint = HMAC-SHA256("1746123456789.a3f9c1d2...", daemonToken)
```

This fingerprint is then included in the cookie value. When the next request arrives, the daemon re-runs the exact same computation over the data in the cookie and checks whether the fingerprint matches. If someone tampers with any part of the cookie (e.g. changes the timestamp to extend expiry, or replaces the nonce), the fingerprint check fails and the request is rejected.

**"Self-validating"** means the cookie proves its own authenticity by carrying a fingerprint that only the daemon could have produced — because the daemon token is the secret ingredient in that fingerprint. The daemon never needs to look up a record in a database or an in-memory table. It just re-derives the fingerprint from the cookie's data and compares. Match → genuine. Mismatch → tampered or forged.

Think of it like a wax seal: the daemon token is the unique stamp. When issuing a cookie the daemon stamps it; when a cookie arrives it checks for the stamp. Anyone without the stamp can't fake one, and can't alter the cookie without breaking the seal.

The security guarantee rests entirely on the `daemonToken` being secret. That token lives in `~/.vibe-station/config.json` (mode `0o600`, readable only by the owner) and in daemon process memory. As long as an attacker doesn't have access to that file, they cannot forge a valid session cookie.

#### Cookie wire format

```
vst-session=<issuedAt>.<nonce>.<hmac>
```

| Field | Size | Description |
|---|---|---|
| `issuedAt` | 13 chars | `Date.now()` in ms, base-10 string |
| `nonce` | 32 chars | `randomBytes(16).toString('hex')` — makes each cookie unique |
| `hmac` | 64 chars | `HMAC-SHA256(issuedAt + "." + nonce, daemonToken)` — hex encoded |

#### Validation algorithm (every request)

```
1. Extract vst-session cookie value using @fastify/cookie parser (not hand-rolled)
2. Split on first two "." → [issuedAt, nonce, receivedHmac]
3. Guard: if parts.length !== 3, return false immediately
4. Guard: if receivedHmac.length !== expectedHmac.length, return false (timingSafeEqual throws on length mismatch)
5. Recompute: expectedHmac = HMAC-SHA256(issuedAt + "." + nonce, daemonToken)
6. Constant-time compare: crypto.timingSafeEqual(buf(receivedHmac), buf(expectedHmac))  → forgery check
7. Age check: const age = Date.now() - parseInt(issuedAt, 10)
             if age < 0 OR age >= TTL → reject  (catches future-dated cookies AND expired cookies)
8. Pass → allow request. Fail → 401.
```

Steps 3 and 4 are critical: `crypto.timingSafeEqual()` throws if buffers differ in length, which would produce a 500 instead of a 401 and leak information as a side channel. Always length-check first.

Step 7 bounds the age on both sides — `age < 0` rejects a cookie with a future `issuedAt` timestamp (which would otherwise pass the `< TTL` check since a large negative number is less than TTL).

#### Why no server-side session store

- No database, no in-memory Map to keep in sync across hypothetical future multi-process setups
- Daemon restart naturally invalidates all sessions (new `daemonToken` → old HMACs invalid)
- Revocation is coarse but sufficient: `vst daemon restart` kills all sessions if needed
- The tradeoff — you can't invalidate a single session without restarting — is acceptable for a single-user local tool

---

### 2. What does `Authorization: Bearer` accept?

Two credential types are accepted, checked in order:

```
Request arrives
  │
  ├─ Has "Authorization: Bearer <value>" header?
  │     │
  │     └─ value === daemonToken ?  → ✅ Allow  (CLI path)
  │         else                    → ❌ 401
  │
  └─ Has "Cookie: vst-session=<value>" header?
        │
        └─ HMAC valid AND 0 ≤ age < TTL? → ✅ Allow  (browser path)
            else                         → ❌ 401
```

**Bearer only accepts the raw daemon token — not a session cookie value.**

Rationale:
- The daemon token is a 64-char secret known only to the local filesystem (`config.json`) — exactly what the CLI already reads.
- Session cookies are browser-scoped and meant to be opaque. Allowing them via Bearer would create a second path to exploit a leaked cookie.
- Keeping the two paths completely separate makes the auth logic easier to audit: CLI = Bearer + daemon token, Browser = Cookie + session.

The CLI never touches cookies. The browser never touches the daemon token directly (only via the one-time `/auth/login` exchange).

---

### 3. Session Token TTL

Session cookies have a **30-day TTL** encoded in the `issuedAt` field and enforced on every request.

```ts
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
```

Additionally, the cookie is sent with `Max-Age=2592000` (30 days in seconds) so the browser also purges it automatically after expiry, even without server involvement.

#### Why 30 days and not shorter

| TTL option | UX impact | Security impact |
|---|---|---|
| Browser session (no Max-Age) | Re-auth on every browser close — annoying for a dev tool | Fine for security |
| 1 day | Re-auth every morning | Marginally better |
| **30 days** | **Re-auth once a month or on daemon restart** | **Acceptable for localhost-only tool** |
| Never | Never re-auth | Revocation only by daemon restart |

30 days strikes the right balance: long enough that developers don't notice it, short enough that abandoned sessions (e.g., on a machine you stopped using) expire on their own.

#### When sessions invalidate regardless of TTL

| Event | Effect |
|---|---|
| Daemon restart | New `daemonToken` generated → all existing HMACs invalid → all sessions dead |
| `vst daemon stop && vst daemon start` | Same as above |
| Cookie TTL reached (30 days) | Browser discards cookie; daemon rejects if somehow presented |
| User clears browser cookies | Session gone; LoginScreen on next visit |
| User clicks "Sign out" | `POST /auth/logout` → `Set-Cookie: vst-session=; Max-Age=0` clears cookie client-side |

---

---

## Implementation Plan

### Phase 1 — Daemon: generate token + auth routes + session validation

**`daemon/src/main.ts`**
- Import `randomBytes` from `node:crypto`
- Generate `const token = randomBytes(32).toString('hex')` before `buildServer()`
- Pass `token` to `buildServer({ ..., token })` and `writeConfig(port, token)`
- `writeConfig` must write `config.json` with `{ mode: 0o600 }` — owner-only read/write. Also `chmod` any existing file on startup in case it was created with wrong permissions.
- Token must **never** be passed as a CLI argv — it travels only via `config.json` and process memory
- Print: `Browser token: ${token.slice(0, 8)}...  (full token in ~/.vibe-station/config.json)`

**`daemon/src/auth.ts`** *(new file)*
- Cookie format: `<issuedAt>.<nonce>.<hmac>` (dot-separated, 3 parts)
- `generateSessionCookie(daemonToken: string): string`
  - `issuedAt = Date.now().toString(10)`
  - `nonce = randomBytes(16).toString('hex')`
  - `hmac = createHmac('sha256', daemonToken).update(issuedAt + '.' + nonce).digest('hex')`
  - returns `issuedAt + '.' + nonce + '.' + hmac`
- `validateSessionCookie(cookie: string, daemonToken: string): boolean`
  - Split on `.` → must be exactly 3 parts, else return false
  - Length-check: `receivedHmac.length` must equal 64 (SHA256 hex), else return false (guards `timingSafeEqual` from throwing)
  - Recompute expectedHmac, `timingSafeEqual` compare
  - Age: `const age = Date.now() - parseInt(issuedAt, 10)` → reject if `age < 0 || age >= SESSION_TTL_MS`
- Uses Node built-in `crypto` only — no new dependencies

**`daemon/src/routes/auth.ts`** *(new file)*
- `POST /auth/login`
  - Reads `body.token`, constant-time compares to daemon token
  - On success: call `generateSessionCookie`, respond with `Set-Cookie: vst-session=<value>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (no `Secure` — localhost HTTP)
  - Returns `{ ok: true }`; on failure `{ error: 'Invalid token' }` with 401
  - **Rate limit**: simple in-memory counter — max 10 attempts per minute per remote IP. Reset on success. Return 429 on breach.
- `POST /auth/logout`
  - Sets `Set-Cookie: vst-session=; Max-Age=0; Path=/` to clear the cookie
  - Returns `{ ok: true }` — no auth required (harmless to call when not logged in)
- `GET /auth/check`
  - Reads and validates `vst-session` cookie (using `validateSessionCookie`)
  - Returns `{ ok: true }` or 401 `{ error: 'Not authenticated' }`
  - All three routes **excluded from the global auth guard**

**`daemon/src/server.ts`**
- Add `token?: string` to `BuildServerOptions`
- Register `@fastify/cookie` plugin **before** any hooks or routes — it must parse `req.cookies` before the `onRequest` hook fires
- Register `@fastify/cors` with `{ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], credentials: true }` — required for `credentials: 'include'` fetch calls to work in dev. Without `credentials: true`, the browser ignores the `Set-Cookie` response header.
- Add Fastify `onRequest` hook:
  - Skip: `GET /health`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/check`
  - Check Bearer first: if `Authorization: Bearer <value>` header present, constant-time compare to daemon token → allow or 401
  - Then check cookie: `validateSessionCookie(req.cookies['vst-session'], token)` → allow or 401

**`daemon/src/ws/server.ts`**
- In `registerWSEndpoint(app, token?)`:
  - **Origin check**: `req.headers.origin` must be in the allowed list (`http://localhost:5173`, `http://127.0.0.1:5173`). Reject if not — this guards against malicious pages on other origins opening a WS to the daemon.
  - Cookie validation: parse `vst-session` from `req.headers.cookie` using the same `@fastify/cookie` parser (not hand-rolled). Call `validateSessionCookie(value, token)`.
  - Close with code 4401 if either check fails — **do not call `registerConnection`**

### Phase 2 — CLI: Bearer token on all requests (bypasses cookie)

**`cli/src/lib/daemon-url.ts`**
- Update `ConfigFile` interface: add `token?: string`
- Add `getDaemonToken(): string | null` — reads `config.json`, returns `token` field (or null if field missing — handles pre-auth daemons gracefully)

**`cli/src/lib/daemon-client.ts`**
- Import `getDaemonToken`
- In `daemonRequest()`, add `Authorization: Bearer <token>` header when token is non-null
- If token is null (old daemon without auth), proceed without header — CLI still works
- If token is present but daemon returns 401, surface a clear error: `"Daemon requires authentication. Run \`vst daemon restart\` to regenerate credentials."`

**`daemon/src/server.ts`** auth hook
- CLI Bearer path: constant-time compare `req.headers.authorization` against `Bearer ${daemonToken}`
- **Never** accept a session cookie value via Bearer — the two paths are fully separate

### Phase 3 — Web UI: login screen + cookie-based auth (no token storage needed)

**`web-ui/src/components/auth/LoginScreen.tsx`** *(new)*
- Clean, minimal UI: vibe-station logo + "Enter your access token" input (password type) + "Login" button
- On submit: `POST /api/auth/login` with `{ token }` → on 200, trigger app re-render → main UI appears
- On 401: show "Incorrect token. Try again." error
- Helper text: `"Find your token in the terminal where you ran vst daemon start"`
- Follow the **100gb-minimalist design system** at `~/code/fastestdevalive/100gb-minimalist-design-system/` — see `design-system-context.md` for the full token + component reference
- See the **UI Design** section below for the layout mockup and specific components to use

**`web-ui/src/hooks/useAuth.ts`** *(new)*
- `useAuth()` hook: calls `GET /api/auth/check` on mount
- Returns `{ authed: boolean, loading: boolean }`
- On 401 → `authed: false`; on 200 → `authed: true`
- Also listens for 401 responses from any API call (e.g. expired session mid-use) → set `authed: false` → LoginScreen appears without a hard reload

**`web-ui/src/App.tsx`**
- Use `useAuth()` hook → show spinner while loading → render `<LoginScreen />` if not authed → render main app if authed

**`web-ui/src/api/client.ts`**
- **No auth header threading needed** — cookies are sent automatically by the browser
- All `fetch` calls must use `credentials: 'include'` (not `'same-origin'`) — in dev the web-ui runs on `:5173` and the daemon on `:7421`, which are different origins. `'same-origin'` would silently drop the cookie.
- Add `login(token: string): Promise<void>` method: `POST /auth/login`
- Add `logout(): Promise<void>` method: `POST /auth/logout`
- Add `checkAuth(): Promise<boolean>` method: `GET /auth/check` → returns true/false
- WS URL: cookies are sent automatically on same-origin WS upgrades, but in dev (different port), must confirm Vite proxy forwards `Cookie` headers. See Vite proxy note below.
- **WS 4401 guard**: in `socket.onclose`, check if close code is 4401 → do **not** call `scheduleReconnect()` → instead emit a synthetic `auth:expired` event that `useAuth` listens to → shows LoginScreen. Without this guard the WS client will hammer the daemon in a tight reconnect loop once a session expires.

**`web-ui/vite.config.ts`** — Vite proxy update
- Current proxy: `/api → http://127.0.0.1:7421` and `/ws → ws://127.0.0.1:7421`
- Add `changeOrigin: true` to both proxy entries so `Cookie` and `Set-Cookie` headers are forwarded correctly through the dev proxy
- Also add `ws: true` to the WS proxy entry if not already present

### Phase 4 — `vst open` command

**`cli/src/commands/open.ts`**
- Open `http://localhost:5173` — no token in URL (LoginScreen handles auth)
- Fix hardcoded `http://localhost:3000` → `http://localhost:5173` (matching actual Vite dev port)

### Phase 5 — Migration & existing installs

**Pre-existing `config.json` without `token`:**
- Daemon reads `config.json` on start. If no `token` field, it generates one and rewrites the file with `{ mode: 0o600 }`.
- CLI: `getDaemonToken()` returns null if field is missing → `daemonRequest` sends no auth header → works with old daemon.
- New daemon + old CLI (no Bearer header): daemon's `onRequest` hook sees no `Authorization` and no cookie → 401. CLI will get a 401 response. Surface message: "Daemon requires auth — please update `vst` CLI or run `vst daemon restart`."

### Phase 6 — Tests & verification

```bash
# Daemon rejects unauthenticated requests
curl http://127.0.0.1:7421/projects                              # → 401
curl http://127.0.0.1:7421/health                                # → 200 (exempt)
curl http://127.0.0.1:7421/auth/check                            # → 401

# CLI path works with Bearer token
TOKEN=$(jq -r .token ~/.vibe-station/config.json)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7421/projects  # → 200

# Cookie login flow
curl -c cookies.txt -X POST http://127.0.0.1:7421/auth/login \
  -H "Content-Type: application/json" -d '{"token":"'$TOKEN'"}'  # → 200 + Set-Cookie
curl -b cookies.txt http://127.0.0.1:7421/projects               # → 200

# Wrong token rejected
curl -X POST http://127.0.0.1:7421/auth/login \
  -H "Content-Type: application/json" -d '{"token":"wrong"}'     # → 401

# Rate limit kicks in after 10 attempts
for i in $(seq 1 11); do curl -X POST .../auth/login -d '{"token":"x"}'; done
# 11th request → 429

# Logout clears cookie
curl -b cookies.txt -c cookies.txt -X POST .../auth/logout       # → 200, Set-Cookie clears
curl -b cookies.txt .../projects                                  # → 401

# Tampered cookie rejected
curl -b "vst-session=9999999999999.aaa.bbbbb" .../projects        # → 401

# config.json file permissions
stat -c "%a" ~/.vibe-station/config.json                          # → 600

# WS without cookie rejected
wscat -c ws://localhost:7421/ws                                    # → 4401
# WS with wrong Origin rejected
wscat -H "Origin: http://evil.com" -c ws://localhost:7421/ws      # → 4401
```

---

## Critical Files

| File | Change |
|------|--------|
| `daemon/src/main.ts` | Generate token, write config with `0o600`, pass to buildServer |
| `daemon/src/auth.ts` | **New** — HMAC cookie generation + validation (3-part format) |
| `daemon/src/routes/auth.ts` | **New** — `POST /auth/login` (+ rate limit), `POST /auth/logout`, `GET /auth/check` |
| `daemon/src/server.ts` | Register `@fastify/cookie` first, then `@fastify/cors`, then `onRequest` guard |
| `daemon/src/ws/server.ts` | Origin allowlist check + cookie validation before `registerConnection` |
| `cli/src/lib/daemon-url.ts` | Add `getDaemonToken()` |
| `cli/src/lib/daemon-client.ts` | Add `Authorization: Bearer` header; 401 error message |
| `web-ui/src/components/auth/LoginScreen.tsx` | **New** — token entry UI |
| `web-ui/src/hooks/useAuth.ts` | **New** — `useAuth()` hook; listens for mid-session 401s |
| `web-ui/src/App.tsx` | Gate on `useAuth()`, render LoginScreen or main app |
| `web-ui/src/api/client.ts` | `credentials: 'include'`; `login()`, `logout()`, `checkAuth()`; WS 4401 guard |
| `web-ui/vite.config.ts` | Add `changeOrigin: true` to proxy entries |

---

## UI Design — LoginScreen

### Design system reference

Use the **100gb-minimalist design system** located at `~/code/fastestdevalive/100gb-minimalist-design-system/`.
Full token + component spec: `design-system-context.md` in that directory.

**Relevant components to use directly:**
- `Card` — `variant="default"` (flat style: `bg-card #191919`, `border-default #262626`)
- `Input` — `type="password"`, `label="Access token"`, `error={errorMsg}` prop for wrong-token state
- `Button` — `variant="primary"`, `size="lg"`, full width inside card

**Relevant tokens:**
- Background: `--bg-primary: #0f0f0f` (page), `--bg-card: #191919` (card)
- Text: `--fg-primary: #e5e5e5`, `--fg-muted: #6b6b6b` (helper text)
- Font: `--font-mono` (JetBrains Mono) — default for the design system
- Spacing: `--space-6: 24px` (card padding), `--space-4: 16px` (between elements)
- Border radius: `--radius-lg: 8px` (card), `--radius-md: 6px` (input/button)
- Status: `--destructive: #dc2626` (error state on wrong token)

---

### Layout mockup

The TopBar is always visible — rendered in its usual slot at the top. In login state it shows
a minimal variant: just the brand name and a `● not signed in` status indicator on the right
(replaces the normal `ConnectionStatus` + pane toggle buttons).
The LoginScreen fills the content area below it.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Vibe Station                                              ● not signed in   │  ← TopBar (layoutMode="login")
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                                                                              │
│                                                                              │
│                   ┌──────────────────────────────────────┐                  │
│                   │                                      │                  │
│                   │           Vibe Station               │                  │  ← brand wordmark, --fg-primary
│                   │         ──────────────               │                  │  ← subtle separator
│                   │                                      │                  │
│                   │  Access token                        │                  │  ← Input label, --fg-secondary
│                   │  ┌────────────────────────────────┐  │                  │
│                   │  │  ••••••••••••••••••••••••••••  │  │                  │  ← Input (password), --bg-input
│                   │  └────────────────────────────────┘  │                  │
│                   │                                      │                  │
│                   │  ┌────────────────────────────────┐  │                  │
│                   │  │            Login               │  │                  │  ← Button primary lg, full width
│                   │  └────────────────────────────────┘  │                  │
│                   │                                      │                  │
│                   │  Find your token in the terminal     │                  │  ← --fg-muted, --font-size-sm
│                   │  where you ran `vst daemon start`    │                  │
│                   │                                      │                  │
│                   └──────────────────────────────────────┘                  │
│                                                                              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Wrong token state** — Input turns red, error message appears below it, button stays enabled:

```
│                   │  Access token                        │
│                   │  ┌────────────────────────────────┐  │
│                   │  │  ••••••••••••••••••••••••••••  │  │  ← border: --destructive
│                   │  └────────────────────────────────┘  │
│                   │  Incorrect token. Try again.         │  ← --destructive, --font-size-sm
```

**Loading state** — while `POST /auth/login` is in-flight, button shows "Logging in…" and is disabled:

```
│                   │  ┌────────────────────────────────┐  │
│                   │  │          Logging in…            │  │  ← disabled, reduced opacity
│                   │  └────────────────────────────────┘  │
```

---

### TopBar in login state

Pass a new `layoutMode="login"` prop to `TopBar`. In this mode:
- **Left side**: sidebar toggle hidden (no sidebar in login state), brand "Vibe Station" shown
- **Right side**: replace `ConnectionStatus` + all pane controls with a single `● not signed in` chip
  - Color: `--fg-muted` for the dot + label
  - No interactive controls — there's nothing to operate while not signed in
- Breadcrumb: empty / hidden

This avoids rendering a broken-looking toolbar with offline indicators and disabled buttons.
