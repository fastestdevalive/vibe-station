import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHoverFrozenOrder } from "./useHoverFrozenOrder";

describe("useHoverFrozenOrder (4.T3)", () => {
  it("freezes the order while hovered, appends new ids, re-sorts on leave", () => {
    const { result, rerender } = renderHook(({ ids }) => useHoverFrozenOrder(ids), {
      initialProps: { ids: ["a", "b"] },
    });
    expect(result.current.order).toEqual(["a", "b"]);

    act(() => result.current.hoverProps.onPointerEnter());
    rerender({ ids: ["b", "a", "c"] });
    expect(result.current.order).toEqual(["a", "b", "c"]);

    act(() => result.current.hoverProps.onPointerLeave());
    expect(result.current.order).toEqual(["b", "a", "c"]);
  });

  it("drops ids that disappear while frozen", () => {
    const { result, rerender } = renderHook(({ ids }) => useHoverFrozenOrder(ids), {
      initialProps: { ids: ["a", "b", "c"] },
    });
    act(() => result.current.hoverProps.onPointerEnter());
    rerender({ ids: ["c", "a"] });
    expect(result.current.order).toEqual(["a", "c"]);
  });
});
