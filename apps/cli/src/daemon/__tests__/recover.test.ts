import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tmuxNs from "../services/tmux.js";
import { recoverNotStartedSessions } from "../services/recover.js";
import type { ProjectRecord } from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vrunHome: () => tempDir,
    projectDir: (id: string) => pathJoin(tempDir, "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) =>
      pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
  };
});

vi.mock("../services/tmux.js", () => ({
  hasSession: vi.fn(),
}));

describe("recoverNotStartedSessions", () => {
  const tmux = vi.mocked(tmuxNs);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vrun-recover-test-"));
    await mkdir(join(tempDir, "projects", "proj-r"), { recursive: true });
    await mkdir(join(tempDir, "repo"), { recursive: true });
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();

    const record: ProjectRecord = {
      id: "proj-r",
      absolutePath: join(tempDir, "repo"),
      prefix: "pfx",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      worktrees: [
        {
          id: "wt-r",
          branch: "b",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          createdAt: new Date().toISOString(),
          sessions: [
            {
              id: "sess-alive",
              slot: "m",
              type: "agent",
              modeId: "mode",
              tmuxName: "alive-pane",
              lifecycle: {
                state: "not_started",
                lastTransitionAt: new Date().toISOString(),
              },
            },
            {
              id: "sess-dead",
              slot: "a1",
              type: "agent",
              modeId: "mode",
              tmuxName: "dead-pane",
              lifecycle: {
                state: "not_started",
                lastTransitionAt: new Date().toISOString(),
              },
            },
            {
              id: "sess-working",
              slot: "a2",
              type: "agent",
              modeId: "mode",
              tmuxName: "ignore-pane",
              lifecycle: {
                state: "working",
                lastTransitionAt: new Date().toISOString(),
              },
            },
          ],
        },
      ],
    };

    await addProject(record);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("promotes not_started with live tmux to working", async () => {
    const { getProject } = await import("../state/project-store.js");
    tmux.hasSession.mockImplementation(async (name: string) => name === "alive-pane");

    await recoverNotStartedSessions();

    const proj = getProject("proj-r")!;
    const alive = proj.worktrees[0]!.sessions.find((s) => s.id === "sess-alive")!;
    expect(alive.lifecycle.state).toBe("working");
    expect(alive.lifecycle.reason).toBe("recovered-from-not-started");

    const dead = proj.worktrees[0]!.sessions.find((s) => s.id === "sess-dead")!;
    expect(dead.lifecycle.state).toBe("exited");
    expect(dead.lifecycle.reason).toBe("daemon-restart-during-spawn");

    const working = proj.worktrees[0]!.sessions.find((s) => s.id === "sess-working")!;
    expect(working.lifecycle.state).toBe("working");
  });
});
