import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

describe("KeyboardShortcutsDialog (2.T9)", () => {
  it("lists the 3 new diff-view-shortcuts rows in the Layout group", () => {
    render(<KeyboardShortcutsDialog open onClose={() => {}} />);

    expect(screen.getByText("Jump to file diff")).toBeInTheDocument();
    expect(screen.getByText("Toggle inline/side-by-side diff")).toBeInTheDocument();
    expect(screen.getByText("Expand/collapse diff hunk")).toBeInTheDocument();

    // Confirm they render inside the "Layout" group table, not a stray group.
    const layoutTitle = screen.getByText("Layout");
    const table = layoutTitle.nextElementSibling as HTMLElement;
    expect(table).toBeTruthy();
    expect(table.textContent).toContain("Jump to file diff");
    expect(table.textContent).toContain("Toggle inline/side-by-side diff");
    expect(table.textContent).toContain("Expand/collapse diff hunk");
  });
});
