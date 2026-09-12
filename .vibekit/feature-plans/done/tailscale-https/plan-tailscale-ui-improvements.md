# Plan — Tailscale card UI improvements (Remote Access settings)

**Branch base:** `tailscale-https-tailscaled` (worktree `vs-128`)
**Primary files**

| File | Role |
|---|---|
| `web-ui/src/components/settings/RemoteAccessSetting.tsx` | all card UI |
| `web-ui/src/styles/workspace.css` | new status-box + inline shell-block CSS (lines 2557-2616 hold the MD code-block rules to mirror) |
| `web-ui/src/api/types.ts` | `TailscaleStatus`, new `TailscaleUpResponse` |
| `web-ui/src/api/client.ts` | `runTailscaleUp()` |
| `web-ui/src/api/mock.ts` | matching mock — **mandatory**, `ApiInstance` is a union |
| `daemon/src/services/tailscaleServe.ts` | new `runUp()` |
| `daemon/src/routes/tailscale.ts` | new `POST /tailscale/up` |
| `daemon/src/__tests__/tailscale.routes.test.ts` | route tests |
| `web-ui/src/components/settings/RemoteAccessSetting.test.tsx` | UI tests |

---

## Phase 0 — Shared primitives (do first, everything else depends on them)

### 0.1 `ShellBlock` component

**Decision: do NOT reuse `CodeBlock` directly.** The MD-preview block lives at
`web-ui/src/components/preview/CodeBlock.tsx`
(`export function CodeBlock({ children }: { children?: ReactNode })`, imported by `MarkdownView.tsx:6`, used at `MarkdownView.tsx:84-86` as the `pre` override). Its API is "give me react-markdown's `<pre>` children and I'll scrape the text out via `extractText`/`findCodeChild`". Feeding it a raw string works only by accident and it cannot host a second (Run) button.

Instead: add a small sibling that **reuses the exact same CSS classes**, so the visual is identical by construction.

New file: `web-ui/src/components/preview/ShellBlock.tsx`

```tsx
export function ShellBlock({
  command,
  lang = "bash",
  actions,          // optional extra buttons rendered left of Copy
}: { command: string; lang?: string; actions?: ReactNode })
```

- Markup mirrors `CodeBlock.tsx:69-84` exactly:
  `div.workspace-md-code-block > div.workspace-md-code-block-header (span.workspace-md-code-block-lang + actions + button.workspace-md-code-block-copy) > pre > code`.
- Copy handler: extract to `web-ui/src/lib/copyText.ts` → `export async function copyText(text: string): Promise<boolean>` (clipboard + `execCommand` fallback — required, the UI is served over plain `http://` on LAN). Have both `CodeBlock.tsx` and `ShellBlock.tsx` call it.
- CSS additions to `workspace.css` next to the block rules (~line 2560):
  ```css
  .workspace-md-code-block--inline { margin: 0; font-size: var(--font-size-xs); }
  .workspace-md-code-block--inline > pre { padding: 8px 10px; white-space: pre-wrap; word-break: break-all; }
  ```
  `ShellBlock` always applies both `workspace-md-code-block workspace-md-code-block--inline`.

### 0.2 `StatusBox` component (local to `RemoteAccessSetting.tsx`)

Add above `CARD_STYLE` (around `RemoteAccessSetting.tsx:101`):

```tsx
type Sentiment = "info" | "warn" | "error" | "busy" | "ok";
function StatusBox({ sentiment, children }: { sentiment: Sentiment; children: ReactNode })
```

- Layout: `display:flex; gap: var(--space-2); align-items: flex-start; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); font-size: var(--font-size-xs); background: var(--bg-input); border: var(--border-width) solid var(--border-default);`
- Icon column: `width: 1em; flex: 0 0 auto; line-height: 1.4`.
- Glyph + accent: `info` → `ℹ` / `var(--fg-muted)`; `warn` → `⚠` / `var(--fg-warning, #d29922)`; `error` → `✕` / `var(--fg-danger, #f85149)`; `ok` → `●` / `var(--fg-success, #16a34a)`; `busy` → animated spinner.
- Spinner: 10px `border-radius:50%` with `border: 1.5px solid var(--border-default); border-top-color: var(--fg-muted); animation: vst-spin 0.8s linear infinite;`. Grep for `vst-spin` first — add `@keyframes` to `workspace.css` only if it doesn't already exist.
- `role="status"` for `busy`/`info`; `role="alert"` for `error`.

