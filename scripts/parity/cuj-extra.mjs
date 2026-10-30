#!/usr/bin/env node
// cuj-extra.mjs — ten more light CUJs (resume, steering, failures, races) against an EXISTING vst daemon
// (the dev sandbox) with a Rich Chat (json channel) agent. Tiny prompts, scratch repos inside the container.
//
//   node scripts/parity/cuj-extra.mjs --cli claude --base-url http://127.0.0.1:<sandbox-port> --container <sandbox-container> \
//        --out DIR [--only 1,4,8] [--model haiku]
//
// Safety: only touches the sandbox daemon at --base-url and the named container. X4 restarts THAT container
// (`docker restart <container>`); X8 kills exactly one PID inside it (an adapter process whose /proc cwd is the
// X8 scratch project) — never by name pattern across the host, never the user's daemon on 7421.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const CLI = opt("cli", "claude"), ROOT = opt("base-url"), CONTAINER = opt("container"), OUT = opt("out"), MODEL = opt("model", "haiku");
const ONLY = opt("only", "") ? opt("only").split(",") : null; const want = (n) => !ONLY || ONLY.includes(String(n));
if (!ROOT || !CONTAINER || !OUT) { console.error("usage: --base-url URL --container NAME --out DIR [--cli claude|codex] [--only 1,2]"); process.exit(2); }
if (/:7421\b/.test(ROOT)) { console.error("refusing the user's daemon (7421)"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(path.dirname(process.argv[1]), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `${ROOT}/api`, H = { "content-type": "application/json", origin: ROOT.replace("127.0.0.1", "localhost") };
const api = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
const dx = (cmd, user = "vst") => spawnSync("docker", ["exec", "-u", user, CONTAINER, "sh", "-c", cmd], { encoding: "utf8" });
const events = async (sid) => (await api("GET", `/sessions/${sid}/transcript`)).body.events || [];
const state = async (sid) => (await api("GET", `/sessions/${sid}`)).body.state;
const chat = (sid, message, extra = {}) => api("POST", `/sessions/${sid}/chat`, { message, ...extra });
async function settle(sid, ms = 120000) { const t0 = Date.now(); await sleep(1500); while (Date.now() - t0 < ms) { const s = await state(sid); if (s === "waiting_for_human" || s === "exited") return s; await sleep(700); } return "timeout"; }
async function waitTool(sid, mark, ms = 60000) { for (let t0 = Date.now(); Date.now() - t0 < ms;) { if ((await events(sid)).slice(mark).some((e) => e.kind === "tool_use")) return true; await sleep(400); } return false; }
const text = (evs) => evs.filter((e) => e.kind === "text").map((e) => e.text).join("");
const errs = (evs) => evs.filter((e) => e.kind === "error").map((e) => String(e.text).slice(0, 140));
async function sampleStates(sid, fn) { const seq = []; let stop = false; const p = (async () => { while (!stop) { const s = await state(sid); if (seq[seq.length - 1] !== s) seq.push(s); await sleep(250); } })(); const r = await fn(); stop = true; await p; return { seq, r }; }
const RED = (() => { const w = 16, raw = Buffer.alloc((w * 3 + 1) * w); for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 255; const T = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; }); const crc = (b) => { let c = -1; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }; const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); }; const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(w, 4); ih[8] = 8; ih[9] = 2; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch("IHDR", ih), ch("IDAT", zlib.deflateSync(raw)), ch("IEND", Buffer.alloc(0))]); })();

