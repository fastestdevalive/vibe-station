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
 *   RELEASE            release tag: selects the shots below and the folder under docs/screenshots/release/ (default v0.0.4-beta)
 *   PLAYWRIGHT_MODULE  module to import Playwright from (default "@playwright/test")
 *   CHROMIUM_PATH      optional explicit chromium / headless-shell executable
 *   ONLY               comma-separated output file names to produce (default: all)
 *   KEEP_RAW=1         keep the unframed crops in the temp dir
 *
 * The limits snapshot, chat histories, extra modes (incl. oh-my-pi), a superseded "previous" session record and the
 * artifacts list are injected for this browser only (REST + WS interception), so no real accounts are needed. The
 * review-comment shots (v0.0.4-beta 05/06) create real comments in the sandbox through the UI and delete exactly
 * those afterwards: point LIVE_URL at a throwaway sandbox, never at a daemon you use.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = process.env.RELEASE ?? "v0.0.4-beta";
const OUT_DIR = join(ROOT, "docs", "screenshots", "release", RELEASE);
const RAW_DIR = process.env.RAW_DIR ?? join(tmpdir(), "vst-release-raw");
const LIVE_URL = process.env.LIVE_URL ?? "http://localhost:7190";

const VIEW = { w: 1440, h: 810 };
const RAW_DSF = 1.6;
const STAGE_SCALE = 1120 / 1440; // README/website stage: 1120px wide for a 1440px app viewport
const OUT_DSF = 2;
const THEME = "vibestation-dark"; // default; a shot can pass `theme` to openApp (e.g. LIGHT)
const LIGHT = "vibestation-light";
// Window background (v0.0.7 wallpapers). Shots for earlier releases use the solid background those releases had.
const SOLID = { mode: "solid", wallpaperId: null, texture: "none" };
const MISTY = { mode: "wallpaper", wallpaperId: "wp-009", texture: "grain" }; // "Misty Mountain Clouds"
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
      // Per-account limits for the injected demo accounts (ACCOUNTS below).
      { ...res("claude", [win("claude", "five_hour", 300, 18, 3.6), win("claude", "seven_day", 10080, 34, 96)]), accountId: "acc_0a1b2c3d" },
      { ...res("claude", [win("claude", "five_hour", 300, 93, 0.7), win("claude", "seven_day", 10080, 72, 40)]), accountId: "acc_4e5f6a7b" },
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

// v0.0.4-beta: more modes (incl. the new oh-my-pi harness), and a superseded predecessor of SESSION for the
// start-fresh / previous-sessions shots. Injected for this browser only.
const EXTRA_MODES = [
  { id: "mode-codex-001", name: "Codex", cli: "codex", context: "", icon: "codex" },
  { id: "mode-omp-001", name: "oh-my-pi", cli: "omp", context: "", icon: "omp" },
  { id: "mode-opencode-001", name: "OpenCode", cli: "opencode", context: "", icon: "opencode" },
];
const PREV = "napi-1-prev";
const HANDOFF_SUMMARY = [
  "Goal: JWT auth middleware for northstar-api.",
  "Done: verifyToken(), authMiddleware.ts on /users,",
  "      9 auth tests passing.",
  "Open: refresh-token rotation, API.md auth docs.",
].join("\n");
const PREV_SESSION = {
  id: PREV, worktreeId: WORKTREE, projectId: "northstar-api", isMain: false, type: "agent", modeId: "mode-cursor-001",
  modeIcon: "cursor", name: "auth middleware", nameSource: "user", tmuxName: null, useTmux: false, channel: "json",
  state: "exited", lifecycleState: "exited", createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), pinnedAt: null,
  archivedAt: new Date(new Date().setHours(10, 42, 0, 0)).toISOString(), /* a fixed daytime clock reading */ sortOrder: 0, handoffSummary: HANDOFF_SUMMARY,
  carryOver: "summary", parentSessionId: null, supersededBy: SESSION, pr: null, draftPrompt: null, draftConfig: null,
  lastActivityAt: null, lastLine: null, lastTool: null,
};
const CHAT_PREV = [
  { kind: "user", role: "user", text: "Add JWT auth middleware and protect the /users routes." },
  { kind: "text", role: "assistant", text: "Added `verifyToken()` in `src/utils/jwt.ts` and `authMiddleware.ts`, then mounted it on the `/users` router. Unauthenticated requests now get a 401 with a JSON error body." },
  { kind: "user", role: "user", text: "Cover it with tests, including an expired token." },
  { kind: "text", role: "assistant", text: "Added 9 cases to `tests/auth.test.ts` (valid, missing, malformed and expired tokens, wrong audience). All pass. Expired tokens still return 401; tell me if you want 403 there instead." },
  { kind: "user", role: "user", text: "Keep 401. What is left before we can ship it?" },
  { kind: "text", role: "assistant", text: "Two things:\n\n1. **Refresh-token rotation.** Refresh tokens are long-lived and never rotated yet.\n2. **Docs.** `docs/API.md` does not mention the `Authorization` header on the `/users` routes.\n\nI can start with the rotation." },
];
const CHAT_AFTER_SWITCH = [
  { kind: "session_break", role: "system", breakKind: "switch", carryOver: "summary", fromMode: "Cursor Agent", toMode: "Claude Code", fromProvider: "cursor", toProvider: "claude", text: HANDOFF_SUMMARY },
  { kind: "user", role: "user", text: "Pick up the refresh-token rotation from the summary." },
  { kind: "text", role: "assistant", text: "On it. I'll add a `refresh_tokens` table, rotate on every use and revoke the whole family when a reused token shows up." },
];
const INJECT_PREV = { sessions: [PREV_SESSION], modes: EXTRA_MODES };

