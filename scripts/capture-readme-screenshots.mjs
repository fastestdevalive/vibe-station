/**
 * Regenerates docs/screenshots/*.png — the README's framed "macOS window on a wallpaper" images.
 *
 * Source of truth for look/density/scaling is the marketing site's DOM demos
 * (vibe-station-website, `src/demo/`): the real web-ui rendered in a fixed 1120x630 stage with the
 * website's seed data, traffic lights overlaid on the app's own top bar. We drive those demos in a
 * headless browser, grab the frame at known scene times, then composite each frame onto a wallpaper
 * with the website's window chrome (12px radius, 1px rgba(255,255,255,.08) border, 0 40px 100px -30px
 * rgba(0,0,0,.9) shadow). Phone shots are cropped to the 289x607 phone shell and given the same treatment.
 *
 * Usage (website dev server must be running, e.g. `npm run dev -- --port 5391` in vibe-station-website):
 *   SITE_URL=http://localhost:5391 node scripts/capture-readme-screenshots.mjs
 *
 * Env:
 *   SITE_URL           website dev/preview server (default http://localhost:5173)
 *   PLAYWRIGHT_MODULE  module to import Playwright from (default "@playwright/test")
 *   CHROMIUM_PATH      optional explicit chromium / headless-shell executable
 *   KEEP_RAW=1         keep raw (unframed) captures in /tmp/vst-readme-raw
 *   WALLPAPER          mist (default) | midnight | aurora | peach | mist | meadow | frost | slate | steel
 *   SHOTS_OUT_DIR          output directory (default docs/screenshots)
 *   ONLY               comma-separated output file names to produce (default: all)
 *   REFRAME_ONLY=1     skip capture; re-composite the kept raw captures (implies KEEP_RAW)
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.SHOTS_OUT_DIR ?? join(ROOT, "docs", "screenshots");
const RAW_DIR = join(tmpdir(), "vst-readme-raw");
const SITE = process.env.SITE_URL ?? "http://localhost:5173";
const DSF = 2.04; // hero demo host is ~1100px wide for a 1120px stage; 2.04 gives ~2240px (2x the stage)

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "@playwright/test");

/** Raw captures: `scene` is the hero demo index on the site's home page; `at` is scene time in ms. */
const RAW = [
  { id: "dashboard", demo: 0, at: 5400 },
  { id: "agents", demo: 0, at: 6800 },
  { id: "qr", demo: 0, at: 12400 },
  { id: "phone-list", demo: 0, at: 17000 },
  { id: "phone-chat", demo: 0, at: 27500 },
  { id: "canvas", demo: 1, at: 19000 },
  { id: "markdown", demo: 2, at: 33000 },
];

/** Final images: a window on the wallpaper, or phones on the wallpaper. */
const OUT = [
  { file: "01-dashboard.png", window: "dashboard" },
  { file: "02-agents-and-modes.png", window: "agents" },
  { file: "03-subagents-canvas.png", window: "canvas" },
  { file: "04-remote-access-qr.png", window: "qr" },
  { file: "05-mobile.png", phones: ["phone-list", "phone-chat"] },
  { file: "06-markdown-customization.png", window: "markdown" },
];

// Phone shell geometry in the 1120x630 stage (website demo.css `.pf-*`).
const PHONE = { x: 415.5, y: 11.6, w: 289, h: 606.8, r: 46.6 };
const CANVAS = { w: 1440, h: 860 };

const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOpts);

await mkdir(OUT_DIR, { recursive: true });
if (!process.env.REFRAME_ONLY) await rm(RAW_DIR, { recursive: true, force: true });
await mkdir(RAW_DIR, { recursive: true });

