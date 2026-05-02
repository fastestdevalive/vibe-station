import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, _resetSkillCacheForTest } from "../services/promptBuilder.js";
import type { ProjectRecord, WorktreeRecord } from "../types.js";

const makeProject = (path: string): ProjectRecord => ({
  id: "my-project",
  absolutePath: path,
  prefix: "mypr",
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  worktrees: [],
});

const makeWorktree = (): WorktreeRecord => ({
  id: "wt-mypr-1",
  branch: "fix-auth",
  baseBranch: "main",
  baseSha: "abc1234abc1234abc1234abc1234abc1234abc123",
  createdAt: new Date().toISOString(),
  sessions: [],
});

describe("buildPrompt", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vrun-prompt-test-"));
    _resetSkillCacheForTest();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    _resetSkillCacheForTest();
  });

  it("returns systemPrompt containing L1 (skill content)", async () => {
    const result = await buildPrompt({ project: makeProject(tempDir), worktree: makeWorktree() });
    // L1 from skill.md — must contain some content
    expect(typeof result.systemPrompt).toBe("string");
    expect(result.systemPrompt.length).toBeGreaterThan(10);
  });

  it("includes L2 project + worktree context", async () => {
    const project = makeProject(tempDir);
    const worktree = makeWorktree();
    const result = await buildPrompt({ project, worktree });
    expect(result.systemPrompt).toContain(project.id);
    expect(result.systemPrompt).toContain(worktree.branch);
    expect(result.systemPrompt).toContain(worktree.baseBranch);
  });

  it("includes mode context in L2 when provided", async () => {
    const result = await buildPrompt({
      project: makeProject(tempDir),
      worktree: makeWorktree(),
      modeContext: "You are fixing a bug. Open a PR when done.",
    });
    expect(result.systemPrompt).toContain("You are fixing a bug");
  });

  it("omits mode context in L2 when not provided", async () => {
    const result = await buildPrompt({
      project: makeProject(tempDir),
      worktree: makeWorktree(),
    });
    // No mode section
    expect(result.systemPrompt).not.toContain("## Mode Instructions");
  });

  it("sets taskPrompt from userPrompt", async () => {
    const result = await buildPrompt({
      project: makeProject(tempDir),
      worktree: makeWorktree(),
      userPrompt: "Fix the login bug",
    });
    expect(result.taskPrompt).toBe("Fix the login bug");
  });

  it("leaves taskPrompt undefined when no userPrompt", async () => {
    const result = await buildPrompt({ project: makeProject(tempDir), worktree: makeWorktree() });
    expect(result.taskPrompt).toBeUndefined();
  });

  it("reads AGENTS.md from project root (L3)", async () => {
    const agentsMd = join(tempDir, "AGENTS.md");
    await writeFile(agentsMd, "# Rules\nAlways write tests.", "utf8");
    const result = await buildPrompt({ project: makeProject(tempDir), worktree: makeWorktree() });
    expect(result.systemPrompt).toContain("Always write tests.");
  });

  it("falls back to .viberun/rules.md if no AGENTS.md", async () => {
    await mkdir(join(tempDir, ".viberun"), { recursive: true });
    await writeFile(join(tempDir, ".viberun", "rules.md"), "Custom rule: no console.log.", "utf8");
    const result = await buildPrompt({ project: makeProject(tempDir), worktree: makeWorktree() });
    expect(result.systemPrompt).toContain("Custom rule: no console.log.");
  });

  it("works without AGENTS.md or rules.md (L3 silently absent)", async () => {
    const result = await buildPrompt({ project: makeProject(tempDir), worktree: makeWorktree() });
    // Should not throw, systemPrompt should be non-empty
    expect(result.systemPrompt.length).toBeGreaterThan(50);
  });

  it("includes sibling session info in L2 when sessions present", async () => {
    const worktree: WorktreeRecord = {
      ...makeWorktree(),
      sessions: [
        {
          id: "sess-1",
          slot: "m",
          type: "agent",
          tmuxName: "vr-mypr-1-m",
          lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
        },
      ],
    };
    const result = await buildPrompt({ project: makeProject(tempDir), worktree });
    expect(result.systemPrompt).toContain("sess-1");
  });
});
