import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { TaskOutput, TaskSummary } from "@/api/types";
import { mkTask } from "./taskFixtures";
import { OUTPUT_DEBOUNCE_MS, TaskOutputLog } from "./TaskOutputLog";

type Api = ReturnType<typeof createMockApi>;
type Resolver = (o: TaskOutput) => void;

const out = (lines: string[], extra: Partial<TaskOutput> = {}): TaskOutput => ({ lines, truncated: false, outputKind: "file", ...extra });

function setup(task: TaskSummary) {
  const api = createMockApi() as Api;
  const pending: Resolver[] = [];
  const spy = vi.fn(
    () =>
      new Promise<TaskOutput>((res) => {
        pending.push(res);
      }),
  );
  (api as { getTaskOutput: unknown }).getTaskOutput = spy;
  const el = (t: TaskSummary) => <TaskOutputLog api={api} sessionId="s1" task={t} now={Date.now()} secondPrecision={false} />;
  const r = render(el(task));
  const settle = async (o: TaskOutput) => {
    await act(async () => {
      pending.shift()!(o);
    });
  };
  return { api, spy, pending, settle, rerender: (t: TaskSummary) => r.rerender(el(t)) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TaskOutputLog", () => {
  it("fetches immediately on open, then debounces outputRev changes (trailing 500ms)", async () => {
    const t = mkTask();
    const h = setup(t);
    expect(h.spy).toHaveBeenCalledTimes(1);
    await h.settle(out(["one"]));
    h.rerender({ ...t, outputRev: 2 });
    h.rerender({ ...t, outputRev: 3 });
    h.rerender({ ...t, outputRev: 4 });
    await act(async () => {
      vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS - 1);
    });
    expect(h.spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(h.spy).toHaveBeenCalledTimes(2);
  });

  it("keeps at most one request in flight and refetches once afterwards", async () => {
    const t = mkTask();
    const h = setup(t);
    h.rerender({ ...t, outputRev: 2 });
    await act(async () => {
      vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);
    });
    expect(h.spy).toHaveBeenCalledTimes(1); // first still pending
    await h.settle(out(["older"])); // older rev still shown: newer than the screen
    expect(screen.getByTestId("task-output").textContent).toBe("older");
    expect(h.spy).toHaveBeenCalledTimes(2); // queued refetch fired
    await h.settle(out(["fresh"]));
    expect(screen.getByTestId("task-output").textContent).toBe("fresh");
  });

  it("refetches on a state change with an unchanged outputRev", async () => {
    const t = mkTask();
    const h = setup(t);
    await h.settle(out(["a"]));
    h.rerender({ ...t, state: "stale", endedAt: new Date().toISOString() });
    await act(async () => {
      vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);
    });
    expect(h.spy).toHaveBeenCalledTimes(2);
  });

  it("a subagent outputRev bump refetches once per debounce window", async () => {
    const t = mkTask({ kind: "subagent", outputKind: "events" });
    const h = setup(t);
    await h.settle(out(["Read a"], { outputKind: "events" }));
    for (let i = 2; i < 6; i++) h.rerender({ ...t, outputRev: i });
    await act(async () => {
      vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);
    });
    expect(h.spy).toHaveBeenCalledTimes(2);
    await h.settle(out(["Read a", "Read b"], { outputKind: "events", finalText: "All **done**" }));
    expect(screen.getByTestId("task-final-text").textContent).toContain("All done");
    expect(screen.getByText("Read b")).toBeTruthy();
  });

  it("refetches when the connection returns online", async () => {
    const t = mkTask();
    const h = setup(t);
    await h.settle(out(["a"]));
    act(() => h.api.mockSetConnectionState("offline"));
    act(() => h.api.mockSetConnectionState("online"));
    await act(async () => {
      vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);
    });
    expect(h.spy).toHaveBeenCalledTimes(2);
  });

  it("with Follow off, holds new output and offers 'New output — Resume follow'", async () => {
    const t = mkTask();
    const h = setup(t);
    await h.settle(out(["old"]));
    fireEvent.click(screen.getByLabelText("Follow"));
    h.rerender({ ...t, outputRev: 2 });
    await act(async () => {
      vi.advanceTimersByTime(OUTPUT_DEBOUNCE_MS);
    });
    await h.settle(out(["old", "new"]));
    expect(screen.getByTestId("task-output").textContent).toBe("old");
    fireEvent.click(screen.getByText("New output — Resume follow"));
    expect(screen.getByTestId("task-output").textContent).toBe("old\nnew");
  });

  it("caps the display at 200 lines", async () => {
    const h = setup(mkTask());
    await h.settle(out(Array.from({ length: 300 }, (_, i) => `l${i}`)));
    const lines = screen.getByTestId("task-output").textContent!.split("\n");
    expect(lines.length).toBe(200);
    expect(lines[0]).toBe("l100");
  });

  it("does no polling while idle (only the shared minute tick may exist)", async () => {
    const h = setup(mkTask());
    await h.settle(out(["a"]));
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(h.spy).toHaveBeenCalledTimes(1);
  });
});

describe("TaskOutputLog last-output age", () => {
  const api = createMockApi() as Api;
  (api as { getTaskOutput: unknown }).getTaskOutput = () => new Promise<TaskOutput>(() => {});
  const base = 1_700_000_000_000;
  const task = mkTask({ outputKind: "file", lastActivityAt: new Date(base - 2000).toISOString() });
  const footer = (now: number, secondPrecision: boolean) => (
    <TaskOutputLog api={api} sessionId="s1" task={task} now={now} secondPrecision={secondPrecision} />
  );

  it("advances every second with secondPrecision and registers no timer of its own", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const r = render(footer(base, true));
    expect(screen.getByTestId("task-log-footer").textContent).toContain("last output 2s ago");
    r.rerender(footer(base + 1000, true));
    expect(screen.getByTestId("task-log-footer").textContent).toContain("last output 3s ago");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("renders <1m for sub-minute ages without secondPrecision", () => {
    render(footer(base, false));
    expect(screen.getByTestId("task-log-footer").textContent).toContain("last output <1m ago");
  });
});
