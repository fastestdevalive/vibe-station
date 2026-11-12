import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { AccountSummary } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { AccountRow } from "./AccountRow";

type RowApi = Pick<ApiInstance, "refreshAccount" | "setDefaultAccount">;

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

function stubApi(over: Partial<Record<keyof RowApi, unknown>> = {}): RowApi {
  return {
    setDefaultAccount: vi.fn(async () => []),
    refreshAccount: vi.fn(),
    ...over,
  } as unknown as RowApi;
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
});

function renderRow(api: RowApi, account: AccountSummary) {
  return render(
    <AccountRow
      api={api}
      cli="claude"
      account={account}
      onRename={vi.fn()}
      onRemove={vi.fn()}
      onSignIn={vi.fn()}
    />,
  );
}

beforeEach(() => {
  useServerStore.setState({ accounts: [], accountsLoaded: false });
});

function openMenu(name: RegExp = /More actions for/) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("AccountRow", () => {
  it("a signed-in row does not carry the action modifier", () => {
    renderRow(stubApi(), WORK);
    expect(screen.getByTestId(`account-row-${WORK.id}`)).not.toHaveClass("accounts-row--action");
  });

  it("never offers Remove on the System row", () => {
    renderRow(stubApi(), SYSTEM);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Unlink" })).toBeNull();
  });

  it("shows the identity once: name, email once, Pro/Default chips, no raw id", () => {
    renderRow(stubApi(), acct({ ...WORK, plan: "pro", isDefault: true }));
    expect(screen.getAllByText("gaurav@acme.io")).toHaveLength(1);
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.queryByText(/^acc_/)).toBeNull();
    expect(screen.queryByText(/signed in/)).toBeNull();
  });

  it("Make default (in the menu) calls setDefaultAccount", async () => {
    const api = stubApi();
    renderRow(api, WORK);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Make default" }));
    await waitFor(() => expect(api.setDefaultAccount).toHaveBeenCalledWith("claude", "acc_1a2b3c4d"));
  });

  it("a signed-out row says Signed out, offers Sign in and Check again refreshes it", async () => {
    const onSignIn = vi.fn();
    const refreshed = acct({ ...SYSTEM, auth: "signed_in" });
    const api = stubApi({ refreshAccount: vi.fn(async () => refreshed) });
    render(
      <AccountRow
        api={api}
        cli="claude"
        account={acct({ ...SYSTEM, auth: "signed_out" })}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        onSignIn={onSignIn}
      />,
    );
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\u26A0/);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Check again" }));
    await waitFor(() => expect(api.refreshAccount).toHaveBeenCalledWith("claude", "system"));
    await waitFor(() => expect(screen.queryByText("Signed out")).toBeNull());
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("Escape closes the menu and refocuses its trigger", () => {
    renderRow(stubApi(), SYSTEM);
    openMenu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /More actions for/ })).toHaveFocus();
  });

  it("collapses every secondary action into one '⋯' menu (desktop and phone alike)", () => {
    renderRow(stubApi(), WORK);
    const menuButtons = screen.getAllByRole("button", { name: /More actions for/ });
    expect(menuButtons).toHaveLength(1);
    expect(menuButtons[0]).toHaveClass("accounts-row__menu-btn");
    expect(screen.queryByRole("button", { name: "Make default" })).toBeNull();
    fireEvent.click(menuButtons[0]!);
    for (const item of screen.getAllByRole("menuitem")) expect(item).toHaveClass("accounts-row__menu-item");
    expect(screen.getByRole("menuitem", { name: "Make default" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Unlink" })).toBeInTheDocument();
  });

  it('api-key row has no "Check again" and says "API key"', () => {
    renderRow(stubApi(), acct({ ...WORK, method: "api_key", auth: "unknown", plan: null }));
    expect(screen.getByText("API key")).toBeInTheDocument();
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Check again" })).toBeNull();
    expect(screen.queryByText(/Not verified/)).toBeNull();
  });

  it('"Check again" is disabled while a check is in flight', async () => {
    const refreshAccount = vi.fn(() => new Promise<AccountSummary>(() => {}));
    renderRow(stubApi({ refreshAccount }), acct({ ...WORK, auth: "unknown" }));
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Check again" }));
    openMenu();
    const busy = await screen.findByRole("menuitem", { name: /Checking/ });
    expect(busy).toBeDisabled();
    expect(refreshAccount).toHaveBeenCalledTimes(1);
  });
});

describe("AccountRow folder, pending and sign-in", () => {
  const FOLDER = acct({
    id: "acc_1a2b3c4d",
    cli: "claude",
    label: "Work",
    displayName: "Work",
    email: "gaurav@acme.io",
    dir: "~/.vibe-station/accounts/claude/work",
    createdByUs: true,
  });
  const PENDING = acct({
    id: "acc_9f8e7d6c",
    cli: "claude",
    displayName: "acc_9f8e7d6c",
    dir: "~/.claude-client-b",
    createdByUs: false,
    pending: true,
    auth: "unknown",
  });

  it("row_shows_dir_and_managed_by_label", () => {
    renderRow(stubApi(), FOLDER);
    expect(
      screen.getByText("gaurav@acme.io · ~/.vibe-station/accounts/claude/work · managed by vibe-station"),
    ).toBeInTheDocument();
  });

  it("system row shows its folder", () => {
    render(
      <AccountRow api={stubApi()} cli="claude" account={SYSTEM} systemDir="~/.claude" onRename={vi.fn()}
        onRemove={vi.fn()} onSignIn={vi.fn()} />,
    );
    expect(screen.getByText("me@personal.dev · ~/.claude")).toBeInTheDocument();
  });

  it("chosen_row_action_is_unlink_and_not_destructive", () => {
    renderRow(stubApi(), { ...FOLDER, createdByUs: false, dir: "~/.claude-client-b" });
    openMenu();
    const item = screen.getByRole("menuitem", { name: "Unlink" });
    expect(item.className).not.toContain("--destructive");
    expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
  });

  it("created_row_remove_is_destructive", () => {
    renderRow(stubApi(), FOLDER);
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Remove" }).className).toContain("--destructive");
  });

  it("pending row: name 'New account', 'Waiting for sign-in', Finish sign-in, Remove through the confirm", () => {
    const onSignIn = vi.fn();
    const onRemove = vi.fn();
    render(
      <AccountRow api={stubApi()} cli="claude" account={PENDING} onRename={vi.fn()} onRemove={onRemove}
        onSignIn={onSignIn} />,
    );
    expect(screen.getByText("New account")).toBeInTheDocument();
    expect(screen.queryByText(/^acc_/)).toBeNull();
    expect(screen.getByTestId(`account-row-${PENDING.id}`)).toHaveClass("accounts-row--action");
    expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unlink" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("a signed-out folder row shows Sign in without expanding any steps", () => {
    const onSignIn = vi.fn();
    const command = "CLAUDE_CONFIG_DIR=~/.claude-b claude auth login";
    const signedOut = acct({
      id: "acc_3c4d5e6f",
      cli: "claude",
      displayName: "Client B",
      auth: "signed_out",
      signIn: { command, hint: null },
    });
    render(
      <AccountRow api={stubApi()} cli="claude" account={signedOut} onRename={vi.fn()} onRemove={vi.fn()}
        onSignIn={onSignIn} />,
    );
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(screen.getByTestId("account-row-acc_3c4d5e6f")).toHaveClass("accounts-row--action");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(command)).toBeNull();
  });

  it("draws the state word inside the actions group, not the chip", () => {
    const { container } = renderRow(stubApi(), acct({ id: "acc_x", cli: "claude", displayName: "Gone", auth: "signed_out" }));
    expect(container.querySelector(".accounts-row__actions .account-chip__state")).not.toBeNull();
    expect(container.querySelector(".account-chip .account-chip__state")).toBeNull();
  });

  it("a signed-in account renders no state tag", () => {
    const { container } = renderRow(stubApi(), WORK);
    expect(container.querySelector(".account-chip__state")).toBeNull();
  });
});

