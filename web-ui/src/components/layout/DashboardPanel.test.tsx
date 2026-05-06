import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { createMockApi } from "@/api/mock";
import { DashboardPanel } from "./DashboardPanel";

describe("DashboardPanel", () => {
  it("renders daemon status and project names on worktree cards", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <DashboardPanel api={api} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/daemon/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
  });

  it("renders working, idle, and finished sections", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <DashboardPanel api={api} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("finished")).toBeInTheDocument();
  });

  it("updates worktree row bucket when session:state fires", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <DashboardPanel api={api} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
    const workingSection = screen.getByText("working").closest("section");
    expect(workingSection).not.toBeNull();
    expect(within(workingSection!).getByRole("link", { name: /Proj A/i })).toHaveAttribute(
      "href",
      "/worktree/wt-1",
    );

    api.__test.emit({ type: "session:state", sessionId: "sess-main", state: "idle" });

    await waitFor(() => {
      // Bucket hides entirely when empty — old section refs would point at stale detached DOM.
      expect(screen.queryByText("working")).toBeNull();
    });
    const idleSection = screen.getByText("idle").closest("section");
    expect(idleSection).not.toBeNull();
    await waitFor(() => {
      expect(within(idleSection!).getByRole("link", { name: /Proj A/i })).toHaveAttribute(
        "href",
        "/worktree/wt-1",
      );
    });
  });
});
