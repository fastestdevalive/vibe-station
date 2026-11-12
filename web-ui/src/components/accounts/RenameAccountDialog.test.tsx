import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "@/api/types";
import { RenameAccountDialog } from "./RenameAccountDialog";

const WORK: AccountSummary = {
  id: "acc_1a2b3c4d",
  cli: "claude",
  label: "Work",
  displayName: "Work",
  email: "gaurav@acme.io",
  plan: "Team",
  method: "sign_in",
  auth: "signed_in",
  isDefault: false,
  limited: null,
  createdAt: null,
};

describe("RenameAccountDialog", () => {
  it("prefills the current label and sends null when the name is emptied", async () => {
    const renameAccount = vi.fn(async () => ({ ...WORK, label: null, displayName: "gaurav@acme.io" }));
    const onClose = vi.fn();
    render(
      <RenameAccountDialog
        open
        api={{ renameAccount }}
        cli="claude"
        cliName="claude"
        account={WORK}
        onClose={onClose}
      />,
    );

    const input = screen.getByLabelText("Name (optional)");
    expect(input).toHaveValue("Work");
    expect(
      screen.getByText("Prefilled names are optional. The email stays visible beside it."),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(renameAccount).toHaveBeenCalledWith("claude", "acc_1a2b3c4d", null));
    expect(onClose).toHaveBeenCalled();
  });
});
