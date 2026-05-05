import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { createMockApi } from "@/api/mock";
import { DashboardPanel } from "./DashboardPanel";

describe("DashboardPanel", () => {
  it("renders daemon status and project list", async () => {
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

  it("renders working and idle session sections", async () => {
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
  });

  it("updates session row when session:state fires", async () => {
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
    expect(within(workingSection!).getByText("main")).toBeInTheDocument();

    api.__test.emit({ type: "session:state", sessionId: "sess-main", state: "idle" });

    await waitFor(() => {
      expect(within(workingSection!).queryByText("main")).toBeNull();
    });
    const idleSection = screen.getByText("idle").closest("section");
    expect(idleSection).not.toBeNull();
    await waitFor(() => {
      expect(within(idleSection!).getAllByText("main").length).toBe(2);
    });
  });
});
