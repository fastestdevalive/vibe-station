import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as githubNs from "../services/github.js";
import * as broadcasterNs from "../broadcaster.js";
import {
  PR_POLL_INTERVAL_MS,
  pollAllPrs,
  _resetPrPollerWarningForTest,
} from "../services/prPoller.js";
import type { ProjectRecord, LifecycleState } from "../types.js";

let tempDir: string;

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir,
    projectDir: (id: string) => pathJoin(tempDir, "projects", id),
    manifestPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json"),
    manifestTmpPath: (id: string) => pathJoin(tempDir, "projects", id, "manifest.json.tmp"),
    worktreePath: (id: string, wtId: string) =>
      pathJoin(tempDir, "projects", id, "worktrees", wtId),
    configPath: () => pathJoin(tempDir, "config.json"),
    modesPath: () => pathJoin(tempDir, "modes.json"),
    daemonLogPath: () => pathJoin(tempDir, "logs", "daemon.log"),
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
    cleanupSessionDataDir: () => {},
  };
});

vi.mock("../services/github.js", () => ({
  getRemoteUrl: vi.fn(),
  parseGithubRepo: vi.fn(),
  fetchPrForBranch: vi.fn(),
}));

vi.mock("../broadcaster.js", () => ({
  notifySession: vi.fn(),
  broadcastAll: vi.fn(),
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn(),
}));

describe("PR poller configuration", () => {
  it("polls once every 60s (Decision 3b)", () => {
    expect(PR_POLL_INTERVAL_MS).toBe(60_000);
  });
});

describe("PR poller behavior", () => {
  const github = vi.mocked(githubNs);

  async function seedProject(initialState: LifecycleState = "working"): Promise<void> {
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    const record: ProjectRecord = {
      id: "proj-pr",
      absolutePath: join(tempDir, "repo"),
      prefix: "pfx",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [],
      worktrees: [
        {
          id: "wt-pr",
          branch: "feature-branch",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          createdAt: new Date().toISOString(),
          sessions: [
            {
              id: "sess-pr",
              slot: "m",
              isMain: true,
              type: "agent",
              modeId: "mode",
              tmuxName: "pane-pr",
              lifecycle: {
                state: initialState,
                lastTransitionAt: new Date().toISOString(),
              },
            },
          ],
        },
      ],
    };
    await addProject(record);
  }

  async function getCurrentState(): Promise<LifecycleState> {
    const { getProject } = await import("../state/project-store.js");
    return getProject("proj-pr")!.worktrees[0]!.sessions[0]!.lifecycle.state;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-prpoller-test-"));
    await mkdir(join(tempDir, "projects", "proj-pr"), { recursive: true });
    await mkdir(join(tempDir, "repo"), { recursive: true });
    github.getRemoteUrl.mockReset();
    github.parseGithubRepo.mockReset();
    github.fetchPrForBranch.mockReset();
    vi.mocked(broadcasterNs.broadcastAll).mockClear();
    _resetPrPollerWarningForTest();
    // Default happy path: a resolvable GitHub remote.
    github.getRemoteUrl.mockResolvedValue("https://github.com/acme/widgets.git");
    github.parseGithubRepo.mockReturnValue({ owner: "acme", repo: "widgets" });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1b.T1 — an open non-draft PR transitions the worktree's main session to needs_review", async () => {
    await seedProject("idle");
    github.fetchPrForBranch.mockResolvedValue({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      title: "Add widget",
      state: "open",
      merged: false,
      draft: false,
      author: "octocat",
    });

    await pollAllPrs();

    expect(await getCurrentState()).toBe("needs_review");
  });

  it("does not flag a draft PR as needs_review", async () => {
    await seedProject("idle");
    github.fetchPrForBranch.mockResolvedValue({
      number: 8,
      url: "https://github.com/acme/widgets/pull/8",
      title: "WIP widget",
      state: "open",
      merged: false,
      draft: true,
      author: "octocat",
    });

    await pollAllPrs();

    expect(await getCurrentState()).toBe("idle");
  });

  it("1b.T2 — a merged PR transitions the session OUT of needs_review", async () => {
    await seedProject("needs_review");
    github.fetchPrForBranch.mockResolvedValue({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      title: "Add widget",
      state: "closed",
      merged: true,
      draft: false,
      author: "octocat",
    });

    await pollAllPrs();

    expect(await getCurrentState()).not.toBe("needs_review");
    expect(await getCurrentState()).toBe("idle");
  });

  it("a closed-without-merge PR also transitions the session out of needs_review", async () => {
    await seedProject("needs_review");
    github.fetchPrForBranch.mockResolvedValue({
      number: 9,
      url: "https://github.com/acme/widgets/pull/9",
      title: "Abandoned",
      state: "closed",
      merged: false,
      draft: false,
      author: "octocat",
    });

    await pollAllPrs();

    expect(await getCurrentState()).toBe("idle");
  });

  it("no PR at all transitions the session out of needs_review", async () => {
    await seedProject("needs_review");
    github.fetchPrForBranch.mockResolvedValue(null);

    await pollAllPrs();

    expect(await getCurrentState()).toBe("idle");
  });

  it("leaves a done session alone even with an open PR", async () => {
    await seedProject("done");
    github.fetchPrForBranch.mockResolvedValue({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      title: "Add widget",
      state: "open",
      merged: false,
      draft: false,
      author: "octocat",
    });

    await pollAllPrs();

    expect(await getCurrentState()).toBe("done");
  });

  it("1b.T3 — a worktree with a non-GitHub remote is skipped without throwing", async () => {
    await seedProject("idle");
    github.parseGithubRepo.mockReturnValue(null);

    await expect(pollAllPrs()).resolves.toBeUndefined();
    expect(github.fetchPrForBranch).not.toHaveBeenCalled();
    expect(await getCurrentState()).toBe("idle");
  });

  it("1b.T3 — a worktree with no resolvable remote at all is skipped without throwing", async () => {
    await seedProject("idle");
    github.getRemoteUrl.mockResolvedValue(null);

    await expect(pollAllPrs()).resolves.toBeUndefined();
    expect(github.fetchPrForBranch).not.toHaveBeenCalled();
    expect(await getCurrentState()).toBe("idle");
  });

  it("skips a worktree with no main agent session, without throwing", async () => {
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    const record: ProjectRecord = {
      id: "proj-pr",
      absolutePath: join(tempDir, "repo"),
      prefix: "pfx",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [],
      worktrees: [
        {
          id: "wt-pr",
          branch: "feature-branch",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          createdAt: new Date().toISOString(),
          sessions: [],
        },
      ],
    };
    await addProject(record);

    await expect(pollAllPrs()).resolves.toBeUndefined();
    expect(github.fetchPrForBranch).not.toHaveBeenCalled();
  });
});
