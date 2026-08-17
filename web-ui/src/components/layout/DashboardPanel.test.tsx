import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { DashboardPanel, bucketForRollup } from "./DashboardPanel";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";

describe("bucketForRollup (4.T1, inverted by 5.T3/D19)", () => {
  it("5.T3 — done + pr=merged lands in finished, NOT the pr bucket (D19 — done is terminal)", () => {
    expect(bucketForRollup("done", { state: "merged", checkedAt: "" })).toBe("finished");
  });

  it("exited + pr=open also lands in finished (D19 applies to exited too)", () => {
    expect(bucketForRollup("exited", { state: "open", checkedAt: "" })).toBe("finished");
  });

  it("working + pr=open stays in working — live activity wins", () => {
    expect(bucketForRollup("working", { state: "open", checkedAt: "" })).toBe("working");
  });

  it("idle + pr=open lands in the pr bucket", () => {
    expect(bucketForRollup("idle", { state: "open", checkedAt: "" })).toBe("pr");
  });

  it("idle + pr=draft/closed/none does not land in the pr bucket", () => {
    expect(bucketForRollup("idle", { state: "draft", checkedAt: "" })).toBe("waiting");
    expect(bucketForRollup("idle", { state: "closed", checkedAt: "" })).toBe("waiting");
    expect(bucketForRollup("idle", { state: "none", checkedAt: "" })).toBe("waiting");
    expect(bucketForRollup("idle", null)).toBe("waiting");
  });

  it("done + no pr lands in finished", () => {
    expect(bucketForRollup("done", null)).toBe("finished");
  });
});

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

  it("4.T2/5.T3 — an idle worktree whose PR merges moves into the PR column across a session:updated event", async () => {
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
    // wt-3's only session (sess-wt3-main) starts idle — bucketed under
    // "waiting for user" until its PR is reported merged.
    expect(screen.queryByText("pr created")).toBeNull();

    api.__test.emit({
      type: "session:updated",
      sessionId: "sess-wt3-main",
      pr: { state: "merged", checkedAt: new Date().toISOString(), prBranch: "wt-main" },
    });

    await waitFor(() => {
      const prSection = screen.getByText("pr created").closest("section");
      expect(prSection).not.toBeNull();
      expect(within(prSection!).getByRole("link", { name: /Proj B/i })).toHaveAttribute(
        "href",
        "/worktree/wt-3",
      );
    });
  });

  it("5.T3 (D19) — a DONE worktree's PR merging does NOT pull it out of finished/into the PR column", async () => {
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
    // wt-2's only session (sess-wt2-main) is "done" — hidden behind "Show
    // finished" and MUST stay there even once its PR merges (D19 — done is
    // terminal, checked before the PR check in bucketForRollup).
    expect(screen.queryByText("pr created")).toBeNull();

    api.__test.emit({
      type: "session:updated",
      sessionId: "sess-wt2-main",
      pr: { state: "merged", checkedAt: new Date().toISOString(), prBranch: "wt-2" },
    });

    await waitFor(() => {
      expect(screen.queryByText("pr created")).toBeNull();
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/show finished/i));
    await waitFor(() => {
      expect(document.querySelector('a[href="/worktree/wt-2"]')).not.toBeNull();
    });
  });

  it("4.T6 — a direct session with pr.state==='open' lands in the PR bucket", async () => {
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
      sessionId: "sess-direct-pr",
      worktreeId: null,
      projectId: "proj-a",
      sessionType: "agent",
      snapshot: {
        id: "sess-direct-pr",
        worktreeId: null,
        projectId: "proj-a",
        modeId: "mode-1",
        type: "agent",
        name: "Direct PR Agent",
        isMain: false,
        state: "idle",
        lifecycleState: "idle",
        tmuxName: "sess-direct-pr",
        createdAt: new Date().toISOString(),
      },
    });
    api.__test.emit({ type: "session:updated", sessionId: "sess-direct-pr", pr: { state: "open", checkedAt: new Date().toISOString() } });

    await waitFor(() => {
      const prSection = screen.getByText("pr created").closest("section");
      expect(prSection).not.toBeNull();
      const link = within(prSection!).getByRole("link", { name: /Direct PR Agent/i });
      expect(link).toHaveAttribute("href", "/session/sess-direct-pr");
    });
  });

  it("4.T6 — an archivedAt-set session in waiting_for_human does not place its worktree in the Waiting bucket", async () => {
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

    // wt-3's only agent session flips to waiting_for_human but is archived in
    // the same update — archived sessions are excluded from bucketing, so
    // the worktree must drop out entirely rather than land in "waiting for user".
    api.__test.emit({ type: "session:state", sessionId: "sess-wt3-main", state: "waiting_for_human" });
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
