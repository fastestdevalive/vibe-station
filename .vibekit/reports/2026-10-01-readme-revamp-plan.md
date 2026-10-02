# README revamp plan

Status: **proposal — nothing implemented yet.** Branch: `developmnts-screenshots-window`.

## Goal

Make `README.md` modern and current with recent development, starting with the screenshots, which are old
and look poor.

## 1. Embedding the website demos — not possible

The website (`~/code/fastestdevalive/vibe-station-website`) demos run the real `web-ui` inline in a React page
on `createMockApi(seed)` with scripted scenes (`src/demo/scenes/m1Dashboard.ts`, `m2Delegate.ts`,
`m3Markdown.ts`). GitHub strips `<script>`, `<iframe>` and `<style>` in READMEs, so a live demo can't
render there. Options for a moving visual:

- Link to the live site demo.
- Optionally record one scene as mp4/GIF for the hero (Playwright's bundled ffmpeg is available). Stretch
  goal, not in the first pass.

## 2. Requirement: screenshots must match the website's DOM demos

Colour, look and feel, density and scaling must match the demos on the website (values taken from the
website's `src/demo/demo.css` and `DemoStage.tsx`):

- **Density / scaling:** the site renders the real app in a fixed **1120×630** (16:9) stage and scales it to
  page width, so UI looks larger/denser than a 1440×900 shot. Capture at a **1120×630 viewport, device
  scale factor ≥ 2**. Phone stage: **390×844**.
- **Colour / theme:** `vibestation-dark`, warm-black window background `#0a0a09`. Show only the real app, no
  extra UI.
- **Window chrome:** 12px radius; `1px solid rgba(255,255,255,.08)` border; shadow
  `0 40px 100px -30px rgba(0,0,0,.9)`. Traffic lights: 12px dots, 6px gap, `#ff5f57` / `#ffbd2e` /
  `#28c840`, overlaid on the app's own top bar (no separate title bar).
- **Phone frame:** black bezel, `#3a3a3d` border, ~46–55px radius, dynamic island and home bar (the `.pf-*`
  rules in the website's `demo.css`).
- **Wallpaper:** dark, neutral gradient behind the window, to suit the site's dark palette.
- Reuse the website's scene seed data where it improves realism; otherwise use the docker demo sandbox
  (needed for views the mock API can't reproduce, e.g. the live terminal).

## 3. Screenshot pipeline

1. Capture raw shots from the docker demo sandbox (`docker-compose.screenshots.yml`, 3 projects / 9
   worktrees / 14 sessions) via `scripts/take-screenshots.ts`, updated to the viewports above.
2. New `scripts/frame-screenshots.ts` composites each capture onto the wallpaper in an HTML page (rounded
   window, traffic lights, shadow) and screenshots that page with Playwright. No ImageMagick needed.
3. Update `docs/screenshots/README.md` with the new regeneration steps; delete the old 8 PNGs once replaced.

Planned shots:

| # | Shot | Replaces |
|---|---|---|
| 01 | Dashboard kanban | `01-dashboard-kanban.png` |
| 02 | Workspace: agent tabs, terminal, file tree, preview | `03`, `04` |
| 03 | Rich Chat with tool calls and thinking blocks | new |
| 04 | Subagents on the canvas | new |
| 05 | Mobile dashboard + workspace, side by side in phone frames | `02`, `05` |
| 06 | Settings → Remote Access (QR) | new |

## 4. Proposed README changes

1. **Header / hero:** centered logo (`docs/brand`), tagline, existing badges, nav links (Download · Docs ·
   Website · Quick start), a one-line curl install, and the new framed dashboard as the hero image. The
   installer exists (`scripts/install.sh`) but there are no published releases yet — say so.
2. **"Why vibe-station":** feature grid replacing the bullet list, each feature paired with a screenshot
   (parallel agents on isolated worktrees, Rich Chat, subagents and agent-to-agent messaging, code reader
   and diffs, mobile access, desktop/browser/CLI). Check the website's current copy first for wording.
3. **Download / install:** rewrite against `scripts/install.sh` and `.github/workflows/release.yml` (curl
   installer; Linux AppImage/.deb; macOS CLI via installer, .dmg manual). Keep the "no releases yet" caveat
   until one is published.
4. **Quick start:** reorder around the shortest path — install → `vst daemon start` → add project → create
   mode → create worktree → open UI.
5. **Screenshots** placed where each feature is explained; drop the "desktop screenshots are pending" note.
6. **Stale content to fix** (this branch's daemon is Rust):
   - Repo layout still lists `cli/` and `daemon/` (Fastify) → replace with `rust/vst-*` crates, `web-ui/`,
     `desktop/`.
   - Verify the Development section (`pnpm build`, `pnpm link`) against the Rust build before rewriting.
   - "Node bundled in" sidecar wording → merged Rust `vst` binary.
   - Auth section: reflect exact-origin policy, loopback bind by default, always-authenticate, live
     network-access toggle.
   - Add a link to `docs/RICH-CHAT-ACP.md`.
7. **Trim:** move the long CLI reference and concepts sections into collapsible `<details>` blocks or link to
   `docs/`.
8. **Keep:** Architecture mermaid (correct the Node/Fastify wording), Troubleshooting, Project-specific agent
   rules.

## 5. Open questions

- Wallpaper: generated dark gradient, or a specific image?
- Include an animated clip (mp4/GIF) of the website's Dashboard scene in the hero?
- README tone: keep as is, or punchier like the site's "Vibe code in parallel. Ship at scale."?

## 6. Next steps

Confirm the open questions → build the framing script → capture the shots → rewrite the README → Opus
subagent reviews the README for accuracy against the code.

## 7. Outcome and review notes (2026-10-01)

Opus review corrections, and what was done:

- Docker screenshots image is stale (`Dockerfile.screenshots` copies a non-existent root `Cargo.toml` and a `vst-cli` binary; token login unhandled by `take-screenshots.ts`) → **not used**. Shots come from the website demos instead, which gives an exact style match.
- `fitScale` max is 1 (never scales up) → the "larger" density comes from the 1120×630 stage; the script captures at DSF 2.04 (~2240px).
- README dev commands corrected: `pnpm build:rust` for the `vst` binary, `pnpm build` is the desktop bundle, no `pnpm link`, no `cli/`/`daemon/`, `--channel=tmux|json` (not `--json`).
- Implemented: `scripts/capture-readme-screenshots.mjs`, six new framed images in `docs/screenshots/`, old 8 PNGs removed, README rewritten.
- Not done: workspace three-pane / file-tree shot (the website demos don't cover it) and an animated hero clip. `scripts/take-screenshots*.ts`, `Dockerfile.screenshots` and `docker-compose.screenshots.yml` are now unused by the README and could be removed in a follow-up.
