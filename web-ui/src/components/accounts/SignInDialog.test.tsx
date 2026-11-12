import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "@/api/types";
import { SignInDialog } from "./SignInDialog";

vi.mock("./signInTerminal", () => ({
  openSignInTerminal: vi.fn(),
  useCanOpenSignInTerminal: () => false,
}));

const WAITING: AccountSummary = {
  id: "acc_bdefbb56",
  cli: "claude",
  label: null,
  displayName: "acc_bdefbb56",
  email: null,
  plan: null,
  method: "sign_in",
  auth: "unknown",
  isDefault: false,
  limited: null,
  createdAt: null,
  pending: true,
  dir: "~/.claude-new",
  createdByUs: false,
  signIn: { command: "CLAUDE_CONFIG_DIR=~/.claude-new claude auth login", hint: null },
};

describe("SignInDialog", () => {
  it("names a waiting account 'New account', never its id", () => {
    const api = { refreshAccount: vi.fn(), restartAccountSignIn: vi.fn() };
    render(<SignInDialog open api={api} cli="claude" account={WAITING} verifiesIdentity onClose={vi.fn()} />);
    expect(screen.getByText("Sign in to New account")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    const clone = dialog.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("code").forEach((c) => c.remove());
    expect(clone.textContent).not.toMatch(/acc_/);
  });

  it("shows the CLI's first-run note under the steps when set, not otherwise", () => {
    const api = { refreshAccount: vi.fn(), restartAccountSignIn: vi.fn() };
    const { rerender } = render(
      <SignInDialog open api={api} cli="claude" account={WAITING} verifiesIdentity firstRunNote="Pick a theme first." onClose={vi.fn()} />,
    );
    expect(screen.getByText("Pick a theme first.")).toHaveClass("accounts-dialog__help");
    rerender(<SignInDialog open api={api} cli="claude" account={WAITING} verifiesIdentity onClose={vi.fn()} />);
    expect(screen.queryByText("Pick a theme first.")).toBeNull();
  });
});
