import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { FilesLeftRail } from "./FilesLeftRail";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";

const WT = "wt-1";

describe("FilesLeftRail", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: WT,
      filesLeftPaneMode: {},
      fileTreeVisible: true,
      vcsSelectedCommitByWorktree: {},
      vcsSidebarVisibleByWorktree: {},
      layoutByWorktree: {
        [WT]: { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" },
      },
    });
  });

  describe("Rail structure and order (§3.a, §3.b)", () => {
    it("renders Tree, Search, Outline, References on top, divider, then Devices, Artifacts, VCS below", () => {
      render(<FilesLeftRail worktreeId={WT} />);

      // No standalone "Files" button
      expect(screen.queryByRole("button", { name: /^Files$/i })).not.toBeInTheDocument();

      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(7);
      expect(buttons[0]).toHaveAccessibleName("Switch to file tree");
      expect(buttons[1]).toHaveAccessibleName("Search files");
      expect(buttons[2]).toHaveAccessibleName("Outline");
      expect(buttons[3]).toHaveAccessibleName("References");
      expect(buttons[4]).toHaveAccessibleName("Devices (coming soon)");
      expect(buttons[5]).toHaveAccessibleName("Artifacts (coming soon)");
      expect(buttons[6]).toHaveAccessibleName("Version Control");

      expect(screen.getByRole("separator")).toBeInTheDocument();
    });

    it("Devices and Artifacts are disabled and not clickable", async () => {
      const user = userEvent.setup();
      render(<FilesLeftRail worktreeId={WT} />);

      const devicesBtn = screen.getByRole("button", { name: "Devices (coming soon)" });
      const artifactsBtn = screen.getByRole("button", { name: "Artifacts (coming soon)" });

      expect(devicesBtn).toBeDisabled();
      expect(artifactsBtn).toBeDisabled();

      await user.click(devicesBtn);
      expect(useWorkspaceStore.getState().layoutByWorktree[WT]?.toolPanelTab).toBe("files");

      await user.click(artifactsBtn);
      expect(useWorkspaceStore.getState().layoutByWorktree[WT]?.toolPanelTab).toBe("files");
    });

    it("clicking VCS switches the active tool to vcs", async () => {
      const user = userEvent.setup();
      render(<FilesLeftRail worktreeId={WT} />);

      const vcsBtn = screen.getByRole("button", { name: "Version Control" });
      await user.click(vcsBtn);

      expect(useWorkspaceStore.getState().layoutByWorktree[WT]?.toolPanelTab).toBe("vcs");
      expect(vcsBtn).toHaveAttribute("aria-pressed", "true");
    });

    it("VCS icon becomes a sidebar toggle once a commit is open (State B ↔ C)", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        layoutByWorktree: {
          [WT]: { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "vcs" },
        },
        vcsSelectedCommitByWorktree: { [WT]: "abc1234def" },
        vcsSidebarVisibleByWorktree: { [WT]: true },
      });
      render(<FilesLeftRail worktreeId={WT} />);

      const vcsBtn = screen.getByRole("button", { name: "Toggle changed files" });
      // Sidebar visible (State B) → pressed
      expect(vcsBtn).toHaveAttribute("aria-pressed", "true");

      // Tap again → closes the changed-file sidebar (State C), still on VCS.
      await user.click(vcsBtn);
      expect(useWorkspaceStore.getState().vcsSidebarVisibleByWorktree[WT]).toBe(false);
      expect(useWorkspaceStore.getState().layoutByWorktree[WT]?.toolPanelTab).toBe("vcs");

      // Tap again → re-opens the sidebar (back to State B).
      await user.click(vcsBtn);
      expect(useWorkspaceStore.getState().vcsSidebarVisibleByWorktree[WT]).toBe(true);
    });

    it("VCS icon is a plain no-op radio in State A (no commit open)", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        layoutByWorktree: {
          [WT]: { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "vcs" },
        },
        vcsSelectedCommitByWorktree: { [WT]: null },
      });
      render(<FilesLeftRail worktreeId={WT} />);

      const vcsBtn = screen.getByRole("button", { name: "Version Control" });
      expect(vcsBtn).toHaveAttribute("aria-pressed", "true");

      // Tapping again in State A is a no-op — stays on VCS, sidebar concept unused.
      await user.click(vcsBtn);
      expect(useWorkspaceStore.getState().layoutByWorktree[WT]?.toolPanelTab).toBe("vcs");
      expect(useWorkspaceStore.getState().vcsSidebarVisibleByWorktree[WT]).toBeUndefined();
    });
  });

  describe("Files modes and click behavior (§3.c)", () => {
    it("clicking search icon calls setFilesLeftPaneMode(wt, 'search')", async () => {
      const user = userEvent.setup();
      render(<FilesLeftRail worktreeId={WT} />);

      await user.click(screen.getByRole("button", { name: "Search files" }));

      expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("search");
    });

    it("clicking tree icon calls setFilesLeftPaneMode(wt, 'tree')", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({ filesLeftPaneMode: { [WT]: "search" } });
      render(<FilesLeftRail worktreeId={WT} />);

      await user.click(screen.getByRole("button", { name: "Switch to file tree" }));

      expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("tree");
    });

    it("active mode icon has aria-pressed=true; inactive mode is false", () => {
      useWorkspaceStore.setState({ filesLeftPaneMode: { [WT]: "search" } });
      render(<FilesLeftRail worktreeId={WT} />);

      expect(screen.getByRole("button", { name: "Search files" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Switch to file tree" })).toHaveAttribute("aria-pressed", "false");
    });

    it("defaults to tree mode when the worktree has no entry", () => {
      render(<FilesLeftRail worktreeId={WT} />);

      expect(screen.getByRole("button", { name: "Switch to file tree" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Search files" })).toHaveAttribute("aria-pressed", "false");
    });

    it("press-active-icon-again-to-close closes the expanded panel", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({ fileTreeVisible: true, filesLeftPaneMode: { [WT]: "tree" } });
      render(<FilesLeftRail worktreeId={WT} />);

      const treeBtn = screen.getByRole("button", { name: "Switch to file tree" });
      expect(treeBtn).toHaveAttribute("aria-pressed", "true");

      await user.click(treeBtn);
      expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);
    });

    it("mode icons remain visible when panel is closed, and the current mode stays highlighted (Files tool is still active)", () => {
      useWorkspaceStore.setState({ fileTreeVisible: false, filesLeftPaneMode: { [WT]: "tree" } });
      render(<FilesLeftRail worktreeId={WT} />);

      const treeBtn = screen.getByRole("button", { name: "Switch to file tree" });
      const searchBtn = screen.getByRole("button", { name: "Search files" });

      expect(treeBtn).toBeInTheDocument();
      expect(searchBtn).toBeInTheDocument();
      // The Files tool is active (tab = files), so its current mode stays
      // highlighted even with the panel collapsed — clicking it re-opens in
      // that mode. Inactive modes stay unpressed.
      expect(treeBtn).toHaveAttribute("aria-pressed", "true");
      expect(searchBtn).toHaveAttribute("aria-pressed", "false");
    });

    it("clicking a mode icon while the panel is closed opens it", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({ fileTreeVisible: false });
      render(<FilesLeftRail worktreeId={WT} />);

      await user.click(screen.getByRole("button", { name: "Search files" }));

      expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
      expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("search");
    });

    it("clicking Tree/Search/Outline/References when VCS is active switches back to files and opens that mode", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        fileTreeVisible: false,
        layoutByWorktree: {
          [WT]: { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "vcs" },
        },
      });
      render(<FilesLeftRail worktreeId={WT} />);

      await user.click(screen.getByRole("button", { name: "Search files" }));

      expect(useWorkspaceStore.getState().layoutByWorktree[WT]?.toolPanelTab).toBe("files");
      expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
      expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("search");
    });

    it("clicking outline icon calls setFilesLeftPaneMode(wt, 'outline')", async () => {
      const user = userEvent.setup();
      render(<FilesLeftRail worktreeId={WT} />);

      await user.click(screen.getByRole("button", { name: "Outline" }));

      expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("outline");
      expect(screen.getByRole("button", { name: "Outline" })).toHaveAttribute("aria-pressed", "true");
    });

    it("clicking references icon calls setFilesLeftPaneMode(wt, 'references')", async () => {
      const user = userEvent.setup();
      render(<FilesLeftRail worktreeId={WT} />);

      await user.click(screen.getByRole("button", { name: "References" }));

      expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("references");
      expect(screen.getByRole("button", { name: "References" })).toHaveAttribute("aria-pressed", "true");
    });
  });
});
