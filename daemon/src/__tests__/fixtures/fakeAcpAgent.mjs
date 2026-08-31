#!/usr/bin/env node
// Minimal fake ACP agent for tests — NDJSON JSON-RPC over stdio.
// Behavior is driven by env vars so tests can exercise different paths
// without spawning a real CLI:
//   FAKE_ACP_MODE=normal (default) — initialize/session/new/session/prompt all succeed,
//     streaming one agent_message_chunk before resolving with stopReason "end_turn".
//   FAKE_ACP_MODE=cancel — session/prompt hangs until it receives session/cancel,
//     then resolves with stopReason "cancelled".
//   FAKE_ACP_MODE=exit_before_ready — exits immediately without responding to anything.
//   FAKE_ACP_MODE=hang — never responds to ANYTHING (simulates a wedged adapter, 4.T2).
//   FAKE_ACP_MODE=bg_terminal — the FIRST session/prompt starts a host-managed
//     background terminal (client-side `terminal/create`) and then hangs until
//     session/cancel, resolving "cancelled"; every LATER prompt resolves
//     "end_turn" immediately. Models "a turn that backgrounded a dev server is
//     interrupted, and the next turn runs on the same connection" (1.T6).
//   FAKE_ACP_MODE=permission_request — session/prompt sends a
//     session/request_permission client-request (offering reject_once,
//     allow_once, allow_always in that order) before resolving; the daemon's
//     outcome is echoed back as stopReason ("selected:<optionId>" or
//     "cancelled") so a test can assert it without a human in the loop.
//   FAKE_ACP_MODE=permission_request_reject_only — same, but every offered
//     option is reject-kind (no allow_once/allow_always at all) — asserts the
//     daemon cancels rather than ever "selecting" a rejection as an approval.
//   FAKE_ACP_MODE=prompt_hang — initialize/session/new succeed normally, but
//     session/prompt NEVER responds and ignores session/cancel too (unlike
//     "cancel" mode) — simulates a connection that looks alive (child process
//     still running) but has stopped answering, so the per-request timeout
//     (not process death) must be what eventually rejects the turn.
import { createInterface } from "node:readline";

const mode = process.env.FAKE_ACP_MODE ?? "normal";

if (mode === "exit_before_ready") {
  process.exit(1);
}
if (mode === "hang") {
  // Never respond, never exit — the connect/initialize timeout must fire.
  // (Don't wire up the readline handler below at all — even parsing/ignoring
  // input would still risk an accidental response path.)
  setInterval(() => {}, 60_000);
} else {
  setupNormalHandlers();
}

function setupNormalHandlers() {
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionId = "fake-session-1";
let cancelRequested = false;
let promptCount = 0;
let nextClientReqId = 1000;

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Maps a client-request id we sent to a callback for its eventual response —
// used by permission_request mode to observe what the daemon auto-selected.
const pendingClientRequests = new Map();

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // A RESPONSE to one of our own agent→client requests: dispatch to whoever
  // is waiting on it (permission_request mode), else ignore the payload
  // (terminal/create — we only care that the daemon now owns the child).
  if (msg.id !== undefined && msg.method === undefined) {
    const cb = pendingClientRequests.get(msg.id);
    if (cb) {
      pendingClientRequests.delete(msg.id);
      cb(msg);
    }
    return;
  }
  if (msg.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return;
  }
  if (msg.method === "session/new") {
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    return;
  }
  if (msg.method === "session/load") {
    if (msg.params.sessionId === "fail-me") {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "no such session" } });
    } else {
      write({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
    return;
  }
  if (msg.method === "session/cancel") {
    cancelRequested = true;
    return;
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    if (mode === "bg_terminal") {
      promptCount += 1;
      if (promptCount > 1) {
        // A later turn on the SAME connection — answer immediately.
        write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        return;
      }
      // Turn 1 backgrounds a long-lived process through the HOST (the daemon's
      // AcpTerminalManager owns the OS child, not this process), then hangs.
      write({
        jsonrpc: "2.0",
        id: nextClientReqId++,
        method: "terminal/create",
        params: {
          sessionId: sid,
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
      });
      const bgCheck = setInterval(() => {
        if (cancelRequested) {
          clearInterval(bgCheck);
          cancelRequested = false;
          write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
        }
      }, 20);
      return;
    }
    if (mode === "permission_request" || mode === "permission_request_reject_only") {
      const reqId = nextClientReqId++;
      pendingClientRequests.set(reqId, (resp) => {
        // Echo the daemon's actual outcome back as stopReason: "selected:<id>"
        // or "cancelled" (or "error:<msg>" if it errored) — lets a test assert
        // on the daemon's decision without inspecting the wire protocol.
        const outcome = resp.result?.outcome;
        const stopReason = outcome
          ? outcome.outcome === "selected"
            ? `selected:${outcome.optionId}`
            : outcome.outcome
          : `error:${resp.error?.message}`;
        write({ jsonrpc: "2.0", id: msg.id, result: { stopReason } });
      });
      const options =
        mode === "permission_request_reject_only"
          ? [
              { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
              { optionId: "reject_always", name: "Reject always", kind: "reject_always" },
            ]
          : [
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
            ];
      write({
        jsonrpc: "2.0",
        id: reqId,
        method: "session/request_permission",
        params: { sessionId: sid, toolCall: { toolCallId: "tc-1" }, options },
      });
      return;
    }
    if (mode === "prompt_hang") {
      // Deliberately never write a response and never observe cancelRequested.
      return;
    }
    if (mode === "cancel") {
      const check = setInterval(() => {
        if (cancelRequested) {
          clearInterval(check);
          write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
        }
      }, 20);
      return;
    }
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi from fake agent" } } },
    });
    setTimeout(() => {
      write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }, 20);
    return;
  }
});
}
