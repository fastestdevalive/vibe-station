import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UpdateStatus } from "@/api/types";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import { useDaemonRestart } from "./useDaemonRestart";

vi.mock("@/api/update", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/update")>()),
  restartDaemon: vi.fn(),
}));
import { restartDaemon } from "@/api/update";

const STATUS: UpdateStatus = {
  current: "1.0.0",
  latest: "1.2.3",
  behindCount: 1,
  updateAvailable: true,
  skipped: [],
  installMethod: "curl",
  targets: [],
  autoCheck: true,
  platform: "linux-x86_64",
  noAsset: false,
  restartPending: { kind: "daemon", version: "1.2.3" },
};
const IMPACT = [{ sessionId: "s1", name: "A", kind: "working" as const }];

beforeEach(() => {
  vi.mocked(restartDaemon).mockReset();
  useUpdateStore.setState({ status: STATUS, canInstall: true, restarting: false });
});

describe("useDaemonRestart", () => {
  it("loads the impact list with a dry run while a daemon restart is pending", async () => {
    vi.mocked(restartDaemon).mockResolvedValue({ kind: "impact", impact: IMPACT });
    const { result } = renderHook(() => useDaemonRestart());
    await waitFor(() => expect(result.current.impact).toEqual(IMPACT));
    expect(restartDaemon).toHaveBeenCalledWith({ dryRun: true });
  });

  it("makes no request when disabled, read-only, or the pending restart is the app's", () => {
    renderHook(() => useDaemonRestart({ enabled: false }));
    useUpdateStore.setState({ canInstall: false });
    renderHook(() => useDaemonRestart());
    useUpdateStore.setState({ canInstall: true, status: { ...STATUS, restartPending: { kind: "app", version: "1.2.3" } } });
    renderHook(() => useDaemonRestart());
    expect(restartDaemon).not.toHaveBeenCalled();
  });

  it("accepted: raises the restart overlay and calls onAccepted", async () => {
    vi.mocked(restartDaemon).mockResolvedValue({ kind: "accepted" });
    const onAccepted = vi.fn();
    const { result } = renderHook(() => useDaemonRestart({ enabled: false, onAccepted }));
    await act(() => result.current.restart());
    expect(useUpdateStore.getState().restarting).toBe(true);
    expect(onAccepted).toHaveBeenCalled();
  });

  it("busy: asks for confirmation, then Later leaves the confirmation", async () => {
    vi.mocked(restartDaemon).mockResolvedValue({ kind: "busy", impact: IMPACT });
    const { result } = renderHook(() => useDaemonRestart({ enabled: false }));
    await act(() => result.current.restart());
    expect(result.current.confirming).toBe(true);
    expect(result.current.impact).toEqual(IMPACT);
    act(() => result.current.cancelConfirm());
    expect(result.current.confirming).toBe(false);
  });

  it("error outcome: exposes the per-reason copy; a thrown request is a non-terminal error", async () => {
    vi.mocked(restartDaemon).mockResolvedValueOnce({ kind: "error", code: "tauri_hosted" });
    const { result } = renderHook(() => useDaemonRestart({ enabled: false }));
    await act(() => result.current.restart());
    expect(result.current.error).toEqual({ message: "Quit & relaunch vibe-station to finish.", terminal: true });

    vi.mocked(restartDaemon).mockRejectedValueOnce(new Error("down"));
    await act(() => result.current.restart());
    expect(result.current.error?.terminal).toBe(false);
    expect(result.current.busy).toBe(false);
  });
});
