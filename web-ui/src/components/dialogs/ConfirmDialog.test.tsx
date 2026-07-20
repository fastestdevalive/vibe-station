import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog — confirmDisabled (2.T1)", () => {
  it("confirmDisabled=true disables the confirm button and blocks onConfirm", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Do it?"
        message="are you sure"
        onConfirm={onConfirm}
        onCancel={() => {}}
        confirmDisabled
      />,
    );
    const confirmBtn = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    await userEvent.click(confirmBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("omitted confirmDisabled behaves exactly as before (regression guard for other callers)", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open title="Do it?" message="are you sure" onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const confirmBtn = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    await userEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirmDisabled=false explicitly behaves the same as omitted", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Do it?"
        message="are you sure"
        onConfirm={onConfirm}
        onCancel={() => {}}
        confirmDisabled={false}
      />,
    );
    const confirmBtn = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
  });
});
