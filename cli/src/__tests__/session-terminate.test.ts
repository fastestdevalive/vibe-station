import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildProgram } from "../program.js";

/**
 * `vst session terminate` — arg/env resolution + error/400 paths.
 * Harness mirrors session-reset.test.ts: fetch stubbed directly (nock only
 * patches http.ClientRequest, not undici's fetch), process.exit stubbed to
 * throw so die()/commander's exitOverride don't kill the worker.
 */

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

interface Captured {
  url: string;
  method: string;
}

let captured: Captured[] = [];
let errorMessages: string[] = [];
let daemonStatus = 200;

async function run(argv: string[]): Promise<number | null> {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  try {
    await program.parseAsync(["node", "vst", ...argv]);
    return null;
  } catch (err) {
    if (err instanceof ExitError) return err.code;
    const code = (err as { exitCode?: number }).exitCode;
    if (typeof code === "number") return code;
    throw err;
  }
}

beforeEach(() => {
  captured = [];
  errorMessages = [];
  daemonStatus = 200;
  process.env.VST_DAEMON_URL = "http://127.0.0.1:9";

  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorMessages.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/health")) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      captured.push({ url, method: init?.method ?? "GET" });
      if (daemonStatus !== 200) {
        return {
          ok: false,
          status: daemonStatus,
          json: async () => ({ error: "Cannot delete the main session. Use DELETE /worktrees/:id instead." }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VST_DAEMON_URL;
  delete process.env.VST_SESSION;
});

describe("vst session terminate", () => {
  it("1.T1 explicit id arg present — DELETE /sessions/<id> regardless of $VST_SESSION", async () => {
    process.env.VST_SESSION = "sess-self";
    await run(["session", "terminate", "sess-explicit"]);

    const del = captured.find((c) => c.url.endsWith("/sessions/sess-explicit"));
    expect(del, "expected a DELETE to /sessions/sess-explicit").toBeDefined();
    expect(del!.method).toBe("DELETE");
    expect(captured.find((c) => c.url.endsWith("/sessions/sess-self"))).toBeUndefined();
  });

  it("1.T2 no arg, $VST_SESSION set — DELETE /sessions/$VST_SESSION", async () => {
    process.env.VST_SESSION = "sess-self";
    await run(["session", "terminate"]);

    const del = captured.find((c) => c.url.endsWith("/sessions/sess-self"));
    expect(del, "expected a DELETE to /sessions/sess-self").toBeDefined();
    expect(del!.method).toBe("DELETE");
  });

  it("1.T3 no arg, $VST_SESSION unset — daemon never called, exits non-zero", async () => {
    delete process.env.VST_SESSION;
    const code = await run(["session", "terminate"]);

    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(errorMessages.some((m) => /VST_SESSION/.test(m))).toBe(true);
    expect(captured.find((c) => c.method === "DELETE")).toBeUndefined();
  });

  it("1.T4 daemon 400 (main-slot rejection) surfaces via die() unchanged", async () => {
    daemonStatus = 400;
    const code = await run(["session", "terminate", "sess-main"]);

    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(errorMessages.some((m) => /Cannot delete the main session/.test(m))).toBe(true);
  });
});