/** Artifacts list (08): rows for real demo files, injected for this browser only (the sandbox has no captured runs). */
function artifactRows() {
  const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const row = (id, displayPath, kind, size, editCount, writers, min, extra = {}) => ({
    id, scopeKind: "worktree", scopeId: WORKTREE, path: `/home/vst/projects/northstar-api/${displayPath}`, displayPath,
    inRepo: true, kind, size, state: "ok", pinned: false, editCount, writers, addedVia: "capture",
    createdAt: at(min + 30), lastWrittenAt: at(min), ...extra,
  });
  const items = [
    row("art-plan", "docs/PLAN.md", "doc", 4210, 3, [SESSION], 2, { pinned: true }),
    row("art-mw", "src/middleware/authMiddleware.ts", "other", 1388, 4, [SESSION, PREV], 6),
    row("art-jwt", "src/utils/jwt.ts", "other", 1675, 2, [PREV], 11),
    row("art-test", "tests/auth.test.ts", "other", 2934, 3, [PREV, SESSION], 14),
    row("art-api", "docs/API.md", "doc", 3120, 1, [SESSION], 19, { addedVia: "cli" }),
    row("art-users", "src/routes/users.ts", "other", 912, 1, ["napi-1-a1"], 41),
  ];
  return { rev: 1, cap: 500, total: items.length, items };
}

/** Updates (v0.0.5): a curl install one release behind, injected for this browser only. The changelog is the
 *  v0.0.5-beta notes file itself. */
const UPDATE_STATUS = {
  current: "0.0.4-beta", latest: "0.0.5-beta", behindCount: 1, updateAvailable: true, skipped: [],
  changelog: readFileSync(join(ROOT, ".github", "release-notes", "v0.0.5-beta.md"), "utf8"),
  releaseUrl: "https://github.com/fastestdevalive/vibe-station/releases/tag/v0.0.5-beta",
  installMethod: "curl", targets: [{ method: "curl", path: "~/.local/bin/vst", version: "0.0.4-beta", auto: true }],
  checkedAt: new Date().toISOString(), autoCheck: true, platform: "darwin-aarch64", noAsset: false, canInstall: true,
};
const UPDATE_ROUTE = ["**/api/update/check**", (r) => r.fulfill({ json: UPDATE_STATUS })];

/** Find in chat (v0.0.6): answer the transcript search route from an injected chat (as replayed by mockRichChat:
 *  seq = index + 1, a new turn at each user row), case-insensitive substring like `lib/findTerms.ts`. */
function searchPage(chat, q) {
  const term = q.trim().toLowerCase();
  const matches = [];
  let turn = 0;
  chat.forEach((e, i) => {
    if (e.kind === "user") turn++;
    if (!term || (e.kind !== "user" && e.kind !== "text")) return;
    const lower = e.text.toLowerCase();
    let at = lower.indexOf(term), occurrence = 0;
    while (at !== -1) {
      const from = Math.max(0, at - 28), to = Math.min(e.text.length, at + term.length + 40);
      matches.push({
        seq: i + 1, turnId: `demo-t${e.kind === "user" ? i : i - 1}`, turnIndex: turn, kind: e.kind, occurrence: occurrence++,
        snippet: [{ text: (from ? "…" : "") + e.text.slice(from, at) }, { text: e.text.slice(at, at + term.length), hit: true }, { text: e.text.slice(at + term.length, to) + (to < e.text.length ? "…" : "") }],
      });
      at = lower.indexOf(term, at + 1);
    }
  });
  return { query: q, total: matches.length, totalCapped: false, matches, backfilling: false, turnCount: turn };
}

/** Accounts (v0.0.6/v0.0.7): the System login plus two named Claude accounts, labels only (no emails), injected for
 *  this browser only. Their limits are in limitsSnapshot(). */
const ACCOUNTS = [
  { id: "system", cli: "claude", label: null, displayName: "System login", email: null, plan: null, method: "system", auth: "signed_in", isDefault: true, limited: null, createdAt: null, dir: "~/.claude", createdByUs: false, pending: false, signIn: null },
  { id: "acc_0a1b2c3d", cli: "claude", label: "Work", displayName: "Work", email: null, plan: "Max", method: "sign_in", auth: "signed_in", isDefault: false, limited: null, createdAt: "2026-11-02T09:00:00Z", dir: "~/.vibe-station/accounts/claude/acc_0a1b2c3d", createdByUs: true, pending: false, signIn: null },
  { id: "acc_4e5f6a7b", cli: "claude", label: "Side project", displayName: "Side project", email: null, plan: "Pro", method: "sign_in", auth: "signed_in", isDefault: false, limited: null, createdAt: "2026-11-09T09:00:00Z", dir: "~/.vibe-station/accounts/claude/acc_4e5f6a7b", createdByUs: true, pending: false, signIn: null },
];
const ACCOUNTS_ROUTE = ["**/api/accounts", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { accounts: ACCOUNTS } }) : r.continue())];

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

/** Present each session in `chats` (id -> events) as a Rich Chat agent for this browser only: patch REST (plus the
 *  `inject` extras: session records appended to /api/sessions, modes to /api/modes, per-id session patches), answer
 *  chat:open with the events, then send meta. */
