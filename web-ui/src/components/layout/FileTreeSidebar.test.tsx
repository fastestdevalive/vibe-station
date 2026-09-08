import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { useWorkspaceStore } from "@/hooks/useStore";

describe("FileTreeSidebar", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      showDotFiles: true,
      diffScopeByWorktree: {},
      treeScopeByWorktree: {},
    });
  });

  it("renders top-level entries from mock api", async () => {
    render(<FileTreeSidebar api={api} />);
    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });
  });

  it("folder chevron triggers api.tree for path", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "tree");
    render(<FileTreeSidebar api={api} />);
    await screen.findByText("src");
    await user.click(screen.getByRole("treeitem", { name: "src" }));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith("wt-1", "src", "worktree");
    });
  });

  it("clicking file sets active file path", async () => {
    const user = userEvent.setup();
    render(<FileTreeSidebar api={api} />);
    await screen.findByText("README.md");
    await user.click(screen.getByText("README.md"));
    expect(useWorkspaceStore.getState().activeFilePath).toBe("README.md");
  });

  describe("Phase 8 — arrow-key roving navigation", () => {
    it("expand a directory via ArrowRight, navigate into its children via ArrowDown, Enter opens the focused file", async () => {
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      const srcRow = screen.getByRole("treeitem", { name: "src" });
      // Click both focuses the row (roving cursor) AND toggles it open — that's
      // the pre-existing "clicking a dir row expands it" behavior. Click again
      // to collapse it back so ArrowRight below is what re-expands it, keeping
      // this test's actual claim (keyboard expand) distinct from mouse click.
      await user.click(srcRow);
      expect(srcRow).toHaveClass("tree-row--cursor");
      await screen.findByText("App.tsx");
      await user.click(srcRow);
      await waitFor(() => expect(screen.queryByText("App.tsx")).not.toBeInTheDocument());

      // ArrowRight expands the focused (still-cursored) directory.
      await user.keyboard("{ArrowRight}");
      await screen.findByText("App.tsx");

      // ArrowDown moves the cursor into the newly-revealed children.
      await user.keyboard("{ArrowDown}");
      const appRow = screen.getByRole("treeitem", { name: "App.tsx" });
      await waitFor(() => expect(appRow).toHaveClass("tree-row--cursor"));

      // Enter opens the focused file.
      await user.keyboard("{Enter}");
      expect(useWorkspaceStore.getState().activeFilePath).toBe("src/App.tsx");
    });

    it("the first row is tabbable (tabIndex 0) before any row has been clicked", async () => {
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      const rows = screen.getAllByRole("treeitem");
      expect(rows[0]).toHaveAttribute("tabIndex", "0");
      for (const row of rows.slice(1)) {
        expect(row).toHaveAttribute("tabIndex", "-1");
      }
    });

    it("Tab-focusing the first row then ArrowDown moves the cursor to the next row", async () => {
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      const rows = screen.getAllByRole("treeitem");
      act(() => rows[0]!.focus());
      expect(rows[0]).toHaveClass("tree-row--cursor");

      await user.keyboard("{ArrowDown}");
      await waitFor(() => expect(rows[1]).toHaveClass("tree-row--cursor"));
    });
  });

  describe("single scope selector — always visible in the Files header", () => {
    it("renders the local/branch chips while browsing the plain tree (diff mode off)", async () => {
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");
      expect(screen.getByText("Files")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "branch" })).toBeInTheDocument();
    });

    it("keeps rendering the same chips after switching to the flat Changes list", async () => {
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      await user.click(screen.getByRole("button", { name: "Diff view off" }));
      await waitFor(() => expect(screen.getByText("Changes")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "branch" })).toBeInTheDocument();
    });

    it("selecting 'branch' while browsing the plain tree does NOT switch to the Changes list", async () => {
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      await user.click(screen.getByRole("button", { name: "branch" }));
      // Still "Files" (plain tree), never flipped to "Changes".
      expect(screen.getByText("Files")).toBeInTheDocument();
      expect(screen.getByRole("treeitem", { name: "README.md" })).toBeInTheDocument();
    });

    it("plain-tree badges reflect branch scope's changed-paths fetch when 'branch' is selected", async () => {
      const spy = vi.spyOn(api, "listChangedPaths");
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      await user.click(screen.getByRole("button", { name: "branch" }));
      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith("wt-1", "branch");
      });
    });

    it("toggling diff mode carries the current scope across in both directions instead of resetting it", async () => {
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      // Select "branch" while browsing the plain tree.
      await user.click(screen.getByRole("button", { name: "branch" }));
      expect(useWorkspaceStore.getState().treeScopeByWorktree["wt-1"]).toBe("branch");

      // Toggle diff mode ON — the Changes list must open showing "branch",
      // not silently revert to "local".
      await user.click(screen.getByRole("button", { name: "Diff view off" }));
      await waitFor(() => expect(screen.getByText("Changes")).toBeInTheDocument());
      expect(useWorkspaceStore.getState().diffScopeByWorktree["wt-1"]).toBe("branch");
      expect(screen.getByRole("button", { name: "branch" })).toHaveAttribute("aria-pressed", "true");

      // Toggle diff mode OFF — the plain tree must still show "branch".
      await user.click(screen.getByRole("button", { name: "Diff view on" }));
      await waitFor(() => expect(screen.getByText("Files")).toBeInTheDocument());
      expect(useWorkspaceStore.getState().treeScopeByWorktree["wt-1"]).toBe("branch");
      expect(screen.getByRole("button", { name: "branch" })).toHaveAttribute("aria-pressed", "true");
    });
  });
});
