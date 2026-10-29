import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import type { DoctorHintDto, TunnelState } from "@/api/types";
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

  it("closes the open QR popup when remote:connected arrives (a QR code was redeemed)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({
      enabled: true,
      tunnelUrl: "https://live.trycloudflare.com",
    });
    const handlers: Array<(e: unknown) => void> = [];
    const realOn = api.on.bind(api);
    vi.spyOn(api, "on").mockImplementation(((type: string, h: (e: never) => void) => {
      if (type === "remote:connected") handlers.push(h as (e: unknown) => void);
      return realOn(type as never, h as never);
    }) as typeof api.on);
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);
    await user.click((await screen.findAllByRole("button", { name: "Show QR" }))[0]!);
    expect(await screen.findByText(/Expires \d+s/)).toBeInTheDocument();

    act(() =>
      handlers.forEach((h) =>
        h({
          type: "remote:connected",
          session: {
            tokenId: "freshly-paired-device",
            scope: "browser",
            connections: 0,
            issuedAt: 1,
            lastSeenAt: 1,
          },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText(/Expires \d+s/)).not.toBeInTheDocument());
  });

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

  it("not_installed on a macOS host shows the app download, not the Linux curl", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getTailscaleStatus").mockResolvedValue({ state: "not_installed", hostOs: "macos" });
    render(<RemoteAccessSetting api={api} />);
    expect(await screen.findByRole("link", { name: /download tailscale for macos/i })).toHaveAttribute(
      "href",
      "https://tailscale.com/download/mac",
    );
    expect(screen.queryByText(/install\.sh/)).not.toBeInTheDocument();
  });

  it("not_connected shows the daemon-provided up command (off-PATH install)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getTailscaleStatus").mockResolvedValue({
      state: "not_connected",
      upCommand: "'/Applications/Tailscale.app/Contents/MacOS/Tailscale' up",
    });
    render(<RemoteAccessSetting api={api} />);
    expect(await screen.findByText(/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale' up/)).toBeInTheDocument();
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

  // ── Same network card ─────────────────────────────────────────────────────────

  it("shows red off status and the enable button when getNetworkAccess returns enabled:false", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getNetworkAccess").mockResolvedValue({ enabled: false });
    render(<RemoteAccessSetting api={api} />);

    const button = await screen.findByRole("button", { name: "Allow access" });
    expect(button).toBeInTheDocument();
    expect(screen.queryByText("Turn off")).not.toBeInTheDocument();
    expect(screen.getByText("Network access off")).toBeInTheDocument();
    expect(screen.queryByText("Change this from localhost on the host machine")).not.toBeInTheDocument();
  });

  it("clicking the enable button then confirming calls setNetworkAccess(true)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getNetworkAccess").mockResolvedValue({ enabled: false });
    const setSpy = vi.spyOn(api, "setNetworkAccess").mockResolvedValue({ enabled: true });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Allow access" }));
    expect(await screen.findByText("Allow network access?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith(true));
  });

  it("a 403 from getNetworkAccess renders 'Change this from localhost on the host machine'", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    vi.spyOn(api, "getNetworkAccess").mockRejectedValue(new ApiError("Forbidden.", 403));
    render(<RemoteAccessSetting api={api} />);

    expect(await screen.findByText("Change this from localhost on the host machine")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow access" })).toBeDisabled();
  });
});

