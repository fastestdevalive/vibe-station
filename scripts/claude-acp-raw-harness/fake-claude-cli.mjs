#!/usr/bin/env node
// Fake `claude` CLI speaking the stream-json protocol the Agent SDK expects.
// Answers every control_request with success and, on each user message, plays a scripted
// list of SDK messages (HARNESS_SCRIPT = path to a JSON array) then a `result`.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

const script = JSON.parse(readFileSync(process.env.HARNESS_SCRIPT, "utf8"));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const SID = "11111111-1111-4111-8111-111111111111";
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`;
const initResp = {
  commands: [], agents: [], output_style: "default", available_output_styles: ["default"],
  models: [{ value: "default", displayName: "Default", description: "d" }],
  account: {}, pid: process.pid,
};
out({ type: "system", subtype: "init", apiKeySource: "none", cwd: process.cwd(), session_id: SID,
  tools: ["Bash"], mcp_servers: [], model: "claude-sonnet-4-5", permissionMode: "default",
  slash_commands: [], output_style: "default", skills: [], plugins: [], uuid: uuid() });
let turn = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === "control_request") {
    const sub = m.request?.subtype;
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id,
      response: sub === "initialize" ? initResp : {} } });
  } else if (m.type === "user") {
    const steps = script[turn++] ?? [];
    for (const { _name, ...s } of steps) out({ session_id: SID, uuid: uuid(), ...s });
    out({ type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1,
      num_turns: 1, result: "ok", stop_reason: "end_turn", total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {}, permission_denials: [], session_id: SID, uuid: uuid() });
  }
});
