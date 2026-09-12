# Tailscale HTTPS — Feature Plan

**Feature:** Native Tailscale HTTPS URL support in the Remote Access settings
**Scope:** No binary bundling. Requires Tailscale already installed on host. Three new daemon routes, one new UI card, one `vst doctor` check.

---

## Daemon

### New service: `daemon/src/services/tailscaleServe.ts`

Shell-out util modelled on `daemon/src/services/git.ts:5-17` (`promisify(execFile)`, arg array, no shell string). All calls use an explicit 15 s timeout.

**Status detection — `GET /tailscale/status`**

Step 1 — run `tailscale status --json`:
- ENOENT / nonzero exit (tailscaled unreachable) → `{ state: "not_installed" }`
- Exit 0 — parse `BackendState`:
  - `"NoState"` | `"Starting"` → `{ state: "starting" }` (transient — UI shows spinner)
  - `"NeedsLogin"` | `"NeedsMachineAuth"` | `"Stopped"` → `{ state: "not_connected" }`
  - `"Running"` → proceed to step 2

Step 2 — check operator permission (Linux only):
- Shell out `tailscale serve status --json` (needs `PermitWrite`); `access denied` stderr → `{ state: "needs_operator", fixCommand: "sudo tailscale set --operator=$USER" }`

Step 3 — check HTTPS certs:
- `CertDomains` is empty or missing → `{ state: "certs_not_enabled", enableUrl: <captured from a dry-run> }`
  - This is a *pre-enable* gate, not a post-serve state
  - `Self.DNSName` always has a trailing dot — `TrimSuffix(".")`

Step 4 — read serve config via `tailscale serve status --json`:
- Returns `{}` or `null` when nothing configured → `{ state: "connected_no_serve", httpsUrl: "https://<dnsname>", setupCommand: "..." }`
- Parses `Web["<dnsname>:443"].Handlers["/"].Proxy` — compare **port only** (parse URL, never string-match) against current daemon port
  - Port matches → `{ state: "serve_active", httpsUrl: "https://<dnsname>" }`
  - Port doesn't match → `{ state: "port_mismatch", expectedPort: <current>, actualPort: <from config>, fixCommand: "..." }`

```ts
type TailscaleStatus =
  | { state: "not_installed" }
  | { state: "starting" }
  | { state: "not_connected" }
  | { state: "needs_operator"; fixCommand: string }
  | { state: "certs_not_enabled"; dnsName: string }
  | { state: "connected_no_serve"; httpsUrl: string }
  | { state: "serve_active"; httpsUrl: string }
  | { state: "port_mismatch"; expectedPort: number; actualPort: number; fixCommand: string }
  | { state: "error"; message: string }
```

**New endpoint: `POST /tailscale/serve/enable`**
- Runs: `tailscale serve --bg --yes --https=443 http://127.0.0.1:<port>`
  - `--bg` is required — without it the rule is foreground-scoped and dies with the child process
  - `--yes` suppresses interactive prompts
- Captures stdout (may contain ACME enablement URL — surface if certs gate fires)
- Hard timeout: 15 s
- **Does NOT trust exit code for success** — after the call, re-reads `tailscale serve status --json` to confirm the rule is registered
- Returns `{ httpsUrl: "https://<dnsname>" }` on success, error otherwise

**New endpoint: `POST /tailscale/serve/disable`**
- Runs: `tailscale serve --https=443 off`
- Before running: reads current serve config — if `/` handler points to a different port (not ours), returns 409 (don't clobber a user's existing rule)
- Verifies removal via re-read of serve status
- Returns `{}`

**New endpoint: `GET /tailscale/qr`** (mirrors `POST /auth/local-qr`)
- Mints a 30 s one-time code (same mechanism as `mobileAuth.ts:122-155`)
- Returns `{ qrUrl: "https://<dnsname>/mobile-auth?code=<hex>", expiresAt: <ms> }`
- This is required — the existing QR overlay expects `expiresAt` and drives a countdown; tailscale serve peers are remote, so they need the auth-code gate just like tunnel peers

**Startup port-drift check** (in `main.ts` or called from it after `setDaemonPort`):
- Reads `tailscale serve status --json`
- If a rule exists but points to a wrong port → logs a warning; the UI surfaces it as `port_mismatch`
- Does NOT auto-fix

**Session cookie `Secure` flag** (`mobileAuth.ts:~269-276`):
- Currently keyed on `viaTunnel`; extend to also set `Secure` when `x-forwarded-proto === "https"` — covers Tailscale serve path without breaking LAN path

**`isTunnelRequest()` guard** (`mobileAuth.ts:47-49`):
- Currently only checks `cf-connecting-ip`
- Extend to also treat requests with `x-forwarded-proto: https` + non-loopback `req.ip` as remote — prevents a tailnet peer from calling `/auth/tunnel/enable` and standing up a public Cloudflare tunnel

