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

  it("onClick dispatches to the enable path when action is 'enable', chaining start (getHover)", async () => {
    vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "disabled",
      language: null,
      label: "Off",
      displayName: null,
      severity: "neutral",
      detail: "Code navigation is off for this workspace.",
      action: "enable",
      actionLabel: "Turn on",
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
    expect(hoverSpy).toHaveBeenCalledWith(
      expect.anything(),
      "worktree",
      "wt-1",
      { kind: "workspace", path: "main.rs" },
      0,
      0,
    );
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

  it("exposes the latched failure and dispatches 'retry' to restartLsp (on action, never on label)", async () => {
    const failure: lspApi.LspFailure = {
      kind: "missing_dependency",
      summary: "TypeScript isn't installed for this project — code navigation needs it.",
      message: null,
      remediation: [{ kind: "retry", label: "Retry" }],
      autoRetry: false,
    };
    const statusSpy = vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "error",
      language: "typescript",
      label: "Setup needed",
      displayName: "TypeScript / JavaScript",
      severity: "warn",
      detail: failure.summary,
      action: "retry",
      // Deliberately not "Retry": dispatch must follow `action`.
      actionLabel: "Try again",
      failure,
    });
    const restartSpy = vi.spyOn(lspApi, "restartLsp").mockResolvedValue({
      status: "starting",
      language: "typescript",
      label: "Starting",
      displayName: "TypeScript / JavaScript",
      severity: "warn",
      detail: "LSP: starting…",
      action: null,
      actionLabel: null,
    });
    const hoverSpy = vi.spyOn(lspApi, "getHover").mockResolvedValue({ empty: true });

    const { result } = renderHook(() => useLspStatus({}, "wt-1", "worktree", "src/a.ts"));
    await waitFor(() => expect(result.current.failure).toEqual(failure));
    const pollsBefore = statusSpy.mock.calls.length;

    await act(async () => {
      await result.current.onClick();
    });

    expect(restartSpy).toHaveBeenCalledWith({}, "worktree", "wt-1", "typescript");
    expect(hoverSpy).not.toHaveBeenCalled();
    // Re-polls right after the restart.
    expect(statusSpy.mock.calls.length).toBeGreaterThan(pollsBefore);
  });

  it("splits an info-level degraded note from a warning (info never reads as degraded)", async () => {
    const spy = vi.spyOn(lspApi, "getLspStatus").mockResolvedValue({
      status: "ready",
      language: "typescript",
      label: "Ready",
      displayName: "TypeScript / JavaScript",
      severity: "ok",
      detail: "LSP: ready",
      action: null,
      actionLabel: null,
      degraded: { message: "Using TypeScript 5.9.3 (global)", level: "info" },
    });
    const { result, rerender } = renderHook(({ path }) => useLspStatus({}, "wt-1", "worktree", path), {
      initialProps: { path: "a.ts" },
    });
    await waitFor(() => expect(result.current.info).toBe("Using TypeScript 5.9.3 (global)"));
    expect(result.current.degraded).toBeNull();

    // Absent level ≡ warning (today's rust-analyzer case).
    spy.mockResolvedValue({
      status: "ready",
      language: "rust",
      label: "Ready",
      displayName: "Rust",
      severity: "ok",
      detail: "LSP: ready",
      action: null,
      actionLabel: null,
      degraded: { message: "cargo metadata failed" },
    });
    rerender({ path: "b.rs" });
    await waitFor(() => expect(result.current.degraded).toBe("cargo metadata failed"));
    expect(result.current.info).toBeNull();
  });
  it("an on-demand refresh that resolves after the path changed does not overwrite the new path's status", async () => {
    const mk = (status: lspApi.LspStatus, language: string): lspApi.LspStatusResponse => ({
      status,
      language,
      label: status,
      displayName: language,
      severity: "ok",
      detail: status,
      action: null,
      actionLabel: null,
    });
    let resolveLate!: (v: lspApi.LspStatusResponse) => void;
    const spy = vi.spyOn(lspApi, "getLspStatus").mockResolvedValue(mk("ready", "rust"));
    // Stable api object: an inline `{}` would re-run the poll effect on every
    // render and mask the stale write this test is about.
    const api = {};
    const { result, rerender } = renderHook(({ p }) => useLspStatus(api, "wt-1", "worktree", p), {
      initialProps: { p: "a.rs" },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    spy.mockImplementationOnce(() => new Promise((r) => { resolveLate = r; }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refresh();
    });
    spy.mockResolvedValue(mk("indexing", "typescript"));
    rerender({ p: "b.ts" });
    await waitFor(() => expect(result.current.language).toBe("typescript"));

    await act(async () => {
      resolveLate(mk("error", "rust"));
      await pending;
    });
    expect(result.current.language).toBe("typescript");
    expect(result.current.status).toBe("indexing");
  });
});
