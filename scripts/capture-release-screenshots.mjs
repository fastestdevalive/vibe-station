/**
 * Release-notes screenshots: tight crops of the real web-ui, framed like the website's small feature
 * visuals (vibe-station-website `CardDemos.tsx` / `sections.css`): square 1px hairline frame, a bar with three
 * 6px dots and a dim mono title, the four L-shaped corner marks, flat on the site's near-black background.
 * The README shots (capture-readme-screenshots.mjs) use the big rounded window on a wallpaper instead.
 *
 * Resolution matches those README/website captures: the app is rendered in a 1440x810 viewport (the README
 * "live" shots do the same) and everything is composed at the website's 1120x630 stage scale (1120/1440), so type
 * and density are identical to the existing images. Raw captures are 1.6x; the framed PNGs are 2x of the stage.
 *
 * Needs a running dev sandbox of this checkout with the demo dataset:
 *   scripts/dev-sandbox.sh up <name> --port=71NN
 *   LIVE_URL=http://localhost:71NN PLAYWRIGHT_MODULE=<path to @playwright/test> node scripts/capture-release-screenshots.mjs
 *
 * Env:
 *   LIVE_URL           running sandbox (default http://localhost:7190)
 *   RELEASE            output folder name under docs/screenshots/release/ (default v0.0.2-beta)
 *   PLAYWRIGHT_MODULE  module to import Playwright from (default "@playwright/test")
 *   CHROMIUM_PATH      optional explicit chromium / headless-shell executable
 *   ONLY               comma-separated output file names to produce (default: all)
 *   KEEP_RAW=1         keep the unframed crops in the temp dir
 *
 * The limits snapshot and the chat history are injected for this browser only (REST + WS interception), so the
 * sandbox is never modified and no real accounts are needed.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = process.env.RELEASE ?? "v0.0.2-beta";
const OUT_DIR = join(ROOT, "docs", "screenshots", "release", RELEASE);
const RAW_DIR = join(tmpdir(), "vst-release-raw");
const LIVE_URL = process.env.LIVE_URL ?? "http://localhost:7190";

const VIEW = { w: 1440, h: 810 };
const RAW_DSF = 1.6;
const STAGE_SCALE = 1120 / 1440; // README/website stage: 1120px wide for a 1440px app viewport
const OUT_DSF = 2;
const THEME = "vibestation-dark";
const WORKTREE = "napi-1";
const SESSION = "napi-1-m"; // main session of the worktree; presented as Rich Chat for this browser only

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "@playwright/test");

// ── injected data ───────────────────────────────────────────────────────────

const hoursFromNow = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
function limitsSnapshot() {
  const asOf = new Date().toISOString();
  const win = (harness, windowId, cadenceMinutes, usedPct, resetsInH) => ({
    harness, windowId, cadenceMinutes, usedPct, resetsAt: hoursFromNow(resetsInH), asOf, status: "ok",
  });
  const res = (harness, windows) => ({ harness, status: "ok", message: null, asOf, windows });
  return {
    host: "demo-host",
    slots: [{ harness: "claude", windowId: "five_hour" }, { harness: "claude", windowId: "seven_day" }],
    harnesses: [
      res("claude", [win("claude", "five_hour", 300, 42, 2.3), win("claude", "seven_day", 10080, 61, 52)]),
      res("codex", [win("codex", "primary", 43200, 4, 480)]),
      res("agy", [win("agy", "gemini_5h", 300, 12, 3.1), win("agy", "gemini_weekly", 10080, 83, 70), win("agy", "3p_5h", 300, 47, 1.4)]),
    ],
  };
}

const bar = (label, pct, color) =>
  `<div style="display:flex;align-items:center;gap:10px;margin-top:9px"><div style="width:74px;color:#94a3b8;font-size:12px">${label}</div><div style="flex:1;height:8px;background:#1e293b;border-radius:4px"><div style="width:${pct}%;height:8px;background:${color};border-radius:4px"></div></div><div style="width:34px;text-align:right;font-size:12px">${pct}%</div></div>`;
const HTML_CARD = [
  "<!doctype html><html><body style=\"margin:0;font:14px system-ui;background:#0f172a;color:#e2e8f0;padding:18px\">",
  "<div style=\"font-weight:600;margin-bottom:12px\">Rollout status</div>",
  "<div style=\"display:flex;gap:10px\">",
  "<div style=\"flex:1;background:#1e293b;border-radius:8px;padding:12px\"><div style=\"color:#94a3b8;font-size:12px\">AUTH_V2</div><div style=\"font-size:22px;font-weight:700;color:#4ade80\">62%</div><div style=\"color:#94a3b8;font-size:12px\">of tenants</div></div>",
  "<div style=\"flex:1;background:#1e293b;border-radius:8px;padding:12px\"><div style=\"color:#94a3b8;font-size:12px\">Errors</div><div style=\"font-size:22px;font-weight:700\">0.02%</div><div style=\"color:#94a3b8;font-size:12px\">last hour</div></div>",
  "<div style=\"flex:1;background:#1e293b;border-radius:8px;padding:12px\"><div style=\"color:#94a3b8;font-size:12px\">p95 latency</div><div style=\"font-size:22px;font-weight:700\">118ms</div><div style=\"color:#94a3b8;font-size:12px\">-9ms vs v1</div></div>",
  "</div>",
  "<div style=\"margin-top:18px;font-weight:600\">By region</div>",
  bar("us-east", 88, "#4ade80"), bar("eu-west", 64, "#4ade80"), bar("ap-south", 31, "#facc15"), bar("sa-east", 12, "#94a3b8"),
  "</body></html>",
].join("");

const META = {
  sessionId: SESSION, channel: "json", cli: "claude", model: "claude-sonnet-5-5", modeName: "Claude Code",
  turnState: "idle", queueDepth: 0, queuedTurnIds: [], editingTurnIds: [], canSteer: true,
  commands: [], // catalog loaded: no "Skills loading..." hint under the composer
};

const CHAT_SCHEDULE = [
  { kind: "user", role: "user", text: "Run the full test suite and summarize anything that fails." },
  { kind: "text", role: "assistant", text: "Running it now. All 412 tests pass except `auth/refresh.test.ts`, which times out once under load. I'll re-run it in isolation." },
  { kind: "user", role: "user", text: "Thanks. Then update docs/PLAN.md with the result." },
  { kind: "text", role: "assistant", text: "Done: the isolated run passes, so I marked the flake in the plan and left a follow-up note." },
];

const CHAT_HTML = [
  { kind: "user", role: "user", text: "Give me a quick status card for the AUTH_V2 rollout." },
  { kind: "text", role: "assistant", text: `Here is the current rollout status:\n\n\`\`\`html\n${HTML_CARD}\n\`\`\`\n\nI can swap in live numbers once the metrics endpoint is wired up.` },
];

// ── REST / WS interception (adapted from capture-readme-screenshots.mjs) ───

/** Rewrite session records for `id` to the json channel, anywhere they appear in a JSON body. */
function asJsonChannel(node, id) {
  if (Array.isArray(node)) return node.map((n) => asJsonChannel(n, id));
  if (node && typeof node === "object") {
    const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, asJsonChannel(v, id)]));
    return out.id === id && "channel" in out ? { ...out, channel: "json" } : out;
  }
  return node;
}

