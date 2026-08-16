import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("renders working and waiting-for-user sections, with finished hidden until toggled", async () => {
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
    // wt-3's idle session buckets under "waiting for user", not "finished".
    expect(screen.getByText("waiting for user")).toBeInTheDocument();
    // wt-2's "done" session is finished — hidden by default.
    expect(screen.queryByText("finished")).toBeNull();

    await userEvent.click(screen.getByRole("checkbox", { name: /show finished/i }));
    expect(screen.getByText("finished")).toBeInTheDocument();
  });

  it("dashboard-direct-agents — shows a direct (worktree-less) agent session, bucketed and linking to /session/:id", async () => {
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

    api.__test.emit({
      type: "session:created",
      sessionId: "sess-direct-1",
      worktreeId: null,
      projectId: "proj-a",
      sessionType: "agent",
      snapshot: {
        id: "sess-direct-1",
        worktreeId: null,
        projectId: "proj-a",
        modeId: "mode-1",
        type: "agent",
        name: "My Direct Agent",
        isMain: false,
        state: "working",
        lifecycleState: "working",
        tmuxName: "sess-direct-1",
        createdAt: new Date().toISOString(),
      },
    });

    await waitFor(() => {
      const workingSection = screen.getByText("working").closest("section");
      expect(workingSection).not.toBeNull();
      const link = within(workingSection!).getByRole("link", { name: /My Direct Agent/i });
      expect(link).toHaveAttribute("href", "/session/sess-direct-1");
    });
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
    const idleSection = screen.getByText("waiting for user").closest("section");
    expect(idleSection).not.toBeNull();
    await waitFor(() => {
      expect(within(idleSection!).getByRole("link", { name: /Proj A/i })).toHaveAttribute(
        "href",
        "/worktree/wt-1",
      );
    });
  });

  it("dashboard-bucket-fixes — a sibling session actively working keeps the worktree bucketed as working, even if another session is waiting_for_human", async () => {
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

    // wt-1: sess-main stays "working"; sess-agent2 flips to waiting_for_human
    // (rank 8, would normally outrank "working" rank 6 in the single-winner
    // rollup) — the worktree must still read as "working" because SOME
    // session is actively working right now.
    api.__test.emit({ type: "session:state", sessionId: "sess-agent2", state: "waiting_for_human" });

    await waitFor(() => {
      const workingSection = screen.getByText("working").closest("section");
      expect(workingSection).not.toBeNull();
      expect(within(workingSection!).getByRole("link", { name: /Proj A/i })).toHaveAttribute(
        "href",
        "/worktree/wt-1",
      );
    });
  });

  it("dashboard-bucket-fixes — excludes an archived session from bucketing", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <DashboardPanel api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-3"]')).not.toBeNull();
    });

    // wt-3's only agent session (idle) gets archived — with no non-archived
    // agent sessions left, the worktree must drop out of every bucket
    // entirely rather than keep poisoning "waiting for user".
    api.__test.emit({
      type: "session:updated",
      sessionId: "sess-wt3-main",
      archivedAt: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-3"]')).toBeNull();
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
        isGit: true,
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
