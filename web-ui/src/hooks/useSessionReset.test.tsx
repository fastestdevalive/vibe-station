import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/errors";
import type { Session } from "@/api/types";
import { usePaneDialogs } from "./usePaneDialogs";
import { useResetProgress } from "./useResetProgress";
import { resetErrorText, useSessionReset, __resetForDemo } from "./useSessionReset";

const session = { id: "s1" } as Session;

function Harness({
  api,
  opts,
  onDone,
}: {
  api: Parameters<typeof useSessionReset>[0];
  opts?: Parameters<ReturnType<typeof useSessionReset>["run"]>[1];
  onDone?: () => void;
}) {
  const { run } = useSessionReset(api, onDone);
  return (
    <button type="button" onClick={() => run(session.id, opts)}>
      go
    </button>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  useResetProgress.setState({ active: {} });
  usePaneDialogs.getState()._reset();
  __resetForDemo();
});

describe("useSessionReset", () => {
  it("sends the new carryOver body (summary) and marks the summary wait", async () => {
    let finish: (v: unknown) => void = () => {};
    const resetSession = vi.fn().mockReturnValue(new Promise((r) => (finish = r)));
    const onDone = vi.fn();
    render(<Harness api={{ resetSession } as never} opts={{ carryOver: "summary" }} onDone={onDone} />);
    await userEvent.click(screen.getByText("go"));
    expect(resetSession).toHaveBeenCalledWith("s1", { carryOver: "summary" });
    expect(useResetProgress.getState().active.s1).toBe("summary");
    finish({ ok: true });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    await waitFor(() => expect(useResetProgress.getState().active.s1).toBeUndefined());
  });

  it("does not show the bar for a Nothing (none) start", async () => {
    const resetSession = vi.fn().mockResolvedValue({ ok: true });
    render(<Harness api={{ resetSession } as never} opts={{ carryOver: "none" }} />);
    await userEvent.click(screen.getByText("go"));
    expect(useResetProgress.getState().active.s1).toBeUndefined();
    expect(resetSession).toHaveBeenCalledWith("s1", { carryOver: "none" });
  });

  it("shows the waiting bar for whenBusy=wait", async () => {
    let finish: (v: unknown) => void = () => {};
    const resetSession = vi.fn().mockReturnValue(new Promise((r) => (finish = r)));
    render(<Harness api={{ resetSession } as never} opts={{ carryOver: "none", whenBusy: "wait" }} />);
    await userEvent.click(screen.getByText("go"));
    expect(useResetProgress.getState().active.s1).toBe("waiting");
    expect(resetSession).toHaveBeenCalledWith("s1", { carryOver: "none", whenBusy: "wait" });
    finish({ ok: true });
  });

  it("ignores a second reset for the same session while one is in flight", async () => {
    let finish: (v: unknown) => void = () => {};
    const resetSession = vi.fn().mockReturnValue(new Promise((r) => (finish = r)));
    render(<Harness api={{ resetSession } as never} opts={{ carryOver: "summary" }} />);
    const btn = screen.getByText("go");
    await userEvent.click(btn);
    await userEvent.click(btn, { pointerEventsCheck: 0 });
    expect(resetSession).toHaveBeenCalledTimes(1);
    finish({ ok: true });
  });

  it("stores the mode-retry prompt in usePaneDialogs and retries with the picked mode", async () => {
    const resetSession = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(JSON.stringify({ error: "Mode 'gone' not found", code: "mode_not_found" }), 400, "mode_not_found"),
      )
      .mockResolvedValueOnce({ ok: true });
    render(<Harness api={{ resetSession } as never} opts={{ carryOver: "summary" }} />);
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(usePaneDialogs.getState().modePrompts.s1).toBeTruthy());
    const prompt = usePaneDialogs.getState().modePrompts.s1!;
    expect(prompt.reason).toContain("Mode 'gone' not found");
    expect(prompt.options.carryOver).toBe("summary");

    usePaneDialogs.getState().clearModePrompt("s1");
    // Retry is just run() with the picked mode (what PaneDialogHost does).
    function Retry() {
      const { run } = useSessionReset({ resetSession } as never);
      return (
        <button type="button" onClick={() => run("s1", { ...prompt.options, modeId: "m2" })}>
          retry
        </button>
      );
    }
    render(<Retry />);
    await userEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(resetSession).toHaveBeenCalledTimes(2));
    expect(resetSession).toHaveBeenLastCalledWith("s1", { carryOver: "summary", modeId: "m2" });
  });

  it("stores the fallback notice for reset_cancelled (survives a host unmount)", async () => {
    const resetSession = vi
      .fn()
      .mockRejectedValue(new ApiError(JSON.stringify({ error: "Cancelled", code: "reset_cancelled" }), 409, "reset_cancelled"));
    const onDone = vi.fn();
    const { unmount } = render(
      <Harness api={{ resetSession } as never} opts={{ carryOver: "summary" }} onDone={onDone} />,
    );
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(usePaneDialogs.getState().notices.s1).toBeTruthy());
    expect(usePaneDialogs.getState().notices.s1!.text).not.toMatch(/reset|handoff/i);
    unmount();
    // The notice lives in the store, not in the unmounted host's state.
    expect(usePaneDialogs.getState().notices.s1).toBeTruthy();
    expect(useResetProgress.getState().active.s1).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("runs the fallback with transcript", async () => {
    const resetSession = vi.fn().mockResolvedValue({ ok: true });
    function Fallback() {
      const { run } = useSessionReset({ resetSession } as never);
      return (
        <button type="button" onClick={() => run("s1", { carryOver: "transcript" })}>
          fallback
        </button>
      );
    }
    render(<Fallback />);
    await userEvent.click(screen.getByText("fallback"));
    await waitFor(() => expect(resetSession).toHaveBeenCalledWith("s1", { carryOver: "transcript" }));
  });

  it("alerts the daemon's error text for any other failure", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const resetSession = vi
      .fn()
      .mockRejectedValue(new ApiError(JSON.stringify({ error: "Session already archived" }), 400));
    render(<Harness api={{ resetSession } as never} opts={{ carryOver: "none" }} />);
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Session already archived"));
    expect(usePaneDialogs.getState().notices.s1).toBeUndefined();
  });

  it("accepts a second reset after a failure releases the in-flight lock", async () => {
    vi.spyOn(window, "alert").mockImplementation(() => {});
    const resetSession = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(JSON.stringify({ error: "boom" }), 400))
      .mockResolvedValueOnce({ ok: true });
    render(<Harness api={{ resetSession } as never} opts={{ carryOver: "none" }} />);
    const btn = screen.getByText("go");
    await userEvent.click(btn);
    await waitFor(() => expect(resetSession).toHaveBeenCalledTimes(1));
    await userEvent.click(btn);
    await waitFor(() => expect(resetSession).toHaveBeenCalledTimes(2));
  });

  it("closes the pane dialog and clears stale prompts when a run starts", async () => {
    const resetSession = vi.fn().mockResolvedValue({ ok: true });
    usePaneDialogs.getState().open("s1", "fresh");
    usePaneDialogs.getState().setModePrompt({ sessionId: "s1", reason: "x", options: {} });
    render(<Harness api={{ resetSession } as never} opts={{ carryOver: "none" }} />);
    await userEvent.click(screen.getByText("go"));
    expect(usePaneDialogs.getState().dialogs.s1).toBeUndefined();
    expect(usePaneDialogs.getState().modePrompts.s1).toBeUndefined();
  });
});

describe("resetErrorText", () => {
  it("falls back to the raw message for non-JSON bodies", () => {
    expect(resetErrorText(new Error("boom"))).toBe("boom");
    expect(resetErrorText("x")).toBe("Failed to start a fresh session.");
  });
});
