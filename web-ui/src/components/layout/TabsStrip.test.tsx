import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { TabsStrip } from "./TabsStrip";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";

describe("TabsStrip", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      activeTerminalSessionId: null,
      sessionStates: {},
      layoutByWorktree: {
        "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, terminalDockVisible: true },
        "wt-2": { ...DEFAULT_WORKTREE_LAYOUT, terminalDockVisible: true },
      },
    });
  });

  it("main tab has no close control", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /^main$/i })).toBeInTheDocument();
    });
    const mainTab = screen.getByRole("tab", { name: /^main$/i });
    expect(mainTab.querySelector('[aria-label^="Close"]')).toBeNull();
  });

  it("non-main tab exposes close via aria-label", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Close agent-2/i })).toBeInTheDocument();
    });
  });

  it("clicking close opens confirm dialog", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /Close agent-2/i });
    await user.click(screen.getByRole("button", { name: /Close agent-2/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("click + opens NewTab dialog", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /New agent/i }));
    expect(screen.getByRole("dialog", { name: /New agent/i })).toBeInTheDocument();
  });

  it("agent strip has no dock-close control", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /^main$/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Close terminal dock/i })).toBeNull();
  });

  it("terminal strip close button hides the dock", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ activeWorktreeId: "wt-1" });
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="terminal" />
      </MemoryRouter>,
    );
    const closeBtn = await screen.findByRole("button", { name: /Close terminal dock/i });
    await user.click(closeBtn);
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.terminalDockVisible).toBe(false);
  });

  it("auto-creates a terminal when dock opens empty", async () => {
    const createSpy = vi.spyOn(api, "createSession");
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-2",
      activeTerminalSessionId: null,
    });
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-2" kind="terminal" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: "wt-2",
        type: "terminal",
        useTmux: true,
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Terminal/i })).toBeInTheDocument();
    });
  });

  it("does not auto-create when terminals already exist", async () => {
    const createSpy = vi.spyOn(api, "createSession");
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="terminal" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /term-1/i })).toBeInTheDocument();
    });
    expect(createSpy).not.toHaveBeenCalled();
  });
});
