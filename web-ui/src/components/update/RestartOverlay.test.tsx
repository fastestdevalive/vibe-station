import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RestartOverlay } from "./RestartOverlay";
import { ConnectionStatus } from "@/components/layout/ConnectionStatus";
import { OfflineOverlay } from "@/components/layout/OfflineOverlay";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import type { ApiInstance } from "@/api";

function makeMockApi(initialBootId = "boot-1") {
  const connState = "disconnected";
  const listeners = new Set<(s: unknown) => void>();
  return {
    health: vi.fn().mockResolvedValue({ bootId: initialBootId, version: "1.0.0" }),
    getConnectionState: vi.fn(() => connState),
    subscribeConnection: vi.fn((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    retryConnection: vi.fn(),
  } as unknown as ApiInstance;
}

describe("RestartOverlay", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sessionStorage.clear();
    useUpdateStore.setState({ restarting: false, loadBootId: null });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: vi.fn() },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("renders null when not restarting", () => {
    const api = makeMockApi();
    render(<RestartOverlay api={api} />);
    expect(screen.queryByTestId("restart-overlay")).toBeNull();
  });

  it("polls health until bootId changes then calls reload and sets vst:restartedAt", async () => {
    const api = makeMockApi("boot-1");
    useUpdateStore.setState({ restarting: true });

    render(<RestartOverlay api={api} />);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Restarting vibe-station…")).toBeInTheDocument();

    // Initial health call
    await vi.waitFor(() => expect(api.health).toHaveBeenCalled());

    // Next health call returns new bootId
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      port: 1234,
      bootId: "boot-2",
      version: "1.0.1",
    });

    // Advance 500ms for polling
    await vi.advanceTimersByTimeAsync(500);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("vst:restartedAt")).not.toBeNull();
  });

  it("reloads against the page-load bootId even if the daemon is already down when the overlay mounts", async () => {
    const api = makeMockApi("boot-1");
    vi.mocked(api.health).mockRejectedValue(new Error("down"));
    useUpdateStore.setState({ restarting: true, loadBootId: "boot-1" });

    render(<RestartOverlay api={api} />);
    await vi.advanceTimersByTimeAsync(1500);
    expect(window.location.reload).not.toHaveBeenCalled();

    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      port: 1234,
      bootId: "boot-2",
      version: "1.0.1",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("timeout after 75s shows 'vibe-station didn't come back' and Retry restarts polling", async () => {
    const api = makeMockApi("boot-1");
    // Make health reject so bootId never changes
    vi.mocked(api.health).mockRejectedValue(new Error("down"));
    useUpdateStore.setState({ restarting: true });

    render(<RestartOverlay api={api} />);

    // Advance past 75s in steps to trigger the polling intervals
    for (let i = 0; i < 155; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(await screen.findByText("vibe-station didn't come back")).toBeInTheDocument();
    expect(screen.getByText("vst open")).toBeInTheDocument();
    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).toBeInTheDocument();

    // Click retry
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const callsBeforeRetry = vi.mocked(api.health).mock.calls.length;
    await user.click(retryBtn);

    expect(screen.getByText("Restarting vibe-station…")).toBeInTheDocument();

    // Polling really restarted: health is called again and a new boot reloads.
    vi.mocked(api.health).mockResolvedValue({ ok: true, port: 1234, bootId: "boot-2", version: "1.0.1" });
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(api.health).mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("with no baseline, health failing then succeeding counts as a new boot", async () => {
    const api = makeMockApi();
    vi.mocked(api.health)
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ ok: true, port: 1234, bootId: "b2", version: "1.0.1" });
    useUpdateStore.setState({ restarting: true, loadBootId: null });

    render(<RestartOverlay api={api} />);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(window.location.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("a hanging health request cannot stall the 75 s timeout", async () => {
    const api = makeMockApi();
    vi.mocked(api.health).mockReturnValue(new Promise(() => {}));
    useUpdateStore.setState({ restarting: true, loadBootId: "boot-1" });

    render(<RestartOverlay api={api} />);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(await screen.findByText("vibe-station didn't come back")).toBeInTheDocument();
  });

  it("focus moves into the dialog, onto Retry after the timeout; aria-busy clears; app is inert", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.appendChild(appRoot);
    try {
      const api = makeMockApi();
      vi.mocked(api.health).mockRejectedValue(new Error("down"));
      useUpdateStore.setState({ restarting: true, loadBootId: "boot-1" });

      const { unmount } = render(<RestartOverlay api={api} />);
      const dialog = screen.getByRole("alertdialog");
      expect(dialog).toHaveAttribute("aria-busy", "true");
      expect(dialog.querySelector(".restart-overlay__content")).toBe(document.activeElement);
      expect(appRoot).toHaveAttribute("inert");
      expect(screen.getByText(/Terminal \(tmux\) sessions keep running\./)).toBeInTheDocument();
      expect(screen.queryByText(/logins are preserved/)).toBeNull();

      // The deadline timer sets state outside React's batching; wrap it in act so the
      // re-render AND the focus effect are flushed before we assert (no reliance on
      // the scheduler, which is not driven by fake timers under load).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(75_000);
      });
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(document.activeElement).toBe(retry);
      expect(screen.getByRole("alertdialog")).toHaveAttribute("aria-busy", "false");

      unmount();
      expect(appRoot).not.toHaveAttribute("inert");
    } finally {
      appRoot.remove();
    }
  });

  it("ConnectionStatus and OfflineOverlay render null while restarting", () => {
    const api = makeMockApi();
    useUpdateStore.setState({ restarting: true });

    const { container: connContainer } = render(<ConnectionStatus />);
    expect(connContainer.firstChild).toBeNull();

    const { container: offlineContainer } = render(<OfflineOverlay api={api} />);
    expect(offlineContainer.firstChild).toBeNull();
  });
});
