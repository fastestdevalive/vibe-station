import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { AccountSummary, Mode } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useModesStore } from "@/store/modesStore";
import { AccountBadge } from "./AccountBadge";

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

function mode(id: string, cli: Mode["cli"]): Mode {
  return { id, name: id, cli, context: "" };
}

const SYSTEM = acct({ id: "system", cli: "claude", displayName: "System login", method: "system", isDefault: true });
const WORK = acct({ id: "acc_work", cli: "claude", displayName: "Work" });

beforeEach(() => {
  useServerStore.setState({ accounts: [SYSTEM, WORK], accountsLoaded: true });
  useModesStore.setState({
    modes: new Map([
      ["claude-mode", mode("claude-mode", "claude")],
      ["opencode-mode", mode("opencode-mode", "opencode")],
    ]),
    loaded: true,
  });
});

describe("AccountBadge", () => {
  it("shows the account name for a CLI with several accounts", () => {
    render(<AccountBadge session={{ modeId: "claude-mode", accountId: WORK.id }} />);
    expect(screen.getByRole("img", { name: "Account: Work" })).toBeInTheDocument();
  });

  it("shows the System login's name for a session with no account id", () => {
    render(<AccountBadge session={{ modeId: "claude-mode", accountId: null }} />);
    expect(screen.getByRole("img", { name: "Account: System login" })).toBeInTheDocument();
  });

  describe("hideDefault", () => {
    it("hides the mark for the CLI's default account (System, explicit or implicit)", () => {
      const { container, rerender } = render(<AccountBadge hideDefault session={{ modeId: "claude-mode", accountId: null }} />);
      expect(container.firstChild).toBeNull();
      rerender(<AccountBadge hideDefault session={{ modeId: "claude-mode", accountId: "system" }} />);
      expect(container.firstChild).toBeNull();
    });

    it("shows a non-default account while System is the default", () => {
      render(<AccountBadge hideDefault session={{ modeId: "claude-mode", accountId: WORK.id }} />);
      expect(screen.getByRole("img", { name: "Account: Work" })).toBeInTheDocument();
    });

    it("hides a non-System account when it is the default, and shows System then", () => {
      useServerStore.setState({ accounts: [{ ...SYSTEM, isDefault: false }, { ...WORK, isDefault: true }], accountsLoaded: true });
      const { container, rerender } = render(<AccountBadge hideDefault session={{ modeId: "claude-mode", accountId: WORK.id }} />);
      expect(container.firstChild).toBeNull();
      rerender(<AccountBadge hideDefault session={{ modeId: "claude-mode", accountId: null }} />);
      expect(screen.getByRole("img", { name: "Account: System login" })).toBeInTheDocument();
    });

    it("still marks a default account that needs attention", () => {
      useServerStore.setState({ accounts: [{ ...SYSTEM, auth: "signed_out" }, WORK], accountsLoaded: true });
      render(<AccountBadge hideDefault session={{ modeId: "claude-mode", accountId: null }} />);
      expect(screen.getByRole("img", { name: /Account: System login/ })).toBeInTheDocument();
    });

    it("still marks a removed account", () => {
      render(<AccountBadge hideDefault session={{ modeId: "claude-mode", accountId: "acc_gone" }} />);
      expect(screen.getByRole("img", { name: "Account: Account removed" })).toBeInTheDocument();
    });
  });

  it("is absent for a single-account CLI", () => {
    // opencode has only its virtual System row in this fixture.
    useServerStore.setState({
      accounts: [...useServerStore.getState().accounts, acct({ id: "system", cli: "opencode", displayName: "System login", method: "system", isDefault: true })],
    });
    const { container } = render(<AccountBadge session={{ modeId: "opencode-mode", accountId: null }} />);
    expect(container.firstChild).toBeNull();
  });

  it("says 'Account removed' when the stored account id is no longer listed", () => {
    render(<AccountBadge session={{ modeId: "claude-mode", accountId: "acc_gone" }} />);
    expect(screen.getByRole("img", { name: "Account: Account removed" })).toBeInTheDocument();
  });

  it("is absent when the session's mode (and therefore its CLI) is unknown", () => {
    const { container } = render(<AccountBadge session={{ modeId: "unknown-mode", accountId: WORK.id }} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "Account removed" when the only named account is gone', () => {
    useServerStore.setState({ accounts: [SYSTEM] });
    render(<AccountBadge session={{ modeId: "claude-mode", accountId: "acc_gone" }} />);
    expect(screen.getByRole("img", { name: "Account: Account removed" })).toBeInTheDocument();
  });

  it("shows nothing before accounts load", () => {
    useServerStore.setState({ accounts: [SYSTEM], accountsLoaded: false });
    const { container } = render(<AccountBadge session={{ modeId: "claude-mode", accountId: "acc_gone" }} />);
    expect(container.firstChild).toBeNull();
  });

  it("loads the modes cache itself when given an api (R2F-08)", async () => {
    useModesStore.setState({ modes: new Map(), loaded: false });
    const api = {
      listModes: vi.fn().mockResolvedValue([mode("claude-mode", "claude")]),
      on: vi.fn(() => () => {}),
    } as unknown as ApiInstance;
    render(<AccountBadge session={{ modeId: "claude-mode", accountId: WORK.id }} api={api} />);
    await waitFor(() => expect(screen.getByRole("img", { name: "Account: Work" })).toBeInTheDocument());
  });
});
