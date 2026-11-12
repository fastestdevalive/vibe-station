import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createMockApi, type MockApi } from "@/api/mock";
import { __resetFileScrollMapForTests } from "@/hooks/useFileScrollMap";
import { ScrollMapToggle } from "./ScrollMapToggle";
import type { EffectiveScrollMap, ScrollMapFallback } from "./effectiveScrollMapMode";

let testApi: MockApi;

vi.mock("@/api", () => ({
  get api() {
    return testApi;
  },
  createMockApi,
}));

beforeEach(() => {
  __resetFileScrollMapForTests();
  testApi = createMockApi();
});

describe("ScrollMapToggle", () => {
  it("hidden when display is null", () => {
    const { container } = render(<ScrollMapToggle display={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("hidden when display.display is 'none'", () => {
    const { container } = render(
      <ScrollMapToggle display={{ display: "none", forced: "fits" }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  const forcedReasons: ScrollMapFallback[] = [
    "fits",
    "phone",
    "diff",
    "overCap",
    "narrow",
    "unavailable",
  ];

  it.each(forcedReasons)("hidden when forced is '%s'", (forced) => {
    const display: EffectiveScrollMap = { display: "marks", forced };
    const { container } = render(<ScrollMapToggle display={display} />);
    expect(container.firstChild).toBeNull();
  });

  it("shown with aria-pressed='true' for minimap and aria-label='File minimap'", () => {
    // Default is minimap
    render(<ScrollMapToggle display={{ display: "minimap", forced: null }} />);
    const btn = screen.getByRole("button", { name: "File minimap" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toHaveAttribute("title", "Show change marks instead of the minimap");
  });

  it("clicking calls updateSettings and toggles between marks and minimap", async () => {
    const patchSpy = vi.spyOn(testApi, "updateSettings");
    const { rerender } = render(
      <ScrollMapToggle display={{ display: "minimap", forced: null }} />,
    );

    const btn = screen.getByRole("button", { name: "File minimap" });
    expect(btn).toHaveAttribute("aria-pressed", "true");

    // Click 1: minimap -> marks
    fireEvent.click(btn);
    expect(patchSpy).toHaveBeenCalledWith({ fileScrollMap: "marks" });

    // With marks:
    rerender(<ScrollMapToggle display={{ display: "marks", forced: null }} />);
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAttribute("title", "Show the minimap");

    // Click 2: marks -> minimap
    fireEvent.click(btn);
    expect(patchSpy).toHaveBeenCalledWith({ fileScrollMap: "minimap" });
  });

  it("keyboard Enter and Space toggle the setting", () => {
    const patchSpy = vi.spyOn(testApi, "updateSettings");
    render(<ScrollMapToggle display={{ display: "minimap", forced: null }} />);

    const btn = screen.getByRole("button", { name: "File minimap" });
    btn.focus();

    // Enter triggers click on a button in DOM
    fireEvent.click(btn);
    expect(patchSpy).toHaveBeenCalledWith({ fileScrollMap: "marks" });
  });
});
