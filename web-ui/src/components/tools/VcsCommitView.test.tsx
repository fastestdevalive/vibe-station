import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";
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
      expect(changedPathsSpy).toHaveBeenCalledWith("wt-1", "commit", "abc1234def", "worktree", undefined);
    });
    await screen.findByText("App.tsx");

    await user.click(screen.getByText("App.tsx"));
    await waitFor(() => {
      expect(diffSpy).toHaveBeenCalledWith("wt-1", "src/App.tsx", "commit", "abc1234def", "worktree", undefined);
    });
  });

  it("shows the commit breadcrumb label", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listChangedPaths").mockResolvedValue([]);
    render(<VcsCommitView api={api} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);
    expect(await screen.findByText("commit #abc1234")).toBeInTheDocument();
  });

  it("hides the changed-file sidebar when the VCS rail closed it (State C)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listChangedPaths").mockResolvedValue([{ path: "src/App.tsx", status: "M" }]);
    vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/src/App.tsx b/src/App.tsx\n");
    // Sidebar driven by the VCS rail icon's store flag, not `fileTreeVisible`.
    const { useWorkspaceStore } = await import("@/hooks/useStore");
    useWorkspaceStore.setState({
      vcsSidebarVisibleByWorktree: { "wt-1": false },
      fileTreeVisible: true,
    });
    try {
      render(<VcsCommitView api={api} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);

      // Changed-file list hidden even though fileTreeVisible is true.
      await waitFor(() => expect(api.listChangedPaths).toHaveBeenCalled());
      expect(screen.queryByRole("treeitem", { name: "src/App.tsx" })).not.toBeInTheDocument();
      // The old split's two redundant toggles are gone.
      expect(screen.queryByRole("button", { name: "Hide file tree" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Switch to stacked layout" })).not.toBeInTheDocument();
    } finally {
      // Reset the store so the leaked state doesn't hide the sidebar for the
      // sibling tests that run in this file with the shared real store.
      useWorkspaceStore.setState({
        vcsSidebarVisibleByWorktree: {},
        fileTreeVisible: true,
      });
    }
  });

  it("3.T4 — under scope='project', listChangedPaths is called with the project id and FilePreviewPane diffs at project scope", async () => {
    const api = createMockApi();
    const changedPathsSpy = vi
      .spyOn(api, "listChangedPaths")
      .mockResolvedValue([{ path: "src/App.tsx", status: "M" }]);
    const diffSpy = vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/src/App.tsx b/src/App.tsx\n");

    const user = userEvent.setup();
    render(<VcsCommitView api={api} worktreeId="proj-1" sha="abc1234def" onBack={() => {}} scope="project" />);

    await waitFor(() => {
      expect(changedPathsSpy).toHaveBeenCalledWith("proj-1", "commit", "abc1234def", "project", undefined);
    });
    await screen.findByText("App.tsx");

    // Clicking the file drives FilePreviewPane, which must fetch the diff at
    // project scope (its `scope` prop threaded through from VcsCommitView).
    await user.click(screen.getByText("App.tsx"));
    await waitFor(() => {
      expect(diffSpy).toHaveBeenCalledWith("proj-1", "src/App.tsx", "commit", "abc1234def", "project", undefined);
    });
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
    // an overlay docked on the right; keyboard users reach the row via Tab,
    // which this reproduces without depending on click-to-focus in jsdom.
    act(() => rowA.focus());
    expect(rowA).toHaveClass("changed-file-list-file--cursor");

    await user.keyboard("{ArrowDown}");
    const rowB = screen.getByRole("treeitem", { name: "b.ts" });
    expect(rowB).toHaveClass("changed-file-list-file--cursor");

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(api.getDiff).toHaveBeenCalledWith("wt-1", "b.ts", "commit", "abc1234def", "worktree", undefined);
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

  describe("docked on the RIGHT, like the Files list", () => {
    const entries = [{ path: "src/App.tsx", status: "M" as const }];
    const mockApi = () => {
      const api = createMockApi();
      vi.spyOn(api, "listChangedPaths").mockResolvedValue(entries);
      vi.spyOn(api, "getDiff").mockResolvedValue("diff --git a/src/App.tsx b/src/App.tsx\n");
      return api;
    };
    const reset = () =>
      useWorkspaceStore.setState({
        filesLeftPaneWidthByWorktree: {},
        filesLeftPaneHeightByWorktree: {},
        layoutByWorktree: {},
        vcsSidebarVisibleByWorktree: {},
      });
    beforeEach(() => {
      reset();
      if (!Element.prototype.setPointerCapture) {
        (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
      }
    });
    afterEach(() => {
      vi.restoreAllMocks();
      reset();
    });

    function drag(handle: Element, downX: number, upX: number) {
      act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true, clientX: downX }));
      });
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, bubbles: true, clientX: upX }));
      });
      act(() => {
        window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true, clientX: upX }));
      });
    }

    it("the changed-file list is an overlay on the right edge, the content column pads for it", async () => {
      const { container } = render(<VcsCommitView api={mockApi()} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);
      const row = await screen.findByRole("treeitem", { name: "src/App.tsx" });
      const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
      expect(overlay.contains(row)).toBe(true);
      expect(overlay.style.right).toBe("0px");
      expect(overlay.style.left).toBe("");
      expect(overlay.style.width).toBe("var(--list-pane-w, 240px)");
      const content = container.querySelector(".files-panel__content") as HTMLElement;
      expect(content.style.paddingRight).toBe("var(--list-pane-w, 240px)");
      // The diff preview and the breadcrumb bar are in the content column, not the list.
      expect(content.contains(screen.getByText("commit #abc1234"))).toBe(true);
      expect(overlay.contains(screen.getByText("commit #abc1234"))).toBe(false);
      // The list header uses the shared actions-row convention.
      expect(overlay.querySelector(".commit-files__head")).toHaveClass("actions-row");
      // Compares document order too: overlay is after the content (DOM order = visual order, right).
      expect(content.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("the handle is on the list's left edge: dragging left grows it (shared persisted width), arrows are inverted", async () => {
      const user = userEvent.setup();
      const { container } = render(<VcsCommitView api={mockApi()} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);
      await screen.findByRole("treeitem", { name: "src/App.tsx" });
      const panel = container.querySelector(".files-panel") as HTMLElement;
      vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
        width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
      });
      const handle = screen.getByRole("separator", { name: "Resize changed files side panel" });
      expect(handle).toHaveAttribute("aria-valuenow", "240");
      drag(handle, 250, 200);
      // The Files tab's own store slice: one width for both views.
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(290);
      // Let the open-time list autofocus (one animation frame) settle before the handle takes focus.
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });
      act(() => handle.focus());
      await user.keyboard("{ArrowLeft}");
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(300);
      await user.keyboard("{ArrowRight}");
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(290);
    });

    it("stacked layout (the shared masterDetailVertical): the list is a top overlay with a horizontal handle", async () => {
      useWorkspaceStore.setState({
        layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, masterDetailVertical: true } },
      });
      const { container } = render(<VcsCommitView api={mockApi()} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);
      await screen.findByRole("treeitem", { name: "src/App.tsx" });
      const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
      expect(overlay.style.top).toBe("0px");
      expect(overlay.style.left).toBe("0px");
      expect(overlay.style.height).toBe("var(--list-pane-h, 240px)");
      expect(screen.getByRole("separator", { name: "Resize changed files top panel" })).toHaveAttribute("aria-orientation", "horizontal");
    });

    it("toggling the list (VCS rail icon) never remounts the diff preview column", async () => {
      const { container } = render(<VcsCommitView api={mockApi()} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);
      await screen.findByRole("treeitem", { name: "src/App.tsx" });
      const content = container.querySelector(".files-panel__content");
      const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
      act(() => useWorkspaceStore.getState().setVcsSidebarVisible("wt-1", false));
      expect(container.querySelector(".files-panel__content")).toBe(content);
      expect(overlay.style.display).toBe("none");
      expect((content as HTMLElement).style.paddingRight).toBe("0px");
      act(() => useWorkspaceStore.getState().setVcsSidebarVisible("wt-1", true));
      expect(container.querySelector(".files-panel__content")).toBe(content);
      expect(overlay.style.display).toBe("flex");
    });

    describe("phone (<=768px)", () => {
      const realMatchMedia = window.matchMedia;
      beforeEach(() => {
        window.matchMedia = ((q: string) => ({
          matches: q.includes("max-width: 768px"),
          media: q, onchange: null,
          addEventListener: () => {}, removeEventListener: () => {},
          addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
        const real = HTMLElement.prototype.getBoundingClientRect;
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
          return this.classList.contains("files-panel")
            ? ({ width: 345, height: 600, top: 0, left: 0, right: 345, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
            : real.call(this);
        });
      });
      afterEach(() => {
        window.matchMedia = realMatchMedia;
      });

      it("full-height list on the right, half the pane by default, the diff column keeps >=144px", async () => {
        const { container } = render(<VcsCommitView api={mockApi()} worktreeId="wt-1" sha="abc1234def" onBack={() => {}} />);
        await screen.findByRole("treeitem", { name: "src/App.tsx" });
        const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
        const panel = container.querySelector(".files-panel") as HTMLElement;
        expect(overlay.style.top).toBe("0px");
        expect(overlay.style.bottom).toBe("0px");
        expect(overlay.style.right).toBe("0px");
        expect(panel.style.getPropertyValue("--list-pane-w")).toBe("173px");
        expect(screen.getByRole("separator", { name: "Resize changed files side panel" })).toHaveAttribute("aria-valuenow", "173");
        // A stored 600 is clamped to leave the diff its 144px minimum: 345 - 144 = 201.
        act(() => useWorkspaceStore.getState().setFilesLeftPaneWidth("wt-1", 600));
        expect(panel.style.getPropertyValue("--list-pane-w")).toBe("201px");
      });
    });
  });
});