describe("AccountRow menu placement", () => {
  const rectOf = (el: Element): DOMRect => {
    if (el.getAttribute("role") === "menu") return { top: 0, bottom: 100, left: 0, right: 192, width: 192, height: 100 } as DOMRect;
    if (el.classList.contains("accounts-row__menu-btn")) return (globalThis as { __btn?: DOMRect }).__btn as DOMRect;
    if (el.classList.contains("global-status-bar")) return { top: 580, bottom: 600, height: 20, left: 0, right: 400, width: 400 } as DOMRect;
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
  };

  function setup(btn: Partial<DOMRect>) {
    (globalThis as { __btn?: unknown }).__btn = { left: 300, width: 28, height: 28, ...btn };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return rectOf(this);
    });
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(400);
    const bar = document.createElement("div");
    bar.className = "global-status-bar";
    document.body.appendChild(bar);
    return () => {
      bar.remove();
      vi.restoreAllMocks();
    };
  }

  it("flips above the button when the status bar would cover it", () => {
    const done = setup({ top: 540, bottom: 568, right: 328 });
    renderRow(stubApi(), WORK);
    openMenu();
    expect(screen.getByRole("menu").style.top).toBe(`${540 - 100 - 4}px`);
    done();
  });

  it("opens under the button when there is room, and a scroll closes it", () => {
    const done = setup({ top: 100, bottom: 128, right: 328 });
    renderRow(stubApi(), WORK);
    openMenu();
    expect(screen.getByRole("menu").style.top).toBe("132px");
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).toBeNull();
    done();
  });
});
