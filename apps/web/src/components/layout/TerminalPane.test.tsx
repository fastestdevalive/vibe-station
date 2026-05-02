import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { TerminalPane } from "./TerminalPane";
import { useWorkspaceStore } from "@/hooks/useStore";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: { fontSize: number } = { fontSize: 14 };
    rows = 24;
    element = null;
    open() {}
    write() {}
    writeln() {}
    reset() {}
    refresh() {}
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData(_cb: (d: string) => void) {
      return { dispose: () => {} };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

describe("TerminalPane", () => {
  const api = createMockApi();

  beforeEach(() => {
    useWorkspaceStore.setState({
      activeSessionId: "sess-main",
      sessionStates: { "sess-main": "working" },
    });
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
  });
});
