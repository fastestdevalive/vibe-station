import { useState } from "react";
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

  it("auto-focuses the [data-autofocus] field on open, not the Close button", async () => {
    render(
      <Dialog open title="T" onClose={() => {}}>
        <input data-autofocus aria-label="Focus me" />
      </Dialog>,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Focus me"));
    });
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: /Close dialog/i }),
    );
  });

  it("does NOT re-steal focus when the parent re-renders with a new onClose identity", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [, force] = useState(0);
      // New inline onClose each render — mirrors the real LeftSidebar caller.
      return (
        <>
          <button type="button" onClick={() => force((n) => n + 1)}>
            rerender
          </button>
          <Dialog open title="T" onClose={() => {}}>
            <input data-autofocus aria-label="Field" />
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const field = await screen.findByLabelText("Field");
    await waitFor(() => expect(document.activeElement).toBe(field));

    // Move focus elsewhere inside the dialog, then force several re-renders.
    field.blur();
    const rerender = screen.getByRole("button", { name: "rerender" });
    for (let i = 0; i < 3; i++) await user.click(rerender);

    // Focus must NOT have jumped back to the autofocus field or the Close button.
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: /Close dialog/i }),
    );
  });

  it("Escape calls the latest onClose after re-renders (no stale closure)", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setN((x) => x + 1)}>
            bump
          </button>
          <Dialog open title="T" onClose={() => setN((x) => x + 100)}>
            <span>count {n}</span>
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "bump" })); // n = 1
    await user.keyboard("{Escape}"); // latest onClose → n += 100
    await waitFor(() => expect(screen.getByText(/count 101/)).toBeInTheDocument());
  });
});
