import { fireEvent, render } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";
import { useWorkspaceKeyboardShortcuts } from "./useWorkspaceKeyboardShortcuts";

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
