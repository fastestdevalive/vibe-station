#!/usr/bin/env node
// product-check.mjs — product-level parity check through a REAL vst daemon (Rich Chat, json channel).
//
//   node scripts/parity/product-check.mjs --cli codex|claude --bin <adapter> --out DIR [--port 7198]
//
// Starts a throw-away native vst-daemon (rust/target/debug/vst-daemon, built with insecure-no-auth) with an
// ISOLATED HOME and a free port, per AGENTS.md "Killing processes you started": the daemon PID is captured
// at spawn and that exact PID is killed at the end. The user's daemon (7421) is never touched.
// Credentials: nothing is copied or read. The harness only points the vendor CLI at its OWN dir through
// the vendor's documented env var (CODEX_HOME / CLAUDE_CONFIG_DIR), so the host login is used in place.
// Scenarios: tool turn + edit diff, steering, cancel, resume across a daemon restart, background command, image.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const CLI = opt("cli"), BIN = opt("bin"), OUT = opt("out"), PORT = Number(opt("port", "7198"));
if (!CLI || !BIN || !OUT) { console.error("usage: --cli codex|claude --bin ADAPTER --out DIR [--port N]"); process.exit(2); }
if (PORT === 7421) { console.error("refusing port 7421 (the user's daemon)"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(path.dirname(process.argv[1]), "../..");
const DAEMON = path.join(REPO, "rust/target/debug/vst-daemon");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const free = (p) => new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.once("listening", () => s.close(() => res(true))); s.listen(p, "127.0.0.1"); });
if (!(await free(PORT))) { console.error(`port ${PORT} busy`); process.exit(2); }

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vst-prod-"));
const proj = path.join(HOME, "proj"); fs.mkdirSync(proj);
for (const a of [["init", "-q"], ["-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "--allow-empty", "-m", "init"]]) spawnSync("git", a, { cwd: proj });
fs.writeFileSync(path.join(proj, "a.txt"), "alpha\nbeta\ngamma\n");
spawnSync("git", ["add", "."], { cwd: proj }); spawnSync("git", ["-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "-m", "a"], { cwd: proj });

const base = `http://127.0.0.1:${PORT}/api`;
const H = { "content-type": "application/json", origin: `http://localhost:${PORT}` };
const api = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };

let daemon, daemonLog = "";
async function startDaemon() {
  const env = { HOME, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${path.dirname(process.execPath)}`, VST_NO_AUTH: "1", VST_PORT: String(PORT) };
  if (CLI === "codex") { env.CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"); env.VST_CODEX_ACP_BIN = BIN; }
  else { env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"); env.VST_CLAUDE_ACP_BIN = BIN; }
  daemon = spawn(DAEMON, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout.on("data", (d) => (daemonLog += d)); daemon.stderr.on("data", (d) => (daemonLog += d));
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return; } catch {} await sleep(500); }
  throw new Error("daemon did not come up");
}
async function stopDaemon() { if (!daemon) return; const pid = daemon.pid; daemon.kill("SIGTERM"); for (let i = 0; i < 20; i++) { try { process.kill(pid, 0); } catch { break; } await sleep(250); } daemon = null; }

const events = async (sid) => (await api("GET", `/sessions/${sid}/transcript`)).body.events || [];
const kinds = (evs) => evs.map((e) => e.kind);
const state = async (sid) => (await api("GET", `/sessions/${sid}`)).body.state;
async function settle(sid, ms = 120000) { const t0 = Date.now(); await sleep(1500); while (Date.now() - t0 < ms) { const s = await state(sid); if (s === "waiting_for_human" || s === "exited") return s; await sleep(800); } return "timeout"; }
const chat = (sid, message, extra = {}) => api("POST", `/sessions/${sid}/chat`, { message, ...extra });
const summarize = (evs) => ({ kinds: [...new Set(kinds(evs))], tools: evs.filter((e) => e.kind === "tool_use").map((e) => ({ name: e.toolName, kind: e.toolKind, diffs: e.toolDiffs ? e.toolDiffs.map((d) => ({ path: path.basename(d.path || ""), old: d.oldText ?? null, new: d.newText })) : undefined })), errors: evs.filter((e) => e.kind === "error").map((e) => e.text), text: evs.filter((e) => e.kind === "text").map((e) => e.text).join("").slice(-300), results: evs.filter((e) => e.kind === "result").map((e) => e.stopReason ?? e.subtype ?? "result"), usage: evs.filter((e) => e.kind === "usage").length });

const report = { cli: CLI, bin: BIN, port: PORT, home: HOME, startedAt: new Date().toISOString(), scenarios: {} };
const rec = (n, v) => { report.scenarios[n] = v; console.error(`[${CLI}] ${n}: ${JSON.stringify(v).slice(0, 220)}`); };
const RED = (() => { const w = 16, raw = Buffer.alloc((w * 3 + 1) * w); for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 255; } const T = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; }); const crc = (b) => { let c = -1; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }; const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); }; const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(w, 4); ih[8] = 8; ih[9] = 2; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch("IHDR", ih), ch("IDAT", zlib.deflateSync(raw)), ch("IEND", Buffer.alloc(0))]); })();

try {
  await startDaemon();
  const pr = await api("POST", "/projects", { path: proj });
  const modeBody = { name: CLI, cli: CLI, context: "Be terse." }; if (CLI === "claude") modeBody.model = "haiku";
  const mode = (await api("POST", "/modes", modeBody)).body;
  await sleep(2500);
  rec("setup", { project: pr.body.id, mode: mode.id });
  const mk = async (prompt) => { const cp = spawnSync(path.join(REPO, "rust/target/debug/vst"), ["agent", "create", `--project=${pr.body.id}`, `--mode=${mode.id}`, "--channel=json", "--prompt", prompt], { env: { ...process.env, HOME, VST_DAEMON_URL: `http://127.0.0.1:${PORT}` }, encoding: "utf8" }); const m = /Created session: (\S+)/.exec(cp.stdout); if (!m) throw new Error("create failed: " + cp.stdout + cp.stderr); return m[1]; };

  // 1. tool turn + edit diff (first prompt of the session)
  const sid = await mk("Use a patch/edit tool (not the shell) to change the line 'beta' to 'BETA' in a.txt. Then reply: edited");
  const st1 = await settle(sid); const e1 = await events(sid);
  rec("tool_edit_turn", { state: st1, fileAfter: fs.readFileSync(path.join(proj, "a.txt"), "utf8"), ...summarize(e1) });

  // 2. second turn (shell tool) + usage
  await chat(sid, "Run the shell command `echo second-turn` and reply with its output only."); const st2 = await settle(sid);
  rec("second_turn", { state: st2, ...summarize((await events(sid)).slice(e1.length)) });

  // 3. cancel mid-tool
  let mark = (await events(sid)).length;
  await chat(sid, "Run the shell command `sleep 60; echo late` and then reply: finished");
  for (let i = 0; i < 60; i++) { const ev = (await events(sid)).slice(mark); if (ev.some((e) => e.kind === "tool_use")) break; await sleep(500); }
  await sleep(1000); const t0 = Date.now(); const stop = await api("POST", `/sessions/${sid}/chat/stop`, {}); const st3 = await settle(sid, 40000);
  rec("cancel", { stopHttp: stop.status, state: st3, ms: Date.now() - t0, ...summarize((await events(sid)).slice(mark)) });

  // 4. steering mid-turn (default chat while a turn runs steers)
  mark = (await events(sid)).length;
  await chat(sid, "Run the shell command `sleep 20; echo steer-base` and when done reply: BASE-OK");
  for (let i = 0; i < 60; i++) { if ((await events(sid)).slice(mark).some((e) => e.kind === "tool_use")) break; await sleep(500); }
  await sleep(1000); const sr = await chat(sid, "Also end your final reply with the token STEER-OK"); const st4 = await settle(sid, 120000);
  const ev4 = (await events(sid)).slice(mark);
  rec("steering", { enqueue: sr.status, delivery: sr.body?.delivery, state: st4, steerTokenInReply: /STEER-OK/.test(ev4.filter((e) => e.kind === "text").map((e) => e.text).join("")), ...summarize(ev4) });

  // 5. background command, then check what the transcript shows after the turn returns
  mark = (await events(sid)).length;
  await chat(sid, "Start `sleep 6; echo bg-finished` in the background (do not wait for it), then reply exactly: STARTED"); const st5 = await settle(sid, 90000); await sleep(15000);
  const ev5 = (await events(sid)).slice(mark);
  rec("background", { stateAtTurnEnd: st5, stateAfter15s: await state(sid), ...summarize(ev5) });

  // 6. image (attachment upload + chat)
  mark = (await events(sid)).length;
  const fd = new FormData(); fd.append("files", new Blob([RED], { type: "image/png" }), "red.png");
  const up = await fetch(`${base}/sessions/${sid}/attachments`, { method: "POST", headers: { origin: H.origin }, body: fd }); const upj = await up.json().catch(() => ({}));
  const ids = (upj.attachments || upj.uploads || upj.files || []).map((a) => a.id || a.uploadId).filter(Boolean);
  await chat(sid, "What single colour is the attached image? One word.", { attachmentIds: ids }); const st6 = await settle(sid, 90000);
  rec("image", { uploadHttp: up.status, uploadKeys: Object.keys(upj), attachmentIds: ids.length, state: st6, ...summarize((await events(sid)).slice(mark)) });

  // 7. resume across a daemon restart
  await chat(sid, "Remember: the secret word is plum. Reply: stored"); await settle(sid, 60000);
  const beforeLen = (await events(sid)).length;
  await stopDaemon(); await sleep(2000); await startDaemon();
  const stR = await state(sid);
  await chat(sid, "What is the secret word I told you? Reply with only that word."); const st7 = await settle(sid, 120000);
  const ev7 = (await events(sid)).slice(beforeLen);
  rec("resume_after_daemon_restart", { stateRightAfterRestart: stR, state: st7, recalled: /plum/i.test(ev7.filter((e) => e.kind === "text").map((e) => e.text).join("")), ...summarize(ev7) });
  fs.writeFileSync(path.join(OUT, "final-transcript.json"), JSON.stringify(await events(sid), null, 1));
} catch (e) { rec("harness_error", String(e.stack || e)); }
finally {
  await stopDaemon();
  report.daemonLogTail = daemonLog.slice(-1500).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>");
  fs.writeFileSync(path.join(OUT, `product-${CLI}.json`), JSON.stringify(report, null, 2).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"));
  fs.rmSync(HOME, { recursive: true, force: true });
  console.error(`daemon stopped; port ${PORT} free: ${await free(PORT)}`);
}