**trustProxy note** (`server.ts:98`, `trustProxy: "loopback"`):
- Tailscale serve sets `X-Forwarded-For: <tailnet-IP>`, so `req.ip` correctly resolves to the tailnet IP and the loopback auth bypass does not fire — this is correct behaviour, but fragile; add a comment noting the dependency so it's not silently broken by a `trustProxy` change

---

## UI

**`web-ui/src/api/client.ts` and `web-ui/src/api/mock.ts`**
Both files must get new methods (`getTailscaleStatus`, `enableTailscaleServe`, `disableTailscaleServe`, `getTailscaleQr`) — `ApiInstance` is a union type and both sides must stay in sync.

**`web-ui/src/components/settings/RemoteAccessSetting.tsx`**
At 677 lines, extract existing cards into sub-components first (one task, committed separately), then add the Tailscale card.

New card states:

| State | What the card shows |
|---|---|
| `not_installed` | Muted: "Tailscale not installed" — no action |
| `starting` | Spinner: "Connecting to Tailscale…" |
| `not_connected` | "Run `tailscale up` to connect" |
| `needs_operator` | "Permissions needed" + copyable `sudo tailscale set --operator=$USER` |
| `certs_not_enabled` | "Enable HTTPS in Tailscale admin" + link to admin console |
| `connected_no_serve` | Acknowledgment note ("reachable by all tailnet members") + "Enable" button |
| `serve_active` | Green dot · URL · "Show QR" + "Disable" buttons |
| `port_mismatch` | Warning + "Fix" button (re-runs enable with correct port) |
| `error` | Error string in `var(--fg-danger)` |

**Status fetch:**
- Fetched independently of the existing tunnel `loading` gate (don't block the whole panel)
- No polling — tailscale state changes out-of-band; add a manual "Refresh" link shown in `serve_active` and `port_mismatch` states

**QR overlay:**
- `getTailscaleQr` returns `{ qrUrl, expiresAt }` — same shape as local/tunnel QR responses
- Existing overlay works unmodified — `expiresAt` drives the countdown correctly

**"Same network" card copy:**
- Currently says "Works on same WiFi or Tailscale" — with a dedicated Tailscale card, change to "Works on same WiFi or LAN" to avoid overlap

---

## CLI

**Which `doctor`:** `cli/src/commands/doctor.ts` (live, chalk output). `daemon/src/services/doctor.ts` has zero callers and is dead code — do not add to it.

New check added to `cli/src/commands/doctor.ts`:
```
tailscale      ✓ connected (machine.tailXXXX.ts.net) / ✗ not found / ✗ not connected
```
Uses `execFile` with an explicit timeout (the existing `execSync` calls have no timeout — don't copy that pattern).

**`VST_PORT` env var** (alongside this feature):
- `daemon/src/main.ts:176` scans 7421–7520 with no override; every boot with 7421 taken silently drifts and breaks any active serve rule
- Add `const port = process.env.VST_PORT ? parseInt(process.env.VST_PORT) : await findFreePort(DEFAULT_PORT)`
- Document in `vst doctor` output if a serve rule exists but port drifted

---

## Persistence note

Cloudflared persists enabled/disabled state to SQLite (`daemon/src/state/tunnel-store.ts`) and deliberately does not re-spawn on boot. Tailscale serve is different: the rule is stored by `tailscaled` itself and persists across all restarts with no action from the daemon. The daemon does not need to persist any tailscale state — it only reads live status on demand.

---

## Implementation order

1. `daemon/src/services/tailscaleServe.ts` — status, enable, disable logic
2. Three daemon routes (`GET /tailscale/status`, `POST /tailscale/serve/enable`, `POST /tailscale/serve/disable`, `GET /tailscale/qr`)
3. Startup port-drift check in `main.ts`
4. Fix `isTunnelRequest()` guard and `Secure` cookie in `mobileAuth.ts`
5. Extract existing `RemoteAccessSetting.tsx` cards into sub-components
6. Add Tailscale card and API client methods
7. `cli/src/commands/doctor.ts` tailscale check + `VST_PORT` env var

---

## Key decisions

- **No bundling** — `tailscaled` not shipped; user must have Tailscale installed
- **`tailscale serve --bg --yes`** — `--bg` mandatory (foreground rules die with the child process); `--yes` suppresses prompts
- **Exit code not trusted for enable success** — re-read `serve status --json` to confirm
- **Port parsed, never string-matched** — serve config `Proxy` URL is not normalized; compare port integers
- **`/auth/tailscale-qr` endpoint required** — existing QR overlay needs `expiresAt`; tailnet peers need the one-time auth code gate
- **No clobber on disable** — refuse with 409 if the existing serve rule isn't ours
- **`VST_PORT` override** — port drift is the common failure mode; add env var alongside this feature
- **Persistence owned by tailscaled** — daemon stores no tailscale state; reads live status only
