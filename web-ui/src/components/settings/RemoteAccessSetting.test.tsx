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
    vi.spyOn(api, "listAuthSessions").mockResolvedValue({
      sessions: [{ tokenId: "t1", scope: "browser", connections: 1, issuedAt: 1, lastSeenAt: 2 }],
      isDesktop: true,
      currentScope: "tauri",
    });
    const revokeSpy = vi
      .spyOn(api, "revokeAllBrowserSessions")
      .mockResolvedValue({ ok: true, browserEpoch: 1 });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Revoke all" }));
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("All sessions revoked.")).toBeInTheDocument();
  });

  it("a failed revoke-all surfaces an error instead of the success message", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "listAuthSessions").mockResolvedValue({
      sessions: [{ tokenId: "t1", scope: "browser", connections: 1, issuedAt: 1, lastSeenAt: 2 }],
      isDesktop: true,
      currentScope: "tauri",
    });
    vi.spyOn(api, "revokeAllBrowserSessions").mockRejectedValue(new ApiError("forbidden", 403));
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Revoke all" }));
    await waitFor(() => expect(screen.getByText("forbidden")).toBeInTheDocument());
    expect(screen.queryByText("All sessions revoked.")).not.toBeInTheDocument();
  });

  // ── Tailscale card ────────────────────────────────────────────────────────────

  it("renders the Cloudflare card title, not Remote", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    render(<RemoteAccessSetting api={api} />);
    expect(await screen.findByText("Cloudflare")).toBeInTheDocument();
    expect(screen.queryByText("Remote")).not.toBeInTheDocument();
  });

  it("not_installed shows the curl install command, no Run button", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getTailscaleStatus").mockResolvedValue({ state: "not_installed" });
    render(<RemoteAccessSetting api={api} />);
    expect(
      await screen.findByText(/curl -fsSL https:\/\/tailscale\.com\/install\.sh \| sh/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run/i })).not.toBeInTheDocument();
  });

  it("not_connected Run calls runTailscaleUp and refetches status on exitCode 0", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    const getStatus = vi.spyOn(api, "getTailscaleStatus");
    getStatus.mockResolvedValue({ state: "not_connected" });
    const runUp = vi
      .spyOn(api, "runTailscaleUp")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false, loginUrl: null });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Run" }));
    await waitFor(() => expect(runUp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("not_connected loginUrl result renders a link, not an error", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getTailscaleStatus").mockResolvedValue({ state: "not_connected" });
    const loginUrl = "https://login.tailscale.com/a/xyz";
    vi.spyOn(api, "runTailscaleUp").mockResolvedValue({
      stdout: "",
      stderr: `To authenticate, visit:\n${loginUrl}\n`,
      exitCode: -1,
      timedOut: true,
      loginUrl,
    });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Run" }));
    const link = await screen.findByRole("link", { name: loginUrl });
    expect(link).toHaveAttribute("href", loginUrl);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("not_connected exitCode 1 renders the stderr text", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getTailscaleStatus").mockResolvedValue({ state: "not_connected" });
    vi.spyOn(api, "runTailscaleUp").mockResolvedValue({
      stdout: "",
      stderr: "tailscale: failed to connect",
      exitCode: 1,
      timedOut: false,
      loginUrl: null,
    });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Run" }));
    expect(await screen.findByText("tailscale: failed to connect")).toBeInTheDocument();
  });

  it("needs_operator shows fixCommand as text, no Run button", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getTailscaleStatus").mockResolvedValue({
      state: "needs_operator",
      fixCommand: "sudo tailscale set --operator=alice",
    });
    render(<RemoteAccessSetting api={api} />);
    expect(await screen.findByText("sudo tailscale set --operator=alice")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
  });

  it("certs_not_enabled shows the explanation and dnsName", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getTailscaleStatus").mockResolvedValue({
      state: "certs_not_enabled",
      dnsName: "machine.ts.net",
    });
    render(<RemoteAccessSetting api={api} />);
    expect(await screen.findByText(/HTTPS certificates must be enabled/)).toBeInTheDocument();
    expect(screen.getByText("This machine:")).toBeInTheDocument();
    expect(screen.getByText("machine.ts.net")).toBeInTheDocument();
  });

  it("certs_not_enabled with empty dnsName renders neither This machine nor empty code", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getTailscaleStatus").mockResolvedValue({
      state: "certs_not_enabled",
      dnsName: "",
    });
    render(<RemoteAccessSetting api={api} />);
    await screen.findByText(/HTTPS certificates must be enabled/);
    expect(screen.queryByText("This machine:")).not.toBeInTheDocument();
  });

  it("↺ Refresh is present for not_installed and refetches on click", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    const getStatus = vi.spyOn(api, "getTailscaleStatus");
    getStatus.mockResolvedValue({ state: "not_installed" });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    const refresh = await screen.findByRole("button", { name: "Refresh Tailscale status" });
    expect(refresh).toBeInTheDocument();
    const callsBefore = getStatus.mock.calls.length;
    await user.click(refresh);
    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(callsBefore));
  });
});
