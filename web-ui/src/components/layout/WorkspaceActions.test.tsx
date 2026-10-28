import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";
import { DemoEnvProvider } from "@/context/DemoEnv";
import { useWorkspaceStore } from "@/hooks/useStore";
import { Layout } from "./Layout";
import { ActionsHost } from "./TopActionsSlot";
import { WorkspaceActions } from "./WorkspaceActions";

vi.mock("@/components/layout/PaneFullscreenChrome", () => ({
  PaneFullscreenChrome: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

const TOGGLE = "Toggle tool panel";

function setTools(visible: boolean) {
  act(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-own",
      workspacePaneFullscreen: null,
      layoutTransitionHint: null,
      layoutByWorktree: {
        "wt-own": {
          toolPanelVisible: visible,
          toolPanelTab: "files",
          terminalDockVisible: false,
          toolSplitOrientation: "horizontal",
          layoutMode: "classic",
          activeWorkspaceId: null,
          scratchCanvas: null,
          canvasToolbarVisible: true,
        },
      },
    });
  });
}

function ui(onOpenQuickOpen: Mock = vi.fn()) {
  return (
    <DemoEnvProvider value={{ demo: false } as never}>
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={
          <div data-testid="agent-host">
            <ActionsHost zone="agent" />
          </div>
        }
        toolPanel={
          <div data-testid="tools-host">
            <ActionsHost zone="tools" />
          </div>
        }
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
        isClassicLayout
        actionsGroup={<WorkspaceActions isMobile={false} onOpenQuickOpen={onOpenQuickOpen} canvasWorktreeId="wt-own" />}
      />
    </DemoEnvProvider>
  );
}

describe("WorkspaceActions: the shared Search / '...' / toggle group", () => {
  beforeEach(() => setTools(true));

  it("renders Search, the '...' trigger, then the toggle (toggle last), and Search calls onOpenQuickOpen", () => {
    const open = vi.fn();
    render(ui(open));
    // The rail also has a "Search files" mode button: scope to the chip that carries the group.
    const chip = document.querySelector(".top-actions-anchor") as HTMLElement;
    expect(
      within(chip).getAllByRole("button"),
      "chip width is --top-actions-w (3 buttons): bump it in workspace.css and CHIP_W (anchorCss.test.ts)",
    ).toHaveLength(3);
    const search = within(chip).getByLabelText("Search files");
    const more = screen.getByLabelText("More options");
    const toggle = screen.getByLabelText(TOGGLE);
    expect(search.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(more.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The toggle is inline in the group (never portaled elsewhere) and its last child.
    expect(toggle.parentElement).toBe(chip);
    expect(chip.lastElementChild).toBe(toggle);
    fireEvent.click(search);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the '...' menu opens with the split/terminal items and Esc closes only the menu", () => {
    render(ui());
    fireEvent.click(screen.getByLabelText("More options"));
    expect(screen.getByRole("menuitemcheckbox", { name: /Terminal/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /toolbar/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByLabelText("More options")).toHaveFocus();
  });
});
