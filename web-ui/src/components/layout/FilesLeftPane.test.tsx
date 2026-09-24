import React, { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FilesLeftPane, type FilesLeftPaneHandle } from "./FilesLeftPane";
import { useWorkspaceStore } from "@/hooks/useStore";
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
});
