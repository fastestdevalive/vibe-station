import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import type { ApiInstance } from "@/api";
import { resetVcsCacheForTests, useVcsCacheStore, vcsKey } from "./vcsCacheStore";
import { useVcsSync } from "./useVcsSync";

type Handler = (ev: unknown) => void;

function fakeApi() {
  const handlers = new Map<string, Set<Handler>>();
  const api = {
    on(event: string, fn: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
  };
  const emit = (event: string, ev: unknown) => {
    for (const fn of handlers.get(event) ?? []) fn(ev);
  };
  return { api: api as unknown as ApiInstance, emit };
}

describe("useVcsSync", () => {
  beforeEach(() => {
    resetVcsCacheForTests();
  });

  it("worktree:head marks that worktree's entry stale", () => {
    const KEY = vcsKey("worktree", "wt1");
    useVcsCacheStore.getState().replace(KEY, [], 50);
    const { api, emit } = fakeApi();
    renderHook(() => useVcsSync(api));
    act(() => {
      emit("worktree:head", { type: "worktree:head", worktreeId: "wt1", headSha: "a", baseSha: "b", rev: 5 });
    });
    expect(useVcsCacheStore.getState().entries[KEY]!.stale).toBe(true);
  });

  it("ws:open and ws:resync mark every entry stale", () => {
    const A = vcsKey("worktree", "wt1");
    const B = vcsKey("worktree", "wt2");
    useVcsCacheStore.getState().replace(A, [], 50);
    useVcsCacheStore.getState().replace(B, [], 50);
    const { api, emit } = fakeApi();
    renderHook(() => useVcsSync(api));
    act(() => emit("ws:open", { type: "ws:open" }));
    expect(useVcsCacheStore.getState().entries[A]!.stale).toBe(true);
    expect(useVcsCacheStore.getState().entries[B]!.stale).toBe(true);
    useVcsCacheStore.getState().replace(A, [], 50);
    useVcsCacheStore.getState().replace(B, [], 50);
    act(() => emit("ws:resync", { type: "ws:resync" }));
    expect(useVcsCacheStore.getState().entries[A]!.stale).toBe(true);
    expect(useVcsCacheStore.getState().entries[B]!.stale).toBe(true);
  });
});
