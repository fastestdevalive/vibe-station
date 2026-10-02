import { render, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useVirtualizer } from "@tanstack/react-virtual";

// 2.0 spike — prove the jsdom windowing mechanism works for large-list tests.
// jsdom has no layout, so a real virtualizer sees a 0px scroller and would
// render ~overscan rows regardless of the total. To make the test meaningful we
// stub the scroller's geometry (getBoundingClientRect / offsetHeight) so the
// virtualizer computes a real viewport and windows the rows.
describe("virtualizer jsdom spike (2.0)", () => {
  const TOTAL = 5000;
  let mountDiv: HTMLDivElement;

  function stubGeometry(el: HTMLElement, clientHeight: number, offsetTop = 0) {
    el.getBoundingClientRect = () =>
      ({ top: offsetTop, left: 0, right: 0, bottom: offsetTop + clientHeight, width: 0, height: clientHeight, x: 0, y: offsetTop, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(el, "offsetHeight", { value: clientHeight, configurable: true });
    Object.defineProperty(el, "offsetTop", { value: offsetTop, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
    // jsdom doesn't fire resize; give the virtualizer a non-zero scroll size.
    Object.defineProperty(el, "scrollHeight", { value: TOTAL * 100, configurable: true });
  }

  function Harness({ count }: { count: number }) {
    const rows = Array.from({ length: count }, (_, i) => `row-${i}`);
    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => mountDiv,
      estimateSize: (i) => (i % 2 === 0 ? 80 : 120),
      overscan: 8,
      useFlushSync: false,
    });
    return (
      <div ref={(el) => { if (el) { stubGeometry(el, 500); mountDiv = el; } }} style={{ overflow: "auto", height: "100%" }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div key={item.key} data-index={item.index}>
            {rows[item.index]}
          </div>
        ))}
      </div>
    );
  }

  it("renders far fewer windowed rows than the total item count", async () => {
    const { container } = render(<Harness count={TOTAL} />);
    // A real ResizeObserver/scroll layout loop is needed for the virtualizer to
    // settle its range; flush microtasks + a tick.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const rows = container.querySelectorAll("[data-index]");
    expect(rows.length).toBeLessThan(60);
    expect(rows.length).toBeLessThan(TOTAL);
    expect(rows.length).toBeGreaterThan(0);
  });
});
