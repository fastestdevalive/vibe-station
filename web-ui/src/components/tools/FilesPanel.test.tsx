import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { FilesPanel } from "./FilesPanel";
import { mobileListSize } from "@/components/layout/DockedListLayout";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";

/** 10.T4 — regression: tree toggle / open-file tab / zoom controls behavior
 *  must be unchanged after the docked-list extraction. */
describe("FilesPanel (post docked-list extraction)", () => {
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

  it("opening the list refocuses it, except while focus sits on the actions chip's toggle (it must keep focus)", async () => {
    const next = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    const chip = document.createElement("div");
    chip.className = "top-actions-anchor";
    const toggle = document.createElement("button");
    chip.appendChild(toggle);
    document.body.appendChild(chip);
    try {
      useWorkspaceStore.setState({ fileTreeVisible: false });
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("No file open");
      // Chip focused: opening the list does not steal focus.
      toggle.focus();
      act(() => useWorkspaceStore.getState().toggleFileTree());
      await next();
      expect(document.activeElement).toBe(toggle);
      // Focus elsewhere: opening the list moves focus into it (unchanged behaviour).
      act(() => useWorkspaceStore.getState().toggleFileTree());
      (document.activeElement as HTMLElement | null)?.blur();
      act(() => useWorkspaceStore.getState().toggleFileTree());
      await next();
      expect(document.activeElement).not.toBe(toggle);
      expect(screen.getByRole("tree", { name: /Worktree files/ }).contains(document.activeElement)).toBe(true);
    } finally {
      chip.remove();
    }
  });

  it("Close all files appears with 2+ tabs and clears them; absent with 1 tab", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      openFileTabsByWorktree: { "wt-1": ["src/App.tsx"] },
      activeFileTabIdxByWorktree: { "wt-1": 0 },
    });
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("README.md");
    expect(screen.queryByRole("button", { name: "Close all files" })).toBeNull();

    act(() => {
      useWorkspaceStore.setState({
        openFileTabsByWorktree: { "wt-1": ["src/App.tsx", "README.md"] },
      });
    });
    await user.click(await screen.findByRole("button", { name: "Close all files" }));
    expect(screen.getByText("No file open")).toBeInTheDocument();
    expect(useWorkspaceStore.getState().openFileTabsByWorktree["wt-1"]).toEqual([]);
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
    // The name shows in the tab and in the strip; the tab is the identity this test cares about.
    expect(await screen.findByRole("tab", { name: /App\.tsx/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close App.tsx" }));
    expect(useWorkspaceStore.getState().activeFilePath).toBeNull();
  });

  it("the File menu text size bumps previewFontScale", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      openFileTabsByWorktree: { "wt-1": ["src/App.tsx"] },
      activeFileTabIdxByWorktree: { "wt-1": 0 },
    });
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    await screen.findByRole("tab", { name: /App\.tsx/ });

    const before = useWorkspaceStore.getState().previewFontScaleByWorktree["wt-1"] ?? useWorkspaceStore.getState().previewFontScale;
    // Text size lives in the strip's File menu (tools-pane-rework B4.2); the menu stays open for repeated steps.
    await user.click(screen.getByRole("button", { name: "File menu" }));
    await user.click(screen.getByRole("button", { name: "Increase text size" }));
    expect(useWorkspaceStore.getState().previewFontScaleByWorktree["wt-1"]).toBeGreaterThan(before);

    await user.click(screen.getByRole("button", { name: "Decrease text size" }));
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
      expect(useWorkspaceStore.getState().peekFile).toMatchObject({ worktreeId: "wt-1", path: "src/App.tsx", line: 42, matchText: null, source: "search" });

      act(() => {
        useWorkspaceStore.getState().setFilesLeftPaneMode("wt-1", "tree");
      });
      rerender(<FilesPanel api={api} worktreeId="wt-1" />);
      expect(useWorkspaceStore.getState().peekFile).toMatchObject({ worktreeId: "wt-1", path: "src/App.tsx", line: 42, matchText: null, source: "search" });
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
      await screen.findByRole("tab", { name: /App\.tsx/ });

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
      await screen.findByRole("tab", { name: /App\.tsx/ });
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
      await screen.findByRole("tab", { name: /App\.tsx/ });

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
      expect(useWorkspaceStore.getState().pendingLineTarget).toMatchObject({
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
      await screen.findByRole("tab", { name: /App\.tsx/ });

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
      // Desktop floor 224 = the chip reserve with the offline pill (145px) + room for the list header's own items.
      expect(handle).toHaveAttribute("aria-valuemin", "224");
      expect(handle).toHaveAttribute("aria-valuemax", "600");
    });

    it("§4a — a persisted width below the desktop floor is shown at the floor (the chip never covers the list header)", async () => {
      useWorkspaceStore.setState({ filesLeftPaneWidthByWorktree: { "wt-1": 160 } });
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      expect(screen.getByRole("separator", { name: "Resize files side panel" })).toHaveAttribute("aria-valuenow", "224");
    });

    it("§4a — dragging resize handle adjusts width and persists to store on pointerup", async () => {
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      mockPaneRect(800, 600);

      const handle = screen.getByRole("separator", { name: "Resize files side panel" });

      // Handle is on the LEFT edge: start at x = 250, drag 50px LEFT -> 240 + 50 = 290
      drag(handle, { clientX: 250 }, { clientX: 200 });

      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(290);

      // Dragging RIGHT shrinks: 290 - 30 = 260
      drag(handle, { clientX: 200 }, { clientX: 230 });
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(260);
    });

    it("§4a — dragging clamps to the desktop min (224) and max (600)", async () => {
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      // Wide pane: max = min(600, 800 - 80) = 600, so the absolute max applies.
      mockPaneRect(800, 600);

      const handle = screen.getByRole("separator", { name: "Resize files side panel" });

      // Drag way to the right (+400px shrinks) -> clamp to min 224
      drag(handle, { clientX: 100 }, { clientX: 500 });
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(224);

      // Drag way to the left (-800px grows) -> clamp to max 600
      drag(handle, { clientX: 900 }, { clientX: 100 });
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(600);
    });

    it("§4a — clamping is pane-relative, NOT window-relative (narrow pane caps the width below 600)", async () => {
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      // A 300px-wide pane must keep the content column its 120px minimum (W1-02):
      // max = min(600, 300 - 120) = 180. Window.innerWidth in jsdom is 1024,
      // so the OLD window-based clamp would have allowed up to 600 here.
      mockPaneRect(300, 600);

      const handle = screen.getByRole("separator", { name: "Resize files side panel" });

      // Drag way to the left (grows) -> must stop at 180, never reach 600.
      drag(handle, { clientX: 900 }, { clientX: 100 });
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(180);
    });

    it("§4a — keyboard ArrowLeft / ArrowRight adjusts width (and shares the pane-relative clamp)", async () => {
      const user = userEvent.setup();
      render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      mockPaneRect(800, 600);

      const handle = screen.getByRole("separator", { name: "Resize files side panel" });
      handle.focus();

      // Left-edge handle: ArrowLeft grows, ArrowRight shrinks.
      await user.keyboard("{ArrowLeft}");
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(250);

      await user.keyboard("{ArrowRight}");
      expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(240);
    });

    it("§4b — side-by-side overlay docks on the right edge, and content padding-right reflects open/closed state", async () => {
      const { container, rerender } = render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
      expect(overlay.style.right).toBe("0px");
      expect(overlay.style.left).toBe("");
      expect(overlay.style.width).toBe("var(--list-pane-w, 240px)");
      expect(overlay.style.borderLeft).toBe("var(--border-width) solid var(--border-default)");
      expect(overlay.style.borderRight).toBe("");

      const content = container.querySelector(".files-panel__content") as HTMLElement;
      const topbar = container.querySelector(".files-topbar") as HTMLElement;

      // Open state: content padded on the right by the panel width; no rail-based left padding.
      expect(content.style.paddingRight).toBe("var(--list-pane-w, 240px)");
      expect(content.style.paddingLeft).toBe("");
      expect(topbar.style.paddingLeft).toBe("");

      // Close panel
      act(() => {
        useWorkspaceStore.setState({ fileTreeVisible: false });
      });
      rerender(<FilesPanel api={api} worktreeId="wt-1" />);

      expect(content.style.paddingRight).toBe("0px");
      expect(topbar.style.paddingLeft).toBe("");
    });

    it("DOM order (R12): preview content precedes the list overlay", async () => {
      const { container } = render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");
      const content = container.querySelector(".files-panel__content") as HTMLElement;
      const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
      expect(content.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    describe("<=768px (phone)", () => {
      const rect = (w: number, h: number) =>
        ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

      function mockPhone(paneW: number | null, paneH = 404) {
        vi.spyOn(window, "matchMedia").mockImplementation(
          (query: string) =>
            ({
              matches: query.includes("max-width: 768px"),
              media: query,
              addEventListener: () => {},
              removeEventListener: () => {},
              addListener: () => {},
              removeListener: () => {},
              dispatchEvent: () => false,
              onchange: null,
            }) as MediaQueryList,
        );
        const real = HTMLElement.prototype.getBoundingClientRect;
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
          return this.classList.contains("files-panel") && paneW != null ? rect(paneW, paneH) : real.call(this);
        });
        if (!Element.prototype.setPointerCapture) {
          (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
        }
      }

      afterEach(() => {
        vi.restoreAllMocks();
        useWorkspaceStore.setState({
          filesLeftPaneWidthByWorktree: {},
          filesLeftPaneHeightByWorktree: {},
          layoutByWorktree: {},
        });
      });

      it("nothing stored: list full height right of the content column (tab bar over preview), half the pane, handle present", async () => {
        mockPhone(345);
        const { container } = render(<FilesPanel api={api} worktreeId="wt-1" />);
        await screen.findByText("README.md");

        const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
        const panel = container.querySelector(".files-panel") as HTMLElement;
        expect(overlay.style.top).toBe("0px");
        expect(overlay.style.bottom).toBe("0px");
        expect(overlay.style.right).toBe("0px");
        expect(overlay.style.left).toBe("");
        expect(overlay.style.width).toBe("var(--list-pane-w, 240px)");
        expect(panel.style.getPropertyValue("--list-pane-w")).toBe("173px");
        expect(screen.getByRole("separator", { name: "Resize files side panel" })).toHaveAttribute("aria-valuenow", "173");
        // The handle sits on the full-height list's left edge, so it spans the tab-bar row too.
        expect(overlay.contains(screen.getByRole("separator", { name: "Resize files side panel" }))).toBe(true);

        const content = container.querySelector(".files-panel__content") as HTMLElement;
        // Same as desktop: the content column (tab bar + preview) is padded by the list width.
        expect(content.style.paddingRight).toBe("var(--list-pane-w, 240px)");
        const previewWrap = content.querySelector(":scope > div:last-child") as HTMLElement;
        expect(previewWrap.style.paddingRight).toBe("");
        // The tab bar lives inside the content column, not under/over the overlay; it precedes it.
        const topbar = container.querySelector(".files-topbar") as HTMLElement;
        expect(content.contains(topbar)).toBe(true);
        expect(overlay.contains(topbar)).toBe(false);
        expect(topbar.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(content.style.paddingTop).toBe("0px");
      });

      it("stored 333: capped so the content column keeps 144px; the store is not written without a drag", async () => {
        mockPhone(345);
        useWorkspaceStore.setState({ filesLeftPaneWidthByWorktree: { "wt-1": 333 } });
        const { container } = render(<FilesPanel api={api} worktreeId="wt-1" />);
        await screen.findByText("README.md");
        expect((container.querySelector(".files-panel") as HTMLElement).style.getPropertyValue("--list-pane-w")).toBe(
          "201px",
        );
        expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(333);
      });

      it("dragging left is clamped to the cap (201) and ArrowLeft at the cap stays there", async () => {
        const user = userEvent.setup();
        mockPhone(345);
        useWorkspaceStore.setState({ filesLeftPaneWidthByWorktree: { "wt-1": 333 } });
        render(<FilesPanel api={api} worktreeId="wt-1" />);
        await screen.findByText("README.md");
        const handle = screen.getByRole("separator", { name: "Resize files side panel" });
        act(() => {
          handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true, clientX: 300 }));
        });
        act(() => {
          window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, bubbles: true, clientX: 100 }));
        });
        act(() => {
          window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true, clientX: 100 }));
        });
        expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(201);
        handle.focus();
        await user.keyboard("{ArrowLeft}");
        expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(201);
      });

      it("dragging right shrinks the list from its SHOWN size (173), not the stored default", async () => {
        mockPhone(345);
        render(<FilesPanel api={api} worktreeId="wt-1" />);
        await screen.findByText("README.md");
        const handle = screen.getByRole("separator", { name: "Resize files side panel" });
        act(() => {
          handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true, clientX: 170 }));
        });
        act(() => {
          window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, bubbles: true, clientX: 190 }));
        });
        act(() => {
          window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true, clientX: 190 }));
        });
        // Starts from the shown 173 (not the stored default 240): 173 - 20 = 153, clamped up to the 160 minimum.
        expect(useWorkspaceStore.getState().filesLeftPaneWidthByWorktree["wt-1"]).toBe(160);
      });

      it("clicking a tree file adds the tab and keeps the list open", async () => {
        const user = userEvent.setup();
        mockPhone(345);
        const { container } = render(<FilesPanel api={api} worktreeId="wt-1" />);
        await user.click(await screen.findByText("README.md"));
        expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
        expect(useWorkspaceStore.getState().openFileTabsByWorktree["wt-1"]).toContain("README.md");
        expect((container.querySelector(".files-left-pane-overlay") as HTMLElement).style.display).toBe("flex");
      });

      it("stacked: top overlay, default height min(240, (404-35)/2) = 185, stored 600 capped to 273", async () => {
        mockPhone(345, 404);
        useWorkspaceStore.setState({
          layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, masterDetailVertical: true } },
        });
        const { container, unmount } = render(<FilesPanel api={api} worktreeId="wt-1" />);
        await screen.findByText("README.md");
        const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
        const panel = container.querySelector(".files-panel") as HTMLElement;
        expect(overlay.style.top).toBe("0px");
        expect(panel.style.getPropertyValue("--list-pane-h")).toBe("185px");
        unmount();

        useWorkspaceStore.setState({ filesLeftPaneHeightByWorktree: { "wt-1": 600 } });
        const second = render(<FilesPanel api={api} worktreeId="wt-1" />);
        await screen.findByText("README.md");
        expect(
          (second.container.querySelector(".files-panel") as HTMLElement).style.getPropertyValue("--list-pane-h"),
        ).toBe("273px");
      });

      it("a pane without layout (zero rect) applies no phone clamp: the stored/default size is used as is", async () => {
        mockPhone(null);
        const { container } = render(<FilesPanel api={api} worktreeId="wt-1" />);
        await screen.findByText("README.md");
        const panel = container.querySelector(".files-panel") as HTMLElement;
        expect(panel.style.getPropertyValue("--list-pane-w")).toBe("240px");
        expect(panel.style.getPropertyValue("--list-pane-h")).toBe("240px");
      });
    });

    describe("mobileListSize", () => {
      const w = { min: 160, floor: 120, minPreview: 144, def: 240 };
      it("390-class pane: half by default, capped when stored", () => {
        expect(mobileListSize(240, true, 345, w)).toBe(173);
        expect(mobileListSize(333, false, 345, w)).toBe(201);
      });
      it("360-class pane: the 160 minimum wins over half (155 left for the content)", () => {
        expect(mobileListSize(240, true, 315, w)).toBe(160);
      });
      it("768-class pane: default 240", () => {
        expect(mobileListSize(240, true, 724, w)).toBe(240);
      });
      it("tiny pane: floors at 120", () => {
        expect(mobileListSize(240, true, 190, w)).toBe(120);
        expect(mobileListSize(300, false, 190, w)).toBe(120);
      });
    });

    it("stacked orientation: sets top overlay, height handle, and padding-top on content", async () => {
      useWorkspaceStore.setState({
        layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, masterDetailVertical: true } },
      });
      const { container } = render(<FilesPanel api={api} worktreeId="wt-1" />);
      await screen.findByText("README.md");

      const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
      expect(overlay.style.left).toBe("0px");
      expect(overlay.style.right).toBe("0px");
      expect(overlay.style.height).toBe("var(--list-pane-h, 240px)");
      expect(overlay.style.borderBottom).toBe("var(--border-width) solid var(--border-default)");
      expect(overlay.style.borderRight).toBe("");

      const handle = screen.getByRole("separator", { name: "Resize files top panel" });
      expect(handle).toHaveAttribute("aria-orientation", "horizontal");
      expect(handle).toHaveAttribute("aria-valuenow", "240");

      const content = container.querySelector(".files-panel__content") as HTMLElement;
      const topbar = container.querySelector(".files-topbar") as HTMLElement;

      expect(content.style.paddingRight).toBe("0px");
      expect(content.style.paddingTop).toBe("var(--list-pane-h, 240px)");
      expect(topbar.style.paddingLeft).toBe("");
      // The topbar reserves no right padding: the actions host lives in-flow.
      expect(topbar.style.paddingRight).toBe("");
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
