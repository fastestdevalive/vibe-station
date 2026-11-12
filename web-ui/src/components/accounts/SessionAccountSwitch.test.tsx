import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import type { AccountSummary } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { SessionAccountSwitch } from "./SessionAccountSwitch";
import { useSwitchNotices } from "./useAccountSwitch";

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false, MOBILE_QUERY: "(max-width: 768px)" }));

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
const WORK = acct({ id: "acc_work", cli: "claude", displayName: "Work" });

function stubApi(fn?: ReturnType<typeof vi.fn>) {
  const switchSessionAccount =
    fn ?? vi.fn(async () => ({ ok: true as const, archivedSessionId: "a", newSessionId: "b", carryOver: "native" as const }));
  return { switchSessionAccount } as unknown as Pick<ApiInstance, "switchSessionAccount"> & {
    switchSessionAccount: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  useSwitchNotices.setState({ notices: {} });
  useServerStore.setState({ accounts: [SYSTEM, WORK], accountsLoaded: true });
});

describe("SessionAccountSwitch", () => {
  it("renders nothing for a CLI with one account", () => {
    useServerStore.setState({ accounts: [SYSTEM] });
    const { container } = render(
      <SessionAccountSwitch api={stubApi()} session={{ id: "s1", channel: "json", accountId: null }} cli="claude" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("picking another account calls switchSessionAccount once", async () => {
    const api = stubApi();
    render(<SessionAccountSwitch api={api} session={{ id: "s1", channel: "json", accountId: "acc_work" }} cli="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /System login/ }));
    await waitFor(() => expect(api.switchSessionAccount).toHaveBeenCalledTimes(1));
    expect(api.switchSessionAccount).toHaveBeenCalledWith("s1", "system");
  });

  it("shows the busy message for agent_busy", async () => {
    const api = stubApi(
      vi.fn(async () => {
        throw new ApiError(JSON.stringify({ error: "busy", code: "agent_busy" }), 409, "agent_busy");
      }),
    );
    render(<SessionAccountSwitch api={api} session={{ id: "s1", channel: "tmux", accountId: "acc_work" }} cli="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /System login/ }));
    expect(await screen.findByText("Wait for the agent to finish, then switch.")).toBeInTheDocument();
  });

  it("shows the daemon's reason, offers a way forward and keeps the original account after handover_failed (R2F-09)", async () => {
    const api = stubApi(
      vi.fn(async () => {
        throw new ApiError(
          JSON.stringify({ error: "The two copies differ. Nothing changed.", code: "handover_failed" }),
          409,
          "handover_failed",
        );
      }),
    );
    render(<SessionAccountSwitch api={api} session={{ id: "s1", channel: "json", accountId: "acc_work" }} cli="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /System login/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The two copies differ. Nothing changed.");
    expect(screen.getByRole("button", { name: "Switch with a transcript instead" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account: Work" })).toBeInTheDocument();
  });

  describe.each([
    ["json", "Switch with a transcript instead", "transcript"],
    ["tmux", "Switch and start a new conversation", "none"],
  ] as const)("refusal on a %s session (R6F-05)", (channel, label, carryOver) => {
    const refuse = () =>
      stubApi(
        vi.fn(async (_id: string, _to: string, opts?: unknown) => {
          if (opts) return { ok: true as const, archivedSessionId: "a", newSessionId: "b", carryOver: "none" as const };
          throw new ApiError(
            JSON.stringify({ error: "The chat was continued in both accounts, so a native hand-over is refused.", code: "handover_failed" }),
            409,
            "handover_failed",
          );
        }),
      );

    async function open(api: ReturnType<typeof stubApi>) {
      const view = render(<SessionAccountSwitch api={api} session={{ id: "s1", channel, accountId: "acc_work" }} cli="claude" />);
      fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: /System login/ }));
      await screen.findByRole("alert");
      return view;
    }

    it("renders text plus one real fallback button in a portaled container, outside the toolbar flow", async () => {
      const { container } = await open(refuse());
      const box = screen.getByTestId("switch-refusal");
      expect(container.contains(box)).toBe(false);
      expect(box).toContainElement(screen.getByRole("alert"));
      expect(screen.getByRole("alert")).toHaveTextContent("The chat was continued in both accounts");
      const buttons = screen.getAllByRole("button", { name: label });
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.tagName).toBe("BUTTON");
      expect(box).toContainElement(buttons[0]!);
      expect(screen.getByRole("alert")).not.toContainElement(buttons[0]!);
      // Nothing from the refusal sits in the chip's row, so the chip cannot shrink.
      expect(container.querySelector(".session-account__error-wrap, .session-account__error")).toBeNull();
      expect(container.querySelector(".session-account__btn")).toBeInTheDocument();
    });

    it("the button runs the fallback and closes the notice; Escape closes it too", async () => {
      const api = refuse();
      await open(api);
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(api.switchSessionAccount).toHaveBeenLastCalledWith("s1", "system", { carryOver }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });

    it("Escape dismisses the refusal and returns focus to the chip", async () => {
      await open(refuse());
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      expect(screen.queryByTestId("switch-refusal")).toBeNull();
      expect(screen.getByRole("button", { name: "Account: Work" })).toHaveFocus();
    });

    it("focuses the fallback button on open and traps Tab between it and Dismiss", async () => {
      await open(refuse());
      const primary = screen.getByRole("button", { name: label });
      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      await waitFor(() => expect(primary).toHaveFocus());
      dismiss.focus();
      fireEvent.keyDown(dismiss, { key: "Tab" });
      expect(primary).toHaveFocus();
      fireEvent.keyDown(primary, { key: "Tab", shiftKey: true });
      expect(dismiss).toHaveFocus();
      fireEvent.click(dismiss);
      expect(screen.queryByTestId("switch-refusal")).toBeNull();
      expect(screen.getByRole("button", { name: "Account: Work" })).toHaveFocus();
    });
  });

  it("stores a Terminal switch notice for the replacement session, not here", async () => {
    const api = stubApi(
      vi.fn(async () => ({
        ok: true as const,
        archivedSessionId: "a",
        newSessionId: "b",
        carryOver: "transcript" as const,
        accountSwitch: { fromAccountId: "acc_work", toAccountId: null, handover: "transcript" as const },
      })),
    );
    render(<SessionAccountSwitch api={api} session={{ id: "s1", channel: "tmux", accountId: "acc_work" }} cli="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Work" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /System login/ }));
    await waitFor(() => expect(useSwitchNotices.getState().notices.b).toBeDefined());
    expect(useSwitchNotices.getState().notices.b?.text).toBe(
      "Switched to System login. The agent is reading a transcript of the earlier chat.",
    );
    expect(useSwitchNotices.getState().notices.s1).toBeUndefined();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
