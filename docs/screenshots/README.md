# Screenshots

README images: the real web UI inside a macOS-style window (traffic lights, 12px corners, shadow) on a
gradient wallpaper. They are **generated**, not hand-captured.

## Why they come from the website demos

Look, density and scaling must match the DOM demos on the marketing site
(`vibe-station-website`, `src/demo/`): the app rendered in a fixed **1120×630** stage (phone: 289×607 shell
of a 390×844 screen) with the site's seed data, `vibestation-dark` theme, and traffic lights overlaid on the
app's own top bar. The script drives those demos headlessly, grabs frames at known scene times, and frames them
with the site's window chrome (`border-radius:12px`, `1px solid rgba(255,255,255,.08)`,
`box-shadow:0 40px 100px -30px rgba(0,0,0,.9)`).

## Regenerate

```bash
# 1. Run the website dev server (separate repo: vibe-station-website)
cd ../vibe-station-website && npm run dev -- --port 5391

# 2. From this repo's root (needs Playwright + a Chromium; see env vars in the script header)
SITE_URL=http://localhost:5391 node scripts/capture-readme-screenshots.mjs
```

`07` is the one image that is *not* from the website demos: it drives the real web-ui on a running dev sandbox seeded
with the demo dataset (`LIVE_URL=http://localhost:<port>`, `worktree napi-1`), forces `vibestation-light` for that
browser only (the chat history is scripted in the capture script and fed to that browser over a proxied WebSocket;
the sandbox itself is never modified), and frames it with the traffic lights overlaid on the app's own top bar (next to the sidebar toggle, like the dark shots) on the dark `dusk` wallpaper. Use `ONLY=07-markdown-file-tree.png`
to produce just it (no website server needed).

`WALLPAPER` picks a preset (default `mist`), `SHOTS_OUT_DIR` redirects output, `PLAYWRIGHT_MODULE` points at a Playwright install (default `@playwright/test`), `CHROMIUM_PATH` at a browser
binary, `KEEP_RAW=1` keeps the unframed captures in `/tmp/vst-readme-raw`, and `REFRAME_ONLY=1` re-composites
them without recapturing. Scene times and the wallpaper live at the top of the script.

## Files

| File | Shows |
|---|---|
| `01-dashboard.png` | Dashboard board — working / needs you / idle / PR created |
| `02-agents-and-modes.png` | Settings → Harnesses and modes, all four harnesses detected |
| `03-subagents-canvas.png` | Canvas: Claude plans, Antigravity reviews, Deepseek implements |
| `04-remote-access-qr.png` | Settings → Remote Access, pairing a phone with a QR code |
| `05-mobile.png` | Phone: dashboard list and a Rich Chat session |
| `06-markdown-customization.png` | Settings → Markdown with live preview |
| `07-markdown-file-tree.png` | Light-mode workspace: Rich Chat agent with history, file tree, file tabs, rendered `.md` — captured from a running sandbox (`LIVE_URL`), on the dark `dusk` wallpaper |

## Mobile app screenshots

`mobile/*.jpg` (README § Mobile apps) are real captures of the Android app (`vibe-station-mobile`, debug build) on a
Pixel 7 emulator (1080x2400, API 36), framed by `scripts/mobile-screenshots.py` in the same visual language as the
desktop shots: the `dusk` wallpaper (the same gradients as the capture script, ported to Python), the phone screen in a
thin dark device with rounded corners, and the desktop's two-layer shadow. Every image is a 720x1380 JPEG of about 100 KB.

| File | Shows |
|---|---|
| `mobile/01-home-widgets.jpg` | Home screen (light): Pinned agents, Needs you, Plan limits, Single project widgets |
| `mobile/02-home-widgets-dark.jpg` | Home screen (dark): Server status, Single worktree, two Single agent, Needs you widgets |
| `mobile/03-dashboard.jpg` | Dashboard in demo mode: needs you / working / PR / idle |
| `mobile/04-rich-chat.jpg` | Rich Chat on the demo `fix-login` agent |
| `mobile/05-review-diff.jpg` | Review → Changes → `auth.rs` diff (Wrap) |
| `mobile/06-terminal.jpg` | Worktree terminal |

Regenerate:

1. Emulator: a fresh Pixel 7 AVD with a Google Play image, on its own port. Never pair the app to a real server.
2. Wallpaper: `python scripts/mobile-screenshots.py wallpaper dusk-phone.png`, push it and set it from Photos
   ("Set as wallpaper"). Remove the default home screen icons.
3. Widget data: the debug build renders fixture snapshots on the real widgets. Write the fixture with
   `python scripts/mobile-widget-fixture.py <mobile checkout>/androidApp/src/debug/assets/widget-fixtures/readme.json`,
   build `:androidApp:assembleDebug`, install, then
   `adb shell am broadcast -a com.vst.mobile.debug.WIDGET_FIXTURE -n ai.vibestation.mobile/com.vst.mobile.WidgetFixtureReceiver --es name readme`
   (repeat right before each capture so the "as of" time is current).
4. Widgets: add them from the launcher's widget picker in the order above (the launcher fills free cells in order;
   page 1 under the date, page 2 below it). Capture page 1 with `cmd uimode night no` and page 2 with `night yes`.
5. App screens: onboarding with the Dark theme, then **Try demo**. For `06`, the demo shell's placeholder output was
   swapped for a test-run transcript in a local, uncommitted edit of `DemoScripts.kt` (`TERMINAL_SCRIPT`).
6. Status bar: SystemUI demo mode (`settings put global sysui_demo_allowed 1`, then `com.android.systemui.demo`
   broadcasts for `clock`, `battery`, `network`, `notifications`), with the clock set to the device time.
7. Capture each screen with `adb exec-out screencap -p > raw/<name>.png` using the names in `SHOTS` at the top of the
   script (`widgets-light`, `widgets-dark`, `dashboard`, `rich-chat`, `review`, `terminal`), then
   `python scripts/mobile-screenshots.py frame raw/` (Pillow + numpy, e.g. in a venv) writes `mobile/*.jpg`.

## Release-notes screenshots

`docs/screenshots/release/<tag>/*.png` are the small framed crops embedded in a release's notes (see
`docs/RELEASE-NOTES.md`). They are generated by `scripts/capture-release-screenshots.mjs` from the real web-ui on a dev
sandbox (demo dataset): the app renders in the same 1440x810 viewport as the `07` shot and is composed at the 1120x630
stage scale, so type and density match the README and website images. The frame is the website's small-feature
"mini window" (square 1px hairline, three-dot bar with a dim mono title, L-shaped corner marks) on `#0a0a09`.
Chat history, the limits snapshot, extra modes, a superseded session and the artifacts list are injected for the
capture browser only; the review-comment shots create real comments in the sandbox through the UI and delete them
afterwards, so always point `LIVE_URL` at a throwaway sandbox.

```bash
scripts/dev-sandbox.sh up <name> --port=71NN          # then finish onboarding once: POST /api/oobe/step1 + /api/oobe/complete
LIVE_URL=http://localhost:71NN RELEASE=v0.0.4-beta node scripts/capture-release-screenshots.mjs
```
