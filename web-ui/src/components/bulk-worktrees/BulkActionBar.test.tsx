import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { BulkActionBar } from "./BulkActionBar";
import { useBulkWorktrees } from "./useBulkWorktrees";

function worktree(id: string): Worktree {
  return {
    id,
    projectId: "proj-a",
    branch: id,
    baseBranch: "main",
    baseSha: "sha",
    createdAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: null,
    hiddenAt: null,
    lspEnabled: false,
  };
}

function seedWorktrees(...ids: string[]) {
  useServerStore.setState({
    projects: [],
    worktrees: ids.map(worktree),
    sessions: [],
    loaded: true,
  });
}

function renderBar(api = createMockApi(), collapsed = false, initialEntry = "/") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <BulkActionBar api={api} collapsed={collapsed} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useBulkWorktrees.setState({ mode: null, selected: new Set(), job: null });
  useWorkspaceStore.setState({ sessionStates: {}, activeWorktreeId: null });
  seedWorktrees();
});

describe("BulkActionBar", () => {
  it("renders nothing outside select mode", () => {
    renderBar();
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("disables the primary button at 0 selected", () => {
    useBulkWorktrees.setState({ mode: "delete" });
    renderBar();

    const primary = screen.getByRole("button", { name: "Delete 0" });
    expect(primary).toBeDisabled();
    expect(primary).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });

  it("labels the primary button with the selection count", () => {
    seedWorktrees("wt-1", "wt-2", "wt-3");
    useBulkWorktrees.setState({ mode: "delete", selected: new Set(["wt-1", "wt-2", "wt-3"]) });
    renderBar();

    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete 3" })).toBeEnabled();
  });

  it("Cancel exits select mode", async () => {
    const user = userEvent.setup();
    seedWorktrees("wt-1");
    useBulkWorktrees.setState({ mode: "archive", selected: new Set(["wt-1"]) });
    renderBar();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useBulkWorktrees.getState().mode).toBeNull();
    expect(useBulkWorktrees.getState().selected.size).toBe(0);
  });

  it("Escape exits select mode", async () => {
    const user = userEvent.setup();
    seedWorktrees("wt-1");
    useBulkWorktrees.setState({ mode: "archive", selected: new Set(["wt-1"]) });
    renderBar();

    await user.keyboard("{Escape}");

    expect(useBulkWorktrees.getState().mode).toBeNull();
  });

  it("Escape while the confirm dialog is open closes the dialog only", async () => {
    const user = userEvent.setup();
    seedWorktrees("wt-1", "wt-2");
    useBulkWorktrees.setState({ mode: "delete", selected: new Set(["wt-1", "wt-2"]) });
    renderBar();

    await user.click(screen.getByRole("button", { name: "Delete 2" }));
    expect(await screen.findByRole("dialog", { name: "Delete 2 worktrees?" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useBulkWorktrees.getState().mode).toBe("delete");
  });

  it("archive starts the job immediately, with no confirmation", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const hideSpy = vi.spyOn(api, "hideWorktree");
    seedWorktrees("wt-1", "wt-2");
    useBulkWorktrees.setState({ mode: "archive", selected: new Set(["wt-1", "wt-2"]) });
    renderBar(api);

    await user.click(screen.getByRole("button", { name: "Archive 2" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));
    expect(hideSpy).toHaveBeenCalledTimes(2);
    expect(useBulkWorktrees.getState().job?.action).toBe("archive");
    expect(useBulkWorktrees.getState().mode).toBeNull();
  });

  it("delete opens the confirm dialog and starts nothing yet", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const deleteSpy = vi.spyOn(api, "deleteWorktree");
    seedWorktrees("wt-1", "wt-2");
    useBulkWorktrees.setState({ mode: "delete", selected: new Set(["wt-1", "wt-2"]) });
    renderBar(api);

    await user.click(screen.getByRole("button", { name: "Delete 2" }));

    expect(await screen.findByRole("dialog", { name: "Delete 2 worktrees?" })).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(useBulkWorktrees.getState().mode).toBe("delete");
  });

  it("warns when the open worktree is part of the delete selection", async () => {
    const user = userEvent.setup();
    seedWorktrees("wt-1", "wt-2");
    useWorkspaceStore.setState({ activeWorktreeId: "wt-1" });
    useBulkWorktrees.setState({ mode: "delete", selected: new Set(["wt-1", "wt-2"]) });
    renderBar(createMockApi(), false, "/worktree/wt-1");

    await user.click(screen.getByRole("button", { name: "Delete 2" }));

    expect(await screen.findByText(/You are viewing “wt-1”; you'll be taken to the dashboard\./)).toBeInTheDocument();
  });

  it("exits select mode when the sidebar collapses", async () => {
    seedWorktrees("wt-1");
    useBulkWorktrees.setState({ mode: "archive", selected: new Set(["wt-1"]) });
    renderBar(createMockApi(), true);

    await waitFor(() => expect(useBulkWorktrees.getState().mode).toBeNull());
  });
});
