import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { DashboardPanel } from "./DashboardPanel";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";

/** Mirrors production wiring (useServerSync lives in Workspace) so WS events
 *  emitted via api.__test.emit flow into the central store. */
function Harness({ api, children }: { api: ApiInstance; children: ReactNode }) {
  useServerSync(api);
  return <>{children}</>;
}

describe("DashboardPanel", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  });

  it("renders daemon status and project names on worktree cards", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
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
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
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
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
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

  it("excludes a hidden project's worktree cards and its project card", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    // proj-a's worktree wt-1 has agent sessions → a worktree card linking to it.
    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-1"]')).not.toBeNull();
    });

    api.__test.emit({
      type: "project:updated",
      project: {
        id: "proj-a",
        name: "Proj A",
        path: "/home/dev/proj-a",
        prefix: "pa",
        defaultBranch: "main",
        createdAt: new Date().toISOString(),
        hidden: true,
      },
    });

    // The hidden project's worktree cards disappear.
    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-1"]')).toBeNull();
    });
    // No "Proj A" trace remains anywhere on the dashboard (worktree cards or
    // the projects section).
    expect(screen.queryByText("Proj A")).toBeNull();
    // A visible project's worktree (proj-b / wt-3) is unaffected.
    expect(document.querySelector('a[href="/worktree/wt-3"]')).not.toBeNull();
  });
});
