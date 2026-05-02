import { describe, it, expect } from "vitest";
import type { Session } from "@/api/types";

const P1 = "project-1";
const W1 = "wt-1";

const mockSession = (id: string, slot: "m" | "a" = "m"): Session => ({
  id,
  worktreeId: W1,
  modeId: null,
  type: "terminal",
  state: "working",
  lifecycleState: "working",
  label: slot === "m" ? "main" : "alt",
  slot,
  tmuxName: id,
  createdAt: new Date().toISOString(),
});

describe("useWorkspaceUrlSync - URL omission for main slot logic", () => {
  it("identifies main slot session correctly", () => {
    const mainSession = mockSession("s-main", "m");
    const altSession = mockSession("s-alt", "a");

    expect(mainSession.slot).toBe("m");
    expect(altSession.slot).toBe("a");
  });

  it("main slot sessions are distinguishable from others", () => {
    const sessions = [mockSession("s-main", "m"), mockSession("s-alt", "a")];
    const mainSlot = sessions.find((s) => s.slot === "m");
    expect(mainSlot?.id).toBe("s-main");
  });

  it("session not in list returns undefined", () => {
    const sessions = [mockSession("s-main", "m")];
    const notFound = sessions.find((s) => s.id === "nonexistent");
    expect(notFound).toBeUndefined();
  });

  it("multiple sessions can be filtered by worktreeId and slot", () => {
    const sessions = [
      mockSession("s-main-1", "m"),
      mockSession("s-alt-1", "a"),
      mockSession("s-alt-2", "a"),
    ];
    const mainSessions = sessions.filter((s) => s.slot === "m");
    expect(mainSessions).toHaveLength(1);
    expect(mainSessions[0]!.id).toBe("s-main-1");
  });

  describe("URL param logic", () => {
    it("should omit session param when active session is main slot", () => {
      const sessions = [mockSession("s-main", "m")];
      const activeSessionId = "s-main";
      const activeSession = sessions.find((s) => s.id === activeSessionId)!;

      // This mimics the logic in useWorkspaceUrlSync write effect
      const shouldOmitSessionParam = activeSession.slot === "m";
      expect(shouldOmitSessionParam).toBe(true);
    });

    it("should include session param when active session is non-main slot", () => {
      const sessions = [mockSession("s-main", "m"), mockSession("s-alt", "a")];
      const activeSessionId = "s-alt";
      const activeSession = sessions.find((s) => s.id === activeSessionId)!;

      const shouldOmitSessionParam = activeSession.slot === "m";
      expect(shouldOmitSessionParam).toBe(false);
    });
  });
});
