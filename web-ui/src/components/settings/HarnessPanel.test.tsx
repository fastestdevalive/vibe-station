import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { AccountSummary, SupportedCli } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { HarnessPanel } from "./HarnessPanel";

function cli(over: Partial<SupportedCli> = {}): SupportedCli {
  return {
    id: "claude",
    defaultModel: "sonnet",
    supportsJson: true,
    supportsTerminalDelivery: false,
    supportsTerminalComments: false,
    importsNativeHistory: true,
    supportsJsonToTerminalResume: true,
    detected: true,
    starterBundleNames: [],
    usingFallbackOnly: false,
    defaultChannel: "json",
    defaultChannelOverridden: false,
    supportsAccounts: true,
    accountSwitch: "native",
    accountsNote: null,
    ...over,
  };
}

const SYSTEM: AccountSummary = {
  id: "system",
  cli: "claude",
  label: null,
  displayName: "System login",
  email: "me@personal.dev",
  plan: "Max",
  method: "system",
  auth: "signed_in",
  isDefault: true,
  limited: null,
  createdAt: null,
};

beforeEach(() => {
  useServerStore.setState({ accounts: [], accountsLoaded: false });
});

describe("HarnessPanel accounts block", () => {
  it("mounts the Accounts block below the default-channel row for a supporting CLI", () => {
    useServerStore.setState({ accounts: [SYSTEM] });
    render(
      <HarnessPanel api={createMockApi()} cli={cli()} hasAnyMode={false} onChanged={vi.fn()} />,
    );
    expect(screen.getByTestId("default-channel-claude")).toBeInTheDocument();
    expect(screen.getByText("Accounts")).toBeInTheDocument();
    // Exactly one Add account button, even with only the System row.
    expect(screen.getAllByRole("button", { name: "Add account" })).toHaveLength(1);
    expect(screen.getByTestId("account-row-system")).toBeInTheDocument();
  });
});
