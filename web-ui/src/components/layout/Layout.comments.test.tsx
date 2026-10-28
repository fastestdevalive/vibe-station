import { useEffect, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { makeComment as c } from "@/components/comments/testFixtures";
import { makeSession } from "@/components/comments/testHarness";
import { useCommentStore } from "@/components/comments/useCommentStore";
import { useServerStore } from "@/hooks/useServerStore";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";
import { MemoryRouter } from "react-router-dom";
import { Layout } from "./Layout";
import { ToolPanel } from "./ToolPanel";

// 7.T3: the comments tray, the send picker and the bottom sheet are siblings of the agent panel: opening,
// closing and fullscreen never change the agent pane's tree path (R92, AGENTS "Terminal" no-remount).
vi.mock("@/components/layout/PaneFullscreenChrome", () => ({
  PaneFullscreenChrome: ({ children }: { children: ReactNode }) => <div data-testid="fullscreen-chrome">{children}</div>,
}));
vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children }: { children: ReactNode }) => <div data-testid="panel-group">{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div data-testid="panel">{children}</div>,
  PanelResizeHandle: () => <div data-testid="resize-handle" />,
}));

let mounts = 0;
let unmounts = 0;
function AgentChild() {
  useEffect(() => {
    mounts += 1;
    return () => {
      unmounts += 1;
    };
  }, []);
  return <div data-testid="agent-child">Agent</div>;
}

const api = createMockApi();

function mobileMatchMedia(mobile: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: mobile && q.includes("max-width: 768px"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as never;
}

function mount() {
  return render(
    <MemoryRouter>
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={<AgentChild />}
        toolPanel={<ToolPanel api={api} worktreeId="wt-1" scope="worktree" />}
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mounts = 0;
  unmounts = 0;
  localStorage.clear();
  mobileMatchMedia(false);
  useCommentStore.getState().reset();
  useCommentStore.getState().replace("wt-1", "worktree", { comments: [c({ id: "a", scopeId: "wt-1" }), c({ id: "b", pin: 2, scopeId: "wt-1" })], nextPin: 3, terminalDeliveries: [] });
  useServerStore.setState({ sessions: [makeSession({ id: "s1", worktreeId: "wt-1" })], worktrees: [] } as never);
  act(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, toolPanelVisible: true, toolPanelTab: "files" } },
    } as never);
  });
});

afterEach(() => {
  mobileMatchMedia(false);
});

describe("Layout with the comments tray (7.T3)", () => {
  it("mounts the tray without touching the agent pane, and opening / closing the picker and fullscreen never remount it", async () => {
    mount();
    expect(mounts).toBe(1);
    const region = await screen.findByRole("region", { name: "Review comments" });
    // the tray is a sibling AFTER the tool panel body, inside the tools content column
    expect(region.previousElementSibling?.className).toContain("tool-panel__body");
    expect(mounts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Send to agent…" }));
    expect(await screen.findByRole("dialog", { name: "Send 2 comments" })).toBeInTheDocument();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Send 2 comments" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send 2 comments" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^2 comments$/ }));
    expect(mounts).toBe(1);

    act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("tools"));
    expect(screen.getByRole("region", { name: "Review comments" })).toBeInTheDocument();
    act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen(null));
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(screen.getByTestId("agent-child")).toBeInTheDocument();
  });

  it("expanding the tray, resizing it, opening the picker and switching When never remount the agent pane", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^2 comments$/ }));
    const handle = await screen.findByRole("separator", { name: "Resize comments list" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(window, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(window, { clientY: 400, pointerId: 1 });
    fireEvent.doubleClick(handle);
    expect(mounts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Send 2 to agent…" }));
    await screen.findByRole("dialog", { name: "Send 2 comments" });
    fireEvent.click(screen.getByRole("radio", { name: "Later" }));
    fireEvent.click(screen.getByRole("radio", { name: "Now" }));
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(screen.getByTestId("agent-child")).toBeInTheDocument();
  });

  it("the mobile picker is a BottomSheet and the agent pane still never remounts", async () => {
    mobileMatchMedia(true);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Send…" }));
    const sheet = await screen.findByRole("dialog", { name: "Send 2 comments" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet.className).toContain("bottom-sheet");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });
});
