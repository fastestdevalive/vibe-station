/**
 * Screenshots for revisit-bar-mobile branch changes.
 * Targets the dev sandbox at http://localhost:7100 (VST_NO_AUTH=1).
 *
 * Run:
 *   PLAYWRIGHT_BROWSERS_PATH=/home/gb/code/fastestdevalive/vibe-station/web-ui/node_modules/playwright \
 *   node --experimental-strip-types \
 *     --import=/home/gb/code/fastestdevalive/vibe-station/node_modules/tsx/dist/esm/index.cjs \
 *     scripts/take-screenshots-dev.ts
 */

import { chromium, type Page, type BrowserContext } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "screenshots");
const BASE = "http://localhost:7100";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

async function waitForApp(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  await page.waitForTimeout(1200);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
  console.log("  saved:", name);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });

  // ── 1. Desktop: top bar height + no brand ───────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await waitForApp(page);
    // Clip just the top bar area
    await page.screenshot({
      path: join(OUT_DIR, "01-desktop-topbar.png"),
      clip: { x: 0, y: 0, width: 1440, height: 80 },
    });
    console.log("  saved: 01-desktop-topbar.png");

    // ── 2. Desktop: sidebar with "Vibe Station Home" ──────────────────────
    // Ensure sidebar is open
    const sidebar = page.locator(".pane-left, [class*='left-sidebar']").first();
    await page.screenshot({
      path: join(OUT_DIR, "02-desktop-sidebar-home.png"),
      clip: { x: 0, y: 0, width: 280, height: 500 },
    });
    console.log("  saved: 02-desktop-sidebar-home.png");

    await ctx.close();
  }

  // ── 3. Desktop: 3-dot popup with worktree ID ─────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await waitForApp(page);
    // Click the 3-dot button on the first worktree row
    const menuTrigger = page.locator("[data-wt-menu-trigger]").first();
    if (await menuTrigger.isVisible()) {
      await menuTrigger.click();
      await page.waitForTimeout(400);
      // Find the popup
      const popup = page.locator(".menu-pop").first();
      if (await popup.isVisible()) {
        const box = await popup.boundingBox();
        if (box) {
          await page.screenshot({
            path: join(OUT_DIR, "03-desktop-wt-popup-id.png"),
            clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: box.width + 20, height: box.height + 20 },
          });
          console.log("  saved: 03-desktop-wt-popup-id.png");
        } else {
          await shot(page, "03-desktop-wt-popup-id.png");
        }
      } else {
        await shot(page, "03-desktop-wt-popup-id.png");
      }
    } else {
      console.log("  ⚠ no wt-menu-trigger found, taking full page");
      await shot(page, "03-desktop-wt-popup-id.png");
    }
    await ctx.close();
  }

  // ── 4. Mobile: top bar (no wt ID/branch), open worktree ──────────────────
  {
    const ctx = await browser.newContext({ viewport: MOBILE });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await waitForApp(page);
    // Tap hamburger menu if sidebar is closed
    const sidebarToggle = page.locator("button[aria-label*='sidebar' i], button.icon-btn").first();
    const wtRow = page.locator(".tree-row--worktree, .wt-row").first();
    if (!await wtRow.isVisible() && await sidebarToggle.isVisible()) {
      await sidebarToggle.click();
      await page.waitForTimeout(400);
    }
    if (await wtRow.isVisible()) {
      await wtRow.click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
    }
    await page.screenshot({
      path: join(OUT_DIR, "04-mobile-topbar-no-wtid.png"),
      clip: { x: 0, y: 0, width: 390, height: 70 },
    });
    console.log("  saved: 04-mobile-topbar-no-wtid.png");

    // ── 5. Mobile: 3-dot popup with worktree ID ───────────────────────────
    await page.goto(BASE);
    await waitForApp(page);
    if (!await wtRow.isVisible() && await sidebarToggle.isVisible()) {
      await sidebarToggle.click();
      await page.waitForTimeout(400);
    }
    const mobileTrigger = page.locator("[data-wt-menu-trigger]").first();
    if (await mobileTrigger.isVisible()) {
      await mobileTrigger.click({ force: true });
      await page.waitForTimeout(400);
      const popup = page.locator(".menu-pop").first();
      if (await popup.isVisible()) {
        const box = await popup.boundingBox();
        if (box) {
          await page.screenshot({
            path: join(OUT_DIR, "05-mobile-wt-popup-id.png"),
            clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: box.width + 20, height: box.height + 20 },
          });
          console.log("  saved: 05-mobile-wt-popup-id.png");
        } else {
          await shot(page, "05-mobile-wt-popup-id.png");
        }
      } else {
        await shot(page, "05-mobile-wt-popup-id.png");
      }
    } else {
      await shot(page, "05-mobile-wt-popup-id.png");
    }

    await ctx.close();
  }

  // ── 6. Mobile: default vertical split layout ──────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: MOBILE });
    const page = await ctx.newPage();
    // Pre-seed store so we land in a worktree workspace view
    await page.goto(BASE);
    await waitForApp(page);
    // Click into a worktree
    const wtRow = page.locator(".wt-row, [class*='tree-row']").first();
    if (await wtRow.isVisible()) {
      await wtRow.click();
      await page.waitForTimeout(800);
    }
    await shot(page, "06-mobile-vertical-split.png");
    await ctx.close();
  }

  await browser.close();
  console.log("\nDone. Screenshots saved to:", OUT_DIR);
}

main().catch((e) => { console.error(e); process.exit(1); });
