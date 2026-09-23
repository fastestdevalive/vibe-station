import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConnectionStatus } from "./ConnectionStatus";
import { api } from "@/api";
import type { ConnectionState } from "@/api";

describe("ConnectionStatus (Phase 3.T1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders null when state is online", () => {
    vi.spyOn(api, "getConnectionState").mockReturnValue("online");
    vi.spyOn(api, "subscribeConnection").mockImplementation((handler) => {
      handler("online");
      return () => {};
    });

    const { container } = render(<ConnectionStatus />);
    expect(container.firstChild).toBeNull();
  });

  it("renders Reconnecting… when state drops to offline after being online", () => {
    let currentHandler: ((s: ConnectionState) => void) | null = null;
    vi.spyOn(api, "getConnectionState").mockReturnValue("online");
    vi.spyOn(api, "subscribeConnection").mockImplementation((handler) => {
      currentHandler = handler;
      handler("online");
      return () => { currentHandler = null; };
    });

    render(<ConnectionStatus />);

    // Now connection drops to offline
    act(() => {
      currentHandler?.("offline");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("3.T1: renders Disconnected label + Retry button when state is disconnected, and clicking Retry calls api.retryConnection", async () => {
    const user = userEvent.setup();
    let currentHandler: ((s: ConnectionState) => void) | null = null;
    vi.spyOn(api, "getConnectionState").mockReturnValue("disconnected");
    vi.spyOn(api, "subscribeConnection").mockImplementation((handler) => {
      currentHandler = handler;
      handler("disconnected");
      return () => {
        currentHandler = null;
      };
    });
    const retrySpy = vi.spyOn(api, "retryConnection").mockImplementation(() => {});

    render(<ConnectionStatus />);

    const pill = screen.getByRole("status");
    expect(pill).toHaveClass("conn-pill--disconnected");
    expect(screen.getByText("Disconnected")).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: /retry connection/i });
    expect(retryBtn).toBeInTheDocument();

    await user.click(retryBtn);
    expect(retrySpy).toHaveBeenCalledTimes(1);

    // If connection transitions back to connecting/online
    act(() => {
      currentHandler?.("connecting");
    });
    expect(screen.queryByRole("button", { name: /retry connection/i })).toBeNull();
  });
});