/** Make SESSION a Rich Chat agent for this browser only: patch REST, answer chat:open with `chat`, then send meta. */
async function mockRichChat(page, chat) {
  const events = chat.map((e, i) => ({
    id: `demo-${i}`, sessionId: SESSION, provider: "claude", turnId: `demo-t${e.kind === "user" ? i : i - 1}`,
    ts: Date.now() - (chat.length - i) * 60_000, logSeq: i + 1, ...e,
  }));
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    if (!(res.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response: res });
    await route.fulfill({ response: res, json: asJsonChannel(await res.json(), SESSION) });
  });
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => ws.send(m));
    ws.onMessage((m) => {
      const msg = typeof m === "string" ? JSON.parse(m.startsWith("{") ? m : "{}") : {};
      if (msg.type === "chat:open" && msg.sessionId === SESSION) {
        ws.send(JSON.stringify({ type: "chat:replay", sessionId: SESSION, events, hasMore: false, oldestSeq: 1 }));
        ws.send(JSON.stringify({ type: "session:meta", sessionId: SESSION, meta: META }));
      } else server.send(m);
    });
  });
}

async function openApp(browser, { chat }) {
  const ctx = await browser.newContext({ viewport: { width: VIEW.w, height: VIEW.h }, deviceScaleFactor: RAW_DSF });
  await ctx.addInitScript((t) => localStorage.setItem("vibestation:theme", t), THEME);
  const page = await ctx.newPage();
  if (chat) await mockRichChat(page, chat); // before the routes below: later routes win
  await page.route("**/api/limits", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: limitsSnapshot() }) : route.continue());
  // The daemon's saved themeId wins over the localStorage hint; override it for this browser only.
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), themeId: THEME } });
  });
  await page.goto(`${LIVE_URL}/worktree/${WORKTREE}`);
  await page.waitForSelector('button[aria-label="Hide projects sidebar"]');
  // The seed session is "waiting" (red pane border); that status colour is unrelated to what these shots show.
  await page.addStyleTag({ content: ".agent-pane-slot { border-color: var(--border-default) !important; }" });
  await page.waitForTimeout(2500);
  return { ctx, page };
}

