import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { canOpenSignInTerminal, openSignInTerminal, pickSignInWorktreeId } from "./signInTerminal";

const wt = (id: string, projectId: string) => ({ id, projectId }) as Worktree;

beforeEach(() => {
  useServerStore.setState({ worktrees: [], sessions: [] });
  useWorkspaceStore.setState({ activeWorktreeId: null, activeProjectId: null });
});

describe("pickSignInWorktreeId", () => {
  const all = [wt("w1", "p1"), wt("w2", "p2")];

  it("prefers the active worktree", () => {
    expect(pickSignInWorktreeId("w2", "p1", all)).toBe("w2");
  });

  it("then the first worktree of the active project", () => {
    expect(pickSignInWorktreeId(null, "p2", all)).toBe("w2");
  });

  it("then the first worktree in the store (Settings has no project)", () => {
    expect(pickSignInWorktreeId(null, null, all)).toBe("w1");
    expect(pickSignInWorktreeId(null, "p-gone", all)).toBe("w1");
  });

  it("is null with no worktree at all", () => {
    expect(pickSignInWorktreeId(null, null, [])).toBeNull();
  });
});

describe("openSignInTerminal", () => {
  it("returns false and calls nothing when no worktree can host it", async () => {
    const api = { restartAccountSignIn: vi.fn() };
    expect(canOpenSignInTerminal()).toBe(false);
    expect(await openSignInTerminal(api, "claude", "acc_1")).toBe(false);
    expect(api.restartAccountSignIn).not.toHaveBeenCalled();
  });

  it("restarts the sign-in on the fallback worktree", async () => {
    useServerStore.setState({ worktrees: [wt("w1", "p1")] });
    const api = { restartAccountSignIn: vi.fn(async () => ({ sessionId: "s1" })) };
    expect(canOpenSignInTerminal()).toBe(true);
    expect(await openSignInTerminal(api as never, "claude", "acc_1")).toBe(true);
    expect(api.restartAccountSignIn).toHaveBeenCalledWith("claude", "acc_1", "w1");
  });
});
