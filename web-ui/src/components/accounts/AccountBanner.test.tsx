import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary, Session, SupportedCli, Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useModesStore } from "@/store/modesStore";
import { AccountBanner } from "./AccountBanner";
import { useSwitchNotices } from "./useAccountSwitch";

/** No navigation is allowed after a switch — the WS `supersededBy` follows it. */
const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
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

const WORK_ID = "acc_work";
const SIDE_ID = "acc_side";

const SYSTEM = acct({ id: "system", cli: "claude", displayName: "System login", method: "system", isDefault: true });
const WORK = acct({
  id: WORK_ID,
  cli: "claude",
  displayName: "Work",
  limited: { windowId: "five_hour", resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), source: "poller" },
});
const SIDE = acct({ id: SIDE_ID, cli: "claude", displayName: "gb@side.dev" });

function makeCli(over: Partial<SupportedCli> = {}): SupportedCli {
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

type BannerApi = Parameters<typeof AccountBanner>[0]["api"];

function stubApi(over: Partial<Record<keyof BannerApi, unknown>> = {}): BannerApi {
  return {
    switchSessionAccount: vi.fn(async () => ({
      ok: true as const,
      archivedSessionId: "sess-old",
      newSessionId: "sess-new",
      carryOver: "transcript" as const,
    })),
    restartAccountSignIn: vi.fn(async () => ({ attemptId: "att_1", accountId: WORK_ID, sessionId: "sess-signin" })),
    getSupportedClis: vi.fn(async () => [makeCli()]),
    refreshAccount: vi.fn(async () => ({ ...WORK, auth: "signed_out" as const })),
    ...over,
  } as unknown as BannerApi;
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: "claude-mode",
    type: "agent",
    isMain: true,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: "tmux-sess-1",
    channel: "json",
    accountId: WORK_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const WORKTREE: Worktree = {
  id: "wt-1",
  projectId: "proj-a",
  branch: "main",
  baseBranch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  pinnedAt: null,
  hiddenAt: null,
  lspEnabled: false,
};

beforeEach(() => {
  useSwitchNotices.setState({ notices: {} });
  navigateSpy.mockReset();
  useServerStore.setState({
    accounts: [SYSTEM, WORK, SIDE],
    accountsLoaded: true,
    worktrees: [WORKTREE],
    sessions: [],
    projects: [],
    loaded: true,
  });
  useWorkspaceStore.setState({ activeWorktreeId: "wt-1", activeProjectId: "proj-a" });
  useModesStore.setState({
    modes: new Map([["claude-mode", { id: "claude-mode", name: "Bugfix", cli: "claude", context: "" }]]),
    loaded: true,
  });
});

describe("AccountBanner", () => {
  it("shows the limited banner from account state and clears it when the limit clears", () => {
    const { rerender } = render(<AccountBanner api={stubApi()} session={session()} />);
    expect(screen.getByTestId("account-banner")).toHaveAttribute("role", "status");
    expect(screen.getByText(/Work reached its five hour limit\./)).toBeInTheDocument();
    expect(screen.getByText(/Resets in /)).toBeInTheDocument();

    act(() => {
      useServerStore.getState().applyAccountLimited("claude", WORK_ID, null);
    });
    rerender(<AccountBanner api={stubApi()} session={session()} />);
    expect(screen.queryByTestId("account-banner")).toBeNull();
  });

  it("Wait dismisses this limit instance", () => {
    render(<AccountBanner api={stubApi()} session={session()} />);
    fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    expect(screen.queryByTestId("account-banner")).toBeNull();
  });

  it("Switch calls switchSessionAccount with the alternative account and nothing else", async () => {
    const api = stubApi();
    render(<AccountBanner api={api} session={session()} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this session to System login" }));
    await waitFor(() => expect(api.switchSessionAccount).toHaveBeenCalledWith("sess-1", "system"));
    expect(api.restartAccountSignIn).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("adds the native hand-over caveat from the CLI's accountSwitch capability", async () => {
    render(<AccountBanner api={stubApi()} session={session()} />);
    expect(
      await screen.findByText("The agent keeps its context on System login where the CLI can hand it over; otherwise it first reads a transcript of this chat."),
    ).toBeInTheDocument();
  });

  it("adds the transcript caveat for a CLI without native hand-over", async () => {
    const api = stubApi({ getSupportedClis: vi.fn(async () => [makeCli({ accountSwitch: "transcript" })]) });
    render(<AccountBanner api={api} session={session()} />);
    expect(
      await screen.findByText(
        "The agent restarts on System login and first reads a transcript of this chat (one short turn).",
      ),
    ).toBeInTheDocument();
  });

  it("offers no Switch button when no other account has room", () => {
    const limited = { windowId: "five_hour", resetsAt: null, source: "poller" as const };
    useServerStore.setState({
      accounts: [
        acct({ ...SYSTEM, limited }),
        acct({ ...WORK, limited }),
        acct({ ...SIDE, limited }),
      ],
    });
    render(<AccountBanner api={stubApi()} session={session()} />);
    expect(screen.queryByRole("button", { name: /Switch this session to/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Wait" })).toBeInTheDocument();
  });

  it("shows the signed-out banner as an alert; Sign in opens the dialog and starts no terminal", async () => {
    useServerStore.setState({
      accounts: [SYSTEM, acct({ ...WORK, auth: "signed_out", limited: null }), SIDE],
    });
    const api = stubApi();
    render(<AccountBanner api={api} session={session()} />);
    const banner = screen.getByTestId("account-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent("Work is signed out");
    expect(banner.textContent).not.toContain("⚠");
    expect(
      screen.getByText("This agent is paused until you sign in. It never switches accounts on its own."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(api.restartAccountSignIn).not.toHaveBeenCalled();
  });

  const STEPS = { command: "CLAUDE_CONFIG_DIR=~/.work claude auth login", hint: null };
  function signedOutWithSteps() {
    useServerStore.setState({
      accounts: [SYSTEM, acct({ ...WORK, auth: "signed_out", limited: null, signIn: STEPS }), SIDE],
    });
  }

  it("sign_in_shows_steps_and_opens_no_terminal", async () => {
    signedOutWithSteps();
    const api = stubApi();
    render(<AccountBanner api={api} session={session()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(STEPS.command)).toBeInTheDocument();
    expect(api.restartAccountSignIn).not.toHaveBeenCalled();
  });

  it("steps_open_in_terminal_tab_calls_restart", async () => {
    signedOutWithSteps();
    const api = stubApi();
    render(<AccountBanner api={api} session={session()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open in a terminal tab" }));
    await waitFor(() => expect(api.restartAccountSignIn).toHaveBeenCalledWith("claude", WORK_ID, "wt-1"));
    expect(screen.queryByRole("button", { name: "Open in a terminal tab" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("steps_open_terminal_failure_is_visible_in_the_dialog", async () => {
    signedOutWithSteps();
    const api = stubApi({ restartAccountSignIn: vi.fn(async () => Promise.reject(new Error("terminal boom"))) });
    render(<AccountBanner api={api} session={session()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open in a terminal tab" }));
    await waitFor(() => expect(screen.getByText(/terminal boom/)).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("a signed-out System login opens the dialog with its steps; a terminal only on request", async () => {
    useServerStore.setState({
      accounts: [acct({ ...SYSTEM, auth: "signed_out", signIn: { command: "codex login", hint: null } }), SIDE],
    });
    const api = stubApi();
    render(<AccountBanner api={api} session={session({ accountId: "system" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("codex login")).toBeInTheDocument();
    expect(api.restartAccountSignIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open in a terminal tab" }));
    await waitFor(() => expect(api.restartAccountSignIn).toHaveBeenCalledWith("claude", "system", "wt-1"));
  });

  it("a signed-out account without steps still opens the dialog with the generic line", async () => {
    useServerStore.setState({ accounts: [SYSTEM, acct({ ...WORK, auth: "signed_out", limited: null }), SIDE] });
    render(<AccountBanner api={stubApi()} session={session()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Sign in with this CLI's own login in a terminal/)).toBeInTheDocument();
  });

  it("check_again_signed_in_closes_dialog", async () => {
    signedOutWithSteps();
    const api = stubApi({ refreshAccount: vi.fn(async () => ({ ...WORK, auth: "signed_in" as const, limited: null })) });
    render(<AccountBanner api={api} session={session()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByText(STEPS.command)).toBeNull());
    expect(api.refreshAccount).toHaveBeenCalledWith("claude", WORK_ID);
  });

  it("offers no Switch account… when the CLI has no other usable account", () => {
    useServerStore.setState({ accounts: [acct({ ...WORK, auth: "signed_out", limited: null })] });
    render(<AccountBanner api={stubApi()} session={session()} />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch account…" })).toBeNull();
  });

  it("opens the switch menu from the signed-out banner", () => {
    useServerStore.setState({ accounts: [SYSTEM, acct({ ...WORK, auth: "signed_out", limited: null }), SIDE] });
    render(<AccountBanner api={stubApi()} session={session()} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch account…" }));
    expect(screen.getAllByRole("menuitemradio").length).toBeGreaterThan(0);
  });

  it("toasts the hand-over for a Terminal session (no break card exists there)", async () => {
    const api = stubApi({
      switchSessionAccount: vi.fn(async () => ({
        ok: true as const,
        archivedSessionId: "sess-old",
        newSessionId: "sess-new",
        carryOver: "native" as const,
        accountSwitch: { fromAccountId: WORK_ID, toAccountId: null, handover: "native" as const },
      })),
    });
    const { rerender } = render(<AccountBanner api={api} session={session({ channel: "tmux" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this session to System login" }));
    await waitFor(() => expect(useSwitchNotices.getState().notices["sess-new"]).toBeDefined());
    rerender(<AccountBanner api={api} session={session({ id: "sess-new", channel: "tmux" })} />);
    expect(
      await screen.findByText("Switched to System login. The conversation was handed over."),
    ).toBeInTheDocument();
  });

  it("toasts a fresh start when the hand-over carried nothing", async () => {
    const api = stubApi({
      switchSessionAccount: vi.fn(async () => ({
        ok: true as const,
        archivedSessionId: "sess-old",
        newSessionId: "sess-new",
        carryOver: "nothing" as const,
        accountSwitch: { fromAccountId: WORK_ID, toAccountId: null, handover: "fresh" as const },
      })),
    });
    const { rerender } = render(<AccountBanner api={api} session={session({ channel: "tmux" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this session to System login" }));
    await waitFor(() => expect(useSwitchNotices.getState().notices["sess-new"]).toBeDefined());
    rerender(<AccountBanner api={api} session={session({ id: "sess-new", channel: "tmux" })} />);
    expect(
      await screen.findByText("Switched to System login. This agent starts a new conversation."),
    ).toBeInTheDocument();
  });

  it("a notice put under the replacement id survives the session id change", () => {
    useSwitchNotices.getState().put("b", { text: "Switched to X. Hello.", sticky: true });
    const { rerender } = render(<AccountBanner api={stubApi()} session={session({ id: "a", channel: "tmux" })} compact />);
    expect(screen.queryByText("Switched to X. Hello.")).toBeNull();
    rerender(<AccountBanner api={stubApi()} session={session({ id: "b", channel: "tmux" })} compact />);
    expect(screen.getByText("Switched to X. Hello.")).toBeInTheDocument();
    expect(document.querySelectorAll('.toast[role="status"]').length).toBe(1);
  });

  it("a sticky notice stays after 10 s and goes on Dismiss; a native one fades after 8 s", () => {
    vi.useFakeTimers();
    try {
      useSwitchNotices.getState().put("b", { text: "fresh one", sticky: true });
      render(<AccountBanner api={stubApi()} session={session({ id: "b", channel: "tmux" })} compact />);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByText("fresh one")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText("fresh one")).toBeNull();

      act(() => {
        useSwitchNotices.getState().put("b", { text: "native one", sticky: false });
      });
      expect(screen.getByText("native one")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(8_000);
      });
      expect(screen.queryByText("native one")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Rich Chat switch stores no notice", async () => {
    const api = stubApi({
      switchSessionAccount: vi.fn(async () => ({
        ok: true as const,
        archivedSessionId: "sess-old",
        newSessionId: "sess-new",
        carryOver: "native" as const,
        accountSwitch: { fromAccountId: WORK_ID, toAccountId: null, handover: "native" as const },
      })),
    });
    render(<AccountBanner api={api} session={session({ channel: "json" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this session to System login" }));
    await waitFor(() => expect(api.switchSessionAccount).toHaveBeenCalled());
    expect(useSwitchNotices.getState().notices).toEqual({});
  });

  it("reports a busy agent without touching the session", async () => {
    const { ApiError } = await import("@/api/errors");
    const api = stubApi({
      switchSessionAccount: vi.fn(async () => {
        throw new ApiError(JSON.stringify({ error: "busy", code: "agent_busy" }), 409, "agent_busy");
      }),
    });
    render(<AccountBanner api={api} session={session({ channel: "tmux" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this session to System login" }));
    expect(await screen.findByText("Wait for the agent to finish, then switch.")).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("renders the compact variant for the tabs strip without the hint line", () => {
    render(<AccountBanner api={stubApi()} session={session()} compact />);
    expect(document.querySelector(".account-banner__hint")).toBeNull();
    expect(screen.getByText(/Work reached its five hour limit\./)).toBeInTheDocument();
  });

  it("removed account renders an alert with Switch account… and switching calls switchSessionAccount", async () => {
    useServerStore.setState({ accounts: [SYSTEM, SIDE], accountsLoaded: true });
    const api = stubApi();
    render(<AccountBanner api={api} session={session({ accountId: "acc_gone" })} />);
    expect(screen.getByTestId("account-banner")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("account-banner")).toHaveTextContent("Account removed");
    expect(screen.getByTestId("account-banner").querySelector('[data-state="removed"]')).not.toBeNull();
    expect(screen.getByTestId("account-banner").textContent).not.toContain("⚠");
    fireEvent.click(screen.getByRole("button", { name: "Switch account…" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /System login/ }));
    await waitFor(() => expect(api.switchSessionAccount).toHaveBeenCalledWith("sess-1", "system"));
  });

  it("compact removed banner carries the removed mark too", () => {
    useServerStore.setState({ accounts: [SYSTEM, SIDE], accountsLoaded: true });
    render(<AccountBanner api={stubApi()} session={session({ accountId: "acc_gone" })} compact />);
    const banner = screen.getByTestId("account-banner");
    expect(banner.querySelector('[data-state="removed"]')).not.toBeNull();
    expect(banner).toHaveTextContent("Account removed");
  });

  it("renders no removed banner before accounts load", () => {
    useServerStore.setState({ accounts: [SYSTEM], accountsLoaded: false });
    render(<AccountBanner api={stubApi()} session={session({ accountId: "acc_gone" })} />);
    expect(screen.queryByTestId("account-banner")).toBeNull();
  });

  it("compact signed-out banner has Sign in and Switch account…", () => {
    useServerStore.setState({ accounts: [SYSTEM, acct({ ...WORK, auth: "signed_out", limited: null }), SIDE] });
    render(<AccountBanner api={stubApi()} session={session()} compact />);
    expect(screen.getByTestId("account-banner")).toHaveTextContent("Work is signed out");
    expect(screen.queryByText(/never switches accounts/)).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch account…" })).toBeInTheDocument();
  });

  it("compact limited banner switches and toasts the hand-over for a Terminal session", async () => {
    const api = stubApi({
      switchSessionAccount: vi.fn(async () => ({
        ok: true as const,
        archivedSessionId: "sess-old",
        newSessionId: "sess-new",
        carryOver: "native" as const,
        accountSwitch: { fromAccountId: WORK_ID, toAccountId: null, handover: "native" as const },
      })),
    });
    const { rerender } = render(<AccountBanner api={api} session={session({ channel: "tmux" })} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this session to System login" }));
    await waitFor(() => expect(useSwitchNotices.getState().notices["sess-new"]).toBeDefined());
    rerender(<AccountBanner api={api} session={session({ id: "sess-new", channel: "tmux" })} compact />);
    expect(
      await screen.findByText("Switched to System login. The conversation was handed over."),
    ).toBeInTheDocument();
  });

  it("a switch error does not follow the banner to another session", async () => {
    const api = stubApi({ switchSessionAccount: vi.fn(async () => Promise.reject(new Error("Wait for the agent to finish."))) });
    const { rerender } = render(<AccountBanner api={api} session={session({ id: "s1", channel: "tmux" })} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this session to System login" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    rerender(<AccountBanner api={api} session={session({ id: "s2", channel: "tmux" })} compact />);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
