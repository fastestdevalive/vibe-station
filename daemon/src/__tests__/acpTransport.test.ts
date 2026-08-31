import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AcpConnection, ConnectionSpawnFailed, InitializeFailed } from "../services/acp/acpTransport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fakeAcpAgent.mjs");

function makeConnection(mode: string) {
  return new AcpConnection(
    { command: process.execPath, args: [FAKE_AGENT], cwd: __dirname, env: { FAKE_ACP_MODE: mode } },
    "claude",
  );
}

describe("AcpConnection (1.T1)", () => {
  it("rejects with a typed failure (not a hang) when the process exits before responding", async () => {
    const conn = makeConnection("exit_before_ready");
    await expect(conn.initialize()).rejects.toSatisfy(
      (e: unknown) => e instanceof ConnectionSpawnFailed || e instanceof InitializeFailed,
    );
  });

  it("no unhandled rejection is thrown for a normal early-exit failure", async () => {
    const conn = makeConnection("exit_before_ready");
    let threw = false;
    try {
      await conn.initialize();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("4.T2 — a deliberately hung adapter's initialize() rejects with InitializeFailed within its timeout, not indefinitely", async () => {
    const conn = new AcpConnection(
      { command: process.execPath, args: [FAKE_AGENT], cwd: __dirname, env: { FAKE_ACP_MODE: "hang" }, initializeTimeoutMs: 300 },
      "agy",
    );
    const start = Date.now();
    await expect(conn.initialize()).rejects.toBeInstanceOf(InitializeFailed);
    expect(Date.now() - start).toBeLessThan(2000);
    await conn.dispose();
  });
});

describe("AcpConnection happy path", () => {
  it("initialize → session/new → sendPrompt streams updates and resolves stopReason", async () => {
    const conn = makeConnection("normal");
    const { loadSession } = await conn.initialize();
    expect(loadSession).toBe(true);
    const sessionId = await conn.newSession("/tmp");

    const controller = new AbortController();
    const { updates, result } = conn.sendPrompt(sessionId, [{ type: "text", text: "hi" }], controller.signal);
    const seen: string[] = [];
    for await (const ev of updates) {
      seen.push(ev.kind);
    }
    const { stopReason } = await result;
    expect(stopReason).toBe("end_turn");
    expect(seen).toContain("text");
    await conn.dispose();
  });

  it("auto-approves a session/request_permission with the most-permissive offered option, no human in the loop", async () => {
    const conn = makeConnection("permission_request");
    await conn.initialize();
    const sessionId = await conn.newSession("/tmp");
    const { result } = conn.sendPrompt(sessionId, [{ type: "text", text: "edit a file" }], new AbortController().signal);
    // The fixture echoes the chosen optionId back as stopReason (see
    // fakeAcpAgent.mjs's permission_request mode) — asserts the daemon picked
    // "allow_always" over the offered "reject_once"/"allow_once", matching
    // the `--dangerously-skip-permissions` trust model used everywhere else.
    const { stopReason } = await result;
    expect(stopReason).toBe("allow_always");
    await conn.dispose();
  });

  it("cancelActivePrompt (Stop) resolves the prompt with stopReason cancelled without killing the connection", async () => {
    const conn = makeConnection("cancel");
    await conn.initialize();
    const sessionId = await conn.newSession("/tmp");
    const controller = new AbortController();
    const { result } = conn.sendPrompt(sessionId, [{ type: "text", text: "hi" }], controller.signal);
    conn.cancelActivePrompt();
    const { stopReason } = await result;
    expect(stopReason).toBe("cancelled");
    // Connection still usable for a next turn.
    const { result: result2 } = conn.sendPrompt(sessionId, [{ type: "text", text: "again" }], new AbortController().signal);
    await result2;
    await conn.dispose();
  });
});
