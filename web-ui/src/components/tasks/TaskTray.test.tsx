import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskTray, type TaskTrayProps } from "./TaskTray";
import { minutesAgo, mkTask } from "./taskFixtures";
import { groupTasks } from "./taskFormat";
import type { TaskSummary } from "@/api/types";

function renderTray(tasks: TaskSummary[], over: Partial<TaskTrayProps> = {}) {
  const props: TaskTrayProps = {
    groups: groupTasks(tasks, Date.now()),
    total: tasks.length,
    expanded: false,
    onExpandedChange: vi.fn(),
    onOpenTask: vi.fn(),
    focusComposer: vi.fn(),
    ...over,
  };
  return { props, ...render(<TaskTray {...props} />) };
}

afterEach(() => vi.useRealTimers());

describe("TaskTray", () => {
  it("chip clock ticks every second while a task runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = mkTask({ startedAt: new Date(Date.now() - 5000).toISOString(), lastActivityAt: new Date().toISOString() });
    renderTray([t]);
    expect(screen.getByTestId("task-tray-chip").textContent).toContain("0:05");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("task-tray-chip").textContent).toContain("0:06");
  });

  it("registers no 1s interval when nothing is running", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setInterval");
    renderTray([mkTask({ state: "done" }), mkTask({ id: "q", lastActivityAt: minutesAgo(5) })]);
    expect(spy.mock.calls.filter((c) => c[1] === 1000)).toHaveLength(0);
    spy.mockRestore();
  });

  it("renders nothing with no tasks", () => {
    const { container } = renderTray([]);
    expect(container.firstChild).toBeNull();
  });

  it("collapsed chip shows count, labels and an accent spinner while live", () => {
    renderTray([
      mkTask({ id: "a", label: "cargo build --release" }),
      mkTask({ id: "b", label: "tail -f daemon.log" }),
      mkTask({ id: "c", label: "npm run dev" }),
      mkTask({ id: "d", label: "sleep 100" }),
    ]);
    const chip = screen.getByTestId("task-tray-chip");
    expect(chip.textContent).toContain("4 running");
    expect(chip.textContent).toContain("cargo build");
    expect(chip.textContent).toContain("+1");
    expect(chip.querySelector(".task-spin")).not.toBeNull();
  });

  it("chip click asks to expand", () => {
    const { props } = renderTray([mkTask()]);
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    expect(props.onExpandedChange).toHaveBeenCalledWith(true);
  });

  it("expanded: live rows first, then a Finished group; row click opens the task", () => {
    const { props } = renderTray(
      [mkTask({ id: "live" }), mkTask({ id: "done", label: "sub", kind: "subagent", state: "done", endedAt: minutesAgo(0) })],
      { expanded: true },
    );
    const rows = screen.getAllByTestId("task-row");
    expect(rows.map((r) => r.getAttribute("data-task-id"))).toEqual(["live", "done"]);
    expect(screen.getByTestId("task-tray-finished").textContent).toBe("Finished");
    expect(screen.getByTestId("task-tray-head").textContent).toContain("Background · 1 running");
    fireEvent.click(rows[1]!);
    expect(props.onOpenTask).toHaveBeenCalledWith("done");
  });

  it("a quiet command gets a static grey icon, is excluded from 'N running' and shows 'N quiet'", () => {
    renderTray([mkTask({ id: "q", lastActivityAt: minutesAgo(5) })], { expanded: true });
    const head = screen.getByTestId("task-tray-head");
    expect(head.textContent).toContain("1 quiet");
    expect(head.textContent).not.toContain("running");
    expect(document.querySelector(".task-spin")).toBeNull();
    expect(screen.getByTestId("task-icon-quiet")).toBeTruthy();
  });

  it("with 0 running shows a grey 'N finished' chip and no accent spinner", () => {
    renderTray([mkTask({ state: "stale", endedAt: minutesAgo(1) }), mkTask({ id: "x", state: "done" })]);
    const chip = screen.getByTestId("task-tray-chip");
    expect(chip.textContent).toContain("2 finished");
    expect(chip.querySelector(".task-spin")).toBeNull();
  });

  it("Esc on a row hands focus back to the composer", () => {
    const { props } = renderTray([mkTask()], { expanded: true });
    fireEvent.keyDown(screen.getByTestId("task-row"), { key: "Escape" });
    expect(props.focusComposer).toHaveBeenCalled();
  });

  it("Enter on a focused row opens it", () => {
    const { props } = renderTray([mkTask({ id: "a" }), mkTask({ id: "b" })], { expanded: true });
    const rows = screen.getAllByTestId("task-row");
    rows[1]!.focus();
    fireEvent.focus(rows[1]!);
    fireEvent.keyDown(rows[1]!, { key: "Enter" });
    expect(props.onOpenTask).toHaveBeenCalledWith("b");
  });
});

describe("tasks.css / components: neutral styling", () => {
  const FORBIDDEN = /--fg-danger|--fg-success|--fg-warning|--destructive|--status-|--pr-/;
  const here = __dirname;
  const css = readFileSync(join(here, "../../styles/tasks.css"), "utf8");
  const sources = readdirSync(here)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."))
    .map((f) => [f, readFileSync(join(here, f), "utf8")] as const);

  it("uses no forbidden status tokens", () => {
    expect(css).not.toMatch(FORBIDDEN);
    for (const [f, src] of sources) expect(src, f).not.toMatch(FORBIDDEN);
  });

  it("has no bare hex colours", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const [f, src] of sources) expect(src, f).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  it("spinner track differs from the arc source token (R1F-09)", () => {
    expect(css).toMatch(/\.task-spin__track\s*\{\s*stroke:\s*color-mix\(in srgb, var\(--fg-muted\) 30%, transparent\)/);
    expect(css).toMatch(/\.task-spin__arc\s*\{\s*stroke:\s*var\(--accent\)/);
  });

  it("stops the spinner under prefers-reduced-motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.task-spin\s*\{\s*animation:\s*none;?\s*\}\s*\}/);
  });
});
