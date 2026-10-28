import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WORKTREE_LAYOUT, effectiveToolTab, useWorkspaceStore, type ToolTab } from "@/hooks/useStore";
import { handleToolsEsc } from "./toolsEsc";

const esc = () => new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

describe("effectiveToolTab", () => {
  it.each<[ToolTab, ToolTab]>([
    ["files", "files"],
    ["vcs", "vcs"],
    ["search", "files"],
    ["devices", "files"],
    ["artifacts", "files"],
  ])("%s renders as %s", (tab, want) => {
    expect(effectiveToolTab(tab)).toBe(want);
  });
});

describe("handleToolsEsc resolves the layout of the PANEL's own context", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-A",
      activeDirectContextId: null,
      layoutByWorktree: {
        "wt-A": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "vcs" },
        "wt-B": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" },
      },
      filesLeftPaneMode: { "wt-A": "tree", "wt-B": "tree" },
      fileTreeVisible: true,
      workspacePaneFullscreen: null,
    });
  });

  it("Esc in a canvas tile of worktree B closes B's open list even though active A is on vcs", () => {
    handleToolsEsc(esc(), "wt-B");
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);
  });

  it("Esc for A (on vcs) does not close the Files list", () => {
    handleToolsEsc(esc(), "wt-A");
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(true);
  });

  it.each<ToolTab>(["search", "devices", "artifacts"])("a legacy %s tab in the panel's own layout counts as Files", (tab) => {
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-B": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: tab } },
    });
    handleToolsEsc(esc(), "wt-B");
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);
  });

  it("with no persisted layout the default tab (files) applies", () => {
    useWorkspaceStore.setState({ layoutByWorktree: {} });
    handleToolsEsc(esc(), "wt-B");
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);
  });
});