const union = (...rs) => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, width: Math.max(...rs.map((r) => r.x + r.width)) - x, height: Math.max(...rs.map((r) => r.y + r.height)) - y };
};
const pad = (r, p) => ({ x: r.x - p, y: r.y - p, width: r.width + 2 * p, height: r.height + 2 * p });
const inView = (r) => {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, width: Math.min(VIEW.w, r.x + r.width) - x, height: Math.min(VIEW.h, r.y + r.height) - y };
};
async function box(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

// ── shots ───────────────────────────────────────────────────────────────────

const SHOTS = [
  {
    file: "01-usage-limits.png",
    title: "usage limits",
    async run(browser) {
      const { ctx, page } = await openApp(browser, {});
      const chip = page.locator("button.limit-chip").first();
      await chip.waitFor();
      await chip.click();
      const dialog = page.locator('[role="dialog"]').last();
      await dialog.waitFor();
      await page.waitForTimeout(500);
      const clip = inView(pad(union(await box(chip), await box(dialog)), 28));
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await ctx.close();
      return clip;
    },
  },
  {
    file: "02-schedule-send.png",
    title: "composer",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { chat: CHAT_SCHEDULE });
      const composer = page.locator(".chat-composer").first();
      await composer.waitFor();
      await composer.click({ position: { x: 40, y: 24 } });
      await page.keyboard.type("Re-run the test suite tomorrow morning.");
      await page.locator('button[aria-label="Schedule send"]').first().click();
      const pop = page.locator('[aria-label="Schedule send"]').last();
      const t = new Date(Date.now() + 86_400_000);
      const p2 = (n) => String(n).padStart(2, "0");
      await pop.locator('input[type="datetime-local"]').fill(`${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}T09:00`);
      await page.waitForTimeout(600);
      const parts = [await box(composer)];
      const popBox = await pop.boundingBox();
      if (popBox) parts.push(popBox);
      const clip = inView(pad(union(...parts), 22));
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await ctx.close();
      return clip;
    },
  },
  {
    file: "03-html-preview.png",
    title: "chat",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { chat: CHAT_HTML });
      const block = page.locator(".html-block").first();
      await block.waitFor();
      await block.scrollIntoViewIfNeeded();
      await page.waitForTimeout(900); // sandboxed iframe paints after the tab mounts
      const b = pad(await box(block), 24);
      const clip = inView({ ...b, y: b.y - 12, height: b.height + 48 });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await ctx.close();
      return clip;
    },
  },
];

