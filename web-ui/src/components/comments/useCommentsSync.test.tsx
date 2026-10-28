import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useWorkspaceStore } from "@/hooks/useStore";
import { makeComment } from "./testFixtures";
import { useCommentsSync } from "./useCommentsSync";
import { useCommentStore } from "./useCommentStore";

function Harness({ api }: { api: ReturnType<typeof createMockApi> }) {
  useCommentsSync(api);
  return null;
}

describe("useCommentsSync (4.T5)", () => {
  beforeEach(() => {
    useCommentStore.getState().reset();
    useWorkspaceStore.setState({ activeWorktreeId: "wt-1" });
  });

  it("loads the active scope on mount and applies comments:changed", async () => {
    const api = createMockApi();
    render(<Harness api={api} />);
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]?.status).toBe("ready"));
    await act(async () => {
      await api.createComment("wt-1", "worktree", {
        id: "n1",
        path: "src/App.tsx",
        pathKind: "repo",
        surface: "file",
        quote: "q",
        prefix: "",
        suffix: "",
        occurrence: 0,
        text: "hello",
        lineStart: 1,
      });
    });
    expect(useCommentStore.getState().byScope["wt-1"]!.comments.map((c) => c.id)).toEqual(["n1"]);
    await act(async () => {
      await api.deleteComment("n1");
    });
    expect(useCommentStore.getState().byScope["wt-1"]!.comments).toHaveLength(0);
  });

  it("refetches every loaded scope on ws:resync and on ws:open", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "listComments");
    render(<Harness api={api} />);
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]?.status).toBe("ready"));
    expect(spy).toHaveBeenCalledTimes(1);
    // a comment appears that no event told us about (a dropped broadcast)
    await api.createComment("wt-1", "worktree", { id: "late", path: "a.ts", pathKind: "repo", surface: "file", quote: "q", prefix: "", suffix: "", occurrence: 0, text: "t", lineStart: 1 });
    useCommentStore.getState().reset();
    useCommentStore.getState().replace("wt-1", "worktree", { comments: [], nextPin: 1, terminalDeliveries: [] });
    act(() => api.__test.emit({ type: "ws:resync" }));
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]!.comments.map((x) => x.id)).toEqual(["late"]));
    expect(spy).toHaveBeenCalledTimes(2);
    act(() => api.__test.emit({ type: "ws:open" } as never));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
  });

  it("applies terminal-delivery:updated to a loaded scope", async () => {
    const api = createMockApi();
    render(<Harness api={api} />);
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]?.status).toBe("ready"));
    act(() => api.__test.emit({ type: "terminal-delivery:updated", delivery: { id: "d", scopeKind: "worktree", scopeId: "wt-1", sessionId: "s", state: "pasting", commentIds: [], commentCount: 0, bytes: 0, updatedAt: "x" } }));
    expect(useCommentStore.getState().byScope["wt-1"]!.deliveries.d?.state).toBe("pasting");
  });

  it("a scope that is deleted is dropped", async () => {
    const api = createMockApi();
    render(<Harness api={api} />);
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]?.status).toBe("ready"));
    useCommentStore.getState().upsertLocal(makeComment());
    act(() => api.__test.emit({ type: "worktree:deleted", worktreeId: "wt-1" } as never));
    expect(useCommentStore.getState().byScope["wt-1"]).toBeUndefined();
  });

  it("a refetch merges a comments:changed that arrived while it was in flight (review 8)", async () => {
    const api = createMockApi();
    render(<Harness api={api} />);
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]?.status).toBe("ready"));
    const oldResp = { comments: [], nextPin: 1, terminalDeliveries: [] };
    const fresh = makeComment({ id: "restored", pin: 1 });
    let release!: (v: typeof oldResp) => void;
    const spy = vi
      .spyOn(api, "listComments")
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValue({ comments: [fresh], nextPin: 2, terminalDeliveries: [] });
    act(() => api.__test.emit({ type: "ws:open" } as never)); // reconnect: GET #1 starts (held)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    act(() =>
      api.__test.emit({ type: "comments:changed", scopeKind: "worktree", scopeId: "wt-1", upserted: [fresh], deleted: [] } as never),
    );
    expect(useCommentStore.getState().byScope["wt-1"]!.comments.map((c) => c.id)).toEqual(["restored"]);
    await act(async () => release(oldResp)); // the OLDER response lands afterwards
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2)); // superseded + refetched once
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]!.stale).toBe(false));
    expect(useCommentStore.getState().byScope["wt-1"]!.comments.map((c) => c.id)).toEqual(["restored"]);
  });

  it("W2-06 — a burst of events during a refetch does not restart it: one follow-up after the response lands", async () => {
    const api = createMockApi();
    render(<Harness api={api} />);
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]?.status).toBe("ready"));
    let release!: (v: { comments: []; nextPin: number; terminalDeliveries: [] }) => void;
    const spy = vi
      .spyOn(api, "listComments")
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValue({ comments: [], nextPin: 1, terminalDeliveries: [] });
    act(() => api.__test.emit({ type: "ws:open" } as never));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 3; i++) {
      const c = makeComment({ id: `burst${i}`, pin: i + 1 });
      act(() => api.__test.emit({ type: "comments:changed", scopeKind: "worktree", scopeId: "wt-1", upserted: [c], deleted: [] } as never));
    }
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => release({ comments: [], nextPin: 1, terminalDeliveries: [] }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]!.stale).toBe(false));
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
