<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Install web-ui as an app (PWA installability)

> Make Vibe Station's web-ui installable via Chrome's "Install app" flow on Desktop and Android — manifest + icons only, no offline/service-worker.

**Issue:** pwa-install
**Branch:** `current-browser-behaves` (current worktree branch)
**Status:** Implement complete — awaiting verify/review (chain scope was `plan+implement`)
**PRD:** none — small, single-screen-scope change, PRD skipped per user request (`/sdlc plan-implement`)
**Parent:** none

**Reference files:**
- Manifest: `web-ui/public/manifest.webmanifest` (new)
- Icons: `web-ui/public/icons/*.png` (new), source `web-ui/public/logo.svg`
- Flattened icon source: `web-ui/assets-src/icon-source-flat.svg` (new — kept outside `publicDir` so it is never copied into `dist/`)
- Entry HTML: `web-ui/index.html`
- Theme tokens: `web-ui/src/styles/tokens.css:61-118`
- Docs: repo-root `README.md` (new section)

---

## Problem

- Chrome shows no "Install app" affordance (omnibox icon, 3-dot menu "Install Vibe Station…") for web-ui today — there's no `<link rel="manifest">`, no `manifest.webmanifest`, no icon set sized for install
- Users who run web-ui as their daily driver (desktop Chrome, or Android Chrome over Tailscale) have no way to get an app-like window / home-screen icon

## Out of Scope

- Service worker / offline caching — deferred to a future iteration (see Decision 1: Chrome no longer requires one for the install prompt)
- Safari/iOS "Add to Home Screen" beyond the minimal `apple-touch-icon` + meta tags (Safari has no `beforeinstallprompt`, no scriptable install flow — out of scope to chase further)
- Fixing the underlying secure-context blocker for Tailscale/LAN access — that's an operator/deployment concern, addressed by a documented `tailscale serve` recipe, not app code
- Any daemon-side change — this is a static-asset + `index.html` change only, `daemon/src` is untouched

## Concept

- Add a web app manifest + properly-sized icons so Chrome's installability criteria are met
- Add manifest link + theme-color + Safari meta tags to `index.html`
- Document the secure-context requirement and the `tailscale serve` HTTPS workaround for remote install
- Success state: on `http://localhost:5173` (or any HTTPS/`tailscale serve` origin), Chrome desktop shows the omnibox install icon and 3-dot "Install Vibe Station…"; Chrome Android shows "Add to Home screen" / "Install app" with a WebAPK, launching in a standalone window with the Vibe Station icon

## Requirements

