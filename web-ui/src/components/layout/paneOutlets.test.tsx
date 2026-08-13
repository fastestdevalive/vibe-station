import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaneOutlet, PaneOutletProvider } from "./paneOutlets";

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
});
