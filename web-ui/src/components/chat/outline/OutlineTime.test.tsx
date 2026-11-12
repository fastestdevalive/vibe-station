import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { OutlineTime } from "./OutlineTime";
import { formatOutlineTitle } from "@/lib/timeAgo";

describe("OutlineTime", () => {
  const NOW = new Date(2026, 10, 12, 15, 0).getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a <time> with dateTime and the full timestamp as its title", () => {
    const ts = new Date(NOW - 5 * 60_000).toISOString();
    const { container } = render(<OutlineTime ts={ts} />);
    const el = container.querySelector("time")!;
    expect(el).toHaveClass("olp__time");
    expect(el.textContent).toBe("5m");
    expect(el.getAttribute("dateTime")).toBe(ts);
    expect(el.getAttribute("title")).toBe(formatOutlineTitle(ts));
  });

  it("a merged beat's tooltip reads 'start – end' while the label shows the start", () => {
    const ts = new Date(NOW - 9 * 60_000).toISOString();
    const tsEnd = new Date(NOW - 2 * 60_000).toISOString();
    const { container } = render(<OutlineTime ts={ts} tsEnd={tsEnd} />);
    const el = container.querySelector("time")!;
    expect(el.textContent).toBe("9m");
    expect(el.getAttribute("title")).toBe(`${formatOutlineTitle(ts)} – ${formatOutlineTitle(tsEnd)}`);
  });

  it("prints the time on every row, even when the row above prints the same text", () => {
    const ts = new Date(NOW - 5 * 60_000).toISOString();
    const { container } = render(
      <>
        <OutlineTime ts={new Date(NOW - 5 * 60_000 - 20_000).toISOString()} />
        <OutlineTime ts={ts} />
      </>,
    );
    expect([...container.querySelectorAll("time")].map((t) => t.textContent)).toEqual(["5m", "5m"]);
  });

  it("renders nothing for a missing or invalid timestamp", () => {
    expect(render(<OutlineTime />).container.innerHTML).toBe("");
    expect(render(<OutlineTime ts="garbage" />).container.innerHTML).toBe("");
  });

  it("one minute tick updates the text without re-rendering the parent", () => {
    let parentRenders = 0;
    function Parent({ ts }: { ts: string }) {
      parentRenders++;
      return (
        <div>
          <OutlineTime ts={ts} />
        </div>
      );
    }
    const ts = new Date(NOW - 59_000).toISOString();
    const { container } = render(<Parent ts={ts} />);
    expect(container.querySelector("time")!.textContent).toBe("now");
    expect(parentRenders).toBe(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.querySelector("time")!.textContent).toBe("1m");
    expect(parentRenders).toBe(1);
  });
});
