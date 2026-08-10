/**
 * `listSessionNames` failure semantics.
 *
 * The lifecycle poller uses this one snapshot per tick to decide which
 * sessions are still alive, so the difference between "tmux says nothing is
 * running" and "the tmux call failed" is load-bearing: collapsing the latter
 * to an empty set would mark EVERY session exited in a single tick — hundreds
 * of `session:exited` broadcasts and DB writes — from one transient hiccup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => execFileMock(cb),
}));

/** Shape `promisify(execFile)` rejects with: an Error carrying `stderr`. */
function tmuxError(stderr: string): Error & { stderr: string } {
  const err = new Error(`Command failed: tmux list-sessions\n${stderr}`) as Error & {
    stderr: string;
  };
  err.stderr = stderr;
  return err;
}

describe("listSessionNames", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns the set of live session names", async () => {
    execFileMock.mockImplementation((cb) => cb(null, { stdout: "alpha\nbeta\n", stderr: "" }));
    const { listSessionNames } = await import("../services/tmux.js");
    expect(await listSessionNames()).toEqual(new Set(["alpha", "beta"]));
  });

  it("treats 'no server running' as an authoritative empty set", async () => {
    execFileMock.mockImplementation((cb) =>
      cb(tmuxError("no server running on /tmp/tmux-1000/default"), { stdout: "", stderr: "" }),
    );
    const { listSessionNames } = await import("../services/tmux.js");
    // Empty set, NOT null: nothing is running, so every session really is gone
    // and the poller should act on it.
    expect(await listSessionNames()).toEqual(new Set());
  });

  it("returns null (skip the tick) for a failure it cannot interpret", async () => {
    execFileMock.mockImplementation((cb) =>
      cb(tmuxError("tmux: unexpected catastrophe"), { stdout: "", stderr: "" }),
    );
    const { listSessionNames } = await import("../services/tmux.js");
    expect(await listSessionNames()).toBeNull();
  });

  it("listSessions() keeps its array contract on top of the set", async () => {
    execFileMock.mockImplementation((cb) => cb(null, { stdout: "one\ntwo\n", stderr: "" }));
    const { listSessions } = await import("../services/tmux.js");
    expect(await listSessions()).toEqual(["one", "two"]);
  });
});