**Fix missing tokens in `tokens.css`:** `--fg-danger`, `--fg-success`, `--fg-warning` are not defined in either theme block (only `--fg-muted` etc. exist at lines 65-94 dark / 127-145 light). Today's uses of `var(--fg-danger)` in the component at lines 380, 394, 400, 880, 905 silently inherit instead of rendering red. Fix (b): add all three to both theme blocks in `tokens.css` and drop the hex fallbacks. This is option (b) over option (a); it silently fixes five pre-existing bugs.

---

## Phase 1 — Daemon: `POST /tailscale/up`

### 1.1 `tailscaleServe.ts` — new exported `runUp()`

Insert after `disableServe()`, before `getServeStatus()`.

```ts
export interface TailscaleUpResult {
  stdout: string;
  stderr: string;
  exitCode: number;      // 0 = success; -1 when killed by timeout
  timedOut: boolean;
  loginUrl: string | null;
}

export async function runUp(): Promise<TailscaleUpResult>
```

- `execFile("tailscale", ["up", "--timeout=20s"], { timeout: 30_000, encoding: "utf8", maxBuffer: 1024 * 1024 })`.
  - No `sudo`, no `--reset`, no `--ssh` — preserves user's existing node config.
  - Use a separate `UP_TIMEOUT_MS = 30_000` constant, NOT the module's `TIMEOUT_MS = 15_000`.
- Catch the rejection:
  ```ts
  const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
  exitCode = typeof e.code === "number" ? e.code : -1;
  timedOut = e.killed === true || e.signal === "SIGTERM";
  ```
- **Rename `extractEnableUrl()` → `extractTailscaleUrl()`** (used at line 227). Run it over `stdout + "\n" + stderr` to extract loginUrl.
- Truncate `stdout`/`stderr` to last 4000 chars each before returning.
- **`NeedsLogin` critical case:** `tailscale up` prints an auth URL and blocks until authenticated. It will hit the 20s timeout. `loginUrl` will be non-null. UI must render this as a link, NOT an error.
- **`process.env.USER` can be empty under systemd** — harden `tailscaleServe.ts:171`'s `fixCommand` to fall back to `os.userInfo().username`.

### 1.2 `tailscale.ts` — route

Insert between `serve/disable` and `/tailscale/qr`:

```ts
// POST /tailscale/up — desktop/loopback only: mutates host network state
app.post("/tailscale/up", async (req, reply) => {
  const authPayload = (req as typeof req & { authPayload?: TokenPayload }).authPayload;
  if (authPayload && authPayload.scope !== "tauri") {
    return reply.status(403).send({ error: "DESKTOP_ONLY" });
  }
  try {
    return reply.send(await tailscale.runUp());
  } catch (err) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});
```

- Guard pattern copied from `auth.ts:80-84`. Import `TokenPayload` from same place.
- 200 is returned even for a failed command (`exitCode != 0`). Only ENOENT / unexpected throw → 500. Document in comment.

### 1.3 Daemon tests

Append to `tailscale.routes.test.ts`. Add `runUp: vi.fn()` to the mock factory:
1. success → 200, `{ exitCode: 0, ... }`.
2. `NeedsLogin` shape → 200, `timedOut: true`, non-null `loginUrl`.
3. non-tauri token → 403 `DESKTOP_ONLY`.
4. `runUp` throwing → 500 with `{ error }`.

Add `runUp` unit test to `tailscale.test.ts`: assert exact argv `["up", "--timeout=20s"]` (guards against adding `--reset`).

### 1.4 Web API layer

- `types.ts` — after `EnableTailscaleResponse`:
  ```ts
  export interface TailscaleUpResponse {
    stdout: string; stderr: string; exitCode: number;
    timedOut: boolean; loginUrl: string | null;
  }
  ```
- `client.ts` — after `getTailscaleQr`:
  ```ts
  async runTailscaleUp(): Promise<TailscaleUpResponse> {
    const res = await apiFetch(`${baseUrl()}/tailscale/up`, { method: "POST" });
    return parseJson<TailscaleUpResponse>(res);
  },
  ```
- `mock.ts` — **mandatory** (union type):
  ```ts
  async runTailscaleUp(): Promise<TailscaleUpResponse> {
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, loginUrl: null };
  },
  ```

---

## Phase 2 — UI changes in `RemoteAccessSetting.tsx`

