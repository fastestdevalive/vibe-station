import React, { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FilesLeftPane, type FilesLeftPaneHandle } from "./FilesLeftPane";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useArtifactsStore } from "@/components/artifacts/artifactsStore";
import { makeRow } from "@/components/artifacts/testFixtures";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import type { ApiInstance } from "@/api";

// Mock child panels
vi.mock("@/components/layout/FileTreeSidebar", () => ({
  FileTreeSidebar: () => <div data-testid="tree-sidebar" tabIndex={0}>Tree Content</div>,
}));

vi.mock("@/components/tools/SearchPanel", () => ({
  SearchPanel: () => <div data-testid="search-panel" tabIndex={0}>Search Content</div>,
}));

vi.mock("@/components/tools/ReferencesPanel", () => ({
  ReferencesPanel: () => <div data-testid="references-panel" tabIndex={0}>References Content</div>,
}));

vi.mock("@/components/tools/OutlinePanel", () => ({
  OutlinePanel: () => <div data-testid="outline-panel" tabIndex={0}>Outline Content</div>,
}));

const realOpenFileTabNew = useWorkspaceStore.getState().openFileTabNew;

describe("FilesLeftPane", () => {
  const W1 = "wt-1";

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: W1,
      filesLeftPaneMode: { [W1]: "references" },
    });
  });

  // 5.T7: focusActivePane in "references" mode focuses referencesContainerRef
  it("5.T7: focusActivePane() in 'references' mode focuses referencesContainerRef's content, not search or tree", () => {
    const ref = createRef<FilesLeftPaneHandle>();
    render(<FilesLeftPane ref={ref} api={{} as ApiInstance} worktreeId={W1} />);

    const refsEl = screen.getByTestId("references-panel");
    const searchEl = screen.getByTestId("search-panel");
    const treeEl = screen.getByTestId("tree-sidebar");

    // Invoke imperative focusActivePane()
    ref.current?.focusActivePane();

    expect(document.activeElement).toBe(refsEl);
    expect(document.activeElement).not.toBe(searchEl);
    expect(document.activeElement).not.toBe(treeEl);
  });

  // 6.8: focusActivePane in "outline" mode focuses outlineContainerRef
  it("6.8: focusActivePane() in 'outline' mode focuses outlineContainerRef's content, not search or tree", () => {
    useWorkspaceStore.setState({
      filesLeftPaneMode: { [W1]: "outline" },
    });

    const ref = createRef<FilesLeftPaneHandle>();
    render(<FilesLeftPane ref={ref} api={{} as ApiInstance} worktreeId={W1} />);

    const outlineEl = screen.getByTestId("outline-panel");
    const refsEl = screen.getByTestId("references-panel");
    const treeEl = screen.getByTestId("tree-sidebar");

    ref.current?.focusActivePane();

    expect(document.activeElement).toBe(outlineEl);
    expect(document.activeElement).not.toBe(refsEl);
    expect(document.activeElement).not.toBe(treeEl);
  });

  describe("artifacts body (8.T3)", () => {
    const api = {
      listArtifacts: vi.fn(async () => ({ rev: 1, cap: 500, total: 1, items: [] })),
      pinArtifact: vi.fn(),
      removeArtifact: vi.fn(),
    } as unknown as ApiInstance;

    beforeEach(() => {
      useArtifactsStore.getState().reset();
      useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: true });
      useArtifactsStore.getState().replace(W1, "worktree", {
        rev: 1,
        cap: 500,
        total: 1,
        items: [makeRow({ id: "old", writers: ["gone"], displayPath: "docs/old.md" })],
      });
    });

    it("stays mounted but hidden while another mode is active, and its state survives a mode switch", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "tree" } });
      const { container } = render(<FilesLeftPane api={api} worktreeId={W1} />);

      const pane = container.querySelector(".artifacts-pane") as HTMLElement;
      expect(pane).not.toBeNull();
      const body = pane.closest(".files-left-pane__body") as HTMLElement;
      expect(body).toHaveClass("files-left-pane__hidden");

      act(() => useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "artifacts" } }));
      expect(body).not.toHaveClass("files-left-pane__hidden");
      // Expand the collapsed-by-default "Earlier" group.
      await user.click(screen.getByRole("button", { name: /Earlier/ }));
      expect(screen.getByRole("button", { name: /Earlier/ })).toHaveAttribute("aria-expanded", "true");

      act(() => useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "tree" } }));
      expect(container.querySelector(".artifacts-pane")).toBe(pane); // same DOM node: never remounted
      act(() => useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "artifacts" } }));
      expect(screen.getByRole("button", { name: /Earlier/ })).toHaveAttribute("aria-expanded", "true");
    });

    it("fetches the artifacts list lazily: not while another mode is active, once when Artifacts is first shown (review 17)", () => {
      useArtifactsStore.getState().reset();
      const list = vi.fn(async () => ({ rev: 1, cap: 500, total: 0, items: [] }));
      const lazyApi = { ...api, listArtifacts: list } as unknown as ApiInstance;
      useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "tree" } });
      render(<FilesLeftPane api={lazyApi} worktreeId={W1} />);
      expect(list).not.toHaveBeenCalled();
      act(() => useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "artifacts" } }));
      expect(list).toHaveBeenCalledTimes(1);
      act(() => useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "tree" } }));
      act(() => useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "artifacts" } }));
      expect(list).toHaveBeenCalledTimes(1);
    });

    it("opening an in-repo row opens a tab by its repo-relative path; an outside-repo row by its ABSOLUTE path", async () => {
      const user = userEvent.setup();
      useArtifactsStore.getState().replace(W1, "worktree", {
        rev: 2,
        cap: 500,
        total: 2,
        items: [
          makeRow({ id: "in", writers: ["gone"], displayPath: "docs/in.md", path: "/repo/docs/in.md" }),
          makeRow({ id: "out", writers: ["gone"], inRepo: false, displayPath: "~/plans/out.md", path: "/home/u/plans/out.md" }),
        ],
      });
      useWorkspaceStore.setState({ filesLeftPaneMode: { [W1]: "artifacts" }, openFileTabsByWorktree: {}, activeFileTabIdxByWorktree: {} });
      const openSpy = vi.fn();
      useWorkspaceStore.setState({ openFileTabNew: openSpy });
      render(<FilesLeftPane api={api} worktreeId={W1} />);
      await user.click(screen.getByRole("button", { name: /Earlier/ }));
      await user.click(screen.getByText("in.md"));
      expect(openSpy).toHaveBeenLastCalledWith(W1, "docs/in.md");
      await user.click(screen.getByText("out.md"));
      expect(openSpy).toHaveBeenLastCalledWith(W1, "/home/u/plans/out.md");
    });

    it("phone side-by-side: opening a row does not close the list", async () => {
      const user = userEvent.setup();
      const realMatchMedia = window.matchMedia;
      window.matchMedia = ((q: string) => ({
        matches: q.includes("max-width: 768px"),
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      try {
        useArtifactsStore.getState().replace(W1, "worktree", {
          rev: 2,
          cap: 500,
          total: 1,
          items: [makeRow({ id: "in", writers: ["gone"], displayPath: "docs/in.md", path: "/repo/docs/in.md" })],
        });
        useWorkspaceStore.setState({
          filesLeftPaneMode: { [W1]: "artifacts" },
          fileTreeVisible: true,
          openFileTabsByWorktree: {},
          activeFileTabIdxByWorktree: {},
          openFileTabNew: realOpenFileTabNew, // an earlier test replaced it with a spy
        });
        render(<FilesLeftPane api={api} worktreeId={W1} />);
        await user.click(screen.getByRole("button", { name: /Earlier/ }));
        await user.click(screen.getByText("in.md"));
        expect(useWorkspaceStore.getState().openFileTabsByWorktree[W1]).toEqual(["docs/in.md"]);
        expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
        expect(useWorkspaceStore.getState().filesLeftPaneMode[W1]).toBe("artifacts");
      } finally {
        window.matchMedia = realMatchMedia;
      }
    });
  });
});
