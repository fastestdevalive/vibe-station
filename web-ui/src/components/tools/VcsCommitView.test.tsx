import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { VcsCommitView } from "./VcsCommitView";

describe("VcsCommitView", () => {
  it("10.T1 — fetches GET /changed-paths and GET /diff with scope=commit and the correct sha", async () => {
    const api = createMockApi();
    const changedPathsSpy = vi
      .spyOn(api, "listChangedPaths")
      .mockResolvedValue([{ path: "src/App.tsx", status: "M" }]);
    const diffSpy = vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/src/App.tsx b/src/App.tsx\n");

    const user = userEvent.setup();
    render(<VcsCommitView api={api} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);

    await waitFor(() => {
      expect(changedPathsSpy).toHaveBeenCalledWith("wt-1", "commit", "abc1234def");
    });
    await screen.findByText("App.tsx");

    await user.click(screen.getByText("App.tsx"));
    await waitFor(() => {
      expect(diffSpy).toHaveBeenCalledWith("wt-1", "src/App.tsx", "commit", "abc1234def");
    });
  });

  it("shows the commit breadcrumb label", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listChangedPaths").mockResolvedValue([]);
    render(<VcsCommitView api={api} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);
    expect(await screen.findByText("commit #abc1234")).toBeInTheDocument();
  });

  it("10.T3 — arrow-key roving navigation works inside the controlled ChangedFileList", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listChangedPaths").mockResolvedValue([
      { path: "a.ts", status: "M" },
      { path: "b.ts", status: "M" },
    ]);
    vi.spyOn(api, "getDiff").mockResolvedValue("");
    const user = userEvent.setup();
    render(<VcsCommitView api={api} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);

    const rowA = await screen.findByRole("treeitem", { name: "a.ts" });
    // Focus directly rather than via a synthetic click — the row sits inside
    // a `PanelGroup` (MasterDetailShell), whose own mousedown listener
    // pre-empts default click-to-focus in jsdom the same way it would in a
    // real browser; keyboard users reach the row via Tab, which this
    // reproduces without depending on that unrelated interaction.
    act(() => rowA.focus());
    expect(rowA).toHaveClass("changed-file-list-file--cursor");

    await user.keyboard("{ArrowDown}");
    const rowB = screen.getByRole("treeitem", { name: "b.ts" });
    expect(rowB).toHaveClass("changed-file-list-file--cursor");

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(api.getDiff).toHaveBeenCalledWith("wt-1", "b.ts", "commit", "abc1234def");
    });
  });

  it("surfaces per-file +N -N LOC through to the commit view's file list (ChangedFileList reused verbatim)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listChangedPaths").mockResolvedValue([
      { path: "src/App.tsx", status: "M", insertions: 4, deletions: 2 },
    ]);
    render(<VcsCommitView api={api} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);

    const row = await screen.findByRole("treeitem", { name: "src/App.tsx" });
    expect(row.querySelector(".changed-file-list-file__loc")).toBeInTheDocument();
    expect(row).toHaveTextContent("+4");
    expect(row).toHaveTextContent("−2");
  });
});