### 2.1 Rename Remote → Cloudflare — `TunnelCard`

- Card title `Remote` → `Cloudflare`.
- Subtitle → `Public URL, reachable from anywhere.`
- QR overlay labels (`renderQrOverlay`): `Remote · ${u.hostname}` → `Cloudflare · ${u.hostname}`; fallback `"Remote"` → `"Cloudflare"`.
- Do NOT rename the `"tunnel"` discriminant in `ActiveQrType`, `qrLoading`, `api.enableTunnel/disableTunnel` — those are wire identifiers.

### 2.2 Refresh button — always visible

Remove the `status?.state === …` guard on the header Refresh button. Render unconditionally with a `refreshing` boolean prop:

```tsx
<button type="button" className="btn btn--secondary" onClick={onRefresh}
        disabled={loading || refreshing} aria-label="Refresh Tailscale status"
        style={{ fontSize: "var(--font-size-xs)", padding: "2px 8px", fontWeight: "normal" }}>
  {loading || refreshing ? "↺ …" : "↺ Refresh"}
</button>
```

Add `refreshing` state: set `true` at top of `fetchTailscale`, `false` in `finally`. Keep `tailscaleLoading` as the distinct first-load gate.

After successful `runTailscaleUp` or `handleTailscaleEnable`, call `void fetchTailscale()`.

### 2.3 All message strings → `StatusBox`

| State | Old | New `StatusBox` |
|---|---|---|
| loading | `Loading…` | `sentiment="busy"` Checking Tailscale… |
| null status | `Unavailable.` | `sentiment="error"` Could not read Tailscale status. |
| `not_installed` | plain text | see 2.4 |
| `starting` | plain text | `sentiment="busy"` Connecting to Tailscale… |
| `not_connected` | `Run tailscale up` text | see 2.5 |
| `needs_operator` | plain text + CopyLinkButton | see 2.6 |
| `certs_not_enabled` | plain text | see 2.7 |
| `connected_no_serve` | "Reachable by all…" | `sentiment="info"` Connected. Serve is not enabled yet. |
| `serve_active` | green dot + URL | `sentiment="ok"` {httpsUrl} with `wordBreak: "break-all"` |
| `port_mismatch` | red text | `sentiment="warn"` Serve points to port {actualPort}, daemon is on {expectedPort}. |
| `error` | red text | `sentiment="error"` {message} |
| card-level error | red text | `sentiment="error"` {error} |

Also apply `StatusBox sentiment="ok"` to the tunnel-active line in `TunnelCard` for visual parity.

### 2.4 `not_installed`

```tsx
<StatusBox sentiment="info">Tailscale isn't installed on this machine.</StatusBox>
<ShellBlock command="curl -fsSL https://tailscale.com/install.sh | sh" lang="bash" />
<a href="https://tailscale.com/download" target="_blank" rel="noreferrer"
   style={{ fontSize: "var(--font-size-xs)", color: "var(--accent)" }}>
  Other install options →
</a>
```
Copy-only (no `actions` prop). Never auto-run a `curl | sh`. Cross-platform URL: `https://tailscale.com/download`.

### 2.5 `not_connected` — copy and Run

```tsx
<StatusBox sentiment="warn">Tailscale is installed but not connected.</StatusBox>
<ShellBlock command="tailscale up" lang="bash" actions={
  <button type="button" className="btn btn--secondary" disabled={upBusy}
          onClick={onRunUp}
          style={{ fontSize: "var(--font-size-xs)", padding: "3px 8px", fontWeight: "normal" }}>
    {upBusy ? "Running…" : "Run"}
  </button>
} />
{upResult && <UpResultBlock result={upResult} />}
```

New state (after line 438):
```tsx
const [tailscaleUpBusy, setTailscaleUpBusy] = useState(false);
const [tailscaleUpResult, setTailscaleUpResult] = useState<TailscaleUpResponse | null>(null);
```

Handler (next to `handleTailscaleEnable`):
```tsx
async function handleTailscaleUp() {
  setTailscaleUpBusy(true); setTailscaleUpResult(null); setTailscaleError(null);
  try {
    const res = await api.runTailscaleUp();
    setTailscaleUpResult(res);
    if (res.exitCode === 0) { setTailscaleUpResult(null); await fetchTailscale(); }
  } catch (err) {
    setTailscaleError(errMessage(err, "Failed to run tailscale up."));
  } finally { setTailscaleUpBusy(false); }
}
```
Map `DESKTOP_ONLY` error code → "Run this from the desktop app." string.

