import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/errors";
import type { Mode, Session } from "@/api/types";
import { useResetProgress } from "./useResetProgress";
import { resetErrorText, useSessionReset } from "./useSessionReset";

const session = { id: "s1" } as Session;
const modes = [
  { id: "m1", name: "Alpha", cli: "claude", context: "" },
  { id: "m2", name: "Beta", cli: "cursor", context: "" },
] as Mode[];
const modeErr = () =>
  new ApiError(JSON.stringify({ error: "Mode 'gone' not found", code: "mode_not_found" }), 400, "mode_not_found");

function Harness({ api, onDone }: { api: Parameters<typeof useSessionReset>[0]; onDone?: () => void }) {
  const { reset, modeDialog } = useSessionReset(api, onDone);
  return (
    <>
      <button type="button" onClick={() => reset(session, true)}>
        go
      </button>
      {modeDialog}
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  useResetProgress.setState({ active: {} });
});

describe("useSessionReset", () => {
  it("resets directly when the daemon accepts", async () => {
    const resetSession = vi.fn().mockResolvedValue({ ok: true });
    const onDone = vi.fn();
    render(<Harness api={{ resetSession, listModes: vi.fn() } as never} onDone={onDone} />);
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(resetSession).toHaveBeenCalledWith("s1", { handoff: true });
  });

  it("marks the session as resetting while a handoff is pending, then clears it", async () => {
    let finish: (v: unknown) => void = () => {};
    const resetSession = vi.fn().mockReturnValue(new Promise((r) => (finish = r)));
    render(<Harness api={{ resetSession, listModes: vi.fn() } as never} />);
    await userEvent.click(screen.getByText("go"));
    expect(useResetProgress.getState().active.s1).toBe("shown");
    finish({ ok: true });
    await waitFor(() => expect(useResetProgress.getState().active.s1).toBeUndefined());
  });

  it("does not mark a plain (non-handoff) reset as resetting", async () => {
    const resetSession = vi.fn().mockResolvedValue({ ok: true });
    function Plain() {
      const { reset } = useSessionReset({ resetSession, listModes: vi.fn() } as never);
      return (
        <button type="button" onClick={() => reset(session, false)}>
          plain
        </button>
      );
    }
    render(<Plain />);
    await userEvent.click(screen.getByText("plain"));
    expect(useResetProgress.getState().active.s1).toBeUndefined();
  });

  it("re-shows the progress overlay when Reset is clicked again after the user closed it", async () => {
    let finish: (v: unknown) => void = () => {};
    const resetSession = vi.fn().mockReturnValue(new Promise((r) => (finish = r)));
    render(<Harness api={{ resetSession, listModes: vi.fn() } as never} />);
    await userEvent.click(screen.getByText("go"));
    useResetProgress.getState().dismiss("s1");
    expect(useResetProgress.getState().active.s1).toBe("dismissed");
    await userEvent.click(screen.getByText("go"));
    expect(useResetProgress.getState().active.s1).toBe("shown");
    expect(resetSession).toHaveBeenCalledTimes(1);
    finish({ ok: true });
  });

  it("ignores a second reset for the same session while one is in flight", async () => {
    let finish: (v: unknown) => void = () => {};
    const resetSession = vi.fn().mockReturnValue(new Promise((r) => (finish = r)));
    render(<Harness api={{ resetSession, listModes: vi.fn() } as never} />);
    const btn = screen.getByText("go");
    await userEvent.click(btn);
    await userEvent.click(btn, { pointerEventsCheck: 0 });
    expect(resetSession).toHaveBeenCalledTimes(1);
    finish({ ok: true });
  });

  it("asks for a replacement mode on mode_not_found and retries with it", async () => {
    const resetSession = vi.fn().mockRejectedValueOnce(modeErr()).mockResolvedValueOnce({ ok: true });
    const listModes = vi.fn().mockResolvedValue(modes);
    render(<Harness api={{ resetSession, listModes } as never} />);
    await userEvent.click(screen.getByText("go"));
    expect(await screen.findByText(/Mode 'gone' not found/)).toBeTruthy();
    await userEvent.selectOptions(await screen.findByLabelText("Mode"), "m2");
    await userEvent.click(screen.getByText("Reset with this mode"));
    await waitFor(() => expect(resetSession).toHaveBeenCalledTimes(2));
    expect(resetSession).toHaveBeenLastCalledWith("s1", { handoff: true, modeId: "m2" });
  });

  it("alerts the daemon's error text for any other failure", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const resetSession = vi
      .fn()
      .mockRejectedValue(new ApiError(JSON.stringify({ error: "Session already archived" }), 400));
    render(<Harness api={{ resetSession, listModes: vi.fn() } as never} />);
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Session already archived"));
  });
});

describe("resetErrorText", () => {
  it("falls back to the raw message for non-JSON bodies", () => {
    expect(resetErrorText(new Error("boom"))).toBe("boom");
    expect(resetErrorText("x")).toBe("Failed to reset session.");
  });
});
