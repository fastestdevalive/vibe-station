import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary, LimitsResult } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { AccountPicker } from "./AccountPicker";

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => mobile.value,
  MOBILE_QUERY: "(max-width: 768px)",
}));

/** Deterministic per-account limits (the real hook boots the shared store). */
const limits = vi.hoisted(() => ({ results: {} as Record<string, LimitsResult> }));
vi.mock("@/hooks/useLimits", () => ({
  useLimits: () => ({
    resultFor: (_harness: string, accountId?: string) => {
      const key = !accountId || accountId === "system" ? "system" : accountId;
      return limits.results[key];
    },
  }),
}));

function acct(over: Partial<AccountSummary> & Pick<AccountSummary, "id" | "cli">): AccountSummary {
  return {
    label: null,
    displayName: over.id,
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

const SYSTEM = acct({
  id: "system",
  cli: "claude",
  displayName: "System login",
  email: "me@personal.dev",
  method: "system",
  isDefault: true,
});
const WORK = acct({ id: "acc_work", cli: "claude", displayName: "Work", email: "gaurav@acme.io" });
const SIDE = acct({ id: "acc_side", cli: "claude", displayName: "gb@side.dev", email: "gb@side.dev" });
const CLIENT_B = acct({ id: "acc_client", cli: "claude", displayName: "Client B", auth: "signed_out" });

function limitResult(accountId: string, usedPct: number): LimitsResult {
  return {
    harness: "claude",
    accountId,
    status: "ok",
    message: null,
    asOf: new Date().toISOString(),
    windows: [
      {
        harness: "claude",
        accountId,
        windowId: "five_hour",
        cadenceMinutes: 300,
        usedPct,
        resetsAt: null,
        asOf: new Date().toISOString(),
        status: "ok",
      },
    ],
  };
}

beforeEach(() => {
  mobile.value = false;
  limits.results = {};
  useServerStore.setState({ accounts: [SYSTEM, WORK, SIDE, CLIENT_B], accountsLoaded: true });
});

function renderPicker(onChange = vi.fn()) {
  render(<AccountPicker cli="claude" value="acc_work" onChange={onChange} />);
  return onChange;
}

describe("AccountPicker", () => {
  it("renders nothing for a CLI with a single account", () => {
    useServerStore.setState({ accounts: [SYSTEM] });
    const { container } = render(<AccountPicker cli="claude" value={undefined} onChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("api_key_row_says_api_key_not_status_unknown", () => {
    const KEYED = acct({ id: "acc_key", cli: "claude", displayName: "Keyed", method: "api_key", auth: "unknown" });
    const UNK = acct({ id: "acc_unk", cli: "claude", displayName: "Linked", method: "sign_in", auth: "unknown" });
    useServerStore.setState({ accounts: [SYSTEM, WORK, KEYED, UNK] });
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    const keyed = screen.getByRole("menuitemradio", { name: /Keyed/ });
    expect(keyed.textContent).toContain("API key");
    expect(keyed.textContent).not.toContain("Not verified");
    expect(screen.getByRole("menuitemradio", { name: /Linked/ }).textContent).toContain("Not verified");
  });

  it("opens a menuitemradio list with the picked account checked", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("System login"),
      expect.stringContaining("Work"),
      expect.stringContaining("gb@side.dev"),
      expect.stringContaining("Client B"),
    ]);
    expect(screen.getByRole("menuitemradio", { name: /Work/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /System login/ })).toHaveAttribute("aria-checked", "false");
    // The default is the preselected row, so no row carries a Default chip.
    expect(screen.queryByText("Default")).toBeNull();
    // The email prints once per row (the name is "Work", so it is the secondary line).
    expect(screen.getAllByText("gaurav@acme.io")).toHaveLength(1);
    expect(screen.getAllByText("gb@side.dev")).toHaveLength(1);
  });

  it("puts the check in the chip's trailing slot and the meter outside the chip and body", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    const checked = screen.getByRole("menuitemradio", { name: /Work/ });
    expect(checked.querySelector(".account-chip__trailing .account-picker__check")).not.toBeNull();
    expect(checked.querySelector(".account-picker__meter")).not.toBeNull();
    expect(checked.querySelector(".account-chip .account-picker__meter, .account-picker__body .account-picker__meter")).toBeNull();
  });

  it("gives the chip button the full name as its title", () => {
    renderPicker();
    expect(screen.getByRole("button", { name: "Account: Work" })).toHaveAttribute("title", "Work");
  });

  it("marks a signed-out row aria-disabled with its sign-in help line", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    const row = screen.getByRole("menuitemradio", { name: /Client B/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("Signed out");
    expect(row.textContent).not.toContain("⚠");
    expect(screen.getByText("Sign in to Client B from Settings.")).toBeInTheDocument();
  });

  it("does not pick a signed-out row", () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Client B/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves with arrow keys and picks the next account on Enter", () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("acc_side");
  });

  it("shows the account's tightest limit and names an account with room at >= 90%", () => {
    limits.results = { acc_work: limitResult("acc_work", 96) };
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    const row = screen.getByRole("menuitemradio", { name: /Work/ });
    expect(row).toHaveTextContent("96%");
    expect(row).toHaveTextContent("Work is close to its limit. System login has room.");
  });

  it("renders a bottom sheet on phones", () => {
    mobile.value = true;
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    expect(document.querySelector(".limits-popup-backdrop")).not.toBeNull();
    expect(document.querySelector(".account-picker__popover")).not.toBeNull();
  });
});

describe("AccountPicker add and pending rows", () => {
  it("footer_add_account_calls_handler_and_closes", () => {
    const onAddAccount = vi.fn();
    render(<AccountPicker cli="claude" value="acc_work" onChange={vi.fn()} onAddAccount={onAddAccount} />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "+ Add account…" }));
    expect(onAddAccount).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
  });

  it("footer_add_account_reachable_with_arrows_and_enter", () => {
    const onAddAccount = vi.fn();
    render(<AccountPicker cli="claude" value="acc_work" onChange={vi.fn()} onAddAccount={onAddAccount} />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    const footer = screen.getByRole("menuitem", { name: "+ Add account…" });
    const menu = screen.getByRole("menu", { name: "Account" });
    for (let i = 0; i < 4 && document.activeElement !== footer; i++) {
      fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
    }
    expect(document.activeElement).toBe(footer);
    fireEvent.keyDown(footer, { key: "Enter" });
    expect(onAddAccount).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
  });

  it("pending_row_not_listed", () => {
    useServerStore.setState({
      accounts: [SYSTEM, WORK, acct({ id: "acc_pending", cli: "claude", displayName: "Waiting Person", pending: true })],
    });
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    expect(screen.queryByText("Waiting Person")).toBeNull();
  });
});
