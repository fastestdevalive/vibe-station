import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import * as lspApi from "@/lib/lspApi";
import { useLspStatus } from "./useLspStatus";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useLspStatus", () => {
  it("passes through backend label/displayName/severity/detail/action/actionLabel unchanged", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "stopped",
      language: "rust",
      label: "Stopped",
      displayName: "Rust",
      severity: "neutral",
      detail: "LSP: stopped — click to resume",
      action: "resume",
      actionLabel: "Resume",
    });

    const { result } = renderHook(() => useLspStatus({}, "wt-1", "worktree", "main.rs"));

    await waitFor(() => expect(result.current.status).toBe("stopped"));

    expect(result.current.label).toBe("Stopped");
    expect(result.current.displayName).toBe("Rust");
    expect(result.current.severity).toBe("neutral");
    expect(result.current.text).toBe("LSP: stopped — click to resume");
    expect(result.current.action).toBe("resume");
    expect(result.current.actionLabel).toBe("Resume");
  });

  it("onClick dispatches to the resume path (getHover) when action is 'resume', keyed on action not actionLabel", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "stopped",
      language: "rust",
      label: "Stopped",
      displayName: "Rust",
      severity: "neutral",
      // actionLabel deliberately says something else — dispatch must still
      // follow `action`, never this string.
      detail: "LSP: stopped — click to resume",
      action: "resume",
      actionLabel: "Turn back on",
    });
    const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({ empty: true });

    const { result } = renderHook(() => useLspStatus({}, "wt-1", "worktree", "main.rs"));
    await waitFor(() => expect(result.current.status).toBe("stopped"));

    await act(async () => {
      await result.current.onClick();
    });

    expect(hoverSpy).toHaveBeenCalled();
  });

  it("onClick dispatches to the enable path when action is 'enable'", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "disabled",
      language: null,
      label: "Disabled",
      displayName: null,
      severity: "neutral",
      detail: "LSP is disabled for this workspace — click to enable.",
      action: "enable",
      actionLabel: "Enable",
    });
    const setWorktreeLspEnabled = vi.fn().mockResolvedValue(undefined);
    const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({ empty: true });

    const { result } = renderHook(() =>
      useLspStatus({ setWorktreeLspEnabled }, "wt-1", "worktree", "main.rs")
    );
    await waitFor(() => expect(result.current.status).toBe("disabled"));

    await act(async () => {
      await result.current.onClick();
    });

    expect(setWorktreeLspEnabled).toHaveBeenCalledWith("wt-1", true);
    expect(hoverSpy).not.toHaveBeenCalled();
  });

  it("onClick is a no-op when action is null", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "ready",
      language: "rust",
      label: "Ready",
      displayName: "Rust",
      severity: "ok",
      detail: "LSP: ready",
      action: null,
      actionLabel: null,
    });
    const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({ empty: true });

    const { result } = renderHook(() => useLspStatus({}, "wt-1", "worktree", "main.rs"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.onClick();
    });

    expect(hoverSpy).not.toHaveBeenCalled();
  });
});
