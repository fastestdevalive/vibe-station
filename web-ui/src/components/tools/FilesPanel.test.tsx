import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { FilesPanel } from "./FilesPanel";
import { useWorkspaceStore } from "@/hooks/useStore";

/** 10.T4 — regression: tree toggle / open-file tab / zoom controls behavior
 *  must be unchanged after the `MasterDetailShell` extraction. */
describe("FilesPanel (post-MasterDetailShell extraction)", () => {
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

  it("toggling the tree-visibility button hides the tree and shows preview-only", async () => {
    const user = userEvent.setup();
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("README.md");

    const toggle = screen.getByRole("button", { name: "Hide file tree" });
    await user.click(toggle);
    await waitFor(() => expect(screen.queryByText("README.md")).not.toBeInTheDocument());
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);

    await user.click(screen.getByRole("button", { name: "Show file tree" }));
    await screen.findByText("README.md");
  });

  it("opening a file shows the open-file tab with its name; closing it clears activeFilePath", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ activeWorktreeId: "wt-1", activeFilePath: "src/App.tsx" });
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    expect(await screen.findByText("App.tsx")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close App.tsx" }));
    expect(useWorkspaceStore.getState().activeFilePath).toBeNull();
  });

  it("zoom controls bump previewFontScale", async () => {
    const user = userEvent.setup();
    render(<FilesPanel api={api} worktreeId="wt-1" />);
    await screen.findByText("README.md");

    const before = useWorkspaceStore.getState().previewFontScale;
    await user.click(screen.getByRole("button", { name: "Increase preview font" }));
    expect(useWorkspaceStore.getState().previewFontScale).toBeGreaterThan(before);

    await user.click(screen.getByRole("button", { name: "Decrease preview font" }));
    expect(useWorkspaceStore.getState().previewFontScale).toBeCloseTo(before, 5);
  });
});
