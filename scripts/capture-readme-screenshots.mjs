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
 *   LIVE_URL           running dev sandbox / daemon UI used for the `live` shots (default http://localhost:5174)
 *   WALLPAPER          mist (default) | dusk | midnight | aurora | peach | mist | meadow | frost | slate | steel
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

/** Shots taken from the real web-ui on a running daemon (demo dataset), not from the website demos. */
const LIVE = [
  {
    id: "files-light",
    worktree: "napi-1",
    theme: "vibestation-light",
    files: ["docs/API.md", "README.md", "docs/PLAN.md"],
    // The worktree's main session is a terminal in the seed data; present it as Rich Chat with this history.
    chatSession: "napi-1-m",
    chat: [
      { kind: "user", role: "user", text: "Phase 3 is done — tick it off in docs/PLAN.md and add a rollout note." },
      { kind: "text", role: "assistant", text: "On it. Let me read the plan first." },
      { kind: "tool_use", toolId: "t-read", toolName: "read", toolKind: "read", toolInput: { filePath: "docs/PLAN.md" }, toolStatus: "in_progress" },
      { kind: "tool_result", toolId: "t-read", toolName: "read", toolResult: { content: "66 lines" }, toolStatus: "completed" },
      {
        kind: "tool_use", toolId: "t-edit", toolName: "edit", toolKind: "edit",
        toolInput: { filePath: "docs/PLAN.md" }, toolStatus: "in_progress",
      },
      {
        kind: "tool_result", toolId: "t-edit", toolName: "edit", toolStatus: "completed",
        toolDiffs: [{ path: "docs/PLAN.md", oldText: "### Phase 3 — Role-based access (in progress) ⏳\n", newText: "### Phase 3 — Role-based access ✅\n" }],
      },
      { kind: "text", role: "assistant", text: "Phase 3 is marked complete and I added a **Rollout** section: ship behind `AUTH_V2`, then enable per tenant." },
      { kind: "user", role: "user", text: "Nice. Does the plan mention the refresh-token TTL?" },
      { kind: "text", role: "assistant", text: "Yes — Phase 1 covers `JWT_ACCESS_TTL` and `JWT_REFRESH_TTL`, both configurable via env." },
    ],
  },
];

/** Rewrite session records for `id` to the json channel, anywhere they appear in a JSON body. */
function asJsonChannel(node, id) {
  if (Array.isArray(node)) return node.map((n) => asJsonChannel(n, id));
  if (node && typeof node === "object") {
    const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, asJsonChannel(v, id)]));
    return out.id === id && "channel" in out ? { ...out, channel: "json" } : out;
  }
  return node;
}

/** Click a file-tree row by name: the match right of the chat pane and below the tab strip (names repeat in chat/tabs). */
async function clickTreeRow(page, name) {
  for (let i = 0; i < 40; i += 1) {
    for (const m of await page.getByText(name, { exact: true }).all()) {
      const box = await m.boundingBox();
      if (box && box.x > 700 && box.y > 40) return m.click();
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`file tree row "${name}" not found`);
}

/** Make `l.chatSession` a Rich Chat agent for this browser only: patch REST, and answer chat:open over the WS. */
async function mockRichChat(page, l) {
  const events = l.chat.map((e, i) => ({
    id: `demo-${i}`, sessionId: l.chatSession, provider: "claude", turnId: `demo-t${e.kind === "user" ? i : i - 1}`,
    ts: Date.now() - (l.chat.length - i) * 60_000, logSeq: i + 1, ...e,
  }));
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    if (!(res.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response: res });
    await route.fulfill({ response: res, json: asJsonChannel(await res.json(), l.chatSession) });
  });
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => ws.send(m));
    ws.onMessage((m) => {
      const msg = typeof m === "string" ? JSON.parse(m.startsWith("{") ? m : "{}") : {};
      if (msg.type === "chat:open" && msg.sessionId === l.chatSession) {
        ws.send(JSON.stringify({ type: "chat:replay", sessionId: l.chatSession, events, hasMore: false, oldestSeq: 1 }));
      } else server.send(m);
    });
  });
}

/** Final images: a window on the wallpaper, or phones on the wallpaper. */
const OUT = [
  { file: "01-dashboard.png", window: "dashboard" },
  { file: "02-agents-and-modes.png", window: "agents" },
  { file: "03-subagents-canvas.png", window: "canvas" },
  { file: "04-remote-access-qr.png", window: "qr" },
  { file: "05-mobile.png", phones: ["phone-list", "phone-chat"] },
  { file: "06-markdown-customization.png", window: "markdown" },
  // Light-mode app on a dark wallpaper; `lights` overlays the traffic lights on the app's top bar (live shots have no demo chrome).
  { file: "07-markdown-file-tree.png", window: "files-light", wallpaper: "dusk", lights: true },
];

// Phone shell geometry in the 1120x630 stage (website demo.css `.pf-*`).
const PHONE = { x: 415.5, y: 11.6, w: 289, h: 606.8, r: 46.6 };
const CANVAS = { w: 1440, h: 860 };
const LIVE_URL = process.env.LIVE_URL ?? "http://localhost:5174";

// Raw captures needed by the selected outputs (ONLY unset = all).
const only = process.env.ONLY?.split(",");
const needed = new Set(OUT.filter((o) => !only || only.includes(o.file)).flatMap((o) => (o.window ? [o.window] : o.phones)));

const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOpts);

await mkdir(OUT_DIR, { recursive: true });
if (!process.env.REFRAME_ONLY) await rm(RAW_DIR, { recursive: true, force: true });
await mkdir(RAW_DIR, { recursive: true });

