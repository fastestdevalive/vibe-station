import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { CodeView, type CodeViewHandle } from "@/components/preview/CodeView";
import { DiffView } from "@/components/preview/DiffView";
import { useWorkspaceStore } from "@/hooks/useStore";
import { visibleLineRange } from "./codeLines";

function makeScroller() {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 800, bottom: 500, width: 800, height: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: 500, configurable: true });
  Object.defineProperty(el, "offsetTop", { value: 0, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: 100_000, configurable: true });
  return el;
}

function makeCode(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`).join("\n");
}

describe("codeLines contract with CodeView DOM", () => {
  it("rendering the real CodeView with 300 lines yields .workspace-code-line[data-line='1']", async () => {
    const scroller = makeScroller();
    const handleRef = createRef<CodeViewHandle>();
    const code = makeCode(300);

    const { container } = render(
      <CodeView
        ref={handleRef}
        code={code}
        scrollElRef={{ current: scroller }}
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const firstLine = container.querySelector('.workspace-code-line[data-line="1"]');
    expect(firstLine).toBeTruthy();
    expect(handleRef.current?.isVirtualized()).toBe(false);
  });

  it("rendering with 2,500 lines yields .workspace-code-vrow[data-index] and isVirtualized() === true", async () => {
    const scroller = makeScroller();
    const handleRef = createRef<CodeViewHandle>();
    const code = makeCode(2500);

    const { container } = render(
      <CodeView
        ref={handleRef}
        code={code}
        scrollElRef={{ current: scroller }}
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const vrow = container.querySelector(".workspace-code-vrow[data-index]");
    expect(vrow).toBeTruthy();
    expect(handleRef.current?.isVirtualized()).toBe(true);
  });
});

describe("codeLines contract with DiffView DOM", () => {
  /** A diff whose first hunk starts at line 800 — the case that used to put
   *  the thumb off the track when the range was read from `data-line`. */
  const farHunkDiff = [
    "@@ -800,2 +800,3 @@",
    " context 800",
    "-old 801",
    "+new 801",
    "+new 802",
  ].join("\n");

  it("every rendered diff row carries a 1-based data-diff-row, independent of its new-file line", async () => {
    const { container } = render(<DiffView diffText={farHunkDiff} filePath="src/a.ts" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const rows = Array.from(container.querySelectorAll<HTMLElement>(".diff-line[data-diff-row]"));
    expect(rows.map((r) => r.getAttribute("data-diff-row"))).toEqual(["1", "2", "3", "4"]);
    // The new-file line numbers are 800+ — a different scale entirely.
    expect(rows.map((r) => r.getAttribute("data-line"))).toEqual(["800", null, "801", "802"]);
  });

  it("visibleLineRange over the real DiffView DOM returns row indices, not file line numbers", async () => {
    const { container } = render(<DiffView diffText={farHunkDiff} filePath="src/a.ts" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // The RTL container is the scroller: rows live inside it, as they do inside
    // `.preview-body` in the real pane.
    container.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 800, bottom: 40, width: 800, height: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    Array.from(container.querySelectorAll<HTMLElement>(".diff-line[data-diff-row]")).forEach((row, i) => {
      row.getBoundingClientRect = () =>
        ({ top: i * 20, bottom: (i + 1) * 20, height: 20, left: 0, right: 800, width: 800, x: 0, y: i * 20, toJSON: () => ({}) }) as DOMRect;
    });

    expect(visibleLineRange(container, "diff")).toEqual({ first: 1, last: 2 });
  });

  it("a collapsed hunk keeps the flat row index of the rows below it", async () => {
    useWorkspaceStore.setState({ diffLayoutMode: "inline" });
    const user = userEvent.setup();
    const diffText = [
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -800,1 +800,1 @@",
      "-c",
      "+d",
    ].join("\n");

    const { container } = render(<DiffView diffText={diffText} filePath="src/a.ts" interactive />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".diff-line[data-diff-row]")).map((r) =>
        r.getAttribute("data-diff-row"),
      ),
    ).toEqual(["1", "2", "3", "4"]);

    await user.click(container.querySelectorAll(".preview-diff-hunk-caret")[0]!);

    // The collapsed hunk renders no rows, but the rows below it keep their
    // real indices (3, 4) instead of collapsing down to the DOM list index.
    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".diff-line[data-diff-row]")).map((r) =>
        r.getAttribute("data-diff-row"),
      ),
    ).toEqual(["3", "4"]);
  });

  it("side-by-side cells carry their pair's representative row index", async () => {
    useWorkspaceStore.setState({ diffLayoutMode: "side-by-side" });
    try {
      const { container } = render(<DiffView diffText={farHunkDiff} filePath="src/a.ts" interactive />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      const cells = Array.from(container.querySelectorAll<HTMLElement>(".preview-diff-side-by-side .diff-line[data-diff-row]"));
      const rowIndices = cells.map((c) => Number.parseInt(c.getAttribute("data-diff-row") ?? "0", 10));
      // pair 0 = context (rows 1,1); pair 1 = removed+added (row 2,2); pair 2 =
      // added only (row 4). Monotonic non-decreasing, so visibleLineRange's
      // binary search holds over the cell list.
      expect(rowIndices).toEqual([1, 1, 2, 2, 4]);
    } finally {
      useWorkspaceStore.setState({ diffLayoutMode: "inline" });
    }
  });
});
