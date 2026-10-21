import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "./useLongPress";

function Harness({ enabled, onLongPress, onClick }: {
  enabled: boolean;
  onLongPress: () => boolean | void;
  onClick: () => void;
}) {
  const props = useLongPress({ enabled, onLongPress });
  return (
    <div data-testid="box" {...props}>
      <button onClick={onClick}>row</button>
    </div>
  );
}

const touch = { pointerType: "touch", isPrimary: true } as const;

describe("useLongPress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires after the threshold, not before", () => {
    const onLong = vi.fn();
    render(<Harness enabled onLongPress={onLong} onClick={vi.fn()} />);
    fireEvent.pointerDown(screen.getByText("row"), { ...touch, clientX: 5, clientY: 5 });
    act(() => { vi.advanceTimersByTime(499); });
    expect(onLong).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(onLong).toHaveBeenCalledTimes(1);
  });

  it("cancels on movement past the slop, tolerates small jitter", () => {
    const onLong = vi.fn();
    render(<Harness enabled onLongPress={onLong} onClick={vi.fn()} />);
    const row = screen.getByText("row");
    fireEvent.pointerDown(row, { ...touch, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(row, { ...touch, clientX: 3, clientY: 3 });
    act(() => { vi.advanceTimersByTime(600); });
    expect(onLong).toHaveBeenCalledTimes(1);

    onLong.mockClear();
    fireEvent.pointerDown(row, { ...touch, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(row, { ...touch, clientX: 20, clientY: 0 });
    act(() => { vi.advanceTimersByTime(600); });
    expect(onLong).not.toHaveBeenCalled();
  });

  it("cancels on pointerup and on scroll", () => {
    const onLong = vi.fn();
    render(<Harness enabled onLongPress={onLong} onClick={vi.fn()} />);
    const row = screen.getByText("row");
    fireEvent.pointerDown(row, touch);
    fireEvent.pointerUp(row, touch);
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerDown(row, touch);
    fireEvent.scroll(row);
    act(() => { vi.advanceTimersByTime(600); });
    expect(onLong).not.toHaveBeenCalled();
  });

  it("suppresses the click that follows a fired long-press, once", () => {
    const onClick = vi.fn();
    render(<Harness enabled onLongPress={() => true} onClick={onClick} />);
    const row = screen.getByText("row");
    fireEvent.pointerDown(row, touch);
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerUp(row, touch);
    fireEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not suppress the click when the handler reports nothing handled", () => {
    const onClick = vi.fn();
    render(<Harness enabled onLongPress={() => false} onClick={onClick} />);
    const row = screen.getByText("row");
    fireEvent.pointerDown(row, touch);
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("a normal tap clicks through", () => {
    const onClick = vi.fn();
    const onLong = vi.fn();
    render(<Harness enabled onLongPress={onLong} onClick={onClick} />);
    const row = screen.getByText("row");
    fireEvent.pointerDown(row, touch);
    fireEvent.pointerUp(row, touch);
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onLong).not.toHaveBeenCalled();
  });

  it("mouse pointers and disabled mode are inert; right-click is untouched", () => {
    const onLong = vi.fn();
    const { rerender } = render(<Harness enabled onLongPress={onLong} onClick={vi.fn()} />);
    const row = screen.getByText("row");
    fireEvent.pointerDown(row, { pointerType: "mouse", isPrimary: true });
    act(() => { vi.advanceTimersByTime(600); });
    expect(onLong).not.toHaveBeenCalled();

    rerender(<Harness enabled={false} onLongPress={onLong} onClick={vi.fn()} />);
    fireEvent.pointerDown(row, touch);
    act(() => { vi.advanceTimersByTime(600); });
    expect(onLong).not.toHaveBeenCalled();
    // contextmenu not prevented when disabled (desktop right-click)
    expect(fireEvent.contextMenu(row)).toBe(true);
  });

  it("prevents the native context menu on touch", () => {
    render(<Harness enabled onLongPress={vi.fn()} onClick={vi.fn()} />);
    expect(fireEvent.contextMenu(screen.getByText("row"))).toBe(false);
  });

  it("never blocks a mouse right-click, even when enabled", () => {
    render(<Harness enabled onLongPress={vi.fn()} onClick={vi.fn()} />);
    const row = screen.getByText("row");
    const ev = createEvent.contextMenu(row);
    Object.defineProperty(ev, "pointerType", { value: "mouse" });
    expect(fireEvent(row, ev)).toBe(true);
    const pen = createEvent.contextMenu(row);
    Object.defineProperty(pen, "pointerType", { value: "pen" });
    expect(fireEvent(row, pen)).toBe(false);
  });
});
