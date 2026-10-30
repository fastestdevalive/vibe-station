#!/usr/bin/env node
// agent-cuj.mjs — five light critical-user-journey checks for a Rust ACP adapter (`--cli claude|codex`) through the REAL vst daemon
// (Rich Chat / json channel). Tiny prompts, scratch git repo, a few minutes.
//
//   node scripts/parity/agent-cuj.mjs --bin <codex-acp-or-wrapper> --out DIR [--port 7198] [--label rust]
//
// Safety (AGENTS.md "Killing processes you started"): throw-away native vst-daemon, isolated HOME, free port,
// the daemon PID is captured at spawn and exactly that PID is stopped; refuses 7421; no pkill. Credentials:
// nothing is copied/read — only CODEX_HOME is pointed at the user's own codex dir so the host login is used in place.
// Note: vst's ACP client auto-answers adapter permission requests (prefers allow_always, then allow_once; it never
// rejects), so a "deny" outcome is NOT reachable through the product path — CUJ 5 covers it at protocol level via
// `live-acp-codex.mjs --only plan_accept,plan_reject` (a permission that reliably fires: "Implement this plan?").
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const BASE_URL = opt("base-url", "");        // run against an EXISTING daemon (e.g. the dev sandbox) instead of a throwaway one
const CONTAINER = opt("container", "");     // docker container whose filesystem holds that daemon's project (for file checks)
const ONLY = opt("only", "") ? opt("only").split(",") : null;   // e.g. 1,3,4
const want = (n) => !ONLY || ONLY.includes(String(n));
const CLI = opt("cli", "codex");   // codex | claude
const BIN = opt("bin"), OUT = opt("out"), PORT = Number(opt("port", "7198")), LABEL = opt("label", "rust");
if (!BIN || !OUT) { console.error("usage: --bin ADAPTER --out DIR [--port N] [--label L]"); process.exit(2); }
if (PORT === 7421) { console.error("refusing port 7421"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(path.dirname(process.argv[1]), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const free = (p) => new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.once("listening", () => s.close(() => res(true))); s.listen(p, "127.0.0.1"); });
if (CLI === "claude" && !BASE_URL) {   // preflight: can the host login be used with an isolated HOME? (macOS keeps it keyed to the real HOME)
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "vst-cuj-pre-")); const pf = spawnSync("claude", ["-p", "Reply: pong"], { env: { ...process.env, HOME: t, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") }, encoding: "utf8", timeout: 90000 }); fs.rmSync(t, { recursive: true, force: true });
  if (!/pong/i.test(pf.stdout || "")) { console.error("claude is NOT logged in under an isolated HOME (+CLAUDE_CONFIG_DIR): " + (pf.stdout || pf.stderr || "").trim().slice(0, 120) + "\nstopping instead of improvising (no credential copying)."); process.exit(3); }
}
if (!BASE_URL && !(await free(PORT))) { console.error(`port ${PORT} busy`); process.exit(2); }

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vst-cuj-"));
const proj = BASE_URL ? "/tmp/cuj-proj" : path.join(HOME, "proj");
const dx = (cmd) => spawnSync("docker", ["exec", "-u", "vst", CONTAINER, "sh", "-c", cmd], { encoding: "utf8" });
const readFile = (p) => (BASE_URL ? dx(`cat ${p}`).stdout : fs.readFileSync(p, "utf8"));
const fileExists = (p) => (BASE_URL ? dx(`test -e ${p}`).status === 0 : fs.existsSync(p));
if (BASE_URL) { dx(`rm -rf ${proj} && mkdir -p ${proj} && cd ${proj} && git init -q && printf 'alpha\\nbeta\\ngamma\\n' > a.txt && git add . && git -c user.name=p -c user.email=p@p commit -q -m init`); } else fs.mkdirSync(proj);
const git = (...a) => spawnSync("git", ["-c", "user.name=p", "-c", "user.email=p@p", ...a], { cwd: proj });
if (!BASE_URL) { git("init", "-q"); fs.writeFileSync(path.join(proj, "a.txt"), "alpha\nbeta\ngamma\n"); git("add", "."); git("commit", "-q", "-m", "init"); }

const ROOT = BASE_URL || `http://127.0.0.1:${PORT}`;
const base = `${ROOT}/api`, H = { "content-type": "application/json", origin: ROOT.replace("127.0.0.1", "localhost") };
const api = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
let daemon, log = "";
async function startDaemon() {
  if (BASE_URL) return;
  const env = { HOME, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${path.dirname(process.execPath)}`, VST_NO_AUTH: "1", VST_PORT: String(PORT) };
  if (CLI === "codex") { env.CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"); env.VST_CODEX_ACP_BIN = BIN; }
  else { env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"); env.VST_CLAUDE_ACP_BIN = BIN; }
  daemon = spawn(path.join(REPO, "rust/target/debug/vst-daemon"), [], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout.on("data", (d) => (log += d)); daemon.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return; } catch {} await sleep(500); }
  throw new Error("daemon did not come up");
}
async function stopDaemon() { if (BASE_URL || !daemon) return; const pid = daemon.pid; daemon.kill("SIGTERM"); for (let i = 0; i < 20; i++) { try { process.kill(pid, 0); } catch { break; } await sleep(250); } daemon = null; }
const events = async (sid) => (await api("GET", `/sessions/${sid}/transcript`)).body.events || [];
const state = async (sid) => (await api("GET", `/sessions/${sid}`)).body.state;
const chat = (sid, message, extra = {}) => api("POST", `/sessions/${sid}/chat`, { message, ...extra });
async function settle(sid, ms = 120000) { const t0 = Date.now(); await sleep(1500); while (Date.now() - t0 < ms) { const s = await state(sid); if (s === "waiting_for_human" || s === "exited") return s; await sleep(700); } return "timeout"; }
async function waitTool(sid, mark, ms = 60000) { for (let t0 = Date.now(); Date.now() - t0 < ms;) { if ((await events(sid)).slice(mark).some((e) => e.kind === "tool_use")) return true; await sleep(400); } return false; }
const text = (evs) => evs.filter((e) => e.kind === "text").map((e) => e.text).join("");
// sample the lifecycle state while `fn` runs; returns the number of working->waiting_for_human transitions
async function sampleStates(sid, fn) { const seq = []; let stop = false; const p = (async () => { while (!stop) { const s = await state(sid); if (seq[seq.length - 1] !== s) seq.push(s); await sleep(250); } })(); const r = await fn(); stop = true; await p; return { seq, r }; }
const toolInfo = (evs) => evs.filter((e) => e.kind === "tool_use" || e.kind === "tool_result").map((e) => ({ k: e.kind, name: (e.toolName || "").slice(0, 40), toolKind: e.toolKind, status: e.toolStatus, err: e.toolResult?.isError, out: (e.toolResult?.content || "").toString().slice(0, 60), diffs: e.toolDiffs?.length }));

const report = { label: LABEL, bin: BIN, port: PORT, startedAt: new Date().toISOString(), cuj: {} };
const rec = (n, pass, detail) => { report.cuj[n] = { pass, ...detail }; console.error(`[${LABEL}] ${n}: ${pass ? "PASS" : "FAIL"} ${JSON.stringify(detail).slice(0, 260)}`); };

try {
  await startDaemon();
  const pr = await api("POST", "/projects", { path: proj });
  const mode = (await api("POST", "/modes", { name: CLI, cli: CLI, context: "Be terse.", ...(CLI === "claude" ? { model: "haiku" } : {}) })).body; await sleep(2500);
  const mk = async (prompt) => { const cp = spawnSync(path.join(REPO, "rust/target/debug/vst"), ["agent", "create", `--project=${pr.body.id}`, `--mode=${mode.id}`, "--channel=json", "--prompt", prompt], { env: { ...process.env, HOME, VST_DAEMON_URL: ROOT }, encoding: "utf8" }); const m = /Created session: (\S+)/.exec(cp.stdout); if (!m) throw new Error("create failed: " + cp.stdout + cp.stderr); return m[1]; };

  // ── CUJ 1: queued prompt ────────────────────────────────────────────────
  if (want(1)) {
    const sid = await mk("Run the shell command `sleep 8; echo one` and then reply exactly: ONE-DONE");
    await waitTool(sid, 0);
    const { seq } = await sampleStates(sid, async () => { const q = await chat(sid, "Reply with exactly: TWO-DONE", { queue: true }); report.q1 = q.body; await settle(sid, 120000); await sleep(1500); });
    const evs = await events(sid); const t = text(evs); const results = evs.filter((e) => e.kind === "result").length;
    const order = t.indexOf("ONE-DONE") >= 0 && t.indexOf("TWO-DONE") > t.indexOf("ONE-DONE");
    const idleTransitions = seq.filter((s, i) => s === "waiting_for_human" && i > 0).length;
    rec("1_queued", order && results === 2 && idleTransitions === 1, { enqueue: report.q1, order, results, stateSeq: seq });
  }
  // ── CUJ 2: steering (+ idle fallback) ───────────────────────────────────
  if (want(2)) {
    const sid = await mk("Reply with exactly: WARM");   // vst steers only after the session's first turn is done
    await settle(sid, 60000);
    const mark = (await events(sid)).length;
    await chat(sid, "Run the shell command `sleep 20; echo steer-base` and when done reply: BASE-OK"); await waitTool(sid, mark); await sleep(1000);
    const r = await chat(sid, "Also end your final reply with the token STEER-OK"); const st = await settle(sid, 120000);
    const t = text((await events(sid)).slice(mark));
    const mark2 = (await events(sid)).length;
    const idle = await chat(sid, "Reply with exactly: IDLE-OK");   // steer-by-default on an idle session must just run a normal turn
    const st2 = await settle(sid, 60000); const t2 = text((await events(sid)).slice(mark2));
    const resultsInTurn = (await events(sid)).slice(mark).filter((e) => e.kind === "result").length;
    rec("2_steering", r.body?.delivery === "steered" && /STEER-OK/.test(t) && st === "waiting_for_human" && /IDLE-OK/.test(t2) && st2 === "waiting_for_human", { enqueue: r.status, delivery: r.body?.delivery, resultsInSteeredTurn: resultsInTurn, steerTokenInReply: /STEER-OK/.test(t), idleEnqueue: idle.status, idleDelivery: idle.body?.delivery, idleReplied: /IDLE-OK/.test(t2) });
  }
  // ── CUJ 3: tool results (stdout, diff, failing command) ────────────────
  if (want(3)) {
    const sid = await mk("Run the shell command `echo cuj-stdout` and reply with its output only.");
    const st = await settle(sid, 90000); const e1 = await events(sid); const tools1 = toolInfo(e1);
    const toolResultHasStdout = tools1.some((x) => x.k === "tool_result" && /cuj-stdout/.test(x.out));
    const out_ok = toolResultHasStdout || /cuj-stdout/.test(text(e1));   // stdout reaches the user via the tool result or the reply
    let mark = e1.length; await chat(sid, "Use a patch/edit tool (not the shell) to change the line 'beta' to 'BETA' in a.txt. Reply: edited"); await settle(sid, 90000);
    const e2 = (await events(sid)).slice(mark); const diffTool = toolInfo(e2).find((x) => x.diffs);
    const fileOk = readFile(path.join(proj, "a.txt")) === "alpha\nBETA\ngamma\n";
    mark = (await events(sid)).length; await chat(sid, "Run the shell command `sh -c 'echo cuj-bad >&2; exit 3'` and tell me its exit code in one short sentence."); const st3 = await settle(sid, 90000);
    const e3 = (await events(sid)).slice(mark); const errs = e3.filter((e) => e.kind === "error"); const t3 = toolInfo(e3);
    const failShown = t3.some((x) => x.k === "tool_result" && (x.err === true || x.status === "failed" || /3|bad/.test(x.out))) ;
    rec("3_tool_results", st === "waiting_for_human" && out_ok && !!diffTool && fileOk && st3 === "waiting_for_human" && errs.length === 0 && failShown, { stdoutShown: out_ok, toolResultHasStdout, firstTools: tools1, diff: !!diffTool, fileOk, failingCommand: { state: st3, errors: errs.map((e) => e.text), tool: t3, reply: text(e3).slice(-80) } });
  }
  // ── CUJ 4: cancel mid-tool + follow-up ─────────────────────────────────
  if (want(4)) {
    const sid = await mk("Run the shell command `sleep 60; echo late` and then reply: finished");
    const mark = (await events(sid)).length; await waitTool(sid, 0); await sleep(1000);
    const t0 = Date.now(); const stop = await api("POST", `/sessions/${sid}/chat/stop`, {}); const st = await settle(sid, 30000); const ms = Date.now() - t0;
    const mark2 = (await events(sid)).length; await chat(sid, "Reply with exactly: AFTER-CANCEL"); const st2 = await settle(sid, 60000); const t2 = text((await events(sid)).slice(mark2));
    rec("4_cancel", stop.status === 200 && st === "waiting_for_human" && ms < 6000 && /AFTER-CANCEL/.test(t2) && st2 === "waiting_for_human", { stopHttp: stop.status, state: st, ms, followUpReplied: /AFTER-CANCEL/.test(t2) });
  }
  // ── CUJ 5b: outside-workspace write via vst's auto-answered approval, then resume after a daemon restart ──
  if (want(5)) {
    const out = `/tmp/cuj-outside-${LABEL}-${Date.now()}.txt`;
    const sid = await mk(`Run the shell command \`echo outside > ${out}\` and reply: done`);
    const st = await settle(sid, 120000); const wrote = fileExists(out); if (!BASE_URL) { try { fs.unlinkSync(out); } catch {} }
    const e0 = await events(sid); const errs0 = e0.filter((e) => e.kind === "error");
    await chat(sid, "Remember: the secret word is plum. Reply: stored"); await settle(sid, 60000);
    const beforeLen = (await events(sid)).length; await stopDaemon(); await sleep(2000); await startDaemon();
    await chat(sid, "What is the secret word I told you? Reply with only that word."); const st2 = await settle(sid, 120000);
    const t2 = text((await events(sid)).slice(beforeLen));
    rec("5_permission_and_resume", st === "waiting_for_human" && wrote && errs0.length === 0 && /plum/i.test(t2) && st2 === "waiting_for_human", { outsideWriteDone: wrote, tools: toolInfo(e0), reply: text(e0).slice(-120), errorsBeforeRestart: errs0.map((e) => e.text), recalledAfterDaemonRestart: /plum/i.test(t2), note: "vst auto-approves adapter permission requests (never rejects); deny path covered at protocol level (plan_accept/plan_reject)" });
  }
} catch (e) { rec("harness", false, { error: String(e.stack || e) }); }
finally {
  await stopDaemon();
  report.daemonLogTail = log.slice(-800).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>");
  fs.writeFileSync(path.join(OUT, `cuj-${LABEL}.json`), JSON.stringify(report, null, 2).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"));
  fs.rmSync(HOME, { recursive: true, force: true });
  if (!BASE_URL) console.error(`daemon stopped; port ${PORT} free: ${await free(PORT)}`);
}
