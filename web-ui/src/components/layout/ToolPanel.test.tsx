import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { ToolPanel } from "./ToolPanel";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";

describe("ToolPanel", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeDirectContextId: null,
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "search" } },
      filesLeftPaneMode: {},
      fileTreeVisible: true,
    });
  });

  it("3.T5 — a persisted toolPanelTab==='search' renders the Files tab content and seeds filesLeftPaneMode to 'search'", async () => {
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);

    // The Files tab's tree content renders (not an empty/no-branch state).
    await screen.findByText("README.md");

    // Decision 9 migration: the persisted "search" tab seeds the Files rail
    // into search mode.
    expect(useWorkspaceStore.getState().filesLeftPaneMode["wt-1"]).toBe("search");
    // S-4: the migration is one-shot — it ALSO rewrites the persisted value to
    // "files" so the effect never re-runs/re-seeds on a later worktree switch.
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.toolPanelTab).toBe("files");
  });

  it("S-4 — the migration writes the persisted value, so a re-mount never re-seeds the rail", async () => {
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "search" } },
      filesLeftPaneMode: {},
    });
    const { unmount } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    await screen.findByText("README.md");
    // First mount migrates: persisted tab -> "files", rail -> "search".
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.toolPanelTab).toBe("files");
    expect(useWorkspaceStore.getState().filesLeftPaneMode["wt-1"]).toBe("search");

    // User picks tree mode, then the panel remounts (e.g. a worktree switch back).
    useWorkspaceStore.getState().setFilesLeftPaneMode("wt-1", "tree");
    unmount();
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    await screen.findByText("README.md");
    // Persisted tab is already "files" (not "search"), so the migration effect is
    // a no-op and the user's tree choice is NOT overridden back to search.
    expect(useWorkspaceStore.getState().filesLeftPaneMode["wt-1"]).toBe("tree");
  });

  it("does not render a Search tab in the tab strip", () => {
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    expect(screen.queryByRole("tab", { name: "Search" })).not.toBeInTheDocument();
  });

  // Live-review feedback — after two rejected homes (the rail, then the
  // Files tab's own tab-strip row), the layout-orientation toggle now lives
  // attached directly to the top-level "Files" tab button, as a separately
  // clickable icon on its right edge.
  describe("Layout-orientation toggle on the Files tab", () => {
    beforeEach(() => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        layoutByWorktree: {},
      });
    });

    it("renders inside the Files tab button and toggles masterDetailVertical without also switching tabs", async () => {
      useWorkspaceStore.setState({
        layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "vcs" } },
      });
      render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);

      const filesTab = screen.getByRole("tab", { name: /Files/ });
      const toggle = screen.getByRole("button", { name: "Switch to stacked layout" });
      // The toggle is a sibling *button* inside the same wrapping span as the
      // Files tab button — not nested inside it (buttons can't nest inside
      // buttons) and not a sibling elsewhere in the tab strip.
      expect(filesTab.parentElement?.contains(toggle)).toBe(true);
      expect(filesTab.contains(toggle)).toBe(false);

      await userEvent.setup().click(toggle);

      expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.masterDetailVertical).toBe(true);
      // Clicking the toggle must NOT also switch the active tool tab away
      // from whatever it was (VCS) — it's a separately-clickable action.
      expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.toolPanelTab).toBe("vcs");
    });

    it("icon reflects current orientation and flips after clicking", async () => {
      const user = userEvent.setup();
      render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);

      expect(screen.getByRole("button", { name: "Switch to stacked layout" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Switch to stacked layout" }));
      expect(screen.getByRole("button", { name: "Switch to side-by-side layout" })).toBeInTheDocument();
    });
  });
});
