import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import type { TaskOutput, TaskSummary } from "@/api/types";
import { mkTask } from "./taskFixtures";
import { groupTasks } from "./taskFormat";
import { TaskView } from "./TaskView";

const touch = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsTouch", () => ({ useIsTouch: () => touch.value }));
const copy = vi.hoisted(() => ({ fn: vi.fn(async (_t: string) => true) }));
vi.mock("@/lib/copyText", () => ({ copyText: (t: string) => copy.fn(t) }));

type Api = ReturnType<typeof createMockApi>;

function setup(task: TaskSummary, getOutput: (id: string) => Promise<TaskOutput>, onClose = vi.fn()) {
  const api = createMockApi() as Api;
  (api as { getTaskOutput: unknown }).getTaskOutput = vi.fn((_s: string, id: string) => getOutput(id));
  const view = (t: TaskSummary) => (
    <TaskView api={api} sessionId="s1" sessionName="release-build" task={t} groups={groupTasks([t], Date.now())} onClose={onClose} focusOnMount />
  );
  const r = render(view(task));
  return { api, onClose, rerender: (t: TaskSummary) => r.rerender(view(t)) };
}

const okOut = (lines: string[], extra: Partial<TaskOutput> = {}): TaskOutput => ({
  lines,
  truncated: false,
  outputKind: "file",
  path: "/tmp/claude-1000/p/tasks/t1.output",
  ...extra,
});

beforeEach(() => {
  touch.value = false;
  copy.fn.mockClear();
});