// ── framing: the website's small-feature "Mini" window (square hairline frame, 3 dots + mono title, L corners) ──

const LINE = "rgba(241,239,233,0.14)";
const LINE_STRONG = "rgba(241,239,233,0.32)";
const PAGE_PAD = 22; // stage px of dark margin so the corner marks (which sit on the frame edge) stay visible

function frameHtml(file, title, clip) {
  const w = clip.width * STAGE_SCALE;
  const h = clip.height * STAGE_SCALE;
  const barH = 6 + 6 + 10.5 * 1.6 + 1; // padding 6px 10px + line + divider
  const corner = (pos) => `<span style="position:absolute;width:9px;height:9px;${pos}"></span>`;
  const W = Math.ceil(w + 2 + 2 * PAGE_PAD);
  const H = Math.ceil(h + barH + 2 + 2 * PAGE_PAD);
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:${W}px;height:${H}px;background:#0a0a09;position:relative">
  <div style="position:absolute;left:${PAGE_PAD}px;top:${PAGE_PAD}px;width:${w}px;border:1px solid ${LINE};background:#111110;font-family:'JetBrains Mono','Fira Code','SF Mono',ui-monospace,monospace">
    <div style="display:flex;align-items:center;gap:5px;padding:6px 10px;border-bottom:1px solid ${LINE}">
      <span style="width:6px;height:6px;border-radius:50%;background:${LINE_STRONG}"></span>
      <span style="width:6px;height:6px;border-radius:50%;background:${LINE_STRONG}"></span>
      <span style="width:6px;height:6px;border-radius:50%;background:${LINE_STRONG}"></span>
      <em style="font-style:normal;margin-left:6px;font-size:10.5px;line-height:1.6;color:#5c584f">${title}</em>
    </div>
    <img src="${pathToFileURL(join(RAW_DIR, file)).href}" style="display:block;width:${w}px;height:${h}px">
    ${corner(`top:-1px;left:-1px;border-top:1px solid ${LINE_STRONG};border-left:1px solid ${LINE_STRONG}`)}
    ${corner(`top:-1px;right:-1px;border-top:1px solid ${LINE_STRONG};border-right:1px solid ${LINE_STRONG}`)}
    ${corner(`bottom:-1px;left:-1px;border-bottom:1px solid ${LINE_STRONG};border-left:1px solid ${LINE_STRONG}`)}
    ${corner(`bottom:-1px;right:-1px;border-bottom:1px solid ${LINE_STRONG};border-right:1px solid ${LINE_STRONG}`)}
  </div></body>`;
  return { html, W, H };
}

// ── main ────────────────────────────────────────────────────────────────────

const only = process.env.ONLY?.split(",");
const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOpts);
await rm(RAW_DIR, { recursive: true, force: true });
await mkdir(RAW_DIR, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

try {
  const clips = new Map();
  for (const s of SHOTS.filter((s) => !only || only.includes(s.file))) {
    clips.set(s, await s.run(browser));
    console.log(`captured ${s.file} (${Math.round(clips.get(s).width)}x${Math.round(clips.get(s).height)} css px)`);
  }
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: OUT_DSF });
  const page = await ctx.newPage();
  for (const [s, clip] of clips) {
    const { html, W, H } = frameHtml(s.file, s.title, clip);
    const htmlPath = join(RAW_DIR, `${s.file}.html`);
    await writeFile(htmlPath, html);
    await page.setViewportSize({ width: W, height: H });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    await page.screenshot({ path: join(OUT_DIR, s.file) });
    console.log(`framed ${s.file}`);
  }
  await ctx.close();
} finally {
  await browser.close();
  if (!process.env.KEEP_RAW) await rm(RAW_DIR, { recursive: true, force: true });
}
