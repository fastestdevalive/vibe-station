import { describe, it, expect, vi } from "vitest";
import { visibleLineRange, scrollToLine, lineAtFraction, centeredTopLine } from "./codeLines";
import type { CodeViewHandle } from "@/components/preview/CodeView";

describe("visibleLineRange", () => {
  it("returns null when no rows exist", () => {
    const scroller = document.createElement("div");
    expect(visibleLineRange(scroller)).toBeNull();
  });

  it("with mocked row rects returns the first row whose bottom is below scroller top and last whose top is above scroller bottom", () => {
    const scroller = document.createElement("div");
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 300,
      height: 200,
      width: 400,
      left: 0,
      right: 400,
      x: 0,
      y: 100,
      toJSON: () => {},
    });

    // 5 rows:
    // Row 1: 0..80 (completely above scrollerTop = 100)
    // Row 2: 80..120 (bottom = 120 > 100, first visible!)
    // Row 3: 120..180 (inside)
    // Row 4: 180..280 (top = 180 < 300, inside)
    // Row 5: 280..350 (top = 280 < 300, last visible!)
    // Row 6: 350..400 (completely below scrollerBottom = 300)
    const rects = [
      { top: 0, bottom: 80 },
      { top: 80, bottom: 120 },
      { top: 120, bottom: 180 },
      { top: 180, bottom: 280 },
      { top: 280, bottom: 350 },
      { top: 350, bottom: 400 },
    ];

    rects.forEach((r, idx) => {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(idx + 1));
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: r.top,
        bottom: r.bottom,
        height: r.bottom - r.top,
        width: 400,
        left: 0,
        right: 400,
        x: 0,
        y: r.top,
        toJSON: () => {},
      });
      scroller.appendChild(row);
    });

    const range = visibleLineRange(scroller);
    expect(range).toEqual({ first: 2, last: 5 });
  });

  it("computes visible line range for diff rows from data-diff-row (row scale, never the file line)", () => {
    const scroller = document.createElement("div");
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 300,
      height: 200,
      width: 400,
      left: 0,
      right: 400,
      x: 0,
      y: 100,
      toJSON: () => {},
    });

    const rects = [
      { top: 0, bottom: 80 },
      { top: 80, bottom: 120 },
      { top: 120, bottom: 180 },
      { top: 180, bottom: 280 },
      { top: 280, bottom: 350 },
      { top: 350, bottom: 400 },
    ];

    rects.forEach((r, idx) => {
      const row = document.createElement("div");
      row.className = "diff-line";
      // A hunk at line 800 in a short diff: `data-line` is the new-file line
      // number and `data-diff-row` is the row's index in the flattened hunk
      // order. The range must come from the latter.
      row.setAttribute("data-diff-row", String(idx + 41));
      row.setAttribute("data-line", String(idx + 800));
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: r.top,
        bottom: r.bottom,
        height: r.bottom - r.top,
        width: 400,
        left: 0,
        right: 400,
        x: 0,
        y: r.top,
        toJSON: () => {},
      });
      scroller.appendChild(row);
    });

    const range = visibleLineRange(scroller, "diff");
    expect(range).toEqual({ first: 42, last: 45 });
  });

  it("skips diff rows without data-diff-row (expanded context-gap rows are not on the row scale)", () => {
    const scroller = document.createElement("div");
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 200,
      height: 200,
      width: 400,
      left: 0,
      right: 400,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const rows: Array<{ top: number; bottom: number; diffRow?: number }> = [
      { top: 0, bottom: 20 }, // expanded gap row — not on the scale
      { top: 20, bottom: 40, diffRow: 7 },
      { top: 40, bottom: 60 }, // expanded gap row
      { top: 60, bottom: 80, diffRow: 8 },
    ];
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "diff-line";
      if (r.diffRow != null) row.setAttribute("data-diff-row", String(r.diffRow));
      row.setAttribute("data-line", "120");
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: r.top,
        bottom: r.bottom,
        height: r.bottom - r.top,
        width: 400,
        left: 0,
        right: 400,
        x: 0,
        y: r.top,
        toJSON: () => {},
      });
      scroller.appendChild(row);
    });

    expect(visibleLineRange(scroller, "diff")).toEqual({ first: 7, last: 8 });
  });

  it("returns null for diff rows carrying no data-diff-row at all", () => {
    const scroller = document.createElement("div");
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 200,
      height: 200,
      width: 400,
      left: 0,
      right: 400,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const row = document.createElement("div");
    row.className = "diff-line";
    row.setAttribute("data-line", "1");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 20,
      height: 20,
      width: 400,
      left: 0,
      right: 400,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    scroller.appendChild(row);

    expect(visibleLineRange(scroller, "diff")).toBeNull();
  });
});

describe("scrollToLine", () => {
  it("calls handle.scrollToLine(line - 1) when virtualized", () => {
    const scroller = document.createElement("div");
    const handle: CodeViewHandle = {
      isVirtualized: () => true,
      getFirstVisibleLine: () => null,
      scrollToLine: vi.fn(),
    };

    scrollToLine(scroller, handle, 42);
    expect(handle.scrollToLine).toHaveBeenCalledWith(41);
  });

  it("sets scrollTop from [data-line] row when not virtualized", () => {
    const scroller = document.createElement("div");
    scroller.scrollTop = 50;
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 500,
      height: 400,
      width: 400,
      left: 0,
      right: 400,
      x: 0,
      y: 100,
      toJSON: () => {},
    });

    const row = document.createElement("div");
    row.className = "workspace-code-line";
    row.setAttribute("data-line", "15");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      top: 250,
      bottom: 270,
      height: 20,
      width: 400,
      left: 0,
      right: 400,
      x: 0,
      y: 250,
      toJSON: () => {},
    });
    scroller.appendChild(row);

    const handle: CodeViewHandle = {
      isVirtualized: () => false,
      getFirstVisibleLine: () => null,
      scrollToLine: vi.fn(),
    };

    scrollToLine(scroller, handle, 15);
    // Delta = row.top (250) - scroller.top (100) = 150.
    // New scrollTop = 50 + 150 = 200.
    expect(scroller.scrollTop).toBe(200);
    expect(handle.scrollToLine).not.toHaveBeenCalled();
  });
});

describe("lineAtFraction", () => {
  it("maps fraction to line numbers", () => {
    expect(lineAtFraction(0, 100)).toBe(1);
    expect(lineAtFraction(1, 100)).toBe(100);
    expect(lineAtFraction(0.5, 100)).toBe(51);
  });
});

describe("centeredTopLine", () => {
  it("clamps to 1 at the start", () => {
    expect(centeredTopLine(5, 50, 1000)).toBe(1);
  });

  it("centers around pointerLine in the middle", () => {
    expect(centeredTopLine(500, 50, 1000)).toBe(475);
  });

  it("clamps to lineCount - visibleLines + 1 at the end", () => {
    expect(centeredTopLine(995, 50, 1000)).toBe(951);
  });

  it("handles visibleLines = 0", () => {
    expect(centeredTopLine(50, 0, 100)).toBe(50);
  });

  it("handles visibleLines larger than the file", () => {
    expect(centeredTopLine(50, 200, 100)).toBe(1);
  });
});
