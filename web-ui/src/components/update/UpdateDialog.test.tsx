import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { UpdateDialog } from "./UpdateDialog";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import type { UpdateStatus } from "@/api/types";
import * as updateApi from "@/api/update";
import * as copyModule from "@/lib/copyText";
import { ApiError } from "@/api/errors";
import { afterEach } from "vitest";

const BASE_STATUS: UpdateStatus = {
  current: "1.0.0",
  latest: "1.2.3",
  behindCount: 1,
  updateAvailable: true,
  skipped: [],
  installMethod: "curl",
  targets: [{ method: "curl", path: "/usr/local/bin/vst", auto: true }],
  autoCheck: true,
  platform: "linux-x86_64",
  noAsset: false,
};

describe("UpdateDialog", () => {
  beforeEach(() => {
    useUpdateStore.setState({
      status: BASE_STATUS,
      canInstall: true,
      remindedFor: null,
      dialogOpen: true,
      restarting: false,
      undoSkipVersion: null,
    });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("idle -> click Update now calls installUpdate and updates status", async () => {
    const user = userEvent.setup();
    const installSpy = vi.spyOn(updateApi, "installUpdate").mockResolvedValue({
      ...BASE_STATUS,
      install: { stage: "downloading", pct: 10, startedBy: "ui" },
    });

    render(<UpdateDialog />);

    expect(screen.getByText("vibe-station v1.2.3 available")).toBeInTheDocument();
    const updateBtn = screen.getByRole("button", { name: "Update now" });
    await user.click(updateBtn);

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Downloading… 10%")).toBeInTheDocument();
  });

  it("jumps to progress when 409 or store update sets in-flight install", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        install: { stage: "downloading", pct: 50, startedBy: "cli" },
      },
    });

    render(<UpdateDialog />);

    expect(screen.getByText("Updating to v1.2.3")).toBeInTheDocument();
    expect(screen.getByText("Started from CLI")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  });

  it.each(["verifying", "installing"] as const)(
    "progress bar stays at 100 while %s",
    (stage) => {
      useUpdateStore.setState({
        status: { ...BASE_STATUS, install: { stage, pct: 0, startedBy: "ui" } },
      });
      render(<UpdateDialog />);
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    },
  );

  it("cancel calls cancelUpdate and returns to idle", async () => {
    const user = userEvent.setup();
    const cancelSpy = vi.spyOn(updateApi, "cancelUpdate").mockResolvedValue({
      ...BASE_STATUS,
      install: undefined,
    });

    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        install: { stage: "downloading", pct: 30, startedBy: "ui" },
      },
    });

    render(<UpdateDialog />);

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelBtn);

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("vibe-station v1.2.3 available")).toBeInTheDocument();
  });

  it("no-asset state shows View release only and does not offer Update now", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        noAsset: true,
        releaseUrl: "https://github.com/fastestdevalive/vibe-station/releases/tag/v1.2.3",
      },
    });

    render(<UpdateDialog />);

    expect(screen.getByText(/No prebuilt v1.2.3 for linux-x86_64/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    const viewRel = screen.getByRole("link", { name: "View release" });
    expect(viewRel).toHaveAttribute(
      "href",
      "https://github.com/fastestdevalive/vibe-station/releases/tag/v1.2.3",
    );
  });

  it("Esc closes dialog and does not call skipUpdate", async () => {
    const user = userEvent.setup();
    const skipSpy = vi.spyOn(updateApi, "skipUpdate");

    render(<UpdateDialog />);

    await user.keyboard("{Escape}");
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
    expect(skipSpy).not.toHaveBeenCalled();
  });

  it("done + daemon restartPending shows impact list and Restart daemon", async () => {
    const user = userEvent.setup();
    vi.spyOn(updateApi, "restartDaemon").mockResolvedValue({
      kind: "impact",
      impact: [{ sessionId: "sess-1", name: "Worker 1", kind: "working" }],
    });

    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        restartPending: { kind: "daemon", version: "1.2.3" },
      },
    });

    render(<UpdateDialog />);

    expect(screen.getByText("Restart the daemon to finish the update.")).toBeInTheDocument();
    expect(await screen.findByText(/Worker 1 \(agent is working\)/)).toBeInTheDocument();
    expect(screen.getByText("Restarting will interrupt:")).toBeInTheDocument();
    const restartBtn = screen.getByRole("button", { name: "Restart daemon" });
    expect(restartBtn).toBeInTheDocument();

    // Now clicking restart calls restartDaemon with confirm: false
    const restartCall = vi.spyOn(updateApi, "restartDaemon").mockResolvedValue({ kind: "accepted" });
    await user.click(restartBtn);
    expect(restartCall).toHaveBeenCalledWith({ confirm: false });
  });

  it("done + 409 busy shows Restart anyway and Later buttons", async () => {
    const user = userEvent.setup();
    vi.spyOn(updateApi, "restartDaemon").mockResolvedValueOnce({
      kind: "impact",
      impact: [],
    }).mockResolvedValueOnce({
      kind: "busy",
      impact: [{ sessionId: "sess-2", name: "PTY", kind: "pty" }],
    });

    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        restartPending: { kind: "daemon", version: "1.2.3" },
      },
    });

    render(<UpdateDialog />);

    const restartBtn = await screen.findByRole("button", { name: "Restart daemon" });
    await user.click(restartBtn);

    expect(await screen.findByRole("button", { name: "Restart anyway" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();

    // Clicking restart anyway calls restartDaemon with confirm: true
    const restartAnywayCall = vi.spyOn(updateApi, "restartDaemon").mockResolvedValue({ kind: "accepted" });
    await user.click(screen.getByRole("button", { name: "Restart anyway" }));
    expect(restartAnywayCall).toHaveBeenCalledWith({ confirm: true });
  });

  it("done + kind: 'app' shows Quit & relaunch text and no restart button", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        restartPending: { kind: "app", version: "1.2.3" },
      },
    });

    render(<UpdateDialog />);

    expect(screen.getByText("Quit & relaunch vibe-station to finish.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart daemon" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart anyway" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("manual-step state renders for dmg: Download .dmg, steps, .sha256, and not-updated copies", async () => {
    const user = userEvent.setup();
    const skipSpy = vi.spyOn(updateApi, "skipUpdate").mockResolvedValue({
      ...BASE_STATUS,
      skipped: ["1.2.3"],
    });

    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        lastResult: {
          version: "1.2.3",
          updated: [],
          manual: [
            {
              kind: "open_url",
              text: "Download vibe-station-aarch64-apple-darwin.dmg",
              url: "https://github.com/fastestdevalive/vibe-station/releases/download/v1.2.3/vibe-station.dmg",
            },
            {
              kind: "text",
              text: "1. Quit vibe-station.app (Cmd+Q)",
            },
            {
              kind: "text",
              text: "2. Open the downloaded .dmg and drag the app to /Applications (Replace)",
            },
            {
              kind: "text",
              text: "3. Relaunch vibe-station (if macOS blocks it: System Settings → Privacy & Security → Open Anyway)",
            },
            {
              kind: "open_url",
              text: "Checksum (optional): https://github.com/.../vibe-station.dmg.sha256",
              url: "https://github.com/.../vibe-station.dmg.sha256",
            },
          ],
        },
        targets: [
          { method: "dmg", path: "/Applications/vibe-station.app", auto: false },
        ],
      },
    });

    render(<UpdateDialog />);

    expect(screen.getByText("Update to v1.2.3")).toBeInTheDocument();
    expect(screen.getByText("macOS app")).toBeInTheDocument();

    const downloadLink = screen.getByRole("link", { name: "Download .dmg" });
    expect(downloadLink).toHaveAttribute(
      "href",
      "https://github.com/fastestdevalive/vibe-station/releases/download/v1.2.3/vibe-station.dmg",
    );
    expect(downloadLink).toHaveAttribute("target", "_blank");
    expect(downloadLink).toHaveAttribute("rel", "noopener noreferrer");

    expect(screen.getByText("1. Quit vibe-station.app (Cmd+Q)")).toBeInTheDocument();
    expect(
      screen.getByText("2. Open the downloaded .dmg and drag the app to /Applications (Replace)"),
    ).toBeInTheDocument();

    const shaLink = screen.getByRole("link", {
      name: /Checksum \(optional\)/,
    });
    expect(shaLink).toHaveAttribute(
      "href",
      "https://github.com/.../vibe-station.dmg.sha256",
    );

    expect(
      screen.getByText("/Applications/vibe-station.app (dmg)"),
    ).toBeInTheDocument();

    const skipBtn = screen.getByRole("button", { name: "Skip this version" });
    await user.click(skipBtn);
    expect(skipSpy).toHaveBeenCalledWith("1.2.3");
  });

  it("manual-step state renders for deb and Copy command writes to clipboard", async () => {
    const user = userEvent.setup();
    const copySpy = vi.spyOn(copyModule, "copyText").mockResolvedValue(true);

    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        lastResult: {
          version: "1.2.3",
          updated: [],
          debPath: "/home/user/Downloads/vibe-station_1.2.3_amd64.deb",
          manual: [
            {
              kind: "command",
              text: "sudo apt install /home/user/Downloads/vibe-station_1.2.3_amd64.deb",
            },
            {
              kind: "text",
              text: "Then quit and relaunch vibe-station.",
            },
          ],
        },
        targets: [
          { method: "deb", path: "/usr/bin/vst", auto: false },
        ],
      },
    });

    render(<UpdateDialog />);

    expect(screen.getByText(".deb package verified ✓")).toBeInTheDocument();
    expect(
      screen.getByText("/home/user/Downloads/vibe-station_1.2.3_amd64.deb"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Then quit and relaunch vibe-station."),
    ).toBeInTheDocument();
    expect(screen.getByText("/usr/bin/vst (deb)")).toBeInTheDocument();

    const copyBtns = screen.getAllByRole("button", { name: "Copy command" });
    expect(copyBtns.length).toBeGreaterThan(0);

    await user.click(copyBtns[0]!);
    expect(copySpy).toHaveBeenCalledWith(
      "sudo apt install /home/user/Downloads/vibe-station_1.2.3_amd64.deb",
    );
  });

  it("lists updated vs not-updated copies in coexistence state", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        lastResult: {
          version: "1.2.3",
          updated: ["/home/user/.local/bin/vst"],
          manual: [
            {
              kind: "open_url",
              text: "Download vibe-station.dmg",
              url: "https://example.com/vibe-station.dmg",
            },
          ],
        },
        targets: [
          { method: "curl", path: "/home/user/.local/bin/vst", auto: true },
          { method: "dmg", path: "/Applications/vibe-station.app", auto: false },
        ],
      },
    });

    render(<UpdateDialog />);

    expect(screen.getByText("Updated:")).toBeInTheDocument();
    expect(screen.getByText("/home/user/.local/bin/vst")).toBeInTheDocument();
    expect(
      screen.getByText("Not updated (manual update required):"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("/Applications/vibe-station.app (dmg)"),
    ).toBeInTheDocument();
  });

  const RESTART_PENDING = { ...BASE_STATUS, restartPending: { kind: "daemon" as const, version: "1.2.3" } };

  /** Real client path: `fetch` returns the daemon's JSON bodies; `restartDaemon` is NOT mocked. */
  function stubRestartFetch(status: number, body: unknown) {
    const fn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body ?? "{}")) as { dryRun?: boolean };
      if (req.dryRun) return new Response(JSON.stringify({ impact: [] }), { status: 200 });
      return new Response(JSON.stringify(body), { status });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("real 409 restart_busy body reaches Restart anyway", async () => {
    const user = userEvent.setup();
    stubRestartFetch(409, { error: "restart_busy", impact: [{ sessionId: "s1", name: "A", kind: "working" }] });
    useUpdateStore.setState({ status: RESTART_PENDING });
    render(<UpdateDialog />);
    await user.click(await screen.findByRole("button", { name: "Restart daemon" }));
    expect(await screen.findByRole("button", { name: "Restart anyway" })).toBeInTheDocument();
  });

  it("real 409 tauri_hosted shows relaunch copy and hides Restart daemon", async () => {
    const user = userEvent.setup();
    stubRestartFetch(409, { error: "tauri_hosted" });
    useUpdateStore.setState({ status: RESTART_PENDING });
    render(<UpdateDialog />);
    await user.click(await screen.findByRole("button", { name: "Restart daemon" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Quit & relaunch vibe-station to finish.");
    expect(screen.queryByRole("button", { name: /Restart daemon|Retry/ })).toBeNull();
  });

  it("real 409 restart_in_progress shows the overlay (store.restarting)", async () => {
    const user = userEvent.setup();
    stubRestartFetch(409, { error: "restart_in_progress" });
    useUpdateStore.setState({ status: RESTART_PENDING });
    render(<UpdateDialog />);
    await user.click(await screen.findByRole("button", { name: "Restart daemon" }));
    await vi.waitFor(() => expect(useUpdateStore.getState().restarting).toBe(true));
  });

  it("real 403 mobile_read_only shows read-only copy", async () => {
    const user = userEvent.setup();
    stubRestartFetch(403, { error: "mobile_read_only" });
    useUpdateStore.setState({ status: RESTART_PENDING });
    render(<UpdateDialog />);
    await user.click(await screen.findByRole("button", { name: "Restart daemon" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Restart from your computer.");
  });

  it("real 409 update_in_progress re-fetches the snapshot and jumps to progress", async () => {
    const user = userEvent.setup();
    const running = { ...BASE_STATUS, install: { stage: "downloading", pct: 7, startedBy: "cli" }, canInstall: true };
    const fn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/update/check")) return new Response(JSON.stringify(running), { status: 200 });
      const req = JSON.parse(String(init?.body ?? "{}")) as { dryRun?: boolean };
      if (req.dryRun) return new Response(JSON.stringify({ impact: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: "update_in_progress" }), { status: 409 });
    });
    vi.stubGlobal("fetch", fn);
    useUpdateStore.setState({ status: RESTART_PENDING });
    render(<UpdateDialog />);
    await user.click(await screen.findByRole("button", { name: "Restart daemon" }));
    expect(await screen.findByText("Downloading… 7%")).toBeInTheDocument();
  });

  it("unknown restart error shows code and Retry", async () => {
    const user = userEvent.setup();
    stubRestartFetch(500, { error: "boom" });
    useUpdateStore.setState({ status: RESTART_PENDING });
    render(<UpdateDialog />);
    await user.click(await screen.findByRole("button", { name: "Restart daemon" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't restart (boom)");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("Mobile (canInstall=false) restart-pending: no Restart button, no restart POST", async () => {
    const restartSpy = vi.spyOn(updateApi, "restartDaemon");
    useUpdateStore.setState({ status: RESTART_PENDING, canInstall: false });
    render(<UpdateDialog />);
    expect(screen.queryByRole("button", { name: /Restart daemon/ })).toBeNull();
    expect(screen.getByText("Restart from your computer to finish.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it("Later in restart-confirm keeps the dialog on Restart daemon", async () => {
    const user = userEvent.setup();
    stubRestartFetch(409, { error: "restart_busy", impact: [{ sessionId: "s1", kind: "pty" }] });
    useUpdateStore.setState({ status: RESTART_PENDING });
    render(<UpdateDialog />);
    await user.click(await screen.findByRole("button", { name: "Restart daemon" }));
    await user.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.getByRole("button", { name: "Restart daemon" })).toBeInTheDocument();
  });

  it("install rejecting with 422 no_asset renders reason copy", async () => {
    const user = userEvent.setup();
    vi.spyOn(updateApi, "installUpdate").mockRejectedValue(
      new ApiError("No update is available", 422, "no_asset"),
    );
    render(<UpdateDialog />);
    await user.click(screen.getByRole("button", { name: "Update now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No prebuilt");
  });

  it("real fetch 422 no_asset body renders in the dialog", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "no_asset", message: "No update is available" }), { status: 422 }),
      ),
    );
    render(<UpdateDialog />);
    await user.click(screen.getByRole("button", { name: "Update now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No prebuilt");
  });

  it("cancel rejecting with 409 not_cancellable shows Too late to cancel", async () => {
    const user = userEvent.setup();
    vi.spyOn(updateApi, "cancelUpdate").mockRejectedValue(
      new ApiError("not_cancellable", 409, "not_cancellable"),
    );
    useUpdateStore.setState({
      status: { ...BASE_STATUS, install: { stage: "downloading", pct: 50, startedBy: "ui" } },
    });
    render(<UpdateDialog />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too late to cancel");
  });

  it("checksum_mismatch offers Retry and View release; permission_denied has no Retry", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        releaseUrl: "https://example.test/r",
        lastError: { kind: "install", reason: "checksum_mismatch", message: "raw" },
      },
    });
    const { unmount } = render(<UpdateDialog />);
    expect(screen.getByText("Download failed verification. Nothing was changed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View release" })).toHaveAttribute("href", "https://example.test/r");
    unmount();

    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        lastError: { kind: "install", reason: "permission_denied", message: "cannot write to /usr/local/bin: denied" },
      },
    });
    render(<UpdateDialog />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("only non-running copies updated -> installed + Done, no Update now", async () => {
    const user = userEvent.setup();
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        lastResult: { version: "1.2.3", updated: ["/home/u/.local/bin/vst"], manual: [] },
      },
    });
    render(<UpdateDialog />);
    expect(screen.getByText("v1.2.3 installed")).toBeInTheDocument();
    expect(screen.getByText("/home/u/.local/bin/vst")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it("W09b: progressbar has an accessible name", () => {
    useUpdateStore.setState({
      status: { ...BASE_STATUS, install: { stage: "downloading", pct: 40, startedBy: "ui" } },
    });
    render(<UpdateDialog />);
    expect(screen.getByRole("progressbar", { name: "Update progress" })).toBeInTheDocument();
  });

  it("W09c: restart-pending title names restartPending.version, not latest", () => {
    useUpdateStore.setState({
      status: { ...BASE_STATUS, latest: "1.3.0", restartPending: { kind: "daemon", version: "1.2.3" } },
    });
    render(<UpdateDialog />);
    expect(screen.getByText("v1.2.3 installed")).toBeInTheDocument();
  });

  it("W09c: restart-pending title is not 'v installed' when latest is absent", () => {
    useUpdateStore.setState({
      status: { ...BASE_STATUS, latest: undefined, restartPending: { kind: "daemon", version: "1.2.3" } },
    });
    render(<UpdateDialog />);
    expect(screen.getByText("v1.2.3 installed")).toBeInTheDocument();
  });

  it("W09d: idle subtitle shows the install-method label, not the raw enum", () => {
    useUpdateStore.setState({ status: { ...BASE_STATUS, installMethod: "curl-appimage" } });
    render(<UpdateDialog />);
    expect(screen.getByText(/Install script \(AppImage\)/)).toBeInTheDocument();
    expect(screen.queryByText(/curl-appimage/)).toBeNull();
  });

  it("W09e: install vanishing with no outcome (not cancelled here) shows 'Cancelled from another client'", () => {
    const installing = { ...BASE_STATUS, install: { stage: "downloading" as const, pct: 30, startedBy: "cli" as const } };
    useUpdateStore.setState({ status: installing });
    render(<UpdateDialog />);
    expect(screen.queryByText("Cancelled from another client")).toBeNull();
    act(() => useUpdateStore.getState().setStatus(BASE_STATUS));
    expect(screen.getByText("Cancelled from another client")).toBeInTheDocument();
  });

  it("W09e: cancelling from this tab does not show the notice", async () => {
    const user = userEvent.setup();
    const installing = { ...BASE_STATUS, install: { stage: "downloading" as const, pct: 30, startedBy: "ui" as const } };
    vi.spyOn(updateApi, "cancelUpdate").mockResolvedValue(BASE_STATUS);
    useUpdateStore.setState({ status: installing });
    render(<UpdateDialog />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Update now" })).toBeInTheDocument();
    expect(screen.queryByText("Cancelled from another client")).toBeNull();
  });

  it("W09e: a successful install (lastResult) does not show the notice", () => {
    const installing = { ...BASE_STATUS, install: { stage: "installing" as const, pct: 99, startedBy: "ui" as const } };
    useUpdateStore.setState({ status: installing });
    render(<UpdateDialog />);
    act(() =>
      useUpdateStore.getState().setStatus({
        ...BASE_STATUS,
        lastResult: { version: "1.2.3", updated: ["/usr/local/bin/vst"], manual: [] },
      }),
    );
    expect(screen.queryByText("Cancelled from another client")).toBeNull();
  });

  it("dialog compare link ends at the latest tag", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        behindCount: 2,
        releaseUrl: "https://github.com/fastestdevalive/vibe-station/releases/tag/v1.2.3",
      },
    });
    render(<UpdateDialog />);
    const href = screen.getByRole("link", { name: /2 releases since v1\.0\.0/ }).getAttribute("href")!;
    expect(href.endsWith("/compare/v1.0.0...v1.2.3")).toBe(true);
  });
});
