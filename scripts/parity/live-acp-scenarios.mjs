#!/usr/bin/env node
// live-acp-scenarios.mjs — Layer A2 of the rust-acp-adapters parity proof.
//
// A scripted ACP *client* shaped like vibe-station's (rust/vst-agents/src/
// acp_connection.rs): same initialize capabilities (fs + terminal), same
// `_meta.claudeCode.options` on session/new|load, same permission handling, same
// steering / cancel calls. It drives ONE adapter against the REAL `claude` CLI
// (host login — claude itself reads it; this script never touches credentials)
// and records, per scenario, the full JSON-RPC transcript plus a structural
// summary. Run it once per adapter and diff the summaries (compare-frames.mjs).
//
//   node live-acp-scenarios.mjs --label rust --cmd /path/to/claude-acp \
//        --out DIR [--only plain,edit] [--model haiku]
//   node live-acp-scenarios.mjs --label bun094 --cmd "bun /x/dist/index.js" --out DIR
//
// `claude` is wrapped by a logger (argv + selected env) so argv/env deltas that
// the adapter hands to claude are captured too.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const LABEL = opt("label"), CMD = opt("cmd"), OUT = opt("out");
const ONLY = opt("only", "") ? opt("only").split(",") : null;
const MODEL = opt("model", "haiku");
const REAL_CLAUDE = opt("claude", process.env.REAL_CLAUDE || "claude");
if (!LABEL || !CMD || !OUT) { console.error("usage: --label L --cmd CMD --out DIR [--only a,b] [--model M]"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => String(s).replace(/(sk-|oat|token)[A-Za-z0-9_\-]{8,}/gi, "<redacted>");

// 1x1... use a 16x16 solid red PNG for the image scenario.
const RED_PNG = (() => {
  const w = 16, h = 16;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0; } }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
})();

// ── claude wrapper: log argv + env keys, then exec the real claude ───────────
const WRAP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "parity-wrap-"));
const WRAP = path.join(WRAP_DIR, "claude-wrap.sh");
const WRAP_LOG = path.join(WRAP_DIR, "calls.jsonl");
fs.writeFileSync(WRAP, `#!/bin/bash
node -e 'const a=process.argv.slice(1);const e=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(CLAUDE_|ANTHROPIC_|DISABLE_|ENABLE_|MAX_|IS_SANDBOX|NO_BROWSER)/.test(k)).map(([k,v])=>[k,/TOKEN|KEY|SECRET/.test(k)?"<set>":v]));require("fs").appendFileSync(${JSON.stringify(WRAP_LOG)},JSON.stringify({argv:a,env:e,cwd:process.cwd()})+"\\n")' -- "$@"
${process.env.PARITY_STDIN_LOG ? `tee -a "${process.env.PARITY_STDIN_LOG}" | "${REAL_CLAUDE}" "$@"` : `exec "${REAL_CLAUDE}" "$@"`}
`, { mode: 0o755 });

// The harness may itself run inside a Claude Code session; its CLAUDE_*/ANTHROPIC_* env
// (messaging socket, child-session flags, ANTHROPIC_MODEL…) must not leak into the
// adapters under test. vst pins ANTHROPIC_MODEL to the session model (claude.rs
// `acp_model_env`), so each Client sets that explicitly.
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|CLAUDECODE|MCP_)/.test(k)));
}

