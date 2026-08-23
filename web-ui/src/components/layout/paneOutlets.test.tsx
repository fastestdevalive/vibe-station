import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaneOutlet, PaneOutletProvider, usePaneOutletElement } from "./paneOutlets";

function OutletProbe({ paneKey }: { paneKey: string }) {
  const el = usePaneOutletElement(paneKey);
  return <span data-testid="probe" data-resolved={el ? "yes" : "no"} />;
}

describe("PaneOutlet", () => {
  it("is a full-size flex column container", () => {
    // Regression guard: every pane root that gets portaled into an outlet
    // (`.agent-pane-slot`, `.terminal-pane-root`, `.tool-panel`) sizes itself
    // with `flex: 1; min-height: 0`. If this div is left as a plain block, the
    // `flex: 1` is inert, the pane falls back to `height: auto` and sizes to
    // intrinsic content — a fresh xterm collapses to ~0px inside its workspace
    // tile. jsdom does no layout, so assert the contract on the inline style.
    const { container } = render(
      <PaneOutletProvider>
        <PaneOutlet paneKey="agent:s1" />
      </PaneOutletProvider>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.display).toBe("flex");
    expect(el.style.flexDirection).toBe("column");
    expect(el.style.width).toBe("100%");
    expect(el.style.height).toBe("100%");
    expect(el.style.minHeight).toBe("0");
    expect(el.style.minWidth).toBe("0");
  });

  it("keeps a key resolvable when one of two outlets sharing it unmounts", () => {
    // Ghost "tools window" regression: a stale classic-mode fullscreen overlay
    // and a canvas tile can both mount `tools:<worktreeId>` at once. With a
    // single-slot registry, whichever unmounted first deleted the key and left
    // the survivor permanently empty.
    function Harness({ both }: { both: boolean }) {
      return (
        <PaneOutletProvider>
          <PaneOutlet paneKey="tools:w1" />
          {both ? <PaneOutlet paneKey="tools:w1" /> : null}
          <OutletProbe paneKey="tools:w1" />
        </PaneOutletProvider>
      );
    }

    const { getByTestId, rerender } = render(<Harness both />);
    expect(getByTestId("probe").dataset.resolved).toBe("yes");

    rerender(<Harness both={false} />);
    expect(getByTestId("probe").dataset.resolved).toBe("yes");
  });

  it("clears the key once the last outlet unmounts", () => {
    function Harness({ mounted }: { mounted: boolean }) {
      return (
        <PaneOutletProvider>
          {mounted ? <PaneOutlet paneKey="tools:w1" /> : null}
          <OutletProbe paneKey="tools:w1" />
        </PaneOutletProvider>
      );
    }

    const { getByTestId, rerender } = render(<Harness mounted />);
    expect(getByTestId("probe").dataset.resolved).toBe("yes");

    rerender(<Harness mounted={false} />);
    expect(getByTestId("probe").dataset.resolved).toBe("no");
  });
});
