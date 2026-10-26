import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UpdateCheckResponse, UpdateStatus } from "@/api/types";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import { forceFloor } from "./forceFloor";
import { UpdateSetting } from "./UpdateSetting";

vi.mock("@/api/update", () => ({
  fetchUpdateStatus: vi.fn(),
  setAutoCheck: vi.fn(),
  installUpdate: vi.fn(),
  skipUpdate: vi.fn(),
  unskipUpdate: vi.fn(),
  restartDaemon: vi.fn(),
}));
import {
  fetchUpdateStatus,
  installUpdate,
  skipUpdate,
  restartDaemon,
} from "@/api/update";
import { ApiError } from "@/api/errors";

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    current: "1.0.0",
    behindCount: 0,
    updateAvailable: false,
    skipped: [],
    installMethod: "curl",
    targets: [],
    autoCheck: true,
    platform: "linux-x86_64",
    noAsset: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  forceFloor.lastForcedAt = 0;
  useUpdateStore.setState({ status: null, canInstall: false });
});

describe("UpdateSetting", () => {
  it("shows the development-build notice for an unparseable current version", () => {
    useUpdateStore.setState({ status: status({ current: "dev-abc123" }) });
    render(<UpdateSetting />);
    expect(screen.getByText("Development build — updates unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check for updates/i })).toBeNull();
  });

  it("Check button forces a check and reports up to date", async () => {
    useUpdateStore.setState({ status: status() });
    vi.mocked(fetchUpdateStatus).mockResolvedValue({
      ...status({ checkedAt: new Date().toISOString() }),
      canInstall: true,
    } as UpdateCheckResponse);
    render(<UpdateSetting />);
    await userEvent.click(screen.getByRole("button", { name: /check for updates/i }));
    expect(fetchUpdateStatus).toHaveBeenCalledWith(true);
    expect(await screen.findByText("You're up to date — checked just now")).toBeInTheDocument();
    expect(useUpdateStore.getState().canInstall).toBe(true);
  });

  it("disables Retry until retryAfter when rate limited", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    useUpdateStore.setState({
      status: status({
        lastError: { kind: "check", reason: "rate_limited", message: "x", retryAfter: future },
      }),
    });
    render(<UpdateSetting />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled());
    expect(screen.getByText(/GitHub rate limit — try after /)).toBeInTheDocument();
  });

  it("shows every version with a v prefix", () => {
    useUpdateStore.setState({
      status: status({
        updateAvailable: true,
        latest: "1.2.3",
        targets: [{ method: "curl", path: "/home/u/.local/bin/vst", version: "1.0.0", auto: true }],
      }),
      canInstall: true,
    });
    render(<UpdateSetting />);
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("/home/u/.local/bin/vst (v1.0.0)")).toBeInTheDocument();
    expect(screen.getByText("Version v1.2.3 is available.")).toBeInTheDocument();
  });

  it("enables Retry for an offline error", () => {
    useUpdateStore.setState({
      status: status({ lastError: { kind: "check", reason: "offline", message: "x" } }),
    });
    render(<UpdateSetting />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("shows the auto-check-off / never-checked line", () => {
    useUpdateStore.setState({ status: status({ autoCheck: false }) });
    render(<UpdateSetting />);
    expect(screen.getByText("Automatic checks are off · Never checked")).toBeInTheDocument();
  });

  it("shows source-install notice", () => {
    useUpdateStore.setState({ status: status({ installMethod: "unknown" }) });
    render(<UpdateSetting />);
    expect(screen.getByText("Installed from source — update manually")).toBeInTheDocument();
  });

  it("skipped version shows Update anyway and Unskip, and install works without unskip", async () => {
    const installSpy = vi.mocked(installUpdate).mockResolvedValue(status());
    useUpdateStore.setState({
      status: status({
        updateAvailable: true,
        latest: "1.2.3",
        skipped: ["1.2.3"],
      }),
      canInstall: true,
    });
    render(<UpdateSetting />);
    expect(screen.getByText("v1.2.3 skipped")).toBeInTheDocument();
    const updateAnywayBtn = screen.getByRole("button", { name: "Update anyway" });
    const unskipBtn = screen.getByRole("button", { name: "Unskip" });
    expect(updateAnywayBtn).toBeInTheDocument();
    expect(unskipBtn).toBeInTheDocument();

    await userEvent.click(updateAnywayBtn);
    expect(installSpy).toHaveBeenCalledTimes(1);
  });

  it("permission_denied error renders copy button for sudo command", () => {
    useUpdateStore.setState({
      status: status({
        lastError: {
          kind: "install",
          reason: "permission_denied",
          message: "cannot write to /opt/vst/bin: Permission denied (os error 13).",
        },
        targets: [
          { method: "curl", path: "/home/u/.local/bin/vst", auto: true },
          { method: "curl", path: "/opt/vst/bin/vst", auto: true },
        ],
      }),
      canInstall: true,
    });
    render(<UpdateSetting />);
    expect(screen.getByText(/^Update failed: cannot write to \/opt\/vst\/bin/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code to clipboard" })).toBeInTheDocument();
    // The command targets the copy that failed (not the first) and the real script.
    expect(
      screen.getByText(
        /raw\.githubusercontent\.com\/fastestdevalive\/vibe-station\/main\/scripts\/install\.sh \| sudo sh -s -- --install-dir \/opt\/vst\/bin$/,
      ),
    ).toBeInTheDocument();
  });

  it("hides action buttons when canInstall is false", () => {
    useUpdateStore.setState({
      status: status({
        updateAvailable: true,
        latest: "1.2.3",
        skipped: ["1.2.3"],
      }),
      canInstall: false,
    });
    render(<UpdateSetting />);
    expect(screen.getByText("v1.2.3 skipped")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update anyway" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unskip" })).toBeNull();
  });

  it("renders rolled-back banner with Retry install, Skip this version, and View release", async () => {
    const installSpy = vi.mocked(installUpdate).mockResolvedValue(status());
    useUpdateStore.setState({
      status: status({
        current: "1.1.0",
        latest: "1.2.3",
        rolledBack: { failedVersion: "1.2.3", at: new Date().toISOString() },
        releaseUrl: "https://github.com/fastestdevalive/vibe-station/releases/tag/v1.2.3",
      }),
      canInstall: true,
    });
    render(<UpdateSetting />);

    expect(
      screen.getByText("v1.2.3 failed to start — rolled back to v1.1.0"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Manual restore \(if needed\): mv \.vst\.prev vst/),
    ).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: "Retry install" });
    const skipBtn = screen.getByRole("button", { name: "Skip this version" });
    const releaseLink = screen.getByRole("link", { name: "View release" });

    expect(retryBtn).toBeInTheDocument();
    expect(skipBtn).toBeInTheDocument();
    expect(releaseLink).toHaveAttribute(
      "href",
      "https://github.com/fastestdevalive/vibe-station/releases/tag/v1.2.3",
    );

    await userEvent.click(retryBtn);
    expect(installSpy).toHaveBeenCalledTimes(1);
  });

  it("Skip this version in rolled-back banner calls skipUpdate(failedVersion)", async () => {
    const skipSpy = vi.mocked(skipUpdate).mockResolvedValue(status());
    useUpdateStore.setState({
      status: status({
        current: "1.1.0",
        rolledBack: { failedVersion: "1.2.3", at: new Date().toISOString() },
      }),
      canInstall: true,
    });
    render(<UpdateSetting />);

    const skipBtn = screen.getByRole("button", { name: "Skip this version" });
    await userEvent.click(skipBtn);
    expect(skipSpy).toHaveBeenCalledWith("1.2.3");
  });
});

describe("UpdateSetting error handling", () => {
  it("install failure with 422 no_asset renders an alert", async () => {
    vi.mocked(installUpdate).mockRejectedValue(new ApiError("No update is available", 422, "no_asset"));
    useUpdateStore.setState({
      status: status({ updateAvailable: true, latest: "1.2.3" }),
      canInstall: true,
    });
    render(<UpdateSetting />);
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No prebuilt");
  });

  it("restart tauri_hosted shows relaunch copy and hides Restart daemon", async () => {
    vi.mocked(restartDaemon)
      .mockResolvedValueOnce({ kind: "impact", impact: [] })
      .mockResolvedValueOnce({ kind: "error", code: "tauri_hosted" });
    useUpdateStore.setState({
      status: status({ restartPending: { kind: "daemon", version: "1.2.3" } }),
      canInstall: true,
    });
    render(<UpdateSetting />);
    await userEvent.click(await screen.findByRole("button", { name: "Restart daemon" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Quit & relaunch vibe-station to finish.");
    expect(screen.queryByRole("button", { name: "Restart daemon" })).toBeNull();
  });

  it("Mobile restart-pending does not dry-run the restart", () => {
    useUpdateStore.setState({
      status: status({ restartPending: { kind: "daemon", version: "1.2.3" } }),
      canInstall: false,
    });
    render(<UpdateSetting />);
    expect(restartDaemon).not.toHaveBeenCalled();
  });

  it("noAsset hides Update/Skip and offers View release with the no-prebuilt copy", () => {
    useUpdateStore.setState({
      status: status({
        updateAvailable: true,
        latest: "1.2.3",
        noAsset: true,
        platform: "linux-riscv64",
        releaseUrl: "https://github.com/fastestdevalive/vibe-station/releases/tag/v1.2.3",
      }),
      canInstall: true,
    });
    render(<UpdateSetting />);
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.getByText("No prebuilt v1.2.3 for linux-riscv64.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View release" })).toHaveAttribute(
      "href",
      "https://github.com/fastestdevalive/vibe-station/releases/tag/v1.2.3",
    );
  });

  it("noAsset removes Retry install from the rolled-back banner", () => {
    useUpdateStore.setState({
      status: status({
        current: "1.1.0",
        latest: "1.2.3",
        updateAvailable: true,
        noAsset: true,
        platform: "linux-riscv64",
        rolledBack: { failedVersion: "1.2.3", at: new Date().toISOString() },
        releaseUrl: "https://example.test/r",
      }),
      canInstall: true,
    });
    render(<UpdateSetting />);
    expect(screen.queryByRole("button", { name: "Retry install" })).toBeNull();
    expect(screen.getAllByText("No prebuilt v1.2.3 for linux-riscv64.").length).toBeGreaterThan(0);
  });

  it("the auto-check checkbox is disabled without canInstall", () => {
    useUpdateStore.setState({ status: status(), canInstall: false });
    render(<UpdateSetting />);
    expect(screen.getByRole("checkbox", { name: /Check for updates automatically/ })).toBeDisabled();
  });

  it("W16b: app restart-pending headline says Quit & relaunch", () => {
    useUpdateStore.setState({
      status: status({ restartPending: { kind: "app", version: "1.2.3" } }),
      canInstall: true,
    });
    render(<UpdateSetting />);
    expect(screen.getByText(/Quit & relaunch to finish/)).toBeInTheDocument();
    expect(screen.queryByText(/Restart to finish/)).toBeNull();
  });

  it("W16c: 'checked just now' clears after 60 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      useUpdateStore.setState({ status: status() });
      vi.mocked(fetchUpdateStatus).mockResolvedValue({ ...status(), canInstall: true } as UpdateCheckResponse);
      render(<UpdateSetting />);
      await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(
        screen.getByRole("button", { name: /check for updates/i }),
      );
      expect(await screen.findByText(/checked just now/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_001);
      });
      expect(screen.queryByText(/checked just now/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("W16d: busy confirm lists the impacted sessions and offers Later", async () => {
    const impact = [{ sessionId: "s1", name: "Agent A", kind: "working" as const }];
    vi.mocked(restartDaemon)
      .mockResolvedValueOnce({ kind: "impact", impact: [] })
      .mockResolvedValueOnce({ kind: "busy", impact });
    useUpdateStore.setState({
      status: status({ restartPending: { kind: "daemon", version: "1.2.3" } }),
      canInstall: true,
    });
    render(<UpdateSetting />);
    await userEvent.click(await screen.findByRole("button", { name: "Restart daemon" }));
    expect(await screen.findByText(/Agent A \(agent is working\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.getByRole("button", { name: "Restart daemon" })).toBeInTheDocument();
  });

  it("W09b: install progressbar has an accessible name", () => {
    useUpdateStore.setState({
      status: status({ install: { stage: "downloading", pct: 10, startedBy: "ui" } }),
    });
    render(<UpdateSetting />);
    expect(screen.getByRole("progressbar", { name: "Update progress" })).toBeInTheDocument();
  });
});

describe("UpdateSetting round-3 fixes", () => {
  const rolled = (over: Partial<UpdateStatus> = {}) =>
    status({
      current: "0.0.6-beta",
      latest: "0.0.7-beta",
      updateAvailable: false,
      lastError: null,
      rolledBack: { failedVersion: "0.0.7-beta", at: "2026-10-26T00:00:00Z" },
      ...over,
    } as Partial<UpdateStatus>);

  it("rolled back never says up to date and offers Retry install", async () => {
    useUpdateStore.setState({ status: rolled(), canInstall: true });
    vi.mocked(fetchUpdateStatus).mockResolvedValue({ ...rolled(), canInstall: true } as UpdateCheckResponse);
    render(<UpdateSetting />);
    await userEvent.click(screen.getByRole("button", { name: /check for updates/i }));
    await waitFor(() => expect(fetchUpdateStatus).toHaveBeenCalled());
    expect(screen.queryByText(/You're up to date/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry install" })).toBeInTheDocument();
  });

  it("no Retry install when the failed release is gone, Skip stays", () => {
    useUpdateStore.setState({ status: rolled({ latest: undefined } as Partial<UpdateStatus>), canInstall: true });
    render(<UpdateSetting />);
    expect(screen.queryByRole("button", { name: "Retry install" })).toBeNull();
    expect(screen.getByRole("button", { name: "Skip this version" })).toBeInTheDocument();
  });

  describe("restart pending for the latest version", () => {
    const pending = (over: Partial<UpdateStatus> = {}) =>
      status({
        updateAvailable: true,
        latest: "0.0.5-beta",
        changelog: "## NOTES-HEADING",
        restartPending: { version: "0.0.5-beta", kind: "daemon" },
        ...over,
      } as Partial<UpdateStatus>);

    beforeEach(() => {
      vi.mocked(restartDaemon).mockResolvedValue({ kind: "impact", impact: [] } as never);
    });

    it("hides the available block", () => {
      useUpdateStore.setState({ status: pending(), canInstall: true });
      render(<UpdateSetting />);
      expect(screen.getByText(/Restart to finish v0.0.5-beta/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Restart daemon" })).toBeInTheDocument();
      expect(screen.queryByText(/is available/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
      expect(screen.queryByText("NOTES-HEADING")).toBeNull();
    });

    it("hides Update anyway / Unskip when skipped", () => {
      useUpdateStore.setState({ status: pending({ skipped: ["0.0.5-beta"] }), canInstall: true });
      render(<UpdateSetting />);
      expect(screen.queryByRole("button", { name: "Update anyway" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Unskip" })).toBeNull();
    });

    it("still shows a newer release", () => {
      useUpdateStore.setState({ status: pending({ latest: "0.0.6-beta" }), canInstall: true });
      render(<UpdateSetting />);
      expect(screen.getByText(/Version v0.0.6-beta is available/)).toBeInTheDocument();
    });
  });

  it("a Check inside the 30 s floor shows a hint instead of fetching", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      useUpdateStore.setState({ status: status() });
      vi.mocked(fetchUpdateStatus).mockResolvedValue({ ...status(), canInstall: true } as UpdateCheckResponse);
      render(<UpdateSetting />);
      await user.click(screen.getByRole("button", { name: /check for updates/i }));
      expect(fetchUpdateStatus).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      await user.click(screen.getByRole("button", { name: /check for updates/i }));
      expect(fetchUpdateStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/try again in 2\d s/)).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(21_000);
      });
      expect(screen.queryByText(/try again in/)).toBeNull();
      await user.click(screen.getByRole("button", { name: /check for updates/i }));
      expect(fetchUpdateStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