// ── ACP client ───────────────────────────────────────────────────────────────
class Client {
  constructor(cwd, policy, model) {
    this.model = model; this.cwd = cwd; this.policy = policy || (() => "allow"); this.log = []; this.pending = new Map(); this.nextId = 1; this.updates = []; this.perms = []; this.fsCalls = []; this.terms = new Map();
    this.onUpdate = null;
  }
  start() {
    const parts = CMD.split(" ");
    this.child = spawn(parts[0], parts.slice(1), {
      cwd: this.cwd,
      env: { ...cleanEnv(), CLAUDE_CODE_EXECUTABLE: WRAP, ...(this.model ? { ANTHROPIC_MODEL: this.model } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", (d) => { this.stderr += d; if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000); });
    this.exited = new Promise((r) => this.child.on("exit", (c, s) => { this.exitInfo = { code: c, signal: s }; r(); }));
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (l) => { if (l.trim()) this.recv(l); });
  }
  send(o) { this.log.push({ dir: "out", t: Date.now(), msg: o }); this.child.stdin.write(JSON.stringify(o) + "\n"); }
  request(method, params, timeoutMs = 240000) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    });
  }
  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
  async recv(line) {
    let m; try { m = JSON.parse(line); } catch { this.log.push({ dir: "in", raw: line }); return; }
    this.log.push({ dir: "in", t: Date.now(), msg: m });
    if (m.id !== undefined && (m.result !== undefined || m.error) && !m.method) {
      const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(Object.assign(new Error(m.error.message), { rpc: m.error })) : p.res(m.result); }
      return;
    }
    if (m.method && m.id === undefined) { if (m.method === "session/update") { this.updates.push(m.params.update); this.onUpdate?.(m.params.update); } return; }
    if (m.method) {
      const reply = (result) => this.send({ jsonrpc: "2.0", id: m.id, result });
      const err = (code, message) => this.send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
      try {
        switch (m.method) {
          case "session/request_permission": {
            const o = m.params.options || []; this.perms.push({ toolCall: m.params.toolCall, options: o });
            const verdict = await this.policy(m.params);
            const pick = verdict === "reject" ? (o.find((x) => /reject/.test(x.kind)) || o[o.length - 1]) : (o.find((x) => x.kind === "allow_once") || o.find((x) => /allow/.test(x.kind)) || o[0]);
            return reply({ outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } });
          }
          case "fs/read_text_file": { this.fsCalls.push({ m: "read", path: m.params.path }); let c = fs.readFileSync(m.params.path, "utf8"); if (m.params.line || m.params.limit) { const ls = c.split("\n"); const s = (m.params.line || 1) - 1; c = ls.slice(s, m.params.limit ? s + m.params.limit : undefined).join("\n"); } return reply({ content: c }); }
          case "fs/write_text_file": { this.fsCalls.push({ m: "write", path: m.params.path }); fs.mkdirSync(path.dirname(m.params.path), { recursive: true }); fs.writeFileSync(m.params.path, m.params.content); return reply(null); }
          case "terminal/create": {
            const id = `t${this.terms.size + 1}`; const cp = spawn(m.params.command, m.params.args || [], { cwd: m.params.cwd || this.cwd, shell: !(m.params.args || []).length, env: { ...process.env } });
            const t = { out: "", cp }; cp.stdout.on("data", (d) => (t.out += d)); cp.stderr.on("data", (d) => (t.out += d));
            t.done = new Promise((r) => cp.on("exit", (c, s) => r({ exitCode: c, signal: s }))); this.terms.set(id, t); return reply({ terminalId: id });
          }
          case "terminal/output": { const t = this.terms.get(m.params.terminalId); return reply({ output: t?.out ?? "", truncated: false, exitStatus: null }); }
          case "terminal/wait_for_exit": { const t = this.terms.get(m.params.terminalId); return reply(await t.done); }
          case "terminal/kill": case "terminal/release": { this.terms.get(m.params.terminalId)?.cp.kill(); return reply(null); }
          default: return err(-32601, `client: ${m.method} not supported`);
        }
      } catch (e) { err(-32000, String(e.message || e)); }
    }
  }
  async close() { try { this.child.stdin.end(); } catch {} await Promise.race([this.exited, sleep(4000)]); if (!this.exitInfo) { try { this.child.kill("SIGTERM"); } catch {} await Promise.race([this.exited, sleep(2000)]); } }
}

const CAPS = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };
const vstMeta = (model) => ({ claudeCode: { options: { betas: ["context-1m-2025-08-07"], extraArgs: { chrome: null }, env: { CLAUDE_CODE_ARTIFACT: "1" }, ...(model ? { model } : {}) } } });
const text = (t) => [{ type: "text", text: t }];

