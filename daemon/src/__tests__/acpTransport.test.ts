import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { AcpConnection, ConnectionSpawnFailed, InitializeFailed, type AcpSessionMeta } from "../services/acp/acpTransport.js";

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
    // The fixture echoes the daemon's actual outcome back as stopReason (see
    // fakeAcpAgent.mjs's permission_request mode) — asserts the daemon picked
    // "allow_always" over the offered "reject_once"/"allow_once", matching
    // the `--dangerously-skip-permissions` trust model used everywhere else.
    const { stopReason } = await result;
    expect(stopReason).toBe("selected:allow_always");
    await conn.dispose();
  });

  it("cancels rather than approving when every offered permission option is reject-kind", async () => {
    const conn = makeConnection("permission_request_reject_only");
    await conn.initialize();
    const sessionId = await conn.newSession("/tmp");
    const { result } = conn.sendPrompt(sessionId, [{ type: "text", text: "do something risky" }], new AbortController().signal);
    // No allow_once/allow_always offered at all — the daemon must never fall
    // back to blindly picking options[0] (a reject option) and reporting it
    // as "selected", which would silently approve a rejection.
    const { stopReason } = await result;
    expect(stopReason).toBe("cancelled");
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

describe("5.T1 — AcpConnection supportsSteering from initialize _meta", () => {
  it("supportsSteering is true when initialize response carries _meta.steering.supported=true", async () => {
    const conn = makeConnection("steering_supported");
    await conn.initialize();
    expect(conn.supportsSteering).toBe(true);
    await conn.dispose();
  });

  it("supportsSteering is false when initialize response has no _meta", async () => {
    const conn = makeConnection("normal");
    await conn.initialize();
    expect(conn.supportsSteering).toBe(false);
    await conn.dispose();
  });
});

describe("5.T2 — AcpConnection steer() returns 'unsupported' on method-not-found", () => {
  it("steer() returns 'unsupported' when agent responds with -32601 method-not-found, does not throw", async () => {
    const conn = makeConnection("steering_method_not_found");
    await conn.initialize();
    await conn.newSession("/tmp");
    const result = await conn.steer([{ type: "text", text: "steer me" }]);
    expect(result).toBe("unsupported");
    await conn.dispose();
  });
});

describe("AcpConnection self-healing (idle-dispose / crash respawn regression)", () => {
  it("isAlive() flips to false and onDispose fires exactly once when dispose() is called", async () => {
    let disposeCalls = 0;
    const conn = new AcpConnection(
      { command: process.execPath, args: [FAKE_AGENT], cwd: __dirname, env: { FAKE_ACP_MODE: "normal" } },
      "claude",
      undefined,
      () => {
        disposeCalls += 1;
      },
    );
    await conn.initialize();
    expect(conn.isAlive()).toBe(true);

    await conn.dispose();
    await conn.dispose(); // idempotent — must not double-fire onDispose
    expect(conn.isAlive()).toBe(false);
    expect(disposeCalls).toBe(1);
  });

  it("onDispose fires when the child process exits on its own (crash), not just on explicit dispose()", async () => {
    let disposed = false;
    const conn = new AcpConnection(
      { command: process.execPath, args: [FAKE_AGENT], cwd: __dirname, env: { FAKE_ACP_MODE: "normal" } },
      "claude",
      undefined,
      () => {
        disposed = true;
      },
    );
    await conn.initialize();
    const sessionId = await conn.newSession("/tmp");

    // Kill the child out from under the connection — mirrors a crash, not a
    // clean dispose() call.
    const pid = (conn as unknown as { child: { pid?: number } }).child?.pid;
    expect(pid).toBeTruthy();
    process.kill(pid!, "SIGKILL");

    const deadline = Date.now() + 2000;
    while (!disposed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(disposed).toBe(true);
    expect(conn.isAlive()).toBe(false);

    // A prompt against the now-dead connection must reject immediately with
    // a clear error, never hang or silently drop the write.
    await expect(
      conn.sendPrompt(sessionId, [{ type: "text", text: "hi" }], new AbortController().signal).result,
    ).rejects.toThrow(/disposed/i);
  });

  it("a request against an already-disposed connection rejects immediately instead of hanging", async () => {
    const conn = makeConnection("normal");
    await conn.initialize();
    await conn.dispose();

    await expect(conn.newSession("/tmp")).rejects.toThrow(/disposed/i);
  });

  it("session/prompt times out with a clear error instead of hanging forever when the agent stops responding", async () => {
    const conn = new AcpConnection(
      {
        command: process.execPath,
        args: [FAKE_AGENT],
        cwd: __dirname,
        env: { FAKE_ACP_MODE: "prompt_hang" },
        promptTimeoutMs: 200,
      },
      "claude",
    );
    await conn.initialize();
    const sessionId = await conn.newSession("/tmp");

    const start = Date.now();
    const { result } = conn.sendPrompt(sessionId, [{ type: "text", text: "hi" }], new AbortController().signal);
    await expect(result).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeLessThan(2000);
    await conn.dispose();
  });
});

describe("AcpConnection _meta forwarding", () => {
  const BETA_META: AcpSessionMeta = { claudeCode: { options: { betas: ["context-1m-2025-08-07"] } } };

  /**
   * Runs `body` against an `echo_meta` fake agent and returns what that agent
   * saw on the wire: `{ hasMeta, meta }`, written on EVERY session/new|load so
   * absence is observed rather than inferred from a missing file.
   */
  async function captureWireMeta(
    body: (conn: AcpConnection) => Promise<void>,
  ): Promise<{ hasMeta: boolean; meta: unknown }> {
    const dir = mkdtempSync(join(tmpdir(), "acp-meta-"));
    const outFile = join(dir, "meta.json");
    const conn = new AcpConnection(
      { command: process.execPath, args: [FAKE_AGENT], cwd: __dirname, env: { FAKE_ACP_MODE: "echo_meta", META_OUT_FILE: outFile } },
      "claude",
    );
    try {
      await conn.initialize();
      await body(conn);
      return JSON.parse(readFileSync(outFile, "utf8"));
    } finally {
      await conn.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("newSession forwards _meta to the wire (betas reach the adapter)", async () => {
    const seen = await captureWireMeta((conn) => conn.newSession("/tmp", BETA_META).then(() => {}));
    expect(seen).toEqual({ hasMeta: true, meta: BETA_META });
  });

  it("loadSession forwards _meta to the wire", async () => {
    const seen = await captureWireMeta((conn) => conn.loadSession("/tmp", "fake-session-1", BETA_META));
    expect(seen).toEqual({ hasMeta: true, meta: BETA_META });
  });

  it("newSession omits _meta from the wire when no meta is passed", async () => {
    const seen = await captureWireMeta((conn) => conn.newSession("/tmp").then(() => {}));
    expect(seen).toEqual({ hasMeta: false, meta: null });
  });
});
