import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AccountSummary } from "@/api/types";
import { AccountChip, AccountStateTag } from "./AccountChip";

function acct(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "acc_1a2b3c4d",
    cli: "claude",
    label: null,
    displayName: "Work",
    email: null,
    plan: null,
    method: "sign_in",
    auth: "signed_in",
    isDefault: false,
    limited: null,
    createdAt: null,
    ...over,
  };
}

describe("AccountChip", () => {
  it("draws the monogram from the display name", () => {
    const { rerender } = render(<AccountChip variant="inline" account={acct({ displayName: "jitoram007@gmail.com" })} />);
    expect(document.querySelector(".account-chip__mark")!.textContent).toBe("Ji");
    rerender(<AccountChip variant="inline" account={acct({ displayName: "Work" })} />);
    expect(document.querySelector(".account-chip__mark")!.textContent).toBe("Wo");
    rerender(<AccountChip variant="inline" account={acct({ id: "system", displayName: "System login" })} />);
    expect(document.querySelector(".account-chip__mark")!.textContent).toBe("Sy");
  });

  it("prints the email once, and not at all when it equals the name", () => {
    const { rerender } = render(
      <AccountChip variant="row" account={acct({ displayName: "Work", email: "w@acme.io" })} />,
    );
    expect(screen.getAllByText("w@acme.io")).toHaveLength(1);
    rerender(
      <AccountChip variant="row" account={acct({ displayName: "w@acme.io", email: "w@acme.io" })} />,
    );
    expect(screen.getAllByText("w@acme.io")).toHaveLength(1);
  });

  it("shows the plan with a capital letter and the Default chip", () => {
    render(<AccountChip variant="row" showPlan showDefault account={acct({ plan: "pro", isDefault: true })} />);
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("shows a state word for signed out, pending and not verified, and none when signed in", () => {
    const { rerender } = render(<AccountChip variant="row" account={acct({ auth: "signed_out" })} />);
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    rerender(<AccountChip variant="row" account={acct({ pending: true, auth: "unknown" })} />);
    expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument();
    rerender(<AccountChip variant="row" account={acct({ auth: "unknown" })} />);
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    rerender(<AccountChip variant="row" account={acct()} />);
    expect(document.querySelector(".account-chip__state")).toBeNull();
    expect(document.body.textContent).not.toMatch(/⚠/);
  });

  it("the mark variant exposes the full name and state as its accessible name", () => {
    const { rerender } = render(<AccountChip variant="mark" account={acct()} />);
    const mark = screen.getByRole("img", { name: "Account: Work" });
    expect(mark).toHaveAttribute("title", "Account: Work");
    rerender(<AccountChip variant="mark" account={acct({ auth: "signed_out" })} />);
    expect(screen.getByRole("img", { name: "Account: Work, Signed out" })).toBeInTheDocument();
  });

  it("the removed variant says Account removed with a dashed '?' monogram", () => {
    render(<AccountChip variant="row" removed />);
    expect(screen.getByText("Account removed")).toBeInTheDocument();
    expect(document.querySelector(".account-chip__mark")!.textContent).toBe("?");
    expect(document.querySelector(".account-chip")).toHaveAttribute("data-state", "removed");
  });

  it("tags the System login in its secondary line and appends the caller's detail", () => {
    render(
      <AccountChip
        variant="row"
        account={acct({ id: "system", displayName: "me@personal.dev", email: "me@personal.dev", method: "system" })}
        detail="~/.claude"
      />,
    );
    expect(screen.getByText("System login · ~/.claude")).toBeInTheDocument();
  });

  it("a name override replaces the display name", () => {
    render(<AccountChip variant="inline" account={acct({ displayName: "acc_9f8e7d6c" })} name="New account" />);
    expect(screen.getByText("New account")).toBeInTheDocument();
    expect(screen.queryByText(/^acc_/)).toBeNull();
  });

  it("hideState omits the state word from the row chip; AccountStateTag draws it", () => {
    const a = acct({ auth: "signed_out" });
    const { rerender } = render(<AccountChip variant="row" account={a} />);
    expect(document.querySelector(".account-chip__state")).not.toBeNull();
    rerender(<AccountChip variant="row" account={a} hideState />);
    expect(document.querySelector(".account-chip__state")).toBeNull();
    rerender(<AccountStateTag account={a} />);
    expect(document.querySelector(".account-chip__state")).not.toBeNull();
    rerender(<AccountStateTag account={acct()} />);
    expect(document.querySelector(".account-chip__state")).toBeNull();
  });
});
