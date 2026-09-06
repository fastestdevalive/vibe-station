import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import type { AuthSession } from "@/api/types";
import { RemoteAccessSetting } from "./RemoteAccessSetting";

function makeSession(overrides: Partial<AuthSession> & { nonce: string }): AuthSession {
  return {
    label: null,
    createdVia: "qr",
    createdAt: "1700000000000",
    lastSeenAt: "1700000000000",
    createdIp: null,
    expiresAt: "9999999999999",
    tunnelInvalidated: false,
    tunnelLive: false,
    ...overrides,
  };
}

describe("RemoteAccessSetting", () => {
  it("4.T1 — a session with tunnelInvalidated:true renders the 'tunnel invalidated' badge", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: true, tunnelUrl: "https://live.trycloudflare.com" });
    vi.spyOn(api, "listAuthSessions").mockResolvedValue([
      makeSession({ nonce: "n-stale", label: "Android (old)", tunnelInvalidated: true }),
    ]);
    render(<RemoteAccessSetting api={api} />);
    expect(await screen.findByText("tunnel invalidated")).toBeInTheDocument();
  });

  it("4.T2 — a session with tunnelInvalidated:false renders the normal createdVia badge, no stale badge", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "listAuthSessions").mockResolvedValue([
      makeSession({ nonce: "n-pw", createdVia: "password", label: "Desktop" }),
    ]);
    render(<RemoteAccessSetting api={api} />);
    expect(await screen.findByText("Password")).toBeInTheDocument();
    expect(screen.queryByText("tunnel invalidated")).not.toBeInTheDocument();
  });

  it("4.T3 — Disable with a mix of live/password/invalidated sessions confirms naming only the live one", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: true, tunnelUrl: "https://live.trycloudflare.com" });
    vi.spyOn(api, "listAuthSessions").mockResolvedValue([
      makeSession({ nonce: "n-live", label: "iPhone", tunnelLive: true }),
      makeSession({ nonce: "n-pw", createdVia: "password", label: "Desktop" }),
      makeSession({ nonce: "n-stale", label: "Android (old)", tunnelInvalidated: true }),
    ]);
    const disableSpy = vi.spyOn(api, "disableTunnel");
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    const disableBtn = await screen.findByRole("button", { name: "Disable" });
    await user.click(disableBtn);

    const dialogText = await screen.findByText(/This will disconnect 1 remote session/);
    expect(dialogText.textContent).toContain("iPhone");
    // The dialog names only the live session — "Desktop"/"Android (old)" must not
    // appear anywhere in that dialog's text (they still exist in the session list
    // behind it, so this checks the dialog's own paragraph, not the whole page).
    expect(dialogText.textContent).not.toContain("Desktop");
    expect(dialogText.textContent).not.toContain("Android (old)");
    expect(disableSpy).not.toHaveBeenCalled();

    // Cancel does not call disableTunnel, and closes the dialog.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(disableSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/This will disconnect/)).not.toBeInTheDocument();
  });

  it("4.T3b — confirming the dialog calls api.disableTunnel()", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: true, tunnelUrl: "https://live.trycloudflare.com" });
    vi.spyOn(api, "listAuthSessions").mockResolvedValue([
      makeSession({ nonce: "n-live", label: "iPhone", tunnelLive: true }),
    ]);
    const disableSpy = vi.spyOn(api, "disableTunnel").mockResolvedValue(undefined);
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Disable" }));
    const dialogDisableBtn = await screen.findAllByRole("button", { name: "Disable" });
    // Second "Disable" button belongs to the confirm dialog (the card's own button is the first match).
    await user.click(dialogDisableBtn[dialogDisableBtn.length - 1]!);
    await waitFor(() => expect(disableSpy).toHaveBeenCalledTimes(1));
  });

  it("4.T3c — zero live-tunnel sessions: Disable proceeds with no dialog", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: true, tunnelUrl: "https://live.trycloudflare.com" });
    vi.spyOn(api, "listAuthSessions").mockResolvedValue([
      makeSession({ nonce: "n-pw", createdVia: "password", label: "Desktop" }),
    ]);
    const disableSpy = vi.spyOn(api, "disableTunnel").mockResolvedValue(undefined);
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Disable" }));
    expect(screen.queryByText(/This will disconnect/)).not.toBeInTheDocument();
    await waitFor(() => expect(disableSpy).toHaveBeenCalledTimes(1));
  });

  it("4.T4 — once GET /auth/sessions 403s, the poll loop stops re-requesting it", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    const sessionsSpy = vi.spyOn(api, "listAuthSessions").mockRejectedValue(new ApiError("forbidden", 403));
    render(<RemoteAccessSetting api={api} />);

    await waitFor(() => expect(sessionsSpy).toHaveBeenCalledTimes(1));

    // Fake timers only for the poll-interval assertion — real timers everywhere
    // else in this suite, since testing-library's findBy*/waitFor rely on real
    // setTimeout-based polling internally.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await vi.advanceTimersByTimeAsync(12_000);
      await vi.advanceTimersByTimeAsync(12_000);
    } finally {
      vi.useRealTimers();
    }
    expect(sessionsSpy).toHaveBeenCalledTimes(1);
  });

  it("4.T5 — regression: toggling Enable calls api.enableTunnel and shows the live URL", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "listAuthSessions").mockResolvedValue([]);
    const enableSpy = vi
      .spyOn(api, "enableTunnel")
      .mockResolvedValue({ enabled: true, tunnelUrl: "https://fresh.trycloudflare.com" });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Enable tunnel" }));
    expect(enableSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/fresh.trycloudflare.com/)).toBeInTheDocument();
  });

  it("4.T5 — regression: revoking a single session calls api.revokeAuthSession and removes the row", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "listAuthSessions").mockResolvedValue([
      makeSession({ nonce: "n-1", label: "iPad" }),
    ]);
    const revokeSpy = vi.spyOn(api, "revokeAuthSession").mockResolvedValue(undefined);
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await screen.findByText("iPad");
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith("n-1"));
    await waitFor(() => expect(screen.queryByText("iPad")).not.toBeInTheDocument());
  });
});