async function captureRaw() {
  const byDemo = new Map();
  for (const r of RAW) byDemo.set(r.demo, [...(byDemo.get(r.demo) ?? []), r].sort((a, b) => a.at - b.at));
  for (const [demo, shots] of byDemo) {
    const ctx = await browser.newContext({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: DSF });
    const page = await ctx.newPage();
    await page.goto(`${SITE}/`);
    await page.waitForSelector(".demo-host");
    const host = page.locator(".demo-host").nth(demo);
    await host.scrollIntoViewIfNeeded();
    await page.addStyleTag({ content: ".demo-cursor,[class*=play]{display:none!important}" });
    for (const s of shots) {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const ms = await page.evaluate(() => Math.max(0, ...Object.values(window.__demoDebug ?? {}).map((d) => d.sceneMs ?? 0)));
        if (ms >= s.at) break;
        if (Date.now() > deadline) throw new Error(`timed out waiting for scene time ${s.at} (demo ${demo})`);
        await page.waitForTimeout(40);
      }
      await host.screenshot({ path: join(RAW_DIR, `${s.id}.png`) });
      console.log(`captured ${s.id}`);
    }
    await ctx.close();
  }
}

/** Named wallpapers (CSS backgrounds). `mist` is the one the README ships with. */
const WALLPAPERS = {
  midnight: `
    radial-gradient(1100px 700px at 12% 8%, rgba(99,102,241,.55), transparent 60%),
    radial-gradient(900px 700px at 92% 18%, rgba(168,85,247,.42), transparent 62%),
    radial-gradient(1000px 800px at 78% 100%, rgba(20,184,166,.38), transparent 60%),
    radial-gradient(900px 700px at 0% 100%, rgba(59,130,246,.30), transparent 60%),
    linear-gradient(135deg, #0b0b14 0%, #12101f 45%, #0a1620 100%)`,
  // Bright-but-subtle pastel meshes, in the spirit of stock Linux desktop wallpapers.
  aurora: `
    radial-gradient(900px 650px at 10% 12%, #ffd6e8 0%, transparent 62%),
    radial-gradient(900px 700px at 90% 8%, #cfd8ff 0%, transparent 62%),
    radial-gradient(1000px 750px at 85% 100%, #bff3e4 0%, transparent 60%),
    radial-gradient(900px 700px at 5% 95%, #e3d4ff 0%, transparent 60%),
    linear-gradient(135deg, #f3e8ff 0%, #e4ecff 50%, #dcf7f0 100%)`,
  peach: `
    radial-gradient(1000px 700px at 8% 10%, #ffe0b8 0%, transparent 62%),
    radial-gradient(900px 700px at 95% 15%, #ffc2d4 0%, transparent 62%),
    radial-gradient(1000px 800px at 80% 100%, #d9c2ff 0%, transparent 62%),
    radial-gradient(800px 600px at 0% 100%, #ffd2a6 0%, transparent 60%),
    linear-gradient(135deg, #ffe9d2 0%, #ffd9e2 50%, #e6d9ff 100%)`,
  mist: `
    radial-gradient(1000px 700px at 12% 6%, #bfe6ff 0%, transparent 62%),
    radial-gradient(900px 700px at 92% 20%, #c9f4ee 0%, transparent 62%),
    radial-gradient(1000px 800px at 70% 100%, #cfe0ff 0%, transparent 60%),
    radial-gradient(800px 600px at 0% 100%, #e1f7e8 0%, transparent 60%),
    linear-gradient(135deg, #dff1ff 0%, #d6f3ef 55%, #e4eeff 100%)`,
  meadow: `
    radial-gradient(1000px 700px at 10% 10%, #f6f2b0 0%, transparent 62%),
    radial-gradient(900px 700px at 92% 12%, #c8efc0 0%, transparent 62%),
    radial-gradient(1000px 800px at 80% 100%, #a8e6d2 0%, transparent 62%),
    radial-gradient(800px 600px at 0% 100%, #d6efa6 0%, transparent 60%),
    linear-gradient(135deg, #eaf5c2 0%, #d2f0c8 50%, #bdebdc 100%)`,
  // Blue/grey family.
  frost: `
    radial-gradient(1000px 700px at 10% 8%, #e8eef7 0%, transparent 62%),
    radial-gradient(900px 700px at 92% 15%, #c9d8ee 0%, transparent 62%),
    radial-gradient(1000px 800px at 78% 100%, #b9c8de 0%, transparent 62%),
    radial-gradient(800px 600px at 0% 100%, #d6dfea 0%, transparent 60%),
    linear-gradient(135deg, #e3eaf4 0%, #cdd9ea 55%, #bccade 100%)`,
  slate: `
    radial-gradient(1000px 700px at 10% 8%, #a9bcd6 0%, transparent 62%),
    radial-gradient(900px 700px at 92% 15%, #8fa6c6 0%, transparent 62%),
    radial-gradient(1000px 800px at 78% 100%, #7b92b4 0%, transparent 62%),
    radial-gradient(800px 600px at 0% 100%, #b4c2d6 0%, transparent 60%),
    linear-gradient(135deg, #a3b4cc 0%, #8a9fbd 55%, #7488a8 100%)`,
  steel: `
    radial-gradient(1000px 700px at 12% 6%, #c7d6ea 0%, transparent 60%),
    radial-gradient(900px 700px at 92% 20%, #b3c1d4 0%, transparent 62%),
    radial-gradient(1000px 800px at 70% 100%, #9fb0c8 0%, transparent 60%),
    radial-gradient(800px 600px at 0% 100%, #c9d3df 0%, transparent 60%),
    linear-gradient(135deg, #cfd9e6 0%, #b6c3d5 50%, #a3b2c8 100%)`,
};
const WALLPAPER_NAME = process.env.WALLPAPER ?? "mist";
const WALLPAPER = WALLPAPERS[WALLPAPER_NAME] ?? (() => { throw new Error(`unknown WALLPAPER "${WALLPAPER_NAME}" (${Object.keys(WALLPAPERS).join(", ")})`); })();

