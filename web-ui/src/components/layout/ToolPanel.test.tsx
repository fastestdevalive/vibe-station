import { act, render, screen } from "@testing-library/react";
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

  it("R1 — does not render a horizontal tab strip", () => {
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    expect(screen.queryByRole("tablist", { name: "Tools" })).not.toBeInTheDocument();
  });

  it("§3.b, §3.d — renders vertical tool rail with disabled Devices/Artifacts and working VCS", async () => {
    const user = userEvent.setup();
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);

    const devices = screen.getByRole("button", { name: "Devices (coming soon)" });
    expect(devices).toBeDisabled();

    const artifacts = screen.getByRole("button", { name: "Artifacts (coming soon)" });
    expect(artifacts).toBeDisabled();

    // Clicking VCS switches active tool
    const vcs = screen.getByRole("button", { name: "Version Control" });
    await user.click(vcs);
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.toolPanelTab).toBe("vcs");
  });

  it("R6 — renders relocated ToolFullscreenButton", () => {
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    expect(screen.getByRole("button", { name: /fullscreen/i })).toBeInTheDocument();
  });

  it("§4b — tool-panel__body has zero padding for files tab and 36px padding for VCS tab", async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);

    const body = container.querySelector(".tool-panel__body") as HTMLElement;
    // On files tab: zero padding (file preview draws underneath rail)
    expect(body.style.paddingLeft).toBe("0px");

    // Switch to VCS tab
    const vcs = screen.getByRole("button", { name: "Version Control" });
    await user.click(vcs);

    // On VCS tab: 36px padding so rail icons don't overlap commit list
    expect(body.style.paddingLeft).toBe("36px");
  });

  it("§4a — sets --tools-rail-panel-w according to persisted filesLeftPaneWidthByWorktree", () => {
    useWorkspaceStore.setState({
      filesLeftPaneWidthByWorktree: { "wt-1": 320 },
    });
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    const panel = container.querySelector(".tool-panel") as HTMLElement;
    expect(panel.style.getPropertyValue("--tools-rail-panel-w")).toBe("320px");
  });

  it("§3.f — renders split-orientation toggle in top actions and toggles masterDetailVertical in store", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files", masterDetailVertical: false } },
    });
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);

    const toggleBtn = screen.getByRole("button", { name: "Switch to stacked layout" });
    expect(toggleBtn).toBeInTheDocument();

    await user.click(toggleBtn);
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.masterDetailVertical).toBe(true);

    expect(screen.getByRole("button", { name: "Switch to side-by-side layout" })).toBeInTheDocument();
  });

  it("sets --tools-rail-panel-h according to persisted filesLeftPaneHeightByWorktree", () => {
    useWorkspaceStore.setState({
      filesLeftPaneHeightByWorktree: { "wt-1": 350 },
    });
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    const panel = container.querySelector(".tool-panel") as HTMLElement;
    expect(panel.style.getPropertyValue("--tools-rail-panel-h")).toBe("350px");
  });

  it("R16 — Esc with focus INSIDE the tools pane closes the files panel", async () => {
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" } },
      fileTreeVisible: true,
    });
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    await screen.findByText("README.md");
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);

    // Esc fired on a descendant of the tools pane (bubbles to the container
    // listener). The listener is scoped to the pane, so Esc only closes the
    // panel when focus is actually inside it.
    act(() => {
      const pane = container.querySelector(".tool-panel") as HTMLElement;
      pane.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);
  });

  it("R16 — Esc with focus OUTSIDE the tools pane is NOT swallowed (terminal / dialog keep it)", async () => {
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" } },
      fileTreeVisible: true,
    });
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    await screen.findByText("README.md");
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);

    // Esc fired on document.body (the terminal's focus target) — the pane
    // listener is NOT on this path, so the panel must stay open. The old
    // window capture-phase listener swallowed Esc here, breaking the
    // terminal's Esc-to-interrupt and Quick Open's own Esc handler.
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
  });

  it("R16 — a second Esc (panel already closed) exits tools-pane fullscreen", async () => {
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" } },
      fileTreeVisible: false,
      workspacePaneFullscreen: "tools",
    });
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    await screen.findByText("README.md");
    expect(useWorkspaceStore.getState().workspacePaneFullscreen).toBe("tools");

    act(() => {
      const pane = container.querySelector(".tool-panel") as HTMLElement;
      pane.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useWorkspaceStore.getState().workspacePaneFullscreen).toBeNull();
  });

  it("rail wrapper is a flex container sized to fill so the rail stretches full height", () => {
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    const rail = container.querySelector(".files-left-rail") as HTMLElement;
    expect(rail).not.toBeNull();
    const wrapper = rail?.parentElement;
    // The absolute wrapper hosting the rail must be a flex column sized
    // top:0/bottom:0 so the rail (flex:1) stretches to the pane's full height
    // instead of stopping at its icon content (the rail-full-height bug).
    const wrapperStyle = wrapper?.style;
    expect(wrapperStyle?.position).toBe("absolute");
    expect(wrapperStyle?.top).toBe("0px");
    expect(wrapperStyle?.bottom).toBe("0px");
    expect(wrapperStyle?.display).toBe("flex");
    expect(wrapperStyle?.flexDirection).toBe("column");
  });
});