// ── cloudflared install guidance (phase 2) ────────────────────────────────────
// The daemon no longer bundles cloudflared: it locates an installed one and the
// card guides installation from the daemon's hint table (never hardcoded here).
describe("RemoteAccessSetting — cloudflared install guidance", () => {
  const INSTALL_HINT: DoctorHintDto = {
    title: "cloudflared is not installed",
    why: "Remote access needs the cloudflared binary.",
    commands: [
      { os: "macos", command: "brew install cloudflared" },
      {
        os: "linux",
        command:
          "sudo mkdir -p --mode=0755 /usr/share/keyrings\n" +
          "curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null\n" +
          "echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list\n" +
          "sudo apt-get update && sudo apt-get install cloudflared",
      },
      {
        os: "linux",
        command:
          "curl -fsSL https://pkg.cloudflare.com/cloudflared.repo | sudo tee /etc/yum.repos.d/cloudflared.repo >/dev/null && sudo yum install cloudflared",
      },
      { os: "windows", command: "winget install --id Cloudflare.cloudflared" },
    ],
    docsUrl:
      "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/",
    action: null,
  };

  function notInstalled(hostOs: string): TunnelState {
    return {
      enabled: false,
      tunnelUrl: null,
      binary: { state: "not_installed" },
      hostOs,
      installHint: INSTALL_HINT,
    };
  }

  const CASES: Array<[string, RegExp]> = [
    ["macos", /brew install cloudflared/],
    ["linux", /sudo apt-get install cloudflared/],
    ["windows", /winget install --id Cloudflare\.cloudflared/],
  ];

  it.each(CASES)("2.T1 — not_installed on %s shows its commands and hides Enable tunnel", async (hostOs, command) => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue(notInstalled(hostOs));
    render(<RemoteAccessSetting api={api} />);

    expect(await screen.findByText(/cloudflared isn't installed on this machine/)).toBeInTheDocument();
    expect(screen.getByText(command)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable tunnel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeInTheDocument();
  });

  it("2.T1 — Linux shows both the apt and the RHEL blocks", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue(notInstalled("linux"));
    render(<RemoteAccessSetting api={api} />);

    await screen.findByText(/cloudflared isn't installed on this machine/);
    expect(screen.getByText(/sudo apt-get install cloudflared/)).toBeInTheDocument();
    expect(screen.getByText(/sudo yum install cloudflared/)).toBeInTheDocument();
  });

  it("2.T2 — Re-check re-runs the status call and flips to Enable tunnel", async () => {
    const api = createMockApi();
    const getStatus = vi
      .spyOn(api, "getTunnelStatus")
      .mockResolvedValueOnce(notInstalled("macos"))
      .mockResolvedValueOnce({
        enabled: false,
        tunnelUrl: null,
        binary: { state: "installed", path: "/opt/homebrew/bin/cloudflared", version: "2026.1.0" },
        hostOs: "macos",
      });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Re-check" }));
    expect(await screen.findByRole("button", { name: "Enable tunnel" })).toBeInTheDocument();
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(getStatus).toHaveBeenCalledWith({ binary: true });
  });

  it("2.T3 — Re-check resumes a persisted enabled tunnel exactly once", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus")
      .mockResolvedValueOnce({ ...notInstalled("macos"), enabled: true })
      .mockResolvedValueOnce({
        enabled: true,
        tunnelUrl: null,
        binary: { state: "installed", path: "/opt/homebrew/bin/cloudflared", version: "2026.1.0" },
        hostOs: "macos",
      });
    const enableSpy = vi
      .spyOn(api, "enableTunnel")
      .mockResolvedValue({ enabled: true, tunnelUrl: "https://resumed.trycloudflare.com" });
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await screen.findByText(/Your tunnel will resume once cloudflared is installed/);
    await user.click(screen.getByRole("button", { name: "Re-check" }));
    await waitFor(() => expect(enableSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/resumed\.trycloudflare\.com/)).toBeInTheDocument();
  });

  it("2.T3 — Re-check does not resume while cloudflared is still missing", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus")
      .mockResolvedValueOnce({ ...notInstalled("macos"), enabled: true })
      .mockResolvedValueOnce({ ...notInstalled("macos"), enabled: true });
    const enableSpy = vi.spyOn(api, "enableTunnel");
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Re-check" }));
    await waitFor(() => expect(api.getTunnelStatus).toHaveBeenCalledTimes(2));
    expect(enableSpy).not.toHaveBeenCalled();
  });

  it("2.T4 — unusable shows the path, the error and the hint, no Enable button", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({
      enabled: false,
      tunnelUrl: null,
      binary: { state: "unusable", path: "/opt/homebrew/bin/cloudflared", error: "Exec format error" },
      hostOs: "macos",
      installHint: INSTALL_HINT,
    });
    render(<RemoteAccessSetting api={api} />);

    expect(await screen.findByText(/Exec format error/)).toBeInTheDocument();
    expect(screen.getByText("/opt/homebrew/bin/cloudflared")).toBeInTheDocument();
    expect(screen.getByText(/brew install cloudflared/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable tunnel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeInTheDocument();
  });

  it("2.T5 — an older daemon without `binary` still renders the Enable tunnel card", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ enabled: false, tunnelUrl: null });
    render(<RemoteAccessSetting api={api} />);
    expect(await screen.findByRole("button", { name: "Enable tunnel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Re-check" })).not.toBeInTheDocument();
  });

  it("2.T5 — installed keeps the existing Enable tunnel card and shows the located binary", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({
      enabled: false,
      tunnelUrl: null,
      binary: { state: "installed", path: "/usr/local/bin/cloudflared", version: "2026.1.0" },
      hostOs: "linux",
    });
    render(<RemoteAccessSetting api={api} />);
    expect(await screen.findByRole("button", { name: "Enable tunnel" })).toBeInTheDocument();
    expect(screen.queryByText(/cloudflared isn't installed/)).not.toBeInTheDocument();
    // Which cloudflared vst will spawn (verify-fix-loop V1).
    expect(screen.getByText("cloudflared 2026.1.0 at /usr/local/bin/cloudflared")).toBeInTheDocument();
  });

  it("2.T6 — the tunnel status is not polled (no timer shorter than the existing 30s session refresh)", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue(notInstalled("linux"));
    render(<RemoteAccessSetting api={api} />);

    await screen.findByText(/cloudflared isn't installed on this machine/);
    // The only intervals this component owns are the pre-existing 30s
    // session-presence refresh and testing-library's own 50ms `waitFor`
    // waiter. Anything else shorter than 30s would be a status poll.
    const polls = intervalSpy.mock.calls.filter(
      ([fn, delay]) =>
        typeof delay === "number" &&
        delay < 30_000 &&
        !String(fn).includes("checkRealTimersCallback"),
    );
    expect(polls).toHaveLength(0);
  });

  it("2.T7 — a pending enabled row (no URL) enables, never disables, and mount alone never enables", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({
      enabled: true,
      tunnelUrl: null,
      binary: { state: "installed", path: "/usr/local/bin/cloudflared", version: "2026.1.0" },
      hostOs: "linux",
    });
    const enableSpy = vi
      .spyOn(api, "enableTunnel")
      .mockResolvedValue({ enabled: true, tunnelUrl: "https://pending.trycloudflare.com" });
    const disableSpy = vi.spyOn(api, "disableTunnel").mockResolvedValue(undefined);
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await screen.findByRole("button", { name: "Enable tunnel" });
    expect(enableSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Enable tunnel" }));
    expect(enableSpy).toHaveBeenCalledTimes(1);
    expect(disableSpy).not.toHaveBeenCalled();
    expect(await screen.findByText(/pending\.trycloudflare\.com/)).toBeInTheDocument();
  });

  it("2.T7 — a 409 cloudflared_not_installed on enable re-reads the status instead of only toasting", async () => {
    const api = createMockApi();
    const getStatus = vi
      .spyOn(api, "getTunnelStatus")
      .mockResolvedValueOnce({
        enabled: false,
        tunnelUrl: null,
        binary: { state: "installed", path: "/usr/local/bin/cloudflared", version: "2026.1.0" },
        hostOs: "linux",
      })
      .mockResolvedValueOnce(notInstalled("linux"));
    vi.spyOn(api, "enableTunnel").mockRejectedValue(
      new ApiError(JSON.stringify({ error: "cloudflared not installed — run: vst doctor", code: "cloudflared_not_installed" }), 409, "cloudflared_not_installed"),
    );
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await user.click(await screen.findByRole("button", { name: "Enable tunnel" }));
    expect(await screen.findByText(/cloudflared isn't installed on this machine/)).toBeInTheDocument();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("an active tunnel wins over a binary that later reports not_installed", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({
      enabled: true,
      tunnelUrl: "https://x.trycloudflare.com",
      binary: { state: "not_installed" },
      hostOs: "macos",
      installHint: INSTALL_HINT,
    });
    render(<RemoteAccessSetting api={api} />);

    // The live tunnel's URL, Disable and QR stay available...
    expect(await screen.findByText(/x\.trycloudflare\.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show QR" })).toBeInTheDocument();
    // ...and the binary problem is a secondary warning inside the active card,
    // not a replacement for it (no install guidance / Re-check-only card).
    expect(screen.getByText(/cloudflared isn't installed on this machine/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Re-check" })).not.toBeInTheDocument();
    expect(screen.queryByText(/brew install cloudflared/)).not.toBeInTheDocument();
  });

  it("Don't resume clears the persisted intent while cloudflared is missing", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ ...notInstalled("macos"), enabled: true });
    const disableSpy = vi.spyOn(api, "disableTunnel").mockResolvedValue(undefined);
    const user = userEvent.setup({ delay: null });
    render(<RemoteAccessSetting api={api} />);

    await screen.findByText(/Your tunnel will resume once cloudflared is installed/);
    await user.click(screen.getByRole("button", { name: "Don't resume" }));
    await waitFor(() => expect(disableSpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByText(/Your tunnel will resume once cloudflared is installed/)).not.toBeInTheDocument(),
    );
  });

  it("refetches the tunnel status on every ws:open, including the first after mount", async () => {
    const api = createMockApi();
    const getStatus = vi.spyOn(api, "getTunnelStatus").mockResolvedValue(notInstalled("macos"));
    const wsOpenHandlers: Array<(e: unknown) => void> = [];
    const realOn = api.on.bind(api);
    vi.spyOn(api, "on").mockImplementation(((type: string, h: (e: never) => void) => {
      if (type === "ws:open") wsOpenHandlers.push(h as (e: unknown) => void);
      return realOn(type as never, h as never);
    }) as typeof api.on);
    render(<RemoteAccessSetting api={api} />);

    await screen.findByText(/cloudflared isn't installed on this machine/);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(wsOpenHandlers.length).toBeGreaterThan(0);

    // The settings panel mounts long after the socket's first connect, so its
    // first observed ws:open is already a real reconnect — it must refetch.
    act(() => wsOpenHandlers.forEach((h) => h({ type: "ws:open" })));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
  });
});
