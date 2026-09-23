import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MasterDetailShell } from "./MasterDetailShell";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";

const leftPane = <div>LEFT</div>;
const rightPane = <div>RIGHT</div>;

describe("MasterDetailShell", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      fileTreeVisible: true,
      activeWorktreeId: "wt-1",
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" } },
    });
  });

  // 3.T4 — Decision 8/B6: `layoutToggle` prop suppresses the shell's own
  // layout-toggle button for FilesPanel, while leaving it for VcsCommitView.
  it("renders the layout-toggle button by default (layoutToggle=true, VcsCommitView usage)", () => {
    render(<MasterDetailShell storageKey="k" worktreeId="wt-1" leftPane={leftPane} rightPane={rightPane} />);
    expect(screen.getByRole("button", { name: "Switch to stacked layout" })).toBeInTheDocument();
  });

  it("hides the layout-toggle button when layoutToggle=false (Files usage)", () => {
    render(
      <MasterDetailShell storageKey="k" worktreeId="wt-1" layoutToggle={false} leftPane={leftPane} rightPane={rightPane} />,
    );
    expect(screen.queryByRole("button", { name: "Switch to stacked layout" })).not.toBeInTheDocument();
  });

  it("still hides the layout-toggle button when treeVisible is false, even with layoutToggle=true", () => {
    useWorkspaceStore.setState({ fileTreeVisible: false });
    render(<MasterDetailShell storageKey="k" worktreeId="wt-1" leftPane={leftPane} rightPane={rightPane} />);
    expect(screen.queryByRole("button", { name: "Switch to stacked layout" })).not.toBeInTheDocument();
  });

  it("the layout-toggle button toggles masterDetailVertical in the store", async () => {
    const user = userEvent.setup();
    render(<MasterDetailShell storageKey="k" worktreeId="wt-1" leftPane={leftPane} rightPane={rightPane} />);
    await user.click(screen.getByRole("button", { name: "Switch to stacked layout" }));
    expect((useWorkspaceStore.getState().layoutByWorktree["wt-1"] ?? {}).masterDetailVertical).toBe(true);
  });

  // 3.T6 — B4a: with a `leftPaneFocusHandle`, pointer-down on the right pane
  // refocuses via the handle (scoped to the ACTIVE-mode pane) rather than a
  // generic querySelector that could match a display:none inactive pane's row.
  it("uses leftPaneFocusHandle.focusActivePane on right-pane pointer-down (B4a)", async () => {
    const focusActivePane = vi.fn();
    const handle = { current: { focusActivePane } };
    render(
      <MasterDetailShell
        storageKey="k"
        worktreeId="wt-1"
        leftPaneFocusHandle={handle as never}
        leftPane={leftPane}
        rightPane={rightPane}
      />,
    );

    fireEvent.pointerDown(screen.getByText("RIGHT"));
    await waitFor(() => expect(focusActivePane).toHaveBeenCalled());
  });
});
