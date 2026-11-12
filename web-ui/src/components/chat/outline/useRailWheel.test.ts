import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  clampRow,
  useRailWheel,
  wheelRows,
  WHEEL_CHAT_GUARD_MS,
  WHEEL_LINE_PX,
  WHEEL_PAGE_PX,
  WHEEL_PX_PER_ROW,
} from "./useRailWheel";

function wheel(init: WheelEventInit = {}): WheelEvent {
  return new WheelEvent("wheel", { deltaY: 0, deltaMode: 0, cancelable: true, bubbles: true, ...init });
}

describe("wheelRows", () => {
  it("maps pixel, line and page deltas to rows", () => {
    expect(wheelRows(wheel({ deltaY: 100 }), 100)).toBeCloseTo(100 / WHEEL_PX_PER_ROW);
    expect(wheelRows(wheel({ deltaY: 3, deltaMode: 1 }), 100)).toBeCloseTo((3 * WHEEL_LINE_PX) / WHEEL_PX_PER_ROW);
    expect(wheelRows(wheel({ deltaY: 1, deltaMode: 2 }), 100)).toBeCloseTo(WHEEL_PAGE_PX / WHEEL_PX_PER_ROW);
    // A mouse notch is ~3.5 rows; a trackpad pixel delta is ~1:1 with a row.
    expect(wheelRows(wheel({ deltaY: 100 }), 100)).toBeCloseTo(3.57, 1);
    expect(wheelRows(wheel({ deltaY: 28 }), 100)).toBeCloseTo(1);
  });

  it("sums tiny deltas past the rounding point: ten 2px deltas move a row, four do not", () => {
    const step = wheelRows(wheel({ deltaY: 2 }), 10)!;
    let four = 0;
    for (let i = 0; i < 4; i++) four = clampRow(four + step, 10);
    expect(Math.round(four)).toBe(0);

    let ten = four;
    for (let i = 0; i < 6; i++) ten = clampRow(ten + step, 10);
    expect(Math.round(ten)).toBe(1);
  });

  it("clamps both ends of the loaded rows", () => {
    expect(clampRow(-3.2, 10)).toBe(0);
    expect(clampRow(9.7, 10)).toBe(9);
    expect(clampRow(4.25, 10)).toBe(4.25);
    let pos = 1;
    for (let i = 0; i < 3; i++) pos = clampRow(pos + wheelRows(wheel({ deltaY: -100 }), 10)!, 10);
    expect(pos).toBe(0);
    pos = 8;
    for (let i = 0; i < 3; i++) pos = clampRow(pos + wheelRows(wheel({ deltaY: 100 }), 10)!, 10);
    expect(pos).toBe(9);
  });

  it("gains speed on long chats, up to 6x", () => {
    expect(wheelRows(wheel({ deltaY: 28 }), 399)).toBeCloseTo(1);
    expect(wheelRows(wheel({ deltaY: 28 }), 400)).toBeCloseTo(1);
    expect(wheelRows(wheel({ deltaY: 28 }), 4000)).toBeCloseTo(6);
  });

  it("ignores pinch-zoom (ctrl/meta) and horizontal gestures (incl. Shift+wheel)", () => {
    expect(wheelRows(wheel({ deltaY: 100, ctrlKey: true }), 100)).toBeNull();
    expect(wheelRows(wheel({ deltaY: 100, metaKey: true }), 100)).toBeNull();
    expect(wheelRows(wheel({ deltaX: 60, deltaY: 10 }), 100)).toBeNull();
    expect(wheelRows(wheel({ deltaX: 60, shiftKey: true }), 100)).toBeNull();
  });
});

