import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Dialog } from "./Dialog";

describe("Dialog", () => {
  it("Escape closes the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open title="T" onClose={onClose}>
        <p>Body</p>
      </Dialog>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking overlay closes the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open title="T" onClose={onClose}>
        <p>Body</p>
      </Dialog>,
    );
    // Dialog uses createPortal — query from document.body
    const overlay = document.body.querySelector(".dialog-overlay");
    expect(overlay).toBeTruthy();
    await user.click(overlay!);
    expect(onClose).toHaveBeenCalled();
  });

  it("focus is trapped inside the dialog while open", async () => {
    render(
      <Dialog open title="T" onClose={() => {}}>
        <button type="button">Inside action</button>
      </Dialog>,
    );
    await waitFor(() => {
      const dlg = screen.getByRole("dialog");
      expect(dlg.contains(document.activeElement)).toBe(true);
    });
  });
});
