import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { FilesLeftRail } from "./FilesLeftRail";
import { useWorkspaceStore } from "@/hooks/useStore";

const WT = "wt-1";

describe("FilesLeftRail", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: WT,
      filesLeftPaneMode: {},
      layoutByWorktree: {},
    });
  });

  it("clicking the search icon calls setFilesLeftPaneMode(wt, 'search')", async () => {
    const user = userEvent.setup();
    render(<FilesLeftRail worktreeId={WT} />);

    await user.click(screen.getByRole("button", { name: "Search files" }));

    expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("search");
  });

  it("clicking the tree icon calls setFilesLeftPaneMode(wt, 'tree')", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ filesLeftPaneMode: { [WT]: "search" } });
    render(<FilesLeftRail worktreeId={WT} />);

    await user.click(screen.getByRole("button", { name: "Switch to file tree" }));

    expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("tree");
  });

  it("active mode's icon has aria-pressed=true; inactive mode's is false", () => {
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

  it("B3 — clicking the search icon while the tree is collapsed shows the tree pane so search renders", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ fileTreeVisible: false });
    render(<FilesLeftRail worktreeId={WT} />);

    await user.click(screen.getByRole("button", { name: "Search files" }));

    // The search body lives inside the shell's left pane, which is unmounted
    // when the tree is collapsed — switching to search must make it visible.
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
    expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("search");
  });

  it("B3 — clicking the tree icon while the tree is collapsed also shows the tree pane", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ fileTreeVisible: false, filesLeftPaneMode: { [WT]: "search" } });
    render(<FilesLeftRail worktreeId={WT} />);

    await user.click(screen.getByRole("button", { name: "Switch to file tree" }));

    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
    expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("tree");
  });

  it("5.10: clicking the references icon calls setFilesLeftPaneMode(wt, 'references')", async () => {
    const user = userEvent.setup();
    render(<FilesLeftRail worktreeId={WT} />);

    await user.click(screen.getByRole("button", { name: "References" }));

    expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("references");
    expect(screen.getByRole("button", { name: "References" })).toHaveAttribute("aria-pressed", "true");
  });

  it("6.8: clicking the outline icon calls setFilesLeftPaneMode(wt, 'outline')", async () => {
    const user = userEvent.setup();
    render(<FilesLeftRail worktreeId={WT} />);

    await user.click(screen.getByRole("button", { name: "Outline" }));

    expect(useWorkspaceStore.getState().filesLeftPaneMode[WT]).toBe("outline");
    expect(screen.getByRole("button", { name: "Outline" })).toHaveAttribute("aria-pressed", "true");
  });
});
