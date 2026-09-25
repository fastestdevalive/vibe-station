/**
 * UI verification of plan-04-tab-sidebar-ux-fixes.md's 6 fixes on top of the
 * project-home-workspace feature. Drives the real dev sandbox at
 * http://localhost:7174 with Playwright against system Chrome. Saves PNGs
 * under screenshots/ prefixed `project-home-workspace-ux2-` and prints a
 * structured log.
 *
 * Run (from repo root):
 *   node scripts/verify-project-home-workspace-ux2.mjs
 */

import { chromium } from "/home/gb/.vibe-station/projects/vibe-station/worktrees/vs-174/web-ui/node_modules/@playwright/test/index.mjs";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "screenshots");
const BASE = "http://localhost:7174";
const PREFIX = "project-home-workspace-ux2-";

const consoleErrors = [];
const pageErrors = [];

async function waitForApp(page, extra = 1200) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(extra);
}

async function shot(page, name, opts) {
  await page.screenshot({ path: join(OUT_DIR, PREFIX + name), fullPage: false, ...opts });
  console.log("  saved:", PREFIX + name);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors.push(m.text());
      console.log("[console.error]", m.text());
    }
  });
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
    console.log("[pageerror]", e.message);
  });

  console.log("STEP 1: navigate to", BASE);
  await page.goto(BASE);
  await waitForApp(page);

  // ── Item 5: sidebar row tap target — click a few px ABOVE the visible
  // name text (still inside the row box), not the text glyphs themselves. ──
  console.log("STEP 2: item 5 — sidebar row hit-area (click above the text, inside the row)");
  const projectRow = page.locator(".tree-row--project", { hasText: "northstar-api" }).first();
  const rowBox = await projectRow.boundingBox();
  const labelBox = await projectRow.locator(".tree-row__label").boundingBox();
  // Click near the row's top edge (a few px above the label's own box), well
  // within the row's own bounding box — this is exactly the dead-zone the
  // fix targets.
  const clickY = Math.max(rowBox.y + 2, labelBox.y - 6);
  await page.mouse.click(labelBox.x + 5, clickY);
  await waitForApp(page);
  const gotToProjectViaOffsetTap = page.url().startsWith(BASE + "/project/northstar-api");
  console.log(`  clicked ${labelBox.x + 5},${clickY} (row top=${rowBox.y}, label top=${labelBox.y}) -> URL: ${page.url()} | landed on project: ${gotToProjectViaOffsetTap}`);
  await shot(page, "sidebar-offset-tap.png", { clip: { x: 0, y: 0, width: 320, height: 900 } });

  // ── Item 6: pinned tab now reads "Overview" ──────────────────────────────
  console.log("STEP 3: item 6 — pinned tab label");
  const agentStrip = page.locator('.tabs-strip[aria-label="Agent sessions"]');
  const pinnedTab = agentStrip.locator('.tab[role="tab"]').first();
  const pinnedLabel = (await pinnedTab.textContent())?.trim();
  console.log("  pinned tab text:", pinnedLabel, "| reads Overview:", pinnedLabel?.includes("Overview"));
  await shot(page, "tab-strip-overview.png", { clip: { x: 0, y: 0, width: 1440, height: 110 } });

  // ── Item 1 + 2: tappable bucket rows + worktree chip ────────────────────
  console.log("STEP 4: items 1+2 — tappable bucket row with worktree chip");
  await waitForApp(page);
  const bucketRow = page.locator(".project-home__worktree-row").first();
  const bucketRowCount = await page.locator(".project-home__worktree-row").count();
  console.log("  bucket rows found:", bucketRowCount);
  if (bucketRowCount > 0) {
    const chipText = await bucketRow.locator(".project-home__wt-chip").textContent().catch(() => null);
    console.log("  first bucket row worktree chip:", chipText);
    await shot(page, "bucket-row-chip.png");
    const urlBefore = page.url();
    await bucketRow.click();
    await waitForApp(page);
    console.log(`  clicked bucket row -> URL changed: ${page.url() !== urlBefore} (before=${urlBefore}, after=${page.url()})`);
    await shot(page, "after-bucket-row-click.png");
    // Return to the project overview for the next steps — a direct goto,
    // since we've navigated OUT of project scope entirely (into a worktree),
    // so any previously-captured project-scope locator (e.g. `pinnedTab`) no
    // longer resolves to anything meaningful.
    await page.goto(BASE + "/project/northstar-api");
    await waitForApp(page);
  } else {
    console.log("  ⚠ no worktree bucket rows in current seed state — skipping items 1/2 row-click capture.");
  }

  // ── Item 3: tab-strip "+" opens a DRAFT, not a live agent ───────────────
  console.log("STEP 5: item 3 — tab-strip '+' opens a draft");
  const plusBtn = agentStrip.locator('button[aria-label="New agent"]');
  await plusBtn.click();
  await waitForApp(page, 1500);
  const draftChipCount = await page.locator(".draft-chip").count();
  const draftComposerVisible = await page.locator(".draft-composer").count();
  console.log(`  URL after '+': ${page.url()} | Draft chip present: ${draftChipCount > 0} | DraftComposer rendered: ${draftComposerVisible > 0}`);
  const stripBox = await agentStrip.boundingBox().catch(() => null);
  if (stripBox) {
    await shot(page, "plus-opens-draft.png", { clip: { x: stripBox.x, y: 0, width: Math.min(stripBox.width + 60, 1440), height: stripBox.height + 400 } });
  } else {
    await shot(page, "plus-opens-draft.png");
  }
  // Discard this draft so it doesn't pollute the next steps / accumulate
  // across repeated runs (same courtesy the round-1 script's dogfooding took).
  const discardBtn = page.locator('button[aria-label="Discard"], button:has-text("Discard")').first();
  if (await discardBtn.count()) {
    await discardBtn.click().catch(() => {});
    await waitForApp(page, 800);
  }

  // ── Item 4: sidebar '+' -> "Agent in project dir" matches the tab '+' ───
  console.log("STEP 6: item 4 — sidebar '+' menu 'Agent in project dir'");
  await pinnedTab.click();
  await waitForApp(page);
  const sidebarPlus = page.locator('button[aria-label="New session in northstar-api"]');
  await sidebarPlus.click();
  await waitForApp(page, 500);
  const menuItem = page.locator('[role="menuitem"]', { hasText: "Agent in project dir" });
  const menuItemExists = await menuItem.count();
  console.log("  'Agent in project dir' menu item found:", menuItemExists > 0);
  if (menuItemExists > 0) {
    await menuItem.click();
    await waitForApp(page, 1500);
    const urlAfterSidebarPlus = page.url();
    const isProjectDraftUrl = /\/project\/northstar-api\/[^/]+$/.test(urlAfterSidebarPlus);
    console.log(`  URL after sidebar '+' -> Agent in project dir: ${urlAfterSidebarPlus} | is /project/:pid/:id: ${isProjectDraftUrl}`);
    const sidebarHighlighted = await page.locator(".tree-row[data-active='true']").count();
    console.log("  sidebar rows with data-active=true:", sidebarHighlighted);
    await shot(page, "sidebar-plus-agent-in-project-dir.png", { clip: { x: 0, y: 0, width: 1440, height: 900 } });
    // Discard again for cleanliness.
    const discardBtn2 = page.locator('button[aria-label="Discard"], button:has-text("Discard")').first();
    if (await discardBtn2.count()) {
      await discardBtn2.click().catch(() => {});
      await waitForApp(page, 800);
    }
  }

  await browser.close();

  console.log("\n===== SUMMARY =====");
  console.log("Console errors captured:", consoleErrors.length);
  consoleErrors.forEach((e) => console.log("  -", e));
  console.log("Page errors captured:", pageErrors.length);
  pageErrors.forEach((e) => console.log("  -", e));
  console.log("DONE");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
