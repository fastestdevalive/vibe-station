import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { registerSessionLs } from "../commands/session/ls.js";
import { buildProgram } from "../program.js";

/**
 * `vst session ls` — `--worktree`/`--name` filters + `--json` output.
 * Deep-test harness mirrors `session-terminate.test.ts` EXACTLY (M3): fetch
 * stubbed directly via `vi.stubGlobal("fetch", ...)` (NOT a `daemonGet`
 * mock), `process.exit` stubbed to throw so `die()`/`printJson()`'s internal
 * `process.exit(...)` calls are catchable instead of killing the worker.
 * Unlike session-terminate.test.ts, `console.log` is SPIED (not silenced) so
 * `--json` output can be captured and asserted on (M4) — `printJson`/
 * `printTable` both write via `console.log` directly (output.ts:3-31), not
 * through commander's configured output stream.
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
let loggedArgs: unknown[][] = [];
let daemonSessions: unknown[] = [];

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
  loggedArgs = [];
  daemonSessions = [];
  process.env.VST_DAEMON_URL = "http://127.0.0.1:9";

  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);

  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    loggedArgs.push(args);
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/health")) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      captured.push({ url, method: init?.method ?? "GET" });
      return { ok: true, status: 200, json: async () => daemonSessions };
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VST_DAEMON_URL;
});

describe("session ls command registration", () => {
  it("B1.T1 — registers ls with --worktree, --name, --json options", () => {
    const session = new Command();
    registerSessionLs(session);

    const lsCommand = session.commands.find((cmd) => cmd.name() === "ls");
    expect(lsCommand).toBeDefined();
    const flags = (lsCommand?.options ?? []).map((o) => o.long);
    expect(flags).toContain("--worktree");
    expect(flags).toContain("--name");
    expect(flags).toContain("--json");
  });
});

describe("vst session ls", () => {
  it("B1.T2 — --worktree <id> results in a fetch to /sessions?worktree=<id>", async () => {
    daemonSessions = [];
    await run(["session", "ls", "--worktree", "vs-19", "--json"]);

    const get = captured.find((c) => c.url.includes("/sessions?worktree=vs-19"));
    expect(get, "expected a GET to /sessions?worktree=vs-19").toBeDefined();
    expect(get!.method).toBe("GET");
  });

  it("no --worktree — fetch hits /sessions with no query", async () => {
    daemonSessions = [];
    await run(["session", "ls", "--json"]);

    const get = captured.find((c) => c.url.endsWith("/sessions"));
    expect(get, "expected a GET to /sessions with no query").toBeDefined();
  });

  it("B1.T3 — --name filters the response to only sessions whose .name matches", async () => {
    daemonSessions = [
      { id: "vs-19-a", worktreeId: "vs-19", type: "agent", state: "idle", name: "reviewer" },
      { id: "vs-19-b", worktreeId: "vs-19", type: "agent", state: "idle", name: "other" },
      { id: "vs-19-c", worktreeId: "vs-19", type: "agent", state: "idle", name: "reviewer" },
    ];
    await run(["session", "ls", "--worktree", "vs-19", "--name", "reviewer", "--json"]);

    const printed = loggedArgs[0]?.[0];
    expect(typeof printed).toBe("string");
    const parsed = JSON.parse(printed as string) as Array<{ id: string; name: string }>;
    expect(parsed.map((s) => s.id).sort()).toEqual(["vs-19-a", "vs-19-c"]);
    expect(parsed.every((s) => s.name === "reviewer")).toBe(true);
  });

  it("B1.T4 — --json prints a single JSON-parseable array matching the filtered set", async () => {
    daemonSessions = [
      { id: "vs-19-a", worktreeId: "vs-19", type: "agent", state: "idle", name: "reviewer" },
      { id: "vs-19-b", worktreeId: "vs-19", type: "agent", state: "idle", name: "other" },
    ];
    const code = await run(["session", "ls", "--worktree", "vs-19", "--name", "reviewer", "--json"]);

    // printJson() calls process.exit(0) internally, which the stub converts
    // into an ExitError caught by run() and returned as its exit code — this
    // IS the expected control flow, not a failure.
    expect(code).toBe(0);
    expect(loggedArgs).toHaveLength(1);
    const parsed = JSON.parse(loggedArgs[0]?.[0] as string) as unknown[];
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as { id: string }).id).toBe("vs-19-a");
  });

  it("B1.T5-adjacent — no --name returns the full (worktree-scoped) set unfiltered", async () => {
    daemonSessions = [
      { id: "vs-19-a", worktreeId: "vs-19", type: "agent", state: "idle", name: "reviewer" },
      { id: "vs-19-b", worktreeId: "vs-19", type: "agent", state: "idle", name: "other" },
    ];
    await run(["session", "ls", "--worktree", "vs-19", "--json"]);

    const parsed = JSON.parse(loggedArgs[0]?.[0] as string) as unknown[];
    expect(parsed).toHaveLength(2);
  });
});
