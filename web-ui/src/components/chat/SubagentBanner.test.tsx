import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SubagentBanner } from "./SubagentBanner";
import { useServerStore } from "@/hooks/useServerStore";
import type { Session } from "@/api/types";

function sess(id: string, name?: string): Session {
  return {
    id,
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: null,
    type: "agent",
    isMain: false,
    name: name ?? null,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: id,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("SubagentBanner — 4.T1: resolved parent renders name and button", () => {
  beforeEach(() => {
    useServerStore.setState({
      projects: [],
      worktrees: [],
      sessions: [sess("parent-1", "Parent Agent")],
      loaded: true,
      childByParent: new Map(),
    });
  });

  it("renders the parent session name in a button", () => {
    render(<SubagentBanner parentSessionId="parent-1" />);
    expect(screen.getByText(/Parent Agent/)).toBeTruthy();
    expect(document.querySelector(".chat-subagent-banner__parent-link")).toBeTruthy();
  });

  it("renders the Subagent label", () => {
    render(<SubagentBanner parentSessionId="parent-1" />);
    expect(screen.getByText("Subagent")).toBeTruthy();
  });
});

describe("SubagentBanner — 4.T2: unknown parentSessionId returns null", () => {
  beforeEach(() => {
    useServerStore.setState({
      projects: [],
      worktrees: [],
      sessions: [],
      loaded: true,
      childByParent: new Map(),
    });
  });

  it("renders nothing when parentSessionId is not in the store", () => {
    const { container } = render(<SubagentBanner parentSessionId="ghost-session" />);
    expect(container.firstChild).toBeNull();
  });
});

describe("SubagentBanner — 4.T3: button click calls onNavigate(parentSessionId)", () => {
  beforeEach(() => {
    useServerStore.setState({
      projects: [],
      worktrees: [],
      sessions: [sess("parent-1", "My Parent")],
      loaded: true,
      childByParent: new Map(),
    });
  });

  it("calls onNavigate with parentSessionId when the button is clicked", () => {
    const onNavigate = vi.fn();
    render(<SubagentBanner parentSessionId="parent-1" onNavigate={onNavigate} />);
    const btn = document.querySelector(".chat-subagent-banner__parent-link") as HTMLButtonElement;
    btn?.click();
    expect(onNavigate).toHaveBeenCalledWith("parent-1");
  });
});
