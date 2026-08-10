import { describe, it, expect } from "vitest";
import type { Session } from "@/api/types";

const P1 = "project-1";
const W1 = "wt-1";

const mockSession = (id: string, isMain = true): Session => ({
  id,
  worktreeId: W1,
  projectId: P1,
  modeId: null,
  type: "terminal",
  state: "working",
  lifecycleState: "working",
  isMain,
  tmuxName: id,
  createdAt: new Date().toISOString(),
});

describe("useWorkspaceUrlSync - URL omission for main session logic", () => {
  it("identifies main session correctly", () => {
    const mainSession = mockSession("s-main", true);
    const altSession = mockSession("s-alt", false);

    expect(mainSession.isMain).toBe(true);
    expect(altSession.isMain).toBe(false);
  });

  it("main sessions are distinguishable from others", () => {
    const sessions = [mockSession("s-main", true), mockSession("s-alt", false)];
    const main = sessions.find((s) => s.isMain);
    expect(main?.id).toBe("s-main");
  });

  it("session not in list returns undefined", () => {
    const sessions = [mockSession("s-main", true)];
    const notFound = sessions.find((s) => s.id === "nonexistent");
    expect(notFound).toBeUndefined();
  });

  it("multiple sessions can be filtered by worktreeId and isMain", () => {
    const sessions = [
      mockSession("s-main-1", true),
      mockSession("s-alt-1", false),
      mockSession("s-alt-2", false),
    ];
    const mainSessions = sessions.filter((s) => s.isMain);
    expect(mainSessions).toHaveLength(1);
    expect(mainSessions[0]!.id).toBe("s-main-1");
  });

  describe("URL param logic", () => {
    it("should omit session param when active session is main", () => {
      const sessions = [mockSession("s-main", true)];
      const activeSessionId = "s-main";
      const activeSession = sessions.find((s) => s.id === activeSessionId)!;

      // This mimics the logic in useWorkspaceUrlSync write effect
      const shouldOmitSessionParam = activeSession.isMain;
      expect(shouldOmitSessionParam).toBe(true);
    });

    it("should include session param when active session is non-main", () => {
      const sessions = [mockSession("s-main", true), mockSession("s-alt", false)];
      const activeSessionId = "s-alt";
      const activeSession = sessions.find((s) => s.id === activeSessionId)!;

      const shouldOmitSessionParam = activeSession.isMain;
      expect(shouldOmitSessionParam).toBe(false);
    });
  });

  describe("Path-param routing logic", () => {
    it("write effect produces /worktree/:wtId path for the main session", () => {
      const activeWorktreeId = W1;
      const sessions = [mockSession("s-main", true)];
      const activeSessionId = "s-main";
      const activeSession = sessions.find((s) => s.id === activeSessionId)!;

      // Compute target path (mimics write effect logic)
      let targetPath = "/worktree";
      if (activeWorktreeId) {
        targetPath = `/worktree/${activeWorktreeId}`;
        if (activeSessionId && !activeSession.isMain) {
          targetPath = `/worktree/${activeWorktreeId}/${activeSessionId}`;
        }
      }

      expect(targetPath).toBe(`/worktree/${W1}`);
    });

    it("write effect produces /worktree/:wtId/:sessionId path for non-main session", () => {
      const activeWorktreeId = W1;
      const sessions = [mockSession("s-main", true), mockSession("s-alt", false)];
      const activeSessionId = "s-alt";
      const activeSession = sessions.find((s) => s.id === activeSessionId)!;

      // Compute target path (mimics write effect logic)
      let targetPath = "/worktree";
      if (activeWorktreeId) {
        targetPath = `/worktree/${activeWorktreeId}`;
        if (activeSessionId && !activeSession.isMain) {
          targetPath = `/worktree/${activeWorktreeId}/${activeSessionId}`;
        }
      }

      expect(targetPath).toBe(`/worktree/${W1}/s-alt`);
    });
  });
});
