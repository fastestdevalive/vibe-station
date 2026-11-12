import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/errors";
import { createMockApi } from "@/api/mock";
import type { AccountSummary, SupportedCli } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { AccountsBlock } from "./AccountsBlock";

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
  plan: "Max",
  method: "system",
  isDefault: true,
});

const WORK = acct({
  id: "acc_1a2b3c4d",
  cli: "claude",
  label: "Work",
  displayName: "Work",
  email: "gaurav@acme.io",
  plan: "Team",
  limited: { windowId: "five_hour", resetsAt: null, source: "poller" },
});

const SIDE = acct({
  id: "acc_2b3c4d5e",
  cli: "claude",
  displayName: "gb@side.dev",
  email: "gb@side.dev",
  plan: "Pro",
});

const CLIENT_B = acct({
  id: "acc_3c4d5e6f",
  cli: "claude",
  label: "Client B",
  displayName: "Client B",
  auth: "signed_out",
});

beforeEach(() => {
  useServerStore.setState({ accounts: [], accountsLoaded: false });
});

describe("AccountsBlock", () => {
  it("renders nothing when accounts are unsupported and there is no note", () => {
    const { container } = render(
      <AccountsBlock api={createMockApi()} cli={cli({ supportsAccounts: false })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders only the header and the plugin's note when unsupported", () => {
    render(
      <AccountsBlock
        api={createMockApi()}
        cli={cli({ supportsAccounts: false, accountsNote: "Needs a dedicated config dir." })}
      />,
    );
    expect(screen.getByText("Accounts")).toBeInTheDocument();
    expect(screen.getByText("Needs a dedicated config dir.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add account" })).toBeNull();
    expect(screen.queryAllByTestId(/^account-row-/)).toHaveLength(0);
  });

  it("a System row without an email carries the System login tag, not a raw id", () => {
    useServerStore.setState({
      accounts: [acct({ id: "system", cli: "claude", displayName: "System login", method: "system", isDefault: true })],
    });
    render(<AccountsBlock api={createMockApi()} cli={cli()} />);
    expect(screen.getAllByText("System login").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^acc_/)).toBeNull();
  });

  it("a signed-out row says Signed out with no warning glyph or fallback sentence", () => {
    useServerStore.setState({ accounts: [SYSTEM, CLIENT_B] });
    render(<AccountsBlock api={createMockApi()} cli={cli()} />);
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/⚠|never fall back|stay stopped/);
  });

  it("shows one row and exactly one Add account button for a single-account CLI", () => {
    useServerStore.setState({ accounts: [SYSTEM] });
    render(<AccountsBlock api={createMockApi()} cli={cli()} />);
    expect(screen.getAllByTestId(/^account-row-/)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Add account" })).toHaveLength(1);
    expect(screen.getByText("Claude · 1")).toBeInTheDocument();
  });

  it("shows the Default chip once, Signed out, Limited and a Sign in button with 4 accounts", () => {
    useServerStore.setState({ accounts: [SYSTEM, WORK, SIDE, CLIENT_B] });
    render(<AccountsBlock api={createMockApi()} cli={cli()} />);
    expect(screen.getAllByTestId(/^account-row-/)).toHaveLength(4);
    expect(screen.getAllByText("Default")).toHaveLength(1);
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(screen.getByText("Limited")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("Claude · 4")).toBeInTheDocument();
    expect(screen.queryByText(/^acc_/)).toBeNull();
  });

  it("Sign in opens the one sign-in dialog with the steps and opens no terminal until asked", () => {
    const signIn = { command: "claude auth login", hint: null };
    useServerStore.setState({ accounts: [SYSTEM, { ...CLIENT_B, signIn }], worktrees: [] });
    const api = { ...createMockApi(), restartAccountSignIn: vi.fn() };
    render(<AccountsBlock api={api} cli={cli()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("claude auth login")).toBeInTheDocument();
    // No worktree can host a terminal: the button is simply absent.
    expect(within(dialog).queryByRole("button", { name: "Open in a terminal tab" })).toBeNull();
    expect(screen.queryByText(/Open a project/)).toBeNull();
    expect(api.restartAccountSignIn).not.toHaveBeenCalled();
  });
});

const CLAUDE_LINK = {
  fieldLabel: "Claude config folder",
  fieldNote: null,
  exampleDir: "~/.claude-work",
  systemDir: "~/.claude",
  supportsApiKey: true,
  verifiesIdentity: true,
};

describe("AccountsBlock settings rows", () => {
  it("system_row_shows_system_dir", () => {
    useServerStore.setState({ accounts: [SYSTEM] });
    render(<AccountsBlock api={createMockApi()} cli={cli({ accountLink: CLAUDE_LINK })} />);
    expect(within(screen.getByTestId("account-row-system")).getByText(/~\/\.claude/)).toBeInTheDocument();
  });

  it("empty_state_copy_and_add_button", () => {
    useServerStore.setState({ accounts: [SYSTEM] });
    render(<AccountsBlock api={createMockApi()} cli={cli({ accountLink: CLAUDE_LINK })} />);
    expect(
      screen.getByText("Only this machine's login so far. Add another to choose an account per agent."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add account" })).toHaveLength(1);
  });

  it("count_excludes_pending_rows", () => {
    const pending = acct({ id: "acc_pend0002", cli: "claude", pending: true, auth: "unknown", createdByUs: false });
    useServerStore.setState({ accounts: [SYSTEM, WORK, pending] });
    render(<AccountsBlock api={createMockApi()} cli={cli({ accountLink: CLAUDE_LINK })} />);
    expect(screen.getByText("Claude · 2")).toBeInTheDocument();
  });

  it("no_detected_row", () => {
    useServerStore.setState({ accounts: [SYSTEM, WORK, SIDE] });
    render(<AccountsBlock api={createMockApi()} cli={cli({ accountLink: CLAUDE_LINK })} />);
    expect(screen.queryByText(/^Detected/)).toBeNull();
  });
});

describe("AccountsBlock duplicate identity", () => {
  it("row_check_duplicate_identity_removes_row_and_shows_block_error", async () => {
    const message = 'a@b.c is already added as "Work". Nothing was added; your folder is untouched.';
    const pending = acct({
      id: "acc_pend0001",
      cli: "claude",
      displayName: "acc_pend0001",
      auth: "unknown",
      pending: true,
      dir: "~/.claude-b",
      createdByUs: false,
      signIn: { command: "claude auth login", hint: null },
    });
    useServerStore.setState({ accounts: [SYSTEM, pending] });
    const api = {
      ...createMockApi(),
      refreshAccount: vi.fn(async () => {
        throw new ApiError(JSON.stringify({ error: message, code: "duplicate_account" }), 409, "duplicate_account");
      }),
    };
    render(<AccountsBlock api={api} cli={cli({ accountLink: CLAUDE_LINK })} />);
    fireEvent.click(within(screen.getByTestId("account-row-acc_pend0001")).getByRole("button", { name: "Finish sign-in" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByTestId("account-row-acc_pend0001")).toBeNull());
    expect(screen.getByText(message)).toBeInTheDocument();
  });
});

describe("AccountsBlock pending rows", () => {
  it("removes a pending row through the normal confirm dialog (no inline Cancel)", async () => {
    const pending = acct({
      id: "acc_pend0003",
      cli: "claude",
      displayName: "acc_pend0003",
      auth: "unknown",
      pending: true,
      dir: "~/.claude-c",
      createdByUs: false,
    });
    useServerStore.setState({ accounts: [SYSTEM, pending] });
    render(<AccountsBlock api={createMockApi()} cli={cli({ accountLink: CLAUDE_LINK })} />);
    const row = screen.getByTestId("account-row-acc_pend0003");
    expect(within(row).getByText("Waiting for sign-in")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /More actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unlink" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
