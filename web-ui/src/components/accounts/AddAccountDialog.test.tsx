import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import type { AccountSummary, SupportedCli, ValidateAccountPathResponse } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { cliDisplayName } from "@/lib/cliNames";
import { AddAccountDialog } from "./AddAccountDialog";

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
    accountLink: {
      fieldLabel: "Claude config folder",
      fieldNote: null,
      exampleDir: "~/.claude-work",
      systemDir: "~/.claude",
      supportsApiKey: true,
      verifiesIdentity: true,
    },
    ...over,
  };
}

const SIGNED_IN: AccountSummary = {
  id: "acc_1a2b3c4d",
  cli: "claude",
  label: null,
  displayName: "gaurav@acme.io",
  email: "gaurav@acme.io",
  plan: "Team",
  method: "sign_in",
  auth: "signed_in",
  isDefault: false,
  limited: null,
  createdAt: "2026-11-13T10:00:00.000Z",
  dir: "~/.vibe-station/accounts/claude/work",
  createdByUs: true,
  pending: false,
};

const PENDING: AccountSummary = {
  id: "acc_9f8e7d6c",
  cli: "claude",
  label: null,
  displayName: "acc_9f8e7d6c",
  email: null,
  plan: null,
  method: "sign_in",
  auth: "unknown",
  isDefault: false,
  limited: null,
  createdAt: "2026-11-13T10:00:00.000Z",
  dir: "~/.claude-client-b",
  createdByUs: false,
  pending: true,
  signIn: { command: "CLAUDE_CONFIG_DIR=~/.claude-client-b claude auth login", hint: null },
};

const CREATE_DIR = "~/.vibe-station/accounts/claude/work";

function makeApi(over: Partial<Record<string, unknown>> = {}) {
  const stub = {
    validateAccountPath: vi.fn(async (body: { mode: string; dir?: string }): Promise<ValidateAccountPathResponse> =>
      body.mode === "create"
        ? { dir: CREATE_DIR, exists: false, isEmpty: true, looksValid: true }
        : { dir: body.dir ?? "", exists: true, isEmpty: false, looksValid: true },
    ),
    addFolderAccount: vi.fn(async () => ({ account: PENDING, signedIn: false })),
    refreshAccount: vi.fn(async () => PENDING),
    removeAccount: vi.fn(async () => ({ ok: true as const, stoppedSessionIds: [], folderDeleted: false })),
    restartAccountSignIn: vi.fn(async () => ({ attemptId: "att_1", accountId: PENDING.id, sessionId: "sess-1" })),
    renameAccount: vi.fn(async (_cli: string, _id: string, label: string | null) => ({
      ...SIGNED_IN,
      label,
      displayName: label ?? SIGNED_IN.displayName,
    })),
    createApiKeyAccount: vi.fn(async () => SIGNED_IN),
    fsComplete: vi.fn(async () => ({ entries: [] })),
    ...over,
  };
  return { stub, api: stub as unknown as ApiInstance };
}

function renderDialog(api: ApiInstance, c: SupportedCli = cli(), onClose = vi.fn(), initialDir?: string) {
  const view = render(
    <AddAccountDialog open api={api} cli={c} onClose={onClose} initialDir={initialDir} />,
  );
  return { ...view, onClose };
}

function typeInto(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  useServerStore.setState({ accounts: [], accountsLoaded: false, worktrees: [] });
});