const report = { cli: CLI, base: ROOT, container: CONTAINER, startedAt: new Date().toISOString(), cuj: {} };
const rec = (n, pass, detail) => { report.cuj[n] = { pass, ...detail }; console.error(`[${CLI}] ${n}: ${pass ? "PASS" : "FAIL"} ${JSON.stringify(detail).slice(0, 300)}`); };
const mkRepo = (dir) => dx(`rm -rf ${dir} && mkdir -p ${dir} && cd ${dir} && git init -q && echo x > f.txt && git add . && git -c user.name=p -c user.email=p@p commit -q -m init`);
async function setup(dir) {
  mkRepo(dir); let pr = (await api("POST", "/projects", { path: dir })).body;
  if (!pr?.id) pr = ((await api("GET", "/projects")).body || []).find((x) => x.path === dir) || {};   // already registered by an earlier run
  const mode = (await api("POST", "/modes", { name: `${CLI}-x-${Date.now()}`, cli: CLI, context: "Be terse.", ...(CLI === "claude" ? { model: MODEL } : {}) })).body; await sleep(2500);
  return { pid: pr.id, mid: mode.id };
}
const mk = (S, prompt) => { const cp = spawnSync(path.join(REPO, "rust/target/debug/vst"), ["agent", "create", `--project=${S.pid}`, `--mode=${S.mid}`, "--channel=json", "--prompt", prompt], { env: { ...process.env, VST_DAEMON_URL: ROOT }, encoding: "utf8" }); const m = /Created session: (\S+)/.exec(cp.stdout); if (!m) throw new Error("create failed: " + cp.stdout + cp.stderr); return m[1]; };
const run = async (n, fn) => { if (!want(n)) return; try { await fn(); } catch (e) { rec(`X${n}`, false, { harnessError: String(e.stack || e).slice(0, 300) }); } };

const S = await setup("/tmp/cuj-x"); const SK = await setup("/tmp/cuj-kill");

