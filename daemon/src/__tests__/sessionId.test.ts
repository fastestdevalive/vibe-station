import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRecord, WorktreeRecord } from "../types.js";

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
  };
});

const makeWorktree = (id: string): WorktreeRecord => ({
  id,
  branch: `branch-${id}`,
  baseBranch: "main",
  baseSha: "0".repeat(40),
  createdAt: new Date().toISOString(),
  sessions: [],
});

const makeProject = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "proj-1",
  absolutePath: "/fake/proj-1",
  prefix: "vs",
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  worktrees: [],
  ...overrides,
});

describe("reserveNextWorktreeNum", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-sessionid-test-"));
    await mkdir(join(tempDir, "projects", "proj-1", "worktrees"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("delete-highest-then-create yields N+1, not the freed number", async () => {
    const { reserveNextWorktreeNum } = await import("../services/sessionId.js");

    // vs-1, vs-2, vs-3 existed; vs-3 (the highest) was deleted (purged).
    // The manifest already carries a persisted counter of 4 (set when vs-3 was reserved).
    const project = makeProject({
      worktrees: [makeWorktree("vs-1"), makeWorktree("vs-2")],
      nextWorktreeNum: 4,
    });

    const n = reserveNextWorktreeNum(project);
    expect(n).toBe(4); // NOT 3, the freed number
  });

  it("counter persists across a manifest reload", async () => {
    const { writeManifest, readManifest } = await import("../services/manifest.js");
    const { reserveNextWorktreeNum } = await import("../services/sessionId.js");

    const project = makeProject({
      worktrees: [makeWorktree("vs-1")],
      nextWorktreeNum: 5,
    });
    await writeManifest(project);

    const loaded = await readManifest("proj-1");
    expect(loaded.nextWorktreeNum).toBe(5);
    expect(reserveNextWorktreeNum(loaded)).toBe(5);
  });

  it("legacy manifest (no nextWorktreeNum) seeds from existing worktrees", async () => {
    const { reserveNextWorktreeNum } = await import("../services/sessionId.js");

    const project = makeProject({
      worktrees: [makeWorktree("vs-1"), makeWorktree("vs-3"), makeWorktree("vs-2")],
      // nextWorktreeNum intentionally omitted (legacy manifest)
    });

    expect(reserveNextWorktreeNum(project)).toBe(4); // max(1,3,2) + 1
  });

  it("legacy manifest with a non-numeric-suffixed worktree id does not yield NaN", async () => {
    const { reserveNextWorktreeNum } = await import("../services/sessionId.js");

    const project = makeProject({
      worktrees: [makeWorktree("vs-1"), makeWorktree("vs-feature")],
    });

    const n = reserveNextWorktreeNum(project);
    expect(n).not.toBeNaN();
    expect(n).toBe(2); // max(1, NaN filtered out) + 1
  });

  it("empty legacy manifest seeds at 1", async () => {
    const { reserveNextWorktreeNum } = await import("../services/sessionId.js");
    const project = makeProject({ worktrees: [] });
    expect(reserveNextWorktreeNum(project)).toBe(1);
  });

  it("skips a stray on-disk directory left by a non-purge delete", async () => {
    const { reserveNextWorktreeNum } = await import("../services/sessionId.js");

    // vs-4 has no manifest entry (removed without --purge) but the directory is still there.
    await mkdir(join(tempDir, "projects", "proj-1", "worktrees", "vs-4"), { recursive: true });

    const project = makeProject({
      worktrees: [makeWorktree("vs-1")],
      nextWorktreeNum: 4,
    });

    expect(reserveNextWorktreeNum(project)).toBe(5); // skips the orphaned vs-4 dir
  });

  it("two-phase window: a reserve/bump with no append still advances the counter", async () => {
    const { mutateProject, addProject, getProject, _clearStoreForTest } = await import(
      "../state/project-store.js"
    );
    const { reserveNextWorktreeNum } = await import("../services/sessionId.js");

    _clearStoreForTest();
    const project = makeProject({ worktrees: [] });
    await addProject(project);

    // Simulate the route's reserve-and-bump mutateProject call, WITHOUT the
    // subsequent append (as if worktree creation crashed right after the bump).
    let reserved!: number;
    await mutateProject("proj-1", (p) => {
      reserved = reserveNextWorktreeNum(p);
      return { ...p, nextWorktreeNum: reserved + 1 };
    });
    expect(reserved).toBe(1);

    // No worktree was ever appended for number 1 — it's burned.
    const afterCrash = getProject("proj-1")!;
    expect(afterCrash.worktrees).toEqual([]);
    expect(afterCrash.nextWorktreeNum).toBe(2);

    // The next create must skip the burned number 1.
    expect(reserveNextWorktreeNum(afterCrash)).toBe(2);
  });
});

describe("reserveNextAgentSlot", () => {
  const wtWith = (agentSeq: number | undefined, aNums: number[]): WorktreeRecord => ({
    ...makeWorktree("vs-1"),
    ...(agentSeq != null ? { agentSeq } : {}),
    sessions: aNums.map((n) => ({
      id: `vs-1-a${n}`,
      slot: `a${n}` as const,
      type: "agent" as const,
      tmuxName: `vr-vs-1-a${n}`,
      useTmux: true,
      lifecycle: { state: "working" as const, lastTransitionAt: new Date().toISOString() },
    })),
  });

  it("uses agentSeq high-water: freed number is not reused", async () => {
    const { reserveNextAgentSlot } = await import("../services/sessionId.js");
    // 7 agents created (agentSeq=7), a1 deleted → sessions a2..a7
    expect(reserveNextAgentSlot(wtWith(7, [2, 3, 4, 5, 6, 7]))).toBe("a8");
  });

  it("legacy worktree (no agentSeq) seeds from max existing slot", async () => {
    const { reserveNextAgentSlot } = await import("../services/sessionId.js");
    expect(reserveNextAgentSlot(wtWith(undefined, [1, 2, 3]))).toBe("a4");
  });

  it("fresh worktree yields a1", async () => {
    const { reserveNextAgentSlot } = await import("../services/sessionId.js");
    expect(reserveNextAgentSlot(wtWith(undefined, []))).toBe("a1");
  });

  it("high-water dominates a stale/low agentSeq (no colliding slot)", async () => {
    const { reserveNextAgentSlot } = await import("../services/sessionId.js");
    // agentSeq (2) is lower than the max live slot (a5) — must not reuse a3..a5.
    expect(reserveNextAgentSlot(wtWith(2, [3, 4, 5]))).toBe("a6");
  });

  it("non-numeric agent slot does not poison the counter to NaN", async () => {
    const { reserveNextAgentSlot } = await import("../services/sessionId.js");
    const wt = wtWith(undefined, []);
    wt.sessions.push({
      id: "vs-1-ax",
      slot: "ax" as unknown as `a${number}`,
      type: "agent",
      tmuxName: "vr-vs-1-ax",
      useTmux: true,
      lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
    });
    expect(reserveNextAgentSlot(wt)).toBe("a1");
  });
});

describe("agentHighWaterMark", () => {
  const wtWith = (agentSeq: number | undefined, aNums: number[]): WorktreeRecord => ({
    ...makeWorktree("vs-1"),
    ...(agentSeq != null ? { agentSeq } : {}),
    sessions: aNums.map((n) => ({
      id: `vs-1-a${n}`,
      slot: `a${n}` as const,
      type: "agent" as const,
      tmuxName: `vr-vs-1-a${n}`,
      useTmux: true,
      lifecycle: { state: "working" as const, lastTransitionAt: new Date().toISOString() },
    })),
  });

  it("is 0 for a fresh worktree", async () => {
    const { agentHighWaterMark } = await import("../services/sessionId.js");
    expect(agentHighWaterMark(wtWith(undefined, []))).toBe(0);
  });

  it("falls back to live slots when agentSeq is unset (legacy worktree)", async () => {
    const { agentHighWaterMark } = await import("../services/sessionId.js");
    expect(agentHighWaterMark(wtWith(undefined, [1, 2, 3]))).toBe(3);
  });

  it("prefers the persisted counter when it is higher than live slots", async () => {
    const { agentHighWaterMark } = await import("../services/sessionId.js");
    // agentSeq=5 survives after a1/a2 were the only ones left, then deleted.
    expect(agentHighWaterMark(wtWith(5, [1, 2]))).toBe(5);
  });

  it("prefers live slots when the counter is stale/lower", async () => {
    const { agentHighWaterMark } = await import("../services/sessionId.js");
    expect(agentHighWaterMark(wtWith(2, [3, 4, 5]))).toBe(5);
  });
});
