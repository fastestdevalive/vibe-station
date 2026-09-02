import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerSessionCreate } from "../commands/session/create.js";

const daemonPostMock = vi.fn();

vi.mock("../lib/daemon-client.js", () => ({
  daemonPost: (...args: unknown[]) => daemonPostMock(...args),
}));

vi.mock("../lib/preflight.js", () => ({
  preflight: vi.fn().mockResolvedValue(undefined),
}));

function buildSessionCommand(): Command {
  const session = new Command("session");
  registerSessionCreate(session);
  return session;
}

async function run(args: string[]): Promise<void> {
  const session = buildSessionCommand();
  // commander expects [node, script, ...args] by default via parseAsync
  await session.parseAsync(["node", "session", ...args]);
}

describe("session create — --parent/--source-agent (Decision 3, 14, 15)", () => {
  const originalVstSession = process.env.VST_SESSION;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    daemonPostMock.mockReset();
    daemonPostMock.mockResolvedValue({ ok: true, status: 201, data: { id: "sess-new-1", worktreeId: "wt-1", type: "agent" } });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.VST_SESSION;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.restoreAllMocks();
    if (originalVstSession === undefined) delete process.env.VST_SESSION;
    else process.env.VST_SESSION = originalVstSession;
  });

  it("1.T7 — an explicit --source-agent '' warns and still creates the session", async () => {
    await run(["create", "wt-1", "--mode", "bugfix", "--source-agent", ""]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/parent|source-agent/i);
    expect(daemonPostMock).toHaveBeenCalledTimes(1);
    const [, body] = daemonPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.sourceAgentId).toBeUndefined();
  });

  it("1.T8 — no flag and no $VST_SESSION (human terminal) creates the session with no warning and no sourceAgentId", async () => {
    await run(["create", "wt-1", "--mode", "bugfix"]);

    expect(warnSpy).not.toHaveBeenCalled();
    const [, body] = daemonPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.sourceAgentId).toBeUndefined();
  });

  it("1.T10 — --parent and --source-agent produce an identical request body", async () => {
    await run(["create", "wt-1", "--mode", "bugfix", "--parent", "sess-abc"]);
    const [, parentBody] = daemonPostMock.mock.calls[0] as [string, Record<string, unknown>];

    daemonPostMock.mockClear();
    await run(["create", "wt-1", "--mode", "bugfix", "--source-agent", "sess-abc"]);
    const [, sourceAgentBody] = daemonPostMock.mock.calls[0] as [string, Record<string, unknown>];

    expect(parentBody).toEqual(sourceAgentBody);
    expect(parentBody.sourceAgentId).toBe("sess-abc");
  });

  it("defaults to $VST_SESSION when no flag is passed (Decision 14)", async () => {
    process.env.VST_SESSION = "sess-env-parent";
    await run(["create", "wt-1", "--mode", "bugfix"]);

    expect(warnSpy).not.toHaveBeenCalled();
    const [, body] = daemonPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.sourceAgentId).toBe("sess-env-parent");
  });
});
