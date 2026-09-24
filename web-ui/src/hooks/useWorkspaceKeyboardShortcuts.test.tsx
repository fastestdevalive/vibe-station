import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";
import { DiffView } from "@/components/preview/DiffView";
import { useWorkspaceKeyboardShortcuts } from "./useWorkspaceKeyboardShortcuts";

const multiHunkDiff = [
  "@@ -1,1 +1,1 @@",
  "-old0",
  "+new0",
  "@@ -10,1 +10,1 @@",
  "-old1",
  "+new1",
].join("\n");

function Harness({ enabled = true }: { enabled?: boolean }) {
  useWorkspaceKeyboardShortcuts(() => {}, enabled, false, () => {}, () => {});
  return null;
}

describe("useWorkspaceKeyboardShortcuts", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: null,
      activeDirectContextId: "proj-1",
      layoutByWorktree: { "proj-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" } },
      filesLeftPaneMode: {},
      searchFocusSeq: {},
    });
  });

  it("3.T8 — Mod+Shift+F in a direct session (activeWorktreeId null) switches to search mode and requests focus", () => {
    render(<Harness />);

    fireEvent.keyDown(window, { key: "F", metaKey: true, shiftKey: true });

    const state = useWorkspaceStore.getState();
    // Keyed by activeDirectContextId (B5) — not a bare activeWorktreeId (null).
    expect(state.filesLeftPaneMode["proj-1"]).toBe("search");
    // Mod+Shift+F also opens the Files tab.
    expect(state.layoutByWorktree["proj-1"]!.toolPanelTab).toBe("files");
    // And requests the search query input be focused (B4c), keyed by the
    // same resolved context id — not a global counter (multi-tile canvas
    // correctness).
    expect(state.searchFocusSeq["proj-1"]).toBe(1);
  });

  it("3.T8/B3 — Mod+Shift+F while the file tree is collapsed makes the tree pane visible", () => {
    useWorkspaceStore.setState({ fileTreeVisible: false });
    render(<Harness />);

    fireEvent.keyDown(window, { key: "F", metaKey: true, shiftKey: true });

    const state = useWorkspaceStore.getState();
    // The search body lives inside the shell's left pane, unmounted while the
    // tree is collapsed — the shortcut must show it or the input won't mount.
    expect(state.fileTreeVisible).toBe(true);
    expect(state.filesLeftPaneMode["proj-1"]).toBe("search");
  });
});

