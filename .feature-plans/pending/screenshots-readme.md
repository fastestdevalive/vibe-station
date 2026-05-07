# README Screenshots — Demo Container + Playwright

## Goal
Capture 5 polished screenshots for the GitHub README by spinning up a self-contained Docker
container pre-seeded with realistic demo data (3 projects, 9 worktrees, 14 sessions) and
running a Playwright script to capture each view at the right viewport.

---

## Files to create

| File | Purpose |
|---|---|
| `scripts/demo-seed.sh` | Seeds git repos, modes, manifests, worktree checkouts, tmux sessions |
| `Dockerfile.screenshots` | Self-contained image: builds app, installs stub CLIs, runs seed on boot |
| `docker-compose.screenshots.yml` | Exposes port 5174, no host bind-mounts |
| `scripts/take-screenshots.ts` | Playwright script — 5 screenshots, correct viewports |
| `docs/screenshots/` | Output directory for `.png` files |

---

## Demo data

### Stub CLIs (inside image)
`/usr/local/bin/claude` and `/usr/local/bin/cursor-agent` are tiny shell scripts that
just `exec sleep infinity` — they satisfy path-existence checks and show up in the modes
list. Real agent spawning is never triggered because every session is pre-seeded as
`idle`/`working`/`done`.

### Modes (`~/.vibe-station/modes.json`)
```
mode-claude-001  Claude Code   cli=claude
mode-cursor-001  Cursor Agent  cli=cursor
```

### Projects + worktrees

**northstar-api** (prefix `napi`, path `/home/vst/projects/northstar-api`)
| wt id  | branch                    | sessions                             | rollup   |
|--------|---------------------------|--------------------------------------|----------|
| napi-1 | feat/auth-middleware      | m=idle, a1=idle, a2=working          | working  |
| napi-2 | feat/rate-limiting        | m=working                            | working  |
| napi-3 | fix/db-connection-pool    | m=idle                               | idle     |
| napi-4 | feat/webhooks             | m=done                               | done     |

**atlas-dashboard** (prefix `atls`, path `/home/vst/projects/atlas-dashboard`)
| wt id  | branch                    | sessions                             | rollup   |
|--------|---------------------------|--------------------------------------|----------|
| atls-1 | feat/data-visualization   | m=working                            | working  |
| atls-2 | refactor/component-lib    | m=idle                               | idle     |
| atls-3 | feat/export-pipeline      | m=done                               | done     |

**forge-cli** (prefix `frge`, path `/home/vst/projects/forge-cli`)
| wt id  | branch                    | sessions                             | rollup   |
|--------|---------------------------|--------------------------------------|----------|
| frge-1 | feat/plugin-system        | m=working                            | working  |
| frge-2 | docs/api-reference        | m=done                               | done     |

**Dashboard totals:** Working=4, Idle=2, Done=3 — good kanban distribution.

### Session IDs & tmux names
Pattern: session id = `<wt-id>-<slot>`, tmux name = `vr-<prefix>-<num>-<slot>`

Examples for `napi-1`:
- `napi-1-m`  → tmux `vr-napi-1-m`
- `napi-1-a1` → tmux `vr-napi-1-a1`
- `napi-1-a2` → tmux `vr-napi-1-a2`

### Worktree checkout (for file-tree + preview)
`napi-1` gets a full checkout at
`/home/vst/.vibe-station/projects/northstar-api/worktrees/napi-1/`

Realistic tree:
```
src/
  routes/       auth.ts  users.ts  health.ts
  middleware/   authMiddleware.ts  cors.ts  rateLimiter.ts
  db/           pool.ts  migrations/001_users.sql  002_sessions.sql
  models/       User.ts  Session.ts
  utils/        jwt.ts  crypto.ts
  app.ts  server.ts
docs/
  PLAN.md       ← markdown preview target
  API.md
tests/
  auth.test.ts  users.test.ts
package.json  tsconfig.json  .env.example  README.md
```

`docs/PLAN.md` is a rich markdown file describing the auth middleware implementation plan
(checkboxes, headings, code blocks) — looks great in the preview pane.

### Tmux sessions (for terminal screenshots)
Seed script creates these tmux sessions using `tmux new-session -d`:
- `vr-napi-1-m`  — bash loop that cat-s a fake Claude "idle after task" transcript
- `vr-napi-1-a1` — fake Cursor Agent idle transcript  
- `vr-napi-1-a2` — fake Claude "working" transcript (mid-task, trailing `...`)
- All other sessions use `useTmux: false` and state `done` — no tmux needed for dashboard.

---

## Screenshot plan

| # | File | Viewport | URL / action |
|---|------|----------|--------------|
| 1 | `01-dashboard-kanban.png`  | 1440 × 900  | `/` → click kanban toggle → screenshot |
| 2 | `02-dashboard-mobile.png`  | 390 × 844   | `/` → screenshot (list layout auto on mobile) |
| 3 | `03-workspace-tabs.png`    | 1440 × 900  | `/worktree/napi-1` → wait → screenshot (shows tabs: main / agent 1 / agent 2) |
| 4 | `04-file-tree-preview.png` | 1440 × 900  | `/worktree/napi-1` → toggle file-tree → click `docs/PLAN.md` → toggle preview → screenshot |
| 5 | `05-mobile-split.png`      | 390 × 844   | `/worktree/napi-1` → toggle layout to bottom → show preview + terminal → screenshot |

Playwright uses `page.setViewportSize()` for screenshots 2 and 5.

---

## Phase 1 — write seed script + Dockerfile + Playwright script  ☐
- [ ] 1.1 `scripts/demo-seed.sh` — git repos, modes.json, manifests, worktree files, tmux
- [ ] 1.2 `Dockerfile.screenshots` — FROM dev.Dockerfile pattern, add stubs + seed
- [ ] 1.3 `docker-compose.screenshots.yml`
- [ ] 1.4 `scripts/take-screenshots.ts`
- [ ] 1.5 `mkdir -p docs/screenshots`

## Phase 2 — build & start container  ☐
- [ ] 2.1 `docker compose -f docker-compose.screenshots.yml up --build -d`
- [ ] 2.2 Poll `http://localhost:5174` until 200

## Phase 3 — take screenshots  ☐
- [ ] 3.1 `cd web-ui && npx ts-node --esm scripts/take-screenshots.ts`  
      (or `npx playwright test scripts/take-screenshots.ts`)
- [ ] 3.2 Verify all 5 PNGs land in `docs/screenshots/`
- [ ] 3.3 Commit everything to branch `screenshots-may7`

## Phase 4 — stop container  ☐
- [ ] 4.1 `docker compose -f docker-compose.screenshots.yml down`
