#!/usr/bin/env node
/**
 * Fake pi-acp ACP adapter for Docker/API smoke tests.
 *
 * Speaks just enough ACP JSON-RPC 2.0 (newline-delimited over stdio) to let
 * the daemon complete the initialize → session/new → session/prompt flow.
 *
 * Usage as binary:
 *   pi-acp --version     → prints "0.17.1" and exits (satisfies validatePiAcpPresence)
 *   pi-acp               → runs ACP JSON-RPC server on stdin/stdout
 *
 * ACP wire format: one JSON object per line, no Content-Length framing.
 */

"use strict";

const { randomUUID } = require("node:crypto");
const { createInterface } = require("node:readline");

// --version: satisfies validatePiAcpPresence() in pi.ts
if (process.argv[2] === "--version") {
  process.stdout.write("0.17.1\n");
  process.exit(0);
}

// Print the TTY-mode ready sentinel in case anyone checks stdout before
// the first JSON-RPC message (harmless noise in ACP mode — the transport
// tolerates non-JSON lines).
process.stdout.write("╭─ Fake Pi ACP ─╮\n");

let currentSessionId = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handleRequest(req) {
  switch (req.method) {
    case "initialize":
      respond(req.id, {
        agentCapabilities: {},
        agentInfo: {
          name: "@victor-software-house/pi-acp",
          version: "0.17.1",
        },
        _meta: {},
      });
      break;

    case "session/new":
      currentSessionId = randomUUID();
      respond(req.id, { sessionId: currentSessionId });
      break;

    case "session/load":
      currentSessionId = req.params?.sessionId ?? randomUUID();
      respond(req.id, { sessionId: currentSessionId });
      break;

    case "session/prompt": {
      const sid = req.params?.sessionId ?? currentSessionId;
      // Emit one text chunk before resolving the turn.
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello from Fake Pi ACP!" },
          },
        },
      });
      respond(req.id, { stopReason: "end_turn" });
      break;
    }

    case "session/cancel":
      // Notification — no response required.
      break;

    default:
      // Unknown method — send JSON-RPC error so the daemon doesn't hang.
      if (req.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
      }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // tolerate non-JSON noise
  }
  if (msg && typeof msg === "object" && "method" in msg) {
    handleRequest(msg);
  }
});

rl.on("close", () => process.exit(0));
