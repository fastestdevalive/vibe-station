import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { FilesPanel } from "./FilesPanel";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";

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

  it("toggling tree visibility hides the tree and shows preview-only", async () => {
    const { rerender } = render(<FilesPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("README.md");

    act(() => {
      useWorkspaceStore.getState().toggleFileTree();
    });
    rerender(<FilesPanel api={api} worktreeId="wt-1" />);
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);

    act(() => {
      useWorkspaceStore.getState().toggleFileTree();
    });
    rerender(<FilesPanel api={api} worktreeId="wt-1" />);
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
      const { rerender } = render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      act(() => {
        useWorkspaceStore.getState().setFilesLeftPaneMode("wt-1", "search");
      });
      rerender(<FilesPanel api={api} worktreeId="wt-1" />);

      // Tree is always-mounted — its node is still in the DOM, just inside the
      // CSS-hidden container (display:none), NOT unmounted.
      const treeRow = screen.getByText("README.md");
      expect(treeRow).toBeInTheDocument();
      expect(treeRow.closest(".files-left-pane__hidden")).not.toBeNull();
      // SearchPanel (always-mounted, now active) is showing its input.
      expect(screen.getByPlaceholderText("Search content...")).toBeInTheDocument();
    });

    it("3.T2 — switching tree→search→tree keeps FileTreeSidebar mounted (no conditional-render regression)", async () => {
      const { rerender } = render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      act(() => {
        useWorkspaceStore.getState().setFilesLeftPaneMode("wt-1", "search");
      });
      rerender(<FilesPanel api={api} worktreeId="wt-1" />);
      expect(screen.getByText("README.md")).toBeInTheDocument();

      act(() => {
        useWorkspaceStore.getState().setFilesLeftPaneMode("wt-1", "tree");
      });
      rerender(<FilesPanel api={api} worktreeId="wt-1" />);
      // Back in tree mode, the tree is visible again (no longer in the hidden
      // container) and was never unmounted.
      const treeRow = screen.getByText("README.md");
      expect(treeRow).toBeInTheDocument();
      expect(treeRow.closest(".files-left-pane__hidden")).toBeNull();
    });

    it("3.T3 — peekFile survives a tree→search→tree mode switch (Requirement 7)", async () => {
      const { rerender } = render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      // Set the peek AFTER SearchPanel's empty-query mount effect has run (it
      // clears peek on mount), so we're testing a live peek's persistence.
      useWorkspaceStore.setState({
        peekFile: { worktreeId: "wt-1", path: "src/App.tsx", line: 42, matchText: null, source: "search" },
      });

      act(() => {
        useWorkspaceStore.getState().setFilesLeftPaneMode("wt-1", "search");
      });
      rerender(<FilesPanel api={api} worktreeId="wt-1" />);
      expect(useWorkspaceStore.getState().peekFile).toEqual({ worktreeId: "wt-1", path: "src/App.tsx", line: 42, matchText: null, source: "search" });

      act(() => {
        useWorkspaceStore.getState().setFilesLeftPaneMode("wt-1", "tree");
      });
      rerender(<FilesPanel api={api} worktreeId="wt-1" />);
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

  describe("Revision 2 §4 — drag-resize and rail overlap", () => {
    beforeEach(() => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        fileTreeVisible: true,
        filesLeftPaneWidthByWorktree: {},
      });
    });

    // jsdom doesn't implement setPointerCapture at all; the drag handles call
    // it on pointerdown. Define a no-op so the pointer-events path runs (and
    // the captured pointer's move/up are still delivered to window, which the
    // handler also listens on).
    beforeEach(() => {
      if (!Element.prototype.setPointerCapture) {
        (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
      }
    });

    // The resize clamp is now pane-relative (measures `.files-panel`'s own
    // width/height, not window.innerWidth/innerHeight). jsdom's
    // getBoundingClientRect returns all-zeros, so give the pane a real size
    // for tests that exercise the clamp.
    function mockPaneRect(width: number, height: number) {
      const el = document.querySelector(".files-panel") as HTMLElement | null;
      if (!el) return;
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    }

    // Dispatch a pointer drag: pointerdown on the handle, then pointermove +
    // pointerup on window (what startResize wires), all as PointerEvents.
    function drag(handle: Element, down: { clientX?: number; clientY?: number }, up: { clientX?: number; clientY?: number }) {
      act(() => {
        handle.dispatchEvent(
          new PointerEvent("pointerdown", {
            pointerId: 1,
            bubbles: true,
            clientX: down.clientX ?? 0,
            clientY: down.clientY ?? 0,
          }),
        );
      });
      act(() => {
        window.dispatchEvent(
          new PointerEvent("pointermove", {
            pointerId: 1,
            bubbles: true,
            clientX: up.clientX ?? 0,
            clientY: up.clientY ?? 0,
          }),
        );
      });
      act(() => {
        window.dispatchEvent(
          new PointerEvent("pointerup", {
            pointerId: 1,
            bubbles: true,
            clientX: up.clientX ?? 0,
            clientY: up.clientY ?? 0,
          }),
        );
      });
    }

    it("§4a — renders resize handle with accessible attributes on the expanded panel", async () => {
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      const handle = screen.getByRole("separator", { name: "Resize files side panel" });
      expect(handle).toBeInTheDocument();
      expect(handle).toHaveAttribute("aria-orientation", "vertical");
      expect(handle).toHaveAttribute("aria-valuenow", "240");
      expect(handle).toHaveAttribute("aria-valuemin", "160");
      expect(handle).toHaveAttribute("aria-valuemax", "600");
    });

    it("§4a — dragging resize handle adjusts width and persists to store on pointerup", async () => {
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      mockPaneRect(800, 600);

      const handle = screen.getByRole("separator", { name: "Resize files side panel" });

      // Start drag at x = 200, move 50px right -> 240 + 50 = 290
      drag(handle, { clientX: 200 }, { clientX: 250 });

      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(290);
    });

    it("§4a — dragging clamps to min (160) and max (600)", async () => {
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      // Wide pane: max = min(600, 800 - 80) = 600, so the absolute max applies.
      mockPaneRect(800, 600);

      const handle = screen.getByRole("separator", { name: "Resize files side panel" });

      // Drag way to the left (-200px) -> clamp to min 160
      drag(handle, { clientX: 500 }, { clientX: 100 });
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(160);

      // Drag way to the right (+600px) -> clamp to max 600
      drag(handle, { clientX: 100 }, { clientX: 900 });
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(600);
    });

    it("§4a — clamping is pane-relative, NOT window-relative (narrow pane caps the width below 600)", async () => {
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      // A 300px-wide pane leaves room for the rail + a sliver of preview:
      // max = min(600, 300 - 80) = 220. Window.innerWidth in jsdom is 1024,
      // so the OLD window-based clamp would have allowed up to 600 here.
      mockPaneRect(300, 600);

      const handle = screen.getByRole("separator", { name: "Resize files side panel" });

      // Drag way to the right -> must stop at 220, never reach 600.
      drag(handle, { clientX: 100 }, { clientX: 900 });
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(220);
    });

    it("§4a — keyboard ArrowLeft / ArrowRight adjusts width (and shares the pane-relative clamp)", async () => {
      const user = userEvent.setup();
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      mockPaneRect(800, 600);

      const handle = screen.getByRole("separator", { name: "Resize files side panel" });
      handle.focus();

      await user.keyboard("{ArrowRight}");
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(250);

      await user.keyboard("{ArrowLeft}");
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(240);
    });

    it("§4b — overlay has left at rail width, and content / topbar padding reflects open/closed state", async () => {
      const { container, rerender } = render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
      expect(overlay.style.left).toBe("var(--tools-rail-w, 36px)");

      const content = container.querySelector(".files-panel__content") as HTMLElement;
      const topbar = container.querySelector(".files-topbar") as HTMLElement;

      // Open state: content padded by rail + panel, topbar padded 0
      expect(content.style.paddingLeft).toBe("calc(var(--tools-rail-w, 36px) + var(--tools-rail-panel-w, 240px))");
      expect(topbar.style.paddingLeft).toBe("0px");

      // Close panel
      act(() => {
        useWorkspaceStore.setState({ fileTreeVisible: false });
      });
      rerender(<FilesPanel api={api} worktreeId="wt-1" />);

      // Closed state: content padded 0 (preview full width under rail), topbar padded 36px (tabs avoid rail)
      expect(content.style.paddingLeft).toBe("0px");
      expect(topbar.style.paddingLeft).toBe("var(--tools-rail-w, 36px)");
    });

    it("stacked orientation: sets top overlay, height handle, padding-top on content, and rail-offset on topbar", async () => {
      useWorkspaceStore.setState({
        layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, masterDetailVertical: true } },
      });
      const { container } = render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
      expect(overlay.style.left).toBe("var(--tools-rail-w, 36px)");
      expect(overlay.style.right).toBe("0px");
      expect(overlay.style.height).toBe("var(--tools-rail-panel-h, 240px)");
      expect(overlay.style.borderBottom).toBe("var(--border-width) solid var(--border-default)");
      expect(overlay.style.borderRight).toBe("");

      const handle = screen.getByRole("separator", { name: "Resize files top panel" });
      expect(handle).toHaveAttribute("aria-orientation", "horizontal");
      expect(handle).toHaveAttribute("aria-valuenow", "240");

      const content = container.querySelector(".files-panel__content") as HTMLElement;
      const topbar = container.querySelector(".files-topbar") as HTMLElement;

      expect(content.style.paddingLeft).toBe("0px");
      expect(content.style.paddingTop).toBe("var(--tools-rail-panel-h, 240px)");
      expect(topbar.style.paddingLeft).toBe("var(--tools-rail-w, 36px)");
      expect(topbar.style.paddingRight).toBe("68px");
    });

    it("stacked orientation: dragging clamps to min (100) and max (600)", async () => {
      useWorkspaceStore.setState({
        layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, masterDetailVertical: true } },
      });
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      // Tall pane: max = min(600, 700 - 80) = 600, so the absolute max applies.
      mockPaneRect(800, 700);

      const handle = screen.getByRole("separator", { name: "Resize files top panel" });

      // Drag up (-200px) -> clamp to min 100
      drag(handle, { clientY: 500 }, { clientY: 100 });
      expect(useWorkspaceStore.getState().filesLeftPaneHeightByWorktree["wt-1"]).toBe(100);

      // Drag down (+600px) -> clamp to max 600
      drag(handle, { clientY: 100 }, { clientY: 900 });
      expect(useWorkspaceStore.getState().filesLeftPaneHeightByWorktree["wt-1"]).toBe(600);
    });

    it("stacked orientation: keyboard ArrowUp / ArrowDown adjusts height (and shares the pane-relative clamp)", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, masterDetailVertical: true } },
        filesLeftPaneHeightByWorktree: { "wt-1": 240 },
      });
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      mockPaneRect(800, 700);

      const handle = screen.getByRole("separator", { name: "Resize files top panel" });
      handle.focus();

      await user.keyboard("{ArrowDown}");
      expect(useWorkspaceStore.getState().filesLeftPaneHeightByWorktree["wt-1"]).toBe(250);

      await user.keyboard("{ArrowUp}");
      expect(useWorkspaceStore.getState().filesLeftPaneHeightByWorktree["wt-1"]).toBe(240);
    });
  });
});
