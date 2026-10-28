import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chip } from "./Chip";

describe("Chip", () => {
  it("defaults to the neutral tone and md size", () => {
    render(<Chip>Rich Chat</Chip>);
    expect(screen.getByText("Rich Chat").className).toBe("chip chip--neutral chip--md");
  });

  it("renders the sm size and warn tone classes", () => {
    render(
      <Chip tone="warn" size="sm">
        3 comments
      </Chip>,
    );
    expect(screen.getByText("3 comments").className).toBe("chip chip--warn chip--sm");
  });

  it("passes extra props and class names through", () => {
    render(
      <Chip className="extra" title="hint" data-testid="c">
        x
      </Chip>,
    );
    const el = screen.getByTestId("c");
    expect(el.className).toContain("extra");
    expect(el.getAttribute("title")).toBe("hint");
  });
});
