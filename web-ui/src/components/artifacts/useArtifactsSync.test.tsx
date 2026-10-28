import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useServerStore } from "@/hooks/useServerStore";
import type { ArtifactListResponse, Worktree } from "@/api/types";
import { useArtifactsStore } from "./artifactsStore";
import { ensureArtifactScope, useArtifactsSync, useArtifactScope } from "./useArtifactsSync";
import { makeRow, upsert } from "./testFixtures";

const st = () => useArtifactsStore.getState();

function listResponse(rev = 1): ArtifactListResponse {
  return { rev, cap: 500, total: 1, items: [makeRow({ id: "a" })] };
}

function setup() {
  const api = createMockApi();
  const list = vi.spyOn(api, "listArtifacts").mockImplementation(async () => listResponse());
  return { api, list };
}

beforeEach(() => {
  st().reset();
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
});

describe("useArtifactsSync (6.T2)", () => {
  it("fetches a scope on first need, once", async () => {
    const { api, list } = setup();
    renderHook(() => useArtifactScope(api, "worktree", "wt1"));
    renderHook(() => useArtifactScope(api, "worktree", "wt1"));
    await waitFor(() => expect(st().byScope.wt1?.status).toBe("ready"));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("wt1", "worktree");
  });

  it("refetches every loaded scope on ws:open and on ws:resync", async () => {
    const { api, list } = setup();
    renderHook(() => useArtifactsSync(api));
    ensureArtifactScope(api, "worktree", "wt1");
    ensureArtifactScope(api, "project", "p1");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(st().byScope.p1?.status).toBe("ready"));

    act(() => api.__test.emit({ type: "ws:open" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(st().byScope.wt1?.stale).toBe(false));

    act(() => api.__test.emit({ type: "ws:resync" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(6));
  });

  it("applies events for a loaded scope and ignores other scopes", async () => {
    const { api } = setup();
    renderHook(() => useArtifactsSync(api));
    ensureArtifactScope(api, "worktree", "wt1");
    await waitFor(() => expect(st().byScope.wt1?.status).toBe("ready"));
    act(() => {
      api.__test.emit({ type: "artifact:upserted", scopeKind: "worktree", scopeId: "wt1", rev: 2, rows: [upsert({ id: "n" }, true)] });
      api.__test.emit({ type: "artifact:upserted", scopeKind: "worktree", scopeId: "zzz", rev: 1, rows: [upsert({ id: "q", scopeId: "zzz" }, true)] });
    });
    expect(st().byScope.wt1!.rows.map((r) => r.id).sort()).toEqual(["a", "n"]);
    expect(st().byScope.zzz).toBeUndefined();
  });

  it("a rev gap triggers a refetch", async () => {
    const { api, list } = setup();
    renderHook(() => useArtifactsSync(api));
    ensureArtifactScope(api, "worktree", "wt1");
    await waitFor(() => expect(st().byScope.wt1?.status).toBe("ready"));
    act(() => api.__test.emit({ type: "artifact:removed", scopeKind: "worktree", scopeId: "wt1", rev: 7, ids: ["a"], reason: "removed" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("drops the scope on worktree:deleted and project:deleted", async () => {
    const { api } = setup();
    renderHook(() => useArtifactsSync(api));
    ensureArtifactScope(api, "worktree", "wt1");
    ensureArtifactScope(api, "project", "p1");
    await waitFor(() => expect(st().byScope.p1?.status).toBe("ready"));
    act(() => api.__test.emit({ type: "worktree:deleted", worktreeId: "wt1" }));
    expect(st().byScope.wt1).toBeUndefined();
    act(() => api.__test.emit({ type: "project:deleted", projectId: "p1" }));
    expect(st().byScope.p1).toBeUndefined();
  });

  it("drops a worktree scope when the server store loses that worktree (project cascade)", async () => {
    const { api } = setup();
    renderHook(() => useArtifactsSync(api));
    const wt = { id: "wt1", projectId: "p1" } as Worktree;
    act(() => useServerStore.setState({ worktrees: [wt], loaded: true }));
    ensureArtifactScope(api, "worktree", "wt1");
    await waitFor(() => expect(st().byScope.wt1?.status).toBe("ready"));
    act(() => useServerStore.setState({ worktrees: [] }));
    expect(st().byScope.wt1).toBeUndefined();
  });

  it("a failed list leaves an error scope with no rows", async () => {
    const { api, list } = setup();
    list.mockRejectedValueOnce(new Error("daemon down"));
    ensureArtifactScope(api, "worktree", "wt1");
    await waitFor(() => expect(st().byScope.wt1?.status).toBe("error"));
    expect(st().byScope.wt1!.rows).toEqual([]);
  });

  it("a refetch does not roll the list back past an event applied while it was in flight (review 14)", async () => {
    const { api, list } = setup();
    renderHook(() => useArtifactsSync(api));
    ensureArtifactScope(api, "worktree", "wt1");
    await waitFor(() => expect(st().byScope.wt1?.status).toBe("ready"));
    let release!: (r: ArtifactListResponse) => void;
    list.mockImplementationOnce(() => new Promise((r) => (release = r)));
    list.mockImplementation(async () => ({ rev: 2, cap: 500, total: 2, items: [makeRow({ id: "a" }), makeRow({ id: "n" })] }));
    act(() => api.__test.emit({ type: "ws:open" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    act(() => api.__test.emit({ type: "artifact:upserted", scopeKind: "worktree", scopeId: "wt1", rev: 2, rows: [upsert({ id: "n" }, true)] }));
    await act(async () => release(listResponse(1))); // older (rev 1) response lands after the event
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3)); // refetched once
    await waitFor(() => expect(st().byScope.wt1?.stale).toBe(false));
    expect(st().byScope.wt1!.rows.map((r) => r.id).sort()).toEqual(["a", "n"]);
    expect(st().byScope.wt1!.rev).toBe(2);
  });

  it("W2-06 — ws:open / gap events during a refetch do not restart it: one follow-up after the response lands", async () => {
    const { api, list } = setup();
    renderHook(() => useArtifactsSync(api));
    ensureArtifactScope(api, "worktree", "wt1");
    await waitFor(() => expect(st().byScope.wt1?.status).toBe("ready"));
    let release!: (v: ArtifactListResponse) => void;
    list.mockImplementationOnce(() => new Promise((r) => (release = r)));
    act(() => api.__test.emit({ type: "ws:open" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    act(() => api.__test.emit({ type: "ws:open" }));
    act(() => api.__test.emit({ type: "ws:resync" }));
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => release(listResponse()));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(st().byScope.wt1?.stale).toBe(false));
    expect(list).toHaveBeenCalledTimes(3);
  });
});