async function mockRichChat(page, chats, inject = {}) {
  const replay = Object.fromEntries(Object.entries(chats).map(([sid, chat]) => [sid, chat.map((e, i) => ({
    id: `demo-${sid}-${i}`, sessionId: sid, provider: "claude", turnId: `demo-t${e.kind === "user" ? i : i - 1}`,
    ts: Date.now() - (chat.length - i) * 60_000, logSeq: i + 1, ...e,
  }))]));
  const ids = Object.keys(chats);
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    if (!(res.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response: res });
    let json = await res.json();
    for (const id of ids) json = asJsonChannel(json, id);
    const path = new URL(route.request().url()).pathname;
    if (Array.isArray(json) && /\/api\/sessions$/.test(path) && inject.sessions) {
      const scope = new URL(route.request().url()).searchParams.get("worktree");
      json = [...json, ...inject.sessions.filter((s) => !scope || s.worktreeId === scope)];
    }
    if (Array.isArray(json) && /\/api\/modes$/.test(path) && inject.modes) json = [...json, ...inject.modes];
    if (inject.patch) json = patchById(json, inject.patch);
    await route.fulfill({ response: res, json });
  });
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => ws.send(m));
    ws.onMessage((m) => {
      const msg = typeof m === "string" ? JSON.parse(m.startsWith("{") ? m : "{}") : {};
      if (msg.type === "chat:open" && replay[msg.sessionId]) {
        const sid = msg.sessionId;
        ws.send(JSON.stringify({ type: "chat:replay", sessionId: sid, events: replay[sid], hasMore: false, oldestSeq: 1 }));
        ws.send(JSON.stringify({ type: "session:meta", sessionId: sid, meta: { ...META, sessionId: sid, ...(inject.meta?.[sid] ?? {}) } }));
      } else server.send(m);
    });
  });
}

/** Shallow-merge `patch[id]` into every record with that id (session lists, single records). */
function patchById(node, patch) {
  if (Array.isArray(node)) return node.map((n) => patchById(n, patch));
  if (node && typeof node === "object") {
    const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, patchById(v, patch)]));
    return patch[out.id] && "worktreeId" in out ? { ...out, ...patch[out.id] } : out;
  }
  return node;
}

