import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { api } from "@/api";
import { useOpenFilesChanged } from "@/hooks/usePendingFileOpens";
import { useWorkspaceStore } from "@/hooks/useStore";
import type { WSEvent } from "@/api/types";

// Review Fix E: the `openFiles:changed` subscription was previously scoped to
// the FilesPanel (via usePendingFileOpens), so a CLI-driven open/close made
// while a different tool panel was open never reached the store. It now lives
// in useOpenFilesChanged, an ALWAYS-MOUNTED hook invoked once near the app
// root. This test confirms the relocated subscription still fires and applies.
describe("useOpenFilesChanged (review Fix E)", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({ openFileTabsByWorktree: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscribes unconditionally and replaces the scoped tab list on openFiles:changed", () => {
    let handler: ((ev: WSEvent) => void) | null = null;
    const onSpy = vi.spyOn(api, "on").mockImplementation(((event: unknown, cb: (ev: WSEvent) => void) => {
      if (event === "openFiles:changed") handler = cb;
      return () => {};
    }) as never);

    renderHook(() => useOpenFilesChanged(api));

    // No worktree/project argument — the hook is panel-independent.
    expect(onSpy).toHaveBeenCalledWith("openFiles:changed", expect.any(Function));

    // A CLI-driven open on another client echoes back for the worktree scope.
    handler!({ type: "openFiles:changed", worktreeId: "wt-1", paths: ["/a.ts", "/b.ts"] } as WSEvent);
    expect(useWorkspaceStore.getState().openFileTabsByWorktree["wt-1"]).toEqual(["/a.ts", "/b.ts"]);

    // And for a project scope.
    handler!({ type: "openFiles:changed", projectId: "proj-1", paths: ["/c.ts"] } as WSEvent);
    expect(useWorkspaceStore.getState().openFileTabsByWorktree["proj-1"]).toEqual(["/c.ts"]);
  });

  function capture() {
    let handler: ((ev: WSEvent) => void) | null = null;
    vi.spyOn(api, "on").mockImplementation(((event: unknown, cb: (ev: WSEvent) => void) => {
      if (event === "openFiles:changed") handler = cb;
      return () => {};
    }) as never);
    renderHook(() => useOpenFilesChanged(api));
    return (paths: string[]) => handler!({ type: "openFiles:changed", worktreeId: "wt-1", paths } as WSEvent);
  }

  it("keeps the active tab pointing at the same file when the echo reorders", () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      openFileTabsByWorktree: { "wt-1": ["a", "b", "c"] },
      activeFileTabIdxByWorktree: { "wt-1": 2 },
      activeFilePath: "c",
      peekFile: null,
    });
    capture()(["c", "a", "b"]);
    const s = useWorkspaceStore.getState();
    expect(s.activeFileTabIdxByWorktree["wt-1"]).toBe(0);
    expect(s.openFileTabsByWorktree["wt-1"]![0]).toBe("c");
    expect(s.activeFilePath).toBe("c");
  });

  it("clamps the index and follows it with activeFilePath when the active path is gone", () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      openFileTabsByWorktree: { "wt-1": ["a", "b", "c"] },
      activeFileTabIdxByWorktree: { "wt-1": 2 },
      activeFilePath: "c",
      peekFile: null,
    });
    capture()(["a", "b"]);
    const s = useWorkspaceStore.getState();
    expect(s.activeFileTabIdxByWorktree["wt-1"]).toBe(1);
    expect(s.activeFilePath).toBe("b");
  });
  it("a replaced tab does not resurrect from the daemon echo (2.T4)", async () => {
    const { createMockApi } = await import("@/api/mock");
    const mock = createMockApi();
    await mock.openFileDurable("wt-1", "/a");
    await mock.openFileDurable("wt-1", "/b");
    vi.spyOn(api, "openFileDurable").mockImplementation((...args) => mock.openFileDurable(...args));
    const emit = capture();
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeDirectContextId: null,
      openFileTabsByWorktree: { "wt-1": ["/a", "/b"] },
      activeFileTabIdxByWorktree: { "wt-1": 0 },
    });
    const spy = vi.mocked(api.openFileDurable);
    useWorkspaceStore.getState().setActiveFile("/c");
    const res = await spy.mock.results[0]!.value;
    expect(res.paths).toEqual(["/c", "/b"]);
    emit(res.paths);
    expect(useWorkspaceStore.getState().openFileTabsByWorktree["wt-1"]).toEqual(["/c", "/b"]);
  });
});