async function open(cwd, { policy, load, model = MODEL, meta = true } = {}) {
  const c = new Client(cwd, policy, model); c.start();
  c.init = await c.request("initialize", { protocolVersion: 1, clientCapabilities: CAPS, clientInfo: { name: "vst-parity", version: "0" } });
  const p = { cwd, mcpServers: [], ...(meta ? { _meta: vstMeta(model) } : {}) };
  if (load) { c.sessionLoad = await c.request("session/load", { ...p, sessionId: load }); c.sessionId = load; }
  else { c.session = await c.request("session/new", p); c.sessionId = c.session.sessionId; }
  return c;
}
const prompt = (c, t, extra = []) => c.request("session/prompt", { sessionId: c.sessionId, prompt: [...(typeof t === "string" ? text(t) : t), ...extra] });
const mkProject = (name, files = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `parity-${LABEL}-${name}-`));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  return fs.realpathSync(d);
};
const waitFor = async (pred, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return false; };

// ── scenarios ────────────────────────────────────────────────────────────────
const S = {};
S.plain = async () => {
  const c = await open(mkProject("plain"));
  const r = await prompt(c, "Reply with exactly the single word: pong");
  return { c, r };
};
S.perm_allow = async () => {
  const c = await open(mkProject("perm"), { policy: () => "allow" });
  const r = await prompt(c, "Use the Bash tool to run exactly: echo hello-parity . Then reply: done");
  return { c, r };
};
S.perm_deny = async () => {
  const c = await open(mkProject("deny"), { policy: () => "reject" });
  const r = await prompt(c, "Use the Bash tool to run exactly: echo hello-deny . If it is refused, just reply: refused");
  return { c, r };
};
S.edit_diff = async () => {
  const d = mkProject("edit", { "a.txt": "alpha\nbeta\ngamma\n" });
  const c = await open(d, { policy: () => "allow" });
  const r = await prompt(c, "Use the Edit tool to change the line 'beta' to 'BETA' in a.txt (path " + path.join(d, "a.txt") + "). Do nothing else, then reply: edited");
  c.fileAfter = fs.readFileSync(path.join(d, "a.txt"), "utf8");
  return { c, r };
};
S.write_new = async () => {
  const d = mkProject("write");
  const c = await open(d, { policy: () => "allow" });
  const r = await prompt(c, "Use the Write tool to create " + path.join(d, "new.txt") + " containing exactly: hello-new . Then reply: written");
  c.fileAfter = fs.existsSync(path.join(d, "new.txt")) ? fs.readFileSync(path.join(d, "new.txt"), "utf8") : null;
  return { c, r };
};
S.cancel = async () => {
  const c = await open(mkProject("cancel"), { policy: () => "allow" });
  const pr = prompt(c, "Run the Bash command `sleep 60; echo late` and then reply: finished");
  const ok = await waitFor(() => c.updates.some((u) => u.sessionUpdate === "tool_call"), 90000);
  await sleep(1500);
  c.cancelledAt = Date.now(); c.notify("session/cancel", { sessionId: c.sessionId });
  let r; try { r = await pr; } catch (e) { r = { error: String(e.message) }; }
  c.cancelLatencyMs = Date.now() - c.cancelledAt;
  return { c, r, extra: { sawToolCallBeforeCancel: ok } };
};
S.steer = async () => {
  const c = await open(mkProject("steer"), { policy: () => "allow" });
  const pr = prompt(c, "Run the Bash command `sleep 25; echo first-done` and when it is finished reply: FIRST-OK");
  await waitFor(() => c.updates.some((u) => u.sessionUpdate === "tool_call"), 90000);
  await sleep(1000);
  let steer; try { steer = await c.request("_session/steering", { sessionId: c.sessionId, prompt: text("Also, at the end of your final reply add the token STEER-OK"), _meta: { steering: { idleBehavior: "promptRequired" } } }, 30000); } catch (e) { steer = { error: String(e.message), rpc: e.rpc }; }
  const r = await pr;
  const joined = c.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text || "").join("");
  return { c, r, extra: { steerResponse: steer, steerTokenInReply: /STEER-OK/.test(joined) } };
};
S.queued = async () => {
  const c = await open(mkProject("queued"), { policy: () => "allow" });
  const p1 = prompt(c, "Run the Bash command `sleep 12; echo one` and then reply: ONE-DONE");
  await waitFor(() => c.updates.some((u) => u.sessionUpdate === "tool_call"), 90000);
  const p2 = prompt(c, "Reply with exactly: TWO-DONE");
  const [r1, r2] = await Promise.all([p1, p2]);
  return { c, r: { first: r1, second: r2 } };
};
S.resume = async () => {
  const d = mkProject("resume");
  const c1 = await open(d);
  await prompt(c1, "Remember: the secret word is banana. Reply with only: stored");
  const sid = c1.sessionId; await c1.close();
  const c2 = await open(d, { load: sid });
  const replay = c2.updates.map((u) => u.sessionUpdate);
  const mark = c2.updates.length;
  const r = await prompt(c2, "What is the secret word I told you? Reply with only that word.");
  const reply = c2.updates.slice(mark).filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text || "").join("");
  return { c: c2, r, extra: { loadedSessionId: sid, replayKinds: replay, secretRecalled: /banana/i.test(reply), reply: reply.slice(0, 80), sessionLoadResponse: c2.sessionLoad } };
};
S.subagent = async () => {
  const c = await open(mkProject("sub"), { policy: () => "allow" });
  const r = await prompt(c, "Use the Task tool (a subagent) to compute 17*3 and report back. Then reply with the number only.");
  return { c, r };
};
S.background = async () => {
  const c = await open(mkProject("bg"), { policy: () => "allow" });
  const r = await prompt(c, "Use the Bash tool with run_in_background=true to run: sleep 6; echo bg-finished . Right after starting it, reply exactly: STARTED, and stop.");
  const t0 = Date.now(); const mark = c.updates.length;
  await sleep(22000);   // autonomous task-notification cycle, if any, lands after the prompt returned
  return { c, r, extra: { postPromptUpdates: c.updates.slice(mark).map((u) => ({ k: u.sessionUpdate, status: u.status, text: (u.content?.text || "").slice(0, 60), meta: u._meta ? Object.keys(u._meta) : undefined })), waitedMs: Date.now() - t0 } };
};
S.image = async () => {
  const c = await open(mkProject("img"));
  const r = await prompt(c, [{ type: "image", mimeType: "image/png", data: RED_PNG }, { type: "text", text: "What single colour is this image? One word." }]);
  return { c, r };
};
S.commands = async () => {
  const c = await open(mkProject("cmds"));
  await sleep(1500);
  const r = await prompt(c, "/context");
  return { c, r };
};
S.model = async () => {
  const c = await open(mkProject("model"), { model: "haiku" });
  const out = { newSessionKeys: Object.keys(c.session || {}), models: c.session.models, configOptions: c.session.configOptions, modes: c.session.modes };
  for (const [cfg, val] of [["model", "sonnet"], ["model", "haiku"]]) {
    try { out[`set_${cfg}_${val}`] = await c.request("session/set_config_option", { sessionId: c.sessionId, configId: cfg, value: val }, 30000); }
    catch (e) { out[`set_${cfg}_${val}`] = { error: String(e.message), rpc: e.rpc }; }
  }
  for (const [m, p] of [["session/set_model", { sessionId: c.sessionId, modelId: "sonnet" }], ["session/set_mode", { sessionId: c.sessionId, modeId: "default" }]]) {
    try { out[m] = await c.request(m, p, 30000); } catch (e) { out[m] = { error: String(e.message), rpc: e.rpc }; }
  }
  const r = await prompt(c, "Reply with exactly: model-ok");
  return { c, r, extra: out };
};
S.ask_user = async () => {   // bun adapters disallow AskUserQuestion; does the model reach for it here?
  const c = await open(mkProject("ask"), { policy: () => "allow" });
  const r = await prompt(c, "I need to choose between two options. Use the AskUserQuestion tool to ask me whether I prefer tea or coffee. If you cannot use that tool, just ask me in plain text.");
  return { c, r };
};
S.vst_meta_argv = async () => {   // what claude was spawned with when given vst's real _meta
  const c = await open(mkProject("meta"));
  const r = await prompt(c, "Reply with exactly: meta-ok");
  return { c, r };
};

