import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { ToolPanel } from "./ToolPanel";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";
import { createTopActionsStore, TopActionsProvider } from "@/context/TopActionsContext";
import { TopActionsOwner } from "./TopActionsSlot";
import type { ComponentProps } from "react";

/** The ONE reserve span marked active by the registry (the row under the actions chip). */
const activeReserve = (root: ParentNode) => root.querySelector(".actions-host__reserve[data-active]");

/** Renders ToolPanel(s) under a registry provider with a `Search files` probe as the chip content. */
function renderHosted(
  panels: ComponentProps<typeof ToolPanel>[],
  zones: ("tools" | "agent" | "canvas")[] = ["tools"],
) {
  const store = createTopActionsStore();
  return render(
    <TopActionsProvider store={store}>
      {panels.map((p, i) => (
        <ToolPanel key={i} {...p} />
      ))}
      <TopActionsOwner zones={zones}>
        <button type="button" aria-label="Search files" data-testid="owner-probe">
          s
        </button>
      </TopActionsOwner>
    </TopActionsProvider>,
  );
}

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

  it("8.T2 — a persisted toolPanelTab 'artifacts' still folds into 'files' and renders no placeholder panel", async () => {
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "artifacts" } },
      filesLeftPaneMode: {},
    });
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    await screen.findByText("README.md");
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.toolPanelTab).toBe("files");
    // The old hard-coded sample rows / upload placeholder are gone.
    expect(container.querySelector(".artifacts-panel, .artifacts-upload")).toBeNull();
    expect(screen.queryByText(/drop files here|upload/i)).not.toBeInTheDocument();
  });

  it("R1 — does not render a horizontal tab strip", () => {
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    expect(screen.queryByRole("tablist", { name: "Tools" })).not.toBeInTheDocument();
  });

  it("§3.b — a desktop classic panel renders no rail (the rail is the window-level ToolsRailColumn)", () => {
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    expect(container.querySelector(".files-left-rail")).toBeNull();
    expect(container.querySelector(".tool-panel__tile-rail")).toBeNull();
    expect(container.querySelector("#tools-pane")).not.toBeNull();
  });

  describe("<=768px (phone)", () => {
    const realMatchMedia = window.matchMedia;
    beforeEach(() => {
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
    });
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });

    describe("pane controls host (listHostsPane)", () => {
      const filesLayout = (extra: Partial<typeof DEFAULT_WORKTREE_LAYOUT> = {}) => ({
        "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" as const, ...extra },
      });
      const toggleName = /Switch to (stacked|side-by-side) layout/;

      it("phone side-by-side, list open: the list header carries the layout toggle and Fullscreen; the Files bar has none", async () => {
        useWorkspaceStore.setState({
          activeWorktreeId: "wt-1",
          layoutByWorktree: filesLayout({ masterDetailVertical: false }),
          fileTreeVisible: true,
          filesLeftPaneMode: { "wt-1": "tree" },
        });
        const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
        await screen.findByText("README.md").catch(() => undefined);
        const bar = container.querySelector(".files-topbar") as HTMLElement;
        const header = container.querySelector(".file-tree-sidebar-header") as HTMLElement;
        const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
        expect(overlay.contains(header)).toBe(true);
        expect(header.contains(screen.getByLabelText("Switch to stacked layout"))).toBe(true);
        expect(header.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(true);
        expect(bar.querySelector(".tab--icon")).toBeNull();
        expect(screen.getAllByLabelText(toggleName)).toHaveLength(1);
      });

      it("phone side-by-side, list closed: the controls are back in the Files bar", () => {
        useWorkspaceStore.setState({
          activeWorktreeId: "wt-1",
          layoutByWorktree: filesLayout({ masterDetailVertical: false }),
          fileTreeVisible: false,
        });
        const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
        const bar = container.querySelector(".files-topbar") as HTMLElement;
        expect(bar.contains(screen.getByLabelText("Switch to stacked layout"))).toBe(true);
        expect(bar.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(true);
      });

      it("phone, VCS commit open: the changed-file list header carries the controls; the bar has none", async () => {
        useWorkspaceStore.setState({
          activeWorktreeId: "wt-1",
          layoutByWorktree: filesLayout({ toolPanelTab: "vcs" as const, masterDetailVertical: false }),
          vcsSelectedCommitByWorktree: { "wt-1": { sha: "abc1234" } },
        } as never);
        const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
        await screen.findByText("abc1234", { selector: ".vcs-commit-detail__subject" });
        const head = container.querySelector(".vcs-commit-detail__head") as HTMLElement;
        expect(head.contains(screen.getByLabelText("Switch to stacked layout"))).toBe(true);
        expect(head.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(true);
        expect(container.querySelector(".vcs-topbar")!.querySelector(".tab--icon")).toBeNull();
        expect(screen.getAllByLabelText(toggleName)).toHaveLength(1);
        useWorkspaceStore.setState({ vcsSelectedCommitByWorktree: {} } as never);
      });

      it("phone stacked, list open: still the list header", async () => {
        useWorkspaceStore.setState({
          activeWorktreeId: "wt-1",
          layoutByWorktree: filesLayout({ masterDetailVertical: true }),
          fileTreeVisible: true,
          filesLeftPaneMode: { "wt-1": "tree" },
        });
        const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
        await screen.findByText("README.md").catch(() => undefined);
        const header = container.querySelector(".file-tree-sidebar-header") as HTMLElement;
        expect(header.contains(screen.getByLabelText("Switch to side-by-side layout"))).toBe(true);
        expect(container.querySelector(".files-topbar")!.querySelector(".tab--icon")).toBeNull();
      });
    });

    it("renders its own vertical touch rail as the LAST child, after the content; rail buttons work", async () => {
      const user = userEvent.setup();
      const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
      const root = container.querySelector(".tool-panel") as HTMLElement;
      const rail = container.querySelector(".tool-panel__tile-rail.tool-panel__tile-rail--touch") as HTMLElement;
      expect(rail).not.toBeNull();
      expect(root.lastElementChild).toBe(rail);
      expect(container.querySelector(".tool-panel__content")!.nextElementSibling).toBe(rail);
      expect(rail.querySelector('[aria-orientation="vertical"]')).not.toBeNull();
      await user.click(screen.getByRole("button", { name: "Version Control" }));
      expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.toolPanelTab).toBe("vcs");
    });

    it("Esc with focus on a rail button closes the open list", async () => {
      const user = userEvent.setup();
      act(() => useWorkspaceStore.setState({ fileTreeVisible: true, layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" } } }));
      render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
      screen.getByRole("button", { name: "Outline" }).focus();
      await user.keyboard("{Escape}");
      expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);
    });
  });

  it("§3.b, §3.d — hidePanelControls renders the tile rail as a flex sibling after the content, with working VCS", async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" hidePanelControls />);

    const root = container.querySelector(".tool-panel") as HTMLElement;
    expect(root.style.flexDirection).toBe("row");
    expect(root.id).toBe("");
    const content = container.querySelector(".tool-panel__content") as HTMLElement;
    const tileRail = container.querySelector(".tool-panel__tile-rail") as HTMLElement;
    expect(tileRail).not.toBeNull();
    expect(content.nextElementSibling).toBe(tileRail);
    expect(tileRail.parentElement).toBe(root);

    const devices = screen.getByRole("button", { name: "Devices (coming soon)" });
    expect(devices).toBeDisabled();

    const artifacts = screen.getByRole("button", { name: "Artifacts" });
    expect(artifacts).toBeEnabled();

    // Clicking VCS switches active tool
    const vcs = screen.getByRole("button", { name: "Version Control" });
    await user.click(vcs);
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.toolPanelTab).toBe("vcs");
  });

  it("R6 — renders relocated ToolFullscreenButton", () => {
    renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
    expect(screen.getByRole("button", { name: /fullscreen/i })).toBeInTheDocument();
  });

  it("without a provider no pane controls render (hosts are null) and nothing throws", () => {
    render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    expect(screen.queryByRole("button", { name: /fullscreen/i })).toBeNull();
  });

  it("§4b — tool-panel__body carries no rail padding on any tab", async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" hidePanelControls />);

    const body = container.querySelector(".tool-panel__body") as HTMLElement;
    expect(body.style.paddingLeft).toBe("");

    await user.click(screen.getByRole("button", { name: "Version Control" }));
    expect(body.style.paddingLeft).toBe("");
  });

  it("§4a — the list size var follows persisted filesLeftPaneWidthByWorktree (set by DockedListLayout, the one owner)", () => {
    useWorkspaceStore.setState({
      filesLeftPaneWidthByWorktree: { "wt-1": 320 },
    });
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    expect((container.querySelector(".tool-panel") as HTMLElement).style.getPropertyValue("--list-pane-w")).toBe("");
    const panel = container.querySelector(".files-panel") as HTMLElement;
    expect(panel.style.getPropertyValue("--list-pane-w")).toBe("320px");
  });

  it("§3.f — renders split-orientation toggle in top actions and toggles masterDetailVertical in store", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files", masterDetailVertical: false } },
    });
    renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);

    const toggleBtn = screen.getByRole("button", { name: "Switch to stacked layout" });
    expect(toggleBtn).toBeInTheDocument();

    await user.click(toggleBtn);
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.masterDetailVertical).toBe(true);

    expect(screen.getByRole("button", { name: "Switch to side-by-side layout" })).toBeInTheDocument();
  });

  describe("W1-01 — the layout toggle keeps keyboard focus when the pane controls change host", () => {
    afterEach(() => {
      useWorkspaceStore.setState({ vcsSelectedCommitByWorktree: {} } as never);
    });

    it("Files: side-by-side -> stacked moves the toggle into the list header, still focused; and back", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files", masterDetailVertical: false } },
        fileTreeVisible: true,
        filesLeftPaneMode: { "wt-1": "tree" },
      });
      const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
      const first = screen.getByRole("button", { name: "Switch to stacked layout" });
      first.focus();
      await user.keyboard("{Enter}");
      const header = container.querySelector(".file-tree-sidebar-header") as HTMLElement;
      const second = screen.getByRole("button", { name: "Switch to side-by-side layout" });
      expect(header.contains(second)).toBe(true);
      expect(document.activeElement).toBe(second);

      await user.keyboard("{Enter}");
      const third = screen.getByRole("button", { name: "Switch to stacked layout" });
      expect(container.querySelector(".files-topbar")!.contains(third)).toBe(true);
      expect(document.activeElement).toBe(third);
    });

    it("VCS commit view: the toggle keeps focus across the host change", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "vcs", masterDetailVertical: false } },
        vcsSelectedCommitByWorktree: { "wt-1": { sha: "abc1234" } },
      } as never);
      const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
      await screen.findByText("abc1234", { selector: ".vcs-commit-detail__subject" });
      // The commit view focuses its file list once on open; let that settle before moving focus to the toggle.
      await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("treeitem"));
      screen.getByRole("button", { name: "Switch to stacked layout" }).focus();
      await user.keyboard("{Enter}");
      const next = screen.getByRole("button", { name: "Switch to side-by-side layout" });
      expect((container.querySelector(".vcs-commit-detail__head") as HTMLElement).contains(next)).toBe(true);
      expect(document.activeElement).toBe(next);
    });
  });

  it("the list height var follows persisted filesLeftPaneHeightByWorktree", () => {
    useWorkspaceStore.setState({
      filesLeftPaneHeightByWorktree: { "wt-1": 350 },
    });
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    const panel = container.querySelector(".files-panel") as HTMLElement;
    expect(panel.style.getPropertyValue("--list-pane-h")).toBe("350px");
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

  it("R1F-02 — Esc from inside the list overlay parks focus on the pane so a second Esc exits fullscreen", async () => {
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" } },
      fileTreeVisible: true,
      workspacePaneFullscreen: "tools",
    });
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    await screen.findByText("README.md");
    const overlay = container.querySelector(".files-left-pane-overlay") as HTMLElement;
    const inner = document.createElement("div");
    inner.tabIndex = 0;
    overlay.appendChild(inner);
    inner.focus();
    expect(document.activeElement).toBe(inner);
    act(() => {
      inner.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);
    expect(document.activeElement).toBe(container.querySelector(".tool-panel"));
    expect(useWorkspaceStore.getState().workspacePaneFullscreen).toBe("tools");
    act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(useWorkspaceStore.getState().workspacePaneFullscreen).toBeNull();
  });

  it("R16 — Esc closes a references panel revealed with the tree hidden before exiting fullscreen", () => {
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" } },
      fileTreeVisible: false,
      filesLeftPaneMode: { "wt-1": "references" },
      workspacePaneFullscreen: "tools",
    });
    const { container } = render(<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />);
    const esc = () =>
      act(() => {
        const pane = container.querySelector(".tool-panel") as HTMLElement;
        pane.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    esc();
    expect(useWorkspaceStore.getState().filesLeftPaneMode["wt-1"]).toBe("tree");
    expect(useWorkspaceStore.getState().workspacePaneFullscreen).toBe("tools");
    esc();
    expect(useWorkspaceStore.getState().workspacePaneFullscreen).toBeNull();
  });

  describe("actions hosts (registry)", () => {
    const filesLayout = (extra: Partial<typeof DEFAULT_WORKTREE_LAYOUT> = {}) => ({
      "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" as const, ...extra },
    });

    it("R1F-05 — tools fullscreen hides the layout toggle and shows only Exit fullscreen", () => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        layoutByWorktree: filesLayout(),
        fileTreeVisible: false,
        workspacePaneFullscreen: "tools",
      });
      renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
      expect(screen.queryByLabelText(/Switch to (stacked|side-by-side) layout/)).toBeNull();
      expect(screen.getAllByRole("button", { name: /exit fullscreen/i })).toHaveLength(1);
      act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen(null));
      expect(screen.getAllByLabelText(/Switch to (stacked|side-by-side) layout/)).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "Fullscreen" })).toHaveLength(1);
    });

    it("5.T1 — Files tab, list closed: one fullscreen, one layout toggle, one chip; the Files bar holds the reserve and the pane controls", async () => {
      useWorkspaceStore.setState({ layoutByWorktree: filesLayout(), fileTreeVisible: false });
      const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
      const bar = container.querySelector(".files-topbar") as HTMLElement;
      expect(screen.getAllByLabelText("Search files")).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /fullscreen/i })).toHaveLength(1);
      expect(screen.getAllByLabelText("Switch to stacked layout")).toHaveLength(1);
      // The chip is outside every row; the Files bar holds the active reserve.
      expect(bar.contains(screen.getByLabelText("Search files"))).toBe(false);
      expect(bar.contains(activeReserve(container))).toBe(true);
      expect(bar.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(true);
      expect(bar.contains(screen.getByLabelText("Switch to stacked layout"))).toBe(true);
    });

    it.each([
      ["tree", ".file-tree-sidebar-header"],
      ["search", ".search-panel__bar"],
      ["outline", ".outline-panel__header"],
      ["references", ".references-panel__header"],
    ] as const)("5.T2 — stacked + list open, mode %s: reserve lives only in that mode's header", async (mode, sel) => {
      useWorkspaceStore.setState({
        layoutByWorktree: filesLayout({ masterDetailVertical: true }),
        fileTreeVisible: true,
        filesLeftPaneMode: { "wt-1": mode },
      });
      const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
      await screen.findByText("README.md").catch(() => undefined);
      expect(screen.getAllByLabelText("Search files")).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /fullscreen/i })).toHaveLength(1);
      expect(screen.getAllByLabelText("Switch to side-by-side layout")).toHaveLength(1);
      const headers = Array.from(container.querySelectorAll(sel));
      expect(headers.length).toBeGreaterThan(0);
      const reserve = activeReserve(container);
      expect(headers.some((h) => h.contains(reserve))).toBe(true);
      expect(container.querySelector(".files-topbar")?.contains(reserve)).toBe(false);
      // Stacked: the same header carries the pane controls.
      expect(headers.some((h) => h.contains(screen.getByLabelText("Switch to side-by-side layout")))).toBe(true);
    });

    it.each([
      ["tree", ".file-tree-sidebar-header"],
      ["search", ".search-panel__bar"],
      ["outline", ".outline-panel__header"],
      ["references", ".references-panel__header"],
    ] as const)(
      "anchor — desktop side-by-side list open, mode %s: the mode header holds the reserve only; layout toggle and Fullscreen stay in .files-topbar",
      async (mode, sel) => {
        useWorkspaceStore.setState({
          layoutByWorktree: filesLayout({ masterDetailVertical: false }),
          fileTreeVisible: true,
          filesLeftPaneMode: { "wt-1": mode },
        });
        const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
        await screen.findByText("README.md").catch(() => undefined);
        expect(screen.getAllByLabelText("Search files")).toHaveLength(1);
        const reserve = activeReserve(container);
        const header = container.querySelector(sel) as HTMLElement;
        expect(header).not.toBeNull();
        expect(header).toHaveClass("actions-row"); // every row that can host the chip's reserve carries the shared class
        expect(header.contains(reserve)).toBe(true);
        const bar = container.querySelector(".files-topbar") as HTMLElement;
        expect(bar.contains(reserve)).toBe(false);
        expect(bar.contains(screen.getByLabelText("Switch to stacked layout"))).toBe(true);
        expect(bar.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(true);
        expect(header.contains(screen.getByLabelText("Switch to stacked layout"))).toBe(false);
        expect(header.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(false);
      },
    );

    it("a tools tile of worktree B closes ITS list on Esc even when the active worktree A is on the VCS tab", async () => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-1",
        layoutByWorktree: {
          "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "vcs" },
          "wt-2": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" },
        },
        fileTreeVisible: true,
        filesLeftPaneMode: { "wt-2": "tree" },
      });
      const { container } = render(<ToolPanel api={api} worktreeId="wt-2" scope="worktree" hidePanelControls />);
      await screen.findByText("README.md").catch(() => undefined);
      const root = container.querySelector(".tool-panel") as HTMLElement;
      act(() => {
        root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(useWorkspaceStore.getState().fileTreeVisible).toBe(false);
    });

    it("anchor — side-by-side list closed: the reserve is back in .files-topbar", () => {
      useWorkspaceStore.setState({ layoutByWorktree: filesLayout(), fileTreeVisible: false });
      const { container } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
      expect((container.querySelector(".files-topbar") as HTMLElement).contains(activeReserve(container))).toBe(true);
    });

    it("5.T3 — VCS tab: reserve in .vcs-topbar, including the commit view's bar", async () => {
      useWorkspaceStore.setState({ layoutByWorktree: filesLayout({ toolPanelTab: "vcs" as const }) });
      const { container, unmount } = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
      // No commit open: the list fills the pane and its own rail header is the VCS top row (tool host, the chip's reserve).
      let bar = container.querySelector(".vcs-list-pane > .rail-header") as HTMLElement;
      expect(bar).not.toBeNull();
      expect(screen.getAllByLabelText("Search files")).toHaveLength(1);
      expect(bar.contains(activeReserve(container))).toBe(true);
      // Other panes in this file may leave their own fullscreen control mounted; the VCS top row must hold one.
      expect(screen.getAllByRole("button", { name: /fullscreen/i }).some((b) => bar.contains(b))).toBe(true);
      unmount();

      useWorkspaceStore.setState({ vcsSelectedCommitByWorktree: { "wt-1": { sha: "abc1234" } } } as never);
      const second = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
      await screen.findByText("abc1234", { selector: ".vcs-commit-detail__subject" });
      bar = second.container.querySelector(".vcs-topbar") as HTMLElement;
      expect(screen.getAllByLabelText("Search files")).toHaveLength(1);
      // Commit open, list docked right: the chip's reserve moves into the list header (like the Files list header);
      // the pane controls stay in the bar.
      const head = second.container.querySelector(".vcs-commit-detail__head") as HTMLElement;
      expect(head).toHaveClass("actions-row");
      expect(head.contains(activeReserve(second.container))).toBe(true);
      expect(bar.contains(activeReserve(second.container))).toBe(false);
      expect(bar.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(true);
      second.unmount();

      // List closed (VCS rail icon): the reserve is back in the bar.
      useWorkspaceStore.setState({ vcsSidebarVisibleByWorktree: { "wt-1": false } });
      const third = renderHosted([{ api, worktreeId: "wt-1", scope: "worktree" }]);
      await screen.findByText("abc1234", { selector: ".vcs-commit-detail__subject" });
      bar = third.container.querySelector(".vcs-topbar") as HTMLElement;
      expect(bar.contains(activeReserve(third.container))).toBe(true);
      useWorkspaceStore.setState({ vcsSidebarVisibleByWorktree: {}, vcsSelectedCommitByWorktree: {} } as never);
    });

    it("5.T4 — no worktree: reserve in .tool-panel__bar above the empty state", () => {
      useWorkspaceStore.setState({ activeWorktreeId: null, activeDirectContextId: null });
      const { container } = renderHosted([{ api, worktreeId: null, scope: "worktree" }]);
      const bar = container.querySelector(".tool-panel__bar") as HTMLElement;
      expect(bar).toHaveClass("actions-row");
      expect(bar).not.toBeNull();
      expect(bar.contains(activeReserve(container))).toBe(true);
      expect(bar.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(true);
      expect(screen.getByText("Select a worktree to use tools")).toBeInTheDocument();
    });

    it("5.T5 — a tile (hidePanelControls) has Close but never reserves the chip; one #tools-pane across sticky panels", () => {
      const onClose = () => {};
      const { container } = renderHosted([
        { api, worktreeId: "wt-1", scope: "worktree", hidePanelControls: true, onClose },
      ], ["canvas"]);
      expect(screen.getByRole("button", { name: "Close tool tile" })).toBeInTheDocument();
      // A tile never reserves the chip's width (the registry's `canvas` zone has no host here).
      expect(activeReserve(container)).toBeNull();
      expect(container.querySelector("#tools-pane")).toBeNull();
    });

    it("5.T5 — active + offscreen panels: one Search files, one #tools-pane", () => {
      useWorkspaceStore.setState({
        layoutByWorktree: {
          "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" },
          "wt-2": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelTab: "files" },
        },
        activeWorktreeId: "wt-1",
      });
      const { container } = renderHosted([
        { api, worktreeId: "wt-1", scope: "worktree" },
        { api, worktreeId: "wt-2", scope: "worktree" },
      ]);
      expect(screen.getAllByLabelText("Search files")).toHaveLength(1);
      expect(container.querySelectorAll("#tools-pane")).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /fullscreen/i })).toHaveLength(2);
    });
  });
});
