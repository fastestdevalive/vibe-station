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

  it("lists the Review group: C, Ctrl+Enter and the Esc layers (7.4)", () => {
    render(<KeyboardShortcutsDialog open onClose={() => {}} />);
    const table = screen.getByText("Review").nextElementSibling as HTMLElement;
    expect(table.textContent).toContain("Comment on the selection or the focused gutter +");
    expect(table.textContent).toContain("Add the comment");
    expect(table.textContent).toContain("Cancel the comment (asks before discarding text)");
    expect(table.textContent).toContain("Close the send picker, then the expanded comments tray");
  });
});