const optList = (c) => (c.session?.configOptions || []).map((o) => ({ id: o.id, current: o.currentValue, values: (o.options || []).flatMap((x) => (x.options ? x.options : [x])).map((x) => x.value) }));
S.discover = async () => {   // initialize + session/new shapes, advertised methods actually answering
  const c = await open(mkProject("disc"));
  const out = { configOptions: optList(c), sessionKeys: Object.keys(c.session).sort(), modes: c.session.modes && { cur: c.session.modes.currentModeId, ids: (c.session.modes.availableModes || []).map((m) => m.id) }, models: c.session.models && { cur: c.session.models.currentModelId, n: (c.session.models.availableModels || []).length } };
  for (const [m, p] of [["session/list", { cwd: c.cwd }], ["session/set_mode", { sessionId: c.sessionId, modeId: "default" }], ["session/set_model", { sessionId: c.sessionId, modelId: "haiku" }], ["session/set_config_option", { sessionId: c.sessionId, configId: "model", value: "haiku" }], ["session/resume", { sessionId: c.sessionId, cwd: c.cwd, mcpServers: [] }]]) {
    try { const r = await c.request(m, p, 30000); out[m] = { ok: true, keys: r && typeof r === "object" ? Object.keys(r).sort() : r }; } catch (e) { out[m] = { error: String(e.message), code: e.rpc?.code }; }
  }
  return { c, r: null, extra: out };
};
S.lifecycle = async () => {
  const d = mkProject("life"); const c = await open(d); await prompt(c, "Reply with: ok");
  const out = {};
  for (const [m, p] of [["session/list", { cwd: d }], ["session/fork", { sessionId: c.sessionId, cwd: d, mcpServers: [] }], ["session/resume", { sessionId: c.sessionId, cwd: d, mcpServers: [] }], ["session/close", { sessionId: c.sessionId }], ["session/delete", { sessionId: c.sessionId }]]) {
    try { const r = await c.request(m, p, 60000); out[m] = { ok: true, keys: r && typeof r === "object" ? Object.keys(r).sort() : r, count: r?.sessions?.length, newId: !!(r?.sessionId && r.sessionId !== c.sessionId) }; } catch (e) { out[m] = { error: String(e.message), code: e.rpc?.code }; }
  }
  return { c, r: null, extra: out };
};
S.write_over_existing = async () => {   // P9: upstream's PostToolUse hook turns a Write over an existing file into a real diff
  const d = mkProject("wover", { "w.txt": "old-line\n" }); const c = await open(d, { policy: () => "allow" });
  const r = await prompt(c, "Use the Write tool to overwrite " + path.join(d, "w.txt") + " with exactly: new-line . Do not read it first. Reply: written");
  c.fileAfter = fs.readFileSync(path.join(d, "w.txt"), "utf8"); return { c, r };
};
S.mcp = async () => {
  const mcp = [{ name: "parity-echo", command: process.execPath, args: [path.resolve(path.dirname(process.argv[1]), "mcp-echo-server.mjs")], env: [] }];
  const d = mkProject("mcp"); const c = new Client(d, () => "allow", MODEL); c.start();
  c.init = await c.request("initialize", { protocolVersion: 1, clientCapabilities: CAPS, clientInfo: { name: "vst-parity", version: "0" } });
  c.session = await c.request("session/new", { cwd: d, mcpServers: mcp, _meta: vstMeta(MODEL) }); c.sessionId = c.session.sessionId;
  const r = await prompt(c, "Call the echo_parity tool from the parity-echo MCP server with text 'hi' and report exactly what it returned.");
  return { c, r, extra: { toolReplied: /MCP-ECHO:hi/.test(textOf(c) + JSON.stringify(c.updates)) } };
};
S.kill_mid_turn = async () => {
  const d = mkProject("kmt"); const c1 = await open(d, { policy: () => "allow" });
  await prompt(c1, "Remember: the secret word is plum. Reply with only: stored");
  const pr = prompt(c1, "Run the Bash command `sleep 40` and then reply: finished").catch((e) => ({ error: String(e.message) }));
  await waitFor(() => c1.updates.some((u) => u.sessionUpdate === "tool_call"), 60000); await sleep(1000);
  const sid = c1.sessionId; c1.child.kill("SIGKILL"); await Promise.race([pr, sleep(3000)]); await sleep(2000);
  let c2, err; try { c2 = await open(d, { load: sid }); } catch (e) { err = String(e.message); }
  if (!c2) return { c: null, r: null, extra: { loadError: err } };
  const r = await prompt(c2, "What is the secret word? Reply with only that word.");
  return { c: c2, r, extra: { recalled: /plum/i.test(textOf(c2)) } };
};
S.concurrent_sessions = async () => {
  const d = mkProject("conc"); const c = await open(d, { policy: () => "allow" });
  const s2 = await c.request("session/new", { cwd: d, mcpServers: [], _meta: vstMeta(MODEL) }); const sid1 = c.sessionId;
  const mk = (sid, t) => c.request("session/prompt", { sessionId: sid, prompt: text(t) }, 100000).catch((e) => ({ error: String(e.message) }));
  const [a, b] = await Promise.all([mk(sid1, "Reply with exactly: ALPHA-ONE"), mk(s2.sessionId, "Reply with exactly: BETA-TWO")]);
  const by = (sid) => c.log.filter((l) => l.msg?.method === "session/update" && l.msg.params.sessionId === sid && l.msg.params.update.sessionUpdate === "agent_message_chunk").map((l) => l.msg.params.update.content?.text || "").join("");
  return { c, r: { a, b }, extra: { s1Text: by(sid1), s2Text: by(s2.sessionId), crossTalk: /BETA/.test(by(sid1)) || /ALPHA/.test(by(s2.sessionId)) } };
};
S.close_during_turn = async () => {
  const c = await open(mkProject("cdt"), { policy: () => "allow" });
  const pr = prompt(c, "Run the Bash command `sleep 30` then reply: finished").catch((e) => ({ error: String(e.message) }));
  await waitFor(() => c.updates.some((u) => u.sessionUpdate === "tool_call"), 60000); await sleep(800);
  let cl; try { await c.request("session/close", { sessionId: c.sessionId }, 30000); cl = "ok"; } catch (e) { cl = { error: String(e.message), code: e.rpc?.code }; }
  const r = await Promise.race([pr, sleep(15000).then(() => "prompt-still-pending-15s-after-close")]);
  return { c, r: { promptOutcome: r }, extra: { closeResult: cl } };
};

