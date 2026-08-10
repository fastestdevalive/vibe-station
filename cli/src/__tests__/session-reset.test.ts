import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerSessionReset } from "../commands/session/reset.js";
import { buildProgram } from "../program.js";

/**
 * Phase 1 (handoff robustness) coverage for `vst session reset`:
 *  - `--handoff-file <path>` reads a local file and forwards its content as `handoffText`,
 *    mirroring `--prompt-file` (see `cli/src/__tests__/prompt-file.test.ts` — same harness).
 *  - `--handoff` and `--handoff-file` are mutually exclusive (commander `.conflicts()`).
 *  - `--handoff` targeting the session the CLI is running inside ($VST_SESSION) is rejected
 *    client-side, loudly, before any daemon call (Decision 5).
 *
 * Harness notes carried over from prompt-file.test.ts (all load-bearing there too):
 *  - fetch is stubbed directly (nock only patches http.ClientRequest, not undici's fetch).
 *  - VST_DAEMON_URL must be set so getDaemonUrl() never falls back to a real config.
 *  - process.exit is stubbed to throw, so die()/commander's exitOverride don't kill the worker.
 */

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

let captured: Captured[] = [];
let tmpDir: string;

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

let errorMessages: string[] = [];

beforeEach(() => {
  captured = [];
  errorMessages = [];
  tmpDir = mkdtempSync(join(tmpdir(), "vst-session-reset-"));
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
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/health")) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      captured.push({
        url,
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, archivedSessionId: "old-1", newSessionId: "new-1" }),
      };
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VST_DAEMON_URL;
  delete process.env.VST_SESSION;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeHandoff(contents: string): string {
  const p = join(tmpDir, "handoff.md");
  writeFileSync(p, contents);
  return p;
}

describe("session reset command registration", () => {
  it("registers a reset command on the session group", () => {
    const session = new Command();
    registerSessionReset(session);

    const resetCommand = session.commands.find((cmd) => cmd.name() === "reset");
    expect(resetCommand).toBeDefined();
    expect(resetCommand?.description()).toMatch(/reset/i);
  });

  it("has required options", () => {
    const session = new Command();
    registerSessionReset(session);

    const resetCommand = session.commands.find((cmd) => cmd.name() === "reset");
    expect(resetCommand).toBeDefined();

    const optionNames = resetCommand?.options.map((opt) => opt.name()) || [];
    expect(optionNames).toContain("handoff");
    expect(optionNames).toContain("prompt");
    expect(optionNames).toContain("handoff-file");
    expect(optionNames).toContain("mode");
  });
});

describe("1.T8 --mode sends modeId in the reset body (reset-with-mode-switch)", () => {
  it("sends the raw --mode value as modeId, unresolved (the daemon resolves id-or-name)", async () => {
    await run(["session", "reset", "sess-1", "--mode", "claude-sonnet"]);

    const post = captured.find((c) => c.url.endsWith("/sessions/sess-1/reset"));
    expect(post, "expected a POST to /sessions/sess-1/reset").toBeDefined();
    expect(post!.body.modeId).toBe("claude-sonnet");
  });

  it("omits modeId entirely when --mode is not given (unchanged behavior)", async () => {
    await run(["session", "reset", "sess-1"]);

    const post = captured.find((c) => c.url.endsWith("/sessions/sess-1/reset"));
    expect(post, "expected a POST to /sessions/sess-1/reset").toBeDefined();
    expect(post!.body.modeId).toBeUndefined();
  });

  it("combines with --prompt and --handoff-file in the same call", async () => {
    const file = writeHandoff("summary before switching modes");
    await run([
      "session", "reset", "sess-1",
      "--mode", "claude-sonnet",
      "--prompt", "focus on tests now",
      `--handoff-file=${file}`,
    ]);

    const post = captured.find((c) => c.url.endsWith("/sessions/sess-1/reset"));
    expect(post!.body).toMatchObject({
      modeId: "claude-sonnet",
      prompt: "focus on tests now",
      handoffText: "summary before switching modes",
    });
  });
});

describe("1.T1 --handoff-file reads the file and sends its content as handoffText", () => {
  it("sends the file contents as handoffText", async () => {
    const file = writeHandoff("Finished the refactor, tests still pending.");
    await run(["session", "reset", "sess-1", `--handoff-file=${file}`]);

    const post = captured.find((c) => c.url.endsWith("/sessions/sess-1/reset"));
    expect(post, "expected a POST to /sessions/sess-1/reset").toBeDefined();
    expect(post!.body.handoffText).toBe("Finished the refactor, tests still pending.");
  });

  it("exits non-zero and makes no daemon call when --handoff-file does not exist", async () => {
    const code = await run([
      "session", "reset", "sess-1", `--handoff-file=${join(tmpDir, "nope.md")}`,
    ]);

    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(captured.find((c) => c.url.endsWith("/reset"))).toBeUndefined();
  });
});

describe("1.T2 --handoff and --handoff-file conflict", () => {
  it("rejects --handoff and --handoff-file together before the action runs", async () => {
    const file = writeHandoff("summary");
    const code = await run(["session", "reset", "sess-1", "--handoff", `--handoff-file=${file}`]);

    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(captured.find((c) => c.url.endsWith("/reset"))).toBeUndefined();
  });
});

describe("1.T9/1.T10 self-target --handoff guard (Decision 5)", () => {
  it("1.T9 exits non-zero with a --handoff-file remediation message and never calls the daemon", async () => {
    process.env.VST_SESSION = "sess-1";
    const code = await run(["session", "reset", "sess-1", "--handoff"]);

    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(errorMessages.some((m) => /--handoff-file/.test(m))).toBe(true);
    expect(captured.find((c) => c.url.endsWith("/reset"))).toBeUndefined();
  });

  it("1.T10 --handoff on a DIFFERENT session id still calls the daemon (exact-match guard only)", async () => {
    process.env.VST_SESSION = "sess-1";
    await run(["session", "reset", "sess-2", "--handoff"]);

    const post = captured.find((c) => c.url.endsWith("/sessions/sess-2/reset"));
    expect(post, "expected a POST to /sessions/sess-2/reset").toBeDefined();
    expect(post!.body.handoff).toBe(true);
  });

  it("1.T10 --handoff-file on the SAME session id is NOT rejected (guard only fires on --handoff)", async () => {
    process.env.VST_SESSION = "sess-1";
    const file = writeHandoff("self-written summary");
    await run(["session", "reset", "sess-1", `--handoff-file=${file}`]);

    const post = captured.find((c) => c.url.endsWith("/sessions/sess-1/reset"));
    expect(post, "expected a POST to /sessions/sess-1/reset").toBeDefined();
    expect(post!.body.handoffText).toBe("self-written summary");
  });
});