describe("TaskView", () => {
  it("renders the exact breadcrumb and disabled-composer copy, with the Esc hint", async () => {
    setup(mkTask(), async () => okOut(["hello"]));
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Back to chat");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("release-build/Tasks/cargo build --release");
    expect(screen.getByTestId("task-back").querySelector("kbd")?.textContent).toBe("Esc");
    expect(screen.getByTestId("task-view-composer").textContent).toBe(
      "Viewing task output. Press Esc to go back to the chat and message the agent.",
    );
    expect(await screen.findByTestId("task-output")).toBeTruthy();
  });

  it("on touch: no Esc kbd and tap copy; focus is not stolen", async () => {
    touch.value = true;
    setup(mkTask(), async () => okOut(["hi"]));
    expect(screen.getByTestId("task-back").querySelector("kbd")).toBeNull();
    expect(screen.getByTestId("task-view-composer").textContent).toContain("Tap Back to chat to message the agent.");
    expect(document.activeElement).not.toBe(screen.getByTestId("task-view"));
    await screen.findByTestId("task-output");
  });

  it("focuses its root on open (region, tabIndex -1)", async () => {
    setup(mkTask(), async () => okOut(["hi"]));
    const root = screen.getByTestId("task-view");
    expect(root.getAttribute("role")).toBe("region");
    expect(document.activeElement).toBe(root);
    await screen.findByTestId("task-output");
  });

  it("Copy output copies the cleaned lines", async () => {
    setup(mkTask(), async () => okOut(["\u001b[32mgreen\u001b[0m", "p\r100%"]));
    await screen.findByTestId("task-output");
    await waitFor(() => {
      expect(screen.getByTestId("task-copy").getAttribute("aria-disabled")).not.toBe("true");
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-copy"));
    });
    expect(copy.fn).toHaveBeenCalledWith("green\n100%");
  });

  it("Copy and Stop are icon buttons in the output toolbar with the hint", async () => {
    setup(mkTask(), async () => okOut(["x"]));
    const actions = screen.getByTestId("task-view").querySelector(".task-log__actions")!;
    expect(actions.contains(screen.getByTestId("task-copy"))).toBe(true);
    expect(screen.getByTestId("task-copy").getAttribute("aria-label")).toBe("Copy output");
    expect(screen.getByTestId("task-stop").getAttribute("aria-label")).toBe("Stop task");
    expect(actions.contains(screen.getByTestId("task-stop"))).toBe(true);
    const hint = document.getElementById(screen.getByTestId("task-stop").getAttribute("aria-describedby")!);
    expect(actions.contains(hint)).toBe(true);
    await screen.findByTestId("task-output");
  });

  it("breadcrumb counts use the tray vocabulary and the command crumb is mono", async () => {
    setup(mkTask(), async () => okOut(["x"]));
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("1 running");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).not.toContain("finished");
    expect(document.querySelector(".task-view__crumb--current.task-view__crumb--mono")).not.toBeNull();
    await screen.findByTestId("task-output");
  });

  it("Copy output is aria-disabled with nothing to copy and does not claim success", async () => {
    setup(mkTask(), async () => {
      throw new ApiError("nf", 404, "TASK_NOT_FOUND");
    });
    await screen.findByTestId("task-output-empty");
    const btn = screen.getByTestId("task-copy");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(copy.fn).not.toHaveBeenCalled();
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("Stop is aria-disabled and described by the visible hint", async () => {
    setup(mkTask(), async () => okOut(["x"]));
    const stop = screen.getByTestId("task-stop");
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(stop.hasAttribute("disabled")).toBe(false);
    const hint = document.getElementById(stop.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toBe("Not supported by this agent version");
    await screen.findByTestId("task-output");
  });

  it.each([
    ["none", async () => okOut([], { outputKind: "none" }), { outputKind: "none" as const }],
    ["404", async () => { throw new ApiError("nf", 404, "TASK_NOT_FOUND"); }, {}],
    ["409", async () => { throw new ApiError("na", 409, "OUTPUT_UNAVAILABLE"); }, {}],
  ])("shows the honest empty state for %s", async (_n, getOut, over) => {
    setup(mkTask(over), getOut as () => Promise<TaskOutput>);
    expect((await screen.findByTestId("task-output-empty")).textContent).toBe(
      "Output isn't available for this task from the current agent version.",
    );
  });

  it("header updates and the view stays open when the task flips to done", async () => {
    const t = mkTask({ kind: "subagent", label: "Explore", outputKind: "events" });
    const { rerender, onClose } = setup(t, async () => okOut(["Read a.rs"], { outputKind: "events" }));
    expect(screen.getByTestId("task-view-state").textContent).toContain("Subagent · running");
    rerender({ ...t, state: "done", endedAt: new Date().toISOString() });
    expect(screen.getByTestId("task-view-state").textContent).toContain("Subagent · done in");
    expect(screen.getByTestId("task-view")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await screen.findByTestId("task-output");
  });

  it("live region holds only the state word: stable across ticks, changes on state flip", () => {
    vi.useFakeTimers();
    try {
      const t = mkTask({ kind: "subagent", label: "Explore", outputKind: "events", startedAt: new Date().toISOString() });
      const { rerender } = setup(t, async () => okOut(["x"], { outputKind: "events" }));
      const live = screen.getByTestId("task-view-state-live");
      expect(live.getAttribute("aria-live")).toBe("polite");
      expect(screen.getByTestId("task-view-state").getAttribute("aria-live")).toBeNull();
      expect(live.textContent).toBe("running");
      const visible = screen.getByTestId("task-view-state").textContent;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId("task-view-state").textContent).not.toBe(visible);
      expect(live.textContent).toBe("running");
      rerender({ ...t, state: "done", endedAt: new Date().toISOString() });
      expect(live.textContent).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Full-log footer only for File output; subagent shows activity + final message", async () => {
    const { rerender } = setup(mkTask(), async () => okOut(["a"]));
    expect((await screen.findByTestId("task-log-footer")).textContent).toContain("Last 200 lines");
    expect(screen.getByTestId("task-view-path").textContent).toContain("Full log: /tmp/claude-1000/p/tasks/t1.output");
    const sub = mkTask({ id: "s", kind: "subagent", outputKind: "events", state: "done" });
    rerender(sub);
    await waitFor(() => expect(screen.queryByTestId("task-log-footer")).toBeNull());
    expect(screen.queryByTestId("task-view-path")).toBeNull();
  });

  it("Back to chat button closes", async () => {
    const { onClose } = setup(mkTask(), async () => okOut(["x"]));
    fireEvent.click(screen.getByTestId("task-back"));
    expect(onClose).toHaveBeenCalled();
    await screen.findByTestId("task-output");
  });
});
