import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountSummary, AccountUsage } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { RemoveAccountDialog, usageSentence } from "./RemoveAccountDialog";

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

const WORK = acct({
  id: "acc_1a2b3c4d",
  cli: "claude",
  label: "Work",
  displayName: "Work",
  email: "gaurav@acme.io",
  plan: "Team",
});

const USAGE: AccountUsage = {
  running: [
    { id: "sess-1", name: "Fix login" },
    { id: "sess-2", name: null },
  ],
  pastCount: 12,
};

const CREATED: AccountSummary = { ...WORK, dir: "~/.vibe-station/accounts/claude/work", createdByUs: true };
const CHOSEN: AccountSummary = { ...WORK, dir: "~/.claude-client-b", createdByUs: false };

describe("RemoveAccountDialog", () => {
  it("counts running and past sessions and removes the account", async () => {
    const removeAccount = vi.fn(async () => ({ ok: true as const, stoppedSessionIds: ["sess-1", "sess-2"] }));
    const api = { getAccountUsage: vi.fn(async () => USAGE), removeAccount };
    const onClose = vi.fn();
    render(
      <RemoveAccountDialog open api={api} cli="claude" account={CREATED} onClose={onClose} />,
    );

    expect(await screen.findByText(/2 running sessions will stop/)).toBeInTheDocument();
    expect(
      screen.getByText(/12 past sessions keep their history and will ask for an account when resumed/),
    ).toBeInTheDocument();
    expect(screen.getByText("This folder and its sign-in are deleted:")).toBeInTheDocument();
    expect(screen.getByText("Your System login is not touched.")).toBeInTheDocument();
    expect(api.getAccountUsage).toHaveBeenCalledWith("claude", "acc_1a2b3c4d");

    fireEvent.click(screen.getByRole("button", { name: "Remove and delete folder" }));
    await waitFor(() => expect(removeAccount).toHaveBeenCalledWith("claude", "acc_1a2b3c4d"));
    expect(onClose).toHaveBeenCalled();
  });

  it("remove_applies_removal_to_store_from_the_response", async () => {
    useServerStore.setState({ accounts: [CREATED] });
    const api = {
      getAccountUsage: vi.fn(async () => USAGE),
      removeAccount: vi.fn(async () => ({ ok: true as const, stoppedSessionIds: [], folderDeleted: true })),
    };
    render(<RemoveAccountDialog open api={api} cli="claude" account={CREATED} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove and delete folder" }));
    await waitFor(() => expect(useServerStore.getState().accounts).toHaveLength(0));
  });

  it("names a waiting account 'New account', never its id", async () => {
    const waiting: AccountSummary = {
      ...CREATED,
      id: "acc_bdefbb56",
      label: null,
      email: null,
      displayName: "acc_bdefbb56",
      pending: true,
    };
    const api = { getAccountUsage: vi.fn(async () => USAGE), removeAccount: vi.fn() };
    render(<RemoveAccountDialog open api={api} cli="claude" account={waiting} onClose={vi.fn()} />);
    expect(await screen.findByText('Remove "New account"?')).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    // The id may only appear inside a folder path <code>, never as a name.
    const clone = dialog.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("code").forEach((c) => c.remove());
    expect(clone.textContent).not.toMatch(/acc_/);
  });

  it("created_by_us_names_folder_and_says_deleted", async () => {
    const api = { getAccountUsage: vi.fn(async () => USAGE), removeAccount: vi.fn() };
    render(<RemoveAccountDialog open api={api} cli="claude" account={CREATED} onClose={vi.fn()} />);
    expect(await screen.findByText('Remove "Work"?')).toBeInTheDocument();
    expect(screen.getByText("This folder and its sign-in are deleted:")).toBeInTheDocument();
    expect(screen.getByText("~/.vibe-station/accounts/claude/work")).toBeInTheDocument();
    expect(screen.getByText("Your System login is not touched.")).toBeInTheDocument();
  });

  it("chosen_says_unlink_not_touched_and_button_not_destructive", async () => {
    const api = { getAccountUsage: vi.fn(async () => USAGE), removeAccount: vi.fn() };
    render(<RemoveAccountDialog open api={api} cli="claude" account={CHOSEN} onClose={vi.fn()} />);
    expect(await screen.findByText('Unlink "Work"?')).toBeInTheDocument();
    expect(
      screen.getByText(/vibe-station forgets this account\. Your folder is not touched and stays signed in:/),
    ).toBeInTheDocument();
    expect(screen.getByText("~/.claude-client-b")).toBeInTheDocument();
    expect(screen.getByText("You can add it again later.")).toBeInTheDocument();
    const unlink = screen.getByRole("button", { name: "Unlink" });
    expect(unlink.style.color).toBe("");
    expect(unlink.style.borderColor).toBe("");
  });

  it("unlink_calls_remove_account", async () => {
    const removeAccount = vi.fn(async () => ({ ok: true as const, stoppedSessionIds: [] }));
    const api = { getAccountUsage: vi.fn(async () => USAGE), removeAccount };
    const onClose = vi.fn();
    render(<RemoveAccountDialog open api={api} cli="claude" account={CHOSEN} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(removeAccount).toHaveBeenCalledWith("claude", "acc_1a2b3c4d"));
    expect(onClose).toHaveBeenCalled();
  });

  it("usage_sentence_uses_non_zero_parts_only", () => {
    expect(usageSentence(0, 0)).toBe("No sessions use this account.");
    expect(usageSentence(1, 0)).toBe("1 running session will stop.");
    expect(usageSentence(0, 1)).toBe(
      "1 past session keep their history and will ask for an account when resumed.",
    );
    expect(usageSentence(2, 12)).toBe(
      "2 running sessions will stop. 12 past sessions keep their history and will ask for an account when resumed.",
    );
  });
});
