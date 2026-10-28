import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockedListLayout, desktopListWidth } from "./DockedListLayout";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";

function mockPaneRect(width: number, height = 400) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
}

function renderLayout() {
  return render(
    <DockedListLayout wt="wt-1" open topbar={<span>bar</span>} list={<span>list</span>} handleLabel="files">
      <span>content</span>
    </DockedListLayout>,
  );
}

describe("desktopListWidth (W1-02)", () => {
  it("keeps the wanted width when the pane has room", () => {
    expect(desktopListWidth(240, 800)).toBe(240);
  });
  it("caps the list so the content keeps its minimum", () => {
    expect(desktopListWidth(240, 250)).toBe(130);
  });
  it("never goes below a usable list width", () => {
    expect(desktopListWidth(240, 150)).toBe(120);
  });
});

describe("DockedListLayout on a narrow desktop pane (W1-02)", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, masterDetailVertical: false } },
      filesLeftPaneWidthByWorktree: { "wt-1": 300 },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("a 250px pane gives the list at most 130px; the handle stays inside the pane", () => {
    mockPaneRect(250);
    const { container } = renderLayout();
    const pane = container.querySelector(".files-panel") as HTMLElement;
    expect(pane.style.getPropertyValue("--list-pane-w")).toBe("130px");
    const handle = screen.getByRole("separator", { name: "Resize files side panel" });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(130);
    // The content column is padded by the (capped) list width, leaving it >= 120px.
    expect(250 - Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(120);
  });

  it("a roomy pane keeps the stored width (and the 224 floor)", () => {
    mockPaneRect(1000);
    const { container } = renderLayout();
    const pane = container.querySelector(".files-panel") as HTMLElement;
    expect(pane.style.getPropertyValue("--list-pane-w")).toBe("300px");
  });
});
