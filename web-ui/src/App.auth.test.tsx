import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createMockApi, type MockApi } from "@/api/mock";
import { App } from "./App";

// Workspace mounts the full app shell (Layout, TopBar, LeftSidebar, terminal
// panes, ...). Stub the libraries that need real DOM/canvas layout (which
// jsdom can't provide) so the OOBE-gate assertions below can focus on what
// this file actually changes.
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

let testApi: MockApi;
vi.mock("@/api", () => ({
  get api() {
    return testApi;
  },
  createMockApi,
}));

beforeEach(() => {
  vi.useFakeTimers();
  testApi = createMockApi();
  vi.spyOn(testApi, "getOobeState").mockResolvedValue({
    completed: true,
    currentStep: 1,
    defaultProjectsDir: "/x",
    vstHome: "/x/.vibe-station",
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("App + real useAuth (3.T5)", () => {
  it("unreachable shows the retry screen, then heals into the workspace after 2s", async () => {
    const check = vi.spyOn(testApi, "checkAuthStatus") as unknown as {
      mockResolvedValue: (v: string) => void;
    };
    check.mockResolvedValue("unreachable");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("daemon-unreachable")).toBeInTheDocument();
    expect(screen.queryByText(/Show QR/)).toBeNull();

    check.mockResolvedValue("authed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("daemon-unreachable")).toBeNull();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
  });
});