async function captureRaw() {
  const byDemo = new Map();
  for (const r of RAW.filter((r) => needed.has(r.id))) byDemo.set(r.demo, [...(byDemo.get(r.demo) ?? []), r].sort((a, b) => a.at - b.at));
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

/** Open markdown files in the real UI (light theme, agent pane narrowed) and grab the frame. */
async function captureLive() {
  for (const l of LIVE.filter((l) => needed.has(l.id))) {
    // 1440x810 scales by 1120/1440 into the full 1120x630 window; the traffic lights are overlaid on the app's own top bar.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1.6 });
    await ctx.addInitScript((t) => localStorage.setItem("vibestation:theme", t), l.theme);
    const page = await ctx.newPage();
    if (l.chat) await mockRichChat(page, l); // before the settings route below: later routes win
    // The daemon's saved themeId wins over the localStorage hint; override it for this browser only.
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), themeId: l.theme } });
    });
    await page.goto(`${LIVE_URL}/worktree/${l.worktree}`);
    await page.waitForSelector('button[aria-label="Hide projects sidebar"]');
    // Make room for the overlaid traffic lights (the website demo does the same: padding-left on the top bar).
    await page.addStyleTag({ content: 'button[aria-label$="projects sidebar"] { margin-left: 70px !important; }' });
    await page.waitForTimeout(2500);
    const opened = new Set(); // tree folders are toggles: expand each once
    for (const f of l.files) {
      for (const dir of f.split("/").slice(0, -1)) {
        if (opened.has(dir)) continue;
        opened.add(dir);
        await clickTreeRow(page, dir);
      }
      await page.waitForTimeout(400);
      await clickTreeRow(page, f.split("/").pop());
      await page.waitForTimeout(700);
    }
    // Sidebar stays open: its header is the app top bar the traffic lights sit on. Narrow the agent pane
    // (the separator between the sidebar and the files panel) so the markdown preview gets the room.
    let sep = null;
    for (const s of await page.locator('[role="separator"]').all()) {
      const box = await s.boundingBox();
      if (box && box.height > 300 && box.x > 400) { sep = box; break; }
    }
    await page.mouse.move(sep.x + sep.width / 2, 400);
    await page.mouse.down();
    await page.mouse.move(sep.x - 40, 400, { steps: 8 });
    await page.mouse.move(sep.x - 80, 400, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1000);
    // Chat pane (left of x=700): show the latest messages.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("*")) {
        if (el.scrollHeight > el.clientHeight + 20 && el.getBoundingClientRect().x < 700 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
      }
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(RAW_DIR, `${l.id}.png`) });
    console.log(`captured ${l.id}`);
    await ctx.close();
  }
}

/** Named wallpapers (CSS backgrounds). `mist` is the one the README ships with. */
const WALLPAPERS = {
  // Dark, muted blue-grey: makes a light-mode window pop.
  dusk: `
    radial-gradient(1000px 700px at 12% 8%, #34415f 0%, transparent 62%),
    radial-gradient(900px 700px at 92% 18%, #3b3360 0%, transparent 62%),
    radial-gradient(1000px 800px at 78% 100%, #1f4a52 0%, transparent 60%),
    radial-gradient(900px 700px at 0% 100%, #2a3a55 0%, transparent 60%),
    linear-gradient(135deg, #161a26 0%, #1b2033 50%, #131d26 100%)`,
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
const wallpaper = (name) => WALLPAPERS[name] ?? (() => { throw new Error(`unknown wallpaper "${name}" (${Object.keys(WALLPAPERS).join(", ")})`); })();
const WALLPAPER = wallpaper(WALLPAPER_NAME);

const WINDOW_CHROME = `border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);background:#0a0a09;
  box-shadow:0 40px 100px -30px rgba(0,0,0,.9),0 12px 30px -10px rgba(0,0,0,.5);`;

function page_(inner, bg = WALLPAPER) {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;width:${CANVAS.w}px;height:${CANVAS.h}px;
    background:${bg};position:relative;overflow:hidden">${inner}</body>`;
}

// Live shots have no demo chrome: overlay the lights on the app's own top bar (same 12px dots, 16px inset as the website hero).
const LIGHTS = ["#ff5f57", "#febc2e", "#28c840"]
  .map((c, i) => `<i style="position:absolute;left:${16 + i * 18}px;top:8px;width:12px;height:12px;border-radius:50%;background:${c}"></i>`)
  .join("");

function windowHtml(id, { bg, lights } = {}) {
  const w = 1120;
  const h = 630;
  return page_(`<div style="position:absolute;left:${(CANVAS.w - w) / 2}px;top:${(CANVAS.h - h) / 2 - 8}px;width:${w}px;height:${h}px;${WINDOW_CHROME}">
    <img src="file://${join(RAW_DIR, id + ".png")}" style="display:block;width:${w}px;height:${h}px">${lights ? LIGHTS : ""}</div>`, bg);
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
  for (const o of OUT) {
    if (only && !only.includes(o.file)) continue;
    const html = o.window ? windowHtml(o.window, { bg: o.wallpaper && wallpaper(o.wallpaper), lights: o.lights }) : phonesHtml(o.phones);
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
  if (!process.env.REFRAME_ONLY) {
    await captureLive();
    await captureRaw();
  }
  await frame();
} finally {
  await browser.close();
  if (!process.env.KEEP_RAW && !process.env.REFRAME_ONLY) await rm(RAW_DIR, { recursive: true, force: true });
}
