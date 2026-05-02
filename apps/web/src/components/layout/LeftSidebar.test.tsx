import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { LeftSidebar } from "./LeftSidebar";
import { useWorkspaceStore } from "@/hooks/useStore";

describe("LeftSidebar", () => {
  const api = createMockApi();

  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeProjectId: "proj-a",
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      sessionStates: {},
      lastSessionByWorktree: {},
      diffScopeByWorktree: {},
    });
  });

  it("renders projects from mock api", async () => {
    render(
      <MemoryRouter>
        <LeftSidebar api={api} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("Proj A")).toBeInTheDocument();
    });
  });

  it("clicking project name toggles worktrees (expand control)", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LeftSidebar api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("wt-1");
    await user.click(screen.getByText("Proj A"));
    expect(screen.queryByText("wt-1")).toBeNull();
    await user.click(screen.getByText("Proj A"));
    await screen.findByText("wt-1");
  });

  it("clicking worktree sets active worktree", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LeftSidebar api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("wt-2");
    await user.click(screen.getByText("wt-2"));
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-2");
  });

  it("worktree row exposes overflow menu control", async () => {
    render(
      <MemoryRouter>
        <LeftSidebar api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("wt-1");
    const menus = screen.getAllByRole("button", { name: /Worktree actions for/i });
    expect(menus[0]?.className).toContain("wt-menu-trigger");
  });

  it("collapsed rail shows abbreviated labels and hides worktree overflow menu", async () => {
    render(
      <MemoryRouter>
        <LeftSidebar api={api} collapsed />
      </MemoryRouter>,
    );
    await screen.findByText("Pra");
    await screen.findByText("Prb");
    await screen.findByText("wt1");
    await screen.findByText("wt2");
    expect(screen.queryAllByRole("button", { name: /Worktree actions for/i })).toHaveLength(0);
  });

  it("Modes is an icon button with accessible name", async () => {
    render(
      <MemoryRouter>
        <LeftSidebar api={api} />
      </MemoryRouter>,
    );
    await screen.findByText("Proj A");
    expect(screen.getByRole("button", { name: /^Modes$/i })).toBeInTheDocument();
  });
});
