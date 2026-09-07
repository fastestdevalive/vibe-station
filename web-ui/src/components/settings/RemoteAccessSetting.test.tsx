import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import { RemoteAccessSetting } from "./RemoteAccessSetting";

// The stateless HMAC auth redesign removed the per-session list (AuthSession,
// api.listAuthSessions, api.revokeAuthSession) — browser sessions are now
// epoch-revoked in bulk. What remains to cover here is the tunnel toggle and
// the single "Revoke all browser sessions" action.
describe("RemoteAccessSetting", () => {
  it("toggling Enable calls api.enableTunnel and shows the live URL", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    const enableSpy = vi
      .spyOn(api, "enableTunnel")
      .mockResolvedValue({ enabled: true, tunnelUrl: "https://fresh.trycloudflare.com" });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Enable tunnel" }));
    expect(enableSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/fresh.trycloudflare.com/)).toBeInTheDocument();
  });

  it("Disable calls api.disableTunnel directly — the session-list confirm dialog is gone", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({
      enabled: true,
      tunnelUrl: "https://live.trycloudflare.com",
    });
    const disableSpy = vi.spyOn(api, "disableTunnel").mockResolvedValue(undefined);
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Disable" }));
    expect(screen.queryByText(/This will disconnect/)).not.toBeInTheDocument();
    await waitFor(() => expect(disableSpy).toHaveBeenCalledTimes(1));
  });

  it("a failed enable surfaces the daemon's error string, not the raw JSON body", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "enableTunnel").mockRejectedValue(
      new ApiError(JSON.stringify({ error: "cloudflared not found — run: vst doctor" }), 500),
    );
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Enable tunnel" }));
    expect(await screen.findByText(/cloudflared not found/)).toBeInTheDocument();
  });

  it("Revoke all browser sessions calls api.revokeAllBrowserSessions and confirms", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    const revokeSpy = vi
      .spyOn(api, "revokeAllBrowserSessions")
      .mockResolvedValue({ ok: true, browserEpoch: 1 });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Revoke all browser sessions" }));
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("All browser sessions revoked.")).toBeInTheDocument();
  });

  it("a failed revoke-all surfaces an error instead of the success message", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "revokeAllBrowserSessions").mockRejectedValue(new ApiError("forbidden", 403));
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Revoke all browser sessions" }));
    await waitFor(() => expect(screen.getByText("forbidden")).toBeInTheDocument());
    expect(screen.queryByText("All browser sessions revoked.")).not.toBeInTheDocument();
  });
});
