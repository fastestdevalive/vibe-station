import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "@/api/types";
import { SignInSteps } from "./SignInSteps";

const COMMAND = "CLAUDE_CONFIG_DIR=~/.claude-work claude auth login";

function acct(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "acc_1a2b3c4d",
    cli: "claude",
    label: "Work",
    displayName: "Work",
    email: null,
    plan: null,
    method: "sign_in",
    auth: "signed_out",
    isDefault: false,
    limited: null,
    createdAt: null,
    pending: true,
    signIn: { command: COMMAND, hint: null },
    ...over,
  };
}

function renderSteps(over: Partial<React.ComponentProps<typeof SignInSteps>> = {}) {
  const props = {
    account: acct(),
    verifiesIdentity: true,
    onCheck: vi.fn(async () => acct({ pending: false, auth: "signed_in" })),
    onOpenTerminal: vi.fn(),
    ...over,
  };
  render(<SignInSteps {...props} />);
  return props;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("SignInSteps", () => {
  it("renders_three_steps_with_command_and_copy", () => {
    renderSteps();
    expect(screen.getByText("Open a terminal on this machine")).toBeInTheDocument();
    expect(screen.getByText("Run this command")).toBeInTheDocument();
    expect(screen.getByText("Finish in your browser")).toBeInTheDocument();
    expect(screen.getByText(COMMAND).tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("hint_replaces_step_two_label", () => {
    renderSteps({ account: acct({ signIn: { command: "PI_CODING_AGENT_DIR=~/x pi", hint: "Run the command, then use /login inside." } }) });
    expect(screen.getByText("Run the command, then use /login inside.")).toBeInTheDocument();
    expect(screen.queryByText("Run this command")).toBeNull();
  });

  it("copy_announces_Copied_and_writes_clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    renderSteps();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COMMAND));
    const copied = await screen.findByRole("button", { name: "Copied" });
    expect(copied).toHaveAttribute("aria-live", "polite");
  });

  it("copy_failure_selects_text_and_says_press_ctrl_c", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    renderSteps();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText("Press Ctrl+C (⌘C on a Mac) to copy.")).toBeInTheDocument();
  });

  it("check_again_label_is_ive_signed_in_when_unverifiable", () => {
    renderSteps({ verifiesIdentity: false });
    expect(screen.getByRole("button", { name: "I've signed in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("check_again_shows_still_not_signed_in", async () => {
    const onCheck = vi.fn(async () => acct({ pending: true }));
    renderSteps({ onCheck });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Still not signed in.");
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it("check_again_disabled_while_running_no_double_call", async () => {
    let finish: (a: AccountSummary) => void = () => undefined;
    const onCheck = vi.fn(
      () =>
        new Promise<AccountSummary>((resolve) => {
          finish = resolve;
        }),
    );
    renderSteps({ onCheck });
    const button = screen.getByRole("button", { name: "Check again" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(onCheck).toHaveBeenCalledTimes(1);
    await act(async () => finish(acct({ pending: false, auth: "signed_in" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).not.toBeDisabled());
  });

  it("open_in_terminal_calls_handler", () => {
    const onOpenTerminal = vi.fn();
    renderSteps({ onOpenTerminal });
    fireEvent.click(screen.getByRole("button", { name: "Open in a terminal tab" }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("SignInSteps without a worktree", () => {
  it("renders no terminal button and no 'Open a project' text when canOpenTerminal is false", () => {
    renderSteps({ canOpenTerminal: false });
    expect(screen.queryByRole("button", { name: "Open in a terminal tab" })).toBeNull();
    expect(screen.queryByText(/Open a project/)).toBeNull();
    expect(screen.getByText(COMMAND)).toBeInTheDocument();
  });

  it("the Copied label reverts to Copy after 2 s", async () => {
    vi.useFakeTimers();
    try {
      stubClipboard(async () => undefined);
      renderSteps();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      });
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });
      expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
