/**
 * Screenshots the subagent UX in the dev sandbox.
 *
 * Navigates to a working session, injects mock subagent state into the
 * Zustand stores (childByParent + a fake spawnedFrom session), then
 * screenshots:
 *   1. Parent session — TaskToolEntry live row visible in the tool run
 *   2. Child session  — SubagentBanner visible above the Composer
 *
 * Run:
 *   SCREENSHOTS_URL=http://localhost:5190 node scripts/screenshot-subagent-ux.mjs
 */

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "docs", "screenshots");
const BASE = process.env.SCREENSHOTS_URL ?? "http://localhost:5174";

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

async function waitForApp() {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(1200);
}

// ── 1. Load the app ──────────────────────────────────────────────────────────
console.log("Loading sandbox…");
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await waitForApp();

// ── 2. Navigate into a worktree session ──────────────────────────────────────
// The demo routes to /worktree by default. Find any session tile and click it.
const sessionTile = page.locator('[data-session-id]').first();
const hasSessionTile = await sessionTile.count() > 0;
if (!hasSessionTile) {
  // Try navigating directly
  await page.goto(`${BASE}/worktree`, { waitUntil: "domcontentloaded" });
  await waitForApp();
}

// Click the first visible session tile to open its chat pane
const tiles = page.locator('[data-session-id], .session-tile, [class*="session"]');
const tileCount = await tiles.count();
console.log(`Found ${tileCount} session elements`);

// Take a baseline screenshot first
await page.screenshot({ path: join(OUT, "subagent-00-baseline.png"), fullPage: false });
console.log("Baseline screenshot saved.");

// ── 3. Inject mock subagent state into Zustand ───────────────────────────────
// We patch the live store directly in the browser to simulate:
//   • A parent session that has a child session
//   • The child session having spawnedFrom set
// This lets us screenshot both the TaskToolEntry (parent view) and
// SubagentBanner (child view) without needing a real agent run.

const injected = await page.evaluate(() => {
  // Find Zustand store instances — vibe-station exposes them via React DevTools fiber
  // Walk the fiber tree to find useServerStore and patch it
  function findFiberRoot() {
    const root = document.getElementById("root") || document.body.firstElementChild;
    if (!root) return null;
    for (const key of Object.keys(root)) {
      if (key.startsWith("__reactFiber") || key.startsWith("__reactContainer")) {
        return root[key];
      }
    }
    return null;
  }

  function collectZustandStores(fiber, stores = []) {
    if (!fiber) return stores;
    const state = fiber.memoizedState;
    if (state) {
      let s = state;
      while (s) {
        if (
          s.memoizedState &&
          typeof s.memoizedState === "object" &&
          typeof s.memoizedState.getState === "function"
        ) {
          stores.push(s.memoizedState);
        }
        s = s.next;
      }
    }
    if (fiber.child) collectZustandStores(fiber.child, stores);
    if (fiber.sibling) collectZustandStores(fiber.sibling, stores);
    return stores;
  }

  const fiber = findFiberRoot();
  if (!fiber) return { ok: false, reason: "no fiber root" };

  const stores = collectZustandStores(fiber);

  // Find the server store (has .sessions array)
  const serverStore = stores.find((s) => {
    try { return Array.isArray(s.getState().sessions); } catch { return false; }
  });
  if (!serverStore) return { ok: false, reason: "serverStore not found", count: stores.length };

  const state = serverStore.getState();
  const sessions = state.sessions;
  if (!sessions?.length) return { ok: false, reason: "no sessions" };

  // Pick two sessions — make the second a "child" of the first
  const parent = sessions[0];
  const child = sessions[1];
  if (!parent || !child) return { ok: false, reason: "need ≥2 sessions" };

  // Patch child to have spawnedFrom = parent.id
  const patchedSessions = sessions.map((s) =>
    s.id === child.id ? { ...s, spawnedFrom: parent.id } : s
  );

  // Build childByParent map
  const childByParent = new Map([[parent.id, [child.id]]]);

  // Apply to store
  serverStore.setState({ sessions: patchedSessions, childByParent });

  return {
    ok: true,
    parentId: parent.id,
    childId: child.id,
    parentName: parent.name || parent.id,
    childName: child.name || child.id,
    totalSessions: sessions.length,
  };
});

console.log("Store injection result:", injected);
await page.waitForTimeout(800);

if (!injected.ok) {
  // Fall back: just take a nice screenshot of the UI as-is
  await page.screenshot({ path: join(OUT, "subagent-ux.png"), fullPage: false });
  console.log("Fallback screenshot saved to docs/screenshots/subagent-ux.png");
  await browser.close();
  process.exit(0);
}

// ── 4. Navigate to the parent session and screenshot TaskToolEntry ────────────
// Navigate to parent's chat pane — try clicking its tile or routing directly
const parentTile = page.locator(`[data-session-id="${injected.parentId}"]`).first();
if (await parentTile.count() > 0) {
  await parentTile.click();
  await page.waitForTimeout(1000);
}

await page.screenshot({ path: join(OUT, "subagent-01-parent-session.png") });
console.log("Parent session screenshot saved.");

// ── 5. Navigate to the child session and screenshot SubagentBanner ───────────
const childTile = page.locator(`[data-session-id="${injected.childId}"]`).first();
if (await childTile.count() > 0) {
  await childTile.click();
  await page.waitForTimeout(1000);
}

// The SubagentBanner should now render because spawnedFrom is set
const banner = page.locator(".chat-subagent-banner").first();
const bannerVisible = await banner.count() > 0;
console.log("SubagentBanner visible:", bannerVisible);

await page.screenshot({ path: join(OUT, "subagent-02-child-session-banner.png") });
console.log("Child session screenshot saved.");

// ── 6. Crop the banner area specifically if visible ──────────────────────────
if (bannerVisible) {
  const box = await banner.boundingBox();
  if (box) {
    // Screenshot a region around the banner + composer area
    await page.screenshot({
      path: join(OUT, "subagent-03-banner-closeup.png"),
      clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 80 },
    });
    console.log("Banner closeup saved.");
  }
}

await browser.close();
console.log("Done. Screenshots in docs/screenshots/");
