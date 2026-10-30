import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskTray, type TaskTrayProps } from "./TaskTray";
import { minutesAgo, mkTask } from "./taskFixtures";
import { groupTasks } from "./taskFormat";
import type { TaskSummary } from "@/api/types";

function renderTray(tasks: TaskSummary[], over: Partial<TaskTrayProps> = {}) {
  const props: TaskTrayProps = {
    sessionId: "s1",
    groups: groupTasks(tasks, Date.now()),
    total: tasks.length,
    known: true,
    pref: "strip",
    onPrefChange: vi.fn(),
    taskViewOpen: false,
    onOpenTask: vi.fn(),
    focusComposer: vi.fn(),
    ...over,
  };
  return { props, ...render(<TaskTray {...props} />) };
}

const finished = (n: number) =>
  Array.from({ length: n }, (_, i) => mkTask({ id: `f${i}`, state: "done", endedAt: minutesAgo(1) }));
const mode = () => screen.getByTestId("task-tray").getAttribute("data-mode");

beforeEach(() => {
  const orig = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, sel: string) {
    return sel === ":focus-visible" ? false : orig.call(this, sel);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

  it("3.T4 renders nothing with no tasks; keeps last-known groups when not known", () => {
    const { container } = renderTray([]);
    expect(container.firstChild).toBeNull();
    const tasks = [mkTask({ id: "a" })];
    const props: TaskTrayProps = {
      sessionId: "s1", groups: groupTasks(tasks, Date.now()), total: 1, known: true, pref: "strip",
      onPrefChange: vi.fn(), taskViewOpen: false, onOpenTask: vi.fn(),
    };
    const r = render(<TaskTray {...props} />);
    expect(screen.getByTestId("task-tray-chip")).toBeTruthy();
    r.rerender(<TaskTray {...props} known={false} groups={groupTasks(undefined, 0)} total={0} />);
    expect(screen.getByTestId("task-tray")).toBeTruthy();
    expect(mode()).toBe("strip");
  });

  it("collapsed chip shows count, labels and an accent spinner while live", () => {
    renderTray([
      mkTask({ id: "a", label: "cargo build --release" }),
      mkTask({ id: "b", label: "tail -f daemon.log" }),
      mkTask({ id: "c", label: "npm run dev" }),
      mkTask({ id: "d", label: "sleep 100" }),
    ]);
    const chip = screen.getByTestId("task-tray-chip");
    expect(mode()).toBe("strip");
    expect(chip.textContent).toContain("4 running");
    expect(chip.textContent).toContain("cargo build");
    expect(chip.textContent).toContain("+1");
    expect(chip.querySelector(".task-spin")).not.toBeNull();
  });

  it("3.T3 strip tap goes to a pinned bar and writes the preference once", () => {
    const { props } = renderTray([mkTask()]);
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    expect(mode()).toBe("bar");
    expect(props.onPrefChange).toHaveBeenCalledTimes(1);
    expect(props.onPrefChange).toHaveBeenCalledWith("bar");
    fireEvent.click(screen.getByTestId("task-tray-close"));
    expect(mode()).toBe("strip");
    expect(props.onPrefChange).toHaveBeenLastCalledWith("strip");
  });

  it("pref bar + active renders rows; finishing it falls to the dot after 5 s", () => {
    vi.useFakeTimers();
    const live = mkTask({ id: "live" });
    const props: TaskTrayProps = {
      sessionId: "s1", groups: groupTasks([live], Date.now()), total: 1, known: true, pref: "bar",
      onPrefChange: vi.fn(), taskViewOpen: false, onOpenTask: vi.fn(),
    };
    const r = render(<TaskTray {...props} />);
    expect(mode()).toBe("bar");
    expect(screen.getAllByTestId("task-row")).toHaveLength(1);
    const done = [{ ...live, state: "done" as const, endedAt: minutesAgo(0) }];
    r.rerender(<TaskTray {...props} groups={groupTasks(done, Date.now())} />);
    expect(mode()).toBe("bar");
    act(() => void vi.advanceTimersByTime(4999));
    expect(mode()).toBe("bar");
    act(() => void vi.advanceTimersByTime(1));
    expect(mode()).toBe("dot");
    expect(props.onPrefChange).not.toHaveBeenCalled();
  });

  it("expanded: live rows first, then a Finished group; row click opens the task", () => {
    const { props } = renderTray(
      [mkTask({ id: "live" }), mkTask({ id: "done", label: "sub", kind: "subagent", state: "done", endedAt: minutesAgo(0) })],
      { pref: "bar" },
    );
    const rows = screen.getAllByTestId("task-row");
    expect(rows.map((r) => r.getAttribute("data-task-id"))).toEqual(["live", "done"]);
    expect(screen.getByTestId("task-tray-finished").textContent).toBe("Finished");
    expect(screen.getByTestId("task-tray-head").textContent).toContain("Background · 1 running");
    fireEvent.click(rows[1]!);
    expect(props.onOpenTask).toHaveBeenCalledWith("done");
  });

  it("a quiet command gets a static grey icon, is excluded from 'N running' and shows 'N quiet'", () => {
    renderTray([mkTask({ id: "q", lastActivityAt: minutesAgo(5) })], { pref: "bar" });
    const head = screen.getByTestId("task-tray-head");
    expect(head.textContent).toContain("1 quiet");
    expect(head.textContent).not.toContain("running");
    expect(document.querySelector(".task-spin")).toBeNull();
    expect(screen.getByTestId("task-icon-quiet")).toBeTruthy();
  });

  it("a running row shows its reason (hold lapsed); without one it shows none", () => {
    renderTray(
      [mkTask({ id: "lapsed", reason: "Still running after 60 min — no longer counted as agent work" }), mkTask({ id: "plain" })],
      { pref: "bar" },
    );
    const rows = screen.getAllByTestId("task-row");
    expect(rows[0]!.textContent).toContain("Still running after 60 min");
    expect(rows[1]!.querySelector(".task-tray__row-reason")).toBeNull();
  });

  it("a row's accessible name includes its reason", () => {
    renderTray([mkTask({ id: "lapsed", reason: "Still running after 60 min — no longer counted as agent work" })], {
      pref: "bar",
    });
    expect(screen.getByRole("button", { name: /no longer counted as agent work/ })).toBeTruthy();
  });

  it("3.T1 all finished -> dot with a summary name, no aria-controls, other layers inert", () => {
    renderTray(finished(3));
    expect(mode()).toBe("dot");
    const dot = screen.getByRole("button", { name: "Background tasks, 3 finished. Show" });
    expect(dot).toBe(screen.getByTestId("task-tray-dot"));
    expect(dot.hasAttribute("aria-controls")).toBe(false);
    expect(dot.hasAttribute("aria-expanded")).toBe(false);
    expect(screen.getByTestId("task-tray-chip").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("task-tray-head").hasAttribute("inert")).toBe(true);
    expect(screen.queryAllByTestId("task-row")).toHaveLength(0);
    expect(dot.querySelector(".task-spin")).toBeNull();
  });

  it("3.T2 dot -> strip -> bar, one step per tap; the bar stays until the user collapses it", () => {
    vi.useFakeTimers();
    renderTray(finished(2));
    fireEvent.click(screen.getByTestId("task-tray-dot"));
    expect(mode()).toBe("strip");
    expect(screen.queryAllByTestId("task-row")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    expect(mode()).toBe("bar");
    expect(screen.getAllByTestId("task-row")).toHaveLength(2);
    const close = screen.getByTestId("task-tray-close");
    expect(close.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(close.getAttribute("aria-controls")!)).toBe(screen.getByRole("group", { name: "Background tasks" }));
    expect(screen.queryByTestId("task-tray-pin")).toBeNull();
    act(() => void vi.advanceTimersByTime(20_000));
    expect(mode()).toBe("bar");
    expect(screen.getByTestId("task-tray-close")).toBe(close);
  });

  it("collapsing the bar goes to the strip, which returns to the dot after 5 s", () => {
    vi.useFakeTimers();
    renderTray(finished(2));
    fireEvent.click(screen.getByTestId("task-tray-dot"));
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    fireEvent.click(screen.getByTestId("task-tray-close"));
    expect(mode()).toBe("strip");
    act(() => void vi.advanceTimersByTime(4999));
    expect(mode()).toBe("strip");
    act(() => void vi.advanceTimersByTime(1));
    expect(mode()).toBe("dot");
  });

  it("the strip opened from the dot returns to the dot after 5 s; hover pauses it", () => {
    vi.useFakeTimers();
    renderTray(finished(2));
    fireEvent.click(screen.getByTestId("task-tray-dot"));
    act(() => void vi.advanceTimersByTime(3000));
    fireEvent.pointerEnter(screen.getByTestId("task-tray"), { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(20_000));
    expect(mode()).toBe("strip");
    fireEvent.pointerLeave(screen.getByTestId("task-tray"), { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(4999));
    expect(mode()).toBe("strip");
    act(() => void vi.advanceTimersByTime(1));
    expect(mode()).toBe("dot");
  });

  it("with 0 running shows a grey 'N finished' chip when the strip was the preference", () => {
    const { container } = renderTray([mkTask({ state: "stale", endedAt: minutesAgo(1) }), mkTask({ id: "x", state: "done" })]);
    expect(container.querySelector(".task-tray__chip .task-spin")).toBeNull();
    expect(screen.getByTestId("task-tray-chip").textContent).toContain("2 finished");
  });

  it("3.T5 Esc on a row collapses, focuses the composer and never writes the preference", () => {
    const { props } = renderTray([mkTask()], { pref: "bar" });
    fireEvent.keyDown(screen.getByTestId("task-row"), { key: "Escape" });
    expect(props.focusComposer).toHaveBeenCalled();
    expect(mode()).toBe("strip");
    expect(props.onPrefChange).not.toHaveBeenCalled();
  });

  it("Esc inside a nested input does nothing", () => {
    const { props } = renderTray([mkTask()], { pref: "bar" });
    const input = document.createElement("input");
    screen.getByTestId("task-tray").appendChild(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mode()).toBe("bar");
    expect(props.focusComposer).not.toHaveBeenCalled();
    input.remove();
  });

  it("Enter on a focused row opens it", () => {
    const { props } = renderTray([mkTask({ id: "a" }), mkTask({ id: "b" })], { pref: "bar" });
    const rows = screen.getAllByTestId("task-row");
    rows[1]!.focus();
    fireEvent.focus(rows[1]!);
    fireEvent.keyDown(rows[1]!, { key: "Enter" });
    expect(props.onOpenTask).toHaveBeenCalledWith("b");
  });

  it("3.T6 a timer collapse to the dot moves focus from the leaving strip to the dot", () => {
    vi.useFakeTimers();
    renderTray(finished(2));
    fireEvent.click(screen.getByTestId("task-tray-dot"));
    const chip = screen.getByTestId("task-tray-chip");
    chip.focus();
    expect(document.activeElement).toBe(chip);
    // Not :focus-visible (mouse focus) so the focus hold does not pause the timer; the chip then goes inert.
    act(() => void vi.advanceTimersByTime(5000));
    expect(mode()).toBe("dot");
    expect(document.activeElement).toBe(screen.getByTestId("task-tray-dot"));
  });

  it("3.T7 has no aria-live anywhere", () => {
    renderTray(finished(2));
    fireEvent.click(screen.getByTestId("task-tray-dot"));
    expect(screen.getByTestId("task-tray").querySelector("[aria-live]")).toBeNull();
  });

  it("3.T8 50 tasks: dot shows no visible count (name carries it); the bar lists all rows", () => {
    renderTray(finished(50));
    const dot = screen.getByTestId("task-tray-dot");
    expect(dot.textContent).toBe("");
    expect(dot.getAttribute("aria-label")).toContain("50 finished");
    fireEvent.click(screen.getByTestId("task-tray-dot"));
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    expect(screen.getAllByTestId("task-row")).toHaveLength(50);
  });

  it("3.T10 the list is inert during its exit window, then unmounts", () => {
    vi.useFakeTimers();
    renderTray(finished(2));
    fireEvent.click(screen.getByTestId("task-tray-dot"));
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    fireEvent.click(screen.getByTestId("task-tray-close"));
    const wrap = document.querySelector(".task-tray__listwrap")!;
    expect(wrap.hasAttribute("inert")).toBe(true);
    act(() => void vi.advanceTimersByTime(270));
    expect(document.querySelector(".task-tray__listwrap")).toBeNull();
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

  it("keeps the accent on the spinner arc only", () => {
    expect(css.replace(/\.task-spin__arc\s*\{[^}]*\}/, "")).not.toMatch(/--accent/);
  });

  it("animates only grid-template-rows / clip-path / opacity / visibility", () => {
    const trayCss = css.slice(css.indexOf("/* ── Tray"), css.indexOf("/* ── Passive background line"));
    for (const m of trayCss.matchAll(/transition:\s*([^;]+);/g)) {
      const props = m[1]!.split(",").map((p) => p.trim().split(/\s+/)[0]!);
      for (const p of props) expect(["grid-template-rows", "clip-path", "background-color", "border-color", "opacity", "transform", "visibility", "none"]).toContain(p);
    }
  });

  it("dot mode clips the shell to a chip-height circle at its right end, so strip <-> dot is a shape morph", () => {
    const rule = css.match(/\.task-tray\[data-mode="dot"\] \.task-tray__shell\s*\{([^}]*)\}/)![1]!;
    expect(rule).toMatch(/clip-path:\s*inset\(/);
    expect(rule).toMatch(/round calc\(var\(--task-tray-dot-d\) \/ 2\)/);
    expect(css).toMatch(/\.task-tray__shell\s*\{[^}]*clip-path:\s*inset\(0 0 0 0 round/);
  });

  it("clip has no padding/border/margin; reduced motion kills transitions; footer stays static", () => {
    const clip = css.match(/\.task-tray__reveal > \.task-tray__clip\s*\{([^}]*)\}/)![1]!;
    expect(clip).not.toMatch(/padding|border|margin/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.task-tray,\s*\.task-tray \*\s*\{\s*transition:\s*none !important/);
    expect(css).not.toMatch(/\.chat-pane__footer\s*\{[^}]*position:\s*relative/);
  });

  it("dot is icon-only, sits in the strip's former row (bottom-anchored above the composer) with zero flow height", () => {
    expect(css).not.toMatch(/dot-count/);
    expect(css).toMatch(/\.task-tray\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.task-tray\[data-mode="dot"\] \.task-tray__reveal\s*\{[^}]*grid-template-rows:\s*0fr/);
    const dot = css.match(/\.task-tray__dot\s*\{([^}]*)\}/)![1]!;
    // Same bottom gap / right edge / diameter as the strip chip, so it never overlaps the composer.
    expect(dot).toMatch(/bottom:\s*0/);
    expect(dot).toMatch(/right:\s*var\(--space-3\)/);
    expect(dot).toMatch(/width:\s*var\(--task-tray-dot-d\)/);
    expect(dot).toMatch(/height:\s*var\(--task-tray-dot-d\)/);
    expect(dot).not.toMatch(/\btop:|task-tray-lift/);
  });

  it("coarse-pointer row min-height comes after the base rule so it wins", () => {
    const base = css.indexOf(".task-tray__row {");
    const coarse = css.search(/@media \(pointer: coarse\)\s*\{\s*\.task-tray__row\s*\{\s*min-height:\s*44px/);
    expect(coarse).toBeGreaterThan(base);
  });

  it("stops the spinner under prefers-reduced-motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.task-spin\s*\{\s*animation:\s*none;?\s*\}\s*\}/);
  });
});
