import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import type { Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { BulkProgressTray } from "./BulkProgressTray";
import { useBulkWorktreeActions, type BulkWorktreeActions } from "./useBulkWorktreeActions";
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

/** Exposes the actions hook the way the tray's sibling (the action bar) does. */
let actions: BulkWorktreeActions | null = null;

function Harness({ api }: { api: ApiInstance }) {
  actions = useBulkWorktreeActions(api);
  return <BulkProgressTray api={api} />;
}

function renderTray(api: ApiInstance) {
  return render(
    <MemoryRouter>
      <Harness api={api} />
    </MemoryRouter>,
  );
}

/** Hold every delete until the test releases it, so a job stays in flight. */
function deferredDeletes(api: ApiInstance): Array<() => void> {
  const pending: Array<() => void> = [];
  vi.spyOn(api, "deleteWorktree").mockImplementation(
    () =>
      new Promise<{ ok: true }>((resolve) => {
        pending.push(() => resolve({ ok: true }));
      }),
  );
  return pending;
}

beforeEach(() => {
  useBulkWorktrees.setState({ mode: null, selected: new Set(), job: null });
  useWorkspaceStore.setState({ sessionStates: {}, activeWorktreeId: null });
  seedWorktrees();
  actions = null;
});

describe("BulkProgressTray", () => {
  it("renders nothing without a job", () => {
    renderTray(createMockApi());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the live count while a job runs", async () => {
    const api = createMockApi();
    seedWorktrees("wt-1", "wt-2", "wt-3");
    const pending = deferredDeletes(api);
    renderTray(api);

    act(() => {
      actions!.start("delete", ["wt-1", "wt-2", "wt-3"]);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Deleting worktrees… 0 of 3");
    expect(document.querySelector(".bulk-tray__verb-extra")).not.toBeNull();

    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending.shift()!());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Deleting worktrees… 1 of 3"));

    // Drain the rest so the module-scope runner is left finished for later tests.
    for (let i = 0; i < 2; i += 1) {
      await waitFor(() => expect(pending).toHaveLength(1));
      await act(async () => pending.shift()!());
    }
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));
  });

  it("Cancel stops only the not-yet-started items", async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    seedWorktrees("wt-1", "wt-2", "wt-3");
    const pending = deferredDeletes(api);
    renderTray(api);

    act(() => {
      actions!.start("delete", ["wt-1", "wt-2", "wt-3"]);
    });
    await waitFor(() => expect(pending).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useBulkWorktrees.getState().job?.items.map((item) => item.status)).toEqual([
      "running",
      "cancelled",
      "cancelled",
    ]);

    await act(async () => pending.shift()!());
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    expect(screen.getByRole("status")).toHaveTextContent("1 deleted · 2 cancelled");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("reports partial failure and Retry re-runs only the failed item", async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    seedWorktrees("wt-1", "wt-2", "wt-3");
    const deleteSpy = vi.spyOn(api, "deleteWorktree").mockImplementation(async (id: string) => {
      if (id === "wt-3") throw new Error("directory is in use");
      return { ok: true };
    });
    renderTray(api);

    act(() => {
      actions!.start("delete", ["wt-1", "wt-2", "wt-3"]);
    });
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    expect(screen.getByRole("status")).toHaveTextContent("2 deleted · 1 failed");
    expect(screen.getByText("wt-3 — directory is in use")).toBeInTheDocument();

    deleteSpy.mockClear();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy.mock.calls[0]?.[0]).toBe("wt-3");
  });

  it("uses archive wording for archiving jobs", async () => {
    const api = createMockApi();
    seedWorktrees("wt-1", "wt-2");
    const pending: Array<() => void> = [];
    vi.spyOn(api, "hideWorktree").mockImplementation(
      () =>
        new Promise<{ ok: true; worktree: Worktree }>((resolve) => {
          pending.push(() => resolve({ ok: true, worktree: worktree("wt-1") }));
        }),
    );
    renderTray(api);

    act(() => {
      actions!.start("archive", ["wt-1", "wt-2"]);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Archiving… 0 of 2");
    expect(document.querySelector(".bulk-tray__verb-extra")).toBeNull();

    for (let i = 0; i < 2; i += 1) {
      await waitFor(() => expect(pending).toHaveLength(1));
      await act(async () => pending.shift()!());
    }
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));
    expect(screen.getByRole("status")).toHaveTextContent("2 archived");
  });

  it("dismisses a finished job via ×", async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    seedWorktrees("wt-1");
    renderTray(api);

    act(() => {
      actions!.start("delete", ["wt-1"]);
    });
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useBulkWorktrees.getState().job).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
