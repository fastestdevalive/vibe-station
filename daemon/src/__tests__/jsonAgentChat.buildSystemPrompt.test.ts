import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";

const buildPromptMock = vi.fn().mockResolvedValue({ systemPrompt: "worktree-prompt" });
const buildDirectPromptMock = vi.fn().mockResolvedValue({ systemPrompt: "direct-prompt" });

vi.mock("../services/promptBuilder.js", () => ({
  buildPrompt: (...args: unknown[]) => buildPromptMock(...args),
  buildDirectPrompt: (...args: unknown[]) => buildDirectPromptMock(...args),
}));

describe("jsonAgentChat — buildSystemPrompt passes richChat: true (2.T3)", () => {
  beforeEach(() => {
    buildPromptMock.mockClear();
    buildDirectPromptMock.mockClear();
  });

  const project = { id: "p1" } as unknown as ProjectRecord;
  const worktree = { id: "w1" } as unknown as WorktreeRecord;
  const session = { id: "s1" } as unknown as SessionRecord;

  it("passes richChat: true for the worktree path (buildPrompt)", async () => {
    const { _buildSystemPromptForTest } = await import("../services/jsonAgentChat.js");
    await _buildSystemPromptForTest({ project, worktree, session }, { cli: "claude" });
    expect(buildPromptMock).toHaveBeenCalledTimes(1);
    expect(buildPromptMock.mock.calls[0]?.[0]).toMatchObject({ richChat: true });
    expect(buildDirectPromptMock).not.toHaveBeenCalled();
  });

  it("passes richChat: true for the direct path (buildDirectPrompt)", async () => {
    const { _buildSystemPromptForTest } = await import("../services/jsonAgentChat.js");
    await _buildSystemPromptForTest({ project, worktree: null, session }, { cli: "claude" });
    expect(buildDirectPromptMock).toHaveBeenCalledTimes(1);
    expect(buildDirectPromptMock.mock.calls[0]?.[0]).toMatchObject({ richChat: true });
    expect(buildPromptMock).not.toHaveBeenCalled();
  });
});
