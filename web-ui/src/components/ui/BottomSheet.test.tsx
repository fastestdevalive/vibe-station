import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BottomSheet } from "./BottomSheet";

describe("BottomSheet Escape (V-06)", () => {
  it("closes the sheet on Escape", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} label="Sheet">
        <button type="button">Inside</button>
      </BottomSheet>,
    );
    fireEvent.keyDown(screen.getByText("Inside"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to an open combobox menu inside it; the next Escape closes the sheet", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <BottomSheet open onClose={onClose} label="Sheet">
        <div role="combobox" aria-expanded="true" tabIndex={0} aria-label="Message" />
      </BottomSheet>,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(
      <BottomSheet open onClose={onClose} label="Sheet">
        <div role="combobox" aria-expanded="false" tabIndex={0} aria-label="Message" />
      </BottomSheet>,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("BottomSheet focus (L4-17)", () => {
  it("moves focus into the sheet and hands it back to the opener on close", () => {
    function Host({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">Opener</button>
          <BottomSheet open={open} onClose={() => {}} label="Sheet">
            <button type="button">Inside</button>
          </BottomSheet>
        </>
      );
    }
    const { rerender } = render(<Host open={false} />);
    screen.getByText("Opener").focus();
    rerender(<Host open />);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    rerender(<Host open={false} />);
    expect(document.activeElement).toBe(screen.getByText("Opener"));
  });
});
