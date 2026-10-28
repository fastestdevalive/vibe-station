import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOBILE_QUERY, useIsMobile } from "./useIsMobile";

function mockViewport(matches: (q: string) => boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: matches(q),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("useIsMobile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the 768px max-width query", () => {
    expect(MOBILE_QUERY).toBe("(max-width: 768px)");
  });

  it("reflects the query result", () => {
    mockViewport((q) => q === MOBILE_QUERY);
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
    mockViewport(() => false);
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });
});
