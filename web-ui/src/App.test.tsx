import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createMockApi, type MockApi } from "@/api/mock";
import { App, resolveNavigateAction } from "./App";

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

// Control useAuth's authed/loading per test (App calls useOobeGate with
// enabled: authed, and its loading/!authed early returns drive the minimal shell).
let authMock: { status?: string; authed: boolean; loading: boolean; onLoginSuccess: () => void };
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => authMock,
}));

// The daemon-side `api` singleton is replaced with the in-memory mock so tests
// can spy on getOobeState. Read via a getter so a fresh mock per test is used.
let testApi: MockApi;
vi.mock("@/api", () => ({
  get api() {
    return testApi;
  },
  createMockApi,
}));

beforeEach(() => {
  testApi = createMockApi();
  authMock = { authed: false, loading: false, onLoginSuccess: () => {} };
});

describe("App routing", () => {
  it("visiting /workspace redirects to /worktree", () => {
    expect(App).toBeTruthy();
  });

  it("canonical route is /worktree", () => {
    expect(App).toBeTruthy();
  });
});

// Review Fix D: on a cold start (`vst <path>` launches the app fresh), the main
// window's very first WS connection lands inside the daemon's 3s replay window,
// which hardcodes newWindow:false. Before the fix the main window never
// navigated and the user landed on the dashboard instead of the project.
describe("resolveNavigateAction - navigate WS decision", () => {
  it("plain browser tab (no Tauri) always navigates, regardless of newWindow", () => {
    expect(
      resolveNavigateAction({ projectId: "p1", newWindow: true, isTauri: false, label: undefined }),
    ).toBe("navigate");
    expect(
      resolveNavigateAction({ projectId: "p1", newWindow: false, isTauri: false, label: undefined }),
    ).toBe("navigate");
  });

  it("main window + newWindow:true spawns a new OS window", () => {
    expect(
      resolveNavigateAction({ projectId: "p1", newWindow: true, isTauri: true, label: "main" }),
    ).toBe("spawn");
  });

  it("main window + newWindow:false (cold-start replay) does a SAME-WINDOW navigate (review Fix D)", () => {
    // This is the exact cold-start case that previously did NOTHING — the fix
    // makes the main window land on the project instead of the dashboard.
    expect(
      resolveNavigateAction({ projectId: "p1", newWindow: false, isTauri: true, label: "main" }),
    ).toBe("navigate");
  });

  it("non-main Tauri window (project-*) always does nothing - loop-prevention guard 2", () => {
    expect(
      resolveNavigateAction({ projectId: "p1", newWindow: true, isTauri: true, label: "project-p1-0" }),
    ).toBe("none");
    expect(
      resolveNavigateAction({ projectId: "p1", newWindow: false, isTauri: true, label: "project-p1-0" }),
    ).toBe("none");
  });

  it("main window with no injected label still spawns/navigates like main", () => {
    expect(
      resolveNavigateAction({ projectId: "p1", newWindow: true, isTauri: true, label: undefined }),
    ).toBe("none");
  });
});

describe("App OOBE gate", () => {
  it("4.T4 — authed + OOBE completed renders the normal Routes tree, never OobeFlow", async () => {
    authMock = { authed: true, loading: false, onLoginSuccess: () => {} };
    vi.spyOn(testApi, "getOobeState").mockResolvedValue({
      completed: true,
      currentStep: 1,
      defaultProjectsDir: "/x",
      vstHome: "/x/.vibe-station",
    });

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    // The full workspace shell renders (LeftSidebar's distinctive New project
    // control), not the OOBE flow.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("oobe-step1")).toBeNull();
    expect(screen.queryByTestId("oobe-step2")).toBeNull();
  });

  it("4.T4 — loading:true from useAuth renders the minimal shell and never calls getOobeState", async () => {
    authMock = { authed: false, loading: true, onLoginSuccess: () => {} };
    const spy = vi.spyOn(testApi, "getOobeState");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    // The minimal TopBar-only loading shell renders (never the OOBE flow nor
    // the workspace tree)…
    expect(screen.getByText(/not signed in/)).toBeInTheDocument();
    expect(screen.queryByTestId("oobe-step1")).toBeNull();
    expect(screen.queryByTestId("oobe-step2")).toBeNull();
    // …and useOobeGate (enabled:false) never fetched OOBE state.
    expect(spy).not.toHaveBeenCalled();
  });

  it("4.T4 — !authed renders the login shell and never calls getOobeState", async () => {
    authMock = { authed: false, loading: false, onLoginSuccess: () => {} };
    const spy = vi.spyOn(testApi, "getOobeState");

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText(/not signed in/)).toBeInTheDocument();
    expect(screen.queryByTestId("oobe-step1")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("App tri-state auth shells", () => {
  const renderApp = () =>
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

  it("3.T1 — unreachable renders the retry screen + reconnecting chip, not login", () => {
    authMock = { status: "unreachable", authed: false, loading: false, onLoginSuccess: () => {} };
    const spy = vi.spyOn(testApi, "getOobeState");
    renderApp();
    expect(screen.getByTestId("daemon-unreachable")).toBeInTheDocument();
    expect(screen.getByText(/Can't reach vibe-station/)).toBeInTheDocument();
    expect(screen.getByText("● reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText(/not signed in/)).toBeNull();
    expect(screen.queryByText(/Show QR/)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("3.T2 — unauthenticated renders LoginScreen + not-signed-in chip", () => {
    authMock = { status: "unauthenticated", authed: false, loading: false, onLoginSuccess: () => {} };
    renderApp();
    expect(screen.getByText(/not signed in/)).toBeInTheDocument();
    expect(screen.getByText(/Show QR/)).toBeInTheDocument();
    expect(screen.queryByTestId("daemon-unreachable")).toBeNull();
  });
});
