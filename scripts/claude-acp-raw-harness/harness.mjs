#!/usr/bin/env node
// Offline harness: runs the REAL claude-agent-acp adapter (vendor/claude-acp, pinned 0.98.0)
// against a fake Claude CLI that plays synthetic SDK task messages, and records the exact
// `_claude/sdkMessage` notifications the adapter emits when
// `_meta.claudeCode.emitRawSDKMessages` is set (the opt-in vst makes in claude.rs `acp_meta`).
//
//   node scripts/claude-acp-raw-harness/harness.mjs [out.json [fixtures-dir]]
//
// Output: JSON { initialize, ext: [{method, params}], updates: [session/update params] }
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const entry = join(repo, "vendor/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
const FILTER = [
  { type: "system", subtype: "task_started" },
  { type: "system", subtype: "task_updated" },
  { type: "system", subtype: "task_notification" },
];
const tmp = mkdtempSync(join(tmpdir(), "raw-harness-"));
const scriptPath = join(tmp, "script.json");
const bashTu = "toolu_bash01", agentTu = "toolu_agent01";
const turns = [
  [ // turn 1: background Bash start, plus noise the filter must drop
    { _name: "raw_task_started_bash", type: "system", subtype: "task_started", task_id: "bx1a2b3c4", tool_use_id: bashTu,
      description: "sleep 45; echo done", task_type: "local_bash", is_backgrounded: true },
    { _name: "raw_task_started_ambient", type: "system", subtype: "task_started", task_id: "ambient1", description: "watcher",
      task_type: "local_bash", ambient: true, is_backgrounded: true },
    { _name: "raw_task_started_monitor", type: "system", subtype: "task_started", task_id: "mon1", description: "tail",
      task_type: "local_monitor", tool_use_id: "toolu_mon01" },
    { _name: "raw_task_updated_running", type: "system", subtype: "task_updated", task_id: "bx1a2b3c4", patch: { status: "running" } },
    { _name: "raw_task_updated_paused", type: "system", subtype: "task_updated", task_id: "bx1a2b3c4", patch: { status: "paused" } },
    { _name: "raw_task_updated_backgrounded", type: "system", subtype: "task_updated", task_id: "bx9", patch: { is_backgrounded: true } },
  ],
  [ // turn 2: bash ends + subagent lifecycle
    { _name: "raw_task_notification_completed", type: "system", subtype: "task_notification", task_id: "bx1a2b3c4", tool_use_id: bashTu,
      status: "completed", output_file: "/tmp/tasks/bx1a2b3c4.output", summary: "Background command completed" },
    { _name: "raw_task_updated_killed", type: "system", subtype: "task_updated", task_id: "bx2", patch: { status: "killed" } },
    { _name: "raw_task_notification_failed", type: "system", subtype: "task_notification", task_id: "bx3", tool_use_id: "toolu_bash03",
      status: "failed", output_file: "/tmp/tasks/bx3.output", summary: "Background command failed (exit code 2)" },
    { _name: "raw_task_started_agent", type: "system", subtype: "task_started", task_id: "agent-7f", tool_use_id: agentTu,
      description: "explore", task_type: "local_agent", subagent_type: "general-purpose",
      prompt: "SECRET PROMPT" },
    { _name: "raw_task_updated_failed", type: "system", subtype: "task_updated", task_id: "agent-7f", patch: { status: "failed", error: "boom" } },
    { _name: "raw_task_notification_worker_restart", type: "system", subtype: "task_notification", task_id: "agent-7f", tool_use_id: agentTu,
      status: "stopped", reason: "worker_restart", output_file: "/tmp/tasks/agent-7f.output", summary: "stopped" },
    { type: "system", subtype: "status", status: null }, // must NOT be forwarded
  ],
];
// Names of the steps the filter forwards, in emission order (the `status` noise is dropped).
const names = turns.flat().filter((t) => t._name).map((t) => t._name);
writeFileSync(scriptPath, JSON.stringify(turns));

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, CLAUDE_CODE_EXECUTABLE: join(here, "fake-claude-cli.mjs"),
    HARNESS_SCRIPT: scriptPath, HOME: tmp, ANTHROPIC_API_KEY: "sk-harness" },
});
let id = 0;
const pending = new Map();
const result = { initialize: null, ext: [], updates: [] };
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) {
    pending.get(m.id)(m); pending.delete(m.id); return;
  }
  if (m.id !== undefined && m.method) { // agent -> client request: answer permissively
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n"); return;
  }
  if (m.method === "session/update") result.updates.push(m.params);
  else if (m.method) result.ext.push({ method: m.method, params: m.params });
});
const call = (method, params) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
});
const timeout = setTimeout(() => { console.error("harness timeout"); child.kill(); process.exit(2); }, 60000);
try {
  // Same client capabilities vst declares: NO _meta (no AIR).
  result.initialize = await call("initialize", { protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  const s = await call("session/new", { cwd: tmp, mcpServers: [],
    _meta: { claudeCode: { options: {}, emitRawSDKMessages: FILTER } } });
  for (const text of ["start", "finish"]) {
    await call("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text }] });
  }
  await new Promise((r) => setTimeout(r, 300));
  result.sessionId = s.sessionId;
  const outPath = process.argv[2];
  const fixturesDir = process.argv[3];
  if (fixturesDir) {
    // One fixture per forwarded message, exactly as the adapter put it on the wire.
    if (names.length !== result.ext.length) throw new Error(`expected ${names.length} ext notifications, got ${result.ext.length}`);
    result.ext.forEach((e, i) => writeFileSync(join(fixturesDir, names[i] + ".json"), JSON.stringify(e.params, null, 2) + "\n"));
  }
  // Machine-independent summary (no cwd / command catalogue): ext notifications verbatim + update kinds.
  const summary = { adapter: "@agentclientprotocol/claude-agent-acp", ext: result.ext,
    sessionUpdateKinds: result.updates.map((u) => u.update?.sessionUpdate) };
  const json = JSON.stringify(summary, null, 2);
  if (outPath) writeFileSync(outPath, json); else console.log(json);
} finally { clearTimeout(timeout); child.kill(); }
