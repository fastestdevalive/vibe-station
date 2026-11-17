import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "./backgroundStore";
import { SCOPE_SWEEP_DELAY_MS, useScopeSweep } from "./useScopeSweep";

function Harness() {
  useScopeSweep();
  return null;
}

function worktree(id: string): Worktree {
  return {
    id,
    projectId: "p1",
    branch: `b-${id}`,
    baseBranch: "main",
    pinnedAt: null,
    hiddenAt: null,
  } as Worktree;
}

function project(id: string): Project {
  return { id, name: id, path: `/tmp/${id}`, prefix: id, isGit: true } as Project;
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetBackgroundStoreForTests();
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
});

afterEach(() => {
  vi.useRealTimers();
  __resetBackgroundStoreForTests();
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
});

describe("useScopeSweep", () => {
  it("prunes deleted scopes after 30 s", () => {
    const store = getBackgroundStore();
    store.writeSeedIfAbsent("worktree:w1", "wp-001");
    store.writeSeedIfAbsent("worktree:w2", "wp-001");
    store.writeSeedIfAbsent("project:p1", "wp-001");
    store.writeSeedIfAbsent("project:p2", "wp-001");
    store.setOverride("worktree:w2", { kind: "none" });
    store.setOverride("project:p2", { kind: "id", id: "wp-002" });

    act(() => {
      useServerStore.setState({
        projects: [project("p1")],
        worktrees: [worktree("w1")],
        loaded: true,
      });
    });
    render(<Harness />);

    // Nothing happens before the grace period.
    act(() => {
      vi.advanceTimersByTime(SCOPE_SWEEP_DELAY_MS - 1);
    });
    expect(Object.keys(store.getState().seeds)).toHaveLength(4);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    const state = store.getState();
    expect(Object.keys(state.seeds).sort()).toEqual(["project:p1", "worktree:w1"]);
    expect(state.overrides).toEqual({});
  });

  it("does nothing before the server store is loaded", () => {
    const store = getBackgroundStore();
    store.writeSeedIfAbsent("worktree:w1", "wp-001");
    store.writeSeedIfAbsent("worktree:w2", "wp-001");

    act(() => {
      useServerStore.setState({
        projects: [project("p1")],
        worktrees: [worktree("w1")],
        loaded: false,
      });
    });
    render(<Harness />);

    act(() => {
      vi.advanceTimersByTime(SCOPE_SWEEP_DELAY_MS * 2);
    });

    expect(Object.keys(store.getState().seeds).sort()).toEqual(["worktree:w1", "worktree:w2"]);
  });

  it("keeps live scopes", () => {
    const store = getBackgroundStore();
    store.writeSeedIfAbsent("worktree:w1", "wp-001");
    store.writeSeedIfAbsent("project:p1", "wp-001");
    store.setOverride("worktree:w1", { kind: "id", id: "wp-002" });

    act(() => {
      useServerStore.setState({
        projects: [project("p1")],
        worktrees: [worktree("w1")],
        loaded: true,
      });
    });
    render(<Harness />);

    act(() => {
      vi.advanceTimersByTime(SCOPE_SWEEP_DELAY_MS);
    });

    const state = store.getState();
    expect(Object.keys(state.seeds).sort()).toEqual(["project:p1", "worktree:w1"]);
    expect(state.overrides).toEqual({ "worktree:w1": { kind: "id", id: "wp-002" } });
  });

  it("re-arms when a new worktree appears", () => {
    const store = getBackgroundStore();
    store.writeSeedIfAbsent("worktree:w1", "wp-001");
    store.writeSeedIfAbsent("worktree:w2", "wp-001");

    act(() => {
      useServerStore.setState({
        projects: [project("p1")],
        worktrees: [worktree("w1")],
        loaded: true,
      });
    });
    render(<Harness />);

    // w2 arrives before the first sweep fires: the timer restarts, and w2 lives.
    act(() => {
      vi.advanceTimersByTime(SCOPE_SWEEP_DELAY_MS - 1);
      useServerStore.setState({ worktrees: [worktree("w1"), worktree("w2")] });
    });

    act(() => {
      vi.advanceTimersByTime(SCOPE_SWEEP_DELAY_MS);
    });

    expect(Object.keys(store.getState().seeds).sort()).toEqual(["worktree:w1", "worktree:w2"]);
  });
});