const WINDOW_CHROME = `border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);background:#0a0a09;
  box-shadow:0 40px 100px -30px rgba(0,0,0,.9),0 12px 30px -10px rgba(0,0,0,.5);`;

function page_(inner) {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;width:${CANVAS.w}px;height:${CANVAS.h}px;
    background:${WALLPAPER};position:relative;overflow:hidden">${inner}</body>`;
}

function windowHtml(id) {
  const w = 1120;
  const h = 630;
  return page_(`<div style="position:absolute;left:${(CANVAS.w - w) / 2}px;top:${(CANVAS.h - h) / 2 - 8}px;width:${w}px;height:${h}px;${WINDOW_CHROME}">
    <img src="file://${join(RAW_DIR, id + ".png")}" style="display:block;width:${w}px;height:${h}px"></div>`);
}

function phonesHtml(ids) {
  const s = 1.18;
  const gap = 90;
  const pw = PHONE.w * s;
  const ph = PHONE.h * s;
  const total = pw * ids.length + gap * (ids.length - 1);
  const left0 = (CANVAS.w - total) / 2;
  const top = (CANVAS.h - ph) / 2;
  return page_(
    ids
      .map(
        (id, i) => `<div style="position:absolute;left:${left0 + i * (pw + gap)}px;top:${top}px;width:${pw}px;height:${ph}px;
          border-radius:${PHONE.r * s}px;overflow:hidden;box-shadow:0 40px 100px -30px rgba(0,0,0,.9),0 12px 30px -10px rgba(0,0,0,.5)">
          <img src="file://${join(RAW_DIR, id + ".png")}" style="position:absolute;width:${1120 * s}px;height:${630 * s}px;
            left:${-PHONE.x * s}px;top:${-PHONE.y * s}px;max-width:none"></div>`,
      )
      .join(""),
  );
}

async function frame() {
  const ctx = await browser.newContext({ viewport: { width: CANVAS.w, height: CANVAS.h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const only = process.env.ONLY?.split(",");
  for (const o of OUT) {
    if (only && !only.includes(o.file)) continue;
    const html = o.window ? windowHtml(o.window) : phonesHtml(o.phones);
    const htmlPath = join(RAW_DIR, `${o.file}.html`);
    await writeFile(htmlPath, html);
    await page.goto(pathToFileURL(htmlPath).href);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    await page.screenshot({ path: join(OUT_DIR, o.file) });
    console.log(`framed ${o.file}`);
  }
  await ctx.close();
}

try {
  if (!process.env.REFRAME_ONLY) await captureRaw();
  await frame();
} finally {
  await browser.close();
  if (!process.env.KEEP_RAW && !process.env.REFRAME_ONLY) await rm(RAW_DIR, { recursive: true, force: true });
}