describe("diff-view-shortcuts: Alt+D / Alt+Shift+D / Alt+H", () => {
  const WT = "wt-1";

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: WT,
      activeDirectContextId: null,
      activeFilePath: "/a.ts",
      diffScopeByWorktree: {},
      diffLayoutMode: "inline",
      layoutByWorktree: { [WT]: { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "vcs" } },
    });
  });

  it("2.T1 — Alt+D with an active worktree + file sets scope to local and switches to the Files tab", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { code: "KeyD", altKey: true });

    const state = useWorkspaceStore.getState();
    expect(state.diffScopeByWorktree[WT]).toBe("local");
    expect(state.layoutByWorktree[WT]!.toolPanelTab).toBe("files");
  });

  it("2.T2 — Alt+D with no active file is a no-op", () => {
    useWorkspaceStore.setState({ activeFilePath: null });
    render(<Harness />);
    fireEvent.keyDown(window, { code: "KeyD", altKey: true });

    expect(useWorkspaceStore.getState().diffScopeByWorktree).toEqual({});
  });

  it("2.T3 — Alt+D with neither an active worktree nor an active direct-session context is a no-op", () => {
    useWorkspaceStore.setState({ activeWorktreeId: null, activeDirectContextId: null });
    render(<Harness />);
    fireEvent.keyDown(window, { code: "KeyD", altKey: true });

    expect(useWorkspaceStore.getState().diffScopeByWorktree).toEqual({});
  });

  it("2.T3b — Alt+D in a direct/project-scoped session (activeWorktreeId null) resolves via activeDirectContextId, same pattern as Mod+Shift+F", () => {
    const PROJ = "proj-1";
    useWorkspaceStore.setState({ activeWorktreeId: null, activeDirectContextId: PROJ });
    render(<Harness />);
    fireEvent.keyDown(window, { code: "KeyD", altKey: true });

    const state = useWorkspaceStore.getState();
    expect(state.diffScopeByWorktree[PROJ]).toBe("local");
    expect(state.layoutByWorktree[PROJ]?.toolPanelTab).toBe("files");
  });

  it("2.T4 — multi-tile canvas: clicking into one of two interactive DiffViews resolves it via real focus, not a trivial single-instance fallback", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <Harness />
        <DiffView diffText={multiHunkDiff} interactive />
        <DiffView diffText={multiHunkDiff} interactive />
      </>,
    );
    const roots = container.querySelectorAll(".preview-diff-view");
    expect(roots).toHaveLength(2);

    // `fireEvent.click` does NOT move `document.activeElement` in jsdom — only
    // `userEvent.click` simulates the real browser default action of moving
    // focus to the nearest focusable ancestor (the `tabIndex={-1}` root).
    // With two instances registered and neither focused, `getActiveDiffView()`
    // would return null (Decision 2) — so this only passes if the click
    // actually resolved ONE specific instance, not a same-result fallback.
    await user.click(roots[0]!);

    fireEvent.keyDown(window, { code: "KeyD", altKey: true, shiftKey: true });

    expect(useWorkspaceStore.getState().diffLayoutMode).toBe("side-by-side");
  });

  it("2.T5 — Alt+H with no interactive DiffView mounted does not throw and changes no state", () => {
    render(<Harness />);
    expect(() => fireEvent.keyDown(window, { code: "KeyH", altKey: true })).not.toThrow();
    expect(useWorkspaceStore.getState().diffLayoutMode).toBe("inline");
  });

  it("2.T6 — regression: Alt+N still triggers onNewAgent (the new Alt+D/H branch is placed before it, not instead of it)", () => {
    const onNewAgent = vi.fn();
    function LocalHarness() {
      useWorkspaceKeyboardShortcuts(
        () => {},
        true,
        false,
        () => {},
        onNewAgent,
      );
      return null;
    }
    render(<LocalHarness />);
    fireEvent.keyDown(window, { altKey: true, code: "KeyN" });
    expect(onNewAgent).toHaveBeenCalledTimes(1);
  });

  it("2.T7 — a non-interactive DiffView never registers: Alt+D still works, Alt+Shift+D/Alt+H no-op", async () => {
    render(
      <>
        <Harness />
        <DiffView diffText={multiHunkDiff} />
      </>,
    );
    fireEvent.keyDown(window, { code: "KeyD", altKey: true });
    expect(useWorkspaceStore.getState().diffScopeByWorktree[WT]).toBe("local");

    const layoutBefore = useWorkspaceStore.getState().diffLayoutMode;
    fireEvent.keyDown(window, { code: "KeyH", altKey: true });
    fireEvent.keyDown(window, { code: "KeyD", altKey: true, shiftKey: true });
    expect(useWorkspaceStore.getState().diffLayoutMode).toBe(layoutBefore);
    await act(async () => {});
  });

  it("2.T8 — Rendered-mode diff: Alt+Shift+D/Alt+H no-op; Alt+D is unaffected", async () => {
    const user = userEvent.setup();
    const mdDiff = "@@ -1 +1,2 @@\n # Demo\n+added line\n";
    const { container } = render(
      <>
        <Harness />
        <DiffView
          diffText={mdDiff}
          filePath="README.md"
          fileContentFallback={"# Demo\n\nbody\n"}
          interactive
        />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Rendered" }));
    await user.click(container.querySelector(".preview-diff-view")!);

    const layoutBefore = useWorkspaceStore.getState().diffLayoutMode;
    fireEvent.keyDown(window, { code: "KeyD", altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { code: "KeyH", altKey: true });
    expect(useWorkspaceStore.getState().diffLayoutMode).toBe(layoutBefore);

    fireEvent.keyDown(window, { code: "KeyD", altKey: true });
    expect(useWorkspaceStore.getState().diffScopeByWorktree[WT]).toBe("local");
  });
});
