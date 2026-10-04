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
| `02-agents-and-modes.png` | Settings → Agents & modes, all four harnesses detected |
| `03-subagents-canvas.png` | Canvas: Claude plans, Antigravity reviews, Deepseek implements |
| `04-remote-access-qr.png` | Settings → Remote Access, pairing a phone with a QR code |
| `05-mobile.png` | Phone: dashboard list and a Rich Chat session |
| `06-markdown-customization.png` | Settings → Markdown with live preview |
| `07-markdown-file-tree.png` | Light-mode workspace: Rich Chat agent with history, file tree, file tabs, rendered `.md` — captured from a running sandbox (`LIVE_URL`), on the dark `dusk` wallpaper |