| # | Requirement |
|---|-------------|
| 1 | `manifest.webmanifest` served at `/manifest.webmanifest` as `application/manifest+json` (or `application/json`) with valid JSON — not swallowed by any SPA fallback |
| 2 | Manifest includes `name`, `short_name`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, `theme_color`, `background_color`, and `icons` with 192×192 + 512×512 `purpose: "any"` PNGs plus a separate 512×512 `purpose: "maskable"` PNG |
| 3 | `index.html` links the manifest and sets a matching `<meta name="theme-color">` |
| 4 | Icons are flattened to a single fixed color scheme (the SVG source's `@media (prefers-color-scheme: dark)` branch selection is undefined under a plain rasterizer — must not depend on it) |
| 5 | Maskable icon artwork sits within the inner 80% safe zone with an opaque background fill (not transparent) so Android's circular/squircle mask doesn't clip the mark |
| 6 | No new build tooling — plain static files, works identically under `vite dev` and `vite build`/`vite preview` |
| 7 | Secure-context requirement (HTTPS or `localhost`) for install is documented, including the `tailscale serve` recipe for remote-device install |

---

## Research

### No existing manifest / SW / PWA tooling

- **File:** `web-ui/package.json` — no `vite-plugin-pwa` or similar dependency
- **File:** `web-ui/public/` — only contains `logo.svg`
- **File:** `web-ui/index.html:1-24` — no `<link rel="manifest">`, no theme-color meta
- **Risk:** LOW — greenfield, no conflicting config to migrate

### Logo SVG uses `prefers-color-scheme`, branch selection under rasterization is undefined

- **File:** `web-ui/public/logo.svg:1-21` — `.stroke`/`.fill` classes swap between `#0e0e10` (light mode) and `#f5f5f5` (dark mode) via `@media (prefers-color-scheme: dark)`
- **Trigger:** the only rasterizer available in this environment is ImageMagick `convert` (no `rsvg-convert`/`inkscape`/`sharp`). Verified empirically: ImageMagick 6.9.12's MSVG renderer does correctly apply the CSS class rules (not literally broken), but which `@media` branch it resolves is unspecified/environment-dependent — do not depend on it picking dark mode
- **Risk:** MEDIUM — produce a flattened, single-color-scheme copy of the SVG with hardcoded presentation attributes (no `<style>`/`@media`) before rasterizing, so the output color is deterministic regardless of renderer/environment

### App default theme is dark

- **File:** `web-ui/index.html:2` — `<html data-theme="dark">` is the default/shipped theme
- **File:** `web-ui/src/styles/tokens.css:61-66` (root fallback) and `:73-85` (`[data-theme="dark"]`) — `--bg-primary: #0f0f0f`
- **Decision driver:** flatten the icon to the dark-mode color pairing (`#f5f5f5` mark on `#0f0f0f` field) to match the app's default shipped look

### Vite serves `public/` files as real static assets, not SPA-fallback HTML

- **File:** `web-ui/vite.config.ts:1-33` — no custom `historyApiFallback`/middleware; Vite's built-in dev server serves an existing file under `public/` directly (200, correct `Content-Type`) and only falls back to `index.html` for paths with no matching file
- **Risk:** LOW, but must be verified at implementation time (`curl -i http://localhost:5173/manifest.webmanifest`) — this is the exact footgun called out in the plan requirements, confirming it isn't silently broken is a required verification step, not a research assumption

### No production static-file server for `web-ui/dist` exists today

- **File:** `daemon/src/server.ts` — Fastify registers no static-file plugin; nothing in `daemon/src` serves `web-ui/dist`
- **File:** `cli/src/commands/open.ts:10` — points at `VST_UI_URL ?? "http://localhost:5173"`, i.e. today the daemon/CLI always point users at the Vite dev server, not a built bundle
- **Risk:** LOW for this plan — Phase 3's `npm run build` + `npm run preview` verification is still valid (confirms `dist/` output is correct and installable), but the API Contracts section must not imply a prod server already exists

### App is a client-routed SPA (react-router `BrowserRouter`)

- **File:** `web-ui/src/main.tsx:12-18` — `<BrowserRouter>` wraps `<App />`
- **File:** `web-ui/src/App.tsx` — routes under `/` (login vs workspace, gated by `useAuth()`)
- **Risk:** LOW — `start_url: "/"` + `scope: "/"` covers the whole app; no HashRouter conflict

### Secure-context requirement (from research, see Key Decisions)

- Chrome requires a secure context (`https:`, or `localhost`/`127.0.0.1`/`*.localhost`) for `beforeinstallprompt`/install — a raw Tailscale/LAN IP (`http://100.x.x.x:5173`) will not show the install affordance
- `tailscale cert <host>.<tailnet>.ts.net` + `tailscale serve --https=443 http://127.0.0.1:5173` is the documented workaround (terminates real TLS, no per-device Chrome flags needed)
- **Risk:** HIGH impact if undocumented (users will file "install doesn't work" bugs when accessing over Tailscale IP) — mitigated by Requirement 7 / Phase 3 docs

## Root Cause

- web-ui has simply never had PWA manifest/icon assets added — this is new capability, not a regression

---

## Architecture Diagram

- Single-module, static-asset-only change — no diagram required (browser reads `index.html` → fetches `manifest.webmanifest` + icon files, no new runtime code path)

---

## Design Details

### System Boundaries

- No boundary crossed — pure static frontend assets, no daemon/API change. One line per FORMAT.md: not applicable.

### Critical User Journeys (CUJs)

#### CUJ 1 — Install on Chrome Desktop (happy path)

```
User opens http://localhost:5173 in Chrome desktop
  → Chrome evaluates installability criteria (secure context + valid manifest + 192/512 icons)
  → Omnibox shows the install icon; 3-dot menu shows "Install Vibe Station…"
  → User clicks install
  → Chrome opens Vibe Station in a standalone app window, using the 512×512 "any" icon
```

- **Error path:** user accesses via `http://100.x.x.x:5173` (Tailscale IP, no TLS) → not a secure context → no install icon appears, no error dialog (Chrome silently withholds the affordance) — this is the documented, expected blocker (Requirement 7)

#### CUJ 2 — Install on Chrome Android

```
User opens the site over an HTTPS origin (e.g. tailscale-serve URL) in Chrome Android
  → Chrome evaluates installability criteria
  → "Add to Home screen" / "Install app" banner or menu item appears
  → User taps install
  → Chrome/Play Services mints a WebAPK using the maskable icon (clipped to Android's mask shape)
  → Home-screen icon launches the app in standalone mode, start_url "/"
```

- **Edge case:** if only `purpose: "any"` icons existed (no maskable), Android would letterbox/circle-crop the flat icon awkwardly — mitigated by shipping a dedicated maskable icon (Requirement 5)

### Data Model

- No persisted entities — static manifest file only. Not applicable.

### API Contracts

- No new HTTP endpoints. `GET /manifest.webmanifest` and `GET /icons/*.png` are static files served by Vite dev server's `publicDir` handling — same mechanism as the existing `GET /logo.svg` today, not a new contract
- No production static server for `web-ui/dist` exists yet (see Research) — this plan verifies the built output via `vite preview` only; wiring a real prod server is out of scope

### Key Decisions

#### Decision 1: No service worker in this iteration

- **Decision:** ship manifest + icons only; no `vite-plugin-pwa`, no Workbox, no SW registration
- **Rationale:** Chrome dropped the SW-with-fetch-handler requirement for installability (Chrome 108 Android / 112 desktop, confirmed) — manifest + secure context is sufficient for `beforeinstallprompt` and the install UI. Adding a SW pulls in caching-strategy decisions (must not cache authenticated `/api`/`/ws` responses — see `daemon/src/server.ts:81-116` cookie auth) that are unnecessary for pure installability and better scoped as a separate feature.
- **Where:** N/A — no `web-ui/src/main.tsx` SW registration call is added; `web-ui/package.json` gets no new PWA-tooling dependency (this decision is verified by absence, not by a file diff)

#### Decision 2: Flatten the maskable/any icons to the dark theme's color pairing, generated with ImageMagick

- **Decision:** create `web-ui/assets-src/icon-source-flat.svg` (a copy of `logo.svg` with the `<style>`/`@media` block removed, colors hardcoded to `#f5f5f5` as inline `stroke`/`fill` attributes — content given verbatim in Phase 1.1), then rasterize each size with `convert -background "#0f0f0f" -resize NxN icon-source-flat.svg -alpha remove -alpha off icon-NxN.png`; for the maskable icon, composite the mark at ~360×360 (safely inside the 512×512 canvas's 80%-diameter circular safe zone) onto an opaque `#0f0f0f` background
- **Rationale:** the source SVG's `@media` branch resolution is renderer/environment-dependent (see Research) — flattening to fixed presentation attributes makes the output deterministic. The background must be set on the *rendered SVG sub-image* (inside the `\( ... \)` group), not only on the outer canvas, or ImageMagick's default white SVG background shows through as a visible white square around the mark — confirmed by direct testing.
- **Where:** `web-ui/assets-src/icon-source-flat.svg` (new — kept outside `web-ui/public/` so Vite's `publicDir` copy never ships it to `dist/`) — see Phase 1

```bash
# Maskable icon: pad artwork well inside Android's circular safe zone (80% of the
# 512px diameter ≈ 410px, but the safe zone is a CIRCLE — a square placed at 410x410
# clips at the corners, so size the artwork down to ~360x360 for headroom).
# -background none INSIDE the \( \) group is required: it sets the background of the
# rendered SVG sub-image before compositing. Without it, ImageMagick's default white
# SVG background shows through as a visible white square behind the mark.
convert -size 512x512 xc:"#0f0f0f" \
  \( -background none icon-source-flat.svg -resize 360x360 \) \
  -gravity center -composite -alpha remove -alpha off \
  icon-512-maskable.png
```

#### Decision 3: `theme_color`/`background_color` = `#0f0f0f` (app's default dark `--bg-primary`)

- **Decision:** use `#0f0f0f` for both manifest fields and the `<meta name="theme-color">` tag
- **Rationale:** matches `web-ui/index.html:2`'s shipped default (`data-theme="dark"`) and `tokens.css:77` `--bg-primary` — avoids a flash of mismatched color on the splash/status-bar chrome
- **Where:** `web-ui/public/manifest.webmanifest`, `web-ui/index.html`

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Will Android manual verification actually happen in this environment?** | No physical/emulated Android device or `tailscale serve` HTTPS endpoint is set up in this worktree/session — Phase 3 verification covers desktop Chrome directly; Android install (3.T3) is a documented manual follow-up for the user. Not a blocker to shipping the code. |
| 2 | **Should light-mode users get a light-themed icon?** | Out of scope for v1 — a single flattened dark-themed icon (matching the app's default) is simpler; `icon-source-flat.svg` is kept in the repo so a light variant can be derived later. |
| 3 | **`vite build` output — does the `public/` copy work?** | Standard Vite behavior (`publicDir` defaults to `public/`, copied verbatim into `dist/` root); no custom override exists (`web-ui/vite.config.ts:1-33`) — confirmed directly in Phase 3.1 via `diff -r`. |

---

## Implementation Phases

- Each phase ends with a **verification block** — the phase is not complete until those tests pass
- Screenshots: none planned for this phase (no UI-visual verification needed beyond DevTools panel + icon file inspection)

---

### Phase 1 — Icons

- [x] **1.0** `mkdir -p web-ui/assets-src web-ui/public/icons` — neither directory exists yet; `convert` fails with "unable to open image" if the target dir is missing
- [x] **1.1** Create `web-ui/assets-src/icon-source-flat.svg` with exactly this content (flattened, no `<style>`/`@media`, colors hardcoded to `#f5f5f5`):
  ```xml
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
    <g stroke="#f5f5f5" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 32 H28 L38 18 H50"/>
      <path d="M20 32 H56"/>
      <path d="M20 32 H28 L38 46 H50"/>
    </g>
    <g fill="#f5f5f5">
      <circle cx="14" cy="32" r="6"/>
      <circle cx="50" cy="18" r="3.5"/>
      <circle cx="56" cy="32" r="3.5"/>
      <circle cx="50" cy="46" r="3.5"/>
    </g>
  </svg>
  ```
- [x] **1.2** Generate `web-ui/public/icons/icon-192.png` — 192×192, `#0f0f0f` background, `purpose: any`:
  ```bash
  convert -background "#0f0f0f" -resize 192x192 web-ui/assets-src/icon-source-flat.svg \
    -alpha remove -alpha off -colorspace sRGB -depth 8 web-ui/public/icons/icon-192.png
  ```
- [x] **1.3** Generate `web-ui/public/icons/icon-512.png` — 512×512, `#0f0f0f` background, `purpose: any`:
  ```bash
  convert -background "#0f0f0f" -resize 512x512 web-ui/assets-src/icon-source-flat.svg \
    -alpha remove -alpha off -colorspace sRGB -depth 8 web-ui/public/icons/icon-512.png
  ```
- [x] **1.4** Generate `web-ui/public/icons/icon-512-maskable.png` — 512×512, `#0f0f0f` background, artwork scaled to 360×360 (well inside the 80%-diameter circular safe zone — see Decision 2 for why 410 is too tight), `purpose: maskable`:
  ```bash
  convert -size 512x512 xc:"#0f0f0f" \
    \( -background none web-ui/assets-src/icon-source-flat.svg -resize 360x360 \) \
    -gravity center -composite -alpha remove -alpha off -colorspace sRGB -depth 8 \
    web-ui/public/icons/icon-512-maskable.png
  ```
- [x] **1.5** Generate `web-ui/public/icons/apple-touch-icon.png` — 180×180, `#0f0f0f` background (no alpha — iOS renders transparency as black):
  ```bash
  convert -background "#0f0f0f" -resize 180x180 web-ui/assets-src/icon-source-flat.svg \
    -alpha remove -alpha off -colorspace sRGB -depth 8 web-ui/public/icons/apple-touch-icon.png
  ```

**Verify phase 1:**
- [x] **1.T1** Manual — `identify web-ui/public/icons/*.png` confirms exact dimensions (192×192, 512×512 ×2, 180×180) and no alpha channel (not `graya`/`srgba`); `convert <file> -format %c histogram:info:- | sort -rn | head -1` on each confirms `#0f0f0f` (or its RGB equivalent) is the dominant/background color, not a stray white square
- [x] **1.T2** Manual — visually confirm the maskable icon's mark stays inside a circle inscribed in the 512×512 canvas (simulate Android's circular mask) — open `icon-512-maskable.png` and check the dot at `cx="56"` maps well inside the circle after the 360/64 scale-and-center transform

---

### Phase 2 — Manifest + HTML wiring

- [x] **2.1** Create `web-ui/public/manifest.webmanifest`:
  ```json
  {
    "id": "/",
    "name": "Vibe Station",
    "short_name": "Vibe Station",
    "description": "Manage coding agent sessions across worktrees.",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "theme_color": "#0f0f0f",
    "background_color": "#0f0f0f",
    "icons": [
      { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
      { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
      { "src": "/icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
    ]
  }
  ```
- [x] **2.2** `web-ui/index.html:11` (after the existing `<link rel="icon">`) — add:
  ```html
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="theme-color" content="#0f0f0f" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Vibe Station" />
  ```

**Verify phase 2:**
- [x] **2.T1** Integration — `curl -i http://localhost:5173/manifest.webmanifest` (with `vite dev` running): 200 status, `Content-Type` containing `json`, body is the exact JSON from 2.1 (confirms Vite serves it as a real static file, not the SPA `index.html` fallback)
- [x] **2.T2** Integration — `curl -s http://localhost:5173/manifest.webmanifest | python3 -m json.tool` succeeds (valid JSON, no parse error)
- [x] **2.T3** Regression — `curl -i http://localhost:5173/` still returns the app shell (`index.html`) unaffected by the new `<link>`/`<meta>` tags

---

### Phase 3 — Build verification + docs

- [x] **3.1** `cd web-ui && npm run build` succeeds; verify parity with `diff -r web-ui/public/icons web-ui/dist/icons` (expect no output) and `diff web-ui/public/manifest.webmanifest web-ui/dist/manifest.webmanifest` (expect no output)
- [x] **3.2** `cd web-ui && npm run preview` — note Vite's default preview port is **4173**, not 5173 — then re-run 2.T1/2.T2 against `http://localhost:4173/manifest.webmanifest` to confirm prod-build parity
- [x] **3.3 — N/A, documented reason:** the `claude-in-chrome` browser-automation tool used this session runs a Chrome instance in a separate network namespace from this worktree's shell — it loaded `https://example.com` successfully but got `chrome-error://chromewebdata/` (connection error) navigating to `http://localhost:4199` (the running `vite preview` server), and the same for `:5199` (dev). No Chrome DevTools access to the actual running server was possible from this session. Static verification was done instead: manifest JSON validated (2.T2/3.2), icon files inspected byte-level (1.T1), `dist/` parity confirmed (3.1) — these cover everything DevTools' Manifest panel would statically check. The live "installability checklist green" check itself is left for the user.
- [x] **3.4** Add an "Installing as an app" section to the repo-root `README.md` covering: install works out of the box on `localhost`; Tailscale/LAN HTTP access does **not** show the install option (secure-context requirement); the `tailscale cert <host>.<tailnet>.ts.net` + `tailscale serve --https=443 http://127.0.0.1:5173` recipe for installing from another device

**Verify phase 3:**
- [ ] **3.T1 — N/A this session, same reason as 3.3.** User follow-up: open `http://localhost:5173` (dev) or `http://localhost:4173` (`vite preview`) in desktop Chrome directly (not through browser automation), confirm the omnibox install icon appears, install, and confirm a standalone window opens with the correct icon and title "Vibe Station"
- [ ] **3.T2 — N/A this session, same reason as 3.3.** User follow-up: confirm `http://<tailscale-ip>:5173` shows **no** install icon (confirms the documented blocker is real, not accidentally worked around)
- [ ] **3.T3** Manual (user follow-up, deferred past this session) — Chrome Android install via the documented `tailscale serve` HTTPS URL; confirm WebAPK installs with correct maskable icon and standalone launch

---

## Files & Phase Impact

| File | Status | Phase | Description / Contract Change |
|------|--------|-------|-------------------------------|
| `web-ui/assets-src/icon-source-flat.svg` | **New** | 1.1 | Flattened (non-media-query) copy of `logo.svg`, dark-theme colors hardcoded; source for rasterization only, outside `publicDir` so it's never shipped to `dist/` |
| `web-ui/public/icons/icon-192.png` | **New** | 1.2 | 192×192 install icon, `purpose: any` |
| `web-ui/public/icons/icon-512.png` | **New** | 1.3 | 512×512 install icon, `purpose: any` |
| `web-ui/public/icons/icon-512-maskable.png` | **New** | 1.4 | 512×512 maskable icon, 80% safe-zone artwork |
| `web-ui/public/icons/apple-touch-icon.png` | **New** | 1.5 | 180×180 opaque icon for Safari/iOS home screen |
| `web-ui/public/manifest.webmanifest` | **New** | 2.1 | Web app manifest — name/icons/display/theme served at `/manifest.webmanifest` |
| `web-ui/index.html` | **Modified** | 2.2 | Add manifest link, theme-color meta, apple-touch-icon + apple-mobile-web-app-* meta tags |
| `README.md` | **Modified** | 3.4 | "Installing as an app" docs section — secure-context requirement + `tailscale serve` recipe |

