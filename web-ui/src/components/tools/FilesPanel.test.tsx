import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { FilesPanel } from "./FilesPanel";
import { useWorkspaceStore } from "@/hooks/useStore";

/** 10.T4 — regression: tree toggle / open-file tab / zoom controls behavior
 *  must be unchanged after the `MasterDetailShell` extraction. */
describe("FilesPanel (post-MasterDetailShell extraction)", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: null,
      fileTreeVisible: true,
      previewFontScale: 1,
    });
  });

  it("renders the file tree by default, with no open-file tab", async () => {
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("README.md");
    expect(screen.getByText("No file open")).toBeInTheDocument();
  });

  it("toggling the tree-visibility button hides the tree and shows preview-only", async () => {
    const user = userEvent.setup();
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("README.md");

    const toggle = screen.getByRole("button", { name: "Hide file tree" });
    await user.click(toggle);
    await waitFor(() => expect(screen.queryByText("README.md")).not.toBeInTheDocument());
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);

    await user.click(screen.getByRole("button", { name: "Show file tree" }));
    await screen.findByText("README.md");
  });

  it("opening a file shows the open-file tab with its name; closing it clears activeFilePath", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      openFileTabsByWorktree: { "wt-1": ["src/App.tsx"] },
      activeFileTabIdxByWorktree: { "wt-1": 0 },
    });
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    expect(await screen.findByText("App.tsx")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close App.tsx" }));
    expect(useWorkspaceStore.getState().activeFilePath).toBeNull();
  });

  it("zoom controls bump previewFontScale", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      openFileTabsByWorktree: { "wt-1": ["src/App.tsx"] },
      activeFileTabIdxByWorktree: { "wt-1": 0 },
    });
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("App.tsx");

    const before = useWorkspaceStore.getState().previewFontScaleByWorktree["wt-1"] ?? useWorkspaceStore.getState().previewFontScale;
    await user.click(screen.getByRole("button", { name: "Increase preview font" }));
    expect(useWorkspaceStore.getState().previewFontScaleByWorktree["wt-1"]).toBeGreaterThan(before);

    await user.click(screen.getByRole("button", { name: "Decrease preview font" }));
    expect(useWorkspaceStore.getState().previewFontScaleByWorktree["wt-1"]).toBeCloseTo(before, 5);
  });

  describe("Phase 3 — rail mode switching", () => {
    beforeEach(() => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        activeFilePath: null,
        fileTreeVisible: true,
        filesLeftPaneMode: {},
      });
    });

    it("3.T2 — rail search mode hides the tree and shows SearchPanel without unmounting FileTreeSidebar", async () => {
      const user = userEvent.setup();
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      await user.click(screen.getByRole("button", { name: "Search files" }));

      // Tree is always-mounted — its node is still in the DOM, just inside the
      // CSS-hidden container (display:none), NOT unmounted.
      const treeRow = screen.getByText("README.md");
      expect(treeRow).toBeInTheDocument();
      expect(treeRow.closest(".files-left-pane__hidden")).not.toBeNull();
      // SearchPanel (always-mounted, now active) is showing its input.
      expect(screen.getByPlaceholderText("Search content...")).toBeInTheDocument();
    });

    it("3.T2 — switching tree→search→tree keeps FileTreeSidebar mounted (no conditional-render regression)", async () => {
      const user = userEvent.setup();
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      await user.click(screen.getByRole("button", { name: "Search files" }));
      expect(screen.getByText("README.md")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Switch to file tree" }));
      // Back in tree mode, the tree is visible again (no longer in the hidden
      // container) and was never unmounted.
      const treeRow = screen.getByText("README.md");
      expect(treeRow).toBeInTheDocument();
      expect(treeRow.closest(".files-left-pane__hidden")).toBeNull();
    });

    it("3.T3 — peekFile survives a tree→search→tree mode switch (Requirement 7)", async () => {
      const user = userEvent.setup();
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      // Set the peek AFTER SearchPanel's empty-query mount effect has run (it
      // clears peek on mount), so we're testing a live peek's persistence.
      useWorkspaceStore.setState({
        peekFile: { worktreeId: "wt-1", path: "src/App.tsx", line: 42, matchText: null, source: "search" },
      });

      await user.click(screen.getByRole("button", { name: "Search files" }));
      expect(useWorkspaceStore.getState().peekFile).toEqual({ worktreeId: "wt-1", path: "src/App.tsx", line: 42, matchText: null, source: "search" });

      await user.click(screen.getByRole("button", { name: "Switch to file tree" }));
      expect(useWorkspaceStore.getState().peekFile).toEqual({ worktreeId: "wt-1", path: "src/App.tsx", line: 42, matchText: null, source: "search" });
    });
  });

  // Live-review feedback — confirmed in the live sandbox that with several
  // tabs open, the "+" add-file button appeared to vanish. Root cause: it
  // used to be the LAST CHILD of the horizontally-scrolling tab strip, so
  // once tabs overflowed, it scrolled out of view along with them
  // (unreachable without manually scrolling all the way over). It must be a
  // direct sibling of the scrolling tab strip, not a child of it. (The
  // layout-orientation toggle that was briefly also here has since moved
  // again, to the "Files" tab button itself — see ToolPanel.test.tsx.)
  it("the add-file button is NOT inside the scrollable tab strip, so it stays reachable when tabs overflow", async () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      openFileTabsByWorktree: { "wt-1": ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"] },
      activeFileTabIdxByWorktree: { "wt-1": 0 },
    });
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("a.ts");

    const tabStrip = document.querySelector(".files-topbar__tabs")!;
    const addBtn = screen.getByRole("button", { name: "Open another file" });

    expect(tabStrip.contains(addBtn)).toBe(false);
  });

  // Live-review feedback — a dedicated, always-separate search-preview tab.
  describe("Dedicated search-preview tab", () => {
    it("shows a distinct preview tab for the peeked file, dims the real active tab, and closing it clears the peek", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        activeFilePath: "src/App.tsx",
        openFileTabsByWorktree: { "wt-1": ["src/App.tsx"] },
        activeFileTabIdxByWorktree: { "wt-1": 0 },
        fileTreeVisible: true,
      });
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("App.tsx");

      // Set the peek AFTER SearchPanel's empty-query mount effect has run (it
      // clears peek on mount, same race the 3.T3 test above avoids).
      useWorkspaceStore.setState({
        peekFile: { worktreeId: "wt-1", path: "src/main.tsx", line: 5, matchText: null, source: "search" },
      });

      await screen.findByRole("tablist", { name: "Open files" });
      // Real tab (App.tsx) is present but no longer the active one...
      const realTab = screen.getByRole("tab", { name: /App\.tsx/ });
      expect(realTab).not.toHaveAttribute("data-active");
      // ...while the dedicated preview tab (main.tsx) is active instead.
      const previewTab = screen.getByRole("tab", { name: /main\.tsx/ });
      expect(previewTab).toHaveAttribute("data-active");
      expect(previewTab).toHaveClass("files-topbar__tab--preview");

      // Closing the preview tab clears the peek (and leaves the real tab alone).
      await user.click(screen.getByRole("button", { name: "Close search preview" }));
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().openFileTabsByWorktree["wt-1"]).toEqual(["src/App.tsx"]);
    });

    it("no preview tab rendered when there is no active peek", async () => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        activeFilePath: "src/App.tsx",
        openFileTabsByWorktree: { "wt-1": ["src/App.tsx"] },
        activeFileTabIdxByWorktree: { "wt-1": 0 },
        peekFile: null,
      });
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("App.tsx");
      expect(screen.queryByRole("button", { name: "Close search preview" })).not.toBeInTheDocument();
    });

    // 2.T5 — double-clicking the preview tab promotes it into openFileTabsByWorktree;
    // a subsequent pushJump to that same path skips the peek slot and scrolls the existing tab instead (R3)
    it("2.T5 — double-clicking preview tab promotes to permanent tab; subsequent pushJump skips peek slot", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        activeFilePath: "src/App.tsx",
        openFileTabsByWorktree: { "wt-1": ["src/App.tsx"] },
        activeFileTabIdxByWorktree: { "wt-1": 0 },
        fileTreeVisible: true,
      });
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("App.tsx");

      act(() => {
        useWorkspaceStore.setState({
          peekFile: {
            worktreeId: "wt-1",
            path: "src/main.tsx",
            line: 5,
            matchText: null,
            source: "definition",
          },
        });
      });

      const previewTab = await screen.findByRole("tab", { name: /main\.tsx/ });
      expect(previewTab).toBeInTheDocument();

      // Double-click preview tab promotes it to permanent tab
      await user.dblClick(previewTab);

      // peekFile is cleared and src/main.tsx is now in openFileTabsByWorktree
      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().openFileTabsByWorktree["wt-1"]).toContain("src/main.tsx");
      expect(useWorkspaceStore.getState().activeFilePath).toBe("src/main.tsx");

      // Subsequent pushJump to src/main.tsx skips peek slot and scrolls the existing tab
      act(() => {
        useWorkspaceStore.getState().pushJump({
          worktreeId: "wt-1",
          path: "src/main.tsx",
          line: 12,
          matchText: null,
          source: "definition",
        });
      });

      expect(useWorkspaceStore.getState().peekFile).toBeNull();
      expect(useWorkspaceStore.getState().pendingLineTarget).toEqual({
        worktreeId: "wt-1",
        path: "src/main.tsx",
        line: 12,
        matchText: null,
      });
    });

    // 4.T5 — external peek shows the "outside workspace" badge with displayPath;
    // double-click does not promote it (assert openFileTabsByWorktree unchanged)
    it("4.T5 — external peek renders 'outside workspace' badge with displayPath and double-click does not promote it", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        activeFilePath: "src/App.tsx",
        openFileTabsByWorktree: { "wt-1": ["src/App.tsx"] },
        activeFileTabIdxByWorktree: { "wt-1": 0 },
        fileTreeVisible: true,
      });
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("App.tsx");

      act(() => {
        useWorkspaceStore.setState({
          peekFile: {
            worktreeId: "wt-1",
            path: "tokio/src/lib.rs",
            line: 10,
            matchText: null,
            source: "definition",
            external: {
              token: "test-token-123",
              displayPath: "tokio::runtime::Runtime",
            },
          },
        });
      });

      // Assert badge is visible and displayPath is rendered
      expect(await screen.findByText("tokio::runtime::Runtime")).toBeInTheDocument();
      expect(screen.getByText("outside workspace")).toBeInTheDocument();

      const previewTab = screen.getByRole("tab", { name: /tokio::runtime::Runtime/ });
      expect(previewTab).toBeInTheDocument();

      // Double-click preview tab does NOT promote to permanent tab
      await user.dblClick(previewTab);

      // peekFile is still active, openFileTabsByWorktree is unchanged
      expect(useWorkspaceStore.getState().peekFile).not.toBeNull();
      expect(useWorkspaceStore.getState().openFileTabsByWorktree["wt-1"]).toEqual(["src/App.tsx"]);
    });
  });
});
