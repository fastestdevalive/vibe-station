import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkTask } from "@/components/tasks/taskFixtures";
import { useTaskStore } from "./useTaskStore";
import { useSessionTasks } from "./useSessionTasks";

const snap = (sid: string, rev: number, ...ids: string[]) =>
  act(() => useTaskStore.getState().applySnapshot(sid, rev, ids.map((id) => mkTask({ id }))));

beforeEach(() => {
  localStorage.clear();
  useTaskStore.setState(useTaskStore.getInitialState(), true);
});
afterEach(() => vi.restoreAllMocks());

describe("useTaskStore", () => {
  it("replaces (never merges) and drops rev <= held", () => {
    snap("s1", 10, "a", "b");
    expect(useTaskStore.getState().tasksBySession.s1!.map((t) => t.id)).toEqual(["a", "b"]);
    snap("s1", 11, "c");
    expect(useTaskStore.getState().tasksBySession.s1!.map((t) => t.id)).toEqual(["c"]);
    snap("s1", 11, "x"); // equal rev
    snap("s1", 5, "y"); // older rev
    expect(useTaskStore.getState().tasksBySession.s1!.map((t) => t.id)).toEqual(["c"]);
  });

  it("reset() forgets revs so a restarted daemon's lower rev is accepted", () => {
    snap("s1", 1000, "a");
    act(() => useTaskStore.getState().reset());
    expect(useTaskStore.getState().tasksBySession.s1).toBeUndefined();
    snap("s1", 3, "z");
    expect(useTaskStore.getState().tasksBySession.s1!.map((t) => t.id)).toEqual(["z"]);
  });
});

describe("useSessionTasks", () => {
  it("does NOT prune the persisted open task before the first snapshot, but does after one lacking it", () => {
    localStorage.setItem("vst.taskView.s1", "gone");
    const { result } = renderHook(() => useSessionTasks("s1"));
    expect(result.current.tasks).toBeUndefined();
    expect(result.current.openTaskId).toBe("gone");
    expect(result.current.openTask).toBeUndefined();

    snap("s1", 1, "other");
    expect(result.current.openTaskId).toBeNull();
    expect(result.current.lostNotice).toBe("That task is no longer tracked");
    expect(localStorage.getItem("vst.taskView.s1")).toBeNull();
    act(() => result.current.ackLostNotice());
    expect(result.current.lostNotice).toBeNull();
  });

  it("restores the open task once the snapshot contains it (reload)", () => {
    localStorage.setItem("vst.taskView.s1", "t1");
    const { result } = renderHook(() => useSessionTasks("s1"));
    snap("s1", 1, "t1");
    expect(result.current.openTask?.id).toBe("t1");
  });

  it("open()/close() persist per session", () => {
    const { result } = renderHook(() => useSessionTasks("s1"));
    snap("s1", 1, "t1");
    act(() => result.current.open("t1"));
    expect(localStorage.getItem("vst.taskView.s1")).toBe("t1");
    act(() => result.current.close());
    expect(localStorage.getItem("vst.taskView.s1")).toBeNull();
  });

  it("keeps the open task across a reset() (WS reconnect gap); a snapshot lacking it then closes it", () => {
    const { result } = renderHook(() => useSessionTasks("s1"));
    snap("s1", 1, "t1");
    act(() => result.current.open("t1"));
    const before = result.current.openTask;
    expect(before?.id).toBe("t1");
    act(() => useTaskStore.getState().reset());
    expect(result.current.tasks).toBeUndefined();
    expect(result.current.openTask).toBe(before);
    expect(result.current.openTaskId).toBe("t1");
    snap("s1", 1, "other");
    expect(result.current.openTask).toBeUndefined();
    expect(result.current.openTaskId).toBeNull();
    expect(result.current.lostNotice).toBe("That task is no longer tracked");
  });

  it("tolerates a throwing localStorage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = renderHook(() => useSessionTasks("s1"));
    snap("s1", 1, "t1");
    act(() => result.current.open("t1"));
    expect(result.current.openTask?.id).toBe("t1");
    act(() => result.current.setExpanded(true));
    expect(result.current.expanded).toBe(true);
  });

  it("never shows session A's tasks under session B on switch", () => {
    snap("A", 1, "a1");
    snap("B", 1, "b1", "b2");
    localStorage.setItem("vst.taskView.A", "a1");
    const { result, rerender } = renderHook(({ id }) => useSessionTasks(id), { initialProps: { id: "A" } });
    expect(result.current.tasks!.map((t) => t.id)).toEqual(["a1"]);
    expect(result.current.openTaskId).toBe("a1");
    rerender({ id: "B" });
    expect(result.current.tasks!.map((t) => t.id)).toEqual(["b1", "b2"]);
    expect(result.current.openTaskId).toBeNull();
    expect(result.current.openTask).toBeUndefined();
  });
});
