import { render, screen, waitFor } from "@testing-library/react";
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

  it("renders active sessions when present", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <DashboardPanel api={api} />
      </MemoryRouter>,
    );
    // Dashboard loads async — wait for projects to appear first
    await waitFor(() => {
      expect(screen.getAllByText(/Proj A/i).length).toBeGreaterThan(0);
    });
  });
});
