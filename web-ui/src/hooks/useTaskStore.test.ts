import { beforeEach, describe, expect, it } from "vitest";
import { createMockApi } from "@/api/mock";
import { createClientApi } from "@/api/client";
import { mkTask } from "@/components/tasks/taskFixtures";
import { ensureTaskSubscription, useTaskStore } from "./useTaskStore";

beforeEach(() => useTaskStore.setState(useTaskStore.getInitialState(), true));

describe("ensureTaskSubscription", () => {
  it("is idempotent: one snapshot is applied once, not once per call", () => {
    const api = createMockApi();
    ensureTaskSubscription(api);
    ensureTaskSubscription(api);
    let applied = 0;
    const unsub = useTaskStore.subscribe(() => applied++);
    api.__test.emit({ type: "session:tasks", sessionId: "s1", rev: 5, tasks: [mkTask()] });
    unsub();
    expect(applied).toBe(1);
    expect(useTaskStore.getState().tasksBySession.s1).toHaveLength(1);
  });

  it("reset() runs synchronously on the transition back to online", () => {
    const api = createMockApi();
    ensureTaskSubscription(api);
    api.__test.emit({ type: "session:tasks", sessionId: "s1", rev: 5000, tasks: [mkTask()] });
    api.mockSetConnectionState("offline");
    expect(useTaskStore.getState().tasksBySession.s1).toHaveLength(1); // kept while offline
    api.mockSetConnectionState("online");
    expect(useTaskStore.getState().tasksBySession.s1).toBeUndefined();
    // a restarted daemon's lower rev is now accepted
    api.__test.emit({ type: "session:tasks", sessionId: "s1", rev: 3, tasks: [] });
    expect(useTaskStore.getState().tasksBySession.s1).toEqual([]);
  });
});

describe("api task output (2.T8)", () => {
  it("getTaskOutput exists on both ApiInstance union members", () => {
    expect(typeof createMockApi().getTaskOutput).toBe("function");
    expect(typeof createClientApi().getTaskOutput).toBe("function");
  });

  it("mock openChat emits an empty session:tasks snapshot synchronously and the store handles it", async () => {
    const api = createMockApi();
    ensureTaskSubscription(api);
    const seen: unknown[] = [];
    api.on("session:tasks", (e) => seen.push(e));
    const p = api.openChat("s9");
    expect(seen).toHaveLength(1); // emitted before the first await resolves
    await p;
    expect(useTaskStore.getState().tasksBySession.s9).toEqual([]);
  });

  it("mock getTaskOutput serves canned output and 404/409 error shapes", async () => {
    const api = createMockApi();
    expect((await api.getTaskOutput("s", "t1", 200)).lines.length).toBeGreaterThan(0);
    await expect(api.getTaskOutput("s", "missing-1")).rejects.toMatchObject({ status: 404, code: "TASK_NOT_FOUND" });
    await expect(api.getTaskOutput("s", "unavailable-1")).rejects.toMatchObject({ status: 409, code: "OUTPUT_UNAVAILABLE" });
  });
});
