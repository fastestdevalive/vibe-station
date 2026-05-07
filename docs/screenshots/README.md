# Screenshots

Source images for the project README, captured from a self-contained demo
container with realistic seed data.

## Regenerate

From the repo root:

```bash
# 1. Boot the demo container (builds vibe-station + seeds 3 projects, 9 worktrees,
#    14 sessions, a populated worktree checkout, and tmux sessions with fake
#    Claude/Cursor transcripts).
docker compose -f docker-compose.screenshots.yml up --build -d

# 2. Install Playwright deps (first time only).
pnpm --filter @vibestation/web install

# 3. Capture all 5 PNGs.
cp scripts/take-screenshots.ts web-ui/_take-screenshots.ts
node --experimental-strip-types --no-warnings web-ui/_take-screenshots.ts
rm web-ui/_take-screenshots.ts

# 4. Tear down.
docker compose -f docker-compose.screenshots.yml down
```

## Files

| File                       | Viewport   | Shows |
|----------------------------|------------|-------|
| `01-dashboard-kanban.png`  | 1440 × 900 | Dashboard kanban — agents across working / idle / finished columns |
| `02-dashboard-mobile.png`  | 390 × 844  | Same data, mobile list layout |
| `03-workspace-tabs.png`    | 1440 × 900 | Workspace with main / agent 1 / agent 2 tabs + live terminal |
| `04-file-tree-preview.png` | 1440 × 900 | Three-pane IDE: terminal · markdown preview · file tree |
| `05-mobile-split.png`      | 390 × 844  | Mobile workspace — preview on top, terminal below |