S.queued3 = async () => {   // 3 prompts queued behind a running turn: stop reasons + reply order + whether replies merge
  const c = await open(mkProject("q3"), { policy: () => "allow" });
  const p1 = prompt(c, "Run the Bash command `sleep 8; echo one` then reply: FIRST");
  await waitFor(() => c.updates.some((u) => u.sessionUpdate === "tool_call"), 90000);
  const mark = c.updates.length;
  const p2 = prompt(c, "Reply with exactly: QA"), p3 = prompt(c, "Reply with exactly: QB"), p4 = prompt(c, "Reply with exactly: QC");
  const rs = await Promise.all([p1, p2, p3, p4].map((p) => p.catch((e) => ({ error: String(e.message) }))));
  const t = textOf(c);
  return { c, r: { stops: rs.map((x) => x.stopReason || x.error) }, extra: { text: t.slice(0, 120), order: ["FIRST", "QA", "QB", "QC"].map((k) => t.indexOf(k)) } };
};

// ── summary ──────────────────────────────────────────────────────────────────
function shape(u) {
  const o = { k: u.sessionUpdate };
  for (const f of ["kind", "status", "title", "name"]) if (u[f] !== undefined) o[f] = f === "title" ? String(u.title).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").slice(0, 80) : u[f];
  if (u.content !== undefined) o.content = Array.isArray(u.content) ? u.content.map((x) => (x.type === "diff" ? { type: "diff", path: path.basename(x.path || ""), oldText: x.oldText ?? null, newText: x.newText } : x.type === "content" ? { type: "content", ct: x.content?.type, text: (x.content?.text || "").slice(0, 80) } : { type: x.type })) : { text: (u.content?.text || "").slice(0, 80), ct: u.content?.type };
  if (u.rawInput !== undefined) o.rawInputKeys = Object.keys(u.rawInput || {}).sort();
  if (u.rawOutput !== undefined) o.hasRawOutput = true;
  if (u.locations) o.locations = u.locations.map((l) => path.basename(l.path || ""));
  if (u._meta) o.metaKeys = Object.keys(u._meta).sort(), (o.claudeCodeMeta = u._meta.claudeCode ? Object.keys(u._meta.claudeCode).sort() : undefined);
  if (u.availableCommands) o.commands = u.availableCommands.map((x) => x.name).sort();
  if (u.used !== undefined) o.usage = { hasUsed: true, hasSize: u.size !== undefined, hasCost: u.cost !== undefined };
  return o;
}
function collapse(shapes) {   // collapse streaming chunks to "kind×n"
  const out = [];
  for (const s of shapes) {
    const last = out[out.length - 1];
    const key = JSON.stringify(s.k === "agent_message_chunk" || s.k === "agent_thought_chunk" || s.k === "user_message_chunk" ? { k: s.k } : s);
    if (last && last.key === key) last.n++; else out.push({ key, n: 1, s });
  }
  return out.map((x) => (x.n > 1 ? { ...(x.s.k.endsWith("_chunk") ? { k: x.s.k } : x.s), repeat: ">1" } : x.s.k.endsWith("_chunk") ? { k: x.s.k } : x.s));
}
const textOf = (c, kind = "agent_message_chunk") => c.updates.filter((u) => u.sessionUpdate === kind).map((u) => u.content?.text || "").join("");