describe("useRailWheel", () => {
  it("opens on the start row plus the event's own delta, then sums later deltas per frame", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const onScrubRow = vi.fn();
      renderHook(() =>
        useRailWheel({
          el,
          rowCount: 30,
          active: false,
          getStartRow: () => 0,
          onScrubRow,
        }),
      );

      const first = wheel({ deltaY: 100 });
      el.dispatchEvent(first);
      expect(first.defaultPrevented).toBe(true);
      expect(onScrubRow).toHaveBeenLastCalledWith(Math.round(100 / WHEEL_PX_PER_ROW));

      // Two more notches before the frame are summed into one call.
      el.dispatchEvent(wheel({ deltaY: 100 }));
      el.dispatchEvent(wheel({ deltaY: 100 }));
      expect(onScrubRow).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(onScrubRow).toHaveBeenCalledTimes(2);
      expect(onScrubRow).toHaveBeenLastCalledWith(Math.round((3 * 100) / WHEEL_PX_PER_ROW));
    } finally {
      document.body.removeChild(el);
      vi.useRealTimers();
    }
  });

  it("leaves pinch-zoom and horizontal wheels to the page", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const onScrubRow = vi.fn();
      renderHook(() =>
        useRailWheel({ el, rowCount: 30, active: false, getStartRow: () => 0, onScrubRow }),
      );
      const pinch = wheel({ deltaY: 100, ctrlKey: true });
      el.dispatchEvent(pinch);
      expect(pinch.defaultPrevented).toBe(false);
      const horizontal = wheel({ deltaX: 80, deltaY: 4 });
      el.dispatchEvent(horizontal);
      expect(horizontal.defaultPrevented).toBe(false);
      expect(onScrubRow).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(el);
      vi.useRealTimers();
    }
  });

  it("ignores rail wheels within the guard of a chat-scroller wheel, extended by each ignored wheel", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    const scroller = document.createElement("div");
    document.body.append(el, scroller);
    try {
      const onScrubRow = vi.fn();
      renderHook(() =>
        useRailWheel({ el, scrollElement: scroller, rowCount: 30, active: false, getStartRow: () => 0, onScrubRow }),
      );
      scroller.dispatchEvent(wheel({ deltaY: 120 }));
      act(() => {
        vi.advanceTimersByTime(WHEEL_CHAT_GUARD_MS - 1);
      });
      const momentum = wheel({ deltaY: 120 });
      el.dispatchEvent(momentum);
      expect(momentum.defaultPrevented).toBe(false);

      // Past the chat wheel's own guard, but within the one the momentum event refreshed.
      act(() => {
        vi.advanceTimersByTime(WHEEL_CHAT_GUARD_MS - 1);
      });
      const coasting = wheel({ deltaY: 60 });
      el.dispatchEvent(coasting);
      expect(coasting.defaultPrevented).toBe(false);
      expect(onScrubRow).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(WHEEL_CHAT_GUARD_MS);
      });
      const later = wheel({ deltaY: 120 });
      el.dispatchEvent(later);
      expect(later.defaultPrevented).toBe(true);
      expect(onScrubRow).toHaveBeenCalledTimes(1);
    } finally {
      el.remove();
      scroller.remove();
      vi.useRealTimers();
    }
  });

  it("a wheel right after the wheel list closes is momentum and does not reopen it", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const onScrubRow = vi.fn();
      const { rerender } = renderHook(
        ({ active }) => useRailWheel({ el, rowCount: 30, active, getStartRow: () => 0, onScrubRow }),
        { initialProps: { active: true } },
      );
      // Esc closes the wheel list.
      rerender({ active: false });
      const coasting = wheel({ deltaY: 120 });
      el.dispatchEvent(coasting);
      expect(coasting.defaultPrevented).toBe(false);
      expect(onScrubRow).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(WHEEL_CHAT_GUARD_MS);
      });
      const fresh = wheel({ deltaY: 120 });
      el.dispatchEvent(fresh);
      expect(fresh.defaultPrevented).toBe(true);
      expect(onScrubRow).toHaveBeenCalledTimes(1);
    } finally {
      el.remove();
      vi.useRealTimers();
    }
  });

  it("a row count change mid-scrub re-anchors the position on the start row and keeps pending deltas", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const onScrubRow = vi.fn();
      const { rerender } = renderHook(
        ({ rowCount, start }) =>
          useRailWheel({ el, rowCount, active: true, getStartRow: () => start, onScrubRow }),
        { initialProps: { rowCount: 30, start: 0 } },
      );
      // 56px is two rows: the scrub sits on row 2.
      el.dispatchEvent(wheel({ deltaY: 56 }));
      expect(onScrubRow).toHaveBeenLastCalledWith(2);
      // A delta waits for its frame while earlier turns load: ten rows prepended, the
      // marked row is now row 12.
      el.dispatchEvent(wheel({ deltaY: 28 }));
      rerender({ rowCount: 40, start: 12 });
      act(() => {
        vi.advanceTimersByTime(16);
      });
      // The waiting delta is relative: it still moves one row past the re-anchored row.
      expect(onScrubRow).toHaveBeenLastCalledWith(13);
      el.dispatchEvent(wheel({ deltaY: 28 }));
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(onScrubRow).toHaveBeenLastCalledWith(14);
    } finally {
      el.remove();
      vi.useRealTimers();
    }
  });

  it("rows appended after the marked row keep the fractional position", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const onScrubRow = vi.fn();
      const { rerender } = renderHook(
        ({ rowCount, start }) => useRailWheel({ el, rowCount, active: true, getStartRow: () => start, onScrubRow }),
        { initialProps: { rowCount: 30, start: 0 } },
      );
      // 40px is 1.43 rows: the scrub sits on row 1.
      el.dispatchEvent(wheel({ deltaY: 40 }));
      expect(onScrubRow).toHaveBeenLastCalledWith(1);
      // A streaming turn appends rows; the marked row is still row 1.
      rerender({ rowCount: 40, start: 1 });
      // 12px is 0.43 rows: 1.86 rounds to 2 (a reset to 1.0 would stay on 1).
      el.dispatchEvent(wheel({ deltaY: 12 }));
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(onScrubRow).toHaveBeenLastCalledWith(2);
    } finally {
      el.remove();
      vi.useRealTimers();
    }
  });

  it("a prepend while the scrub rests on the top row keeps it on the marked row; wheeling up continues into the new rows", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const onScrubRow = vi.fn();
      const { rerender } = renderHook(
        ({ rowCount, start }) => useRailWheel({ el, rowCount, active: true, getStartRow: () => start, onScrubRow }),
        { initialProps: { rowCount: 30, start: 0 } },
      );
      // Over-scrolling past the top clamps to row 0 and builds no debt.
      el.dispatchEvent(wheel({ deltaY: -100 }));
      el.dispatchEvent(wheel({ deltaY: -100 }));
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(onScrubRow).toHaveBeenLastCalledWith(0);
      onScrubRow.mockClear();
      // Earlier turns load: nine rows land above, the marked turn is now row 9.
      rerender({ rowCount: 39, start: 9 });
      expect(onScrubRow).not.toHaveBeenCalled();
      el.dispatchEvent(wheel({ deltaY: -28 }));
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(onScrubRow).toHaveBeenLastCalledWith(8);
    } finally {
      el.remove();
      vi.useRealTimers();
    }
  });

  it("a row count change before any wheel leaves the next scrub to start from the start row", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    document.body.appendChild(el);
    try {
      const onScrubRow = vi.fn();
      const { rerender } = renderHook(
        ({ rowCount }) => useRailWheel({ el, rowCount, active: false, getStartRow: () => 5, onScrubRow }),
        { initialProps: { rowCount: 30 } },
      );
      rerender({ rowCount: 40 });
      expect(onScrubRow).not.toHaveBeenCalled();
      el.dispatchEvent(wheel({ deltaY: 28 }));
      expect(onScrubRow).toHaveBeenLastCalledWith(6);
    } finally {
      el.remove();
      vi.useRealTimers();
    }
  });
});
