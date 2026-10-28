import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolsRailColumn } from "./ToolsRailColumn";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";

const WT = "wt-1";

function setLayout(extra: Partial<typeof DEFAULT_WORKTREE_LAYOUT> = {}) {
  act(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: WT,
      activeDirectContextId: null,
      filesLeftPaneMode: {},
      fileTreeVisible: true,
      workspacePaneFullscreen: null,
      vcsSelectedCommitByWorktree: {},
      vcsSidebarVisibleByWorktree: {},
      layoutByWorktree: {
        [WT]: { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files", toolPanelVisible: true, ...extra },
      },
    });
  });
}

function renderRail() {
  return render(<ToolsRailColumn contextId={WT} />);
}

describe("ToolsRailColumn", () => {
  beforeEach(() => setLayout());

  it("2.T1 — the head cell comes first as an empty aria-hidden spacer with the drag region; the rail icons follow", () => {
    const { container } = renderRail();
    const root = container.querySelector(".tools-rail") as HTMLElement;
    const head = root.firstElementChild as HTMLElement;
    expect(head).toHaveClass("tools-rail__head");
    expect(head).not.toHaveClass("tools-corner");
    expect(head).toHaveAttribute("aria-hidden", "true");
    expect(head).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(head.querySelector("button")).toBeNull();
    expect(head.textContent).toBe("");
    // The toggle lives in the actions chip rendered by Layout, never in the rail.
    expect(screen.queryByRole("button", { name: "Toggle tool panel" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")[0]).toHaveAccessibleName("Switch to file tree");
    expect(screen.getByRole("toolbar", { name: "Tools rail" })).toHaveAttribute("aria-orientation", "vertical");
  });

  it("2.T1 — an icon click switches the tool tab like FilesLeftRail", async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(screen.getByRole("button", { name: "Version Control" }));
    expect(useWorkspaceStore.getState().layoutByWorktree[WT]!.toolPanelTab).toBe("vcs");
  });

  describe("2.T1b — Esc from a rail button", () => {
    it("closes the open list first, then a second Esc exits tools fullscreen", async () => {
      const user = userEvent.setup();
      act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("tools"));
      renderRail();
      expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);

      const btn = screen.getByRole("button", { name: "Outline" });
      btn.focus();
      await user.keyboard("{Escape}");
      // First Esc closes the list pane (the stored open state flips), fullscreen stays.
      expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);
      expect(useWorkspaceStore.getState().workspacePaneFullscreen).toBe("tools");

      await user.keyboard("{Escape}");
      expect(useWorkspaceStore.getState().workspacePaneFullscreen).toBeNull();
    });
  });
});