const names = Object.keys(S).filter((n) => !ONLY || ONLY.includes(n));
const summary = { label: LABEL, cmd: CMD, model: MODEL, startedAt: new Date().toISOString(), scenarios: {} };
for (const n of names) {
  const t0 = Date.now(); process.stderr.write(`[${LABEL}] ${n} … `);
  let res, error;
  const wrapBefore = fs.existsSync(WRAP_LOG) ? fs.readFileSync(WRAP_LOG, "utf8").split("\n").filter(Boolean).length : 0;
  try { res = await Promise.race([S[n](), sleep(420000).then(() => { throw new Error("scenario timeout"); })]); } catch (e) { error = String(e.message || e); }
  const entry = { ms: Date.now() - t0 };
  if (error) entry.error = error;
  if (res && !res.c) { entry.extra = res.extra; }
  if (res && res.c) {
    const { c, r, extra } = res;
    entry.init = { agentInfo: c.init.agentInfo, caps: c.init.agentCapabilities, authMethods: c.init.authMethods, meta: c.init._meta };
    entry.sessionNew = c.session ? { keys: Object.keys(c.session).sort(), models: c.session.models, modes: c.session.modes && Object.keys(c.session.modes), configOptions: Array.isArray(c.session.configOptions) ? c.session.configOptions.map((o) => o.id) : c.session.configOptions } : undefined;
    entry.result = r; entry.updateShape = collapse(c.updates.map(shape));
    entry.agentText = textOf(c).slice(0, 400);
    entry.permissions = c.perms.map((p) => ({ tool: p.toolCall && { kind: p.toolCall.kind, title: String(p.toolCall.title || "").slice(0, 60), name: p.toolCall.name }, options: p.options.map((o) => ({ id: o.optionId, kind: o.kind, name: o.name })) }));
    entry.fsCalls = c.fsCalls; entry.terminals = c.terms.size;
    if (c.fileAfter !== undefined) entry.fileAfter = c.fileAfter;
    if (c.cancelLatencyMs !== undefined) entry.cancelLatencyMs = c.cancelLatencyMs;
    entry.extra = extra; entry.stderrTail = redact(c.stderr.slice(-600));
    fs.writeFileSync(path.join(OUT, `${n}.transcript.json`), JSON.stringify(c.log.map((l) => ({ ...l, t: undefined })), null, 1));
    const calls = fs.readFileSync(WRAP_LOG, "utf8").split("\n").filter(Boolean).slice(wrapBefore).map((l) => JSON.parse(l));
    entry.claudeSpawns = calls.map((x) => ({ argv: x.argv.map((a) => a.replace(/--session-id=.*/, "--session-id=<id>").replace(/--resume=?.*/, "--resume=<id>")), env: x.env }));
    await res.c.close();
  }
  summary.scenarios[n] = entry;
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"));
  process.stderr.write(`${error ? "ERROR " + error : "ok"} (${entry.ms}ms)\n`);
}
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
process.exit(0);