async function openApp(browser, { chat, chats, inject, route, routes = [], path = `/worktree/${WORKTREE}`, patchSessions = false, hideTools = false, theme = THEME, viewport = VIEW, isMobile = false, background = SOLID }) {
  const ctx = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: RAW_DSF, isMobile, hasTouch: isMobile });
  await ctx.addInitScript((t) => localStorage.setItem("vibestation:theme", t), theme);
  // Background prefs live in this browser's storage (keyed by daemon origin). Seed them once per context so a shot
  // never shows the random first-run wallpaper; later picks made through the UI are kept across navigations.
  await ctx.addInitScript(([key, prefs]) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(prefs)); },
    [`vst.background.v1:${new URL(LIVE_URL).origin}`, { v: 2, rolled: true, picked: true, agentWallpapers: false, ...background }]);
  const page = await ctx.newPage();
  const allChats = chats ?? (chat ? { [SESSION]: chat } : null);
  if (allChats || inject) await mockRichChat(page, allChats ?? {}, inject); // before the routes below: later routes win
  await page.route("**/api/limits", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: limitsSnapshot() }) : route.continue());
  // The daemon's saved themeId wins over the localStorage hint; override it for this browser only.
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), themeId: theme } });
  });
  if (route) await page.route(...route);
  for (const r of routes) await page.route(...r);
  if (patchSessions) await page.route(/\/api\/sessions(\?.*)?$/, decorateSessions);
  await page.goto(`${LIVE_URL}${path}`);
  await page.waitForSelector(isMobile ? "#root *" : 'button[aria-label="Hide projects sidebar"]');
  // The seed session is "waiting" (red pane border); that status colour is unrelated to what these shots show.
  await page.addStyleTag({ content: ".agent-pane-slot { border-color: var(--border-default) !important; }" });
  await page.waitForTimeout(2500);
  if (hideTools) {
    await page.locator('button[aria-label^="Toggle tool panel"][aria-pressed="true"]').first().click();
    await page.waitForTimeout(600);
  }
  if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-open-${Date.now()}.png`) });
  return { ctx, page };
}

/** Popover + the composer's input box (not its hint line), padded inside the pane: no border or status-bar slivers. */
async function mentionClip(page, pop) {
  const p = await box(pop);
  const send = await box(page.locator(".chat-composer__send").first());
  return inView({ x: p.x - 10, y: p.y - 10, width: p.width + 20, height: send.y + send.height + 14 - (p.y - 10) });
}

/** Comment shots: open a demo file in the preview, fullscreen that pane (wide code), and add comments through the
 *  real UI (gutter "+" then Cmd+Enter). Comments are real daemon rows in the sandbox; `deleteSeededComments` removes
 *  exactly the ones these shots created (matched by text) so reruns start clean. */
const COMMENT_TEXTS = {
  missing: "Return a machine-readable code too, e.g. { error, code: \"missing_token\" }.",
  expired: "Expired tokens should say so; clients need it to trigger a refresh.",
  roles: "requireRole() never runs if this is skipped. Add a test for a token without roles.",
  draft: "Catch the throw from verifyAccess() and map it to a 401 instead of a 500.",
};
async function openPreviewFile(page, dirs, file) {
  for (const d of dirs) {
    const node = page.getByText(d, { exact: true }).first();
    await node.click();
    await page.waitForTimeout(250);
  }
  await page.getByText(file, { exact: true }).first().click();
  await page.locator('button[aria-label="Add comment on line 1"]').waitFor({ state: "attached" });
  await page.waitForTimeout(800);
}
async function fullscreenPreview(page) {
  const btns = page.locator('button[aria-label="Fullscreen"]');
  for (let i = 0; i < (await btns.count()); i++) {
    const b = await btns.nth(i).boundingBox();
    if (b && b.x > 1000 && b.x < 1200) { await btns.nth(i).click(); break; }
  }
  await page.waitForTimeout(800);
}
async function addComment(page, line, text) {
  await page.locator(`button[aria-label="Add comment on line ${line}"]`).click({ force: true });
  await page.locator('[data-comment-box="new"]').waitFor();
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press("Meta+Enter");
  await page.locator('[data-comment-box="new"]').waitFor({ state: "detached" });
  await page.waitForTimeout(400);
}
async function deleteSeededComments(page) {
  const texts = new Set(Object.values(COMMENT_TEXTS));
  const res = await page.request.get(`${LIVE_URL}/api/worktrees/${WORKTREE}/comments`);
  if (!res.ok()) return;
  const body = await res.json();
  for (const c of body.comments ?? []) {
    if (texts.has(c.text)) await page.request.delete(`${LIVE_URL}/api/comments/${encodeURIComponent(c.id)}`, { headers: { "x-vst-csrf": "1" } });
  }
}

/** Settings > Background: one of the picker's collapsible sections ("Wallpaper", "Texture", "Gradient"...). */
const sectionToggle = (page, title) => page.locator(".wp-section__head").filter({ has: page.locator(".wp-section__label", { hasText: new RegExp(`^${title}$`) }) }).first();
async function openSection(page, title) {
  const head = sectionToggle(page, title);
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await page.waitForTimeout(300);
}
/** Pick a fixed wallpaper and texture through the real picker (stored in this browser only), so shots are stable
 *  instead of showing the random first-run pick. Leaves the Wallpaper and Texture sections open. */
async function pickBackground(page, wallpaper, texture) {
  await page.locator(".wp-picker").first().waitFor();
  await openSection(page, "Wallpaper");
  await page.locator(`.wp-thumb[aria-label="${wallpaper}"]`).first().click();
  await openSection(page, "Texture");
  await page.locator(".wp-tile").filter({ hasText: new RegExp(`^${texture}$`) }).first().click();
  await page.waitForTimeout(600);
}

/** "Create new agent" opens a real (global) draft session; shots delete exactly the drafts they created. */
async function draftIds(page) {
  const res = await page.request.get(`${LIVE_URL}/api/sessions`);
  return new Set((await res.json()).filter((s) => s.state === "drafting").map((s) => s.id));
}
async function deleteGlobalDrafts(page, before) {
  for (const id of await draftIds(page)) {
    if (!before.has(id) && id.startsWith("global-")) await page.request.delete(`${LIVE_URL}/api/sessions/${encodeURIComponent(id)}`, { headers: { "x-vst-csrf": "1" } });
  }
}

/** Compose several raw crops (same RAW_DSF) side by side, bottom-aligned, into RAW_DIR/<file>; returns its css box
 *  so the framing step treats it like any other clip. The gap shows the frame's own inner background. */
async function sideBySide(browser, file, parts, gap = 18) {
  const W = parts.reduce((s, p) => s + p.w, 0) + gap * (parts.length + 1);
  const H = Math.max(...parts.map((p) => p.h)) + gap * 2;
  const imgs = parts.map((p) => `<img src="${pathToFileURL(join(RAW_DIR, p.file)).href}" style="width:${p.w}px;height:${p.h}px;display:block;outline:1px solid rgba(241,239,233,0.14)">`).join("");
  const html = `<!doctype html><body style="margin:0;width:${W}px;height:${H}px;background:#111110;display:flex;align-items:flex-end;gap:${gap}px;padding:${gap}px;box-sizing:border-box">${imgs}</body>`;
  const htmlPath = join(RAW_DIR, `${file}.compose.html`);
  await writeFile(htmlPath, html);
  const ctx = await browser.newContext({ viewport: { width: Math.ceil(W), height: Math.ceil(H) }, deviceScaleFactor: RAW_DSF });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(htmlPath).href);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path: join(RAW_DIR, file) });
  await ctx.close();
  return { x: 0, y: 0, width: Math.ceil(W), height: Math.ceil(H) };
}

/** Close a capture context without in-flight route callbacks throwing after the page is gone. */
async function closeCtx(ctx) {
  for (const p of ctx.pages()) await p.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
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


/** Dashboard shot: make the seed agents look like live Rich Chat sessions (tool activity, recent activity, PR chips). */
const TOOLS = [
  { name: "Edit", detail: "authMiddleware.ts" },
  { name: "Bash", detail: "pnpm" },
  { name: "Read", detail: "schema.prisma" },
  { name: "Grep" },
];
const PRS = {
  // main-session id -> PR (prBranch must equal the worktree's branch, see AGENTS.md "Status indicators")
  "napi-1-m": { state: "open", number: 142, branch: "feat/auth-middleware" },
  "atls-2-m": { state: "open", number: 57, branch: "refactor/component-library" },
  "frge-2-m": { state: "merged", number: 31, branch: "docs/api-reference" },
};
async function decorateSessions(route) {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  const sessions = await res.json();
  let i = 0;
  const out = sessions.map((s) => {
    if (s.type !== "agent") return s;
    const pr = PRS[s.id];
    const live = s.state === "working" || s.state === "waiting_for_human";
    const n = live ? i++ : -1;
    return {
      ...s,
      channel: "json",
      lastActivityAt: new Date(Date.now() - (n < 0 ? 40 : 2 + 4 * n) * 60_000).toISOString(),
      lastTool: live ? TOOLS[n % TOOLS.length] : null,
      ...(pr ? { pr: { state: pr.state, number: pr.number, url: `https://github.com/acme/repo/pull/${pr.number}`, checkedAt: new Date().toISOString(), prBranch: pr.branch } } : {}),
    };
  });
  await route.fulfill({ response: res, json: out });
}

// ── shots ───────────────────────────────────────────────────────────────────

