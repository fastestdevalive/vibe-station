import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Project, Session, SessionState, Worktree } from "@/api/types";
import { CollapsedProjectRail } from "./CollapsedProjectRail";

const project = { id: "p1", name: "Proj One", path: "/tmp/p1" } as unknown as Project;
const worktree = { id: "w1", projectId: "p1", branch: "feat", name: "feat" } as unknown as Worktree;

function agent(id: string, state: SessionState, overrides: Partial<Session> = {}): Session {
  return {
    id,
    worktreeId: "w1",
    projectId: "p1",
    modeId: null,
    type: "agent",
    isMain: false,
    state,
    lifecycleState: state,
    tmuxName: id,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function renderRail(sessions: Session[]) {
  return render(
    <MemoryRouter>
      <CollapsedProjectRail
        projects={[project]}
        pinnedItems={[]}
        workspaces={[]}
        worktreeMap={{ p1: [worktree] }}
        directSessionMap={{}}
        sessionMap={{ w1: sessions }}
        sessionStates={{}}
        activeProjectId={null}
        projectById={{ p1: project }}
        onSelectProject={() => {}}
        onSelectWorktree={() => {}}
        onNewSession={() => {}}
      />
    </MemoryRouter>,
  );
}

describe("CollapsedProjectRail — superseded sessions", () => {
  const sessions = [
    agent("old", "working", { supersededBy: "new" }),
    agent("new", "idle", { isMain: true }),
  ];

  it("project tile dot ignores a superseded working row", () => {
    renderRail(sessions);
    const tile = screen.getByRole("button", { name: /Proj One/i });
    expect(within(tile).getByLabelText("status: idle")).toBeInTheDocument();
    expect(within(tile).queryByLabelText("status: working")).toBeNull();
  });

  it("flyout worktree row ignores a superseded working row", async () => {
    const user = userEvent.setup();
    renderRail(sessions);
    await user.click(screen.getByRole("button", { name: /Proj One/i }));
    const row = (await screen.findAllByRole("menuitem")).find((el) => /feat/.test(el.textContent ?? ""))!;
    expect(within(row).getByLabelText("status: idle")).toBeInTheDocument();
    expect(within(row).queryByLabelText("status: working")).toBeNull();
  });
});