describe("AddAccountDialog", () => {
  it("default_is_create_new_folder_with_path_preview", async () => {
    const { api, stub } = makeApi();
    renderDialog(api);
    expect(screen.getByRole("radio", { name: "Create a new folder for me" })).toBeChecked();
    expect(await screen.findByText("Will create a folder in ~/.vibe-station/accounts/claude/")).toBeInTheDocument();
    expect(screen.queryByText(`Will create ${CREATE_DIR}`)).toBeNull();
    expect(stub.validateAccountPath).toHaveBeenCalledWith({ cli: "claude", mode: "create", label: undefined });
  });

  it("named_create_shows_exact_folder", async () => {
    const { api } = makeApi();
    renderDialog(api);
    typeInto("Name (optional)", "Work");
    expect(await screen.findByText(`Will create ${CREATE_DIR}`)).toBeInTheDocument();
  });

  it("dialog_card_has_accounts_sheet_class", () => {
    const { api } = makeApi();
    renderDialog(api);
    expect(document.querySelector(".dialog-card.accounts-dialog-card")).not.toBeNull();
    expect(document.querySelector(".dialog-overlay.dialog-overlay--flush")).not.toBeNull();
  });

  it("check_again_duplicate_identity_returns_to_folder_step_with_server_text", async () => {
    const message = 'a@b.c is already added as "Work". Nothing was added; your folder is untouched.';
    const { api } = makeApi({
      refreshAccount: vi.fn(async () => {
        throw new ApiError(JSON.stringify({ error: message, code: "duplicate_account" }), 409, "duplicate_account");
      }),
    });
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText(/Waiting for sign-in/);
    fireEvent.click(await screen.findByRole("button", { name: /Check again/ }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Create a new folder for me" })).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for sign-in/)).toBeNull();
  });

  it("continue_disabled_while_refusal_shows", async () => {
    const { api } = makeApi({
      validateAccountPath: vi.fn(async () => {
        throw new ApiError(
          JSON.stringify({ error: `Work is already a ${cliDisplayName("claude")} account name.`, code: "label_taken" }),
          409,
          "label_taken",
        );
      }),
    });
    renderDialog(api);
    typeInto("Name (optional)", "Work");
    expect(await screen.findByRole("alert")).toHaveTextContent(`Work is already a ${cliDisplayName("claude")} account name.`);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("choose_folder_signed_in_shows_added_with_email_prefilled", async () => {
    const { api, stub } = makeApi({
      addFolderAccount: vi.fn(async () => ({ account: SIGNED_IN, signedIn: true })),
    });
    renderDialog(api);
    fireEvent.click(screen.getByRole("radio", { name: "Choose a folder" }));
    typeInto("Claude config folder", "~/.claude-client-b");
    const cont = await waitFor(() => {
      const button = screen.getByRole("button", { name: "Continue" });
      expect(button).toBeEnabled();
      return button;
    });
    fireEvent.click(cont);
    expect(await screen.findByText("Account added")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByLabelText("Name (optional)")).toHaveValue("gaurav@acme.io");
    expect(stub.addFolderAccount).toHaveBeenCalledWith({
      cli: "claude",
      mode: "choose",
      dir: "~/.claude-client-b",
    });
  });

  it("done_renames_only_when_edited", async () => {
    const { api, stub } = makeApi({
      addFolderAccount: vi.fn(async () => ({ account: SIGNED_IN, signedIn: true })),
    });
    const { onClose } = renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Account added");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(stub.renameAccount).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    typeInto("Name (optional)", "Work");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(stub.renameAccount).toHaveBeenCalledWith("claude", SIGNED_IN.id, "Work"));
  });

  it("not_signed_in_shows_waiting_steps_no_terminal_opened", async () => {
    const { api, stub } = makeApi();
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Waiting for sign-in")).toBeInTheDocument();
    expect(screen.getByText(PENDING.signIn!.command!)).toBeInTheDocument();
    expect(stub.restartAccountSignIn).not.toHaveBeenCalled();
  });

  it("check_again_completes_pending_to_added", async () => {
    const confirmed: AccountSummary = {
      ...PENDING,
      pending: false,
      auth: "signed_in",
      email: "gb@side.dev",
      displayName: "gb@side.dev",
    };
    const { api, stub } = makeApi({ refreshAccount: vi.fn(async () => confirmed) });
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(stub.refreshAccount).toHaveBeenCalledWith("claude", PENDING.id));
    expect(await screen.findByText("Account added")).toBeInTheDocument();
  });

  it("open_in_terminal_tab_calls_restart_sign_in_and_focuses_session", async () => {
    useServerStore.setState({ worktrees: [{ id: "wt1", projectId: "p1" } as never] });
    useWorkspaceStore.setState({ activeProjectId: "p1", activeWorktreeId: null });
    const { api, stub } = makeApi();
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Waiting for sign-in");
    fireEvent.click(screen.getByRole("button", { name: "Open in a terminal tab" }));
    await waitFor(() => expect(stub.restartAccountSignIn).toHaveBeenCalledWith("claude", PENDING.id, "wt1"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancel_in_waiting_removes_the_account", async () => {
    const { api, stub } = makeApi();
    const { onClose } = renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Waiting for sign-in");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    await waitFor(() => expect(stub.removeAccount).toHaveBeenCalledWith("claude", PENDING.id));
    expect(onClose).toHaveBeenCalled();
  });

  it("added_step_has_one_done_footer_button", async () => {
    const { api } = makeApi({ addFolderAccount: vi.fn(async () => ({ account: SIGNED_IN, signedIn: true })) });
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Account added")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("added_step_shows_first_run_note_only_when_set", async () => {
    const { api } = makeApi({ addFolderAccount: vi.fn(async () => ({ account: SIGNED_IN, signedIn: true })) });
    const base = cli();
    const withNote = cli({ accountLink: { ...base.accountLink!, firstRunNote: "First run shows setup." } });
    const first = renderDialog(api, withNote);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("First run shows setup.")).toBeInTheDocument();
    first.unmount();
    renderDialog(api, base);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Account added");
    expect(screen.queryByText("First run shows setup.")).toBeNull();
  });

  it("waiting_step_shows_first_run_note_before_a_terminal_opens", async () => {
    const { api, stub } = makeApi();
    const base = cli();
    const first = renderDialog(api, cli({ accountLink: { ...base.accountLink!, firstRunNote: "NOTE" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Waiting for sign-in");
    expect(screen.getByText("NOTE")).toBeInTheDocument();
    expect(stub.restartAccountSignIn).not.toHaveBeenCalled();
    first.unmount();
    const { container } = renderDialog(api, base);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Waiting for sign-in");
    expect(document.querySelector(".accounts-dialog__help")).toBeNull();
    expect(container).toBeDefined();
  });

  it("api_key_footer_order_is_back_cancel_add", async () => {
    const { api } = makeApi();
    renderDialog(api);
    fireEvent.click(screen.getByRole("button", { name: "Use an API key instead" }));
    const names = screen
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => t === "Back" || t === "Cancel" || t === "Add account");
    expect(names).toEqual(["Back", "Cancel", "Add account"]);
    expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Work or Personal");
  });

  it("waiting_cancel_disabled_while_removing_no_double_delete", async () => {
    let finish: () => void = () => {};
    const removeAccount = vi.fn(
      () =>
        new Promise<{ ok: true; stoppedSessionIds: string[]; folderDeleted: boolean }>((resolve) => {
          finish = () => resolve({ ok: true, stoppedSessionIds: [], folderDeleted: false });
        }),
    );
    const { api } = makeApi({ removeAccount });
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Waiting for sign-in");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(removeAccount).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("terminal_button_absent_without_a_worktree", async () => {
    useServerStore.setState({ worktrees: [] });
    useWorkspaceStore.setState({ activeProjectId: null, activeWorktreeId: null });
    const { api } = makeApi();
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Waiting for sign-in");
    expect(screen.queryByRole("button", { name: "Open in a terminal tab" })).toBeNull();
    expect(screen.queryByText(/Open a project/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("api_key_link_only_when_supported", () => {
    const { api } = makeApi();
    const supported = renderDialog(api, cli());
    expect(screen.getByRole("button", { name: "Use an API key instead" })).toBeInTheDocument();
    supported.unmount();
    renderDialog(api, cli({ accountLink: { ...cli().accountLink!, supportsApiKey: false } }));
    expect(screen.queryByRole("button", { name: "Use an API key instead" })).toBeNull();
  });

  it("api_key_flow_clears_key_before_request_and_never_renders_it", async () => {
    const { api, stub } = makeApi();
    renderDialog(api);
    fireEvent.click(screen.getByRole("button", { name: "Use an API key instead" }));
    typeInto("Name", "Team key");
    typeInto("API key", "sk-secret-123");
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    await waitFor(() =>
      expect(stub.createApiKeyAccount).toHaveBeenCalledWith({
        cli: "claude",
        method: "api_key",
        apiKey: "sk-secret-123",
        label: "Team key",
      }),
    );
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(document.body.textContent).not.toContain("sk-secret-123");
  });

  it("label_taken_message", async () => {
    const { api } = makeApi({
      addFolderAccount: vi.fn(async () => {
        throw new ApiError(JSON.stringify({ error: "taken", code: "label_taken" }), 409, "label_taken");
      }),
    });
    renderDialog(api);
    typeInto("Name (optional)", "Work");
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Work is already a ${cliDisplayName("claude")} account name.`);
  });

  it("duplicate_account_shows_server_text_and_nothing_added", async () => {
    const text = 'gb@side.dev is already added as "Work". Nothing was added; your folder is untouched.';
    const { api } = makeApi({
      addFolderAccount: vi.fn(async () => {
        throw new ApiError(JSON.stringify({ error: text, code: "duplicate_account" }), 409, "duplicate_account");
      }),
    });
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByText("Account added")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("create_failed_shows_server_text", async () => {
    const text = "Could not create this folder. Nothing was added.";
    const { api } = makeApi({
      addFolderAccount: vi.fn(async () => {
        throw new ApiError(JSON.stringify({ error: text, code: "folder_create_failed" }), 500, "folder_create_failed");
      }),
    });
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("reopen_starts_clean", async () => {
    const { api } = makeApi();
    const c = cli();
    const { rerender } = render(<AddAccountDialog open api={api} cli={c} onClose={vi.fn()} />);
    typeInto("Name (optional)", "Work");
    rerender(<AddAccountDialog open={false} api={api} cli={c} onClose={vi.fn()} />);
    rerender(<AddAccountDialog open api={api} cli={c} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Name (optional)")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "Create a new folder for me" })).toBeChecked();
  });

  it("entry_from_picker_preselects_harness", () => {
    const { api } = makeApi();
    renderDialog(api);
    expect(screen.getByText(`Add ${cliDisplayName("claude")} account`)).toBeInTheDocument();
  });
});
