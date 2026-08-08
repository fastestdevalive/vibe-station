import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useDragClickGuard } from "./useDragClickGuard";

/**
 * These tests encode the ACTUAL mechanism of the drag-selects-the-row bug,
 * not a generic "click still works" check.
 *
 * The sortable sidebar rows are `<a href>` elements. When a dnd-kit drag ends
 * with the pointer still inside the dragged row, the browser dispatches a
 * trailing `click` on that anchor. dnd-kit's PointerSensor installs its own
 * `document`-CAPTURE click listener that calls `stopPropagation()` — so the
 * click never reaches React and no row `onClick` can intervene — but
 * `stopPropagation()` does not cancel the DEFAULT ACTION, so the browser still
 * navigated to the anchor's href. That is what made a pure reorder select the
 * dragged worktree.
 *
 * Every test below therefore installs a stand-in for dnd-kit's suppressor, so
 * the guard is exercised under the same conditions it has to survive in the app.
 */

let dndSuppressor: ((e: Event) => void) | null = null;

/** Stand-in for dnd-kit's PointerSensor click suppression (document capture,
 *  stopPropagation only — no preventDefault). See @dnd-kit/core `handleStart`. */
function installDndKitClickSuppressor() {
  dndSuppressor = (e: Event) => e.stopPropagation();
  document.addEventListener("click", dndSuppressor, true);
}

/** `markDrag` is invoked the way the app invokes it: directly from dnd-kit's
 *  onDragEnd, NOT via a DOM event (dnd-kit's suppressor would eat that too). */
let markDrag: () => void = () => {};

function Harness({ onAnchorClick }: { onAnchorClick?: () => void }) {
  markDrag = useDragClickGuard();
  return (
    <a href="/worktree/wt-2" onClick={onAnchorClick}>
      row
    </a>
  );
}

/** Replay dnd-kit's drag lifecycle for a reorder that ends on the dragged row. */
function dragEnds() {
  markDrag();
}

/** Dispatch a real, cancelable click the way the browser does after a drag —
 *  NOT `fireEvent.click`, because we need to inspect `defaultPrevented`. */
function browserClick(el: Element): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(ev);
  return ev;
}

describe("useDragClickGuard", () => {
  beforeEach(() => {
    installDndKitClickSuppressor();
  });
  afterEach(() => {
    if (dndSuppressor) document.removeEventListener("click", dndSuppressor, true);
    dndSuppressor = null;
    vi.restoreAllMocks();
    cleanup();
  });

  it("cancels the anchor's default navigation on the click that trails a drag", () => {
    const onAnchorClick = vi.fn();
    render(<Harness onAnchorClick={onAnchorClick} />);
    dragEnds();

    const ev = browserClick(screen.getByRole("link", { name: "row" }));

    // The default action is what actually navigated (and therefore selected)
    // the dragged worktree. It MUST be cancelled.
    expect(ev.defaultPrevented).toBe(true);
    expect(onAnchorClick).not.toHaveBeenCalled();
  });

  it("wins over dnd-kit's document-capture suppressor (window capture runs first)", () => {
    // Regression for the original fix's blind spot: a guard living in the
    // row's React onClick can never run, because dnd-kit stops propagation at
    // `document` capture before React's root container sees the event. Prove
    // the guard still fires even though the app-level handler does not.
    const onAnchorClick = vi.fn();
    render(<Harness onAnchorClick={onAnchorClick} />);

    // Without a preceding drag the click reaches nothing (dnd-kit's stand-in
    // suppressor is unconditional here), but it is also NOT default-prevented.
    const plain = browserClick(screen.getByRole("link", { name: "row" }));
    expect(plain.defaultPrevented).toBe(false);

    dragEnds();
    const afterDrag = browserClick(screen.getByRole("link", { name: "row" }));
    expect(afterDrag.defaultPrevented).toBe(true);
  });

  it("only swallows ONE click per drag", () => {
    render(<Harness />);
    dragEnds();

    expect(browserClick(screen.getByRole("link", { name: "row" })).defaultPrevented).toBe(true);
    // The user's next, deliberate click must go through.
    expect(browserClick(screen.getByRole("link", { name: "row" })).defaultPrevented).toBe(false);
  });

  it("does not go stale when the trailing click never arrives", () => {
    // Regression for the boolean-flag approach this replaced: the trailing
    // click usually never reaches any React handler, so a "drag occurred" flag
    // consumed in `onClick` was never reset and swallowed the NEXT genuine
    // click on any row — forever. A timestamp expires on its own.
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    render(<Harness />);

    dragEnds(); // drag ends, no trailing click follows
    now += 5_000; // user reads the screen, then clicks a row

    expect(browserClick(screen.getByRole("link", { name: "row" })).defaultPrevented).toBe(false);
  });

  it("still cancels a trailing click delayed by the reorder re-render", () => {
    // The click can lag the drop by more than dnd-kit's own 50ms window when
    // the reorder's re-render + optimistic store write block the main thread.
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    render(<Harness />);

    dragEnds();
    now += 120;

    expect(browserClick(screen.getByRole("link", { name: "row" })).defaultPrevented).toBe(true);
  });

  it("leaves clicks alone when no drag ever happened", () => {
    const onAnchorClick = vi.fn();
    render(<Harness onAnchorClick={onAnchorClick} />);
    expect(browserClick(screen.getByRole("link", { name: "row" })).defaultPrevented).toBe(false);
  });
});
