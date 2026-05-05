import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { TabsStrip } from "./TabsStrip";
import { useWorkspaceStore } from "@/hooks/useStore";

describe("TabsStrip", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      sessionStates: {},
    });
  });

  it("main tab has no close control", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" />
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
        <TabsStrip api={api} worktreeId="wt-1" />
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
        <TabsStrip api={api} worktreeId="wt-1" />
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
        <TabsStrip api={api} worktreeId="wt-1" />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /New tab/i }));
    expect(screen.getByRole("dialog", { name: /New tab/i })).toBeInTheDocument();
  });
});
