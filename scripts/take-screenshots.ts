/**
 * Captures the 5 README screenshots from the demo container.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.screenshots.yml up --build -d
 *   (and `pnpm --filter @vibestation/web install` so playwright is available)
 *
 * Run:
 *   node --experimental-strip-types scripts/take-screenshots.ts
 *   # or:
 *   pnpm --filter @vibestation/web exec node --experimental-strip-types ../scripts/take-screenshots.ts
 *
 * Output:
 *   docs/screenshots/01..05*.png
 */

import { chromium, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "docs", "screenshots");
const BASE = process.env.SCREENSHOTS_URL ?? "http://localhost:5174";

const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;

async function waitForApp(page: Page): Promise<void> {
  // Vite + the workspace bundle take a beat on first load.
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  // Wait for webfonts so markdown text doesn't render as invisible glyphs
  // before the mono/sans face is ready.
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(800);
}

/**
 * Pre-seed the persisted Zustand store before navigation so the workspace
 * boots straight into the layout we want — much more robust than clicking
 * through the UI on mobile, where toggle buttons can be off-screen and tree
 * rows can be matched by selectors that pick up breadcrumb text.
 */
async function presetWorkspaceLayout(
  ctx: import("@playwright/test").BrowserContext,
  layout: {
    terminalPosition: "left" | "bottom";
    paneCollapsed: [boolean, boolean, boolean];
    activeWorktreeId: string;
    activeSessionId: string;
    activeFilePath: string | null;
  },
): Promise<void> {
  const persisted = {
    state: {
      layoutByWorktree: {
        [layout.activeWorktreeId]: {
          terminalPosition: layout.terminalPosition,
          paneCollapsed: layout.paneCollapsed,
        },
      },
      activeProjectId: "northstar-api",
      activeWorktreeId: layout.activeWorktreeId,
      activeSessionId: layout.activeSessionId,
      activeFilePath: layout.activeFilePath,
      lastFileByWorktree: layout.activeFilePath
        ? { [layout.activeWorktreeId]: layout.activeFilePath }
        : {},
      fileScrollByKey: {},
      showDotFiles: false,
      sessionStates: {},
      lastSessionByWorktree: { [layout.activeWorktreeId]: layout.activeSessionId },
      diffScopeByWorktree: {},
      previewFontScale: 1, // 0 = invisible text! defaults are 1
      terminalFontScale: 1,
      leftSidebarCollapsed: false,
      hideInactiveWorktrees: false,
    },
    version: 4,
  };
  await ctx.addInitScript((payload) => {
    window.localStorage.setItem("vibestation:workspace", payload);
  }, JSON.stringify(persisted));
}

async function dismissTransient(page: Page): Promise<void> {
  // Press Escape a few times — closes QuickOpen, ConfirmDialog, modal panes,
  // and any other portal-rendered overlay that listens for Escape.
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(80);
  }
  // Defensive: if an overlay is still up, click outside the card to dismiss
  // (Dialog.tsx closes on overlay click).
  const overlay = page.locator(".dialog-overlay").first();
  if (await overlay.isVisible().catch(() => false)) {
    const box = await overlay.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + 5, box.y + 5).catch(() => {});
      await page.waitForTimeout(120);
    }
  }
}

async function shoot(page: Page, file: string): Promise<void> {
  const out = join(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`  → ${out}`);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  // ── 1. Dashboard kanban (desktop) ────────────────────────────────────────
  console.log("01: dashboard kanban (desktop)");
  {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await waitForApp(page);
    await dismissTransient(page);

    // Toggle kanban (button shown only on desktop, default is list).
    const kanbanBtn = page.locator('button[aria-label="Switch to kanban layout"]');
    if (await kanbanBtn.isVisible().catch(() => false)) {
      await kanbanBtn.click();
      await page.waitForTimeout(400);
    }
    await shoot(page, "01-dashboard-kanban.png");
    await ctx.close();
  }

  // ── 2. Dashboard mobile ─────────────────────────────────────────────────
  console.log("02: dashboard mobile");
  {
    const ctx = await browser.newContext({ viewport: MOBILE, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await waitForApp(page);
    await dismissTransient(page);
    await shoot(page, "02-dashboard-mobile.png");
    await ctx.close();
  }

  // ── 3. Workspace with multiple tabs (main / agent 1 / agent 2) ─────────
  console.log("03: workspace tabs");
  {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/worktree/napi-1`);
    await waitForApp(page);
    await dismissTransient(page);
    await page.waitForTimeout(1500); // give the terminal stream time to attach
    await shoot(page, "03-workspace-tabs.png");
    await ctx.close();
  }

  // ── 4. File tree + markdown preview ────────────────────────────────────
  console.log("04: file tree + preview");
  {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    await presetWorkspaceLayout(ctx, {
      terminalPosition: "left",
      // [tree, preview, terminal] — show all three
      paneCollapsed: [false, false, false],
      activeWorktreeId: "napi-1",
      activeSessionId: "napi-1-m",
      activeFilePath: "docs/PLAN.md",
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/worktree/napi-1`);
    await waitForApp(page);
    await dismissTransient(page);
    // Wait for the markdown to actually render (not skeleton placeholders).
    await page
      .getByRole("heading", { name: /Auth Middleware/i })
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => {});
    await page.waitForTimeout(1500); // let terminal attach + markdown finish layout
    await shoot(page, "04-file-tree-preview.png");
    await ctx.close();
  }

  // ── 5. Mobile: PLAN.md preview above + agent terminal below ────────────
  console.log("05: mobile split (preview top, terminal bottom)");
  {
    const ctx = await browser.newContext({ viewport: MOBILE, deviceScaleFactor: 2 });
    await presetWorkspaceLayout(ctx, {
      terminalPosition: "bottom", // preview stacks above terminal
      paneCollapsed: [true, false, false], // hide tree, show preview + terminal
      activeWorktreeId: "napi-1",
      activeSessionId: "napi-1-m",
      activeFilePath: "docs/PLAN.md",
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/worktree/napi-1`);
    await waitForApp(page);
    await dismissTransient(page);
    // Wait for the markdown to render so the preview pane isn't a skeleton.
    await page
      .getByRole("heading", { name: /Auth Middleware/i })
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    await shoot(page, "05-mobile-split.png");
    await ctx.close();
  }

  await browser.close();
  console.log(`\n✔ all screenshots saved to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
