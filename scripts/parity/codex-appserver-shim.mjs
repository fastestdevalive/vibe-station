// codex-appserver-shim.mjs — HARNESS-ONLY. Runs `codex <args>` and rewrites exactly one thing on its stdout:
// an `account/read` result that has BOTH `account` and `requiresOpenaiAuth:true` (what codex 0.163.0 returns for a
// logged-in ChatGPT user) gets `requiresOpenaiAuth:false`. This neutralises finding C1 of the codex port so the
// rest of the parity matrix can be observed; every rewrite is logged to $PARITY_SHIM_LOG. Not used for the reference adapter.
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
const child = spawn(process.env.REAL_CODEX || "codex", process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"], env: process.env });
const trace = (d, l) => { if (process.env.PARITY_SHIM_TRACE) fs.appendFileSync(process.env.PARITY_SHIM_TRACE, d + " " + l.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>") + "\n"); };
readline.createInterface({ input: process.stdin }).on("line", (l) => { trace(">", l); child.stdin.write(l + "\n"); }).on("close", () => { child.stdin.end(); setTimeout(() => child.kill("SIGTERM"), 1500); });   // parent gone => behave like a pipe-connected child
child.stdin.on("error", () => {});
readline.createInterface({ input: child.stdout }).on("line", (l) => {
  try {
    const m = JSON.parse(l);
    // C3 neutraliser: Thread.status is {"type":"idle"} on codex 0.163.0, the port parses a bare string.
    let n3 = 0;
    const fix = (o) => { if (Array.isArray(o)) o.forEach(fix); else if (o && typeof o === "object") { if ("cliVersion" in o && o.status && typeof o.status === "object" && typeof o.status.type === "string") { o.status = o.status.type; n3++; } Object.values(o).forEach(fix); } };
    if (process.env.PARITY_SHIM_C3 === "1" && (m.method === "turn/started" || m.method === "turn/completed") && m.params?.turn && !m.params.turnId) { m.params.turnId = m.params.turn.id; m.params.status = m.params.turn.status; m.params.error = m.params.turn.error; l = JSON.stringify(m); if (process.env.PARITY_SHIM_LOG) fs.appendFileSync(process.env.PARITY_SHIM_LOG, "flattened " + m.method + "\n"); }
    if (process.env.PARITY_SHIM_C3 === "1" && m.method === "thread/status/changed" && m.params?.status && typeof m.params.status === "object") { m.params.status = m.params.status.type; n3++; }
    if (process.env.PARITY_SHIM_C3 === "1") { fix(m); if (n3) { l = JSON.stringify(m); if (process.env.PARITY_SHIM_LOG) fs.appendFileSync(process.env.PARITY_SHIM_LOG, "rewrote Thread.status object->string x" + n3 + "\n"); } }
    if (m.result && m.result.account && m.result.requiresOpenaiAuth === true) {
      m.result.requiresOpenaiAuth = false; l = JSON.stringify(m);
      if (process.env.PARITY_SHIM_LOG) fs.appendFileSync(process.env.PARITY_SHIM_LOG, "rewrote account/read requiresOpenaiAuth true->false\n");
    }
  } catch {}
  trace("<", l);
  process.stdout.write(l + "\n");
});
child.on("exit", (c) => process.exit(c ?? 0));
process.on("SIGTERM", () => child.kill("SIGTERM"));
