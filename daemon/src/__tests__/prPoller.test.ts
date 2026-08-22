import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as githubNs from "../services/github.js";
import * as broadcasterNs from "../broadcaster.js";
import { PR_POLL_INTERVAL_MS, pollAllPrs, _resetPrPollerWarningForTest } from "../services/prPoller.js";
import type { ProjectRecord, LifecycleState, PrStatus } from "../types.js";

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
  resolveGithubRemote: vi.fn(),
  fetchPrsForBranches: vi.fn(),
  fetchPrForBranch: vi.fn(),
  _clearPrCacheForTest: vi.fn(),
}));

vi.mock("../broadcaster.js", () => ({
  notifySession: vi.fn(),
  broadcastAll: vi.fn(),
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn(),
}));

describe("PR poller configuration", () => {
  it("polls once every 30s (K8)", () => {
    expect(PR_POLL_INTERVAL_MS).toBe(30_000);
  });
});

describe("PR poller behavior", () => {
  const github = vi.mocked(githubNs);

  async function seedProject(
    lifecycleState: LifecycleState = "working",
    pr?: PrStatus,
    opts?: { worktreeCount?: number },
  ): Promise<void> {
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    const worktreeCount = opts?.worktreeCount ?? 1;
    const record: ProjectRecord = {
      id: "proj-pr",
      absolutePath: join(tempDir, "repo"),
      prefix: "pfx",
      isGit: true,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      directSessions: [],
      worktrees: Array.from({ length: worktreeCount }, (_, i) => ({
        id: `wt-pr-${i}`,
        branch: `feature-branch-${i}`,
        baseBranch: "main",
        baseSha: "a".repeat(40),
        createdAt: new Date().toISOString(),
        sortOrder: i,
        sessions: [
          {
            id: `sess-pr-${i}`,
            isMain: true,
            sortOrder: 0,
            type: "agent" as const,
            modeId: "mode",
            tmuxName: `pane-pr-${i}`,
            useTmux: true,
            lifecycle: {
              state: lifecycleState,
              lastTransitionAt: new Date().toISOString(),
            },
            ...(pr ? { pr } : {}),
          },
        ],
      })),
    };
    await addProject(record);
  }

  async function getSession(index = 0): Promise<{ lifecycle: { state: LifecycleState }; pr?: PrStatus }> {
    const { getProject } = await import("../state/project-store.js");
    return getProject("proj-pr")!.worktrees[index]!.sessions[0]!;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-prpoller-test-"));
    await mkdir(join(tempDir, "projects", "proj-pr"), { recursive: true });
    await mkdir(join(tempDir, "repo"), { recursive: true });
    github.getRemoteUrl.mockReset();
    github.resolveGithubRemote.mockReset();
    github.fetchPrsForBranches.mockReset();
    vi.mocked(broadcasterNs.broadcastAll).mockClear();
    _resetPrPollerWarningForTest();
    // Default happy path: a resolvable GitHub remote.
    github.getRemoteUrl.mockResolvedValue("https://github.com/acme/widgets.git");
    github.resolveGithubRemote.mockResolvedValue({ host: "github.com", owner: "acme", repo: "widgets" });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("2.T2 — an open non-draft PR sets pr.state to open", async () => {
    await seedProject("idle");
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([
        [
          "acme/widgets#feature-branch-0",
          {
            kind: "pr" as const,
            pr: {
              number: 7,
              url: "https://github.com/acme/widgets/pull/7",
              title: "Add widget",
              state: "open" as const,
              merged: false,
              draft: false,
              author: "octocat",
            },
          },
        ],
      ]),
    );

    await pollAllPrs();

    const session = await getSession();
    expect(session.pr?.state).toBe("open");
    expect(session.pr?.number).toBe(7);
    // Lifecycle is never touched by this poller (D5/D6).
    expect(session.lifecycle.state).toBe("idle");
  });

  it("2.T2 — a merged PR sets pr.state to merged", async () => {
    await seedProject("idle");
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([
        [
          "acme/widgets#feature-branch-0",
          {
            kind: "pr" as const,
            pr: {
              number: 7,
              url: "https://github.com/acme/widgets/pull/7",
              title: "Add widget",
              state: "closed" as const,
              merged: true,
              draft: false,
              author: "octocat",
            },
          },
        ],
      ]),
    );

    await pollAllPrs();

    expect((await getSession()).pr?.state).toBe("merged");
  });

  it("2.T2 — a draft PR sets pr.state to draft", async () => {
    await seedProject("idle");
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([
        [
          "acme/widgets#feature-branch-0",
          {
            kind: "pr" as const,
            pr: {
              number: 8,
              url: "https://github.com/acme/widgets/pull/8",
              title: "WIP widget",
              state: "open" as const,
              merged: false,
              draft: true,
              author: "octocat",
            },
          },
        ],
      ]),
    );

    await pollAllPrs();

    expect((await getSession()).pr?.state).toBe("draft");
  });

  it("2.T2 — a closed-without-merge PR sets pr.state to closed", async () => {
    await seedProject("idle");
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([
        [
          "acme/widgets#feature-branch-0",
          {
            kind: "pr" as const,
            pr: {
              number: 9,
              url: "https://github.com/acme/widgets/pull/9",
              title: "Abandoned",
              state: "closed" as const,
              merged: false,
              draft: false,
              author: "octocat",
            },
          },
        ],
      ]),
    );

    await pollAllPrs();

    expect((await getSession()).pr?.state).toBe("closed");
  });

  it("pr-status-axis 5 — records the branch it queried (D20)", async () => {
    await seedProject("idle");
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([
        [
          "acme/widgets#feature-branch-0",
          {
            kind: "pr" as const,
            pr: {
              number: 7,
              url: "https://github.com/acme/widgets/pull/7",
              title: "Add widget",
              state: "open" as const,
              merged: false,
              draft: false,
              author: "octocat",
            },
          },
        ],
      ]),
    );

    await pollAllPrs();

    expect((await getSession()).pr?.prBranch).toBe("feature-branch-0");
  });

  it("2.T2 — a no_pr result sets pr.state to none", async () => {
    await seedProject("idle", { state: "open", number: 3, checkedAt: "2020-01-01T00:00:00.000Z" });
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([["acme/widgets#feature-branch-0", { kind: "no_pr" as const }]]),
    );

    await pollAllPrs();

    expect((await getSession()).pr?.state).toBe("none");
  });

  it("2.T2 — a not_github worktree is skipped: no batch call, no session write, no log", async () => {
    await seedProject("idle");
    github.resolveGithubRemote.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await pollAllPrs();

    expect(github.fetchPrsForBranches).not.toHaveBeenCalled();
    expect((await getSession()).pr).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("2.T1 — a kind:\"error\" result holds session.pr.state AND leaves lifecycle unchanged (R4)", async () => {
    await seedProject("waiting_for_human", {
      state: "open",
      number: 5,
      checkedAt: "2020-01-01T00:00:00.000Z",
      prBranch: "feature-branch-0",
    });
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([
        [
          "acme/widgets#feature-branch-0",
          { kind: "error" as const, reason: "network" as const, message: "boom" },
        ],
      ]),
    );

    await pollAllPrs();

    // `error` is surfaced live over the WS broadcast (not a persisted column,
    // see § Data model) — assert it there; the persisted/re-read state must
    // still hold its previous value.
    expect(broadcasterNs.broadcastAll).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:updated",
        sessionId: "sess-pr-0",
        pr: expect.objectContaining({ state: "open", number: 5, error: "boom" }),
      }),
    );
    const session = await getSession();
    expect(session.pr?.state).toBe("open");
    expect(session.pr?.number).toBe(5);
    expect(session.lifecycle.state).toBe("waiting_for_human");
  });

  it("2.T1 — a kind:\"no_credentials\" result holds session.pr.state (R4)", async () => {
    await seedProject("idle", {
      state: "open",
      number: 5,
      checkedAt: "2020-01-01T00:00:00.000Z",
      prBranch: "feature-branch-0",
    });
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([["acme/widgets#feature-branch-0", { kind: "no_credentials" as const }]]),
    );

    await pollAllPrs();

    expect(broadcasterNs.broadcastAll).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session:updated",
        sessionId: "sess-pr-0",
        pr: expect.objectContaining({ state: "open", error: expect.any(String) }),
      }),
    );
    const session = await getSession();
    expect(session.pr?.state).toBe("open");
  });

  it("BLOCKING-1 — a kind:\"error\" result does NOT hold a PR from a different branch (D20)", async () => {
    // Session's persisted PR was last checked against a branch the worktree
    // has since left — `nextPrStatus` must not re-stamp it onto the CURRENT
    // branch (`feature-branch-0`) just because a transient failure occurred.
    await seedProject("idle", {
      state: "open",
      number: 10,
      url: "https://github.com/acme/widgets/pull/10",
      checkedAt: "2020-01-01T00:00:00.000Z",
      prBranch: "old-branch",
    });
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([
        [
          "acme/widgets#feature-branch-0",
          { kind: "error" as const, reason: "network" as const, message: "boom" },
        ],
      ]),
    );

    await pollAllPrs();

    const session = await getSession();
    expect(session.pr?.state).toBe("none");
    expect(session.pr?.number).toBeUndefined();
    expect(session.pr?.url).toBeUndefined();
    expect(session.pr?.prBranch).toBe("feature-branch-0");
  });

  it("BLOCKING-1 — a kind:\"no_credentials\" result does NOT hold a PR from a different branch (D20)", async () => {
    await seedProject("idle", {
      state: "open",
      number: 10,
      url: "https://github.com/acme/widgets/pull/10",
      checkedAt: "2020-01-01T00:00:00.000Z",
      prBranch: "old-branch",
    });
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([["acme/widgets#feature-branch-0", { kind: "no_credentials" as const }]]),
    );

    await pollAllPrs();

    const session = await getSession();
    expect(session.pr?.state).toBe("none");
    expect(session.pr?.number).toBeUndefined();
    expect(session.pr?.url).toBeUndefined();
    expect(session.pr?.prBranch).toBe("feature-branch-0");
  });

  it("2.T3 — one tick, 3 worktrees → exactly one batched fetchPrsForBranches call", async () => {
    await seedProject("idle", undefined, { worktreeCount: 3 });
    github.fetchPrsForBranches.mockResolvedValue(new Map());

    await pollAllPrs();

    expect(github.fetchPrsForBranches).toHaveBeenCalledTimes(1);
    const entries = github.fetchPrsForBranches.mock.calls[0]![0];
    expect(entries).toHaveLength(3);
  });

  it("2.T4 — getRemoteUrl returning null makes zero fetch calls and zero log lines (R9/C5)", async () => {
    await seedProject("idle");
    github.getRemoteUrl.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(pollAllPrs()).resolves.toBeUndefined();

    expect(github.fetchPrsForBranches).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("B2 — a second tick with an unchanged PR result performs no write and no broadcast", async () => {
    const existing: PrStatus = {
      state: "open",
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      checkedAt: "2020-01-01T00:00:00.000Z",
      prBranch: "feature-branch-0",
    };
    await seedProject("idle", existing);
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([
        [
          "acme/widgets#feature-branch-0",
          {
            kind: "pr" as const,
            pr: {
              number: 7,
              url: "https://github.com/acme/widgets/pull/7",
              title: "Add widget",
              state: "open" as const,
              merged: false,
              draft: false,
              author: "octocat",
            },
          },
        ],
      ]),
    );

    await pollAllPrs();

    expect(broadcasterNs.broadcastAll).not.toHaveBeenCalled();
    // The write itself was skipped, so `checkedAt` was never bumped — it
    // still holds the value from the seed, not this tick's `now`.
    expect((await getSession()).pr).toEqual(existing);
  });

  it("B2 — getRemoteUrl/resolveGithubRemote are called once per project per tick, not once per worktree", async () => {
    await seedProject("idle", undefined, { worktreeCount: 5 });
    github.fetchPrsForBranches.mockResolvedValue(new Map());

    await pollAllPrs();

    expect(github.getRemoteUrl).toHaveBeenCalledTimes(1);
    expect(github.resolveGithubRemote).toHaveBeenCalledTimes(1);
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
          sortOrder: 0,
          sessions: [],
        },
      ],
    };
    await addProject(record);

    await expect(pollAllPrs()).resolves.toBeUndefined();
    expect(github.fetchPrsForBranches).not.toHaveBeenCalled();
  });

  it("A1.T6 — after a main-session promotion, polling resolves PR against the NEW isMain session, not a former/non-main sibling", async () => {
    // Simulates the post-promotion state a Fix 1 `DELETE /sessions/:id`
    // would leave behind: the old main is gone (deleted), and the promoted
    // sibling already carries the old main's `pr` forward (M1 fix, asserted
    // structurally in sessions.test.ts) — here we only need to confirm
    // `prPoller` needs no code change: it must re-derive `isMain` fresh and
    // target whichever session holds it now, regardless of array position
    // or prior role, and must never write to a non-main sibling.
    const { _clearStoreForTest, addProject } = await import("../state/project-store.js");
    _clearStoreForTest();
    const carriedPr: PrStatus = {
      state: "open",
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      prBranch: "feature-branch-0",
      checkedAt: new Date(0).toISOString(),
    };
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
          id: "wt-pr-0",
          branch: "feature-branch-0",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          createdAt: new Date().toISOString(),
          sortOrder: 0,
          sessions: [
            // A non-main sibling (never touched by prPoller — the OLD main
            // is gone entirely post-promotion, but a second, ineligible
            // sibling like a terminal could still be present).
            {
              id: "sess-pr-sibling",
              isMain: false,
              sortOrder: 1,
              type: "terminal" as const,
              tmuxName: "pane-pr-sibling",
              useTmux: true,
              lifecycle: { state: "idle", lastTransitionAt: new Date().toISOString() },
            },
            // The PROMOTED session — isMain now, already carrying the old
            // main's `pr` forward, and NOT at array index 0.
            {
              id: "sess-pr-promoted",
              isMain: true,
              sortOrder: 0,
              type: "agent" as const,
              modeId: "mode",
              tmuxName: "pane-pr-promoted",
              useTmux: true,
              lifecycle: { state: "idle", lastTransitionAt: new Date().toISOString() },
              pr: carriedPr,
            },
          ],
        },
      ],
    };
    await addProject(record);

    // Next 30s tick finds a newer PR state — must land on the promoted
    // session's id, never the (nonexistent) old main or the terminal sibling.
    github.fetchPrsForBranches.mockResolvedValue(
      new Map([
        [
          "acme/widgets#feature-branch-0",
          {
            kind: "pr" as const,
            pr: {
              number: 7,
              url: "https://github.com/acme/widgets/pull/7",
              title: "Add widget",
              state: "closed" as const,
              merged: true,
              draft: false,
              author: "octocat",
            },
          },
        ],
      ]),
    );

    await pollAllPrs();

    const { getProject } = await import("../state/project-store.js");
    const worktree = getProject("proj-pr")!.worktrees[0]!;
    const promoted = worktree.sessions.find((s) => s.id === "sess-pr-promoted")!;
    const sibling = worktree.sessions.find((s) => s.id === "sess-pr-sibling")!;
    expect(promoted.pr?.state).toBe("merged");
    expect(sibling.pr).toBeUndefined();
  });
});
