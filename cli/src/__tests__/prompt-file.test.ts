import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../program";

/**
 * Regression tests for `--prompt-file` / `--context-file`.
 *
 * The bug: commander camelCases dashed options (`--prompt-file` → `opts.promptFile`), but the
 * handlers read `opts["prompt-file"]` — always undefined. The file was never read, `prompt` stayed
 * undefined, JSON.stringify dropped the key, and the agent spawned with no task. Silently, exit 0.
 *
 * These assert on the request body actually POSTed, because the CLI→daemon boundary is exactly
 * where the prompt went missing.
 *
 * Harness notes (each of these is load-bearing):
 *  - `nock` cannot be used: it is pinned at ^13, which patches http.ClientRequest only, while the
 *    CLI uses global fetch (undici). We stub fetch directly instead.
 *  - VST_DAEMON_URL must be set, or getDaemonUrl() falls back to the developer's real
 *    ~/.vibe-station/config.json and the test could hit a live daemon and create real worktrees.
 *    (It only covers the URL: getDaemonToken() reads that config unconditionally either way.
 *    That read is harmless — read-only, and the stubbed fetch ignores the header.)
 *  - process.exit must be stubbed: die() calls it, which would otherwise kill the vitest worker.
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

/** Run argv through the real program, returning the exit code die()/commander produced (if any). */
async function run(argv: string[]): Promise<number | null> {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  try {
    await program.parseAsync(["node", "vst", ...argv]);
    return null;
  } catch (err) {
    if (err instanceof ExitError) return err.code;
    // commander's own exitOverride errors (e.g. conflicting options) carry exitCode
    const code = (err as { exitCode?: number }).exitCode;
    if (typeof code === "number") return code;
    throw err;
  }
}

beforeEach(() => {
  captured = [];
  tmpDir = mkdtempSync(join(tmpdir(), "vst-prompt-file-"));
  process.env.VST_DAEMON_URL = "http://127.0.0.1:9";

  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);

  vi.spyOn(console, "error").mockImplementation(() => {});
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
        json: async () => ({ id: "wt-1", branch: "b", projectId: "p", worktreeId: "wt-1", type: "agent", name: "m" }),
      };
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VST_DAEMON_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writePrompt(contents: string): string {
  const p = join(tmpDir, "task.md");
  writeFileSync(p, contents);
  return p;
}

describe("--prompt-file / --context-file are actually read", () => {
  it("worktree create --prompt-file sends the file contents as prompt", async () => {
    const file = writePrompt("Fix the flaky test.");
    await run(["worktree", "create", "proj-1", "--mode=m1", "--branch=b1", `--prompt-file=${file}`]);

    const post = captured.find((c) => c.url.endsWith("/worktrees"));
    expect(post, "expected a POST to /worktrees").toBeDefined();
    expect(post!.body.prompt).toBe("Fix the flaky test.");
  });

  it("session create --prompt-file sends the file contents as prompt", async () => {
    const file = writePrompt("Implement the parser.");
    await run(["session", "create", "wt-1", "--mode=m1", `--prompt-file=${file}`]);

    const post = captured.find((c) => c.url.endsWith("/sessions"));
    expect(post, "expected a POST to /sessions").toBeDefined();
    expect(post!.body.prompt).toBe("Implement the parser.");
  });

  it("mode add --context-file sends the file contents as context", async () => {
    const file = writePrompt("Always write tests first.");
    await run(["mode", "add", "--name=n1", "--cli=claude", `--context-file=${file}`]);

    const post = captured.find((c) => c.url.endsWith("/modes"));
    expect(post, "expected a POST to /modes").toBeDefined();
    expect(post!.body.context).toBe("Always write tests first.");
  });

  it("preserves multi-line prompt files verbatim", async () => {
    const contents = "# Task\n\nLine one.\nLine two.\n";
    const file = writePrompt(contents);
    await run(["worktree", "create", "proj-1", "--mode=m1", "--branch=b1", `--prompt-file=${file}`]);

    const post = captured.find((c) => c.url.endsWith("/worktrees"));
    expect(post, "expected a POST to /worktrees").toBeDefined();
    expect(post!.body.prompt).toBe(contents);
  });

  it("treats a whitespace-only prompt file as no prompt, not a whitespace task", async () => {
    // A truthy "\n" would be *submitted* as the agent's task by plugins that gate on
    // `if (prompt.taskPrompt)`. Omitting the key takes the same path as "no prompt given".
    const file = writePrompt("\n\n  \n");
    await run(["worktree", "create", "proj-1", "--mode=m1", "--branch=b1", `--prompt-file=${file}`]);

    const post = captured.find((c) => c.url.endsWith("/worktrees"));
    expect(post, "expected a POST to /worktrees").toBeDefined();
    expect(post!.body).not.toHaveProperty("prompt");
  });
});

describe("inline --prompt still works", () => {
  it("worktree create --prompt sends the inline text", async () => {
    await run(["worktree", "create", "proj-1", "--mode=m1", "--branch=b1", "--prompt=inline task"]);

    const post = captured.find((c) => c.url.endsWith("/worktrees"));
    expect(post!.body.prompt).toBe("inline task");
  });

  it("omits prompt entirely when neither flag is given", async () => {
    await run(["worktree", "create", "proj-1", "--mode=m1", "--branch=b1"]);

    const post = captured.find((c) => c.url.endsWith("/worktrees"));
    // JSON.stringify drops undefined values, so the key is absent rather than null.
    expect(post!.body).not.toHaveProperty("prompt");
  });
});

describe("failure modes are loud, not silent", () => {
  it("exits non-zero when --prompt-file does not exist", async () => {
    const code = await run([
      "worktree", "create", "proj-1", "--mode=m1", "--branch=b1",
      `--prompt-file=${join(tmpDir, "nope.md")}`,
    ]);

    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    // Must fail before contacting the daemon — never spawn an agent with a prompt we failed to read.
    expect(captured.find((c) => c.url.endsWith("/worktrees"))).toBeUndefined();
  });

  it("rejects --prompt and --prompt-file together", async () => {
    const file = writePrompt("from file");
    const code = await run([
      "worktree", "create", "proj-1", "--mode=m1", "--branch=b1",
      "--prompt=inline", `--prompt-file=${file}`,
    ]);

    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(captured.find((c) => c.url.endsWith("/worktrees"))).toBeUndefined();
  });

  it("rejects a prompt on a terminal session the daemon would discard", async () => {
    // The daemon only consumes `prompt` for agent sessions; a terminal session would accept it
    // and drop it — the same silent loss this PR is about.
    const code = await run(["session", "create", "wt-1", "--type=terminal", "--prompt=hi"]);

    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(captured.find((c) => c.url.endsWith("/sessions"))).toBeUndefined();
  });

  it("rejects project create --prompt without --start-agent", async () => {
    // Without --start-agent there is no agent to receive the prompt, and the request body
    // would omit it silently.
    const code = await run(["project", "create", "proj-x", "--prompt=hi"]);

    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(captured.find((c) => c.url.endsWith("/projects"))).toBeUndefined();
  });
});
