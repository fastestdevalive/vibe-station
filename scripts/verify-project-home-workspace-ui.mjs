/**
 * UI verification of the "project-home-workspace" feature.
 * Drives the real dev sandbox at http://localhost:7174 with Playwright
 * against system Chrome. Saves PNGs under screenshots/ prefixed
 * `project-home-workspace-` and prints a structured log.
 *
 * Run (from repo root):
 *   node scripts/verify-project-home-workspace-ui.mjs
 *
 * The `@playwright/test` ESM entry is imported by absolute path from
 * web-ui/node_modules (the repo-root `scripts/` dir is outside web-ui's
 * package resolution), matching how this sandbox runs the existing
 * take-screenshots scripts.
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
const PREFIX = "project-home-workspace-";

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
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/") || r.url().includes("/ws")) {
      console.log("[requestfailed]", r.url(), r.failure()?.errorText);
    }
  });

  // ── Step 1: navigate + settle ─────────────────────────────────────────
  console.log("STEP 1: navigate to", BASE);
  await page.goto(BASE);
  await waitForApp(page);
  console.log("  URL:", page.url(), "| title:", await page.title());

  // ── Step 2: sidebar split — project name navigates, folder icon does not ──
  console.log("STEP 2: sidebar split");
  const projectRow = page.locator(".tree-row--project", { hasText: "northstar-api" }).first();
  // Item 5 (plan-04) replaced the name-only `.tree-row__project-link` with a
  // full-row `.wt-row__stretch-link`, same pattern as every other sidebar
  // row — this selector was updated to match.
  const projectLink = projectRow.locator(".wt-row__stretch-link");
  const projectExpand = projectRow.locator(".tree-row__project-expand");

  // Folder icon: toggles expand/collapse, must NOT navigate.
  const expandAriaBefore = await projectExpand.getAttribute("aria-label");
  await projectExpand.click();
  await page.waitForTimeout(500);
  const urlAfterFolderClick = page.url();
  const expandAriaAfter = await projectExpand.getAttribute("aria-label");
  console.log(`  folder icon: aria "${expandAriaBefore}" -> "${expandAriaAfter}" ; URL stayed at root: ${urlAfterFolderClick === BASE}`);
  // Re-open if we collapsed it.
  if (expandAriaAfter && expandAriaAfter.startsWith("Expand")) {
    await projectExpand.click();
    await page.waitForTimeout(400);
  }

  // Now click the project NAME (the freshly-fixed split target) -> navigates.
  await projectLink.click();
  await waitForApp(page);
  console.log("  name click navigated to:", page.url());
  const gotToProject = page.url().startsWith(BASE + "/project/northstar-api");

  // Screenshot the sidebar area (clip left column).
  const sbBox = await page.locator(".pane-left").boundingBox().catch(() => null);
  if (sbBox) {
    await shot(page, "sidebar-split.png", { clip: { x: sbBox.x, y: 0, width: sbBox.width, height: 900 } });
  } else {
    await shot(page, "sidebar-split.png", { clip: { x: 0, y: 0, width: 320, height: 900 } });
  }

  // ── Step 3: Project tab (home) full page ───────────────────────────────
  console.log("STEP 3: Project tab home");
  await waitForApp(page);
  const h1 = await page.locator(".project-home__name").textContent().catch(() => null);
  const path = await page.locator(".project-home__path").textContent().catch(() => null);
  const gitStatus = await page.locator(".project-home__git-status").count();
  const newWt = await page.locator("button:has-text('New worktree')").count();
  const newDirect = await page.locator("button:has-text('New direct agent')").count();
  const buckets = await page.locator(".project-home__buckets").count();
  const directAgents = await page.locator(".project-home__direct-agents").count();
  console.log(`  name="${h1}" path="${path}" gitStatus=${gitStatus} newWt=${newWt} newDirect=${newDirect} buckets=${buckets} directAgents=${directAgents}`);
  await shot(page, "project-tab.png");

  // ── Step 4: create a direct agent (dogfood) if none exists ─────────────
  console.log("STEP 4: New direct agent");
  const directAgentExists = (await page.locator(".project-home__direct-row").count()) > 0;
  console.log("  existing direct agents:", await page.locator(".project-home__direct-row").count());

  if (!directAgentExists) {
    const newDirectBtn = page.locator("button:has-text('New direct agent')").first();
    const disabled = await newDirectBtn.isDisabled().catch(() => false);
    console.log("  New direct agent disabled:", disabled);
    if (!disabled) {
      await newDirectBtn.click();
      await waitForApp(page, 2000);
      // Wait for a new agent tab to appear in the agent strip.
      let agentTabCount = await page.locator('.tabs-strip[aria-label="Agent sessions"] .tab').count();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        agentTabCount = await page.locator('.tabs-strip[aria-label="Agent sessions"] .tab').count();
        if (agentTabCount > 2) break; // + and fullscreen are 2; an agent tab makes 3+
        await page.waitForTimeout(500);
      }
      console.log("  agent strip tab count after create:", agentTabCount);
      console.log("  URL after create:", page.url());
      // Screenshot the tab strip area (clip the top strip region).
      const stripBox = await page.locator('.tabs-strip[aria-label="Agent sessions"]').boundingBox().catch(() => null);
      if (stripBox) {
        await shot(page, "new-agent-tab.png", { clip: { x: stripBox.x, y: stripBox.y - 30, width: Math.min(stripBox.width + 60, 1440), height: stripBox.height + 60 } });
      } else {
        await shot(page, "new-agent-tab.png", { clip: { x: 0, y: 0, width: 1440, height: 140 } });
      }
    } else {
      // Zero-modes case: screenshot whatever state results and note it.
      console.log("  ⚠ New direct agent button is disabled (no agent modes?) — capturing state, not a failure.");
      await shot(page, "new-agent-tab.png");
    }
  } else {
    console.log("  direct agent already exists — will activate it in step 5.");
    // Still capture the tab-strip screenshot fresh each run (showing the
    // pinned Project tab + existing agent tabs), so this file never goes
    // stale relative to the current UI even when creation is skipped.
    const stripBox = await page.locator('.tabs-strip[aria-label="Agent sessions"]').boundingBox().catch(() => null);
    if (stripBox) {
      await shot(page, "new-agent-tab.png", { clip: { x: stripBox.x, y: stripBox.y - 30, width: Math.min(stripBox.width + 60, 1440), height: stripBox.height + 60 } });
    } else {
      await shot(page, "new-agent-tab.png", { clip: { x: 0, y: 0, width: 1440, height: 140 } });
    }
  }

  // ── Step 5: activate a direct-agent tab ────────────────────────────────
  console.log("STEP 5: activate direct-agent tab");
  const agentStrip = page.locator('.tabs-strip[aria-label="Agent sessions"]');
  let agentTabs = agentStrip.locator(".tab");
  // Find a real agent-session tab (role=tab, not the "+"/fullscreen controls,
  // and NOT the pinned "Project" tab — that's index 0 by design, see 4.3.1).
  let clicked = false;
  for (let i = 0; i < (await agentTabs.count()); i++) {
    const t = agentTabs.nth(i);
    if ((await t.getAttribute("role")) === "tab" && !(await t.evaluate((el) => el.classList.contains("tab--project-home")))) {
      await t.click();
      clicked = true;
      console.log("  clicked agent tab index", i, "label:", (await t.textContent()).trim());
      break;
    }
  }
  if (!clicked) {
    console.log("  ⚠ no direct-agent tab found to activate; skipping step-5 screenshot.");
  }
  await waitForApp(page, 1500);
  console.log("  URL after activating agent tab:", page.url());
  // Detect agent pane + shared tools pane.
  const hasChatOrTerminal = (await page.locator(".chat-pane,.terminal-pane,.pane").count()) > 0;
  console.log("  agent pane-ish present:", hasChatOrTerminal);
  await shot(page, "agent-tab-active.png");

  // ── Step 6: back to the Project tab (real, pinned, first, no close button) ──
  console.log("STEP 6: back to Project tab");
  // Click the real pinned "Project" TabsStrip tab directly (fixed bug: this
  // tab now exists — previously it didn't, and the only way back was via the
  // sidebar project-name link).
  const projectTab = agentStrip.locator('.tab[role="tab"]').first();
  console.log("  clicking pinned tab, label:", (await projectTab.textContent()).trim());
  await projectTab.click();
  await waitForApp(page);
  console.log("  back at URL:", page.url(), "| project-home visible:", await page.locator(".project-home").count());
  console.log(
    "  pinned tab has no close control:",
    (await projectTab.locator('[aria-label*="Close" i], [aria-label*="Terminate" i]').count()) === 0,
  );
  const projectTabLabels = await agentStrip.locator(".tab__label").allTextContents();
  console.log("  agent strip tab labels:", projectTabLabels);
  await shot(page, "back-to-project-tab.png");

  // ── Step 7: non-git empty state ────────────────────────────────────────
  console.log("STEP 7: non-git project empty state");
  const projects = await page.evaluate(async () => {
    const r = await fetch("/api/projects");
    const d = await r.json();
    const list = Array.isArray(d) ? d : d.projects ?? [];
    return list.map((p) => ({ id: p.id, name: p.name, isGit: p.isGit }));
  });
  const nonGit = projects.filter((p) => !p.isGit);
  console.log("  total projects:", projects.length, "| non-git:", nonGit.length);
  if (nonGit.length > 0) {
    const ng = nonGit[0];
    // Navigate to the non-git project via sidebar
    const ngRow = page.locator(".tree-row--project", { hasText: ng.name }).first();
    await ngRow.locator(".wt-row__stretch-link").click();
    await waitForApp(page);
    await shot(page, "nongit-empty-state.png");
    console.log("  captured non-git empty state for:", ng.name);
  } else {
    console.log("  ⚠ no non-git project in seed data — skipping (will note in report, not fabricating).");
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
