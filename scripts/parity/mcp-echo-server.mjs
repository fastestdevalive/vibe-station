// Minimal stdio MCP server (one tool: echo_parity) for the codex/claude parity MCP scenario.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "parity-echo", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo_parity", description: "Echo the given text back, prefixed with MCP-ECHO:", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "MCP-ECHO:" + (m.params?.arguments?.text ?? "") }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