Result rendering (`UpResultBlock`):
1. `exitCode === 0` → nothing (status refetch flips state).
2. `loginUrl` non-null → `<StatusBox sentiment="info">` + "Finish signing in to Tailscale:" + `<a href={loginUrl} target="_blank">` link. NOT rendered as an error.
3. otherwise → `<StatusBox sentiment="error">` + `<pre>` with `stderr.trim() || stdout.trim() || \`tailscale up exited with code ${exitCode}\`` (`maxHeight: 120`, `overflow: auto`, `font-mono`, `font-size-xs`).

Clear `tailscaleUpResult` when `fetchTailscale` produces a state other than `not_connected`.

### 2.6 `needs_operator` — shell block, copy only

```tsx
<StatusBox sentiment="warn">
  Tailscale needs operator permission for this user before it can serve.
</StatusBox>
<ShellBlock command={status.fixCommand} lang="bash" />
```
No Run button — `fixCommand` uses `sudo`. `CopyLinkButton` remains (still used by QR overlay).

### 2.7 `certs_not_enabled`

```tsx
<StatusBox sentiment="warn">
  HTTPS certificates must be enabled for your tailnet in the Tailscale admin console (DNS tab).
</StatusBox>
{status.dnsName && (
  <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", wordBreak: "break-all" }}>
    This machine: <code style={{ fontFamily: "var(--font-mono)" }}>{status.dnsName}</code>
  </div>
)}
<a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer" …>
  Open admin console
</a>
```
Guard `{status.dnsName && …}` — the 409 path in `handleTailscaleEnable` fabricates `{ state: "certs_not_enabled", dnsName: "" }`. Also fix that path to call `void fetchTailscale()` instead of fabricating partial status.

### 2.8 `starting` auto-refetch

Add a single 3-second auto-refetch while `state === "starting"` — without it the spinner is decorative and the user must manually click Refresh:

```tsx
useEffect(() => {
  if (tailscaleStatus?.state !== "starting") return;
  const id = setTimeout(() => void fetchTailscale(), 3000);
  return () => clearTimeout(id);
}, [tailscaleStatus?.state, fetchTailscale]);
```

---

## Phase 3 — Tests

Add to `RemoteAccessSetting.test.tsx` (check it currently passes before adding):
1. Card title renders "Cloudflare", not "Remote".
2. `not_installed` → curl command text present; exactly one button (Copy), no "Run".
3. `not_connected` → clicking "Run" calls `api.runTailscaleUp`; on `exitCode: 0` `getTailscaleStatus` called again.
4. `not_connected` → `loginUrl` result renders an anchor with that href and no error styling.
5. `not_connected` → `exitCode: 1` with stderr renders the stderr text.
6. `needs_operator` → `fixCommand` visible as text; no Run button.
7. `certs_not_enabled` → explanation + `dnsName` render; `dnsName: ""` renders neither "This machine:" nor empty code.
8. "↺ Refresh" present for `not_installed` (proves header button is unconditional); clicking re-calls `getTailscaleStatus`.

---

## Self-Review findings (already addressed in plan above)

- `ShellBlock` is a new sibling to `CodeBlock`, not a wrapper — visual parity via shared CSS, not shared component. Avoids touching the markdown render path.
- `runUp` uses `UP_TIMEOUT_MS = 30_000`, not the module's `TIMEOUT_MS = 15_000`. Argv is `["up", "--timeout=20s"]` — explicitly no `--reset`/`--ssh`.
- `NeedsLogin` path (most common `not_connected` cause) → renders loginUrl as a link, NOT an error.
- `runTailscaleUp` added to both `mock.ts` AND `client.ts` — union type safety.
- `--fg-danger`/`--fg-success`/`--fg-warning` added to `tokens.css` — fixes 5 pre-existing silent bugs.
- `starting` state gets a 3s auto-refetch so spinner is not decorative.
- `fixCommand` hardened to fall back to `os.userInfo().username` when `$USER` is empty.
- `DESKTOP_ONLY` guard on `POST /tailscale/up` mirrors `auth.ts` pattern — other tailscale routes remain unguarded (acceptable for now; flag as follow-up).
- Verify `RemoteAccessSetting.test.tsx` is currently green before adding to it — it may be stale relative to the component.
