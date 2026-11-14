import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { useWorkspaceStore } from "@/hooks/useStore";
import { makeComment } from "@/components/comments/testFixtures";
import { useCommentStore } from "@/components/comments/useCommentStore";
import { useDetailsStore } from "@/components/details/detailsStore";

describe("FileTreeSidebar", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      activeFilePath: null,
      peekFile: null,
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

  it("R1F-04: an absolute (outside-repo) active path expands nothing and fetches only the root", async () => {
    const spy = vi.spyOn(api, "tree");
    spy.mockClear();
    useWorkspaceStore.setState({ activeFilePath: "/tmp/vst-av/plan.md" });
    render(<FileTreeSidebar api={api} />);
    await screen.findByText("README.md");
    expect(spy.mock.calls.map((c) => c[1])).toEqual([""]);
    spy.mockRestore();
  });

  it("R1F-04: a failing dir fetch is swallowed and other dirs still load", async () => {
    const real = api.tree.bind(api);
    const treeSpy = vi.spyOn(api, "tree").mockImplementation((wt, p, scope) =>
      p === "src" ? Promise.reject(new Error("404")) : real(wt, p, scope),
    );
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    useWorkspaceStore.setState({ activeFilePath: "src/App.tsx" });
    render(<FileTreeSidebar api={api} />);
    await screen.findByText("README.md");
    // The failing fetch actually happened (src is expanded for the active file); let its rejection settle.
    await waitFor(() => expect(treeSpy).toHaveBeenCalledWith("wt-1", "src", "worktree"));
    await act(async () => {});
    process.off("unhandledRejection", onRej);
    treeSpy.mockRestore();
    expect(rejections).toEqual([]);
  });

  it("clicking file sets active file path", async () => {
    const user = userEvent.setup();
    render(<FileTreeSidebar api={api} />);
    await screen.findByText("README.md");
    await user.click(screen.getByText("README.md"));
    expect(useWorkspaceStore.getState().activeFilePath).toBe("README.md");
  });

  it("2.T6 — clicking a file while a peek is active records that peek onto backStack", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeFilePath: "src/App.tsx",
      peekFile: {
        worktreeId: "wt-1",
        path: "src/peek.ts",
        line: 10,
        matchText: null,
        source: "definition",
      },
      backStack: {},
      forwardStack: {},
    });

    render(<FileTreeSidebar api={api} />);
    await screen.findByText("README.md");
    await user.click(screen.getByText("README.md"));

    expect(useWorkspaceStore.getState().activeFilePath).toBe("README.md");
    expect(useWorkspaceStore.getState().peekFile).toBeNull();
    // Recorded the active peek onto backStack
    expect(useWorkspaceStore.getState().backStack["wt-1"]).toHaveLength(1);
    expect(useWorkspaceStore.getState().backStack["wt-1"]![0]).toEqual({
      kind: "peek",
      value: {
        worktreeId: "wt-1",
        path: "src/peek.ts",
        line: 10,
        matchText: null,
        source: "definition",
      },
    });
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
    // The header's compare-base dropdown (tools-pane-rework B3.3): "vs HEAD" (local) / "vs main" (branch).
    const scopeTrigger = () => screen.getByRole("button", { name: "Compare against" });
    async function pickScope(user: ReturnType<typeof userEvent.setup>, name: "vs HEAD" | "vs main") {
      await user.click(scopeTrigger());
      await user.click(screen.getByRole("menuitemradio", { name }));
    }

    it("renders the compare-base dropdown while browsing the plain tree (diff mode off)", async () => {
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");
      expect(scopeTrigger()).toHaveTextContent("vs HEAD");
    });

    it("keeps rendering the dropdown after switching to the flat Changes list", async () => {
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      await user.click(screen.getByRole("button", { name: "Changes view off" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Changes view on" })).toBeInTheDocument());
      expect(scopeTrigger()).toHaveTextContent("vs HEAD");
    });

    it("choosing 'vs main' while browsing the plain tree does NOT switch to the Changes list", async () => {
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      await pickScope(user, "vs main");
      // Still the plain tree, never flipped to the "Changes" list.
      expect(screen.getByRole("button", { name: "Changes view off" })).toBeInTheDocument();
      expect(screen.getByRole("treeitem", { name: "README.md" })).toBeInTheDocument();
      expect(scopeTrigger()).toHaveTextContent("vs main");
    });

    it("plain-tree badges reflect branch scope's changed-paths fetch when 'vs main' is selected", async () => {
      const spy = vi.spyOn(api, "listChangedPaths");
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      await pickScope(user, "vs main");
      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith("wt-1", "branch", undefined, "worktree");
      });
    });

    it("toggling diff mode carries the current scope across in both directions instead of resetting it", async () => {
      const user = userEvent.setup();
      render(<FileTreeSidebar api={api} />);
      await screen.findByText("README.md");

      // Select "vs main" while browsing the plain tree.
      await pickScope(user, "vs main");
      expect(useWorkspaceStore.getState().treeScopeByWorktree["wt-1"]).toBe("branch");

      // Toggle diff mode ON — the Changes list must open showing "vs main",
      // not silently revert to "vs HEAD".
      await user.click(screen.getByRole("button", { name: "Changes view off" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Changes view on" })).toBeInTheDocument());
      expect(useWorkspaceStore.getState().diffScopeByWorktree["wt-1"]).toBe("branch");
      expect(scopeTrigger()).toHaveTextContent("vs main");

      // Toggle diff mode OFF — the plain tree must still show "vs main".
      await user.click(screen.getByRole("button", { name: "Changes view on" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Changes view off" })).toBeInTheDocument());
      expect(useWorkspaceStore.getState().treeScopeByWorktree["wt-1"]).toBe("branch");
      expect(scopeTrigger()).toHaveTextContent("vs main");
    });
  });

  describe("project scope", () => {
    it("2.T10 — the local changed-paths fetch fires with fileScope='project'", async () => {
      const spy = vi
        .spyOn(api, "listChangedPaths")
        .mockResolvedValue([{ path: "file.rs", status: "M", insertions: 1, deletions: 0 }]);
      useWorkspaceStore.setState({ activeWorktreeId: null });
      render(<FileTreeSidebar api={api} contextId="proj-1" scope="project" />);
      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith("proj-1", "local", undefined, "project");
      });
      spy.mockRestore();
    });

    it("the diff-view toggle is shown (always-local, no branch/local chip) and switches to the changed-file list", async () => {
      const user = userEvent.setup();
      const spy = vi
        .spyOn(api, "listChangedPaths")
        .mockResolvedValue([{ path: "file.rs", status: "M", insertions: 1, deletions: 0 }]);
      useWorkspaceStore.setState({ activeWorktreeId: null });
      render(<FileTreeSidebar api={api} contextId="proj-1" scope="project" />);
      await screen.findByRole("button", { name: "Changes view off" });

      // Project scope is always local — no compare-base dropdown (the Files | Changes switch stays).
      expect(screen.queryByRole("button", { name: "Compare against" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute("aria-pressed", "true");

      await user.click(screen.getByRole("button", { name: "Changes view off" }));
      await screen.findByRole("button", { name: "Changes view on" });
      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith("proj-1", "local", undefined, "project");
      });
      expect(await screen.findByText("file.rs")).toBeInTheDocument();
      spy.mockRestore();
    });
  });

  describe("Changes list comment counts follow the list's own context (L4-01)", () => {
    const changed = [{ path: "file.rs", status: "M" as const, insertions: 1, deletions: 0 }];
    const seed = (scopeId: string, kind: "worktree" | "project", n: number) =>
      useCommentStore.getState().replace(scopeId, kind, {
        comments: Array.from({ length: n }, (_, i) => makeComment({ id: `${scopeId}-${i}`, pin: i + 1, path: "file.rs" })),
        nextPin: n + 1,
        terminalDeliveries: [],
      });

    beforeEach(() => useCommentStore.getState().reset());

    it("a project-scope sidebar (no active worktree) shows its project's counts", async () => {
      const user = userEvent.setup();
      vi.spyOn(api, "listChangedPaths").mockResolvedValue(changed);
      seed("proj-1", "project", 3);
      useWorkspaceStore.setState({ activeWorktreeId: null });
      render(<FileTreeSidebar api={api} contextId="proj-1" scope="project" />);
      await user.click(await screen.findByRole("button", { name: "Changes view off" }));
      expect(await screen.findByRole("img", { name: "3 comments" })).toBeInTheDocument();
    });

    it("a sidebar for worktree B shows B's counts, not the active worktree wt-1's", async () => {
      const user = userEvent.setup();
      vi.spyOn(api, "listChangedPaths").mockResolvedValue(changed);
      seed("wt-1", "worktree", 5);
      seed("wt-2", "worktree", 2);
      useWorkspaceStore.setState({ activeWorktreeId: "wt-1" });
      render(<FileTreeSidebar api={api} contextId="wt-2" />);
      await user.click(await screen.findByRole("button", { name: "Changes view off" }));
      expect(await screen.findByRole("img", { name: "2 comments" })).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "5 comments" })).not.toBeInTheDocument();
    });
  });

  it("a transient tree-refresh error keeps the last-known children of an expanded folder (L4-02)", async () => {
    const user = userEvent.setup();
    const real = api.tree.bind(api);
    let fail = false;
    const treeSpy = vi.spyOn(api, "tree").mockImplementation((wt, p, scope) => (fail && p === "src" ? Promise.reject(new Error("503")) : real(wt, p, scope)));
    render(<FileTreeSidebar api={api} />);
    await user.click(await screen.findByRole("treeitem", { name: "src" }));
    await screen.findByText("App.tsx");
    fail = true;
    const calls = treeSpy.mock.calls.length;
    act(() => api.__test.emit({ type: "tree:changed", worktreeId: "wt-1", path: "src", kind: "added" }));
    await waitFor(() => expect(treeSpy.mock.calls.length).toBeGreaterThan(calls));
    await act(async () => {});
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    treeSpy.mockRestore();
  });
});

describe("FileTreeSidebar row Details (tools-pane-rework B7.4)", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({ activeWorktreeId: "wt-1", activeFilePath: null, peekFile: null, diffScopeByWorktree: {}, treeScopeByWorktree: {} });
    useDetailsStore.setState({ target: null });
  });

  it("right-click on a file row offers Copy path, Copy relative path and Details; Details targets that row", async () => {
    render(<FileTreeSidebar api={api} />);
    const row = await screen.findByRole("treeitem", { name: "README.md" });
    fireEvent.contextMenu(row, { clientX: 1, clientY: 1 });
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy relative path" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(useDetailsStore.getState().target).toMatchObject({ scope: "worktree", scopeId: "wt-1", path: "README.md", name: "README.md" });
    expect(useDetailsStore.getState().target?.isDir).toBeFalsy();
  });

  it("right-click on a folder row offers the same items; its Details is a folder", async () => {
    render(<FileTreeSidebar api={api} />);
    const row = await screen.findByRole("treeitem", { name: "src" });
    fireEvent.contextMenu(row, { clientX: 1, clientY: 1 });
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy relative path" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(useDetailsStore.getState().target).toMatchObject({ path: "src", name: "src", isDir: true });
  });
});
