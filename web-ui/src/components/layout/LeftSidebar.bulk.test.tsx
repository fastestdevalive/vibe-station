import { DemoEnvProvider } from "@/context/DemoEnv";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";
import { useWorkspaceStore } from "@/hooks/useStore";
import { LeftSidebar } from "./LeftSidebar";
import { useBulkWorktrees } from "@/components/bulk-worktrees/useBulkWorktrees";

/** Mirrors `LeftSidebar.test.tsx`: `useServerSync` is mounted by `Workspace` in
 *  production, so the harness wires it here to fill the central store. */
function Harness({ api, children }: { api: ApiInstance; children: ReactNode }) {
  useServerSync(api);
  return <>{children}</>;
}

/** Router-internal path reporter — the only way to prove a row click did NOT navigate. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function renderSidebar(api: ApiInstance) {
  return render(
    <DemoEnvProvider value={{ demo: false, viewport: null, scale: 1, portalRoot: null, eventRoot: null }}>
      <MemoryRouter initialEntries={["/"]}>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
        <LocationProbe />
      </MemoryRouter>
    </DemoEnvProvider>,
  );
}

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
    hideInactiveWorktrees: false,
  });
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  useBulkWorktrees.setState({ mode: null, selected: new Set(), job: null });
});

describe("LeftSidebar — bulk select mode", () => {
  it("replaces the relative time with a checkbox and toggles the row without navigating", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.spyOn(api, "getDiffStat").mockResolvedValue({ insertions: 5, deletions: 2 });
    useBulkWorktrees.setState({ mode: "delete" });
    renderSidebar(api);

    const link = await screen.findByRole("link", { name: /Open worktree wt-1/i });
    const row = link.closest(".tree-row") as HTMLElement;

    expect(row.querySelector(".wt-row__time")).toBeNull();
    expect(row.querySelector("[data-wt-menu-trigger]")).toBeNull();
    expect(within(row).getByRole("checkbox", { name: "Select wt-1" })).toBeInTheDocument();
    await within(row).findByText("+5");

    // Chip, diffstat, checkbox — in that order (design `Select.dc.html`).
    const trail = row.querySelector(".wt-row__trail") as HTMLElement;
    expect([...trail.children].map((el) => el.className)).toEqual([
      "bulk-row__chip",
      "wt-row__diffstat",
      "bulk-row__checkbox",
    ]);
    expect(within(trail).getByText("agent running")).toBeInTheDocument();

    await user.click(link);
    expect(useBulkWorktrees.getState().selected.has("wt-1")).toBe(true);
    expect(screen.getByTestId("location-probe").textContent).toBe("/");
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");

    await user.click(within(row).getByRole("checkbox", { name: "Select wt-1" }));
    expect(useBulkWorktrees.getState().selected.has("wt-1")).toBe(false);
  });

  it("marks a selected row and leaves drafts / direct sessions without a checkbox", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    api.__test.addSession({
      id: "direct-agent-1",
      worktreeId: null,
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      name: "direct-agent-1",
      isMain: false,
      state: "idle",
      lifecycleState: "idle",
      tmuxName: "direct-agent-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      sortOrder: 1,
    });
    api.__test.addSession({
      id: "wt-draft-1",
      worktreeId: null,
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      isMain: false,
      state: "drafting",
      lifecycleState: "drafting",
      tmuxName: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      draftConfig: { entryPoint: "worktree" },
    });
    useBulkWorktrees.setState({ mode: "delete", selected: new Set(["wt-1"]) });
    renderSidebar(api);

    const link = await screen.findByRole("link", { name: /Open worktree wt-1/i });
    const row = link.closest(".tree-row") as HTMLElement;
    expect(row.getAttribute("data-bulk-selected")).toBe("true");

    await screen.findByRole("button", { name: /Expand direct agents for Proj A/i });
    await user.click(screen.getByRole("button", { name: /Expand direct agents for Proj A/i }));

    await waitFor(() => {
      expect(document.querySelectorAll(".tree-row--direct-session").length).toBeGreaterThan(0);
    });
    expect(document.querySelectorAll(".tree-row--direct-session [role='checkbox']")).toHaveLength(0);
    expect(document.querySelectorAll(".draft-row [role='checkbox']")).toHaveLength(0);
  });

  it("Select all on a collapsed project selects its filtered worktrees", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    // Hide done: wt-2's only agent is `done`, so only wt-1 is visible under Proj A.
    useWorkspaceStore.setState({ hideInactiveWorktrees: true });
    useBulkWorktrees.setState({ mode: "delete" });
    renderSidebar(api);

    await screen.findByRole("button", { name: /Collapse project Proj A/i });
    const projectRow = screen
      .getByRole("button", { name: /Collapse project Proj A/i })
      .closest(".tree-row") as HTMLElement;
    const selectAll = within(projectRow).getByRole("button", { name: "Select all" });

    await user.click(projectRow.querySelector(".tree-row__project-expand") as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /Open worktree wt-1/i })).toBeNull();
    });

    await user.click(selectAll);

    expect([...useBulkWorktrees.getState().selected]).toEqual(["wt-1"]);
    expect(within(projectRow).getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("hides the Pinned section while selecting", async () => {
    const api = createMockApi();
    await api.pinWorktree("wt-1");
    renderSidebar(api);

    await screen.findByRole("region", { name: /^pinned$/i });
    act(() => {
      useBulkWorktrees.getState().enter("delete");
    });

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: /^pinned$/i })).toBeNull();
    });
  });

  it("swaps the heading for the select-mode title and exits via Esc", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    useBulkWorktrees.setState({ mode: "archive" });
    renderSidebar(api);

    await waitFor(() =>
      expect(document.querySelector(".bulk-heading__title")).toHaveTextContent("Select worktrees to archive"),
    );
    expect(screen.queryByRole("button", { name: /bulk actions/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Esc" }));
    expect(useBulkWorktrees.getState().mode).toBeNull();
  });

  it("leaves single-row menus untouched when select mode is off", async () => {
    const api = createMockApi();
    renderSidebar(api);

    const link = await screen.findByRole("link", { name: /Open worktree wt-1/i });
    const row = link.closest(".tree-row") as HTMLElement;
    expect(row.querySelector(".wt-row__time")).not.toBeNull();
    expect(row.querySelector("[data-wt-menu-trigger]")).not.toBeNull();
    expect(within(row).queryByRole("checkbox")).toBeNull();
  });

  it("keeps a failed row marked after the job finishes, until the job is cleared", async () => {
    const api = createMockApi();
    useBulkWorktrees.setState({
      job: {
        id: 1,
        action: "delete",
        finished: true,
        cancelRequested: false,
        items: [{ id: "wt-1", label: "wt-1", status: "failed", error: "x" }],
      },
    });
    renderSidebar(api);

    const link = await screen.findByRole("link", { name: /Open worktree wt-1/i });
    const row = link.closest(".tree-row") as HTMLElement;
    expect(row).toHaveAttribute("data-bulk-state", "failed");
    expect(within(row).getByText("failed")).toBeInTheDocument();

    act(() => useBulkWorktrees.setState({ job: null }));
    expect(row).not.toHaveAttribute("data-bulk-state");
    expect(row.querySelector(".wt-row__time")).not.toBeNull();
  });

  it("shows no trail for a done item of a finished job", async () => {
    const api = createMockApi();
    useBulkWorktrees.setState({
      job: {
        id: 1,
        action: "archive",
        finished: true,
        cancelRequested: false,
        items: [{ id: "wt-1", label: "wt-1", status: "cancelled" }],
      },
    });
    renderSidebar(api);
    const link = await screen.findByRole("link", { name: /Open worktree wt-1/i });
    const row = link.closest(".tree-row") as HTMLElement;
    expect(row).not.toHaveAttribute("data-bulk-state");
    expect(row.querySelector(".wt-row__time")).not.toBeNull();
  });
});
