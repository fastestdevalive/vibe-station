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
      expect(screen.getByText(/CLI Daemon/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/Proj A/i)).toBeInTheDocument();
    });
  });

  it("renders sessions list", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <DashboardPanel api={api} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Sessions/i)).toBeInTheDocument();
    });
  });
});
