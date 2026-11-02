import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { useWorkspaceStore } from "./useStore";
import { useWorktreeFocusHint } from "./useWorktreeFocusHint";

describe("useWorktreeFocusHint", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeWorktreeId: null });
  });

  it("fires once per opened worktree", () => {
    const api = createMockApi();
    const focus = vi.spyOn(api, "focusWorktree").mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useWorktreeFocusHint(api));
    expect(focus).not.toHaveBeenCalled();

    act(() => useWorkspaceStore.setState({ activeWorktreeId: "wt-1" }));
    rerender();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith("wt-1");

    // Re-rendering with the same opened worktree must not re-hint.
    rerender();
    rerender();
    expect(focus).toHaveBeenCalledTimes(1);

    act(() => useWorkspaceStore.setState({ activeWorktreeId: "wt-2" }));
    rerender();
    expect(focus).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenLastCalledWith("wt-2");

    // Closing the worktree (back to the dashboard) hints nothing.
    act(() => useWorkspaceStore.setState({ activeWorktreeId: null }));
    rerender();
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it("re-hints when the same worktree becomes opened again after null", () => {
    const api = createMockApi();
    const focus = vi.spyOn(api, "focusWorktree").mockResolvedValue(undefined);
    const { rerender } = renderHook(() => useWorktreeFocusHint(api));

    act(() => useWorkspaceStore.setState({ activeWorktreeId: "wt-a" }));
    rerender();
    act(() => useWorkspaceStore.setState({ activeWorktreeId: null }));
    rerender();
    act(() => useWorkspaceStore.setState({ activeWorktreeId: "wt-a" }));
    rerender();
    expect(focus).toHaveBeenCalledTimes(2);

    rerender();
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it("swallows a failed hint", async () => {
    const api = createMockApi();
    vi.spyOn(api, "focusWorktree").mockRejectedValue(new Error("offline"));

    const { rerender } = renderHook(() => useWorktreeFocusHint(api));
    act(() => useWorkspaceStore.setState({ activeWorktreeId: "wt-1" }));
    rerender();

    // Let the rejected promise settle; an unhandled rejection would fail the
    // test run.
    await Promise.resolve();
    expect(api.focusWorktree).toHaveBeenCalledTimes(1);
  });
});
