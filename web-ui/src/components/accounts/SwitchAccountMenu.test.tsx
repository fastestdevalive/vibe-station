import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { SwitchAccountMenu } from "./SwitchAccountMenu";

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => mobile.value,
  MOBILE_QUERY: "(max-width: 768px)",
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

const SYSTEM = acct({ id: "system", cli: "claude", displayName: "System login", method: "system", isDefault: true });
const WORK = acct({ id: "acc_work", cli: "claude", displayName: "Work", email: "gaurav@acme.io" });
const CLIENT_B = acct({ id: "acc_client", cli: "claude", displayName: "Client B", auth: "signed_out" });

function anchorRef() {
  const el = document.createElement("button");
  el.id = "trigger";
  return { current: el };
}

beforeEach(() => {
  mobile.value = false;
  useServerStore.setState({ accounts: [SYSTEM, WORK, CLIENT_B], accountsLoaded: true });
});

describe("SwitchAccountMenu", () => {
  it("lists the CLI's accounts with the current one checked", () => {
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId="acc_work" onPick={vi.fn()} onClose={vi.fn()} />);
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows).toHaveLength(3);
    expect(screen.getByRole("menuitemradio", { name: /Work/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /System login/ })).toHaveAttribute("aria-checked", "false");
  });

  it("shows the explanatory caption and a Signed out word on the signed-out row", () => {
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId="acc_work" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/Switch this agent to another account\. It restarts there/)).toBeInTheDocument();
    const row = screen.getByRole("menuitemradio", { name: /Client B/ });
    expect(row).toHaveTextContent("Signed out");
    expect(row.textContent).not.toContain("⚠");
    expect(screen.getByRole("menuitemradio", { name: /Work/ })).toHaveTextContent("Current");
  });

  it("disables a signed-out row and never picks it", () => {
    const onPick = vi.fn();
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId={null} onPick={onPick} onClose={vi.fn()} />);
    const row = screen.getByRole("menuitemradio", { name: /Client B/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("pending_account_is_not_listed", () => {
    const pending = acct({ id: "acc_pending", cli: "claude", displayName: "Waiting Person", pending: true });
    useServerStore.setState({ accounts: [SYSTEM, WORK, pending], accountsLoaded: true });
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId={null} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText("Waiting Person")).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /Work/ })).toBeInTheDocument();
  });

  it("picks the clicked account", () => {
    const onPick = vi.fn();
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId={null} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Work/ }));
    expect(onPick).toHaveBeenCalledWith("acc_work");
  });

  it("moves with arrow keys (skipping the signed-out row) and picks on Enter", () => {
    const onPick = vi.fn();
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId="system" onPick={onPick} onClose={vi.fn()} />);
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("acc_work");
  });

  it("renders into the portal root, not beside the trigger", () => {
    const wrap = document.createElement("div");
    document.body.appendChild(wrap);
    const trigger = document.createElement("button");
    wrap.appendChild(trigger);
    const { container } = render(
      <SwitchAccountMenu anchorRef={{ current: trigger }} cli="claude" currentAccountId={null} onPick={vi.fn()} onClose={vi.fn()} />,
    );
    const menu = screen.getByRole("menu");
    expect(container.contains(menu)).toBe(false);
    expect(wrap.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ top: "8px" });
    wrap.remove();
  });

  it("does not show the Default chip on any row", () => {
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId="acc_work" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText("Default")).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /Work/ })).toHaveTextContent("Current");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId={null} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a bottom sheet with a backdrop on phones", () => {
    mobile.value = true;
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId={null} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector(".limits-popup-backdrop")).not.toBeNull();
    expect(document.querySelector(".account-menu")).not.toBeNull();
  });

  it("focuses the first usable row when the current account is signed out", () => {
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId="acc_client" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("menuitemradio", { name: /System login/ })).toHaveFocus();
  });

  it("Enter on the current row closes without calling onPick", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId="acc_work" onPick={onPick} onClose={onClose} />);
    const current = screen.getByRole("menuitemradio", { name: /Work/ });
    expect(current).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(current);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("Escape closes when no row is usable", () => {
    useServerStore.setState({ accounts: [{ ...CLIENT_B }] });
    const onClose = vi.fn();
    render(<SwitchAccountMenu anchorRef={anchorRef()} cli="claude" currentAccountId="acc_client" onPick={vi.fn()} onClose={onClose} />);
    expect(screen.getByRole("menu")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
