import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// --- 4b.T1/T2: --source-agent flag + $VST_SESSION defaulting (agent-interaction-
// workspaces/04-workspaces Phase 4b) for both `vst worktree create` and
// `vst session create`. No CLI-command test harness existed in this codebase
// before this file — mock the two daemon-facing modules directly and drive
// the registered commander action via a minimal parent Command tree, the
// same shape program.ts wires up for real.

const daemonPostMock = vi.fn(async () => ({
  ok: true,
  status: 201,
  data: { id: "new-id", branch: "b", projectId: "p", worktreeId: "wt-1", type: "agent" },
}));

vi.mock("../lib/daemon-client.js", () => ({
  daemonPost: (path: string, body?: unknown) => daemonPostMock(path, body),
}));
vi.mock("../lib/preflight.js", () => ({ preflight: vi.fn(async () => {}) }));

const { registerWorktreeCreate } = await import("./worktree/create.js");
const { registerSessionCreate } = await import("./session/create.js");

function buildWorktreeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  const worktree = program.command("worktree");
  registerWorktreeCreate(worktree);
  return program;
}

function buildSessionProgram(): Command {
  const program = new Command();
  program.exitOverride();
  const session = program.command("session");
  registerSessionCreate(session);
  return program;
}

describe("vst worktree create --source-agent", () => {
  const originalVstSession = process.env.VST_SESSION;

  beforeEach(() => {
    daemonPostMock.mockClear();
    delete process.env.VST_SESSION;
  });
  afterEach(() => {
    if (originalVstSession === undefined) delete process.env.VST_SESSION;
    else process.env.VST_SESSION = originalVstSession;
  });

  it("4b.T1 — explicit --source-agent sends sourceAgentId in the POST body", async () => {
    const program = buildWorktreeProgram();
    await program.parseAsync(
      ["worktree", "create", "proj1", "--mode", "m1", "--source-agent", "sess-explicit"],
      { from: "user" },
    );
    expect(daemonPostMock).toHaveBeenCalledWith(
      "/worktrees",
      expect.objectContaining({ sourceAgentId: "sess-explicit" }),
    );
  });

  it("4b.T1 — no --source-agent but $VST_SESSION set in env defaults sourceAgentId to it", async () => {
    process.env.VST_SESSION = "sess-from-env";
    const program = buildWorktreeProgram();
    await program.parseAsync(["worktree", "create", "proj1", "--mode", "m1"], { from: "user" });
    expect(daemonPostMock).toHaveBeenCalledWith(
      "/worktrees",
      expect.objectContaining({ sourceAgentId: "sess-from-env" }),
    );
  });

  it("4b.T2 — explicit --source-agent overrides $VST_SESSION when both are present", async () => {
    process.env.VST_SESSION = "sess-from-env";
    const program = buildWorktreeProgram();
    await program.parseAsync(
      ["worktree", "create", "proj1", "--mode", "m1", "--source-agent", "sess-explicit"],
      { from: "user" },
    );
    expect(daemonPostMock).toHaveBeenCalledWith(
      "/worktrees",
      expect.objectContaining({ sourceAgentId: "sess-explicit" }),
    );
  });

  it("omitting both --source-agent and $VST_SESSION sends no sourceAgentId at all (S5, no side effect)", async () => {
    const program = buildWorktreeProgram();
    await program.parseAsync(["worktree", "create", "proj1", "--mode", "m1"], { from: "user" });
    const [, body] = daemonPostMock.mock.calls[0]!;
    expect(body).not.toHaveProperty("sourceAgentId");
  });
});

describe("vst session create --source-agent", () => {
  const originalVstSession = process.env.VST_SESSION;

  beforeEach(() => {
    daemonPostMock.mockClear();
    delete process.env.VST_SESSION;
  });
  afterEach(() => {
    if (originalVstSession === undefined) delete process.env.VST_SESSION;
    else process.env.VST_SESSION = originalVstSession;
  });

  it("4b.T1 — explicit --source-agent sends sourceAgentId in the POST body", async () => {
    const program = buildSessionProgram();
    await program.parseAsync(["session", "create", "wt-1", "--source-agent", "sess-explicit"], {
      from: "user",
    });
    expect(daemonPostMock).toHaveBeenCalledWith(
      "/sessions",
      expect.objectContaining({ sourceAgentId: "sess-explicit" }),
    );
  });

  it("4b.T1 — no --source-agent but $VST_SESSION set in env defaults sourceAgentId to it", async () => {
    process.env.VST_SESSION = "sess-from-env";
    const program = buildSessionProgram();
    await program.parseAsync(["session", "create", "wt-1"], { from: "user" });
    expect(daemonPostMock).toHaveBeenCalledWith(
      "/sessions",
      expect.objectContaining({ sourceAgentId: "sess-from-env" }),
    );
  });

  it("4b.T2 — explicit --source-agent overrides $VST_SESSION when both are present", async () => {
    process.env.VST_SESSION = "sess-from-env";
    const program = buildSessionProgram();
    await program.parseAsync(["session", "create", "wt-1", "--source-agent", "sess-explicit"], {
      from: "user",
    });
    expect(daemonPostMock).toHaveBeenCalledWith(
      "/sessions",
      expect.objectContaining({ sourceAgentId: "sess-explicit" }),
    );
  });

  it("omitting both --source-agent and $VST_SESSION sends no sourceAgentId at all (S5, no side effect)", async () => {
    const program = buildSessionProgram();
    await program.parseAsync(["session", "create", "wt-1"], { from: "user" });
    const [, body] = daemonPostMock.mock.calls[0]!;
    expect(body).not.toHaveProperty("sourceAgentId");
  });
});
