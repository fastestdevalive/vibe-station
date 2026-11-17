import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CollapsibleSection } from "./CollapsibleSection";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <CollapsibleSection
      id="wp-texture"
      title="Texture"
      summary={<b>Grain</b>}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    >
      <p>child</p>
    </CollapsibleSection>
  );
}

describe("CollapsibleSection", () => {
  it("aria-expanded toggles", () => {
    render(<Harness />);

    const head = screen.getByRole("button", { name: /Texture/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(head).toHaveAttribute("aria-controls", "wp-texture");
    expect(screen.queryByText("child")).not.toBeVisible();

    fireEvent.click(head);

    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("child")).toBeVisible();
    const region = document.getElementById("wp-texture");
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAttribute("aria-labelledby", head.id);

    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("child")).not.toBeVisible();
  });
});