const SHOTS = [
  // ── v0.0.1-beta ──
  {
    release: "v0.0.1-beta",
    file: "01-subagents.png",
    title: "subagents",
    async run(browser) {
      // The worktree's two demo agents, linked as subagents of the main session for this browser only.
      const patch = {
        "napi-1-a1": { parentSessionId: SESSION, name: "auth tests", nameSource: "user" },
        "napi-1-a2": { parentSessionId: SESSION, name: "API docs", nameSource: "user" },
      };
      const { ctx, page } = await openApp(browser, { chats: { [SESSION]: CHAT_SCHEDULE }, inject: { patch }, theme: LIGHT });
      const row = page.locator(".chat-subagent-row").first();
      await row.waitFor();
      await page.mouse.move(1300, 700);
      await page.waitForTimeout(900);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      // The parent's chat pane: its tab strip (with the subagents' tabs), the chat, the subagent row and the composer.
      const pane = await box(page.locator(".agent-pane-slot").first());
      const c = await box(page.locator(".chat-composer").first());
      const clip = inView({ x: pane.x, y: 0, width: pane.width, height: c.y + c.height + 2 });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.1-beta",
    file: "02-code-outline.png",
    title: "code navigation",
    async run(browser) {
      const { ctx, page } = await openApp(browser, {});
      await openPreviewFile(page, ["src", "middleware"], "authMiddleware.ts");
      await page.getByRole("button", { name: "Outline" }).first().click();
      // Symbols from the language server (needs LSP on for the worktree and typescript-language-server installed).
      await page.locator('[aria-label="Outline panel"]').getByText("requireRole", { exact: false }).first().waitFor({ timeout: 60_000 });
      await page.mouse.move(700, 790);
      await page.waitForTimeout(1500);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      // The code preview and the outline beside it (symbols from the language server).
      const body = await box(page.locator(".preview-body").first());
      const x = body.x - 1;
      const clip = inView({ x, y: 0, width: VIEW.w - x, height: 560 });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.1-beta",
    file: "03-mobile.png",
    title: "mobile",
    async run(browser) {
      const phoneView = { w: 390, h: 844 };
      const { ctx, page } = await openApp(browser, { path: "/", viewport: phoneView, isMobile: true });
      await page.waitForTimeout(1500);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      await page.screenshot({ path: join(RAW_DIR, this.file) });
      await closeCtx(ctx);
      return { x: 0, y: 0, width: phoneView.w, height: phoneView.h };
    },
  },
  // ── v0.0.5-beta ──
  {
    release: "v0.0.5-beta",
    file: "01-update.png",
    title: "updates",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { theme: LIGHT, routes: [UPDATE_ROUTE] });
      const chip = page.locator(".update-chip__main").first();
      await chip.waitFor();
      await page.waitForTimeout(600);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-chip-${this.file}`) });
      await chip.click();
      const dialog = page.locator('[role="dialog"]').last();
      await dialog.waitFor();
      await page.waitForTimeout(900);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      // The chip in the top bar and the dialog it opened.
      const chipBox = await box(page.locator(".update-chip").first());
      const skip = await box(page.locator(".update-chip__skip").first());
      const u = pad(union(chipBox, await box(dialog)), 22);
      const clip = inView({ ...u, width: skip.x + skip.width + 8 - u.x }); // stop before the search button
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  // ── v0.0.6-beta ──
  {
    release: "v0.0.6-beta",
    file: "01-accounts.png",
    title: "accounts",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { path: "/settings/modes", theme: LIGHT, routes: [ACCOUNTS_ROUTE] });
      await page.locator('[data-testid="harness-tab-claude"]').click();
      const add = page.getByRole("button", { name: "Add account" }).first();
      await add.waitFor();
      await page.waitForTimeout(1200);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const tabs = await box(page.locator('[role="tablist"][aria-label="Harnesses"]').first());
      // Down to the end of the accounts block: the "Claude modes" heading follows it.
      const modes = await box(page.getByText("Claude modes", { exact: true }).first());
      const clip = inView({ x: tabs.x - 16, y: tabs.y - 14, width: tabs.width + 32, height: modes.y - 14 - (tabs.y - 14) });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.6-beta",
    file: "02-find-in-chat.png",
    title: "find in chat",
    async run(browser) {
      const { ctx, page } = await openApp(browser, {
        chats: { [SESSION]: CHAT_PREV }, theme: LIGHT, hideTools: true,
        routes: [[/\/api\/sessions\/[^/]+\/transcript\/search/, (r) => r.fulfill({ json: searchPage(CHAT_PREV, new URL(r.request().url()).searchParams.get("q") ?? "") })]],
      });
      await page.locator(".chat-composer").first().waitFor();
      await page.getByRole("button", { name: "Find in chat" }).first().click();
      await page.keyboard.type("token", { delay: 40 });
      await page.waitForTimeout(900);
      await page.getByRole("button", { name: /^List matches/ }).first().click();
      await page.waitForTimeout(900);
      await page.mouse.move(5, 400);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const pane = await box(page.locator(".agent-pane-slot").first());
      // Down to just below the results list (the chat's empty space and composer are not part of this feature).
      const list = await box(page.locator(".fpop").first());
      const clip = inView({ x: pane.x, y: pane.y, width: pane.width, height: Math.min(pane.height, list.y + list.height + 60 - pane.y) });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.6-beta",
    file: "03-tools-pane.png",
    title: "tools pane",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { theme: LIGHT });
      await openPreviewFile(page, ["src", "middleware"], "authMiddleware.ts");
      await page.mouse.move(700, 790);
      await page.waitForTimeout(800);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      // The preview pane (tab, file strip with back/forward, name and +/- counts) and the Files/Changes list beside it.
      const body = await box(page.locator(".preview-body").first());
      const x = body.x - 1;
      const clip = inView({ x, y: 0, width: VIEW.w - x, height: 300 });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  // ── v0.0.7-beta ──
  {
    release: "v0.0.7-beta",
    file: "01-wallpaper-picker.png",
    title: "background",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { path: "/settings/background", theme: LIGHT, background: MISTY });
      await pickBackground(page, "Misty Mountain Clouds", "Halftone");
      await sectionToggle(page, "Texture").click(); // fold it again: the shot shows the wallpaper grid
      await page.waitForTimeout(400);
      await page.mouse.move(5, 400);
      await page.locator(".bg-setting").first().evaluate((el) => {
        for (let n = el; n; n = n.parentElement) n.scrollTop = 0;
      });
      await page.waitForTimeout(2000); // thumbnails
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const s = await box(page.locator(".bg-setting").first());
      // Down to the third row of thumbnails (rows are measured, the grid is responsive).
      const bottom = await page.locator(".wp-grid .wp-thumb").evaluateAll((els) => {
        const rows = [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().bottom)))].sort((a, b) => a - b);
        return rows[Math.min(2, rows.length - 1)];
      });
      const clip = inView({ x: s.x - 18, y: s.y - 14, width: s.width + 36, height: bottom + 6 - (s.y - 14) });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.7-beta",
    file: "02-wallpaper-window.png",
    title: "wallpaper",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { path: "/settings/background", chats: { [SESSION]: CHAT_SCHEDULE }, background: MISTY });
      const before = await draftIds(page);
      await pickBackground(page, "Reflections snowy mountains reflect calm", "Grain");
      // Same page (client-side route): the picked background stays in this browser's storage.
      await page.getByRole("button", { name: "Create new agent" }).first().click(); // client-side: the empty new-agent chat
      await page.waitForTimeout(1500);
      await page.mouse.move(700, 790);
      await page.waitForTimeout(3000); // full-size image + texture bake
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const clip = inView({ x: 0, y: 0, width: VIEW.w, height: VIEW.h });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await deleteGlobalDrafts(page, before);
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.7-beta",
    file: "03-drafts-sync.png",
    title: "drafts",
    async run(browser) {
      // Two browsers on the same session (a desktop window and a phone): text typed on the desktop shows up in the
      // phone's composer through the daemon's draft-text sync. The draft row is real; it is cleared afterwards.
      const chats = { [SESSION]: CHAT_PREV };
      const phoneView = { w: 390, h: 844 };
      const desk = await openApp(browser, { chats, theme: LIGHT, background: MISTY });
      const phone = await openApp(browser, { chats, theme: LIGHT, viewport: phoneView, isMobile: true, hideTools: true, background: MISTY });
      const text = "After the flake fix, bump the refresh-token TTL to 14 days and note it in docs/API.md.";
      const composer = desk.page.locator(".chat-composer").first();
      await composer.waitFor();
      await composer.click({ position: { x: 40, y: 24 } });
      await desk.page.keyboard.type(text, { delay: 8 });
      await phone.page.getByText("bump the refresh-token TTL", { exact: false }).first().waitFor({ timeout: 15_000 });
      for (const pg of [desk.page, phone.page]) {
        // The pane's font-zoom overlay sits on the last bubble; it is not part of this feature.
        await pg.addStyleTag({ content: ".chat-font-overlay { display: none !important; }" });
        await pg.mouse.move(2, 2);
        await pg.waitForTimeout(800);
      }
      if (process.env.FULL) {
        await desk.page.screenshot({ path: join(RAW_DIR, `full-desk-${this.file}`) });
        await phone.page.screenshot({ path: join(RAW_DIR, `full-phone-${this.file}`) });
      }
      // Phone: its agent pane (tab strip to the composer's hint line). Desktop: the chat pane, same height, ending
      // just below its composer.
      const pp = await box(phone.page.locator(".agent-pane-slot").first());
      const pc = await box(phone.page.locator(".chat-composer").first());
      const phoneClip = { x: pp.x, y: pp.y, width: pp.width, height: pc.y + pc.height + 2 - pp.y };
      const pane = await box(desk.page.locator(".agent-pane-slot").first());
      const c = await box(composer);
      const bottom = c.y + c.height + 2;
      const deskClip = inView({ x: pane.x, y: bottom - phoneClip.height, width: pane.width, height: phoneClip.height });
      await desk.page.screenshot({ path: join(RAW_DIR, `a-${this.file}`), clip: deskClip });
      await phone.page.screenshot({ path: join(RAW_DIR, `b-${this.file}`), clip: phoneClip });
      await desk.page.request.put(`${LIVE_URL}/api/draft-texts/${encodeURIComponent(SESSION)}`, {
        headers: { "x-vst-csrf": "1" }, data: { text: "", clientId: "release-screenshots" },
      });
      await closeCtx(desk.ctx);
      await closeCtx(phone.ctx);
      return sideBySide(browser, this.file, [
        { file: `a-${this.file}`, w: deskClip.width, h: deskClip.height },
        { file: `b-${this.file}`, w: phoneClip.width, h: phoneClip.height },
      ]);
    },
  },
  {
    release: "v0.0.7-beta",
    file: "04-account-picker.png",
    title: "accounts",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { chats: { [SESSION]: CHAT_SCHEDULE }, theme: LIGHT, routes: [ACCOUNTS_ROUTE], background: MISTY });
      await page.locator(".chat-composer").first().waitFor();
      await page.locator(".session-account__btn").first().click();
      const menu = page.locator('[role="menu"]').last();
      await menu.waitFor();
      await page.waitForTimeout(800);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const c = await box(page.locator(".chat-composer").first());
      const m = await box(menu);
      const u = union(c, m);
      const clip = inView({ x: c.x - 14, y: m.y - 16, width: u.x + u.width + 14 - (c.x - 14), height: u.y + u.height + 1 - (m.y - 16) });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.4-beta",
    file: "01-start-fresh.png",
    title: "start fresh",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { chats: { [SESSION]: CHAT_SCHEDULE }, inject: { modes: EXTRA_MODES } });
      await page.locator(".chat-composer").first().waitFor();
      await page.locator(".chat-model-switch__button").first().click();
      await page.getByText("Start fresh with summary…", { exact: true }).click();
      const dialog = page.locator(".fresh-dialog").first();
      await dialog.waitFor();
      await page.waitForTimeout(600);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const clip = inView(pad(await box(dialog), 18));
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.4-beta",
    file: "02-previous-session.png",
    title: "previous sessions",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { chats: { [SESSION]: CHAT_AFTER_SWITCH, [PREV]: CHAT_PREV }, inject: INJECT_PREV });
      const trigger = page.locator('button[aria-label="Previous sessions"]').first();
      await trigger.waitFor();
      await trigger.click();
      await page.locator(".prev-session__open").first().click(); // open the superseded chat read-only
      await page.locator(".chat-composer--archived").first().waitFor();
      await page.waitForTimeout(800);
      await trigger.click();
      const menu = page.locator("[data-previous-sessions-panel]").first();
      await menu.waitFor();
      await page.waitForTimeout(400);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-menu-${this.file}`) });
      
      await menu.locator(".prev-session__toggle").first().click(); // show the handoff summary
      await page.waitForTimeout(500);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      // The read-only chat (tab strip down to the archived notice) with the menu beside it over the empty preview pane.
      const pane = await box(page.locator(".agent-pane-slot").first());
      const m = await box(menu);
      // The pane's font-zoom overlay sits on the first bubble; it is not part of this feature.
      await page.evaluate(() => document.querySelectorAll('button[aria-label="Decrease chat font"]').forEach((b) => { b.parentElement.style.display = "none"; }));
      await page.waitForTimeout(300);
      const clip = inView({ x: pane.x - 1, y: 0, width: m.x + m.width + 16 - (pane.x - 1), height: pane.y + pane.height + 1 });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.4-beta",
    file: "03-mentions-projects-agents.png",
    title: "mentions",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { chats: { [SESSION]: CHAT_SCHEDULE } });
      const composer = page.locator(".chat-composer").first();
      await composer.click({ position: { x: 40, y: 24 } });
      await page.keyboard.type("Ask ", { delay: 20 });
      await page.keyboard.type("@agents:", { delay: 40 });
      const pop = page.locator(".chat-mention-popover").first();
      await pop.waitFor();
      await page.waitForTimeout(900);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const clip = await mentionClip(page, pop);
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.4-beta",
    file: "04-mentions-files.png",
    title: "mentions",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { chats: { [SESSION]: CHAT_SCHEDULE } });
      const composer = page.locator(".chat-composer").first();
      const pop = page.locator(".chat-mention-popover").first();
      await composer.click({ position: { x: 40, y: 24 } });
      const pick = async (query, label) => {
        await page.keyboard.type(query, { delay: 40 });
        await pop.waitFor();
        const row = pop.locator(".chat-mention-popover__option", { hasText: label }).first();
        await row.waitFor();
        await row.click();
        await page.waitForTimeout(300);
      };
      await page.keyboard.type("Compare ", { delay: 20 });
      await pick("@authMid", "authMiddleware.ts");
      await page.keyboard.type("with ", { delay: 20 });
      await pick("@jwt", "jwt.ts");
      await page.keyboard.type("and update the tests in ", { delay: 20 });
      await page.keyboard.type("@files:test", { delay: 40 });
      await pop.waitFor();
      await page.waitForTimeout(900);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const clip = await mentionClip(page, pop);
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.4-beta",
    file: "05-comments-inline.png",
    title: "review comments",
    async run(browser) {
      const { ctx, page } = await openApp(browser, {});
      await deleteSeededComments(page);
      await openPreviewFile(page, ["src", "middleware"], "authMiddleware.ts");
      await fullscreenPreview(page);
      await addComment(page, 20, COMMENT_TEXTS.missing);
      // The `c` shortcut: select code, press c, write a comment (left as a draft for the shot).
      await page.locator(".preview-body").getByText("verifyAccess", { exact: true }).nth(1).dblclick();
      await page.keyboard.press("c");
      const draft = page.locator('[data-comment-box="new"]');
      await draft.waitFor();
      await page.keyboard.type(COMMENT_TEXTS.draft, { delay: 5 });
      // Scroll so the function starts near the top and both boxes clear the tray strip.
      await page.locator('button[aria-label="Add comment on line 13"]').evaluate((el) => {
        let sc = el.parentElement;
        while (sc && !(sc.scrollHeight > sc.clientHeight && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        const r = el.getBoundingClientRect();
        if (sc) sc.scrollTop += r.top - sc.getBoundingClientRect().top;
      });
      await page.mouse.move(1300, 700); // over the file list: no hover "+" in the gutter
      await page.waitForTimeout(600);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const d = await box(draft);
      const top = await box(page.locator('button[aria-label="Add comment on line 14"]'));
      const row = top.y + top.height / 2 - 11; // top of line 14's row (rows are ~22px)
      const clip = inView({ x: 0, y: row, width: d.x + d.width + 12, height: d.y + d.height + 6 - row });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await deleteSeededComments(page);
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.4-beta",
    file: "06-comments-send.png",
    title: "review comments",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { chats: { [SESSION]: CHAT_SCHEDULE } });
      await deleteSeededComments(page);
      await openPreviewFile(page, ["src", "middleware"], "authMiddleware.ts");
      await addComment(page, 20, COMMENT_TEXTS.missing);
      await addComment(page, 25, COMMENT_TEXTS.expired);
      await openPreviewFile(page, ["routes"], "users.ts");
      await addComment(page, 8, COMMENT_TEXTS.roles);
      await page.locator(".comment-tray").first().waitFor();
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-a-${this.file}`) });
      await page.locator(".comment-tray").getByRole("button", { name: /comments?/ }).first().click();
      await page.waitForTimeout(600);
      // Grow the list so the picker sits over it rather than over the file preview.
      const h = await box(page.locator(".comment-tray__handle").first());
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2, 150, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: /^Send \d+ to agent/ }).first().click();
      const picker = page.locator(".comment-picker").first();
      await picker.waitFor();
      await picker.locator('[aria-label="Message for the agent"]').click();
      await page.keyboard.type("Fix these, then rerun the auth tests.", { delay: 5 });
      await page.mouse.move(400, 600);
      await page.waitForTimeout(600);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const tray = await box(page.locator(".comment-tray").first());
      const pk = await box(picker);
      const y = Math.min(tray.y + 8, pk.y - 12); // below the list's resize handle
      const clip = inView({ x: tray.x, y, width: tray.x + tray.width - tray.x, height: tray.y + tray.height - y });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await deleteSeededComments(page);
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.4-beta",
    file: "07-omp.png",
    title: "harnesses",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { path: "/settings/modes", inject: { modes: EXTRA_MODES } });
      await page.locator('[data-testid="harness-tab-omp"]').click();
      await page.waitForTimeout(1200);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      const tabs = await box(page.locator('[role="tablist"][aria-label="Harnesses"]').first());
      // Down to the bottom of the (injected) oh-my-pi mode card: the nearest card-sized ancestor of its Edit button.
      const card = await page.getByRole("button", { name: "Edit oh-my-pi" }).evaluate((el) => {
        let n = el;
        while (n.parentElement && n.getBoundingClientRect().height < 56) n = n.parentElement;
        const r = n.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      const clip = inView({ x: tabs.x - 14, y: tabs.y - 12, width: card.x + card.width + 14 - (tabs.x - 14), height: card.y + card.height + 14 - (tabs.y - 12) });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.4-beta",
    file: "08-artifacts.png",
    title: "artifacts",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { inject: INJECT_PREV, route: [`**/api/worktrees/${WORKTREE}/artifacts`, (r) => r.fulfill({ json: artifactRows() })] });
      await page.getByRole("button", { name: "Artifacts" }).first().click();
      const list = page.locator('[role="listbox"][aria-label="Artifacts"]').first();
      await list.waitFor();
      await page.waitForTimeout(900);
      if (process.env.FULL) await page.screenshot({ path: join(RAW_DIR, `full-${this.file}`) });
      // From the session filter row (the title row above it shares the window's top-right actions chip) to the list end.
      const filter = await box(page.locator("select").filter({ hasText: /Session/ }).first());
      const l = await box(list);
      const x = filter.x - 12;
      const right = l.x + l.width + 4; // the tools rail (with its active-tab marker) starts right at the list's edge
      const clip = inView({ x, y: filter.y - 7, width: right - x, height: l.y + l.height + 10 - (filter.y - 7) });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.3-beta",
    file: "01-bulk-archive.png",
    title: "sidebar",
    async run(browser) {
      const { ctx, page } = await openApp(browser, {});
      const trigger = page.locator('button[aria-label="Bulk actions"]').first();
      await trigger.waitFor();
      const head = await box(trigger); // select mode swaps this heading out, so measure it first
      await trigger.click();
      await page.getByRole("menuitem", { name: /Archive worktrees/ }).click();
      const boxes = page.locator('[role="checkbox"][aria-label^="Select "]:not([aria-label^="Select all"])');
      // Projects start collapsed in the sidebar: expand one so its worktree rows (with checkboxes) show.
      if ((await boxes.count()) < 3) await page.getByText("northstar-api", { exact: true }).first().click();
      await boxes.nth(2).waitFor();
      for (let i = 0; i < Math.min(3, await boxes.count()); i++) await boxes.nth(i).click();
      const bar = page.locator(".bulk-action-bar").first();
      await bar.waitFor();
      await page.waitForTimeout(500);
      const b = await box(bar);
      const clip = inView({ x: 0, y: head.y - 14, width: b.x + b.width + 1, height: b.y + b.height + 2 - (head.y - 14) });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.3-beta",
    file: "02-dashboard.png",
    title: "dashboard",
    async run(browser) {
      const { ctx, page } = await openApp(browser, { path: "/", patchSessions: true });
      const cards = page.locator(".dashboard-card-shell");
      await cards.first().waitFor();
      await page.waitForTimeout(1200);
      const inner = await box(page.locator(".dashboard-panel__inner").first());
      const label = await box(page.locator(".dashboard-section__label").first());
      const last = await box(cards.nth(4)); // four working cards + the first "needs you" one: icon, activity and PR chip, no cut-off card
      const clip = inView({ x: inner.x - 14, y: label.y - 18, width: inner.width + 28, height: last.y + last.height + 3 - (label.y - 18) });
      await page.screenshot({ path: join(RAW_DIR, this.file), clip });
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.2-beta",
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
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.2-beta",
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
      await closeCtx(ctx);
      return clip;
    },
  },
  {
    release: "v0.0.2-beta",
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
      await closeCtx(ctx);
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
  for (const s of SHOTS.filter((s) => s.release === RELEASE && (!only || only.includes(s.file)))) {
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