await run(1, async () => {   // steering mid-turn (after the session's first turn)
  const sid = mk(S, "Reply with exactly: WARM"); await settle(sid, 60000);
  const mark = (await events(sid)).length; const { seq, r } = await sampleStates(sid, async () => {
    await chat(sid, "Run the shell command `sleep 15; echo base` and when done reply: BASE-OK"); await waitTool(sid, mark); await sleep(800);
    const r = await chat(sid, "Also end your final reply with the token STEER-OK"); await settle(sid, 120000); return r; });
  const t = text((await events(sid)).slice(mark));
  rec("X1_steering", r.body?.delivery === "steered" && /STEER-OK/.test(t) && seq.filter((s) => s === "waiting_for_human").length === 1, { delivery: r.body?.delivery, token: /STEER-OK/.test(t), stateSeq: seq });
});
await run(2, async () => {   // multi-turn memory
  const sid = mk(S, "My name is Zed. Reply: ok"); await settle(sid, 60000); await chat(sid, "I like pears. Reply: ok"); await settle(sid, 60000);
  const mark = (await events(sid)).length; await chat(sid, "What is my name and what fruit do I like? One short line."); await settle(sid, 60000);
  const t = text((await events(sid)).slice(mark)); rec("X2_multi_turn_memory", /zed/i.test(t) && /pear/i.test(t), { reply: t.slice(-90) });
});
await run(3, async () => {   // retire (done) then resume the same session
  const sid = mk(S, "Remember: the code word is kiwi. Reply: ok"); await settle(sid, 60000);
  const d = await api("POST", `/sessions/${sid}/done`, {}); await sleep(1500); const sd = await state(sid);
  const rs = await api("POST", `/sessions/${sid}/resume`, {}); await sleep(2500);
  const mark = (await events(sid)).length; const c = await chat(sid, "What is the code word? Reply with only that word."); const st = await settle(sid, 90000);
  const t = text((await events(sid)).slice(mark)); rec("X3_done_then_resume", /kiwi/i.test(t) && st === "waiting_for_human", { done: d.status, stateAfterDone: sd, resume: rs.status, chat: c.status, reply: t.slice(-60), errors: errs((await events(sid)).slice(mark)) });
});
await run(4, async () => {   // sandbox restart (daemon + adapters die), then resume
  const sid = mk(S, "Remember: the secret is plum. Reply: ok"); await settle(sid, 60000);
  spawnSync("docker", ["restart", CONTAINER], { encoding: "utf8" });
  let up = false; for (let i = 0; i < 120; i++) { try { if ((await fetch(`${ROOT}/health`)).ok) { up = true; break; } } catch {} await sleep(1500); }
  await sleep(3000); const stR = up ? await state(sid) : "daemon-down";
  const mark = (await events(sid)).length; await chat(sid, "What is the secret? Reply with only that word."); const st = await settle(sid, 120000);
  const t = text((await events(sid)).slice(mark)); rec("X4_container_restart_resume", up && /plum/i.test(t), { up, stateRightAfter: stR, state: st, reply: t.slice(-50), errors: errs((await events(sid)).slice(mark)) });
});
await run(5, async () => {   // FIFO queue of 3, delete the middle one
  const sid = mk(S, "Run the shell command `sleep 8` then reply: FIRST"); const mark0 = 0; await waitTool(sid, 0);
  const qa = await chat(sid, "Reply with exactly: QA", { queue: true }); const qb = await chat(sid, "Reply with exactly: QB", { queue: true }); const qc = await chat(sid, "Reply with exactly: QC", { queue: true });
  const del = await api("DELETE", `/sessions/${sid}/chat/queue/${qb.body?.turnId}`); const st = await settle(sid, 150000); await sleep(1500);
  const t = text(await events(sid)); const ia = t.indexOf("QA"), ic = t.indexOf("QC");
  const evs5 = await events(sid); const seq5 = []; let cur = ""; for (const e of evs5) { if (e.kind === "user") seq5.push(`USER ${e.text.slice(0, 26)}`); else if (e.kind === "text") cur += e.text; else if (e.kind === "result") { seq5.push(`REPLY ${JSON.stringify(cur.slice(-24))} (turn ${String(e.turnId).slice(0, 6)})`); cur = ""; } else if (e.kind === "status") seq5.push(`STATUS ${e.text}`); }
  if (cur) seq5.push(`TRAILING TEXT ${JSON.stringify(cur.slice(-24))}`);
  rec("X5_queue_fifo_and_delete", ia >= 0 && ic > ia && !/QB/.test(t) && st === "waiting_for_human", { sequence: seq5, positions: [qa.body?.queuePosition, qb.body?.queuePosition, qc.body?.queuePosition], deleteStatus: del.status, order: [ia, ic], qbRan: /QB/.test(t) });
});
await run(6, async () => {   // stop races: stop while idle, double stop, immediate new prompt
  const sid = mk(S, "Reply with exactly: READY"); await settle(sid, 60000);
  const idleStop = await api("POST", `/sessions/${sid}/chat/stop`, {}); await sleep(500);
  const mark = (await events(sid)).length; await chat(sid, "Run the shell command `sleep 40` then reply: LATE"); await waitTool(sid, mark); await sleep(800);
  const s1 = await api("POST", `/sessions/${sid}/chat/stop`, {}); const s2 = await api("POST", `/sessions/${sid}/chat/stop`, {}); const stA = await settle(sid, 30000);
  const m2 = (await events(sid)).length; await chat(sid, "Reply with exactly: AFTER-STOP"); const stB = await settle(sid, 60000); const t = text((await events(sid)).slice(m2));
  rec("X6_stop_races", /AFTER-STOP/.test(t) && stA === "waiting_for_human" && stB === "waiting_for_human", { idleStop: idleStop.status, stops: [s1.status, s2.status], stateAfterStop: stA, followUp: /AFTER-STOP/.test(t) });
});
await run(7, async () => {   // tool failure recovery + big output
  const sid = mk(S, "Use the Read tool on /tmp/definitely-not-here-12345.txt and tell me the error in 6 words or fewer."); const st1 = await settle(sid, 90000); const e1 = await events(sid);
  const mark = e1.length; await chat(sid, "Run the shell command `seq 1 4000` and reply with only the last number you saw."); const st2 = await settle(sid, 120000); const e2 = (await events(sid)).slice(mark);
  const failed = e1.some((e) => e.kind === "tool_result" && (e.toolStatus === "failed" || e.toolResult?.isError));
  rec("X7_tool_error_and_big_output", st1 === "waiting_for_human" && errs(e1).length === 0 && /4000/.test(text(e2)) && st2 === "waiting_for_human" && errs(e2).length === 0, { readFailedShown: failed, errors: [...errs(e1), ...errs(e2)], replyTail: text(e2).slice(-30), bigResultChars: Math.max(0, ...e2.filter((e) => e.kind === "tool_result").map((e) => (e.toolResult?.content || "").length)) });
});
await run(8, async () => {   // adapter process killed mid-turn; next message must recover
  const sid = mk(SK, "Remember: the word is fig. Reply: ok"); await settle(sid, 60000);
  const mark = (await events(sid)).length; await chat(sid, "Run the shell command `sleep 60` then reply: DONE"); await waitTool(sid, mark); await sleep(800);
  // the adapter is the parent of the `claude` child started with --session-id=<this session's agentChatId>
  const chatId = (await events(sid)).find((e) => e.agentChatId)?.agentChatId;
  const cand = !chatId ? [] : dx(`for p in $(ls /proc | grep -E '^[0-9]+$'); do a=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null); case "$a" in *"--session-id=${chatId}"*) pp=$(awk '{print $4}' /proc/$p/stat 2>/dev/null); pa=$(tr '\\0' ' ' < /proc/$pp/cmdline 2>/dev/null); case "$pa" in "/usr/local/bin/claude-acp "*|"/usr/local/bin/codex-acp "*) echo $pp;; esac;; esac; done`, "root").stdout.trim().split(/\s+/).filter(Boolean);
  let killed = null; if (cand.length === 1) { killed = cand[0]; dx(`kill -9 ${killed}`, "root"); }
  const stA = await settle(sid, 90000); const eA = (await events(sid)).slice(mark);
  const m2 = (await events(sid)).length; await chat(sid, "What is the word I told you? Reply with only that word."); const stB = await settle(sid, 120000); const eB = (await events(sid)).slice(m2);
  rec("X8_adapter_killed_mid_turn", cand.length === 1 && stA !== "timeout" && /fig/i.test(text(eB)) && stB === "waiting_for_human", { candidates: cand.length, killedPid: killed, stateAfterKill: stA, errorShown: errs(eA), recoveredReply: text(eB).slice(-40), recoverErrors: errs(eB) });
});
await run(9, async () => {   // model switch mid-session
  const sid = mk(S, "Reply with exactly: ONE"); await settle(sid, 60000);
  const pm = await api("PATCH", `/sessions/${sid}/chat/model`, { model: CLI === "claude" ? "sonnet" : "gpt-5.6-luna" }); await sleep(1500);
  const mark = (await events(sid)).length; await chat(sid, "Reply with exactly: MODEL-OK"); const st = await settle(sid, 120000); const e = (await events(sid)).slice(mark);
  const meta = (await api("GET", `/sessions/${sid}/meta`)).body;
  rec("X9_model_switch_mid_session", pm.status === 200 && /MODEL-OK/.test(text(e)) && st === "waiting_for_human" && errs(e).length === 0, { patch: pm.status, patchBody: pm.body, metaModel: meta?.model ?? meta?.activeModel, errors: errs(e) });
});
await run(10, async () => {   // image attachment + slash command
  const sid = mk(S, "Reply with exactly: HI"); await settle(sid, 60000);
  const fd = new FormData(); fd.append("files", new Blob([RED], { type: "image/png" }), "red.png");
  const up = await fetch(`${base}/sessions/${sid}/attachments`, { method: "POST", headers: { origin: H.origin }, body: fd }); const upj = await up.json().catch(() => ({})); const ids = (upj.attachments || []).map((a) => a.id || a.uploadId).filter(Boolean);
  const mark = (await events(sid)).length; await chat(sid, "What single colour is the attached image? One word.", { attachmentIds: ids }); const st1 = await settle(sid, 90000); const t1 = text((await events(sid)).slice(mark));
  const m2 = (await events(sid)).length; await chat(sid, "/context"); const st2 = await settle(sid, 90000); const e2 = (await events(sid)).slice(m2); const t2 = text(e2);
  rec("X10_image_and_slash_command", /red/i.test(t1) && st1 === "waiting_for_human" && st2 === "waiting_for_human" && t2.length > 20 && errs(e2).length === 0, { uploaded: ids.length, image: t1.slice(-20), slashReplyChars: t2.length, slashErrors: errs(e2) });
});

fs.writeFileSync(path.join(OUT, `cuj-extra-${CLI}.json`), JSON.stringify(report, null, 2).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"));
const results = Object.entries(report.cuj).map(([k, v]) => `${k}:${v.pass ? "PASS" : "FAIL"}`); console.error("SUMMARY " + results.join(" "));
