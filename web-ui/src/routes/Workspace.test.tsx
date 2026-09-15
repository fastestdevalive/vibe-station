import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import { api } from "@/api";
import type { Session } from "@/api/types";
import { Workspace } from "./Workspace";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";

// Workspace mounts the full app shell (Layout, TopBar, LeftSidebar, the
// terminal/chrome panes, ...). Stub out the libraries that need real DOM/canvas
// layout (which jsdom can't provide) so the drafting-gate assertions below can
// focus on what this file actually changes.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    buffer = { active: { viewportY: 0, length: 0 } };
    open() {}
    focus() {}
    write() {}
    reset() {}
    refresh() {}
    loadAddon() {}
    dispose() {}
    onData() {
      return { dispose: () => {} };
    }
    onResize() {
      return { dispose: () => {} };
    }
    onScroll() {
      return { dispose: () => {} };
    }
    attachCustomKeyEventHandler() {}
    clearTextureAtlas = () => {};
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));
vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

// The daemon-side `api` singleton (Workspace reads it, and `useServerSync`
// subscribes to its WS events) is replaced with the in-memory mock so the
// `session:state` event below can be emitted live via `__test.emit`.
vi.mock("@/api", () => ({ api: createMockApi(), createMockApi }));

const DRAFT_ID = "sess-agent2";

/** Mark the mock fixture's wt-1 agent session as drafting in the store. */
function makeDrafting() {
  useServerStore.setState({
    sessions: useServerStore.getState().sessions.map((s) =>
      s.id === DRAFT_ID ? { ...s, state: "drafting", lifecycleState: "drafting" } : s,
    ),
  });
  useWorkspaceStore.setState({ activeWorktreeId: "wt-1", activeSessionId: DRAFT_ID });
}

describe("Workspace drafting gate", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: null,
    });
  });

  it("2.T2 — a session genuinely still drafting (state: 'drafting') renders DraftComposer", async () => {
    render(
      <MemoryRouter initialEntries={["/worktree/wt-1/sess-agent2"]}>
        <Workspace />
      </MemoryRouter>,
    );

    // Let useServerSync's initial fetch settle and the URL read-effect pick a session.
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBeTruthy();
    });
    act(() => makeDrafting());

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "New agent" })).toBeInTheDocument();
    });
  });

  it("2.T1 — a promoted session (state patched to 'not_started' via session:state while lifecycleState stays stale 'drafting') renders the real agent pane, not DraftComposer", async () => {
    render(
      <MemoryRouter initialEntries={["/worktree/wt-1/sess-agent2"]}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBeTruthy();
    });
    act(() => makeDrafting());

    // Initially still drafting -> DraftComposer.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "New agent" })).toBeInTheDocument();
    });

    // The live `session:state` WS handler patches ONLY `.state` (useServerSync),
    // leaving `.lifecycleState` stale at "drafting" — the exact real-bug shape.
    await act(async () => {
      (api as MockApi).__test.emit({ type: "session:state", sessionId: DRAFT_ID, state: "not_started" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "New agent" })).not.toBeInTheDocument();
    });

    // The store now reflects the promotion: `state` live-updated, `lifecycleState` stale.
    const sess: Session | undefined = useServerStore
      .getState()
      .sessions.find((s) => s.id === DRAFT_ID);
    expect(sess?.state).toBe("not_started");
    expect(sess?.lifecycleState).toBe("drafting");
  });
});
