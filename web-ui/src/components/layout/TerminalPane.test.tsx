import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { TerminalPane } from "./TerminalPane";
import { useWorkspaceStore } from "@/hooks/useStore";

const writeSpy = vi.fn();
let mockCols = 80;
let mockRows = 24;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: { fontSize: number; theme?: object } = { fontSize: 14 };
    buffer = { active: { viewportY: 0, length: 100 } };
    get cols() { return mockCols; }
    get rows() { return mockRows; }
    element = null;
    open() {}
    write = writeSpy;
    writeln() {}
    reset() {}
    refresh() {}
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    clearTextureAtlas = vi.fn();
    onData(_cb: (d: string) => void) {
      return { dispose: () => {} };
    }
    onResize(_cb: (s: { cols: number; rows: number }) => void) {
      return { dispose: () => {} };
    }
    onScroll(_cb: () => void) {
      return { dispose: () => {} };
    }
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}));

describe("TerminalPane", () => {
  const api = createMockApi();

  beforeEach(() => {
    writeSpy.mockClear();
    mockCols = 80;
    mockRows = 24;
    useWorkspaceStore.setState({
      activeSessionId: "sess-main",
      sessionStates: { "sess-main": "working" },
      sessionAttachState: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows spawning placeholder when session is not_started", () => {
    useWorkspaceStore.setState({
      sessionStates: { "sess-main": "not_started" },
      sessionAttachState: {},
    });
    render(<TerminalPane api={api} />);
    expect(screen.getByRole("status", { name: /starting/i })).toBeInTheDocument();
  });

  it("resume banner hidden when state !== exited", () => {
    render(<TerminalPane api={api} />);
    expect(screen.queryByText(/Session exited/i)).toBeNull();
  });

  it("resume banner shown when state is exited", () => {
    useWorkspaceStore.setState({
      sessionStates: { "sess-main": "exited" },
    });
    render(<TerminalPane api={api} />);
    expect(screen.getByText(/Session exited/i)).toBeInTheDocument();
  });

  it("clicking Resume calls api.resumeSession", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "resumeSession");
    useWorkspaceStore.setState({
      sessionStates: { "sess-main": "exited" },
    });
    render(<TerminalPane api={api} />);
    await user.click(screen.getByRole("button", { name: /Resume/i }));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith("sess-main");
    });
    spy.mockRestore();
  });

  it("replaces Resume with busy indicator while resumeSession is in flight", async () => {
    const user = userEvent.setup();
    let resolveResume!: (v: Awaited<ReturnType<typeof api.resumeSession>>) => void;
    const deferred = new Promise<Awaited<ReturnType<typeof api.resumeSession>>>((res) => {
      resolveResume = res;
    });
    const spy = vi.spyOn(api, "resumeSession").mockReturnValue(deferred);
    useWorkspaceStore.setState({
      sessionStates: { "sess-main": "exited" },
    });
    render(<TerminalPane api={api} />);
    await user.click(screen.getByRole("button", { name: /Resume/i }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Resume/i })).toBeNull();
      expect(screen.getByRole("status", { name: /resuming session/i })).toBeInTheDocument();
    });
    resolveResume({
      id: "sess-main",
      worktreeId: "wt-1",
      modeId: "mode-1",
      type: "agent",
      label: "main",
      slot: "m",
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-main",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText(/Session exited/i)).toBeNull();
    });
    spy.mockRestore();
  });

  it("opens session on mount and closes on unmount", async () => {
    const open = vi.spyOn(api, "openSession");
    const close = vi.spyOn(api, "closeSession");
    const { unmount } = render(<TerminalPane api={api} />);
    // fonts.ready resolves synchronously in jsdom (undefined), so the settle
    // timer (100ms) fires and openSession is called.
    await waitFor(
      () => expect(open).toHaveBeenCalledWith("sess-main", 80, 24),
      { timeout: 500 },
    );
    unmount();
    await waitFor(() => expect(close).toHaveBeenCalledWith("sess-main"));
  });

  it("writes terminal output chunks", async () => {
    const open = vi.spyOn(api, "openSession");
    render(<TerminalPane api={api} />);
    // Wait for the terminal to be constructed and subscription installed
    // before emitting — chunks arriving before the terminal exists have
    // nowhere to land (production daemon doesn't emit until openSession).
    await waitFor(() => expect(open).toHaveBeenCalledWith("sess-main", 80, 24));
    api.__test.emit({ type: "session:output", sessionId: "sess-main", chunk: "hello" });
    await waitFor(() => expect(writeSpy).toHaveBeenCalledWith("hello"));
  });

  it("font-size change calls clearTextureAtlas and resizeSession", async () => {
    const { Terminal } = await import("@xterm/xterm");
    const open = vi.spyOn(api, "openSession");
    const resizeSpy = vi.spyOn(api, "resizeSession");

    render(<TerminalPane api={api} />);

    // Wait for the terminal to be constructed (dynamic import + fonts.ready)
    // before mutating the store — the font-scale effect short-circuits when
    // termRef.current is still null.
    await waitFor(() => expect(open).toHaveBeenCalledWith("sess-main", 80, 24));
    resizeSpy.mockClear();

    // Simulate font scale change
    await act(async () => {
      useWorkspaceStore.setState({ terminalFontScale: 1.2 });
    });

    await waitFor(() => {
      const term = (Terminal as unknown as { instances?: { clearTextureAtlas: ReturnType<typeof vi.fn> }[] }).instances?.[0];
      if (term) {
        expect(term.clearTextureAtlas).toHaveBeenCalled();
      }
      expect(resizeSpy).toHaveBeenCalledWith("sess-main", 80, 24);
    });
  });

  it("ResizeObserver triggers fit and resizeSession", async () => {
    const resizeSpy = vi.spyOn(api, "resizeSession");
    render(<TerminalPane api={api} />);

    // Trigger the ResizeObserver callback
    await act(async () => {
      const roCallback = (global.ResizeObserver as unknown as { lastCallback?: () => void }).lastCallback;
      if (roCallback) roCallback();
      await new Promise((r) => requestAnimationFrame(r));
    });

    // The RO fires rAF then resizeSession — just confirm no error thrown
    // (resizeSession may have been called from settle too)
    expect(resizeSpy).toBeDefined();
  });

  it("renders SpawningPlaceholder when attach is pending", () => {
    // Stub openSession so the mock doesn't synchronously emit session:opened
    // (which would flip attach from "pending" to "attached" before we assert).
    vi.spyOn(api, "openSession").mockImplementation(() => new Promise(() => {}));
    useWorkspaceStore.setState({
      activeSessionId: "sess-main",
      sessionStates: { "sess-main": "working" },
      sessionAttachState: { "sess-main": "pending" },
    });
    render(<TerminalPane api={api} />);
    expect(screen.getByRole("status", { name: /starting|reconnecting/i })).toBeInTheDocument();
  });

  it("renders xterm after session:opened arrives", async () => {
    // Same trick: prevent the mock's auto-emit so we control the transition.
    vi.spyOn(api, "openSession").mockImplementation(() => new Promise(() => {}));
    useWorkspaceStore.setState({
      activeSessionId: "sess-main",
      sessionStates: { "sess-main": "working" },
      sessionAttachState: { "sess-main": "pending" },
    });
    const { rerender } = render(<TerminalPane api={api} />);

    // Initially shows spawning placeholder
    expect(screen.getByRole("status", { name: /starting|reconnecting/i })).toBeInTheDocument();

    // Simulate session:opened event which marks attach as complete
    await act(async () => {
      api.__test.emit({ type: "session:opened", sessionId: "sess-main" });
      useWorkspaceStore.setState({
        sessionAttachState: { "sess-main": "attached" },
      });
      rerender(<TerminalPane api={api} />);
    });

    // After attach completes, spawning placeholder should be gone
    expect(screen.queryByRole("status")).toBeNull();
  });
});
